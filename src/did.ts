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

import { createHash, randomBytes } from 'crypto'
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
  issuer: string | { id: string }
  issuanceDate: string
  expirationDate?: string
  credentialSubject: Record<string, unknown>
  proof?: VCProof
}

/** Ed25519Signature2020 proof (W3C VC Data Model). */
export interface VCProof {
  type: string
  created: string
  verificationMethod: string
  proofPurpose: string
  proofValue: string  // base58btc or base64url signature over the canonical VC document
}

export interface ImportedClaimData {
  type: string
  value: unknown
  source: 'issuer-signed'
  /** 'verified' means the Ed25519Signature2020 proof was cryptographically checked. */
  verification: 'verified' | 'none'
  expiresAt: string | null
  issuerDid: string
}

/**
 * Verify a W3C VC proof (Ed25519Signature2020).
 *
 * The signing input per the spec is the SHA-256 of:
 *   canonicalProofOptions + 0x0A + canonicalDocument
 * where canonicalDocument is the JSON with the proof field removed.
 *
 * We use a simplified canonical form (sorted-key JSON serialisation) instead
 * of full JSON-LD normalisation (which requires an external rdfc library).
 * This is compatible with issuers that also use sorted-key JSON; it will fail
 * for issuers that use full RDFC-1.0 — those VCs fall back to `verification: 'none'`.
 *
 * proofValue may be base58btc (prefixed 'z') or base64url.
 */
export async function verifyVCProof(vc: RawVC): Promise<boolean> {
  if (!vc.proof) return false
  const proof = vc.proof

  // Only Ed25519Signature2020 is supported
  if (proof.type !== 'Ed25519Signature2020') return false

  // Resolve issuer DID to a public key
  const issuerDid = typeof vc.issuer === 'string' ? vc.issuer : vc.issuer.id
  let publicKey: Uint8Array
  try {
    publicKey = resolveDID(issuerDid)
  } catch {
    // verificationMethod may differ from issuerDid; try it
    try {
      const vmDid = proof.verificationMethod.split('#')[0]
      publicKey = resolveDID(vmDid)
    } catch {
      return false
    }
  }

  // Build the document to verify: VC without proof field
  const docWithoutProof = { ...vc, proof: undefined } as Record<string, unknown>
  delete docWithoutProof['proof']
  const canonicalDoc = canonicalJson(docWithoutProof)

  // Build the proof options document (proof metadata without proofValue)
  const proofOptions: Record<string, unknown> = {
    type: proof.type,
    created: proof.created,
    verificationMethod: proof.verificationMethod,
    proofPurpose: proof.proofPurpose,
  }
  const canonicalProofOptions = canonicalJson(proofOptions)

  // Signing input: SHA-256(proofOptions) || SHA-256(document) concatenated
  const hashProofOptions = createHash('sha256').update(canonicalProofOptions).digest()
  const hashDoc = createHash('sha256').update(canonicalDoc).digest()
  const signingInput = Buffer.concat([hashProofOptions, hashDoc])

  // Decode signature: base58btc ('z' prefix) or base64url
  let sigBytes: Uint8Array
  try {
    if (proof.proofValue.startsWith('z')) {
      sigBytes = base58Decode(proof.proofValue.slice(1))
    } else {
      sigBytes = await from_base64(proof.proofValue)
    }
  } catch {
    return false
  }

  return verify(signingInput, Buffer.from(sigBytes).toString('base64url'), publicKey)
}

/** Deterministic canonical JSON: keys sorted recursively. */
function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + (obj as unknown[]).map(canonicalJson).join(',') + ']'
  const record = obj as Record<string, unknown>
  const sorted = Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
  return '{' + sorted.join(',') + '}'
}

/**
 * Import a raw W3C Verifiable Credential JSON as vault claims.
 * Each key in credentialSubject becomes a separate claim.
 *
 * If an Ed25519Signature2020 proof is present, it is verified cryptographically.
 * Claims from a verified VC get `verification: 'verified'`.
 * Claims from an unverified or proof-less VC get `verification: 'none'`.
 */
