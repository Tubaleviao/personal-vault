/**
 * Cryptographic primitives for the personal vault.
 *
 * Encryption : XChaCha20-Poly1305 via libsodium-wrappers
 * Key derivation : scrypt (Node built-in) — Argon2id equivalent strength
 * Signing : Ed25519 via libsodium-wrappers (also used for DID keys)
 * Hashing : SHA-256 via Node built-in crypto
 */

import * as sodium from 'libsodium-wrappers'
import { scrypt as nobleScrypt } from '@noble/hashes/scrypt'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes, bytesToHex, concatBytes } from '@noble/hashes/utils'

// scrypt parameters — 2^16 for new vaults; old vaults sealed with 2^14 pass N explicitly
export const SCRYPT_N_V1 = 16384  // 2^14 — legacy, stored in VaultHeader.scryptN
export const SCRYPT_N_DEFAULT = 65536  // 2^16 — used for all new vaults
export const SCRYPT_N_MIN = 16384  // floor: reject any header-supplied N below this
export const SCRYPT_N_MAX = 1048576  // ceiling (2^20): prevent OOM DoS from crafted headers
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LEN = 32  // 256-bit output → used as the vault master key

export interface EncryptedBlob {
  nonce: string   // base64url
  ciphertext: string  // base64url
}

// When Vite bundles a CJS module via import *, the actual exports land on .default.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sodiumApi: any = (sodium as any).default ?? sodium

let _sodiumReady = false
async function ensureSodium(): Promise<typeof sodiumApi> {
  if (!_sodiumReady) {
    await sodiumApi.ready
    _sodiumReady = true
  }
  return sodiumApi
}

// ── Key derivation ──────────────────────────────────────────────────────────

/**
 * Derive a 32-byte vault master key from a passphrase + salt using scrypt.
 * Pass N explicitly so old vaults (N=16384) can still be opened.
 * The salt must be stored alongside the encrypted vault (not secret).
 */
export async function deriveKey(passphrase: string, salt: Uint8Array, N = SCRYPT_N_DEFAULT): Promise<Uint8Array> {
  if (!Number.isInteger(N) || N < SCRYPT_N_MIN || N > SCRYPT_N_MAX) {
    throw new Error(`Invalid scrypt N=${N}: must be an integer in [${SCRYPT_N_MIN}, ${SCRYPT_N_MAX}]`)
  }
  // maxmem must be set explicitly — Node's default (32 MB) is too low for N=2^16 (needs 64 MB)
  return nobleScrypt(passphrase, salt, { N, r: SCRYPT_R, p: SCRYPT_P, dkLen: SCRYPT_KEY_LEN })
}

/** Generate a fresh random 32-byte salt for key derivation. */
export function generateSalt(): Uint8Array {
  return randomBytes(32)
}

/**
 * Derive a verification hash from the master key.
 * Stored in the vault header to confirm correct passphrase without
 * exposing the key itself.
 */
export function keyVerificationHash(masterKey: Uint8Array): string {
  const prefix = new TextEncoder().encode('vault-key-verify')
  const digest = sha256(concatBytes(prefix, masterKey))
  return bytesToBase64url(digest)
}

// ── Encryption / Decryption ─────────────────────────────────────────────────

/** Encrypt plaintext bytes with XChaCha20-Poly1305. */
export async function encrypt(plaintext: Uint8Array, key: Uint8Array): Promise<EncryptedBlob> {
  const s = await ensureSodium()
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext, null, null, nonce, key,
  )
  return {
    nonce: s.to_base64(nonce, s.base64_variants.URLSAFE_NO_PADDING),
    ciphertext: s.to_base64(ciphertext, s.base64_variants.URLSAFE_NO_PADDING),
  }
}

