mod runtime;

use runtime::{Runtime, RuntimeConfig};
use tauri::Manager;

#[tauri::command]
fn runtime_config(window: tauri::Window, state: tauri::State<'_, Runtime>) -> Result<RuntimeConfig, String> {
    if window.label() != "main" {
        return Err("Unknown desktop window".into());
    }
    Ok(state.config.clone())
}

pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![runtime_config])
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            app.manage(Runtime::launch(Some(resources), None).map_err(std::io::Error::other)?);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("AtrisShare desktop startup failed");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Runtime>().stop();
        }
    });
}
