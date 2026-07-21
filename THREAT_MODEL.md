# STRIDE Threat Model — Personal Data Vault

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│  USER DEVICE                                                │
│                                                             │
│  ┌──────────────┐    ┌─────────────────────────────────┐   │
│  │   Browser    │    │  Extension (background worker)  │   │
│  │   (tabs)     │◄──►│  Vault (encrypted blob in       │   │
│  │              │    │  chrome.storage.local)          │   │
│  └──────────────┘    └───────────────┬─────────────────┘   │
│                                      │                      │
└──────────────────────────────────────┼──────────────────────┘
                                       │ HTTPS + Ed25519 auth
                             ┌─────────▼──────────┐
                             │  Sync Relay         │
                             │  (Cloudflare Worker)│
                             │  stores opaque blob │
                             └────────────────────┘
                                       │
                             ┌─────────▼──────────┐
                             │  Verifier / Relying │
                             │  Party              │
                             │  (receives bundles) │
                             └────────────────────┘
```

---

## STRIDE Analysis

### S — Spoofing

| Threat | Where | Mitigation | Status |
|--------|-------|------------|--------|
| Attacker impersonates vault owner to relay | Relay push/pull | Ed25519 challenge-response: relay issues nonce, client signs `nonce.ownerId` with owner private key | ✅ Implemented |
| Attacker forges a push bundle | Verifier | `ownerSig` in bundle covers canonical payload; verifier checks sig against embedded `ownerPublicKey` | ✅ Implemented |
| Attacker forges a grant | Grant validation | `ownerSig` covers all grant fields; `validateGrant()` re-derives and checks before serving data | ✅ Implemented |
| Attacker registers a different owner at the relay | First push | Relay binds `ownerId → publicKey` on first registration; subsequent pushes must match stored key | ✅ Implemented |

### T — Tampering

| Threat | Where | Mitigation | Status |
|--------|-------|------------|--------|
| Attacker modifies vault blob at rest (file/storage) | Vault blob | XChaCha20-Poly1305 with authentication tag; any tamper → decrypt failure | ✅ Implemented |
| Relay tampers with stored blob | Sync | AEAD tag covers ciphertext; client detects on open | ✅ Implemented |
| Audit log entries altered post-hoc | Vault state | Hash chain: each `entryHash` covers content + `prevHash`; `verifyChain()` detects any mutation | ✅ Implemented |
| Attacker modifies relay-stored blob to an older version | Sync | `VaultHeader.sequenceNumber` increments on every seal; client keeps whichever copy has the higher sequence | ✅ Implemented |
| Extension content script field injection tampering | Extension | Content script only injects values after explicit user approval per site | ✅ Implemented |

### R — Repudiation

| Threat | Where | Mitigation | Status |
|--------|-------|------------|--------|
| User denies creating a grant | Consent layer | `ownerSig` over grant payload is non-repudiable proof of DID key control | ✅ Implemented |
| User denies sharing a bundle | Push sharing | Bundle includes `ownerSig` over canonical payload + timestamp | ✅ Implemented |
| Audit log entries missing or reordered | Vault | Hash chain provides ordered, tamper-evident sequence; gaps break chain verification | ✅ Implemented |

### I — Information Disclosure

| Threat | Where | Mitigation | Status |
|--------|-------|------------|--------|
| Relay operator reads vault contents | Relay | Relay receives only `PersistedVault` — header (metadata) + AEAD ciphertext; plaintext never sent | ✅ Implemented |
| Master key exposed in memory after lock | Vault | `Vault.lock()` calls `zeroKey()` (libsodium `memzero`) before returning | ✅ Implemented |
| Wrong-passphrase oracle (timing) | Vault open | `keyVerificationHash` check is SHA-256 comparison (constant-time in Node crypto) before decrypt | ✅ Implemented |
| Claim values leaked in form-fill logs | Extension | Only fill values are injected into form fields; no logging of claim values to console or storage | ✅ Implemented |
| Recovery phrase stored in vault | Recovery | Only SHA-256 commitment stored in `VaultHeader.mnemonicCommitment`; phrase never persisted | ✅ Implemented |
| VC proofs not verified on import | `did.ts` importVC | `importVC()` accepts VC without cryptographic proof check — see **open risk** below | ⚠️ Partial |

### D — Denial of Service

| Threat | Where | Mitigation | Status |
|--------|-------|------------|--------|
| Attacker floods relay with challenge requests | Relay | Nonces are single-use and short-lived (60 s TTL); Cloudflare Workers rate limiting can be layered on | ✅ Partial (CF rate limit layer not configured) |
| Attacker pushes extremely large blob to relay | Relay | Worker enforces 1 MB body limit | ✅ Implemented |
| Slow scrypt exhausts CPU on open | Client | scrypt N is a fixed parameter — cannot be externally influenced | ✅ Implemented |

### E — Elevation of Privilege

| Threat | Where | Mitigation | Status |
|--------|-------|------------|--------|
| Malicious web page extracts fill data via content script | Extension | Content script holds no vault state; background worker sends fill values only after site approval | ✅ Implemented |
| Rogue extension gains vault access | Extension | Vault unlocked only in background service worker; popup and content scripts send typed messages, never receive raw claims | ✅ Implemented |
| Expired/revoked grant re-used by grantee | Consent | `validateGrant()` checks `status`, `expiresAt`, and `ownerSig` before serving any data | ✅ Implemented |
| Attacker replays a captured challenge signature | Relay | Nonces are single-use; relay deletes nonce on first use | ✅ Implemented |

---

## Open Risks

| Risk | Severity | Mitigation path |
|------|----------|-----------------|
| VC proof not verified in `importVC()` | Medium | Claims imported from VCs are tagged `source: 'issuer-signed'` and `verification: 'verified'` without actual cryptographic proof check. An attacker who can feed a malicious VC gains a falsely-verified claim. Fix: implement Ed25519/secp256k1 proof verification per W3C VC Data Model. |
| SD-JWT is a stub | Medium | `frameSDJWT()` produces a non-standard payload; recipients cannot verify it against the SD-JWT draft spec. Risk is limited to push-sharing consumers who expect SD-JWT. Fix: implement full SD-JWT spec conformance (hash disclosures, `_sd` array). |
| Cloudflare Worker rate limiting not configured | Low | The relay has no per-IP request cap beyond Cloudflare's default abuse protection. A determined attacker could hammer the challenge endpoint. Mitigation: add `wrangler` rate limiting rule or a KV-based counter. |
| scrypt N stored in VaultHeader (client-controlled) | Low | A modified client could write `scryptN: 1` to weaken KDF on next seal. Mitigation: add a minimum N floor (`>= 16384`) in `Vault.open()` that refuses to open vaults with N below the floor. |
| No external cryptographic audit | High | All crypto primitives are off-the-shelf (libsodium, Node built-ins), but the protocol composition (key derivation, grant signing, bundle format) has not been reviewed by an independent cryptographer. Plan: fund via NLnet/NGI grant before public launch. |

---

## Scope: What the Vault Does Not Protect Against

- **Compromised user device.** If the OS or another app has root/kernel access, memory scanning can extract the master key while the vault is unlocked. Mitigation is OS-level (full-disk encryption, secure enclave) — out of scope for this project.
- **Passphrase brute-force with stolen blob.** scrypt N=2^16 with r=8, p=1 gives ~64 ms/guess on a modern CPU. A 6-character lowercase password is crackable; a 4-word BIP-39 phrase is not. User education and strong passphrase guidance are the mitigations.
- **Relay availability.** The relay is a single Cloudflare Worker. Cloudflare outage = no sync. Local vault copy remains usable; sync is best-effort.
