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
