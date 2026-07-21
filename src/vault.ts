/**
 * Vault core: create, open, add/edit/delete claims, encrypted persistence.
 *
 * The vault is stored as an encrypted JSON blob (EncryptedBlob).
 * In production this blob would live in SQLCipher or an encrypted file;
 * here we work with the serialised representation so the crypto layer
 * stays portable across environments.
 *
 * Architecture (Step 3.2.1):
 *   passphrase → scrypt → masterKey → XChaCha20 encrypt/decrypt vault state
 *   masterKey is only kept in memory while the vault is unlocked.
 */

import { randomUUID, createHash } from 'crypto'
import {
  deriveKey, generateSalt, keyVerificationHash,
  encryptString, decryptString,
  zeroKey,
} from './crypto'
import type { EncryptedBlob } from './crypto'

// ── Types mirroring the newel schema ────────────────────────────────────────

export type ClaimSource = 'self-attested' | 'issuer-signed' | 'imported'
export type ClaimVerification = 'none' | 'self' | 'verified'

export interface Claim {
  id: string
  ownerId: string
  type: string
  value: unknown
  source: ClaimSource
  verification: ClaimVerification
  issuedAt: string
  expiresAt: string | null
  issuerDid: string | null
}

export type GrantMode = 'push' | 'pull'
export type GrantStatus = 'active' | 'revoked' | 'expired'

export interface Grant {
  id: string
  ownerId: string
  granteeRef: string
  claimIds: string[]
  purpose: string
  mode: GrantMode
  singleUse: boolean
  expiresAt: string | null
  ownerSig: string
  status: GrantStatus
  createdAt: string
  revokedAt: string | null
}

export type AuditAction =
  | 'grant-created' | 'grant-revoked' | 'grant-expired'
  | 'claim-added' | 'claim-updated' | 'claim-deleted'
  | 'vault-unlocked' | 'vault-locked'
  | 'recovery-started' | 'recovery-completed'
  | 'bundle-accessed'

export interface AuditEntry {
  id: string
  ownerId: string
  grantId: string | null
  action: AuditAction
  actor: string
  detail: unknown
  prevHash: string | null
  entryHash: string
  createdAt: string
}

// ── Vault state (the plaintext stored encrypted on disk) ─────────────────────

interface VaultState {
  owner: {
    id: string
    did: string
    displayName: string | null
    createdAt: string
  }
  claims: Record<string, Claim>
  grants: Record<string, Grant>
  auditLog: AuditEntry[]
}

// ── Vault header (stored unencrypted — needed to unlock the vault) ───────────

export interface VaultHeader {
  version: string
  ownerId: string
  salt: string            // base64url-encoded 32-byte random salt
  keyVerificationHash: string
  mnemonicCommitment: string  // SHA-256 hex of the BIP-39 mnemonic
  sequenceNumber: number  // increments on every seal(); used by relay to pick the newer copy
}

// ── Persisted vault file structure ───────────────────────────────────────────

export interface PersistedVault {
  header: VaultHeader
  encrypted: EncryptedBlob
}

// ── Vault class ──────────────────────────────────────────────────────────────

export class Vault {
  private _state: VaultState
  private _masterKey: Uint8Array
  private _header: VaultHeader
  private _locked = false

  private constructor(state: VaultState, masterKey: Uint8Array, header: VaultHeader) {
    this._state = state
    this._masterKey = masterKey
    this._header = header
  }

  // ── Factory: create a new vault ────────────────────────────────────────────

  static async create(options: {
    passphrase: string
    did: string
    displayName?: string
    mnemonicCommitment: string
  }): Promise<Vault> {
    const salt = generateSalt()
    const masterKey = await deriveKey(options.passphrase, salt)
    const keyHash = keyVerificationHash(masterKey)
    const saltB64 = Buffer.from(salt).toString('base64url')
    const ownerId = randomUUID()

    const header: VaultHeader = {
      version: '1',
      ownerId,
      salt: saltB64,
      keyVerificationHash: keyHash,
      mnemonicCommitment: options.mnemonicCommitment,
      sequenceNumber: 0,
    }

    const state: VaultState = {
      owner: {
        id: ownerId,
        did: options.did,
        displayName: options.displayName ?? null,
        createdAt: new Date().toISOString(),
      },
      claims: {},
      grants: {},
      auditLog: [],
    }

    const vault = new Vault(state, masterKey, header)
    vault._appendAudit('vault-unlocked', 'system', null, null)
    return vault
  }

  // ── Factory: open an existing vault ───────────────────────────────────────

