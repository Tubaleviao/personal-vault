import { fabric } from '@newel/core'

export default fabric()
  .meta(m => m
    .name('PersonalVault')
    .description('User-owned personal data store with granular, revocable, auditable consent')
    .version('0.1.0')
    .namespace('https://personalvault.local/schema/')
  )

  // ── VaultUser ──────────────────────────────────────────────────────────────
  // Represents the vault owner. One vault has exactly one VaultUser; the DID
  // is the root of trust — no server-side identity.

  .entity('VaultUser', e => e
    .description('The vault owner, identified by a self-sovereign DID')
    .goal('Hold the owner DID and track the vault lifecycle state')

    .field('id',              f => f.uuid().primaryKey())
    .field('did',             f => f.string().description('did:key identifier derived from the owner Ed25519 keypair'))
    .field('displayName',     f => f.string().nullable().description('Optional human-readable label shown in the UI'))
    .field('status',          f => f.enum(['active', 'locked', 'recovering']))
    .field('createdAt',       f => f.timestamp())

    .stateMachine('status', sm => sm
      .initial('active')
      .state('active',     s => s.description('Vault is unlocked and fully operational'))
      .state('locked',     s => s.description('Passphrase session expired; vault is sealed'))
      .state('recovering', s => s.description('Recovery phrase entered; awaiting new passphrase'))

      .transition(t => t.from('active').to('locked').trigger('lock')
        .effect('Wipes in-memory derived keys'))
      .transition(t => t.from('locked').to('active').trigger('unlock')
        .guard('Passphrase must derive to the stored key verification hash'))
      .transition(t => t.from('locked').to('recovering').trigger('startRecovery')
        .guard('BIP-39 recovery phrase must match stored mnemonic commitment'))
      .transition(t => t.from('recovering').to('active').trigger('completeRecovery')
        .guard('New passphrase must meet minimum entropy requirements')
        .effect('Re-derives and re-wraps all vault keys with the new passphrase'))
    )

    .behavior('lock', b => b
      .description('Seals the vault by wiping session keys from memory')
      .auth(a => a.roles('owner'))
    )
    .behavior('unlock', b => b
      .description('Unseals the vault by verifying the passphrase and re-deriving session keys')
      .rule('Passphrase must derive to the stored key verification hash')
      .auth(a => a.roles('owner'))
    )
    .behavior('startRecovery', b => b
      .description('Initiates account recovery using the BIP-39 recovery phrase')
      .rule('BIP-39 recovery phrase must match stored mnemonic commitment')
      .auth(a => a.roles('owner'))
    )
    .behavior('completeRecovery', b => b
      .description('Finalises recovery by setting a new passphrase and re-wrapping vault keys')
      .rule('New passphrase must meet minimum entropy requirements')
      .auth(a => a.roles('owner'))
    )
  )

  // ── Claim ──────────────────────────────────────────────────────────────────
  // A single typed data item inside the vault (e.g. name, DOB, address).
  // Each claim is individually addressable to enable field-level consent.
  // Uses schema.org / W3C VC vocabulary for interop.

  .entity('Claim', e => e
    .description('A single typed data item stored in the vault, individually addressable for field-level consent')
    .goal('Store personal data with source provenance and verification status, using schema.org vocabulary types')

    .field('id',           f => f.uuid().primaryKey())
    .field('ownerId',      f => f.uuid().foreignKey('VaultUser.id'))
    .field('type',         f => f.string().description('schema.org or W3C VC type, e.g. "schema:givenName", "schema:birthDate"'))
    .field('value',        f => f.json().pii().gdpr('identity').gdprRetention('until-revoked').gdprLegalBasis('consent')
      .description('Encrypted claim payload; plaintext never persisted unencrypted'))
    .field('source',       f => f.enum(['self-attested', 'issuer-signed', 'imported'])
      .description('Provenance of this claim'))
    .field('verification', f => f.enum(['none', 'self', 'verified']).description('Verification level'))
    .field('issuedAt',     f => f.timestamp())
    .field('expiresAt',    f => f.timestamp().nullable().description('Optional expiry; null means no expiry'))
    .field('issuerDid',    f => f.string().nullable().pii().gdpr('identity')
      .description('DID of the external issuer if source=issuer-signed'))

    .relation('owner', r => r.belongsTo('VaultUser').foreignKey('ownerId'))
  )

  // ── Grant ──────────────────────────────────────────────────────────────────
  // Records each consent decision the vault owner makes: which claims, to whom,
  // for what purpose, until when. Signed by the owner's DID key.

  .entity('Grant', e => e
    .description('A signed consent record: which claims are shared with which party, for what purpose, until when')
    .goal('Be the authoritative record of every access decision, enabling revocation and audit')

    .field('id',          f => f.uuid().primaryKey())
    .field('ownerId',     f => f.uuid().foreignKey('VaultUser.id'))
    .field('granteeRef',  f => f.string().description('Opaque identifier for the recipient (DID, email, app name, URL)'))
    .field('claimIds',    f => f.json().description('Ordered list of Claim.id values included in this grant'))
    .field('purpose',     f => f.string().description('Human-readable statement of why the data is shared'))
    .field('mode',        f => f.enum(['push', 'pull']).description('push = encrypted bundle handed to grantee; pull = relay serves on request'))
    .field('singleUse',   f => f.boolean().description('If true, grant is automatically revoked after first access'))
    .field('expiresAt',   f => f.timestamp().nullable().description('Hard expiry; null means no expiry for pull grants'))
    .field('ownerSig',    f => f.string().description('Ed25519 signature over the canonical grant payload, base64url'))
    .field('status',      f => f.enum(['active', 'revoked', 'expired']))
    .field('createdAt',   f => f.timestamp())
    .field('revokedAt',   f => f.timestamp().nullable())

    .relation('owner', r => r.belongsTo('VaultUser').foreignKey('ownerId'))

    .stateMachine('status', sm => sm
      .initial('active')
      .state('active',  s => s.description('Grant is valid; relay will serve data for pull grants'))
      .state('revoked', s => s.description('Owner explicitly revoked; relay refuses further access').terminal())
      .state('expired', s => s.description('Past expiresAt or consumed if singleUse').terminal())

      .transition(t => t.from('active').to('revoked').trigger('revoke')
        .effect('Sets revokedAt to now; relay stops serving this grant immediately'))
      .transition(t => t.from('active').to('expired').trigger('expire')
        .guard('expiresAt must be in the past, or grant is singleUse and has been accessed'))
    )

    .behavior('revoke', b => b
      .description('Immediately invalidates the grant; relay stops serving data for pull grants')
      .rule('Only the vault owner may revoke a grant')
      .auth(a => a.roles('owner'))
    )
    .behavior('expire', b => b
      .description('System-triggered: marks the grant expired when past its expiresAt or after single-use access')
      .rule('expiresAt must be in the past, or grant is singleUse and has been accessed')
      .auth(a => a.roles('system'))
    )
  )

  // ── AuditEntry ─────────────────────────────────────────────────────────────
  // Append-only log. Each entry contains a hash of the previous entry, forming
  // a tamper-evident chain. Never deleted; kept local to the vault.

  .entity('AuditEntry', e => e
    .description('One record in the append-only, hash-chained audit log')
    .goal('Provide the vault owner with a tamper-evident history of every access and consent event')

    .field('id',        f => f.uuid().primaryKey())
    .field('ownerId',   f => f.uuid().foreignKey('VaultUser.id'))
    .field('grantId',   f => f.uuid().nullable().foreignKey('Grant.id').description('Grant involved, if applicable'))
    .field('action',    f => f.enum([
      'grant-created',
      'grant-revoked',
      'grant-expired',
      'claim-added',
      'claim-deleted',
      'vault-unlocked',
      'vault-locked',
      'recovery-started',
      'recovery-completed',
      'bundle-accessed',
    ]).description('The event type'))
    .field('actor',     f => f.string().description('Who triggered the event: "owner", "system", or a grantee DID'))
    .field('detail',    f => f.json().nullable().description('Optional structured context (claim types shared, grantee ref, etc.)'))
    .field('prevHash',  f => f.string().nullable().description('SHA-256 hash of the previous AuditEntry; null for the genesis entry'))
    .field('entryHash', f => f.string().description('SHA-256 hash of this entry\'s canonical payload including prevHash'))
    .field('createdAt', f => f.timestamp())

    .relation('owner', r => r.belongsTo('VaultUser').foreignKey('ownerId'))
    .relation('grant', r => r.belongsTo('Grant').foreignKey('grantId'))
  )

  // ── VaultAPI ───────────────────────────────────────────────────────────────
  // The local vault API — runs on the user's device.
  // All endpoints require owner-level auth (unlocked vault session).

  .api('VaultAPI', a => a
    // VaultUser
    .endpoint('GET /vault/me',             ep => ep.returns('VaultUser').auth(a => a.roles('owner'))
      .description('Return the vault owner profile'))
    .endpoint('POST /vault/lock',          ep => ep.behavior('VaultUser.lock')
      .description('Seal the vault and wipe session keys'))
    .endpoint('POST /vault/unlock',        ep => ep.behavior('VaultUser.unlock')
      .description('Unseal the vault by verifying the passphrase'))
    .endpoint('POST /vault/recover/start', ep => ep.behavior('VaultUser.startRecovery')
      .description('Begin recovery using the BIP-39 phrase'))
    .endpoint('POST /vault/recover/complete', ep => ep.behavior('VaultUser.completeRecovery')
      .description('Complete recovery with a new passphrase'))

    // Claims
    .endpoint('GET /vault/claims',         ep => ep.returns('Claim').auth(a => a.roles('owner'))
      .description('List all claims in the vault'))
    .endpoint('POST /vault/claims',        ep => ep.returns('Claim').auth(a => a.roles('owner'))
      .description('Add a new claim to the vault'))
    .endpoint('GET /vault/claims/:id',     ep => ep.returns('Claim').auth(a => a.roles('owner'))
      .description('Read one claim'))
    .endpoint('DELETE /vault/claims/:id',  ep => ep.auth(a => a.roles('owner'))
      .description('Permanently delete a claim'))

    // Grants
    .endpoint('GET /vault/grants',         ep => ep.returns('Grant').auth(a => a.roles('owner'))
      .description('List all grants'))
    .endpoint('POST /vault/grants',        ep => ep.returns('Grant').auth(a => a.roles('owner'))
      .description('Create a new grant (push or pull)'))
    .endpoint('GET /vault/grants/:id',     ep => ep.returns('Grant').auth(a => a.roles('owner'))
      .description('Read one grant'))
    .endpoint('POST /vault/grants/:id/revoke', ep => ep.behavior('Grant.revoke')
      .description('Revoke a grant immediately'))

    // Audit
    .endpoint('GET /vault/audit',          ep => ep.returns('AuditEntry').auth(a => a.roles('owner'))
      .description('List audit log entries, newest first'))
  )

  // ── RelayAPI ───────────────────────────────────────────────────────────────
  // The thin encrypted-blob relay — runs on the cheap VPS / serverless.
  // Stateless: it stores ciphertext blobs and forwards; it cannot read content.

  .api('RelayAPI', a => a
    .endpoint('PUT /relay/bundles/:grantId',  ep => ep.auth(a => a.roles('owner'))
      .description('Upload an encrypted bundle for a pull grant; body is opaque ciphertext'))
    .endpoint('GET /relay/bundles/:grantId',  ep => ep.auth(a => a.roles('grantee'))
      .description('Download an encrypted bundle; relay checks grant is active before serving'))
    .endpoint('DELETE /relay/bundles/:grantId', ep => ep.auth(a => a.roles('owner'))
      .description('Remove a bundle from the relay (called automatically on revoke)'))
  )
