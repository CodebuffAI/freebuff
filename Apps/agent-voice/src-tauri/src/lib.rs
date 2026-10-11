//! agent-voice — local-first voice input for coding agents.

mod asr;
mod audio;
mod bridge;
mod cleanup;
mod commands;
mod entitlement;
mod focus;
mod hotkey;
mod license;
pub mod mcp;
mod models;
mod paste;
mod paths;
mod state;
mod text;
mod updates;
mod usage;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(hotkey::handle_event)
                .build(),
        )
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::save_settings,
            commands::activate_license,
            commands::revalidate_license,
            commands::deactivate_license,
            commands::download_model,
            commands::delete_model,
            commands::get_audio_level,
            updates::check_for_update,
            updates::install_update,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let app_state = handle.state::<state::AppState>();
            app_state.load_from_disk();

            let hotkey_accel = app_state.settings.read().unwrap().hotkey.clone();
            if let Err(err) = hotkey::register(&handle, &hotkey_accel) {
                eprintln!("failed to register hotkey '{hotkey_accel}': {err}");
            }

            // Installed builds register `agentvoice://` via the bundle config;
            // in development the scheme has to be claimed at runtime so the
            // checkout return link reaches this build.
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            if let Err(err) = handle.deep_link().register_all() {
                eprintln!("deep-link scheme not registered: {err}");
            }

            match bridge::start(handle.clone()) {
                Ok(port) => eprintln!("agent-voice bridge listening on 127.0.0.1:{port}"),
                Err(err) => eprintln!("bridge failed to start: {err}"),
            }

            // Opportunistic online revalidation (no-op when offline/unlicensed).
            let refresh_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let state = refresh_app.state::<state::AppState>();
                commands::revalidate_inner(&refresh_app, &state).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running agent-voice");
}
