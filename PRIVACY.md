# Privacy Policy — Personal Vault Form Filler

_Last updated: 2026-10-11_

Personal Vault Form Filler ("the extension") fills web forms using data from your personal-vault, an encrypted data store that lives on your own device.

## Data we collect

**None.** The developer does not collect, receive, store, sell or share any of your data. The extension has no servers, analytics, telemetry, advertising or tracking, and makes no network requests of its own.

## How the extension handles your data

- **Vault data** (names, dates, addresses and other claims) stays on your device. The extension talks only to the personal-vault desktop app on your computer, through Chrome's native messaging channel.
- **Form filling** happens only after you approve it. A claim value is written into a page only after your approval (you choose which claim types to fill, once or always for that site), and that page can read it as it would anything you type.
- **Page content**: the content script reads form-field attributes (such as `autocomplete` and `name`) on pages you visit to detect which fields can be filled. This information is processed locally and never transmitted or stored.
- **Stored locally**: your per-site approvals, and (when you use a browser-local vault rather than the desktop app's vault files) your passphrase-encrypted vault blob, are saved in `chrome.storage.local` in your browser. Your unlocked vault is kept in memory only. You can revoke them any time from the extension popup. Uninstalling the extension removes them.

## Permissions

- `storage` — remember your per-site approvals.
- `activeTab` — act on the page you are currently using.
- `nativeMessaging` — communicate with the personal-vault desktop app.
- Access to all sites (`<all_urls>` content script) — detect fillable form fields on any site you choose to fill.

## Third parties

No data is sold, transferred or disclosed to third parties. The extension does not use or transfer user data for purposes unrelated to its single purpose (filling forms from your vault), or for creditworthiness or lending.

## Changes

Changes to this policy will be published in this file in the project repository.

## Contact

Open an issue at https://github.com/Tubaleviao/personal-vault/issues.
