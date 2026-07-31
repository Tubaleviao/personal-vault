use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn vault_dir() -> Result<PathBuf, String> {
    let base = dirs_next::data_local_dir()
        .ok_or_else(|| "Could not determine data directory".to_string())?;
    Ok(base.join("personal-vault"))
}

fn vault_path() -> Result<PathBuf, String> {
    Ok(vault_dir()?.join("vault.json"))
}

/// Reject filenames that could escape the vault directory.
fn sanitize_vault_filename(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || !name.ends_with(".json")
    {
        return Err(format!("Invalid vault filename: {name}"));
    }
    Ok(name)
}

/// Read the vault JSON blob from the platform data directory.
/// Pass `name` to read a specific file; defaults to vault.json.
/// Returns null (None) if the file does not exist yet.
#[tauri::command]
pub fn read_vault_file(name: Option<String>) -> Result<Option<String>, String> {
    let filename = name.as_deref().unwrap_or("vault.json");
    sanitize_vault_filename(filename)?;
    let path = vault_dir()?.join(filename);
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("Failed to read vault: {e}"))
}

/// Write the sealed vault blob to the platform data directory.
/// Pass `name` to write a specific file; defaults to vault.json.
/// Creates the directory if it does not exist.
/// Uses a write-to-tmp + rename pattern so a crash mid-write never corrupts the vault.
#[tauri::command]
pub fn write_vault_file(blob: String, name: Option<String>) -> Result<(), String> {
    let filename = name.as_deref().unwrap_or("vault.json");
    sanitize_vault_filename(filename)?;
    let dir = vault_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create vault dir: {e}"))?;
    let path = dir.join(filename);
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

/// Check whether the default vault.json exists (used on startup to decide create vs. open).
#[tauri::command]
pub fn vault_file_exists() -> Result<bool, String> {
    Ok(vault_path()?.exists())
}

/// List all *.json vault files in the vault directory.
/// Returns an array of { name, content } objects; invalid JSON files are skipped.
/// .tmp files are excluded.
#[tauri::command]
pub fn list_vault_files() -> Result<Vec<serde_json::Value>, String> {
    let dir = vault_dir()?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut results = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read vault dir: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Dir entry error: {e}"))?;
        let path = entry.path();

        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        if !name.ends_with(".json") || name.ends_with(".tmp") {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        results.push(serde_json::json!({ "name": name, "content": content }));
    }

    Ok(results)
}

/// Install the native messaging host so the browser extension can reach this app's vault file.
///
/// Called on app startup. Copies the bundled binary to a stable location and writes the
/// Chrome native-messaging manifest. On Linux/macOS the manifest is placed at the path
/// Chrome scans; on Windows a registry key is also required (not yet implemented — returns
/// an error on Windows rather than silently succeeding).
#[tauri::command]
pub fn install_native_host(app: tauri::AppHandle) -> Result<(), String> {
    // ── Locate bundled resources ─────────────────────────────────────────────
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not locate resource dir: {e}"))?;

    let bundled_binary = resource_dir.join("personal-vault-native-host");
    let bundled_manifest = resource_dir.join("com.personal_vault.json");

    if !bundled_binary.exists() {
        // Resources not bundled yet (e.g. dev mode before build-native-host.sh was run).
        return Ok(());
    }

    // ── Install binary to a stable, user-writable location ──────────────────
    let install_dir = dirs_next::data_local_dir()
        .ok_or_else(|| "Could not determine local data dir".to_string())?
        .join("personal-vault");

    fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create install dir: {e}"))?;

    let installed_binary = install_dir.join("personal-vault-native-host");

    fs::copy(&bundled_binary, &installed_binary)
        .map_err(|e| format!("Failed to copy native host binary: {e}"))?;

    // Make binary executable on Unix
    #[cfg(unix)]
    {
        let mut perms = fs::metadata(&installed_binary)
            .map_err(|e| format!("Failed to read binary metadata: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&installed_binary, perms)
            .map_err(|e| format!("Failed to set binary permissions: {e}"))?;
    }

    // ── Write native messaging manifest ─────────────────────────────────────
    let manifest_dir = native_messaging_manifest_dir()?;
    fs::create_dir_all(&manifest_dir)
        .map_err(|e| format!("Failed to create manifest dir: {e}"))?;

    // Read the bundled manifest and patch the binary path to the installed location
    let manifest_template = fs::read_to_string(&bundled_manifest)
        .map_err(|e| format!("Failed to read bundled manifest: {e}"))?;

    let binary_path_str = installed_binary
        .to_str()
        .ok_or_else(|| "Binary path contains non-UTF-8 characters".to_string())?;

    // Replace the placeholder path (whatever ships in the template) with the real installed path
    let manifest_json: serde_json::Value = serde_json::from_str(&manifest_template)
        .map_err(|e| format!("Failed to parse bundled manifest: {e}"))?;

    let mut manifest_obj = match manifest_json {
        serde_json::Value::Object(m) => m,
        _ => return Err("Manifest is not a JSON object".to_string()),
    };
    manifest_obj.insert("path".to_string(), serde_json::Value::String(binary_path_str.to_string()));
    let final_manifest = serde_json::to_string_pretty(&serde_json::Value::Object(manifest_obj))
        .map_err(|e| format!("Failed to serialise manifest: {e}"))?;

    let manifest_dest = manifest_dir.join("com.personal_vault.json");
    fs::write(&manifest_dest, final_manifest)
        .map_err(|e| format!("Failed to write native messaging manifest: {e}"))?;

    Ok(())
}

fn native_messaging_manifest_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    {
        Ok(dirs_next::home_dir()
            .ok_or_else(|| "Could not determine home dir".to_string())?
            .join(".config/google-chrome/NativeMessagingHosts"))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(dirs_next::home_dir()
            .ok_or_else(|| "Could not determine home dir".to_string())?
            .join("Library/Application Support/Google/Chrome/NativeMessagingHosts"))
    }
    #[cfg(target_os = "windows")]
    {
        // Chrome on Windows locates native messaging hosts via a registry key under
        // HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>.
        // Writing that key requires the winreg crate, which is not yet a dependency.
        Err("Native host auto-install is not yet supported on Windows. \
             Please register com.personal_vault.json in the registry manually.".to_string())
    }
}
