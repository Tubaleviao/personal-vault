/**
 * Cloud / removable storage sync — read and write the sealed vault file at a
 * user-chosen path (iCloud Drive, Dropbox, Google Drive, flash drive, ...).
 *
 * The vault file is already fully encrypted; this module only moves opaque
 * bytes. Writes are atomic (write to `<path>.tmp`, then rename).
 */

import { promises as fs } from 'fs'
import * as nodePath from 'path'
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
  } catch {
    return true
  }
}

async function mapError(err: unknown, path: string): Promise<VaultStorageError> {
  if (err instanceof VaultStorageError) return err
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new VaultStorageError('PERMISSION_DENIED', path, err)
  if (code === 'ENOSPC' || code === 'EDQUOT') return new VaultStorageError('DRIVE_FULL', path, err)
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENODEV' || code === 'EIO') {
    return new VaultStorageError(await detectDriveMissing(path) ? 'DRIVE_MISSING' : 'NOT_FOUND', path, err)
  }
  return new VaultStorageError('CORRUPT', path, err)
}

function isPersistedVault(v: unknown): v is PersistedVault {
  const o = v as PersistedVault | null
  return !!o && typeof o === 'object'
    && !!o.header && typeof o.header === 'object'
    && typeof o.header.ownerId === 'string'
    && typeof o.header.salt === 'string'
    && !!o.encrypted && typeof o.encrypted === 'object'
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
  if (await detectDriveMissing(path)) throw new VaultStorageError('DRIVE_MISSING', path)
  const tmp = `${path}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(blob), { mode: 0o600 })
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw await mapError(err, path)
  }
}
