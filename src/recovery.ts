/**
 * Backup & restore via BIP-39 recovery phrase (Step 3.2.2).
 *
 * The mnemonic is derived from 16 bytes (128 bits) of entropy — producing
 * a 12-word phrase. The entropy is used as the Ed25519 keypair seed, so the
 * same phrase restores both the DID signing key and the vault backup access.
 *
 * Flow:
 *   generateMnemonic() → 12-word phrase shown once to user
 *   mnemonicToSeed()   → 64-byte PBKDF2 seed (bip39 standard)
 *   seed.slice(0,32)   → Ed25519 keypair seed (deterministic DID key)
 *   SHA-256(mnemonic)  → mnemonicCommitment stored in VaultHeader (not the mnemonic itself)
 *
 * The mnemonic commitment lets the vault verify the correct phrase was entered
 * during recovery without storing the phrase itself.
 */

import * as bip39 from 'bip39'
import { createHash } from 'crypto'
import { keypairFromSeed } from './crypto'
import type { Ed25519Keypair } from './crypto'

export interface MnemonicBundle {
  mnemonic: string
  mnemonicCommitment: string   // SHA-256(mnemonic) — stored in VaultHeader
  keypair: Ed25519Keypair      // derived deterministically from mnemonic seed
}

/**
 * Generate a fresh 12-word BIP-39 mnemonic and derive the vault root keypair.
 * Call this once at vault creation; show the mnemonic to the user exactly once.
 */
export async function generateMnemonicBundle(): Promise<MnemonicBundle> {
  const mnemonic = bip39.generateMnemonic(128)  // 128-bit entropy → 12 words
  return deriveBundleFromMnemonic(mnemonic)
}

/**
 * Re-derive the keypair from an existing mnemonic (recovery flow).
 * Returns null if the mnemonic is invalid.
 */
export async function restoreFromMnemonic(mnemonic: string): Promise<MnemonicBundle | null> {
  const normalised = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!bip39.validateMnemonic(normalised)) return null
  return deriveBundleFromMnemonic(normalised)
}

/**
 * Verify that a supplied mnemonic matches the commitment stored in the vault header.
 */
export function verifyMnemonicCommitment(mnemonic: string, commitment: string): boolean {
  const normalised = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
  const derived = sha256Hex(normalised)
  return derived === commitment
}

/**
 * Derive a MnemonicBundle from a validated mnemonic string.
 */
async function deriveBundleFromMnemonic(mnemonic: string): Promise<MnemonicBundle> {
  // bip39.mnemonicToSeed returns a 64-byte Buffer
  const seed64 = await bip39.mnemonicToSeed(mnemonic)
  const seed32 = new Uint8Array(seed64.buffer, 0, 32)
  const keypair = await keypairFromSeed(seed32)
  const mnemonicCommitment = sha256Hex(mnemonic)
  return { mnemonic, mnemonicCommitment, keypair }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
