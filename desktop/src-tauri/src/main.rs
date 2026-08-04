// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Install the native messaging host so the browser extension can find the vault file.
            // Runs on every launch; the command is idempotent and exits early if not bundled.
            if let Err(e) = commands::install_native_host(app.handle().clone()) {
                eprintln!("Warning: native host installation failed: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_vault_file,
            commands::write_vault_file,
            commands::vault_file_exists,
            commands::list_vault_files,
            commands::delete_vault_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running personal vault");
}
