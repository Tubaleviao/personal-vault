/**
 * Pure (no Node fs) helpers for validating a sealed vault file. Shared by
 * src/storage.ts and the browser extension's file-import fallback.
 */

import type { PersistedVault } from './vault'
import { SCRYPT_N_MIN, SCRYPT_N_MAX } from './crypto'

export function isPersistedVault(v: unknown): v is PersistedVault {
  const o = v as PersistedVault | null
  return !!o && typeof o === 'object'
    && !!o.header && typeof o.header === 'object'
    && typeof o.header.ownerId === 'string'
    && typeof o.header.salt === 'string'
    && typeof o.header.keyVerificationHash === 'string'
    // sequenceNumber is absent in legacy vaults; Vault.seal treats it as 0.
    && (o.header.sequenceNumber === undefined
      || (Number.isInteger(o.header.sequenceNumber) && o.header.sequenceNumber >= 0))
    // scryptN is absent in legacy vaults; Vault.open falls back to SCRYPT_N_V1.
    && (o.header.scryptN === undefined
      || (Number.isInteger(o.header.scryptN) && o.header.scryptN >= SCRYPT_N_MIN && o.header.scryptN <= SCRYPT_N_MAX
        && (o.header.scryptN & (o.header.scryptN - 1)) === 0))
    && !!o.encrypted && typeof o.encrypted === 'object'
    && typeof o.encrypted.nonce === 'string'
    && typeof o.encrypted.ciphertext === 'string'
}

/** Parse and shape-check vault file text. Returns null if it is not a valid sealed vault. */
export function parseVaultFileText(text: string): PersistedVault | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  return isPersistedVault(parsed) ? parsed : null
}
