# Personal Data Vault — Roadmap

A step-by-step plan for building a user-owned personal data store with granular, revocable consent, using open standards and near-zero capital. Written for a solo developer or small team.

---

## 0. The Core Concept

One encrypted store that holds a person's data (identity attributes, documents, preferences, history). Applications never get a copy — they get **scoped, revocable, auditable access** through a consent layer. The user is the root of trust.

Three pillars:
1. **Storage** — encrypted, portable, user-controlled (self-hosted or hosted-but-encrypted).
2. **Identity** — the user proves who they are without a central authority (DIDs + Verifiable Credentials).
3. **Consent** — every access is an explicit grant: which fields, which app, what duration, revocable anytime, logged.

---

## Phase 3 — MVP Build ✅ (complete)

All steps below are implemented. Modules are in `src/` and `extension/`.

| Step | What | Module |
|---|---|---|
| 3.2.1 | Vault core: create/open/lock, claims CRUD, encrypted persistence | `vault.ts`, `crypto.ts` |
| 3.2.2 | Backup & restore via BIP-39 recovery phrase | `recovery.ts` |
| 3.2.3 | Push sharing: signed encrypted bundle, verifier with badges | `sharing.ts` |
| 3.2.4 | Browser extension: form-filler with per-site/per-field approval, popup, MV3 service worker | `extension/`, `src/form-filler.ts` |
| 3.2.5 | Audit log: hash chain, tamper detection, display format | `audit.ts` |
| 3.2.6 | Sync relay + second device: Cloudflare Worker + KV, Ed25519-authenticated push/pull | `relay/worker.ts`, `src/relay.ts` |
| 3.2.7 | Grant consent layer: create, sign, validate, revoke | `consent.ts` |
| 2.3 | DID identity layer: `did:key` generation, VC import stub, SD-JWT framing | `did.ts` |

---

## Phase 3 — Remaining steps

### Step 3.3 — Security hygiene

- [x] STRIDE threat model document — `THREAT_MODEL.md` covers all trust boundaries, mitigations, and open risks
- [x] `npm audit` in CI — `.github/workflows/ci.yml` runs audit + `tsc --noEmit` + extension build on every push/PR
- [x] Upgrade scrypt N from 2^14 to 2^16 — `VaultHeader.scryptN` stores the parameter; old vaults fall back to 16384 transparently
- [ ] Plan for external cryptography review before public launch — noted in `THREAT_MODEL.md` open risks; fund via NLnet/NGI grant
- [x] SD-JWT full spec conformance — `issueSDJWT()` / `verifySDJWT()` in `did.ts` implement the compact `~`-separated format with per-claim salt disclosures and SHA-256 digests; `frameSDJWT()` kept as a deprecated wrapper
- [x] VC proof verification in `importVC()` — `verifyVCProof()` checks Ed25519Signature2020 proofs; claims get `verification: 'verified'` only on a valid cryptographic check, `'none'` otherwise

---

## Phase 3.5 — Desktop App (Tauri)

This step sits between Phase 3 and Phase 4 because a native desktop app is the strongest possible home for the vault: it owns the file on disk, survives browser profile wipes, and makes the extension a thin UI layer on top of a persistent local process rather than the sole owner of the encrypted blob.

**Framework: Tauri** — ships a ~8 MB binary (vs. ~150 MB for Electron), uses the OS WebView for the UI (same HTML/CSS/TS as the extension popup), and delegates file I/O to a minimal Rust backend. The vault crypto library runs entirely in the WebView as a Vite-bundled JS module — no Rust crypto needed.

### What to build

**`desktop/`** — a new directory in this repo, structured as a Tauri v2 app.

```
desktop/
  src-tauri/          ← Rust backend (Tauri commands only — file I/O, nothing else)
    src/
      main.rs         ← app entry point
      commands.rs     ← read_vault_file / write_vault_file Tauri commands
    tauri.conf.json
    Cargo.toml
  src/                ← TypeScript frontend (Vite + same vault library imports)
    main.ts           ← app entry, imports from ../src/vault, ../src/relay etc.
    App.tsx           ← root UI component
    screens/
      Unlock.tsx
      Claims.tsx
      Audit.tsx
      Sync.tsx
  index.html
  vite.config.ts
  package.json        ← devDependency on @tauri-apps/cli; shared vault deps via workspace
```

