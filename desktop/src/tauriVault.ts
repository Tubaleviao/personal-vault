/**
 * Thin bridge between the Tauri command layer and the vault library.
 * Screens import from here; they never call invoke() directly.
 *
 * `setActiveVaultName` lets the Unlock screen pick a non-default vault file;
 * subsequent reads and writes go to that file until the name is reset.
 */

import { invoke } from '@tauri-apps/api/core'
import type { PersistedVault } from '@vault/vault'
import { isPersistedVault } from '@vault/vault-file'

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
  // Never return null for an unreadable file: callers treat null as "no vault" and offer to create one over it.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Local vault file is corrupt (not valid JSON); it was left untouched')
  }
  if (!isPersistedVault(parsed)) throw new Error('Local vault file is not a valid vault; it was left untouched')
  return parsed
}

/** Write the local working copy only, without mirroring to storage (used by merge, which mirrors with force). */
export async function writeLocalVaultFile(vault: PersistedVault): Promise<void> {
  await invoke<void>('write_vault_file', { blob: JSON.stringify(vault), name: _activeVaultName })
}

export async function writeVaultFile(vault: PersistedVault): Promise<void> {
  await invoke<void>('write_vault_file', { blob: JSON.stringify(vault), name: _activeVaultName })
  await mirrorToStorage(vault)
}

// ── External storage (cloud folder / flash drive) ────────────────────────────

export type StorageErrorCode =
  | 'NOT_CONFIGURED' | 'NOT_FOUND' | 'DRIVE_MISSING'
  | 'PERMISSION_DENIED' | 'CORRUPT' | 'DRIVE_FULL' | 'IO'
  | 'CONFLICT' | 'OWNER_MISMATCH'

export const STORAGE_MESSAGES: Record<StorageErrorCode, string> = {
  NOT_CONFIGURED: 'No sync location set. Enter the full path to your vault file on the Storage screen.',
  NOT_FOUND: 'Vault file not found at the configured path. Has the file been moved?',
  DRIVE_MISSING: 'External drive not found. Plug in your drive and try again.',
  PERMISSION_DENIED: 'Cannot read vault file — check folder permissions.',
  CORRUPT: 'The file at the sync path does not appear to be a valid vault.',
  DRIVE_FULL: 'The storage location is full. Free up space and try again.',
  IO: 'Could not access the storage location.',
  CONFLICT: 'The storage copy has changes this device does not have (newer or diverged). It was left untouched; use "Use local copy" on the Storage screen to overwrite it.',
  OWNER_MISMATCH: 'The file at the sync path belongs to a different vault. It was left untouched.',
}

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, detail?: string) {
    super(STORAGE_MESSAGES[code] + (detail && (code === 'IO' || code === 'NOT_CONFIGURED') ? ` (${detail})` : ''))
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
  try {
    return await invoke<string | null>('get_storage_path')
  } catch (err) {
    throw toStorageError(err)
  }
}

export async function setStoragePath(path: string | null): Promise<void> {
  try {
    await invoke<void>('set_storage_path', { path })
    // The sync base describes the previous location's shared history; drop it.
    // The storage path is shared by every vault, so drop every vault's base.
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(BASE_PREFIX)) localStorage.removeItem(k)
    } catch { /* storage unavailable */ }
  } catch (err) {
    throw toStorageError(err)
  }
}

/** Read and validate the vault at the configured storage path. Throws StorageError. */
export async function readStorageVault(path?: string | null): Promise<PersistedVault> {
  let raw: string
  try {
    const p = path ?? await getStoragePath()
    if (!p) throw new StorageError('NOT_CONFIGURED')
    raw = await invoke<string>('read_external_vault', { path: p })
  } catch (err) {
    throw err instanceof StorageError ? err : toStorageError(err)
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new StorageError('CORRUPT') }
  if (!isPersistedVault(parsed)) throw new StorageError('CORRUPT')
  return parsed
}

const seqOf = (v: PersistedVault) => v.header.sequenceNumber ?? 0

// ── Sync base ────────────────────────────────────────────────────────────────
// Every seal gets a fresh random nonce. We remember the nonce of the last copy that
// was known identical on both sides (after a mirror, adopt or match). A copy whose
// nonce differs from that base has changed since; if both sides changed, they diverged
// even when their sequence numbers differ.

const BASE_PREFIX = 'vault-sync-base:'
const baseKey = () => `${BASE_PREFIX}${_activeVaultName}`

export function getSyncBase(): string | null {
  try { return localStorage.getItem(baseKey()) } catch { return null }
}

function setSyncBase(v: PersistedVault): void {
  try { localStorage.setItem(baseKey(), v.encrypted.nonce) } catch { /* storage unavailable */ }
}

export type CopyComparison = 'local' | 'remote' | 'same' | 'conflict'

/**
 * Which copy is newer. With a known sync `base` (nonce of the last copy both sides shared),
 * changes on both sides are a 'conflict'. Without one, falls back to header.sequenceNumber;
 * equal sequence numbers with different sealed content are a 'conflict', not 'same'.
 */
