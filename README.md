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
| Cross-device sync | ✅ | ✅ | ✅ | ✅ | ✅ | 🔜 |
| BIP-39 recovery phrase | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Self-sovereign DID identity | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| W3C Verifiable Credentials | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Granular per-claim consent | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Revocable access grants | ❌ | ❌ | ❌ | ❌ | Partial | ✅ |
| Tamper-evident audit log | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Vendor holds your data | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |

> 🔜 = planned, not yet implemented.

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
| Cross-device sync relay | 🔜 Planned |
| Mobile apps (iOS, Android) | 🔜 Planned |
| Full SD-JWT spec conformance | 🔜 Planned |
| VC proof verification in `importVC()` | 🔜 Planned |
| STRIDE threat model + external crypto review | 🔜 Planned |

---

## Crypto stack

| Purpose | Primitive |
|---|---|
| Symmetric encryption | XChaCha20-Poly1305 (libsodium) |
| Key derivation | scrypt N=16384, r=8, p=1 (Node built-in) |
| Signing / DID keys | Ed25519 (libsodium) |
| Hashing | SHA-256 (Node built-in) |
| Recovery phrase | BIP-39 128-bit entropy (12 words) |

---

## License

MIT
