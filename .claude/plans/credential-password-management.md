# Plan: Credential / Password Management

## Goal

Store per-site credentials (username + password) inside the vault as a new claim type `credential:login`, with a dedicated browser extension flow for saving, updating, and filling them. Passwords get identical encryption protection to SSN/CPF/address data already in the vault.

## Design principles

- **Credentials are vault claims, not extension storage.** The `credential:login` claim value `{ origin, username, password }` is encrypted inside the vault blob — the extension never persists passwords outside the vault.
- **Separate code path from identity filling.** Credentials use exact-origin matching only. The existing `FILL_RULES` / `buildFillMap` / `FillMap` pipeline is for identity fields and is intentionally left untouched.
- **Password never travels until the user says so.** The fill banner shows only the username. The password is only sent in `CREDENTIAL_FILL_DATA` after the user clicks Fill.
- **Exact origin, always.** `window.location.origin === storedOrigin` — no substring, no subdomain wildcard. This kills the gnjoylatam.com.evil.com phishing vector.
- **Fill: ask before filling.** Banner on login form detection.
- **Save: always prompt.** Banner after form submission.
- **Multiple accounts per site are supported.** The fill banner lists all stored usernames for the origin; user picks one.

---

## Files changed

### 1. `src/vault.ts`

**Add `updateClaim(id, patch)`**

Currently only `addClaim` and `deleteClaim` exist. Credential updates (user changes password) need an in-place mutation that also appends an audit entry.

```ts
updateClaim(id: string, patch: Partial<Omit<Claim, 'id' | 'ownerId'>>): Claim
```

- Finds the claim, merges `patch`, writes back, appends `'claim-updated'` audit action.
- Add `'claim-updated'` to the `AuditAction` union.

---

### 2. `src/form-filler.ts`

**Add credential-specific types and helpers** (no changes to FILL_RULES or buildFillMap).

```ts
export interface CredentialValue {
  origin: string      // "https://gnjoylatam.com"
  username: string
  password: string
}

export interface CredentialEntry {
  claimId: string
  origin: string
  username: string
  // password is intentionally absent — never returned to content script in the list
}

/** Return all credential:login claims matching the exact origin. */
export function findCredentialsForOrigin(
  claims: Claim[],
  origin: string,
): CredentialEntry[]

/** Find one credential by claim ID and return the full value including password.
 *  Called only after user has clicked Fill. */
export function getCredentialById(
  claims: Claim[],
  claimId: string,
): CredentialValue | null
```

---

### 3. `extension/messages.ts`

Add new message types and update the union types.

**Content → Background**

```ts
// Sent when a login form (has password field) is detected on load
MsgCredentialFormDetected { type: 'CREDENTIAL_FORM_DETECTED'; origin: string }

// Sent after a form with a password field is submitted, before navigation
MsgCredentialSubmit {
  type: 'CREDENTIAL_SUBMIT'
  origin: string
  username: string
  password: string
}

// User confirmed saving / updating in the banner
MsgCredentialSaveConfirmed {
  type: 'CREDENTIAL_SAVE_CONFIRMED'
  origin: string
  username: string
  password: string
  existingClaimId?: string   // present = update, absent = new
}

MsgCredentialSaveDenied  { type: 'CREDENTIAL_SAVE_DENIED' }

// User picked an account from the fill banner
MsgCredentialFillConfirmed { type: 'CREDENTIAL_FILL_CONFIRMED'; claimId: string }
```

**Background → Content**

```ts
// Prompt to fill — carries usernames only, no passwords
MsgCredentialFillPrompt {
  type: 'CREDENTIAL_FILL_PROMPT'
  credentials: CredentialEntry[]
}

// Actual fill data — only sent after user confirms
MsgCredentialFillData {
  type: 'CREDENTIAL_FILL_DATA'
  username: string
  password: string
}

// Prompt to save a new password
MsgCredentialSavePrompt {
  type: 'CREDENTIAL_SAVE_PROMPT'
  username: string
  existingClaimId?: string   // present = "Update saved password?", absent = "Save password?"
}
```

Update `ContentToBackground` and `BackgroundToContent` union types to include these.

---

### 4. `extension/content.ts`

**Add `detectLoginForm()`** — separate from `detectFields()`.

Looks for any `input[type="password"]` in the document. If found, also searches for the most likely adjacent username field (tries `input[type="email"]`, then `input[autocomplete="username"]`, then `input[name*="user"]`, then the nearest preceding text input). Returns `{ passwordEl, usernameEl | null }` or `null` if no password field found.

**On page load** — after existing `detectFields()` check:

```
if detectLoginForm():
  send CREDENTIAL_FORM_DETECTED { origin }
  if response is CREDENTIAL_FILL_PROMPT:
    showCredentialFillBanner(credentials)
```

**Form submit interception:**

```
document.addEventListener('submit', handler, { capture: true })
```

Inside the handler: if the submitted form contains the detected password element, capture `username` and `password` values, then send `CREDENTIAL_SUBMIT`. If response is `CREDENTIAL_SAVE_PROMPT`, call `showCredentialSaveBanner()`.

