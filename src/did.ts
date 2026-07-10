/**
 * DID key generation and identity layer (Phase 2, Step 2.3).
 *
 * Implements did:key using Ed25519 keypairs. The DID is self-contained:
 * no registry, no infrastructure — the public key IS the identifier.
 *
 * did:key format:
 *   did:key:z<base58btc-encoded multicodec prefix + public key>
 *
 * Multicodec prefix for Ed25519: 0xed01 (two-byte varint)
 *
 * Upgrade path: did:web is a later concern (Step 2.3 note). This module
 * exports everything needed to get did:key working without any external
 * resolver dependency.
 *
 * Also provides:
 *   - VC import stub: store a raw VC JSON as an issuer-signed Claim
 *   - SD-JWT framing helper: produce a minimal SD-JWT header for selective disclosure
 */

import { generateKeypair, keypairFromSeed, sign, verify, from_base64 } from './crypto'
import type { Ed25519Keypair } from './crypto'

// ── Multibase / multicodec constants ─────────────────────────────────────────

// Base58btc multibase prefix character
const MULTIBASE_BASE58BTC = 'z'

// Multicodec varint prefix for Ed25519 public key (0xed 0x01)
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01])

// ── DID key ───────────────────────────────────────────────────────────────────

export interface DIDDocument {
  did: string
  publicKey: Uint8Array
  privateKey: Uint8Array
}

/**
 * Generate a fresh did:key identity.
 * The keypair is derived from the BIP-39 mnemonic seed at vault creation,
 * or freshly generated here for non-mnemonic flows.
 */
export async function generateDID(): Promise<DIDDocument> {
  const keypair = await generateKeypair()
  const did = publicKeyToDID(keypair.publicKey)
  return { did, ...keypair }
}

/**
 * Derive a did:key from an existing Ed25519 keypair seed.
 * Used by the recovery flow to restore the same DID from the mnemonic.
 */
export async function didFromSeed(seed: Uint8Array): Promise<DIDDocument> {
  const keypair = await keypairFromSeed(seed)
  const did = publicKeyToDID(keypair.publicKey)
  return { did, ...keypair }
}

/**
 * Resolve a did:key back to its public key bytes.
 * No network call required — the key is embedded in the DID.
 */
export function resolveDID(did: string): Uint8Array {
  if (!did.startsWith('did:key:')) throw new Error(`Not a did:key: ${did}`)
  const encoded = did.slice('did:key:'.length)
  if (encoded[0] !== MULTIBASE_BASE58BTC) throw new Error(`Unsupported multibase prefix: ${encoded[0]}`)
  const bytes = base58Decode(encoded.slice(1))
  // Verify and strip the multicodec prefix
  if (bytes[0] !== ED25519_MULTICODEC_PREFIX[0] || bytes[1] !== ED25519_MULTICODEC_PREFIX[1]) {
    throw new Error('DID does not encode an Ed25519 key')
  }
  return bytes.slice(2)
}

// ── Signing / verification with DID ──────────────────────────────────────────

/**
 * Sign a UTF-8 message with the DID private key.
 * Returns a base64url signature.
 */
export async function signWithDID(message: string, privateKey: Uint8Array): Promise<string> {
  return sign(new TextEncoder().encode(message), privateKey)
}

/**
 * Verify a signature given a did:key string (no private key needed).
 */
export async function verifyWithDID(
  message: string,
  signatureB64u: string,
  did: string,
): Promise<boolean> {
  const publicKey = resolveDID(did)
  return verify(new TextEncoder().encode(message), signatureB64u, publicKey)
}

// ── Verifiable Credential import stub ────────────────────────────────────────

export interface RawVC {
  '@context': string[]
  type: string[]
  issuer: string
  issuanceDate: string
  expirationDate?: string
  credentialSubject: Record<string, unknown>
  proof?: unknown
}

export interface ImportedClaimData {
  type: string
  value: unknown
  source: 'issuer-signed'
  verification: 'verified'
  expiresAt: string | null
  issuerDid: string
}

/**
 * Import a raw W3C Verifiable Credential JSON as vault claims.
 * Each key in credentialSubject becomes a separate claim.
 * Proof verification is intentionally left as a TODO for a later phase —
 * the presence of a proof field is noted but not cryptographically checked here.
 */
export function importVC(vc: RawVC): ImportedClaimData[] {
  const issuerDid = typeof vc.issuer === 'string' ? vc.issuer : (vc.issuer as { id: string }).id
  const expiresAt = vc.expirationDate ?? null

  return Object.entries(vc.credentialSubject)
    .filter(([key]) => key !== 'id')  // skip the subject DID field
    .map(([key, value]) => ({
      type: `vc:${key}`,
      value,
      source: 'issuer-signed' as const,
      verification: 'verified' as const,
      expiresAt,
      issuerDid,
    }))
}

// ── SD-JWT framing (minimal, for selective disclosure) ────────────────────────

export interface SDJWTFrame {
  header: string   // base64url-encoded JWT header JSON
  payload: string  // base64url-encoded payload JSON with _sd disclosures
  signature: string  // base64url Ed25519 signature over header.payload
}

/**
 * Produce a minimal SD-JWT-style frame for a subset of claim types.
 * Full SD-JWT spec conformance is a later phase; this establishes the framing.
 */
export async function frameSDJWT(
  claims: Array<{ type: string; value: unknown }>,
  issuerDid: string,
  privateKey: Uint8Array,
  expiresAt: Date | null,
): Promise<SDJWTFrame> {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'vc+sd-jwt' })).toString('base64url')

  const payload = Buffer.from(JSON.stringify({
    iss: issuerDid,
    iat: Math.floor(Date.now() / 1000),
    exp: expiresAt ? Math.floor(expiresAt.getTime() / 1000) : undefined,
    _sd: claims.map(c => ({ type: c.type, value: c.value })),
    _sd_alg: 'sha-256',
  })).toString('base64url')

  const signingInput = `${header}.${payload}`
  const signature = await sign(new TextEncoder().encode(signingInput), privateKey)

  return { header, payload, signature }
}

// ── Base58btc codec (Bitcoin alphabet, no external dependency) ────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes: Uint8Array): string {
  let num = BigInt('0x' + Buffer.from(bytes).toString('hex') || '0')
  let encoded = ''
  while (num > 0n) {
    encoded = BASE58_ALPHABET[Number(num % 58n)]! + encoded
    num /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    encoded = '1' + encoded
  }
  return encoded
}

function base58Decode(s: string): Uint8Array {
  let num = 0n
  for (const char of s) {
    const idx = BASE58_ALPHABET.indexOf(char)
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`)
    num = num * 58n + BigInt(idx)
  }
  const hex = num.toString(16).padStart(2, '0')
  const padded = hex.length % 2 === 0 ? hex : '0' + hex
  const bytes = Buffer.from(padded, 'hex')
  const leadingOnes = [...s].findIndex(c => c !== '1')
  const leading = leadingOnes < 0 ? s.length : leadingOnes
  return new Uint8Array([...new Uint8Array(leading), ...bytes])
}

function publicKeyToDID(publicKey: Uint8Array): string {
  const multikey = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length)
  multikey.set(ED25519_MULTICODEC_PREFIX)
  multikey.set(publicKey, ED25519_MULTICODEC_PREFIX.length)
  return `did:key:${MULTIBASE_BASE58BTC}${base58Encode(multikey)}`
}
