/**
 * Sync relay client — push and pull the encrypted vault blob to/from the relay.
 *
 * The relay is a Cloudflare Worker (relay/worker.ts) that stores opaque blobs.
 * Auth uses the owner's Ed25519 keypair: the relay issues a nonce, the client
 * signs "<nonce>.<ownerId>" and sends the signature in a request header.
 *
 * The relay never sees plaintext. Merge is purely local: after pulling, we
 * compare audit log depths and keep whichever copy has more history.
 */

import { sign, to_base64 } from './crypto'
import type { PersistedVault } from './vault'

export interface RelayConfig {
  url: string       // base URL, no trailing slash, e.g. "https://vault.example.workers.dev"
  ownerId: string
}

export interface SyncResult {
  action: 'pushed' | 'pulled' | 'already-current' | 'first-push'
  updatedAt: string
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function fetchChallenge(relayUrl: string): Promise<string> {
  const res = await fetch(`${relayUrl}/challenge`, { method: 'POST' })
  if (!res.ok) throw new Error(`Challenge failed: ${res.status}`)
  const { nonce } = await res.json() as { nonce: string }
  if (!nonce) throw new Error('Relay returned no nonce')
  return nonce
}

async function buildAuthHeaders(
  ownerId: string,
  nonce: string,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  isFirstTime: boolean,
): Promise<Record<string, string>> {
  const message = new TextEncoder().encode(`${nonce}.${ownerId}`)
  const signature = await sign(message, privateKey)
  const publicKeyB64 = await to_base64(publicKey)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Vault-Nonce': nonce,
    'X-Vault-Signature': signature,
  }
  // Always send public key on first push; relay stores it for subsequent requests
  if (isFirstTime) headers['X-Vault-PublicKey'] = publicKeyB64
  return headers
}

// ── Push ──────────────────────────────────────────────────────────────────────

/**
 * Upload the local vault blob to the relay.
 * Pass `isFirstRegistration = true` on the very first push so the relay can
 * register the owner's public key.
 */
export async function pushVault(
  config: RelayConfig,
  blob: PersistedVault,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  isFirstRegistration = false,
): Promise<{ updatedAt: string }> {
  const nonce = await fetchChallenge(config.url)
  const headers = await buildAuthHeaders(
    config.ownerId, nonce, privateKey, publicKey, isFirstRegistration,
  )

  const res = await fetch(`${config.url}/vault/${encodeURIComponent(config.ownerId)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(blob),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Push failed (${res.status}): ${body}`)
  }

  const { updatedAt } = await res.json() as { updatedAt: string }
  return { updatedAt }
}

// ── Pull ──────────────────────────────────────────────────────────────────────

/**
 * Download the vault blob from the relay.
 * Returns null if no vault has been pushed yet.
 */
export async function pullVault(
  config: RelayConfig,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<{ blob: PersistedVault; updatedAt: string } | null> {
  const nonce = await fetchChallenge(config.url)
  const headers = await buildAuthHeaders(
    config.ownerId, nonce, privateKey, publicKey, false,
  )
  // Remove Content-Type header for GET
  delete headers['Content-Type']

  const res = await fetch(`${config.url}/vault/${encodeURIComponent(config.ownerId)}`, {
    method: 'GET',
    headers,
  })

  if (res.status === 404) return null

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Pull failed (${res.status}): ${body}`)
  }

  const { blob, updatedAt } = await res.json() as { blob: PersistedVault; updatedAt: string }
  return { blob, updatedAt }
}

// ── Merge ─────────────────────────────────────────────────────────────────────

/**
 * Decide which blob to keep after a pull.
 *
 * The vault is single-user and append-only (audit log only grows).
 * We pick the copy with the longer audit log — it represents more activity.
 * If both have the same depth (or we can't decrypt either), prefer remote
 * since the push was deliberate.
 *
 * NOTE: this function works on sealed (encrypted) blobs; it can only use
 * the header to compare, not the audit log itself. We add a `sequenceNumber`
 * to the VaultHeader on each seal so we can compare without decrypting.
 *
 * For vaults that predate this field, falls back to preferring remote.
 */
export function chooseBlobToKeep(
  local: PersistedVault,
  remote: PersistedVault,
): { chosen: PersistedVault; source: 'local' | 'remote' } {
  const localSeq = (local.header as { sequenceNumber?: number }).sequenceNumber ?? 0
  const remoteSeq = (remote.header as { sequenceNumber?: number }).sequenceNumber ?? 0
  if (localSeq > remoteSeq) return { chosen: local, source: 'local' }
  return { chosen: remote, source: 'remote' }
}

// ── Sync (push+pull combined) ─────────────────────────────────────────────────

/**
 * Full sync: pull from relay, compare with local, push whichever is newer.
 * Returns the blob to persist locally and what action was taken.
 *
 * Callers are responsible for sealing the vault before calling this and
 * persisting the returned blob afterwards.
 */
export async function syncVault(
  config: RelayConfig,
  localBlob: PersistedVault,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<{ blob: PersistedVault; result: SyncResult }> {
  const remote = await pullVault(config, privateKey, publicKey)

  if (!remote) {
    // No remote copy yet — push ours and register the public key
    const { updatedAt } = await pushVault(config, localBlob, privateKey, publicKey, true)
    return { blob: localBlob, result: { action: 'first-push', updatedAt } }
  }

  const { chosen, source } = chooseBlobToKeep(localBlob, remote.blob)
  const updatedAt = new Date().toISOString()

  if (source === 'local') {
    // Local is newer — push it
    const pushed = await pushVault(config, localBlob, privateKey, publicKey)
    return { blob: localBlob, result: { action: 'pushed', updatedAt: pushed.updatedAt } }
  }

  const localSeq = (localBlob.header as { sequenceNumber?: number }).sequenceNumber ?? 0
  const remoteSeq = (remote.blob.header as { sequenceNumber?: number }).sequenceNumber ?? 0

  if (localSeq === remoteSeq) {
    return { blob: localBlob, result: { action: 'already-current', updatedAt: remote.updatedAt } }
  }

  // Remote is newer — return it so the caller can replace local storage
  return { blob: chosen, result: { action: 'pulled', updatedAt: remote.updatedAt } }
}
