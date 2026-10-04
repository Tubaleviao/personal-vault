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

fn storage_config_path() -> Result<PathBuf, String> {
    Ok(vault_dir()?.join("storage.json"))
}

/// Map an io error to a `CODE: message` string; the frontend parses the code prefix
/// (same codes as `VaultStorageErrorCode` in src/storage.ts).
fn external_io_error(path: &std::path::Path, err: &std::io::Error) -> String {
    use std::io::ErrorKind;
    let missing_parent = || path.parent().map(|p| !p.as_os_str().is_empty() && !p.exists()).unwrap_or(false);
    let os = err.raw_os_error();
    let code = match err.kind() {
        ErrorKind::NotFound => if missing_parent() { "DRIVE_MISSING" } else { "NOT_FOUND" },
        ErrorKind::PermissionDenied => "PERMISSION_DENIED",
        ErrorKind::StorageFull => "DRIVE_FULL",
        // Raw errno values below are Unix-specific; other Windows codes fall through to IO.
        _ if cfg!(not(unix)) => "IO",
        _ => match os {
            Some(28) => "DRIVE_FULL",                                  // ENOSPC
            Some(n) if is_quota_errno(n) => "DRIVE_FULL",              // EDQUOT
            Some(30) => "PERMISSION_DENIED",                           // EROFS
            // ENOTDIR / ENODEV: part of the path is gone or not a directory.
            Some(19) | Some(20) => if missing_parent() { "DRIVE_MISSING" } else { "NOT_FOUND" },
            // EIO / ENXIO / ENOTCONN / ETIMEDOUT / ESTALE: drive yanked or mount dead.
            Some(5) | Some(6) => "DRIVE_MISSING",
            Some(n) if is_dead_mount_errno(n) => "DRIVE_MISSING",
            _ => "IO",
        },
    };
    format!("{code}: {err}")
}

/// Shape check on the JSON text of a sealed vault (header.ownerId + encrypted blob).
/// Keeps the external-storage commands from reading or overwriting arbitrary files.
fn looks_like_vault(text: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return false };
    v.get("header").and_then(|h| h.get("ownerId")).map_or(false, |o| o.is_string())
        && v.get("encrypted").map_or(false, |e| e.is_object())
}

fn is_quota_errno(n: i32) -> bool {
    if cfg!(target_os = "macos") { n == 69 } else { n == 122 }
}

fn is_dead_mount_errno(n: i32) -> bool {
    if cfg!(target_os = "macos") { matches!(n, 57 | 60 | 70) } else { matches!(n, 107 | 110 | 116) }
}

/// Return the configured external storage path, or null if none is set.
#[tauri::command]
pub fn get_storage_path() -> Result<Option<String>, String> {
    let cfg = storage_config_path()?;
    if !cfg.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&cfg).map_err(|e| format!("Failed to read storage config: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("CORRUPT: {e}"))?;
    Ok(v.get("path").and_then(|p| p.as_str()).filter(|p| !p.is_empty()).map(String::from))
}

/// Set (or clear, with null) the external storage path.
#[tauri::command]
pub fn set_storage_path(path: Option<String>) -> Result<(), String> {
    let cfg = storage_config_path()?;
    match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            if !std::path::Path::new(p).is_absolute() {
                return Err("NOT_CONFIGURED: storage path must be absolute".to_string());
            }
            fs::create_dir_all(vault_dir()?).map_err(|e| format!("Failed to create vault dir: {e}"))?;
            fs::write(&cfg, serde_json::json!({ "path": p }).to_string())
                .map_err(|e| format!("Failed to save storage config: {e}"))
        }
        None => match fs::remove_file(&cfg) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Failed to clear storage config: {e}")),
        },
    }
}

