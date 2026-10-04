# External Cryptography Review Plan

Status: **planned, not started.** The review itself needs funding and an external reviewer; this document defines scope, preconditions, and deliverables so an RFP can be issued as soon as funding lands. Tracked as the "No external cryptographic audit" open risk in `THREAT_MODEL.md`.

## Goal

Independent assessment of the *protocol composition* built on off-the-shelf primitives (libsodium, `@noble/hashes`, Node `crypto`, `bip39`). The primitives are not in scope for re-audit; their use is.

## Scope (in priority order)

| # | Area | Files | Questions for the reviewer |
|---|---|---|---|
| 1 | Vault encryption and key derivation | `src/crypto.ts`, `src/vault.ts` | scrypt parameters (N=2^16, r=8, p=1; accepted band 2^14..2^20 from `VaultHeader.scryptN`); `keyVerificationHash` as a pre-decryption passphrase check (offline guess oracle vs. AEAD alone); no associated data is bound to the header (`encrypt` passes `null` AAD) — can header fields such as `scryptN` or `sequenceNumber` be tampered without detection? |
| 2 | Recovery phrase | `src/recovery.ts` | BIP-39 128-bit entropy → Ed25519 seed derivation; only the SHA-256 commitment is stored; interaction between recovery and the master key. |
| 3 | Grant signing and validation | `src/consent.ts` | Canonical JSON for signed payloads (key-sorted); replay, downgrade and field-omission attacks; revocation semantics. |
| 4 | Push bundles | `src/sharing.ts` | Signature-then-encrypt ordering; who holds the decryption key and how it travels in the token; expiry enforcement on the verifier side; badge logic (self-attested / verified / imported). |
| 5 | DID, VC and SD-JWT | `src/did.ts` | `did:key` encoding; Ed25519Signature2020 proof verification and canonicalization; SD-JWT salts/digests and disclosure handling. |
| 6 | Audit hash chain | `src/audit.ts` | Chain covers content + `prevHash`; truncation of the chain tail is not detectable without an external anchor — confirm acceptable. |
| 7 | Merge and sync | `src/storage.ts`, merge logic | Rollback/fork handling via `sequenceNumber`; attacker-controlled sync folder. |
| 8 | Key lifetime | `src/vault.ts`, `extension/background.ts` | `zeroKey` effectiveness in JS (GC copies), service-worker lifetime of the unlocked vault, native messaging boundary. |

Out of scope: UI, Tauri shell hardening, Chrome Web Store process (covered by `THREAT_MODEL.md`).

## Known issues to disclose up front

- Everything listed under "open risks" in `THREAT_MODEL.md`.
- No post-quantum signatures (ML-DSA is on the roadmap).
- JS memory zeroing is best-effort only.

## Preconditions before engagement

1. Freeze a tagged release candidate; reviewer works against that commit.
2. `npm run validate`, `tsc --noEmit` and the test suite pass in CI.
3. Provide `THREAT_MODEL.md`, this plan, and a short protocol spec (header layout, blob format, grant payload, bundle token format) generated from `src/fabric.ts` and `src/generated/`.
4. Add known-answer test vectors for crypto helpers where missing, so the reviewer can check conformance quickly.

## Deliverables requested

- Written report with findings ranked by severity and a remediation recommendation for each.
- Re-test of fixes after remediation.
- Permission to publish the report (the trust story depends on it).

## Funding and selection

- Apply to NLnet / NGI (NGI Zero Commons Fund) with the review budgeted as a line item; Open Tech Fund's Red Team Lab is an alternative that provides audits directly.
- Reviewer shortlist criteria: published applied-cryptography work, experience with libsodium-based designs and DID/VC/SD-JWT, no commercial conflict.
- Rough effort estimate: 2–3 reviewer-weeks for the scope above (~2k lines of core code plus protocol specs).

## Timeline

Gate the public launch (Phase 5.1 open-sourcing announcement and Chrome Web Store listing) on completion of the report and remediation of all high/critical findings.
