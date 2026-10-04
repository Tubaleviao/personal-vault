/**
 * Thin bridge between the Tauri command layer and the vault library.
 * Screens import from here; they never call invoke() directly.
 *
 * `setActiveVaultName` lets the Unlock screen pick a non-default vault file;
 * subsequent reads and writes go to that file until the name is reset.
 */

import { invoke } from '@tauri-apps/api/core'
import type { PersistedVault } from '@vault/vault'

let _activeVaultName = 'vault.json'

/** Switch which vault file all subsequent reads/writes target. */
export function setActiveVaultName(name: string): void {
  _activeVaultName = name
}

/** Return the filename currently being used for vault I/O. */
export function getActiveVaultName(): string {
  return _activeVaultName
}

export async function readVaultFile(): Promise<PersistedVault | null> {
  const raw = await invoke<string | null>('read_vault_file', { name: _activeVaultName })
  if (raw === null) return null
  try {
    return JSON.parse(raw) as PersistedVault
  } catch {
    return null
  }
}

export async function writeVaultFile(vault: PersistedVault): Promise<void> {
  await invoke<void>('write_vault_file', { blob: JSON.stringify(vault), name: _activeVaultName })
  await mirrorToStorage(vault)
}

// ── External storage (cloud folder / flash drive) ────────────────────────────

export type StorageErrorCode =
  | 'NOT_CONFIGURED' | 'NOT_FOUND' | 'DRIVE_MISSING'
  | 'PERMISSION_DENIED' | 'CORRUPT' | 'DRIVE_FULL' | 'IO'

export const STORAGE_MESSAGES: Record<StorageErrorCode, string> = {
  NOT_CONFIGURED: 'Choose a sync location in Settings to keep your vault in sync across devices.',
  NOT_FOUND: 'Vault file not found at the configured path. Has the file been moved?',
  DRIVE_MISSING: 'External drive not found. Plug in your drive and try again.',
  PERMISSION_DENIED: 'Cannot read vault file — check folder permissions.',
  CORRUPT: 'The file at the sync path does not appear to be a valid vault.',
  DRIVE_FULL: 'The storage location is full. Free up space and try again.',
  IO: 'Could not access the storage location.',
}

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, detail?: string) {
    super(STORAGE_MESSAGES[code] + (detail && code === 'IO' ? ` (${detail})` : ''))
    this.name = 'StorageError'
  }
}

/** Parse the `CODE: message` strings produced by the Rust storage commands. */
function toStorageError(err: unknown): StorageError {
  const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
  const m = /^([A-Z_]+): ?([\s\S]*)$/.exec(msg)
  if (m && m[1] in STORAGE_MESSAGES) return new StorageError(m[1] as StorageErrorCode, m[2])
  return new StorageError('IO', msg)
}

let _lastSyncError: StorageError | null = null

/** Error from the most recent mirror/reconcile attempt, or null if it succeeded. */
export function getLastSyncError(): StorageError | null {
  return _lastSyncError
}

export async function getStoragePath(): Promise<string | null> {
  return invoke<string | null>('get_storage_path')
}

export async function setStoragePath(path: string | null): Promise<void> {
  try {
    await invoke<void>('set_storage_path', { path })
  } catch (err) {
    throw toStorageError(err)
  }
}

function looksLikeVault(o: unknown): o is PersistedVault {
  const v = o as PersistedVault | null
  return !!v && typeof v === 'object'
    && !!v.header && typeof v.header === 'object' && typeof v.header.version !== 'undefined'
    && !!v.encrypted && typeof v.encrypted === 'object'
}

/** Read and validate the vault at the configured storage path. Throws StorageError. */
export async function readStorageVault(path?: string | null): Promise<PersistedVault> {
  const p = path ?? await getStoragePath()
  if (!p) throw new StorageError('NOT_CONFIGURED')
  let raw: string
  try {
    raw = await invoke<string>('read_external_vault', { path: p })
  } catch (err) {
    throw toStorageError(err)
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new StorageError('CORRUPT') }
  if (!looksLikeVault(parsed)) throw new StorageError('CORRUPT')
  return parsed
}

/** Write the sealed vault to the storage path, if one is configured. Never throws; records the error. */
async function mirrorToStorage(vault: PersistedVault): Promise<void> {
  try {
    const path = await getStoragePath()
    if (!path) { _lastSyncError = null; return }
    await invoke<void>('write_external_vault', { path, blob: JSON.stringify(vault) })
    _lastSyncError = null
  } catch (err) {
    _lastSyncError = toStorageError(err)
  }
}

const seqOf = (v: PersistedVault) => v.header.sequenceNumber ?? 0

/** Which copy is newer, by header.sequenceNumber. */
export function compareCopies(local: PersistedVault | null, remote: PersistedVault | null): 'local' | 'remote' | 'same' {
  if (!local && !remote) return 'same'
  if (!local) return 'remote'
  if (!remote) return 'local'
  const a = seqOf(local), b = seqOf(remote)
  return a === b ? 'same' : a > b ? 'local' : 'remote'
}

/**
 * Startup read: use the storage copy when the local copy is absent or older
 * (and refresh the local file); push the local copy out when the storage copy
 * is older. Storage errors never block opening a local vault.
 */
export async function readVaultFileSynced(): Promise<PersistedVault | null> {
  const local = await readVaultFile()
  const path = await getStoragePath().catch(() => null)
  if (!path) { _lastSyncError = null; return local }
  let remote: PersistedVault | null = null
  try {
    remote = await readStorageVault(path)
    _lastSyncError = null
  } catch (err) {
    const e = err instanceof StorageError ? err : toStorageError(err)
    // A file that doesn't exist yet is normal on first sync; seed it below.
    _lastSyncError = e.code === 'NOT_FOUND' && local ? null : e
    if (e.code !== 'NOT_FOUND' && !local) throw e
  }
  const newer = compareCopies(local, remote)
  if (newer === 'remote' && remote) {
    await invoke<void>('write_vault_file', { blob: JSON.stringify(remote), name: _activeVaultName })
    return remote
  }
  if (newer === 'local' && local) await mirrorToStorage(local)
  return local
}

export async function vaultFileExists(): Promise<boolean> {
  return invoke<boolean>('vault_file_exists')
}

export interface VaultFileEntry {
  name: string
  vault: PersistedVault
}

/** Delete a specific vault file by name. */
export async function deleteVaultFile(name: string): Promise<void> {
  await invoke<void>('delete_vault_file', { name })
}

/** List all *.json vault files in the vault directory. Invalid JSON files are skipped. */
export async function listVaultFiles(): Promise<VaultFileEntry[]> {
  const raw = await invoke<Array<{ name: string; content: string }>>('list_vault_files')
  const results: VaultFileEntry[] = []
  for (const entry of raw) {
    try {
      const parsed = JSON.parse(entry.content) as PersistedVault
      if (parsed?.header?.version && parsed?.encrypted) {
        results.push({ name: entry.name, vault: parsed })
      }
    } catch {
      // not a valid vault file — skip
    }
  }
  return results
}
