# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A user-owned personal data vault: one encrypted store for identity attributes, documents, and preferences. Applications never get a copy — they get scoped, revocable, auditable access through a consent layer. The user is the root of trust.

The implementation guide lives in `personal-data-vault-implementation-guide.md`.

---

## Commands

There is no build step for day-to-day development — source files are run directly with `tsx`.

**Run a source file or ad-hoc script:**
```bash
node -r ./node_modules/tsx/dist/cjs/index.cjs <file.ts>
```

**Browser extension build** (`extension/`):
```bash
node extension/build.mjs          # build once → extension/dist/
node extension/build.mjs --watch  # watch mode
```

Load `extension/dist/` as an unpacked extension in `chrome://extensions` (Developer Mode on).

**Quoin schema commands** (after editing `src/fabric.ts`):
```bash
npm run validate      # check schema for errors — no files written
npm run inspect       # print the full IR as JSON
npm run generate      # regenerate all artifacts in src/generated/
npm run diff          # show what would change without writing files
npm run check-drift   # warn if any generated file was manually edited
```

`src/generated/` is committed. Always run `npm run generate` after changing `fabric.ts` and commit the updated generated files in the same commit.

---

## Architecture

### Two layers that never collide

**Quoin-generated layer** (`src/generated/`): TypeScript types + Zod schemas, SQL migrations, OpenAPI spec, GDPR data map, JSON Schema, RDF/OWL ontologies. Never edit these files. Change `src/fabric.ts` and regenerate.

**Application layer** (`src/*.ts`): hand-written modules that import from `src/generated/typescript/index.ts`. This is where all crypto, identity, and consent logic lives.

### Module map

```
crypto.ts     — primitives only: XChaCha20-Poly1305 encrypt/decrypt, scrypt key
                derivation, Ed25519 sign/verify, SHA-256, base64url helpers,
                memzero. No business logic.

vault.ts      — Vault class: create/open/lock/seal (encrypted JSON blob),
                CRUD for Claims and Grants, revokeGrant, internal
                hash-chained audit log via _appendAudit(). The master key
                lives only in memory while unlocked.

recovery.ts   — BIP-39 mnemonic generation and restore. generateMnemonicBundle()
                returns the 12-word phrase + Ed25519 keypair derived from it.
                Only the SHA-256 commitment is stored in VaultHeader, never
                the phrase itself.

did.ts        — did:key identity (Ed25519, base58btc multicodec). generateDID(),
                resolveDID() (no network), signWithDID(), verifyWithDID(),
                importVC() (W3C VC → Claim array), frameSDJWT() stub.

sharing.ts    — Push bundle flow: createBundle() signs the canonical payload
                with the owner Ed25519 key and encrypts with XChaCha20.
                encodeToken/decodeToken: base64url compact token.
                verifyBundle(): recipient side — sig check, decrypt, expiry,
                self-attested / verified / imported badges.

audit.ts      — Standalone hash-chain utilities: buildEntry(), verifyChain()
                (detects both broken linkage and content tampering),
                formatAuditLog() for the UI screen. The Vault class calls
                _appendAudit() internally; this module exposes the primitives
                for independent use (relay, testing).

consent.ts    — Application-layer grant logic: createGrant() (builds + signs),
                validateGrant() (sig + status + expiry), createPushGrant()
                (full "share claims" action combining sharing.ts + vault),
                revokeGrant() (delegates to Vault).

src/fabric.ts — Single source of truth for the data model. Edit this, then
                run `npm run generate`. Never edit src/generated/.
```

### Browser extension (`extension/`)

Built with esbuild (see `extension/build.mjs`). Output goes to `extension/dist/`; load as an unpacked Chrome extension.

```
extension/messages.ts      — Typed discriminated-union message protocol for all
                             three communication channels:
                               ContentToBackground | BackgroundToContent
                               PopupToBackground   | BackgroundToPopup
                             Single source of truth for message shapes — both
                             ends import from here. Never use untyped raw
                             sendMessage calls.

extension/background.ts    — Background service worker. Sole holder of the
                             unlocked Vault instance. Handles all vault I/O,
                             approval logic, and fill-map construction. A single
                             onMessage listener dispatches all message types
                             through handleMessage(). Stores SiteApproval
                             records in chrome.storage.local (tombstone on
                             revoke; never delete, so APPROVAL_REVOKED can fire
                             on revisit).

extension/content.ts       — Content script injected at document_idle. Detects
                             form fields via FILL_RULES selectors and exact
                             autocomplete token matching (split(' ').includes,
                             not substring). Sends FORM_DETECTED; injects fill
                             values from FILL_DATA; shows the approval banner
                             and fill confirmation toast. Holds no vault state
                             between page loads.

extension/popup/popup.ts   — Popup UI. Unlock / lock the vault (UNLOCK_VAULT /
                             LOCK_VAULT messages). Lists and revokes site
                             approvals. Uses isSiteApprovalValid from
                             form-filler.ts — never re-implements the check.

src/form-filler.ts         — Vault-side library shared by the extension.
                             FILL_RULES: claim-type → CSS selectors +
                             autocomplete tokens. buildFillMap(): Claim[] →
                             FillMap. SiteApproval type + buildSiteApproval()
                             + isSiteApprovalValid() (checks both expiresAt
                             and revoked flag). filterFillMapForSite() is
                             exported but is a no-op when claims are
                             pre-filtered — call sites in background.ts omit it.
```

