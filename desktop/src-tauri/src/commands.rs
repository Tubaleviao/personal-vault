use std::fs;
use std::path::PathBuf;

fn vault_path() -> Result<PathBuf, String> {
    let base = dirs_next::data_local_dir()
        .ok_or_else(|| "Could not determine data directory".to_string())?;
    Ok(base.join("personal-vault").join("vault.json"))
}

/// Read the vault JSON blob from the platform data directory.
/// Returns null (JSON null string) if the file does not exist yet.
#[tauri::command]
pub fn read_vault_file() -> Result<Option<String>, String> {
    let path = vault_path()?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("Failed to read vault: {e}"))
}

/// Write the sealed vault blob to the platform data directory.
/// Creates the directory if it does not exist.
#[tauri::command]
pub fn write_vault_file(blob: String) -> Result<(), String> {
    let path = vault_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create vault dir: {e}"))?;
    }
    fs::write(&path, blob).map_err(|e| format!("Failed to write vault: {e}"))
}

/// Check whether a vault file exists (used on startup to decide create vs. open).
#[tauri::command]
pub fn vault_file_exists() -> Result<bool, String> {
    let path = vault_path()?;
    Ok(path.exists())
}