  static async open(persisted: PersistedVault, passphrase: string): Promise<Vault> {
    const salt = Buffer.from(persisted.header.salt, 'base64url')
    const masterKey = await deriveKey(passphrase, new Uint8Array(salt))

    const derivedHash = keyVerificationHash(masterKey)
    if (derivedHash !== persisted.header.keyVerificationHash) {
      await zeroKey(masterKey)
      throw new Error('Incorrect passphrase')
    }

    const plaintext = await decryptString(persisted.encrypted, masterKey)
    const state: VaultState = JSON.parse(plaintext) as VaultState

    const vault = new Vault(state, masterKey, persisted.header)
    vault._appendAudit('vault-unlocked', 'owner', null, null)
    return vault
  }

  // ── Serialize / seal ───────────────────────────────────────────────────────

  /** Encrypt and serialize the vault to a storable object. */
  async seal(): Promise<PersistedVault> {
    this._assertUnlocked()
    this._header.sequenceNumber = (this._header.sequenceNumber ?? 0) + 1
    this._appendAudit('vault-locked', 'owner', null, null)
    const plaintext = JSON.stringify(this._state)
    const encrypted = await encryptString(plaintext, this._masterKey)
    return { header: this._header, encrypted }
  }

  /** Seal and zero the master key — vault object becomes unusable. */
  async lock(): Promise<PersistedVault> {
    const persisted = await this.seal()
    await zeroKey(this._masterKey)
    this._locked = true
    return persisted
  }

  // ── Claims ─────────────────────────────────────────────────────────────────

  addClaim(input: Omit<Claim, 'id' | 'ownerId' | 'issuedAt'>): Claim {
    this._assertUnlocked()
    const claim: Claim = {
      ...input,
      id: randomUUID(),
      ownerId: this._state.owner.id,
      issuedAt: new Date().toISOString(),
    }
    this._state.claims[claim.id] = claim
    this._appendAudit('claim-added', 'owner', null, { claimType: claim.type })
    return claim
  }

  getClaim(id: string): Claim {
    this._assertUnlocked()
    const claim = this._state.claims[id]
    if (!claim) throw new Error(`Claim not found: ${id}`)
    return claim
  }

  listClaims(): Claim[] {
    this._assertUnlocked()
    return Object.values(this._state.claims)
  }

  updateClaim(id: string, patch: Partial<Omit<Claim, 'id' | 'ownerId'>>): Claim {
    this._assertUnlocked()
    const claim = this._state.claims[id]
    if (!claim) throw new Error(`Claim not found: ${id}`)
    const originalType = claim.type
    Object.assign(claim, patch)
    this._appendAudit('claim-updated', 'owner', null, { claimType: originalType })
    return claim
  }

  deleteClaim(id: string): void {
    this._assertUnlocked()
    const claim = this._state.claims[id]
    if (!claim) throw new Error(`Claim not found: ${id}`)
    delete this._state.claims[id]
    this._appendAudit('claim-deleted', 'owner', null, { claimType: claim.type })
  }

  // ── Grants ─────────────────────────────────────────────────────────────────

  addGrant(grant: Grant): void {
    this._assertUnlocked()
    this._state.grants[grant.id] = grant
    this._appendAudit('grant-created', 'owner', grant.id, {
      granteeRef: grant.granteeRef,
      mode: grant.mode,
    })
  }

  getGrant(id: string): Grant {
    this._assertUnlocked()
    const grant = this._state.grants[id]
    if (!grant) throw new Error(`Grant not found: ${id}`)
    return grant
  }

  listGrants(): Grant[] {
    this._assertUnlocked()
    return Object.values(this._state.grants)
  }

  revokeGrant(id: string): void {
    this._assertUnlocked()
    const grant = this._state.grants[id]
    if (!grant) throw new Error(`Grant not found: ${id}`)
    if (grant.status !== 'active') throw new Error(`Grant is already ${grant.status}`)
    grant.status = 'revoked'
    grant.revokedAt = new Date().toISOString()
    this._appendAudit('grant-revoked', 'owner', id, { granteeRef: grant.granteeRef })
  }

  // ── Audit log ──────────────────────────────────────────────────────────────

  getAuditLog(): AuditEntry[] {
    this._assertUnlocked()
    return [...this._state.auditLog]
  }

  // ── Owner ──────────────────────────────────────────────────────────────────

  get owner() {
    this._assertUnlocked()
    return { ...this._state.owner }
  }

  get header(): VaultHeader {
    return { ...this._header }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _assertUnlocked(): void {
    if (this._locked) throw new Error('Vault is locked')
  }

  private _appendAudit(
    action: AuditAction,
    actor: string,
    grantId: string | null,
    detail: unknown,
  ): void {
    const log = this._state.auditLog
    const prev = log[log.length - 1] ?? null
    const prevHash = prev?.entryHash ?? null

    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const ownerId = this._state.owner.id

    const canonical = JSON.stringify({ id, ownerId, grantId, action, actor, detail, prevHash, createdAt })
    const entryHash = createHash('sha256').update(canonical, 'utf8').digest('hex')

    log.push({ id, ownerId, grantId, action, actor, detail, prevHash, entryHash, createdAt })
  }
}
