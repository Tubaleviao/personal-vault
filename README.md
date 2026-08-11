# personal-vault

Own your data. Control who reads it. Revoke access at any time.

**personal-vault** is an encrypted, user-owned data store for identity attributes, documents, and credentials. Applications never get a permanent copy — they get scoped, revocable, auditable access through a consent layer. The user is the root of trust.

---

## Why personal-vault?

| Feature | 1Password | Bitwarden | Apple Keychain | WebAuthn / Passkeys | Solid | **personal-vault** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Encrypted local storage | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Open source | ❌ | ✅ | ❌ | — | ✅ | ✅ |
| Browser auto-fill | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Cross-device sync | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| BIP-39 recovery phrase | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Self-sovereign DID identity | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| W3C Verifiable Credentials | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Granular per-claim consent | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Revocable access grants | ❌ | ❌ | ❌ | ❌ | Partial | ✅ |
| Tamper-evident audit log | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Vendor holds your data | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |

The key difference: password managers store and replay credentials on your behalf. personal-vault goes further — it lets you grant any application access to a specific piece of your identity (e.g. your date of birth, not your entire profile), log every read, and revoke that access at any time.

---

## What you get today

**Encrypted vault**
- All data stored in a single XChaCha20-Poly1305 encrypted blob on your machine
- Master key is derived from your passphrase with scrypt and exists in memory only while unlocked — locking the vault zeroes the key
- Wrong passphrase is detected before any decryption attempt

**Claims (identity attributes)**
- Store any personal attribute: name, email, address, date of birth, documents, etc.
- Each claim has a type, value, source (`self_attested`, `verified`, `imported`), and optional expiry

**Consent & grants**
- Grant an application access to specific claims only — not your entire vault
- Grants are signed with your Ed25519 private key and validated on every read
- Revoke any grant at any time — future reads return nothing

**Tamper-evident audit log**
- Every vault operation (create, read, grant, revoke) is appended to a hash chain
- `verifyChain()` detects any modification or broken linkage after the fact
- You can inspect the full log at any time

**Self-sovereign identity**
- Generate a `did:key` decentralized identifier — no registry, no third party
- Sign and verify claims with your DID
- Import W3C Verifiable Credentials from external issuers

**Secure sharing**
- Create a signed, encrypted bundle of claims to share with someone
- The recipient can verify the bundle came from you and was not tampered with
- Bundles carry source badges: `self_attested`, `verified`, `imported`

**Recovery**
- 12-word BIP-39 mnemonic phrase — lose your device, restore your vault anywhere
- Only a SHA-256 commitment to the phrase is stored in the vault header — the phrase itself is never persisted

**Browser extension (Chrome / Chromium)**
- Detects form fields on any webpage and matches them against vault claim types
- Shows an inline approval banner before filling anything — no data leaves the vault without an explicit user action
- Per-site, per-field approval: choose exactly which claims a site may receive
- "Fill once" or "Always allow" — persistent approvals are stored in extension local storage and backed by a vault grant in the audit log
- Revoke any site's access from the popup at any time; revoked sites receive `APPROVAL_REVOKED` on the next visit instead of being re-prompted
- The vault is unlocked in the extension popup with your passphrase; locking zeroes the master key from the service worker's memory
- **Credential capture**: detects login form submissions, prompts to save username/password as encrypted vault claims, and fills saved credentials on return visits — a full password-manager flow without any third-party sync

**Desktop app (Tauri — Windows / macOS / Linux)**
- Native app with the full vault UI: unlock/create, claims list, audit log viewer, and sync panel
- The Rust backend is a thin file I/O layer only — all crypto runs in the WebView as the same TypeScript library used by the extension
- Vault file stored at the OS-standard data directory; the desktop app owns the file across browser profile wipes
- Native messaging host auto-installed on first launch — the browser extension delegates vault reads to the desktop app over Chrome's Native Messaging API

**Cross-device sync**
- Sync by pointing the app at a shared folder — iCloud Drive, Dropbox, Google Drive, or a flash drive
- The vault file is already fully encrypted; the cloud provider sees only opaque bytes
- Works fully offline: the OS keeps a local copy and queues uploads when connectivity returns
- Flash drive support for air-gapped setups; clear error messages when the drive is not attached

---

## Installation

Node.js 20 or later required.

```bash
npm install personal-vault
```

---

## Usage

