/**
 * Sync relay — Cloudflare Worker.
 *
 * The relay is intentionally dumb: it stores and returns opaque encrypted blobs.
 * It never sees plaintext. Auth is proved by signing a relay-issued nonce with
 * the owner's Ed25519 key (the same key that anchors the vault's DID).
 *
 * Endpoints:
 *   POST /challenge          — issue a random nonce (30 s TTL)
 *   PUT  /vault/:ownerId     — store the vault blob after verifying signed nonce
 *   GET  /vault/:ownerId     — retrieve the vault blob after verifying signed nonce
 *
 * KV keys:
 *   nonce:<nonce>            — JSON { ownerId, expiresAt }, TTL 60 s
 *   vault:<ownerId>          — JSON { blob: PersistedVault, updatedAt: ISO string }
 *   pubkey:<ownerId>         — base64url-encoded Ed25519 public key (32 bytes)
 */

export interface Env {
  VAULT_KV: KVNamespace
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Vault-Nonce, X-Vault-Signature, X-Vault-PublicKey',
}

const MAX_VAULT_BYTES = 5 * 1024 * 1024  // 5 MB

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function err(msg: string, status: number): Response {
  return json({ error: msg }, status)
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

function bytesToB64url(buf: Uint8Array): string {
  let bin = ''
  for (const b of buf) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function verifyEd25519(
  publicKeyBytes: Uint8Array,
  message: Uint8Array,
  signatureBytes: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw', publicKeyBytes,
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify({ name: 'Ed25519' }, key, signatureBytes, message)
}

// ── Challenge endpoint ────────────────────────────────────────────────────────

async function handleChallenge(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const ownerId = url.searchParams.get('ownerId')
  if (!ownerId) return err('Missing ownerId query parameter', 400)

  const nonce = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)))
  const expiresAt = new Date(Date.now() + 60_000).toISOString()

  // Store nonce bound to the requesting ownerId to prevent cross-owner reuse
  await env.VAULT_KV.put(
    `nonce:${nonce}`,
    JSON.stringify({ ownerId, expiresAt }),
    { expirationTtl: 60 },
  )

  return json({ nonce })
}

// ── Shared auth verification ──────────────────────────────────────────────────

interface AuthHeaders {
  ownerId: string
  nonce: string
  signature: string  // base64url Ed25519 sig over "<nonce>.<ownerId>"
  publicKey: string  // base64url-encoded 32-byte Ed25519 public key (first-time registration)
}

async function verifyAuth(
  env: Env,
  ownerId: string,
  nonce: string,
  signatureB64: string,
  publicKeyB64: string | null,
): Promise<{ ok: boolean; error?: string }> {
  // 1. Validate nonce — must exist, not be expired, and be bound to this ownerId
  const nonceEntry = await env.VAULT_KV.get<{ ownerId: string; expiresAt: string }>(
    `nonce:${nonce}`, 'json',
  )
  if (!nonceEntry) return { ok: false, error: 'Nonce not found or expired' }
  if (nonceEntry.ownerId !== ownerId) return { ok: false, error: 'Nonce was not issued for this owner' }
  if (new Date(nonceEntry.expiresAt) < new Date()) {
    return { ok: false, error: 'Nonce expired' }
  }

  // 2. Resolve the owner's public key
  let storedPubKey = await env.VAULT_KV.get(`pubkey:${ownerId}`)
  if (!storedPubKey) {
    // First-time registration: client must provide their public key
    if (!publicKeyB64) return { ok: false, error: 'Unknown owner; supply public key for registration' }
    storedPubKey = publicKeyB64
    // Will be persisted after successful signature verification below
  } else if (publicKeyB64 && publicKeyB64 !== storedPubKey) {
    return { ok: false, error: 'Public key mismatch' }
  }

  // 3. Verify signature over "<nonce>.<ownerId>"
  const message = new TextEncoder().encode(`${nonce}.${ownerId}`)
  const signatureBytes = b64urlToBytes(signatureB64)
  const publicKeyBytes = b64urlToBytes(storedPubKey)

  let valid: boolean
  try {
    valid = await verifyEd25519(publicKeyBytes, message, signatureBytes)
  } catch {
    return { ok: false, error: 'Signature verification failed' }
  }
  if (!valid) return { ok: false, error: 'Invalid signature' }

  // 4. Consume nonce (delete it so it can't be replayed)
  await env.VAULT_KV.delete(`nonce:${nonce}`)

  // 5. If this was first-time registration, persist the public key now
  if (!await env.VAULT_KV.get(`pubkey:${ownerId}`)) {
    await env.VAULT_KV.put(`pubkey:${ownerId}`, storedPubKey)
  }

  return { ok: true }
}

// ── PUT /vault/:ownerId ───────────────────────────────────────────────────────

async function handlePut(req: Request, env: Env, ownerId: string): Promise<Response> {
  const nonce = req.headers.get('X-Vault-Nonce')
  const signature = req.headers.get('X-Vault-Signature')
  const publicKey = req.headers.get('X-Vault-PublicKey')  // optional after first registration

  if (!nonce || !signature) return err('Missing auth headers', 400)

  const auth = await verifyAuth(env, ownerId, nonce, signature, publicKey)
  if (!auth.ok) return err(auth.error ?? 'Unauthorized', 401)

  const contentLength = Number(req.headers.get('Content-Length') ?? '0')
  if (contentLength > MAX_VAULT_BYTES) return err('Vault blob exceeds 5 MB limit', 413)

  let body: unknown
  try {
    const text = await req.text()
    if (new TextEncoder().encode(text).length > MAX_VAULT_BYTES) return err('Vault blob exceeds 5 MB limit', 413)
    body = JSON.parse(text)
  } catch {
    return err('Invalid JSON body', 400)
  }

  const updatedAt = new Date().toISOString()
  await env.VAULT_KV.put(`vault:${ownerId}`, JSON.stringify({ blob: body, updatedAt }))

  return json({ ok: true, updatedAt })
}

// ── GET /vault/:ownerId ───────────────────────────────────────────────────────

async function handleGet(req: Request, env: Env, ownerId: string): Promise<Response> {
  const nonce = req.headers.get('X-Vault-Nonce')
  const signature = req.headers.get('X-Vault-Signature')
  const publicKey = req.headers.get('X-Vault-PublicKey')

  if (!nonce || !signature) return err('Missing auth headers', 400)

  const auth = await verifyAuth(env, ownerId, nonce, signature, publicKey)
  if (!auth.ok) return err(auth.error ?? 'Unauthorized', 401)

  const stored = await env.VAULT_KV.get<{ blob: unknown; updatedAt: string }>(
    `vault:${ownerId}`, 'json',
  )
  if (!stored) return err('No vault found', 404)

  return json({ blob: stored.blob, updatedAt: stored.updatedAt })
}

// ── Router ────────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)

    if (req.method === 'POST' && parts[0] === 'challenge') {
      return handleChallenge(req, env)
    }

    if (parts[0] === 'vault' && parts[1]) {
      const ownerId = decodeURIComponent(parts[1])
      if (req.method === 'PUT') return handlePut(req, env, ownerId)
      if (req.method === 'GET') return handleGet(req, env, ownerId)
    }

    return err('Not found', 404)
  },
}
