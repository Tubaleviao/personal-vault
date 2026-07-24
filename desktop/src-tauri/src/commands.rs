use std::fs;
use std::io::Write;
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
/// Uses a write-to-tmp + rename pattern so a crash mid-write never corrupts vault.json.
#[tauri::command]
pub fn write_vault_file(blob: String) -> Result<(), String> {
    let path = vault_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create vault dir: {e}"))?;
    }
    let tmp_path = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temp vault file: {e}"))?;
        file.write_all(blob.as_bytes())
            .map_err(|e| format!("Failed to write vault: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync vault: {e}"))?;
    }
    fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to replace vault file: {e}"))
}

/// Check whether a vault file exists (used on startup to decide create vs. open).
#[tauri::command]
pub fn vault_file_exists() -> Result<bool, String> {
    let path = vault_path()?;
    Ok(path.exists())
}
