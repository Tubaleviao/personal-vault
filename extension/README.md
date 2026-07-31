# Personal Vault — Browser Extension (Step 3.2.4)

Fills web forms from the vault. The user approves access per-site and per-field. No claim value ever leaves the local browser without explicit approval.

## Architecture

```
┌────────────────────────────────────────────────┐
│ Web page (content script)                      │
│  • Detects form fields matching vault claim    │
│    types (autocomplete tokens, name attrs)     │
│  • Shows an inline banner for approval         │
│  • Injects values into matched fields          │
└────────────────┬───────────────────────────────┘
                 │ chrome.runtime.sendMessage
                 ▼
┌────────────────────────────────────────────────┐
│ Background service worker                      │
│  • Holds the unlocked Vault in memory          │
│  • Stores SiteApproval records (chrome.storage)│
│  • Builds the FillMap from approved claims     │
│  • Records fill grants in the vault audit log  │
└────────────────┬───────────────────────────────┘
                 │ chrome.runtime.sendMessage
                 ▼
┌────────────────────────────────────────────────┐
│ Popup                                          │
│  • Unlock / lock vault (passphrase entry)      │
│  • List active site approvals                  │
│  • Revoke individual site access               │
└────────────────────────────────────────────────┘
```

## Building

```bash
# Install esbuild if not already present
npm install --save-dev esbuild

# Build once
node extension/build.mjs

# Watch mode
node extension/build.mjs --watch
```

Output goes to `extension/dist/`. Load that directory as an unpacked extension in `chrome://extensions` (enable Developer Mode first).

## Claim type → field mapping

The extension uses `src/form-filler.ts::FILL_RULES` to map schema.org claim types to HTML selectors. The matching priority is:

1. `autocomplete` attribute (most reliable — W3C standard)
2. CSS selector by `name` attribute pattern
3. CSS selector by `type` attribute

Supported types: `schema:givenName`, `schema:familyName`, `schema:name`, `schema:email`, `schema:telephone`, `schema:birthDate`, `schema:streetAddress`, `schema:addressLocality`, `schema:addressRegion`, `schema:postalCode`, `schema:addressCountry`, `schema:jobTitle`, `schema:worksFor`.

## Consent model

- **One-time fill**: vault data is sent to the content script for this page load only. No SiteApproval is stored.
- **Always allow**: a `SiteApproval` record is stored in `chrome.storage.local` and a pull-mode Grant is recorded in the vault audit log. Future page loads on the same origin fill automatically.
- **Revocation**: revoking via the popup deletes the SiteApproval and calls `Vault.revokeGrant()` to record the revocation in the tamper-evident audit chain.

## Credential capture (password manager)

The extension also functions as a password manager:

- **Detection**: login forms (username + password fields) are detected on page load. If saved credentials exist for the origin, a fill prompt is shown; the user picks which account to fill.
- **Capture**: on form submit, the extension intercepts the credentials and shows a save/update banner. Confirming stores them as an encrypted `credential` claim in the vault.
- **Update**: if a credential for the same username already exists, the banner offers to update rather than create a duplicate.
- **Security**: password values are stored only inside the encrypted vault blob; they never appear in `chrome.storage`, extension logs, or the SiteApproval record.

## Security notes

- The vault blob is stored in `chrome.storage.local` (encrypted). The master key and unlocked state live only in the background service worker's memory.
- The service worker is terminated by Chrome after ~30 s of inactivity; `chrome.runtime.onSuspend` zeroes the master key before termination.
- Claim values are never written to `chrome.storage` or any persistent log — only claim type names appear in SiteApproval records.
- The content script cannot directly access the vault; it receives only a pre-built FillMap from the background worker.