**Extension invariants**

- **One dispatcher.** All popup and content-script message types flow through the single `handleMessage` async function. No second `onMessage` listener for lifecycle messages.
- **Revoke = tombstone, not delete.** `REVOKE_APPROVAL` sets `revoked: true` on the `SiteApproval` record; it is never removed from storage. This allows `FORM_DETECTED` to find the record and send `APPROVAL_REVOKED` instead of re-prompting.
- **Autocomplete matching is exact-token.** `autocomplete.split(' ').includes(token)` — not `autocomplete.includes(token)` — to prevent `'given-name'` from matching the `'name'` token.
- **FILL_RULES constants are module-level.** `KNOWN_SELECTORS` and `KNOWN_AUTOCOMPLETE` in content.ts are computed once at load time, not inside `detectFields()`.
- **Claims are pre-filtered before buildFillMap.** All three `FILL_DATA` send sites in background.ts filter `allClaims` to approved types before calling `buildFillMap`; `filterFillMapForSite` is therefore not called at those sites.

### Key invariants

- **No plaintext leaves the vault.** `Claim.value` is always stored encrypted inside the vault blob. The vault blob itself is XChaCha20-Poly1305 encrypted with the scrypt-derived master key.
- **Master key lives in memory only.** `Vault.lock()` calls `zeroKey()` before returning. After locking, the Vault object is unusable.
- **Wrong passphrase is rejected before decryption.** `keyVerificationHash` (stored in `VaultHeader`) is checked first; the actual ciphertext is only touched after the hash matches.
- **Grant signatures bind to the owner DID.** `createGrant()` signs the canonical grant payload with the owner Ed25519 private key. `validateGrant()` re-derives and verifies before serving any data.
- **Audit chain is tamper-evident.** Each `AuditEntry.entryHash` covers the canonical (key-sorted) JSON of that entry including `prevHash`. `verifyChain()` recomputes every hash to detect any modification.

### Crypto stack

| Purpose | Primitive | Source |
|---|---|---|
| Symmetric encryption | XChaCha20-Poly1305 | libsodium-wrappers (CJS) |
| Key derivation | scrypt N=16384, r=8, p=1 | Node built-in `crypto` |
| Signing / DID keys | Ed25519 | libsodium-wrappers |
| Hashing | SHA-256 | Node built-in `crypto` |
| Recovery phrase | BIP-39 128-bit (12 words) | bip39 |

> **Note:** scrypt N is currently 16384 (2^14) to stay within Node 24's default memory limit. Production targets 2^16 or higher.

> **Note:** `libsodium-wrappers` ESM entry is broken in this environment (missing `libsodium.mjs`). Only the CJS entry (`dist/modules/libsodium-wrappers.js`) works. The project is set to `"type": "commonjs"` for this reason.

---

## Implementation status

### Done

| Step | What | Module |
|---|---|---|
| Phase 2, Steps 2.2–2.5 | Data model, consent protocol, identity layer, system diagram | `src/fabric.ts` + `src/generated/` |
| Phase 3, Step 3.1 | Stack selection, project scaffold | `package.json`, `newel.config.ts` |
| Phase 3, Step 3.2.1 | Vault core: create/open/lock, claims CRUD, encrypted persistence | `vault.ts`, `crypto.ts` |
| Phase 3, Step 3.2.2 | Backup & restore via BIP-39 recovery phrase | `recovery.ts` |
| Phase 3, Step 3.2.3 | Push sharing: signed encrypted bundle, verifier with badges | `sharing.ts` |
| Phase 2, Step 2.3 | DID identity layer: did:key generation, VC import stub, SD-JWT framing | `did.ts` |
| Phase 3, Step 3.2.5 | Audit log screen data: hash chain, tamper detection, display format | `audit.ts` |
| Phase 2, Steps 2.4 / Phase 3, Step 3.2.7 | Grant consent layer: create, sign, validate, revoke | `consent.ts` |
| Phase 3, Step 3.2.4 | Browser extension: form-filler with per-site/per-field approval, popup, MV3 service worker | `extension/`, `src/form-filler.ts` |

### Pending

| Step | What |
|---|---|
| Phase 3, Step 3.2.6 | **Sync relay + second device:** encrypted-blob relay (VPS or Cloudflare Workers + R2), pull grants, multi-device sync |
| Phase 3, Step 3.2.7 (partial) | Pull grants (revocation is done; relay-side enforcement is not) |
| Phase 3, Step 3.3 | Security hygiene: STRIDE threat model doc, CI dependency audit, plan for external crypto review |
| Phase 4 | Validation: dogfood, 10 real users, one real data consumer |
| Phase 5 | Distribution: open-source, monetisation, eIDAS/Solid interop |
| Crypto | SD-JWT full spec conformance (currently a framing stub in `did.ts`); VC proof verification in `importVC()`; scrypt N upgrade to 2^16 |