Everything is exported from the top-level package:

```typescript
import { Vault, generateDID, createGrant, validateGrant, /* ... */ } from 'personal-vault'
```

### Create and unlock a vault

```typescript
import { Vault } from 'personal-vault'
import fs from 'fs'

// Create a new vault
const vault = await Vault.create('my-strong-passphrase')

// Persist the encrypted blob
fs.writeFileSync('vault.bin', vault.seal())

// Open an existing vault
const blob = fs.readFileSync('vault.bin')
const vault2 = await Vault.open(blob, 'my-strong-passphrase')

// Lock the vault — zeroes the master key from memory
vault2.lock()
```

### Store and read claims

```typescript
// Add a claim
await vault.addClaim({
  type: 'email',
  value: 'alice@example.com',
  source: 'self-attested',
})

// Read all claims
const claims = await vault.getClaims()

// Delete a claim
await vault.deleteClaim(claimId)
```

### Generate a DID identity

```typescript
import { generateDID } from 'personal-vault'

const { did, privateKey, publicKey } = await generateDID()
// did:key:z6Mk...
```

### Create and validate a grant

```typescript
import { createGrant, validateGrant } from 'personal-vault'

// Grant an app access to specific claims
const { grant } = await createGrant({
  ownerDID: did,
  privateKey,
  appId: 'com.example.app',
  claimTypes: ['email', 'date_of_birth'],
  expiresIn: 60 * 60 * 24 * 30, // 30 days in seconds
})

// Validate the grant before serving data
const result = await validateGrant(grant, did)
```

### Revoke a grant

```typescript
import { revokeGrant } from 'personal-vault'

revokeGrant(vault, grantId)
// Any future validateGrant() call for this grant now returns { valid: false }
```

### Share an encrypted bundle

```typescript
import { createBundle, verifyBundle } from 'personal-vault'

// Sender: create a signed encrypted bundle
const { bundle } = await createBundle({
  claims,
  ownerDID: did,
  privateKey,
  recipientPublicKey,
  expiresIn: 3600,
})

// Recipient: verify and decrypt
const result = await verifyBundle(bundle, did, recipientPrivateKey)
```

### Generate a recovery phrase

```typescript
import { generateMnemonicBundle } from 'personal-vault'

const { mnemonic, did, privateKey } = await generateMnemonicBundle()
// Store mnemonic offline — it is never saved to disk by this library
```

### Inspect the audit log

```typescript
import { verifyChain, formatAuditLog } from 'personal-vault'

const entries = vault.getAuditLog()

// Detect tampering
const { valid, firstBadIndex } = verifyChain(entries)

// Human-readable output
console.log(formatAuditLog(entries))
```

### Browser extension

The package ships `form-filler` utilities used by the Chrome extension. To build and load the extension from source:

```bash
git clone https://github.com/your-username/personal-vault.git
cd personal-vault
npm install
# Build once
node extension/build.mjs

# Watch mode (rebuilds on file change)
node extension/build.mjs --watch
```

Output goes to `extension/dist/`. In Chrome, open `chrome://extensions`, enable **Developer Mode**, click **Load unpacked**, and select the `extension/dist/` directory.

Once loaded:
1. Click the extension icon and enter your vault passphrase to unlock.
2. Navigate to any page with a form — an approval banner appears listing matched claim types.
3. Choose **Fill once** or **Always allow**. The vault fills the matching fields.
4. Manage or revoke site approvals from the popup at any time.

---

## Roadmap

| Feature | Status |
|---|---|
| Encrypted vault core (create, open, lock, claims CRUD) | ✅ Done |
| BIP-39 recovery phrase | ✅ Done |
| Signed encrypted sharing bundles | ✅ Done |
| DID identity layer (`did:key`) | ✅ Done |
| Tamper-evident audit log | ✅ Done |
| Consent & grant layer (create, validate, revoke) | ✅ Done |
| Browser extension (auto-fill with per-site approval) | ✅ Done |
| Browser extension — credential capture (password manager) | ✅ Done |
| Cross-device sync via cloud storage / flash drive | 🔜 Next |
| Desktop app (Tauri — Windows / macOS / Linux) | ✅ Done |
| Full SD-JWT spec conformance (`issueSDJWT` / `verifySDJWT`) | ✅ Done |
| VC proof verification in `importVC()` (Ed25519Signature2020) | ✅ Done |
| scrypt N upgrade to 2^16 for new vaults | ✅ Done |
| STRIDE threat model document | ✅ Done |
| Cloud storage sync (replaces relay) | 🔜 Next |
| Vault discovery & multi-vault picker | 🔜 Planned |
| Chrome Web Store publishing | 🔜 Planned |
| External cryptography review | 🔜 Planned |
| Mobile apps (iOS, Android) | 🔜 Planned |

