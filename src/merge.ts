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

/** Human-readable note on changes a merge made beyond adding claims (deletions, overwrites, revoked grants). */
export function describeMergeChanges(s: MergeSummary): string {
  const parts: string[] = []
  if (s.deleted > 0) parts.push(`${s.deleted} deleted`)
  if (s.remoteWins > 0) parts.push(`${s.remoteWins} replaced by newer copy`)
  if (s.grantsRevoked > 0) parts.push(`${s.grantsRevoked} grant${s.grantsRevoked === 1 ? '' : 's'} revoked`)
  return parts.join(', ')
}

/**
 * Merge `other` into `vault`. Same owner: full merge (tombstones, last-writer-wins).
 * Different owners: claims are imported one by one. Returns the added count and a change note.
 */
export function mergeOrImport(vault: Vault, other: Vault): { added: number; note: string } {
  if (vault.owner.id === other.owner.id) {
    const summary = vault.mergeFrom(other)
    return { added: summary.onlyRemote, note: describeMergeChanges(summary) }
  }
  const before = vault.listClaims().length
  for (const claim of other.listClaims()) vault.importClaim(claim)
  return { added: Math.max(0, vault.listClaims().length - before), note: '' }
}