**New UI functions:**

- `showCredentialFillBanner(credentials)` — lists username(s), "Fill" button per account, "×" dismiss. If only one credential, shows "Fill saved credentials for gnjoylatam.com? — [username@email.com]". If multiple, shows a small list with one Fill button each.
- `showCredentialSaveBanner(username, existingClaimId?)` — "Save password for gnjoylatam.com?" or "Update saved password?", Save / Not now buttons.
- `applyCredentialFill(username, password)` — injects into the detected `usernameEl` and `passwordEl`, dispatches `input` + `change` events.

**Handle `CREDENTIAL_FILL_CONFIRMED` response (`CREDENTIAL_FILL_DATA`):**

After user clicks Fill and background responds with the actual credentials, call `applyCredentialFill`.

---

### 5. `extension/background.ts`

Add three new cases inside `handleMessage()`:

**`CREDENTIAL_FORM_DETECTED`**

```
if (!session) → VAULT_LOCKED
claims = session.vault.listClaims()
entries = findCredentialsForOrigin(claims, message.origin)
if entries.length === 0 → null (no-op)
else → CREDENTIAL_FILL_PROMPT { credentials: entries }
```

**`CREDENTIAL_FILL_CONFIRMED`**

```
if (!session) → VAULT_LOCKED
cred = getCredentialById(session.vault.listClaims(), message.claimId)
if !cred → null
→ CREDENTIAL_FILL_DATA { username: cred.username, password: cred.password }
```

**`CREDENTIAL_SUBMIT`**

```
if (!session) → VAULT_LOCKED
claims = session.vault.listClaims()
existing = findCredentialsForOrigin(claims, message.origin)
  .find(e => e.username === message.username)

if existing:
  existingClaim = session.vault.getClaim(existing.claimId)
  if existingClaim.value.password === message.password → null (no change)
  else → CREDENTIAL_SAVE_PROMPT { username, existingClaimId: existing.claimId }
else:
  → CREDENTIAL_SAVE_PROMPT { username }
```

**`CREDENTIAL_SAVE_CONFIRMED`**

```
if (!session) → VAULT_LOCKED
value: CredentialValue = { origin, username, password }

if existingClaimId:
  session.vault.updateClaim(existingClaimId, { value })
else:
  session.vault.addClaim({
    type: 'credential:login',
    value,
    source: 'self-attested',
    verification: 'none',
    expiresAt: null,
    issuerDid: null,
  })

blob = await session.vault.seal()
await chrome.storage.local.set({ vault: blob })
→ null
```

Note: `seal()` (not `lock()`) is called so the vault stays unlocked in memory but the encrypted blob is persisted immediately.

---

## What is NOT changing

- `FILL_RULES`, `buildFillMap`, `FillMap`, `filterFillMapForSite` — untouched.
- `SiteApproval` / grant system — credentials are not gated by the site approval flow. They have their own per-interaction prompt.
- `fabric.ts` / `src/generated/` — `credential:login` is added only to `form-filler.ts` as a string constant, not to the newel schema (that schema models identity claims; credential management is out of its scope).

---

## Sequence diagram

### Fill flow (returning visit)

```
page loads
  └─ content: detectLoginForm() → found
  └─ content → bg: CREDENTIAL_FORM_DETECTED { origin: "https://gnjoylatam.com" }
  └─ bg: findCredentialsForOrigin → [{ claimId, username: "gamer@gmail.com" }]
  └─ bg → content: CREDENTIAL_FILL_PROMPT { credentials }
  └─ content: showCredentialFillBanner("gamer@gmail.com")
  └─ user clicks Fill
  └─ content → bg: CREDENTIAL_FILL_CONFIRMED { claimId }
  └─ bg: getCredentialById → { username, password }
  └─ bg → content: CREDENTIAL_FILL_DATA { username, password }
  └─ content: applyCredentialFill → fields filled
```

### Save flow (first login / password change)

```
user submits login form
  └─ content: submit handler captures username + password
  └─ content → bg: CREDENTIAL_SUBMIT { origin, username, password }
  └─ bg: no existing credential for this origin+username
  └─ bg → content: CREDENTIAL_SAVE_PROMPT { username }
  └─ content: showCredentialSaveBanner("Save password for gnjoylatam.com?")
  └─ user clicks Save
  └─ content → bg: CREDENTIAL_SAVE_CONFIRMED { origin, username, password }
  └─ bg: vault.addClaim({ type: "credential:login", value: {...} })
  └─ bg: vault.seal() → persist to chrome.storage.local
```

---

## Implementation order

1. `src/vault.ts` — add `updateClaim()` + `'claim-updated'` audit action  
2. `src/form-filler.ts` — add `CredentialValue`, `CredentialEntry`, `findCredentialsForOrigin`, `getCredentialById`  
3. `extension/messages.ts` — add all new message types + update unions  
4. `extension/background.ts` — add three new message handlers  
5. `extension/content.ts` — add `detectLoginForm`, submit interceptor, credential banners, `applyCredentialFill`  