export async function importVC(vc: RawVC): Promise<ImportedClaimData[]> {
  const issuerDid = typeof vc.issuer === 'string' ? vc.issuer : vc.issuer.id
  const expiresAt = vc.expirationDate ?? null

  const proofVerified = vc.proof ? await verifyVCProof(vc) : false
  const verification: 'verified' | 'none' = proofVerified ? 'verified' : 'none'

  return Object.entries(vc.credentialSubject)
    .filter(([key]) => key !== 'id')  // skip the subject DID field
    .map(([key, value]) => ({
      type: `vc:${key}`,
      value,
      source: 'issuer-signed' as const,
      verification,
      expiresAt,
      issuerDid,
    }))
}

// ── SD-JWT (draft-ietf-oauth-selective-disclosure-jwt) ────────────────────────
//
// Compact serialisation:  <Issuer-JWT>~<Disclosure 1>~<Disclosure 2>~...~
//
// Each Disclosure is base64url(JSON([salt, claim_name, claim_value])).
// The Issuer-JWT payload contains:
//   _sd      : SHA-256 digests of each Disclosure (base64url)
//   _sd_alg  : "sha-256"
//   cnf      : optional key binding
//   iss, iat, exp, sub : standard JWT claims
//
// Verification: decode each disclosure, hash it, check it appears in _sd,
// then verify the JWT signature over header.payload.

export interface SDJWTResult {
  /** Full compact token:  <header>.<payload>.<sig>~<disc1>~<disc2>~  */
  compact: string
  /** Individual disclosures (base64url-encoded JSON arrays) */
  disclosures: string[]
  /** Parsed issuer JWT components for inspection/testing */
  issuerJwt: { header: string; payload: string; signature: string }
}

/** A decoded and verified SD-JWT presentation. */
export interface SDJWTVerification {
  ok: true
  iss: string
  iat: number
  exp: number | undefined
  sub: string | undefined
  claims: Array<{ name: string; value: unknown }>
}

export interface SDJWTVerificationFailure {
  ok: false
  reason: 'signature-invalid' | 'expired' | 'malformed' | 'digest-mismatch'
}

/**
 * Issue an SD-JWT for a set of claims.
 *
 * Each claim becomes a separate Disclosure so the holder can present any
 * subset. The Issuer-JWT is signed with the issuer's Ed25519 private key.
 */
export async function issueSDJWT(
  claims: Array<{ name: string; value: unknown }>,
  issuerDid: string,
  privateKey: Uint8Array,
  options: {
    subject?: string
    issuedAt: number  // unix seconds
    expiresAt?: number  // unix seconds
  },
): Promise<SDJWTResult> {
  // Build one Disclosure per claim:  base64url(JSON([salt, name, value]))
  const disclosures: string[] = []
  const sdDigests: string[] = []

  for (const claim of claims) {
    const salt = randomBytes(16).toString('base64url')
    const disclosureJson = JSON.stringify([salt, claim.name, claim.value])
    const disclosure = Buffer.from(disclosureJson).toString('base64url')
    disclosures.push(disclosure)

    // _sd digest = base64url(sha256(disclosure))
    const digest = createHash('sha256').update(disclosure).digest('base64url')
    sdDigests.push(digest)
  }

  const headerObj = { alg: 'EdDSA', typ: 'vc+sd-jwt' }
  const payloadObj: Record<string, unknown> = {
    iss: issuerDid,
    iat: options.issuedAt,
    _sd: sdDigests,
    _sd_alg: 'sha-256',
  }
  if (options.expiresAt !== undefined) payloadObj['exp'] = options.expiresAt
  if (options.subject !== undefined) payloadObj['sub'] = options.subject

  const header = Buffer.from(JSON.stringify(headerObj)).toString('base64url')
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url')
  const signingInput = `${header}.${payload}`
  const signature = await sign(new TextEncoder().encode(signingInput), privateKey)

  // Compact: <header>.<payload>.<sig>~<disc1>~<disc2>~
  const compact = `${signingInput}.${signature}~${disclosures.join('~')}~`

  return {
    compact,
    disclosures,
    issuerJwt: { header, payload, signature },
  }
}

