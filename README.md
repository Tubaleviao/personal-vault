# personal-vault

Own your data. Control who reads it. Revoke access at any time.

**personal-vault** is an encrypted, user-owned data store for identity attributes, documents, and credentials. Applications never get a permanent copy — they get scoped, revocable, auditable access through a consent layer. The user is the root of trust.

---

## Why personal-vault?

| Feature | 1Password | Bitwarden | Apple Keychain | WebAuthn / Passkeys | Solid | **personal-vault** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Encrypted local storage | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Open source | ❌ | ✅ | ❌ | — | ✅ | ✅ |
| Browser auto-fill | ✅ | ✅ | ✅ | ✅ | ❌ | 🔜 |
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

---

## Installation

### Prerequisites

- Node.js 20 or later
- npm

### Clone and install

```bash
git clone https://github.com/your-username/personal-vault.git
cd personal-vault
npm install
```

No build step is needed for day-to-day use — source files are run directly with `tsx`.

---

## Usage

All modules are imported directly from `src/`. Use the following pattern to run any script:

```bash
node -r ./node_modules/tsx/dist/cjs/index.cjs <your-script.ts>
```

### Create and unlock a vault

```typescript
import { Vault } from './src/vault'

// Create a new vault
const vault = await Vault.create('my-strong-passphrase')

// Open an existing vault
const blob = fs.readFileSync('vault.bin')
const vault = await Vault.open(blob, 'my-strong-passphrase')

// Lock the vault — zeroes the master key from memory
vault.lock()
```

### Store and read claims

```typescript
// Add a claim
await vault.addClaim({
  type: 'email',
  value: 'alice@example.com',
  source: 'self_attested',
})

// Read all claims
const claims = await vault.getClaims()

// Delete a claim
await vault.deleteClaim(claimId)
```

### Generate a DID identity

```typescript
import { generateDID } from './src/did'

const { did, privateKey, publicKey } = await generateDID()
// did:key:z6Mk...
```

### Create and validate a grant

```typescript
import { createGrant, validateGrant } from './src/consent'

// Grant an app access to specific claims
const grant = await createGrant({
  ownerDID: did,
  privateKey,
  appId: 'com.example.app',
  claimTypes: ['email', 'date_of_birth'],
  expiresIn: 60 * 60 * 24 * 30, // 30 days in seconds
})

// Validate the grant before serving data
const result = await validateGrant(grant, vault)
```

### Revoke a grant

```typescript
import { revokeGrant } from './src/consent'

await revokeGrant(vault, grantId)
// Any future validateGrant() call for this grant now fails
```

### Share an encrypted bundle

```typescript
import { createBundle, verifyBundle } from './src/sharing'

// Sender: create a signed encrypted bundle
const { token } = await createBundle({
  claims,
  ownerDID: did,
  privateKey,
  recipientPublicKey,
  expiresIn: 3600,
})

// Recipient: verify and decrypt
const result = await verifyBundle(token, senderDID, recipientPrivateKey)
```

### Generate a recovery phrase

```typescript
import { generateMnemonicBundle } from './src/recovery'

const { mnemonic, did, privateKey } = await generateMnemonicBundle()
// Store mnemonic offline — it is never saved to disk by this library
```

### Inspect the audit log

```typescript
import { verifyChain, formatAuditLog } from './src/audit'

const entries = await vault.getAuditLog()

// Detect tampering
const { valid, firstBadIndex } = verifyChain(entries)

// Human-readable output
console.log(formatAuditLog(entries))
```

### Schema commands

After editing `src/fabric.ts`, regenerate all artifacts:

```bash
npm run validate      # check schema for errors — no files written
npm run inspect       # print the full IR as JSON
npm run generate      # regenerate all artifacts in src/generated/
npm run diff          # show what would change without writing files
npm run check-drift   # warn if any generated file was manually edited
```

`src/generated/` is committed. Always run `npm run generate` after changing `fabric.ts` and commit the updated generated files in the same commit.

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
| Browser extension (auto-fill with per-site approval) | 🔜 Planned |
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
