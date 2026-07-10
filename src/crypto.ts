/**
 * Cryptographic primitives for the personal vault.
 *
 * Encryption : XChaCha20-Poly1305 via libsodium-wrappers
 * Key derivation : scrypt (Node built-in) — Argon2id equivalent strength
 * Signing : Ed25519 via libsodium-wrappers (also used for DID keys)
 * Hashing : SHA-256 via Node built-in crypto
 */

import sodium = require('libsodium-wrappers')
import { scrypt as scryptCb, createHash, randomBytes } from 'crypto'
import { promisify } from 'util'

const scrypt = promisify(scryptCb)

// scrypt parameters — 2^14 is the minimum for reasonable security;
// production clients should use 2^16 or higher once confirmed working
const SCRYPT_N = 16384   // 2^14
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LEN = 32  // 256-bit output → used as the vault master key

export interface EncryptedBlob {
  nonce: string   // base64url
  ciphertext: string  // base64url
}

let _sodiumReady = false
async function ensureSodium(): Promise<typeof sodium> {
  if (!_sodiumReady) {
    await sodium.ready
    _sodiumReady = true
  }
  return sodium
}

// ── Key derivation ──────────────────────────────────────────────────────────

/**
 * Derive a 32-byte vault master key from a passphrase + salt using scrypt.
 * The salt must be stored alongside the encrypted vault (not secret).
 */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyBuf = await scrypt(passphrase, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  }) as Buffer
  return new Uint8Array(keyBuf)
}

/** Generate a fresh random 32-byte salt for key derivation. */
export function generateSalt(): Uint8Array {
  return new Uint8Array(randomBytes(32))
}

/**
 * Derive a verification hash from the master key.
 * Stored in the vault header to confirm correct passphrase without
 * exposing the key itself.
 */
export function keyVerificationHash(masterKey: Uint8Array): string {
  return createHash('sha256')
    .update('vault-key-verify')
    .update(masterKey)
    .digest('base64url')
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
  return createHash('sha256').update(data).digest('hex')
}

/** SHA-256 hash of a UTF-8 string, returned as hex. */
export function sha256String(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
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