/**
 * Verify an SD-JWT compact token.
 *
 * Checks:
 *  1. JWT signature with the issuer's public key (resolved from `iss` did:key)
 *  2. Token not expired
 *  3. Every presented disclosure's SHA-256 digest matches an entry in `_sd`
 *
 * Returns the disclosed claims on success.
 */
export async function verifySDJWT(
  compact: string,
): Promise<SDJWTVerification | SDJWTVerificationFailure> {
  // Split on '~'; first part is <header>.<payload>.<sig>
  const parts = compact.split('~')
  if (parts.length < 2) return { ok: false, reason: 'malformed' }

  const jwtPart = parts[0]
  const disclosureParts = parts.slice(1).filter(d => d.length > 0)

  const jwtSegments = jwtPart.split('.')
  if (jwtSegments.length !== 3) return { ok: false, reason: 'malformed' }

  const [headerB64, payloadB64, signatureB64] = jwtSegments as [string, string, string]

  let payloadObj: Record<string, unknown>
  try {
    payloadObj = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  const iss = payloadObj['iss'] as string | undefined
  if (!iss) return { ok: false, reason: 'malformed' }

  // 1. Verify JWT signature
  let publicKey: Uint8Array
  try {
    publicKey = resolveDID(iss)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  const signingInput = `${headerB64}.${payloadB64}`
  const valid = await verify(new TextEncoder().encode(signingInput), signatureB64, publicKey)
  if (!valid) return { ok: false, reason: 'signature-invalid' }

  // 2. Check expiry
  const exp = payloadObj['exp'] as number | undefined
  const iat = payloadObj['iat'] as number
  const nowSec = Math.floor(Date.now() / 1000)
  if (exp !== undefined && nowSec > exp) return { ok: false, reason: 'expired' }

  // 3. Verify disclosures against _sd digests
  const sdDigests = (payloadObj['_sd'] as string[] | undefined) ?? []
  const disclosedClaims: Array<{ name: string; value: unknown }> = []
  const seenDigests = new Set<string>()

  for (const disclosure of disclosureParts) {
    const digest = createHash('sha256').update(disclosure).digest('base64url')
    if (!sdDigests.includes(digest)) return { ok: false, reason: 'digest-mismatch' }
    if (seenDigests.has(digest)) return { ok: false, reason: 'digest-mismatch' }
    seenDigests.add(digest)

    let disclosureArr: [string, string, unknown]
    try {
      disclosureArr = JSON.parse(Buffer.from(disclosure, 'base64url').toString('utf8'))
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (!Array.isArray(disclosureArr) || disclosureArr.length !== 3) {
      return { ok: false, reason: 'malformed' }
    }
    disclosedClaims.push({ name: disclosureArr[1], value: disclosureArr[2] })
  }

  return {
    ok: true,
    iss,
    iat,
    exp,
    sub: payloadObj['sub'] as string | undefined,
    claims: disclosedClaims,
  }
}

/**
 * @deprecated Use issueSDJWT() instead.
 * Kept for backwards compatibility; removed in a future version.
 */
export async function frameSDJWT(
  claims: Array<{ type: string; value: unknown }>,
  issuerDid: string,
  privateKey: Uint8Array,
  expiresAt: Date | null,
): Promise<{ header: string; payload: string; signature: string }> {
  const namedClaims = claims.map(c => ({ name: c.type, value: c.value }))
  const nowSec = Math.floor(Date.now() / 1000)
  const result = await issueSDJWT(namedClaims, issuerDid, privateKey, {
    issuedAt: nowSec,
    expiresAt: expiresAt ? Math.floor(expiresAt.getTime() / 1000) : undefined,
  })
  return result.issuerJwt
}

// ── Base58btc codec (Bitcoin alphabet, no external dependency) ────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex')
  let num = hex.length > 0 ? BigInt('0x' + hex) : 0n
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
