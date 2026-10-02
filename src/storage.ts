/**
 * Cloud / removable storage sync — read and write the sealed vault file at a
 * user-chosen path (iCloud Drive, Dropbox, Google Drive, flash drive, ...).
 *
 * The vault file is already fully encrypted; this module only moves opaque
 * bytes. Writes are atomic (write + fsync a unique tmp file, then rename).
 */

import { promises as fs } from 'fs'
import * as nodePath from 'path'
import { randomBytes } from 'crypto'
import type { PersistedVault } from './vault'

export interface StorageConfig {
  path: string
  label?: string
}

export type VaultStorageErrorCode =
  | 'NOT_CONFIGURED'
  | 'NOT_FOUND'
  | 'DRIVE_MISSING'
  | 'PERMISSION_DENIED'
  | 'CORRUPT'
  | 'DRIVE_FULL'

const MESSAGES: Record<VaultStorageErrorCode, string> = {
  NOT_CONFIGURED: 'Choose a sync location in Settings to keep your vault in sync across devices.',
  NOT_FOUND: 'Vault file not found at the configured path. Has the file been moved?',
  DRIVE_MISSING: 'External drive not found. Plug in your drive and try again.',
  PERMISSION_DENIED: 'Cannot access vault file — check folder permissions.',
  CORRUPT: 'The file at the sync path does not appear to be a valid vault.',
  DRIVE_FULL: 'Not enough free space at the sync location.',
}

export class VaultStorageError extends Error {
  constructor(public readonly code: VaultStorageErrorCode, public readonly path?: string, public readonly cause?: unknown) {
    super(MESSAGES[code])
    this.name = 'VaultStorageError'
  }
}

/**
 * True when the parent directory of `path` does not exist, i.e. the drive or
 * mount point holding it is probably not plugged in / mounted. Distinguishes
 * "drive missing" from "file missing" (parent exists, file does not).
 */
export async function detectDriveMissing(path: string): Promise<boolean> {
  try {
    const st = await fs.stat(nodePath.dirname(path))
    return !st.isDirectory()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return true
    throw err
  }
}

/**
 * Map an fs error to a VaultStorageError. Errors with no meaningful vault-level
 * meaning (EIO, EISDIR, EXDEV, ...) are returned unchanged rather than being
 * mislabelled as CORRUPT or NOT_FOUND.
 */
async function mapError(err: unknown, path: string): Promise<unknown> {
  if (err instanceof VaultStorageError) return err
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new VaultStorageError('PERMISSION_DENIED', path, err)
  if (code === 'ENOSPC' || code === 'EDQUOT') return new VaultStorageError('DRIVE_FULL', path, err)
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENODEV') {
    let missing: boolean
    try { missing = await detectDriveMissing(path) } catch (e) { return await mapError(e, path) }
    return new VaultStorageError(missing ? 'DRIVE_MISSING' : 'NOT_FOUND', path, err)
  }
  return err
}

function isPersistedVault(v: unknown): v is PersistedVault {
  const o = v as PersistedVault | null
  return !!o && typeof o === 'object'
    && !!o.header && typeof o.header === 'object'
    && typeof o.header.ownerId === 'string'
    && typeof o.header.salt === 'string'
    && typeof o.header.keyVerificationHash === 'string'
    && typeof o.header.sequenceNumber === 'number'
    && Number.isFinite(o.header.sequenceNumber)
    && Number.isInteger(o.header.scryptN) && o.header.scryptN >= 16384
    && !!o.encrypted && typeof o.encrypted === 'object'
    && typeof o.encrypted.nonce === 'string'
    && typeof o.encrypted.ciphertext === 'string'
}

export async function readVaultFile(path: string): Promise<PersistedVault> {
  if (!path) throw new VaultStorageError('NOT_CONFIGURED')
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (err) {
    throw await mapError(err, path)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new VaultStorageError('CORRUPT', path, err)
  }
  if (!isPersistedVault(parsed)) throw new VaultStorageError('CORRUPT', path)
  return parsed
}

export async function writeVaultFile(path: string, blob: PersistedVault): Promise<void> {
  if (!path) throw new VaultStorageError('NOT_CONFIGURED')
  let missing: boolean
  try { missing = await detectDriveMissing(path) } catch (err) { throw await mapError(err, path) }
  if (missing) throw new VaultStorageError('DRIVE_MISSING', path)
  // Unique, exclusively-created tmp file: no sharing between concurrent writers,
  // never reuses a stale file (and its permissions).
  // Write through symlinks (e.g. ~/vault -> ~/Dropbox/vault) instead of replacing the link.
  try { path = await fs.realpath(path) } catch { /* file does not exist yet */ }
  // Short fixed-length name keeps us under NAME_MAX for long vault filenames.
  const tmp = nodePath.join(nodePath.dirname(path), `.vault-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  try {
    const fh = await fs.open(tmp, 'wx', 0o600)
    try {
      await fh.writeFile(JSON.stringify(blob))
      try {
        await fh.sync() // flush data before rename so a crash cannot leave a truncated vault
      } catch (err) {
        // Some FUSE / network / exFAT mounts do not support fsync; best effort there.
        const c = (err as NodeJS.ErrnoException)?.code
        if (c !== 'EINVAL' && c !== 'ENOTSUP' && c !== 'ENOSYS' && c !== 'EOPNOTSUPP') throw err
      }
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw await mapError(err, path)
  }
}
