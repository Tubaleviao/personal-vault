/// Personal Vault — native messaging host.
///
/// Chrome native messaging protocol:
///   - Each message is prefixed with a 4-byte little-endian length (u32).
///   - stdin → messages from the extension; stdout → responses.
///   - The host exits when stdin closes (extension closed / reloaded).
///
/// Request shapes (JSON):
///   { "type": "READ_VAULT" }
///   { "type": "WRITE_VAULT", "blob": "<json-string>" }
///   { "type": "VAULT_EXISTS" }
///
/// Response shapes:
///   { "ok": true }                              — WRITE_VAULT success
///   { "ok": true, "blob": "<json-string>" }     — READ_VAULT result (blob absent when no file)
///   { "ok": true, "exists": true|false }        — VAULT_EXISTS result
///   { "ok": false, "error": "<message>" }       — any failure

use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
enum Request {
    ReadVault { name: Option<String> },
    WriteVault { blob: String },
    VaultExists,
    ListVaults,
}

fn vault_path() -> Result<PathBuf, String> {
    Ok(vault_dir()?.join("vault.json"))
}

fn read_msg(stdin: &mut impl Read) -> io::Result<Option<Value>> {
    let mut len_buf = [0u8; 4];
    match stdin.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    let mut body = vec![0u8; len];
    stdin.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

fn write_msg(stdout: &mut impl Write, response: Value) -> io::Result<()> {
    let body = serde_json::to_vec(&response).unwrap_or_default();
    let len = (body.len() as u32).to_le_bytes();
    stdout.write_all(&len)?;
    stdout.write_all(&body)?;
    stdout.flush()
}

fn vault_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs_next::data_local_dir()
        .ok_or_else(|| "Could not determine data directory".to_string())?;
    Ok(base.join("personal-vault"))
}

fn sanitize_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') || !name.ends_with(".json") {
        return Err(format!("Invalid vault filename: {name}"));
    }
    Ok(name)
}

fn handle(req: Request) -> Value {
    match req {
        Request::ListVaults => {
            let dir = match vault_dir() {
                Ok(d) => d,
                Err(e) => return json!({ "ok": false, "error": e }),
            };
            if !dir.exists() {
                return json!({ "ok": true, "vaults": [] });
            }
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(e) => return json!({ "ok": false, "error": format!("Read dir: {e}") }),
            };
            let mut vaults = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if !name.ends_with(".json") || name.ends_with(".tmp") {
                    continue;
                }
                if let Ok(content) = fs::read_to_string(&path) {
                    vaults.push(json!({ "name": name, "content": content }));
                }
            }
            json!({ "ok": true, "vaults": vaults })
        }
        Request::VaultExists => match vault_path() {
            Ok(p) => json!({ "ok": true, "exists": p.exists() }),
            Err(e) => json!({ "ok": false, "error": e }),
        },
        Request::ReadVault { name } => {
            let path_result = match name.as_deref() {
                Some(n) => sanitize_name(n).map(|n| vault_dir().map(|d| d.join(n))).and_then(|r| r),
                None => vault_path(),
            };
            match path_result {
                Err(e) => json!({ "ok": false, "error": e }),
                Ok(path) => {
                    if !path.exists() {
                        return json!({ "ok": true });
                    }
                    match fs::read_to_string(&path) {
                        Ok(s) => json!({ "ok": true, "blob": s }),
                        Err(e) => json!({ "ok": false, "error": format!("Read error: {e}") }),
                    }
                }
            }
        }
        Request::WriteVault { blob } => match vault_path() {
            Err(e) => json!({ "ok": false, "error": e }),
            Ok(path) => {
                let result = path
                    .parent()
                    .ok_or_else(|| "No parent directory".to_string())
                    .and_then(|dir| {
                        fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))
                    })
                    .and_then(|_| {
                        fs::write(&path, &blob).map_err(|e| format!("Write error: {e}"))
                    });
                match result {
                    Ok(_) => json!({ "ok": true }),
                    Err(e) => json!({ "ok": false, "error": e }),
                }
            }
        },
    }
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdin = stdin.lock();
    let mut stdout = stdout.lock();

    loop {
        let msg = match read_msg(&mut stdin) {
            Ok(Some(v)) => v,
            Ok(None) => break,
            Err(_) => break,
        };

        let response = match serde_json::from_value::<Request>(msg) {
            Ok(req) => handle(req),
            Err(e) => json!({ "ok": false, "error": format!("Bad request: {e}") }),
        };

        if write_msg(&mut stdout, response).is_err() {
            break;
        }
    }
}
