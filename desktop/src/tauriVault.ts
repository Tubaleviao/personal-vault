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
}

export async function vaultFileExists(): Promise<boolean> {
  return invoke<boolean>('vault_file_exists')
}

export interface VaultFileEntry {
  name: string
  vault: PersistedVault
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