See [ROADMAP.md](ROADMAP.md) for the full build plan with implementation detail.

---

## Crypto stack

| Purpose | Primitive |
|---|---|
| Symmetric encryption | XChaCha20-Poly1305 (libsodium) |
| Key derivation | scrypt N=65536 (2^16), r=8, p=1 (Node built-in) |
| Signing / DID keys | Ed25519 (libsodium) |
| Hashing | SHA-256 (Node built-in) |
| Recovery phrase | BIP-39 128-bit entropy (12 words) |

---

## Security

### Current posture

**Vault encryption is strong against classical attacks.**
The vault blob is encrypted with XChaCha20-Poly1305 using a 256-bit key derived from your passphrase via scrypt. An attacker who steals the encrypted file gets nothing useful without the passphrase — there is no server-side key to subpoena, no vendor who holds a copy.

**The master key never touches disk.**
It is derived on unlock, lives only in process memory, and is zeroed when you lock the vault. A memory dump after locking yields nothing.

**Wrong passphrase is rejected before decryption.**
The vault header stores a `keyVerificationHash`. If it does not match, the ciphertext is never touched — there is no oracle for partial decryption.

**Grants and audit entries are cryptographically bound.**
Every grant is signed with your Ed25519 private key. `validateGrant()` re-verifies the signature on every read — a tampered or forged grant is rejected. The audit log is a hash chain: `verifyChain()` detects any modification or gap.

**No plaintext leaves the vault.**
`Claim.value` is always encrypted inside the vault blob. The browser extension sends field values to the page only after an explicit user approval action.

---

### Quantum computing considerations

A sufficiently large quantum computer would affect different parts of the stack differently.

**Safe (or safe enough):**
- XChaCha20-Poly1305 — symmetric encryption. Grover's algorithm halves effective key length, leaving ~128-bit quantum security. This is considered sufficient.
- scrypt + SHA-256 — same reasoning. The derived key and hashes retain ~128-bit quantum security.

**Vulnerable:**
- Ed25519 — asymmetric/elliptic-curve cryptography. Shor's algorithm can break it efficiently on a large enough quantum computer. Ed25519 is used for DID identity keys, grant signatures, and sharing bundle signatures.

**The "harvest now, decrypt later" threat:**
An adversary can copy your encrypted vault blob today and wait for quantum hardware to mature. The vault blob itself remains protected (symmetric crypto), but Ed25519-signed artifacts — grants, sharing bundles, DID-linked claims — could be broken or forged retroactively.

*No quantum computer today can break 256-bit ECC. This is a future risk, not a present one. It becomes relevant if your data needs to stay confidential for 10+ years.*

---

### Planned security improvements

| Improvement | Status | Notes |
|---|---|---|
| Upgrade scrypt N to 2^16 | ✅ Done | New vaults use N=65536; old vaults opened at their stored N and re-sealed at 2^16 on next write |
| STRIDE threat model document | ✅ Done | `THREAT_MODEL.md` covers all trust boundaries, attacker capabilities, and mitigations |
| SD-JWT full spec conformance | ✅ Done | `issueSDJWT()` / `verifySDJWT()` implement the compact `~`-separated format with per-claim salt disclosures and SHA-256 digests |
| VC proof verification in `importVC()` | ✅ Done | `verifyVCProof()` checks Ed25519Signature2020 proofs; claims get `verification: 'verified'` only on a valid cryptographic check |
| Replace Ed25519 with a post-quantum signature scheme | Planned | ML-DSA (FIPS 204 / CRYSTALS-Dilithium) is the recommended target — lattice-based, NIST-standardized, drop-in replacement for signing |
| Hybrid signatures during migration | Planned | Sign with both Ed25519 + ML-DSA; both must verify. Protects against classical and quantum attackers simultaneously during the transition period |
| External cryptography review | Planned | Independent audit of the crypto primitives and their usage before any production deployment |

---

## License

MIT
