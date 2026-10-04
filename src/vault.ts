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

import {
  deriveKey, generateSalt, keyVerificationHash, sha256String,
  encryptString, decryptString,
  zeroKey, SCRYPT_N_DEFAULT, SCRYPT_N_V1, SCRYPT_N_MIN,
  bytesToBase64url, base64urlToBytes,
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
  /** Last modification time; absent on claims written before merge support (falls back to issuedAt). */
  updatedAt?: string
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
  | 'vault-unlocked' | 'vault-locked' | 'vault-sealed'
  | 'recovery-started' | 'recovery-completed'
  | 'bundle-accessed'
  | 'merge'

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

export interface MergeSummary {
  identical: number
  localWins: number
  remoteWins: number
  onlyLocal: number
  onlyRemote: number
  /** Claims removed because one side had deleted them. */
  deleted: number
  /** Grants that became revoked because the other side had revoked them. */
  grantsRevoked: number
  grantsAdded: number
  overwritten: { claimId: string; claimType: string; kept: 'local' | 'remote' }[]
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
  /** claimId → deletion time. Lets a merge tell "deleted here" from "never seen here". */
  deletedClaims?: Record<string, string>
  /** claimId → ISO time of an explicit re-import after deletion; beats an older tombstone in a merge. */
  revivedClaims?: Record<string, string>
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
  scryptN: number         // scrypt cost parameter — 65536 (2^16) for new vaults, 16384 (2^14) for old
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
    const masterKey = await deriveKey(options.passphrase, salt, SCRYPT_N_DEFAULT)
    const keyHash = keyVerificationHash(masterKey)
    const saltB64 = bytesToBase64url(salt)
    const ownerId = globalThis.crypto.randomUUID()

    const header: VaultHeader = {
      version: '1',
      ownerId,
      salt: saltB64,
      keyVerificationHash: keyHash,
      mnemonicCommitment: options.mnemonicCommitment,
      sequenceNumber: 0,
      scryptN: SCRYPT_N_DEFAULT,
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
    const salt = base64urlToBytes(persisted.header.salt)
    // Fall back to legacy N for vaults created before scryptN was stored in the header.
    // deriveKey enforces SCRYPT_N_MIN <= N <= SCRYPT_N_MAX, rejecting crafted headers.
    const N = persisted.header.scryptN ?? SCRYPT_N_V1
    if (N < SCRYPT_N_MIN) {
      throw new Error(`Vault header scryptN=${N} is below the minimum (${SCRYPT_N_MIN}); refusing to open`)
    }
    const masterKey = await deriveKey(passphrase, new Uint8Array(salt), N)

    const derivedHash = keyVerificationHash(masterKey)
    const storedHash = persisted.header.keyVerificationHash
    // Constant-time string comparison: both hashes are base64url-encoded SHA-256 digests (public).
    const hashMatch = derivedHash.length === storedHash.length &&
      [...derivedHash].reduce((acc, c, i) => acc | (c.charCodeAt(0) ^ storedHash.charCodeAt(i)), 0) === 0
    if (!hashMatch) {
      await zeroKey(masterKey)
      throw new Error('Incorrect passphrase')
    }

    let plaintext: string
    try {
      plaintext = await decryptString(persisted.encrypted, masterKey)
    } catch (e) {
      await zeroKey(masterKey)
      throw e
    }
    const state: VaultState = JSON.parse(plaintext) as VaultState

    const vault = new Vault(state, masterKey, { ...persisted.header })
    vault._appendAudit('vault-unlocked', 'owner', null, null)
    return vault
  }

  // ── Serialize / seal ───────────────────────────────────────────────────────

  /** Encrypt and serialize the vault to a storable object without locking. */
  async seal(): Promise<PersistedVault> {
    this._assertUnlocked()
    this._header.sequenceNumber = (this._header.sequenceNumber ?? 0) + 1
    this._appendAudit('vault-sealed', 'owner', null, null)
    const plaintext = JSON.stringify(this._state)
    const encrypted = await encryptString(plaintext, this._masterKey)
    return { header: { ...this._header }, encrypted }
  }

  /** Seal and zero the master key — vault object becomes unusable. */
  async lock(): Promise<PersistedVault> {
    try {
      this._appendAudit('vault-locked', 'owner', null, null)
      return await this.seal()
    } finally {
      await zeroKey(this._masterKey)
      this._locked = true
    }
  }

  // ── Claims ─────────────────────────────────────────────────────────────────

  addClaim(input: Omit<Claim, 'id' | 'ownerId' | 'issuedAt'>): Claim {
    this._assertUnlocked()
    const claim: Claim = {
      ...input,
      id: globalThis.crypto.randomUUID(),
      ownerId: this._state.owner.id,
      issuedAt: new Date().toISOString(),
    }
    claim.updatedAt = claim.issuedAt
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

  /** Import a claim from another vault, preserving its original ID for deduplication. */
  importClaim(claim: Claim): void {
    this._assertUnlocked()
    if (this._state.claims[claim.id]) return
    // Explicit re-import revives a claim deleted earlier: record it so a merge with a copy that
    // still carries the older tombstone keeps the claim.
    const tomb = this._state.deletedClaims?.[claim.id]
    if (tomb) {
      const now = new Date().toISOString()
      ;(this._state.revivedClaims ??= {})[claim.id] = now > tomb ? now : tomb + '~'
    }
    this._state.claims[claim.id] = { ...claim, ownerId: this._state.owner.id, updatedAt: new Date().toISOString() }
    this._appendAudit('claim-added', 'owner', null, { claimType: claim.type })
  }

  updateClaim(id: string, patch: Partial<Omit<Claim, 'id' | 'ownerId'>>): Claim {
    this._assertUnlocked()
    const claim = this._state.claims[id]
    if (!claim) throw new Error(`Claim not found: ${id}`)
    const originalType = claim.type
    Object.assign(claim, patch, { updatedAt: new Date().toISOString() })
    this._appendAudit('claim-updated', 'owner', null, { claimType: originalType })
    return claim
  }

  deleteClaim(id: string): void {
    this._assertUnlocked()
    const claim = this._state.claims[id]
    if (!claim) throw new Error(`Claim not found: ${id}`)
    delete this._state.claims[id]
    if (this._state.revivedClaims) delete this._state.revivedClaims[id]
    ;(this._state.deletedClaims ??= {})[id] = new Date().toISOString()
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

  // ── Merge ──────────────────────────────────────────────────────────────────

  /** Zero the master key without sealing — for throw-away instances. */
  async discard(): Promise<void> {
    await zeroKey(this._masterKey)
    this._locked = true
  }

  /**
   * Merge a diverged copy of the same vault into this one (Phase 3.5.3).
   * Claims: union, last `updatedAt` wins, deletion beats modification.
   * Grants: union, revoked > expired > active.
   * Audit: this chain is kept; one `merge` entry records the other chain's tail hash and carries
 *   the other chain's entries this one lacks (`detail.mergedEntries`).
   * `header.sequenceNumber` becomes max(both) so the next seal() yields max + 1.
   */
  mergeFrom(other: Vault): MergeSummary {
    this._assertUnlocked()
    other._assertUnlocked()
    if (other._state.owner.id !== this._state.owner.id) {
      throw new Error('Cannot merge vaults with different owners')
    }
    const summary: MergeSummary = {
      identical: 0, localWins: 0, remoteWins: 0,
      onlyLocal: 0, onlyRemote: 0, deleted: 0, grantsRevoked: 0, grantsAdded: 0,
      overwritten: [],
    }
    const local = this._state
    const remote = other._state

    const tombstones: Record<string, string> = { ...remote.deletedClaims }
    for (const [id, t] of Object.entries(local.deletedClaims ?? {})) {
      if (!tombstones[id] || t > tombstones[id]) tombstones[id] = t
    }
    const revived: Record<string, string> = { ...remote.revivedClaims }
    for (const [id, t] of Object.entries(local.revivedClaims ?? {})) {
      if (!revived[id] || t > revived[id]) revived[id] = t
    }
    // A re-import newer than the tombstone cancels it; a later delete (tombstone > revival) wins again.
    for (const id of Object.keys(tombstones)) {
      if (revived[id] && revived[id] > tombstones[id]) delete tombstones[id]
      else delete revived[id]
    }

    for (const id of new Set([...Object.keys(local.claims), ...Object.keys(remote.claims)])) {
      const l = local.claims[id]
      const r = remote.claims[id]
      if (tombstones[id]) {
        if (l || r) summary.deleted++
        delete local.claims[id]
        continue
      }
      if (l && !r) { summary.onlyLocal++; continue }
      if (!l && r) { local.claims[id] = { ...r, ownerId: local.owner.id }; summary.onlyRemote++; continue }
      const lt = l!.updatedAt ?? l!.issuedAt
      const rt = r!.updatedAt ?? r!.issuedAt
      if (lt === rt) {
        if (JSON.stringify(sortKeys({ ...l!, ownerId: '' })) === JSON.stringify(sortKeys({ ...r!, ownerId: '' }))) {
          summary.identical++
        } else {
          // Same timestamp, different content (e.g. legacy edit without updatedAt): keep local, flag it.
          summary.localWins++
          summary.overwritten.push({ claimId: id, claimType: l!.type, kept: 'local' })
        }
      } else if (rt > lt) {
        local.claims[id] = { ...r!, ownerId: local.owner.id }
        summary.remoteWins++
        summary.overwritten.push({ claimId: id, claimType: r!.type, kept: 'remote' })
      } else {
        summary.localWins++
        summary.overwritten.push({ claimId: id, claimType: l!.type, kept: 'local' })
      }
    }
    if (Object.keys(tombstones).length > 0) local.deletedClaims = tombstones
    else delete local.deletedClaims
    if (Object.keys(revived).length > 0) local.revivedClaims = revived
    else delete local.revivedClaims

    const rank: Record<GrantStatus, number> = { active: 0, expired: 1, revoked: 2 }
    for (const [id, r] of Object.entries(remote.grants)) {
      const l = local.grants[id]
      if (!l) { local.grants[id] = { ...r }; summary.grantsAdded++; continue }
      if (rank[r.status] > rank[l.status]) {
        local.grants[id] = { ...r }
        if (r.status === 'revoked') summary.grantsRevoked++
      }
    }

    const remoteTail = remote.auditLog[remote.auditLog.length - 1]
    // Preserve the other device's events (bundle access, grants, ...) verbatim inside the merge entry.
    // Entries already embedded by an earlier merge count as present, so repeat merges do not re-embed them.
    const localIds = new Set<string>()
    const collect = (e: AuditEntry): void => {
      localIds.add(e.id)
      const nested = (e.detail as { mergedEntries?: AuditEntry[] } | null)?.mergedEntries
      if (e.action === 'merge' && Array.isArray(nested)) nested.forEach(collect)
    }
    local.auditLog.forEach(collect)
    const remoteOnly = remote.auditLog.filter(e => !localIds.has(e.id))
    this._header.sequenceNumber = Math.max(
      this._header.sequenceNumber ?? 0, other._header.sequenceNumber ?? 0,
    )
    this._appendAudit('merge', 'owner', null, {
      mergedFromHash: remoteTail?.entryHash ?? null,
      mergedFromSequence: other._header.sequenceNumber ?? 0,
      mergedEntries: remoteOnly,
      // Counts only for claims; remote-only audit entries are kept so no event is lost.
      identical: summary.identical, localWins: summary.localWins, remoteWins: summary.remoteWins,
      onlyLocal: summary.onlyLocal, onlyRemote: summary.onlyRemote, deleted: summary.deleted,
      grantsRevoked: summary.grantsRevoked, grantsAdded: summary.grantsAdded,
    })
    return summary
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

    const id = globalThis.crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const ownerId = this._state.owner.id

    const canonical = JSON.stringify(sortKeys({ id, ownerId, grantId, action, actor, detail, prevHash, createdAt }))
    const entryHash = sha256String(canonical)

    log.push({ id, ownerId, grantId, action, actor, detail, prevHash, entryHash, createdAt })
  }
}

function sortKeys(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(val as object).sort()) {
    sorted[k] = sortKeys((val as Record<string, unknown>)[k])
  }
  return sorted
}