/// Read the vault blob at the external storage path. Errors are `CODE: message`.
#[tauri::command(async)]
pub fn read_external_vault(path: String) -> Result<String, String> {
    // Same restriction as the write command: the webview cannot read arbitrary files.
    if get_storage_path()?.as_deref() != Some(path.as_str()) {
        return Err("NOT_CONFIGURED: path does not match the configured storage path".to_string());
    }
    let p = std::path::Path::new(&path);
    let text = fs::read_to_string(p).map_err(|e| external_io_error(p, &e))?;
    if !looks_like_vault(&text) {
        return Err("CORRUPT: file is not a sealed vault".to_string());
    }
    Ok(text)
}

/// Atomically write the vault blob to the external storage path (tmp + rename).
/// Resolves symlinks first so a link into a cloud folder is written through, and
/// refuses to create missing parent directories (an unplugged drive must not be
/// papered over with a local folder). A dangling symlink is followed to its
/// missing target; if that target's directory is gone the drive is missing.
#[tauri::command(async)]
pub fn write_external_vault(path: String, blob: String) -> Result<(), String> {
    // Only the user-configured storage path may be written; the webview cannot pick an
    // arbitrary file to overwrite.
    if get_storage_path()?.as_deref() != Some(path.as_str()) {
        return Err("NOT_CONFIGURED: path does not match the configured storage path".to_string());
    }
    if !looks_like_vault(&blob) {
        return Err("CORRUPT: refusing to write data that is not a sealed vault".to_string());
    }
    let requested = std::path::Path::new(&path);
    let target = match fs::canonicalize(requested) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Follow the whole link chain (if any) to its final, missing target.
            let mut cur = requested.to_path_buf();
            for _ in 0..40 {
                match fs::symlink_metadata(&cur) {
                    Ok(m) if m.file_type().is_symlink() => {
                        let link = fs::read_link(&cur).map_err(|e| external_io_error(&cur, &e))?;
                        cur = match cur.parent() {
                            Some(dir) => dir.join(link),
                            None => link,
                        };
                    }
                    _ => break,
                }
            }
            let parent = cur.parent().ok_or_else(|| "NOT_CONFIGURED: invalid path".to_string())?;
            let real_parent = fs::canonicalize(parent).map_err(|e| external_io_error(&cur, &e))?;
            real_parent.join(cur.file_name().ok_or_else(|| "NOT_CONFIGURED: invalid path".to_string())?)
        }
        Err(e) => return Err(external_io_error(requested, &e)),
    };
    // Never replace an existing file that is not a vault (the configured path may be wrong).
    match fs::read_to_string(&target) {
        Ok(existing) if !looks_like_vault(&existing) => {
            return Err("CORRUPT: refusing to overwrite a file that is not a sealed vault".to_string());
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(external_io_error(&target, &e)),
    }
    // Unique tmp name, created exclusively (never follows a planted file/symlink), owner-only.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Fixed-length name so a long vault filename cannot exceed NAME_MAX.
    let tmp_name = format!(".vault-sync.{}.{}.tmp", std::process::id(), nanos);
    let tmp_path = target.with_file_name(tmp_name);
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let write_tmp = || -> std::io::Result<()> {
        let mut file = opts.open(&tmp_path)?;
        file.write_all(blob.as_bytes())?;
        file.sync_all()
    };
    if let Err(e) = write_tmp() {
        let _ = fs::remove_file(&tmp_path);
        return Err(external_io_error(&target, &e));
    }
    fs::rename(&tmp_path, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        external_io_error(&target, &e)
    })
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

/// Delete a specific vault file by name. Rejects path-traversal attempts.
#[tauri::command]
pub fn delete_vault_file(name: String) -> Result<(), String> {
    sanitize_vault_filename(&name)?;
    let path = vault_dir()?.join(&name);
    fs::remove_file(&path).map_err(|e| format!("Failed to delete vault: {e}"))
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

    // In debug builds the resource binary is a stale Cargo-staged copy and
    // native-host/install.sh is the authoritative installer, so skip the
    // overwrite entirely. Only production builds should auto-install.
    if cfg!(debug_assertions) {
        return Ok(());
    }

    if !bundled_binary.exists() {
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
