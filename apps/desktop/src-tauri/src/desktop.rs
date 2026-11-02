use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{Menu, MenuItem},
    plugin::PermissionState,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_notification::NotificationExt;

const QUEUE_EVENT: &str = "atris-share://open-queue";
const NOTICE_LIMIT: usize = 4096;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preferences {
    close_to_tray: bool,
}

struct Settings {
    preferences: Preferences,
    read_error: bool,
}

pub struct DesktopState {
    file: PathBuf,
    settings: Mutex<Settings>,
    tray_available: AtomicBool,
    quitting: AtomicBool,
    notices: Mutex<NoticeLedger>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    close_to_tray: bool,
    tray_available: bool,
    settings_error: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DueNotification {
    id: String,
    title: String,
    body: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotifyStatus {
    Submitted,
    Duplicate,
    PermissionRequired,
    Capacity,
}

#[derive(Default)]
struct NoticeLedger {
    // Session-only identifiers, never notification text, credentials or approvals.
    submitted: HashSet<String>,
}

impl NoticeLedger {
    fn submit(
        &mut self,
        id: &str,
        send: impl FnOnce() -> Result<(), String>,
    ) -> Result<NotifyStatus, String> {
        if self.submitted.contains(id) {
            return Ok(NotifyStatus::Duplicate);
        }
        // Do not evict and later re-notify old occurrences during repeated polling.
        if self.submitted.len() >= NOTICE_LIMIT {
            return Ok(NotifyStatus::Capacity);
        }
        send()?;
        self.submitted.insert(id.to_owned());
        Ok(NotifyStatus::Submitted)
    }
}

fn load_preferences(file: &Path) -> Result<Preferences, String> {
    let mut bytes = Vec::new();
    let source = match File::open(file) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Preferences::default())
        }
        Err(_) => return Err("native_settings_unreadable".into()),
    };
    source
        .take(1025)
        .read_to_end(&mut bytes)
        .map_err(|_| "native_settings_unreadable")?;
    if bytes.len() > 1024 {
        return Err("native_settings_invalid".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "native_settings_invalid".into())
}

fn write_preferences(file: &Path, preferences: &Preferences) -> Result<(), String> {
    let parent = file.parent().ok_or("native_settings_unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "native_settings_write_failed")?;
    let mut nonce = [0u8; 8];
    getrandom::getrandom(&mut nonce).map_err(|_| "native_settings_write_failed")?;
    let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let temporary = parent.join(format!(".desktop-settings-{suffix}.tmp"));
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        serde_json::to_writer(&mut output, preferences)?;
        output.write_all(b"\n")?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, file)
    })();
    let _ = fs::remove_file(&temporary);
    result.map_err(|_: std::io::Error| "native_settings_write_failed".into())
}

impl DesktopState {
    fn load(file: PathBuf) -> Self {
        let loaded = load_preferences(&file);
        let read_error = loaded.is_err();
        Self {
            file,
            settings: Mutex::new(Settings {
                preferences: loaded.unwrap_or_default(),
                read_error,
            }),
            tray_available: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            notices: Mutex::new(NoticeLedger::default()),
        }
    }

    fn snapshot(&self) -> Result<DesktopSettings, String> {
        let settings = self
            .settings
            .lock()
            .map_err(|_| "native_settings_unavailable")?;
        Ok(DesktopSettings {
            close_to_tray: settings.preferences.close_to_tray,
            tray_available: self.tray_available.load(Ordering::SeqCst),
            settings_error: settings.read_error,
        })
    }

    fn set_background(&self, enabled: bool) -> Result<DesktopSettings, String> {
        if enabled && !self.tray_available.load(Ordering::SeqCst) {
            return Err("native_tray_unavailable".into());
        }
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| "native_settings_unavailable")?;
        let next = Preferences {
            close_to_tray: enabled,
        };
        write_preferences(&self.file, &next)?;
        // Only change behavior after the explicit choice has persisted successfully.
        settings.preferences = next;
        settings.read_error = false;
        drop(settings);
        self.snapshot()
    }
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("native_window_forbidden".into())
    }
}

#[tauri::command]
pub fn native_desktop_settings(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<DesktopSettings, String> {
    main_window(&window)?;
    state.snapshot()
}

#[tauri::command]
pub fn native_set_close_to_tray(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    enabled: bool,
) -> Result<DesktopSettings, String> {
    main_window(&window)?;
    let settings = state.set_background(enabled)?;
    if !enabled {
        restore_main(window.app_handle(), false);
    }
    Ok(settings)
}

fn permission_name(permission: PermissionState) -> &'static str {
    match permission {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt => "prompt",
        PermissionState::PromptWithRationale => "prompt-with-rationale",
    }
}

