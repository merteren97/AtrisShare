use crate::runtime::Runtime;
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState {
    busy: AtomicBool,
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn native_prepare_update(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("forbidden".into());
    }
    // Development binaries never replace an installed app.
    if cfg!(debug_assertions) {
        return Err("update_development".into());
    }
    #[cfg(target_os = "linux")]
    if app.env().appimage.is_none() {
        return Err("update_package_manager".into());
    }
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("update_busy".into());
    }
    let _busy = Busy(&state.busy);
    if let Some((update, _)) = state.ready.lock().map_err(|_| "update_failed")?.as_ref() {
        return Ok(Some(update.version.clone()));
    }
    let handle = app.clone();
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(300))
        .on_before_exit(move || {
            handle.state::<Runtime>().stop();
            handle.cleanup_before_exit();
        })
        .build()
        .map_err(|_| "update_failed")?;
    let Some(update) = updater.check().await.map_err(|_| "update_failed")? else {
        return Ok(None);
    };
    let version = update.version.clone();
    let mut downloaded = 0_u64;
    let mut last_progress = Instant::now() - Duration::from_millis(200);
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if last_progress.elapsed() >= Duration::from_millis(200) {
                    let _ = app.emit(
                        "atris-share://update-progress",
                        Progress { downloaded, total },
                    );
                    last_progress = Instant::now();
                }
            },
            || {},
        )
        .await
        .map_err(|_| "update_download_failed")?;
    // The updater verifies the bundled public-key signature before returning bytes.
    *state.ready.lock().map_err(|_| "update_failed")? = Some((update, bytes));
    Ok(Some(version))
}

#[tauri::command]
pub async fn native_install_update(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("forbidden".into());
    }
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("update_busy".into());
    }
    let _busy = Busy(&state.busy);
    let (update, bytes) = state
        .ready
        .lock()
        .map_err(|_| "update_failed")?
        .take()
        .ok_or("update_not_ready")?;
    if update.install(&bytes).is_err() {
        *state.ready.lock().map_err(|_| "update_failed")? = Some((update, bytes));
        return Err("update_install_failed".into());
    }
    // Windows NSIS exits via on_before_exit; other desktop platforms need a restart.
    app.state::<Runtime>().stop();
    app.restart();
}