export function compareCopies(
  local: PersistedVault | null,
  remote: PersistedVault | null,
  base: string | null = null,
): CopyComparison {
  if (!local && !remote) return 'same'
  if (!local) return 'remote'
  if (!remote) return 'local'
  if (local.encrypted.nonce === remote.encrypted.nonce
    && local.encrypted.ciphertext === remote.encrypted.ciphertext) return 'same'
  if (base) {
    const localChanged = local.encrypted.nonce !== base
    const remoteChanged = remote.encrypted.nonce !== base
    if (localChanged && remoteChanged) return 'conflict'
    // A side that changed since the base but has a LOWER sequence number than the other
    // is a rolled-back/foreign copy, not a newer one: never let it overwrite.
    if (remoteChanged) return seqOf(remote) >= seqOf(local) ? 'remote' : 'conflict'
    if (localChanged) return seqOf(local) >= seqOf(remote) ? 'local' : 'conflict'
  }
  const a = seqOf(local), b = seqOf(remote)
  if (a !== b) return a > b ? 'local' : 'remote'
  return 'conflict'
}

/**
 * Write the sealed vault to the storage path, if one is configured. Never throws;
 * records the error. Unless `force`, an existing storage copy is only replaced when
 * it belongs to the same vault and is strictly older.
 */
async function mirrorToStorage(vault: PersistedVault, force = false): Promise<void> {
  try {
    const path = await getStoragePath()
    if (!path) { _lastSyncError = null; return }
    if (!force) {
      let remote: PersistedVault | null = null
      try {
        remote = await readStorageVault(path)
      } catch (err) {
        // A missing file is seeded below; any other failure (incl. an unreadable/corrupt
        // file) must not be overwritten blindly.
        if (!(err instanceof StorageError && err.code === 'NOT_FOUND')) throw err
      }
      if (remote) {
        if (remote.header.ownerId !== vault.header.ownerId) throw new StorageError('OWNER_MISMATCH')
        const cmp = compareCopies(vault, remote, getSyncBase())
        if (cmp === 'same') { setSyncBase(vault); _lastSyncError = null; return }
        if (cmp !== 'local') throw new StorageError('CONFLICT')
      }
    }
    await invoke<void>('write_external_vault', { path, blob: JSON.stringify(vault) })
    setSyncBase(vault)
    _lastSyncError = null
  } catch (err) {
    _lastSyncError = err instanceof StorageError ? err : toStorageError(err)
  }
}

/** Explicitly overwrite the storage copy with `vault` (user-confirmed). Never throws; see getLastSyncError. */
export function forceMirrorToStorage(vault: PersistedVault): Promise<void> {
  return mirrorToStorage(vault, true)
}

export interface SyncedRead {
  persisted: PersistedVault | null
  /** The local copy, if any; fall back to it when `persisted` (a storage copy) cannot be opened. */
  local: PersistedVault | null
  /** True when `persisted` came from storage and the local file has NOT been refreshed yet. */
  fromStorage: boolean
}

/**
 * Startup read: use the storage copy when the local copy is absent or older; push the
 * local copy out when the storage copy is older. Storage errors never block opening a
 * local vault. The local file is not touched here: when `fromStorage` is true the caller
 * must call `adoptStorageCopy` after the passphrase has been verified.
 */
export async function readVaultFileSynced(): Promise<SyncedRead> {
  const local = await readVaultFile()
  let path: string | null
  try {
    path = await getStoragePath()
  } catch (err) {
    _lastSyncError = err as StorageError
    return { persisted: local, local, fromStorage: false }
  }
  if (!path) { _lastSyncError = null; return { persisted: local, local, fromStorage: false } }
  let remote: PersistedVault | null = null
  try {
    remote = await readStorageVault(path)
    _lastSyncError = null
  } catch (err) {
    const e = err instanceof StorageError ? err : toStorageError(err)
    // A file that doesn't exist yet is normal on first sync; seed it below.
    _lastSyncError = e.code === 'NOT_FOUND' && local ? null : e
    if (e.code !== 'NOT_FOUND' && !local) throw e
    // Don't hit a dead mount a second time via the mirror.
    if (e.code !== 'NOT_FOUND') return { persisted: local, local, fromStorage: false }
  }
  if (local && remote && local.header.ownerId !== remote.header.ownerId) {
    _lastSyncError = new StorageError('OWNER_MISMATCH')
    return { persisted: local, local, fromStorage: false }
  }
  const newer = compareCopies(local, remote, getSyncBase())
  if (newer === 'same' && remote) setSyncBase(remote)
  if (newer === 'remote' && remote) return { persisted: remote, local, fromStorage: true }
  if (newer === 'conflict') _lastSyncError = new StorageError('CONFLICT')
  else if (newer === 'local' && local) await mirrorToStorage(local)
  return { persisted: local, local, fromStorage: false }
}

/** Refresh the local vault file from a storage copy (no mirror back). Call only after a successful unlock. */
export async function adoptStorageCopy(vault: PersistedVault): Promise<void> {
  await invoke<void>('write_vault_file', { blob: JSON.stringify(vault), name: _activeVaultName })
  setSyncBase(vault)
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
