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

- [ ] STRIDE threat model document (one-pager covering all trust boundaries and mitigations)
- [ ] `npm audit` / dependency pinning in CI
- [ ] Plan for external cryptography review before public launch
- [ ] Upgrade scrypt N from 2^14 to 2^16
- [ ] SD-JWT full spec conformance (current `frameSDJWT()` is a stub)
- [ ] VC proof verification in `importVC()`

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

- [ ] Scaffold `desktop/` with `npm create tauri-app`
- [ ] Write `read_vault_file` / `write_vault_file` Rust commands
- [ ] Wire Vite config to resolve `../src/` vault library imports
- [ ] Unlock / lock screen (passphrase entry, calls `Vault.open`)
- [ ] Claims list + add/edit/delete UI
- [ ] Audit log viewer
- [ ] Sync panel (relay URL config + manual sync trigger)
- [ ] Package and test on Linux, macOS, Windows
- [ ] (Follow-up) Native messaging host so the extension can delegate to the desktop app

---

## Phase 4 — Validation

**Step 4.1 — Dogfood.** Use it for every form/application you fill for a month. Log friction.

**Step 4.2 — 10 real users.** Friends/family in your wedge scenario. Watch them onboard without helping. The passphrase/recovery step is where consumer crypto products die — iterate there until a non-technical user succeeds unassisted.

**Step 4.3 — One real consumer of the data.** Convince a single counterpart (a landlord, a clinic, an HR person, a community org) to accept a vault bundle instead of emailed PDFs. One real-world acceptance validates the model more than 100 users.

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