#[tauri::command]
pub fn native_notification_permission(
    window: tauri::WebviewWindow,
) -> Result<&'static str, String> {
    main_window(&window)?;
    window
        .notification()
        .permission_state()
        .map(permission_name)
        .map_err(|_| "native_notification_unavailable".into())
}

#[tauri::command]
pub fn native_request_notification_permission(
    window: tauri::WebviewWindow,
) -> Result<&'static str, String> {
    main_window(&window)?;
    window
        .notification()
        .request_permission()
        .map(permission_name)
        .map_err(|_| "native_notification_unavailable".into())
}

fn validate_notification(input: &DueNotification) -> Result<(), String> {
    if input.id.is_empty()
        || input.id.len() > 256
        || !input
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        || input.title.trim().is_empty()
        || input.title.chars().count() > 80
        || input.body.trim().is_empty()
        || input.body.chars().count() > 240
        || input
            .title
            .chars()
            .chain(input.body.chars())
            .any(char::is_control)
    {
        return Err("native_notification_invalid".into());
    }
    Ok(())
}

#[tauri::command]
pub fn native_notify_due(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    input: DueNotification,
) -> Result<NotifyStatus, String> {
    main_window(&window)?;
    validate_notification(&input)?;
    if state.quitting.load(Ordering::SeqCst) {
        return Err("native_closing".into());
    }
    let permission = window
        .notification()
        .permission_state()
        .map_err(|_| "native_notification_unavailable")?;
    if permission != PermissionState::Granted {
        return Ok(NotifyStatus::PermissionRequired);
    }
    let mut notices = state
        .notices
        .lock()
        .map_err(|_| "native_notification_unavailable")?;
    // The plugin submits asynchronously. Success is not proof of OS delivery,
    // review, approval, or authorization to dispatch any publication bytes.
    notices.submit(&input.id, || {
        window
            .notification()
            .builder()
            .title(input.title)
            .body(input.body)
            .show()
            .map_err(|_| "native_notification_failed".into())
    })
}

fn restore_main(app: &tauri::AppHandle, queue: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if queue {
            let _ = window.emit(QUEUE_EVENT, ());
        }
    }
}

fn quit(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<DesktopState>() {
        state.quitting.store(true, Ordering::SeqCst);
    }
    // RunEvent::Exit owns Runtime::stop, including its Job Object tree cleanup.
    app.exit(0);
}