**Rust commands (thin layer — no crypto):**
```rust
// read the vault JSON blob from a platform-appropriate path
read_vault_file() -> Result<String, String>
// write the sealed vault blob back to disk
write_vault_file(blob: String) -> Result<(), String>
```

Default vault file location:
- Linux: `~/.local/share/personal-vault/vault.json`
- macOS: `~/Library/Application Support/personal-vault/vault.json`
- Windows: `%APPDATA%\personal-vault\vault.json`

**TypeScript frontend:**
- Calls `read_vault_file` / `write_vault_file` via `@tauri-apps/api/tauri`
- Imports `Vault`, `syncVault`, `generateDID`, etc. directly from `../src/`
- Shares the same sync relay client (`src/relay.ts`) — no duplication
- UI mirrors the extension popup but with a full window: claims list, add/edit claim, audit log viewer, sync settings

**Extension integration (native messaging — optional follow-up):**
Once the desktop app is running, the browser extension can delegate vault I/O to it via Chrome's Native Messaging API instead of `chrome.storage.local`. This makes the desktop app the single source of truth and removes the need for the relay for local-only users. This is a follow-up step, not a blocker.

### Build steps

- [x] Scaffold `desktop/` — Cargo.toml, tauri.conf.json, Vite config, package.json, index.html
- [x] Write `read_vault_file` / `write_vault_file` / `vault_file_exists` Rust commands in `commands.rs`
- [x] Wire Vite config to resolve `../src/` vault library imports via `@vault/*` alias
- [x] Unlock / lock screen (`screens/Unlock.tsx` — create vault or open existing, shows recovery phrase on create)
- [x] Claims list + add/edit/delete UI (`screens/Claims.tsx`)
- [x] Audit log viewer with chain-integrity badge (`screens/Audit.tsx`)
- [x] Sync panel — relay URL config + manual sync trigger (`screens/Sync.tsx`)
- [ ] Package and test on Linux, macOS, Windows (requires Rust + `cargo tauri build`)
- [x] Native messaging host: auto-installed by the desktop app on first launch; extension ID stabilised via RSA key in `manifest.json` — no manual steps for users

---

## Phase 4 — Validation

**Step 4.1 — Dogfood.** Use it for every form/application you fill for a month. Log friction.

**Step 4.2 — 10 real users.** Friends/family in your wedge scenario. Watch them onboard without helping. The passphrase/recovery step is where consumer crypto products die — iterate there until a non-technical user succeeds unassisted.

**Step 4.3 — One real consumer of the data.** Convince a single counterpart (a landlord, a clinic, an HR person, a community org) to accept a vault bundle instead of emailed PDFs. One real-world acceptance validates the model more than 100 users.

---

## Phase 3.5.1 — Vault Discovery & Selection

Currently the extension and desktop app can each have separate vaults (one in `chrome.storage.local`, one in `vault.json`) with no way to reconcile them. This step fixes that with a proper vault picker.

### What to build

**Extension popup vault picker:**
- On popup open, query both storage backends (native host + `chrome.storage.local`) for vault headers (unencrypted metadata — no passphrase needed)
- If **no vaults found anywhere**: skip the unlock form entirely and go straight to the "Create new vault" view
- If **exactly one vault found**: current behavior — show unlock form pre-pointed at that vault
- If **multiple vaults found**: show a vault picker list (origin label, creation date from header) before the unlock form so the user can select which to unlock

**Background changes:**
- `discoverVaults()` — probe native host and `chrome.storage.local`, return an array of `{ source: 'native' | 'local', header: VaultHeader }` without decrypting
- `SELECT_VAULT` message: popup tells background which source to load from; background caches the choice for the session
- On `UNLOCK_VAULT`, use the selected source rather than the fixed priority order

**Desktop app:**
- Equivalent vault picker on the unlock screen: scan `data_local_dir()/personal-vault/` for `*.json` files that parse as valid `PersistedVault`, list them with header metadata, let the user pick before entering passphrase

