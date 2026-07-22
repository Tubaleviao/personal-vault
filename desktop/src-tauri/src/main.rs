// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_vault_file,
            commands::write_vault_file,
            commands::vault_file_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running personal vault");
}
