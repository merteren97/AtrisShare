mod desktop;
mod runtime;

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
        .invoke_handler(tauri::generate_handler![
            runtime_config,
            desktop::native_desktop_settings,
            desktop::native_set_close_to_tray,
            desktop::native_notification_permission,
            desktop::native_request_notification_permission,
            desktop::native_notify_due
        ])
        .setup(|app| {
            desktop::setup(app)?;
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
