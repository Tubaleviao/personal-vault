import { Vault } from './vault'
import type { PersistedVault, MergeSummary } from './vault'

/**
 * Open both copies with `passphrase`, merge remote into local (see
 * Vault.mergeFrom for the conflict policy) and return the sealed result with
 * a summary for the UI. Throws if the passphrase is wrong or owners differ.
 * Pure (no fs): shared by the Node library and the desktop UI bundle.
 */
export async function mergeVaultsWithSummary(
  local: PersistedVault, remote: PersistedVault, passphrase: string,
): Promise<{ vault: PersistedVault; summary: MergeSummary }> {
  const a = await Vault.open(local, passphrase)
  let b: Vault | undefined
  try {
    b = await Vault.open(remote, passphrase, { recordUnlock: false })
    const summary: MergeSummary = a.mergeFrom(b)
    return { vault: await a.seal(), summary }
  } finally {
    try { await b?.discard() } finally { await a.discard() }
  }
}

/**
 * Merge `other` into `vault`. Same owner: full merge (tombstones, last-writer-wins).
 * Different owners: claims are imported one by one. Returns the added count and change counts (UIs localize them).
 */
export interface MergeChanges { deleted: number; remoteWins: number; grantsRevoked: number }

export function mergeOrImport(vault: Vault, other: Vault): { added: number; changes: MergeChanges } {
  if (vault.owner.id === other.owner.id) {
    const summary = vault.mergeFrom(other)
    return {
      added: summary.onlyRemote,
      changes: { deleted: summary.deleted, remoteWins: summary.remoteWins, grantsRevoked: summary.grantsRevoked },
    }
  }
  const before = vault.listClaims().length
  for (const claim of other.listClaims()) vault.importClaim(claim)
  return { added: Math.max(0, vault.listClaims().length - before), changes: { deleted: 0, remoteWins: 0, grantsRevoked: 0 } }
}
