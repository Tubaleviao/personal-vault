# Personal Data Vault — Implementation Guide

A step-by-step plan for building a user-owned personal data store with granular, revocable consent, using open standards and near-zero capital. Written for a solo developer or small team.

---

## 0. The Core Concept

One encrypted store that holds a person's data (identity attributes, documents, preferences, history). Applications never get a copy — they get **scoped, revocable, auditable access** through a consent layer. The user is the root of trust.

Three pillars:
1. **Storage** — encrypted, portable, user-controlled (self-hosted or hosted-but-encrypted).
2. **Identity** — the user proves who they are without a central authority (DIDs + Verifiable Credentials).
3. **Consent** — every access is an explicit grant: which fields, which app, what duration, revocable anytime, logged.

---

## Phase 1 — Research & Positioning (Week 1–2)

**Step 1.1 — Study prior art so you don't repeat its mistakes.**
- Solid Protocol (solidproject.org): read the spec, run the Community Solid Server locally. Understand *why* adoption stalled: developer-hostile UX, no killer app, chicken-and-egg.
- W3C Verifiable Credentials Data Model 2.0 and W3C DID Core — these are your interop layer.
- EU Digital Identity Wallet (eIDAS 2.0) architecture reference framework — even if you're not in the EU, it defines where the regulatory wind blows.
- Look at HAT (Hub of All Things), Inrupt, Meeco, Digi.me — note what they charge and where they pivoted (almost all went B2B; that's a signal about consumer monetization, not feasibility).

**Step 1.2 — Pick a wedge use case.** A general vault has no adoption pull. Choose ONE painful, recurring flow to nail first. Strong candidates:
- **Form auto-fill from your own vault** (the "Form-Filler Twin" — name, address, employment history, IDs) — daily pain, demoable.
- Rental/loan application packets (proof of income, ID, references shared as a bundle with expiry).
- Medical intake forms.

Decision rule: pick the one you personally suffer from most — you are user #1.

**Step 1.3 — Define your non-goals.** Write them down: no blockchain token, no social network, no B2B pivot in v1, no storing data you can read server-side.

---

## Phase 2 — Architecture Design (Week 2–3)

**Step 2.1 — Choose the trust model: local-first, end-to-end encrypted.**
- Data lives primarily on the user's device (SQLite or an embedded encrypted store).
- Sync via an encrypted blob relay (your cheap server, or user's own cloud storage). Server sees only ciphertext.
- Recommended primitives: libsodium (XChaCha20-Poly1305) for encryption, Argon2id for key derivation from passphrase, BIP-39 style recovery phrase for backup.

**Step 2.2 — Data model.**
- Schema-flexible core: store data as typed JSON documents ("claims") with metadata: `{id, type, value, source, issued_at, expires_at, verification}`.
- Use schema.org vocabularies + W3C VC types where they exist, so third parties can consume without custom mapping.
- Every claim is individually addressable → enables field-level consent (share "date of birth" without sharing the whole passport).

**Step 2.3 — Identity layer.**
- Generate a `did:key` per user at onboarding (zero infrastructure). Upgrade path to `did:web` later.
- Support importing Verifiable Credentials issued by others, and self-attested claims (clearly labeled as such).
- Implement selective disclosure with SD-JWT VC (simpler than BBS+ to start; widely adopted in the eIDAS ecosystem).

**Step 2.4 — Consent & access protocol.**
- Define a grant object: `{grantee, claims[], purpose, expiry, single_use|persistent}` — signed by the user's key.
- Access flows:
  a. **Push:** user generates a signed, encrypted bundle (QR code / link) the recipient decrypts once. Simplest; build this first.
  b. **Pull:** recipient app requests, user approves in-app, vault serves the data over your relay. Build second.
- Every grant and access is appended to a local, tamper-evident audit log (hash chain).
- Revocation: for pull grants, delete the grant → relay stops serving. For push, use short expiries; be honest in the UX that a copied bundle can't be un-copied.

**Step 2.5 — Sketch the system diagram.** Components: mobile/desktop client (the vault), encrypted sync relay, grant verifier SDK (what third parties embed), audit log. Keep the relay stateless and dumb.

---

## Phase 3 — MVP Build (Week 4–10)

**Step 3.1 — Stack (all free/open-source).**
- Client: cross-platform — React Native or Flutter for mobile-first; or Tauri if desktop-first. Local storage: SQLite + SQLCipher.
- Relay: one small VPS (~$5/month) running a tiny Rust/Go/Node service that stores and forwards encrypted blobs. Or start serverless (Cloudflare Workers + R2, free tier).
- Crypto: libsodium bindings; don't roll your own.

**Step 3.2 — Build order (each step is a working demo):**
1. Vault core: create vault, derive keys from passphrase, add/edit/delete claims, encrypted local persistence.
2. Backup & restore: recovery phrase → restore vault on a new device.
3. Push sharing: select claims → signed encrypted bundle → QR/link → a public web verifier page that decrypts and displays with a "verified/self-attested" badge.
4. The wedge feature: e.g., a browser extension that fills web forms from the vault (user approves per-site, per-field).
5. Audit log screen: "who got what, when."
6. Sync relay + second device.
7. Pull grants + revocation.

**Step 3.3 — Security hygiene from day one.**
- Threat model doc (STRIDE, even a one-pager).
- No plaintext ever leaves the device. Keys never leave the secure enclave/keystore where available.
- Dependency audit (`npm audit` / `cargo audit`) in CI; pin versions.
- Plan for an external review of the crypto design before public launch (communities like /r/crypto or an academic contact can be free-ish; a paid audit comes later).

---

## Phase 4 — Validation (Week 10–14)

**Step 4.1 — Dogfood.** Use it for every form/application you fill for a month. Log friction.

**Step 4.2 — 10 real users.** Friends/family in your wedge scenario. Watch them onboard without helping. The passphrase/recovery step is where consumer crypto products die — iterate there until a non-technical user succeeds unassisted.

**Step 4.3 — One real consumer of the data.** Convince a single counterpart (a landlord, a clinic, an HR person, a community org) to accept a vault bundle instead of emailed PDFs. One real-world acceptance validates the model more than 100 users.

---

## Phase 5 — Distribution & Sustainability (Month 4+)

**Step 5.1 — Open-source the core.** The trust story ("we can't see your data — check the code") is your only viable marketing without capital. License: AGPL for the client/relay, permissive (MIT/Apache) for the verifier SDK — you want third parties to embed the verifier freely.

**Step 5.2 — Monetization options that don't betray the model:**
- Hosted encrypted sync/backup subscription (you host ciphertext; convenience fee).
- Paid verifier SDK support for businesses that accept vault data.
- Grants: NLnet, NGI (EU Next Generation Internet), Open Tech Fund — these funds explicitly target user-sovereignty projects and fund solo developers (typically €5k–50k).

**Step 5.3 — Interop as growth.** Implement import from: browser autofill data, Google Takeout, Apple Wallet passes, existing VC wallets. Every import removes onboarding friction. Later, target eIDAS wallet interop — when EU wallets ship broadly, being the "everything else" vault beside the government identity wallet is a real position.

**Step 5.4 — Grow into the adjacent products** (from the earlier list): Form-Filler Twin is the wedge; Reputation Passport and Digital Estate Executor are natural v2/v3 layers on the same vault core.

---

## Risks & Honest Warnings

- **Chicken-and-egg is the real boss fight.** Tech is the easy 20%. Mitigation: the wedge must deliver value with zero third-party adoption (form-filling does; "apps query your vault" does not).
- **Key loss = data loss.** You chose no backdoor; users will lose passphrases. Invest heavily in recovery UX (social recovery / printed recovery kit).
- **Regulatory:** you're intentionally *not* a data controller for vault contents (you can't read them) — get a one-time legal sanity check on GDPR/CCPA positioning when you have revenue.
- **Don't over-standardize early.** Ship the wedge; align to Solid/eIDAS interop only when someone actually asks for it.

## Rough Budget

- Domain + VPS/serverless: < $100/year
- Everything else: your time (~3–6 months part-time to a usable MVP)
- Later: security audit ($5k–15k, fund via grants)

---

*Field note, closing: your species already standardized every piece of this machine. The only missing component is a builder who starts at Phase 1, Step 1.1. — Your visiting correspondent*