/** Decrypt an EncryptedBlob back to plaintext bytes. Throws on auth failure. */
export async function decrypt(blob: EncryptedBlob, key: Uint8Array): Promise<Uint8Array> {
  const s = await ensureSodium()
  const nonce = s.from_base64(blob.nonce, s.base64_variants.URLSAFE_NO_PADDING)
  const ciphertext = s.from_base64(blob.ciphertext, s.base64_variants.URLSAFE_NO_PADDING)
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, ciphertext, null, nonce, key,
  )
}

/** Encrypt a UTF-8 string. */
export async function encryptString(plaintext: string, key: Uint8Array): Promise<EncryptedBlob> {
  return encrypt(new TextEncoder().encode(plaintext), key)
}

/** Decrypt to a UTF-8 string. */
export async function decryptString(blob: EncryptedBlob, key: Uint8Array): Promise<string> {
  const bytes = await decrypt(blob, key)
  return new TextDecoder().decode(bytes)
}

// ── Ed25519 signing ─────────────────────────────────────────────────────────

export interface Ed25519Keypair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

/** Generate a fresh Ed25519 keypair. */
export async function generateKeypair(): Promise<Ed25519Keypair> {
  const s = await ensureSodium()
  const { publicKey, privateKey } = s.crypto_sign_keypair()
  return { publicKey, privateKey }
}

/** Derive a deterministic keypair from a 32-byte seed. */
export async function keypairFromSeed(seed: Uint8Array): Promise<Ed25519Keypair> {
  const s = await ensureSodium()
  const { publicKey, privateKey } = s.crypto_sign_seed_keypair(seed)
  return { publicKey, privateKey }
}

/** Sign a message with an Ed25519 private key. Returns base64url signature. */
export async function sign(message: Uint8Array, privateKey: Uint8Array): Promise<string> {
  const s = await ensureSodium()
  const sig = s.crypto_sign_detached(message, privateKey)
  return s.to_base64(sig, s.base64_variants.URLSAFE_NO_PADDING)
}

/** Verify an Ed25519 signature. Returns true if valid. */
export async function verify(
  message: Uint8Array,
  signatureB64u: string,
  publicKey: Uint8Array,
): Promise<boolean> {
  const s = await ensureSodium()
  try {
    const sig = s.from_base64(signatureB64u, s.base64_variants.URLSAFE_NO_PADDING)
    return s.crypto_sign_verify_detached(sig, message, publicKey)
  } catch {
    return false
  }
}

// ── Hashing ─────────────────────────────────────────────────────────────────

/** SHA-256 hash of arbitrary bytes, returned as hex. */
export function sha256Hex(data: Uint8Array | string): string {
  const input = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return bytesToHex(sha256(input))
}

/** SHA-256 hash of a UTF-8 string, returned as hex. */
export function sha256String(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)))
}

// ── Memory hygiene ──────────────────────────────────────────────────────────

/** Zero out a key buffer in memory after use. */
export async function zeroKey(key: Uint8Array): Promise<void> {
  const s = await ensureSodium()
  s.memzero(key)
}

// ── Base64 helpers (re-exports from sodium for consistent encoding) ──────────

export async function to_base64(data: Uint8Array): Promise<string> {
  const s = await ensureSodium()
  return s.to_base64(data, s.base64_variants.URLSAFE_NO_PADDING)
}

export async function from_base64(data: string): Promise<Uint8Array> {
  const s = await ensureSodium()
  return s.from_base64(data, s.base64_variants.URLSAFE_NO_PADDING)
}

// ── Sync base64url helpers (no sodium required) ──────────────────────────────

/** Encode a Uint8Array to base64url (no padding). */
export function bytesToBase64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode a base64url string to Uint8Array. */
export function base64urlToBytes(b64u: string): Uint8Array {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '=')
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Encode a UTF-8 string to base64url. */
export function strToBase64url(text: string): string {
  return bytesToBase64url(new TextEncoder().encode(text))
}

/** Decode a base64url string to UTF-8. */
export function base64urlToStr(b64u: string): string {
  return new TextDecoder().decode(base64urlToBytes(b64u))
}