**Migration helper:**
- After picking and unlocking a vault, if the other source also has a vault, offer a one-click "Merge into this vault" action that imports claims from the other vault (deduplicating by claim ID)

### Build steps

- [x] `discoverVaults()` in background — headers only, no decryption
- [x] `SELECT_VAULT` / `GET_VAULT_LIST` messages in `messages.ts`
- [x] Popup: skip unlock form when no vaults exist, show picker when multiple exist
- [x] Desktop: vault picker on unlock screen
- [x] Migration helper: merge claims from secondary vault after unlock

---

## Phase 3.6 — Chrome Web Store Publishing

Publishing to the Web Store gives the extension a permanent, public extension ID — different from the dev ID derived from the `key` in `manifest.json`.

### Steps

- [ ] **Create a Chrome Web Store developer account** ($5 one-time fee at [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole))
- [ ] **Build the extension for submission** — run `node extension/build.mjs`, then zip `extension/dist/`
- [ ] **Submit for review** — upload the zip, fill in store listing (description, screenshots, privacy policy URL)
- [ ] **After approval: update the extension ID**
  - The Web Store assigns a new permanent ID (e.g. `abcdefghijklmnopabcdefghijklmnop`)
  - Remove the `"key"` field from `extension/manifest.json` (the Web Store manages the key; keeping it causes a submission error)
  - Update `native-host/com.personal_vault.json` → replace `allowed_origins` with the new store ID
  - Update `install_native_host()` in `desktop/src-tauri/src/commands.rs` if the manifest is embedded rather than read from the bundle
  - Run `./desktop/build-native-host.sh` to re-stage the updated manifest, then cut a new desktop app release so existing users get the updated native host manifest automatically on next launch
- [ ] **Keep the dev ID working alongside the store ID** during the transition by listing both origins in `com.personal_vault.json`:
  ```json
  "allowed_origins": [
    "chrome-extension://fbhiaoeemhfdnjhilpdnpehdljhehffk/",
    "chrome-extension://<STORE_ID>/"
  ]
  ```
- [ ] **Auto-update policy** — once on the Web Store, Chrome auto-updates the extension; the desktop app must also be on an auto-update path (Tauri updater or platform package manager) so the native host manifest stays in sync

---

## Phase 5 — Distribution & Sustainability

**Step 5.1 — Open-source the core.** The trust story ("we can't see your data — check the code") is your only viable marketing without capital. License: AGPL for the client/relay, permissive (MIT/Apache) for the verifier SDK — you want third parties to embed the verifier freely.

**Step 5.2 — Monetization options that don't betray the model:**
- Hosted encrypted sync/backup subscription (you host ciphertext; convenience fee).
- Paid verifier SDK support for businesses that accept vault data.
- Grants: NLnet, NGI (EU Next Generation Internet), Open Tech Fund — these funds explicitly target user-sovereignty projects and fund solo developers (typically €5k–50k).

**Step 5.3 — Interop as growth.** Implement import from: browser autofill data, Google Takeout, Apple Wallet passes, existing VC wallets. Every import removes onboarding friction. Later, target eIDAS wallet interop — when EU wallets ship broadly, being the "everything else" vault beside the government identity wallet is a real position.

**Step 5.4 — Grow into the adjacent products:** Form-Filler Twin is the wedge; Reputation Passport and Digital Estate Executor are natural v2/v3 layers on the same vault core.

---

## Risks & Honest Warnings

- **Chicken-and-egg is the real boss fight.** Tech is the easy 20%. Mitigation: the wedge must deliver value with zero third-party adoption (form-filling does; "apps query your vault" does not).
- **Key loss = data loss.** You chose no backdoor; users will lose passphrases. Invest heavily in recovery UX (social recovery / printed recovery kit).
- **Regulatory:** you're intentionally *not* a data controller for vault contents (you can't read them) — get a one-time legal sanity check on GDPR/CCPA positioning when you have revenue.
- **Don't over-standardize early.** Ship the wedge; align to Solid/eIDAS interop only when someone actually asks for it.

## Rough Budget

- Domain + relay (Cloudflare Workers free tier): < $10/year
- Tauri desktop app distribution: free (no app store fees for self-distribution)
- Later: security audit ($5k–15k, fund via grants)
