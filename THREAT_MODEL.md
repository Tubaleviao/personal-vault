# STRIDE Threat Model — Personal Data Vault

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│  USER DEVICE                                                │
│                                                             │
│  ┌──────────────┐    ┌─────────────────────────────────┐   │
│  │   Browser    │    │  Extension (background worker)  │   │
│  │   (tabs)     │◄──►│  Vault (encrypted blob in       │   │
│  │              │    │  chrome.storage.local or        │   │
│  └──────────────┘    │  delegated to desktop app)      │   │
│                      └───────────────┬─────────────────┘   │
│                                      │                      │
│  ┌──────────────────────────────┐    │                      │
│  │  Desktop App (Tauri)         │◄───┘  native messaging   │
│  │  vault.json (local copy)     │                          │
│  └──────────────┬───────────────┘                          │
│                 │ file I/O                                  │
│  ┌──────────────▼───────────────┐                          │
│  │  Sync folder                 │                          │
│  │  (iCloud Drive / Dropbox /   │                          │
│  │   Google Drive / flash drive)│                          │
│  └──────────────────────────────┘                          │
└─────────────────────────────────────────────────────────────┘

                             ┌────────────────────┐
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
| Attacker forges a push bundle | Verifier | `ownerSig` in bundle covers canonical payload; verifier checks sig against embedded `ownerPublicKey` | ✅ Implemented |
| Attacker forges a grant | Grant validation | `ownerSig` covers all grant fields; `validateGrant()` re-derives and checks before serving data | ✅ Implemented |
| Attacker swaps vault file in sync folder with an old copy | Sync folder | `VaultHeader.sequenceNumber` checked on open; lower sequence is rejected or flagged | ✅ Implemented |

### T — Tampering

| Threat | Where | Mitigation | Status |
|--------|-------|------------|--------|
| Attacker modifies vault blob at rest (file/storage) | Vault blob | XChaCha20-Poly1305 with authentication tag; any tamper → decrypt failure | ✅ Implemented |
| Cloud provider or OS tampers with stored blob | Sync folder | AEAD tag covers ciphertext; client detects tampering on open | ✅ Implemented |
| Audit log entries altered post-hoc | Vault state | Hash chain: each `entryHash` covers content + `prevHash`; `verifyChain()` detects any mutation | ✅ Implemented |
| Attacker replaces sync folder file with an older version | Sync folder | `VaultHeader.sequenceNumber` increments on every seal; client keeps whichever copy has the higher sequence | ✅ Implemented |
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
| Cloud provider reads vault contents | Sync folder | Provider receives only the sealed `PersistedVault` blob — AEAD ciphertext; plaintext never written to the sync folder | ✅ Implemented |
| Master key exposed in memory after lock | Vault | `Vault.lock()` calls `zeroKey()` (libsodium `memzero`) before returning | ✅ Implemented |
| Wrong-passphrase oracle (timing) | Vault open | `keyVerificationHash` check is SHA-256 comparison (constant-time in Node crypto) before decrypt | ✅ Implemented |
| Claim values leaked in form-fill logs | Extension | Only fill values are injected into form fields; no logging of claim values to console or storage | ✅ Implemented |
| Recovery phrase stored in vault | Recovery | Only SHA-256 commitment stored in `VaultHeader.mnemonicCommitment`; phrase never persisted | ✅ Implemented |
| VC proofs not verified on import | `did.ts` importVC | `verifyVCProof()` checks Ed25519Signature2020 proofs; `importVC()` now sets `verification: 'verified'` only after a successful cryptographic check, `'none'` otherwise | ✅ Implemented |

### D — Denial of Service

| Threat | Where | Mitigation | Status |
|--------|-------|------------|--------|
| Sync folder fills up (flash drive full) | Sync folder | `writeVaultFile` checks available space before writing; surfaces `DRIVE_FULL` error with clear message | 🔜 Planned (Phase 3.5.2) |
| Slow scrypt exhausts CPU on open | Client | `scryptN` comes from `VaultHeader`; `Vault.open` and `deriveKey` enforce `SCRYPT_N_MIN` (16384) ≤ N ≤ `SCRYPT_N_MAX` (2^20), rejecting crafted headers before any allocation | ✅ Implemented |
| Attacker sets `scryptN: 1` in relay-stored header to weaken KDF | Relay / Client | `Vault.open` checks `N >= SCRYPT_N_MIN` and throws before calling `deriveKey`; `deriveKey` independently validates the range | ✅ Implemented |

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
| VC proof not verified in `importVC()` | ~~Medium~~ | **Resolved.** `verifyVCProof()` verifies Ed25519Signature2020 proofs using the W3C VC Data Model signing input (SHA-256 of proof options + SHA-256 of document). Claims from unverified VCs get `verification: 'none'`. Limitation: full RDFC-1.0 JSON-LD canonicalization is not implemented; issuers that deviate from sorted-key JSON will produce `'none'`. |
| SD-JWT is a stub | ~~Medium~~ | **Resolved.** `issueSDJWT()` / `verifySDJWT()` implement the SD-JWT compact format (draft-ietf-oauth-selective-disclosure-jwt): per-claim salted disclosures, SHA-256 digests in `_sd`, spec-compliant `~`-separated compact serialisation. `frameSDJWT()` is deprecated but preserved for backwards compatibility. |
| Cloud provider sync conflict (two devices write simultaneously) | Low | `VaultHeader.sequenceNumber` is compared on open; the lower-sequence copy is flagged. The desktop app surfaces a "conflict detected" dialog offering to keep local or cloud copy. Full three-way merge is not planned — single-user append-only model makes it rare. |
| scrypt N stored in VaultHeader (client-controlled) | Low | ~~Mitigated~~: `Vault.open()` enforces `scryptN >= SCRYPT_N_MIN` (16384) and `<= SCRYPT_N_MAX` (2^20) before calling `deriveKey`; `deriveKey` independently validates the range. Crafted headers outside this band are rejected before any memory allocation. |
| No external cryptographic audit | High | All crypto primitives are off-the-shelf (libsodium, Node built-ins), but the protocol composition (key derivation, grant signing, bundle format) has not been reviewed by an independent cryptographer. Plan: fund via NLnet/NGI grant before public launch. |

---

## Scope: What the Vault Does Not Protect Against

- **Compromised user device.** If the OS or another app has root/kernel access, memory scanning can extract the master key while the vault is unlocked. Mitigation is OS-level (full-disk encryption, secure enclave) — out of scope for this project.
- **Passphrase brute-force with stolen blob.** scrypt N=2^16 with r=8, p=1 gives ~64 ms/guess on a modern CPU. A 6-character lowercase password is crackable; a 4-word BIP-39 phrase is not. User education and strong passphrase guidance are the mitigations.
- **Cloud provider availability.** If iCloud / Dropbox / Google Drive is down, the sync folder may not propagate changes to other devices. The local vault copy always remains usable; sync is best-effort and offline-first.
