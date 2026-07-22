/**
 * Push sharing: select claims → sign grant → encrypt bundle → shareable token.
 * Verifier: decode token → display claims with self-attested / verified badges.
 *
 * Step 3.2.3 — Push mode is the simplest sharing flow, built first.
 *
 * Bundle format (before encryption):
 *   { grantId, granteeRef, purpose, claims: Claim[], issuedAt, expiresAt | null }
 *
 * Shareable token format:
 *   base64url(JSON({ version, nonce, ciphertext, ownerPublicKey, ownerSig, grantId }))
 *
 * The token is self-contained: the recipient can verify and decrypt it without
 * contacting any server. The ownerSig covers the canonical bundle payload,
 * proving the vault owner created it.
 */

import { randomUUID } from 'crypto'
import { encrypt, decrypt, sign, verify, to_base64, from_base64 } from './crypto'
import type { Claim, Grant } from './vault'

// ── Public types ─────────────────────────────────────────────────────────────

export interface ShareableBundle {
  version: '1'
  grantId: string
  nonce: string           // base64url — XChaCha20 nonce for ciphertext
  ciphertext: string      // base64url — encrypted BundlePayload JSON
  ownerPublicKey: string  // base64url — Ed25519 public key
  ownerSig: string        // base64url — signature over canonical payload
}

export interface BundlePayload {
  grantId: string
  granteeRef: string
  purpose: string
  claims: Array<{
    id: string
    type: string
    value: unknown
    source: Claim['source']
    verification: Claim['verification']
    issuedAt: string
    expiresAt: string | null
    issuerDid: string | null
  }>
  issuedAt: string
  expiresAt: string | null
}

export interface VerificationResult {
  ok: true
  grantId: string
  granteeRef: string
  purpose: string
  issuedAt: string
  expiresAt: string | null
  claims: Array<BundlePayload['claims'][number] & { badge: 'self-attested' | 'verified' | 'imported' }>
}

export interface VerificationFailure {
  ok: false
  reason: 'signature-invalid' | 'decryption-failed' | 'expired' | 'malformed'
}

// ── Bundle creation ───────────────────────────────────────────────────────────

export interface CreateBundleOptions {
  claims: Claim[]
  granteeRef: string
  purpose: string
  expiresAt: Date | null
  ownerPrivateKey: Uint8Array
  ownerPublicKey: Uint8Array
  encryptionKey: Uint8Array
}

/**
 * Build an encrypted, signed push bundle from a list of claims.
 * Returns a ShareableBundle ready to serialise as a QR / link token.
 */
export async function createBundle(opts: CreateBundleOptions): Promise<{ bundle: ShareableBundle; grant: Grant }> {
  const grantId = randomUUID()
  const now = new Date().toISOString()
  const ownerId = '(caller supplies in grant)'

  const payload: BundlePayload = {
    grantId,
    granteeRef: opts.granteeRef,
    purpose: opts.purpose,
    claims: opts.claims.map(c => ({
      id: c.id,
      type: c.type,
      value: c.value,
      source: c.source,
      verification: c.verification,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
      issuerDid: c.issuerDid,
    })),
    issuedAt: now,
    expiresAt: opts.expiresAt?.toISOString() ?? null,
  }

  const canonical = JSON.stringify(sortKeys(payload))
  const canonicalBytes = new TextEncoder().encode(canonical)

  const ownerSig = await sign(canonicalBytes, opts.ownerPrivateKey)
  const encrypted = await encrypt(canonicalBytes, opts.encryptionKey)
  const ownerPublicKeyB64 = await to_base64(opts.ownerPublicKey)

  const bundle: ShareableBundle = {
    version: '1',
    grantId,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    ownerPublicKey: ownerPublicKeyB64,
    ownerSig,
  }

  const grant: Grant = {
    id: grantId,
    ownerId: '',
    granteeRef: opts.granteeRef,
    claimIds: opts.claims.map(c => c.id),
    purpose: opts.purpose,
    mode: 'push',
    singleUse: true,
    expiresAt: opts.expiresAt?.toISOString() ?? null,
    ownerSig,
    status: 'active',
    createdAt: now,
    revokedAt: null,
  }

  return { bundle, grant }
}

/**
 * Encode a ShareableBundle to a compact URL-safe token (base64url of JSON).
 */
export function encodeToken(bundle: ShareableBundle): string {
  const json = JSON.stringify(bundle)
  return Buffer.from(json, 'utf8').toString('base64url')
}

/**
 * Decode a token back to a ShareableBundle. Returns null on parse failure.
 */
export function decodeToken(token: string): ShareableBundle | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8')
    return JSON.parse(json) as ShareableBundle
  } catch {
    return null
  }
}

// ── Verification (recipient side) ─────────────────────────────────────────────

/**
 * Verify and decrypt a ShareableBundle.
 * The decryption key must be shared out-of-band with the recipient,
 * or derived from the token for public bundles.
 */
export async function verifyBundle(
  bundle: ShareableBundle,
  decryptionKey: Uint8Array,
): Promise<VerificationResult | VerificationFailure> {
  let plaintext: Uint8Array
  try {
    plaintext = await decrypt({ nonce: bundle.nonce, ciphertext: bundle.ciphertext }, decryptionKey)
  } catch {
    return { ok: false, reason: 'decryption-failed' }
  }

  const ownerPublicKey = await from_base64(bundle.ownerPublicKey)
  const sigValid = await verify(plaintext, bundle.ownerSig, ownerPublicKey)
  if (!sigValid) return { ok: false, reason: 'signature-invalid' }

  let payload: BundlePayload
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext)) as BundlePayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (payload.expiresAt && new Date(payload.expiresAt) < new Date()) {
    return { ok: false, reason: 'expired' }
  }

  return {
    ok: true,
    grantId: payload.grantId,
    granteeRef: payload.granteeRef,
    purpose: payload.purpose,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    claims: payload.claims.map(c => ({
      ...c,
      badge: sourceToBadge(c.source, c.verification),
    })),
  }
}

function sourceToBadge(
  source: Claim['source'],
  verification: Claim['verification'],
): 'self-attested' | 'verified' | 'imported' {
  if (source === 'issuer-signed' && verification === 'verified') return 'verified'
  if (source === 'issuer-signed') return 'imported'
  if (source === 'imported') return 'imported'
  return 'self-attested'
}

function sortKeys(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return (val as unknown[]).map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(val as object).sort()) {
    sorted[k] = sortKeys((val as Record<string, unknown>)[k])
  }
  return sorted
}
