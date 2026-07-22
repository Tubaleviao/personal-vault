/**
 * Thin bridge between the Tauri command layer and the vault library.
 * Screens import from here; they never call invoke() directly.
 */

import { invoke } from '@tauri-apps/api/core'
import type { PersistedVault } from '@vault/vault'

export async function readVaultFile(): Promise<PersistedVault | null> {
  const raw = await invoke<string | null>('read_vault_file')
  if (raw === null) return null
  return JSON.parse(raw) as PersistedVault
}

export async function writeVaultFile(vault: PersistedVault): Promise<void> {
  await invoke<void>('write_vault_file', { blob: JSON.stringify(vault) })
}

export async function vaultFileExists(): Promise<boolean> {
  return invoke<boolean>('vault_file_exists')
}
