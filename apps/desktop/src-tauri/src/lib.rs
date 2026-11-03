mod desktop;
mod media_import;
mod runtime;
mod updater;

use runtime::{Runtime, RuntimeConfig};
use tauri::Manager;

#[tauri::command]
fn runtime_config(
    window: tauri::Window,
    state: tauri::State<'_, Runtime>,
) -> Result<RuntimeConfig, String> {
    if window.label() != "main" {
        return Err("Unknown desktop window".into());
    }
    Ok(state.config.clone())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            runtime_config,
            media_import::native_import_media,
            updater::native_prepare_update,
            updater::native_install_update,
            desktop::native_desktop_settings,
            desktop::native_set_close_to_tray,
            desktop::native_notification_permission,
            desktop::native_request_notification_permission,
            desktop::native_notify_due
        ])
        .setup(|app| {
            desktop::setup(app)?;
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                    use windows_core::Interface;
                    if let Ok(settings) = webview
                        .controller()
                        .CoreWebView2()
                        .and_then(|view| view.Settings())
                    {
                        let _ = settings.SetAreDefaultContextMenusEnabled(false);
                        let _ = settings.SetIsZoomControlEnabled(false);
                        if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
                            let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
                        }
                    }
                })?;
            }
            let resources = app.path().resource_dir()?;
            app.manage(Runtime::launch(Some(resources), None).map_err(std::io::Error::other)?);
            Ok(())
        })
        .on_window_event(desktop::on_window_event)
        .build(tauri::generate_context!())
        .expect("AtrisShare desktop startup failed");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Runtime>().stop();
        }
    });
}