fn should_hide(enabled: bool, tray_available: bool, quitting: bool) -> bool {
    enabled && tray_available && !quitting
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let state = window.try_state::<DesktopState>();
        let hide = state.as_ref().is_some_and(|state| {
            let enabled = state
                .settings
                .lock()
                .map(|settings| settings.preferences.close_to_tray)
                .unwrap_or(false);
            should_hide(
                enabled,
                state.tray_available.load(Ordering::SeqCst),
                state.quitting.load(Ordering::SeqCst),
            )
        });
        if hide && window.hide().is_ok() {
            api.prevent_close();
        } else {
            quit(window.app_handle());
        }
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Loaded synchronously before the first close handler can act. Corrupt/missing
    // settings never silently enable background work.
    // Explicit workspace overrides also isolate native preferences, so local
    // acceptance/recovery runs cannot change a user's installed-app behavior.
    let settings_directory = match std::env::var_os("ATRIS_SHARE_DATA_DIR") {
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(std::io::Error::other("Data directory must be absolute").into());
            }
            path
        }
        None => app.path().app_config_dir()?,
    };
    let file = settings_directory.join("desktop-settings.json");
    app.manage(DesktopState::load(file));
    let tray = (|| -> tauri::Result<_> {
        let show = MenuItem::with_id(app, "show-workspace", "Show / Göster", true, None::<&str>)?;
        let quit_item =
            MenuItem::with_id(app, "quit-workspace", "Quit / Çıkış", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show, &quit_item])?;
        let icon = app
            .default_window_icon()
            .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?;
        TrayIconBuilder::with_id("workspace-tray")
            .icon(icon.clone())
            .tooltip("AtrisShare")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show-workspace" => restore_main(app, true),
                "quit-workspace" => quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    }
                ) {
                    restore_main(tray.app_handle(), true);
                }
            })
            .build(app)
    })();
    if let Ok(tray) = tray {
        // Retain the handle for the entire app lifetime; dropping the last handle
        // removes the icon and must never strand an opted-in hidden window.
        app.manage(tray);
        app.state::<DesktopState>()
            .tray_available
            .store(true, Ordering::SeqCst);
    }
    // Failed tray setup leaves the window usable and close-to-quit intact.
    app.notification().on_action({
        let handle = app.handle().clone();
        move |_| restore_main(&handle, true)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let mut nonce = [0u8; 8];
            getrandom::getrandom(&mut nonce).unwrap();
            let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
            let path = std::env::temp_dir().join(format!("atris-desktop-test-{suffix}"));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn background_requires_persisted_opt_in_available_tray_and_no_quit() {
        for enabled in [false, true] {
            for tray in [false, true] {
                for quitting in [false, true] {
                    assert_eq!(
                        should_hide(enabled, tray, quitting),
                        enabled && tray && !quitting
                    );
                }
            }
        }
        let fixture = Fixture::new();
        let file = fixture.0.join("preferences.json");
        let state = DesktopState::load(file.clone());
        assert!(!state.snapshot().unwrap().close_to_tray);
        assert!(state.set_background(true).is_err());
        state.tray_available.store(true, Ordering::SeqCst);
        assert!(state.set_background(true).unwrap().close_to_tray);
        assert!(
            DesktopState::load(file.clone())
                .snapshot()
                .unwrap()
                .close_to_tray
        );
        assert!(!state.set_background(false).unwrap().close_to_tray);
        assert!(!DesktopState::load(file).snapshot().unwrap().close_to_tray);
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn malformed_settings_fail_closed_and_failed_write_does_not_enable_background() {
        let fixture = Fixture::new();
        let file = fixture.0.join("preferences.json");
        for invalid in [
            r#"{"closeToTray":"true"}"#,
            r#"{"closeToTray":true,"extra":"x"}"#,
            "not json",
        ] {
            fs::write(&file, invalid).unwrap();
            let state = DesktopState::load(file.clone());
            let snapshot = state.snapshot().unwrap();
            assert!(!snapshot.close_to_tray);
            assert!(snapshot.settings_error);
        }
        let state = DesktopState::load(fixture.0.join("not-a-directory").join("preferences.json"));
        fs::write(fixture.0.join("not-a-directory"), "fixture").unwrap();
        state.tray_available.store(true, Ordering::SeqCst);
        assert!(state.set_background(true).is_err());
        assert!(!state.snapshot().unwrap().close_to_tray);
    }

    #[test]
    fn duplicate_occurrences_submit_once_failures_retry_and_capacity_never_evicts() {
        let mut ledger = NoticeLedger::default();
        assert!(ledger
            .submit("account:occurrence", || Err("fixture failure".into()))
            .is_err());
        assert_eq!(
            ledger.submit("account:occurrence", || Ok(())).unwrap(),
            NotifyStatus::Submitted
        );
        assert_eq!(
            ledger
                .submit("account:occurrence", || panic!("must not submit twice"))
                .unwrap(),
            NotifyStatus::Duplicate
        );
        for index in 1..NOTICE_LIMIT {
            ledger
                .submit(&format!("account:{index}"), || Ok(()))
                .unwrap();
        }
        assert_eq!(
            ledger
                .submit("new", || panic!("capacity must not dispatch"))
                .unwrap(),
            NotifyStatus::Capacity
        );
        assert_eq!(
            ledger
                .submit("account:occurrence", || panic!("must not evict"))
                .unwrap(),
            NotifyStatus::Duplicate
        );
    }

    #[test]
    fn notification_input_is_bounded_and_strict_and_permission_mapping_is_explicit() {
        let mut input = DueNotification {
            id: "account:destination:occurrence".into(),
            title: "AtrisShare".into(),
            body: "Open the review inbox.".into(),
        };
        assert!(validate_notification(&input).is_ok());
        input.id = "x".repeat(257);
        assert!(validate_notification(&input).is_err());
        input.id = "valid-id".into();
        input.body = "private\nline".into();
        assert!(validate_notification(&input).is_err());
        assert!(serde_json::from_str::<DueNotification>(
            r#"{"id":"a","title":"b","body":"c","approve":true}"#
        )
        .is_err());
        assert_eq!(permission_name(PermissionState::Denied), "denied");
        assert_eq!(permission_name(PermissionState::Granted), "granted");
    }
}
