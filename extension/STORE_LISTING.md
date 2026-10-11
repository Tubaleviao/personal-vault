# Chrome Web Store listing (draft)

**Name:** Personal Vault Form Filler
**Category:** Productivity
**Single purpose:** Fill web forms with data from the user's local personal-vault, with per-site, per-field user approval.

**Summary (<=132 chars):** Fill web forms from your personal vault. You approve per-site, per-field. No data is shared without your consent.

**Description:**
Personal Vault Form Filler connects your browser to your personal-vault desktop app. When a page has a form your vault can fill, you get a banner and choose exactly which fields to fill, on which site. Nothing is filled without your approval, and you can revoke any site at any time. Your data stays on your device: the extension has no servers, no analytics and no network requests. Requires the personal-vault desktop app.

**Privacy policy URL:** https://github.com/Tubaleviao/personal-vault/blob/main/PRIVACY.md
(valid once this branch is merged to main)

**Permission justifications (Privacy practices tab):**
- storage: saves per-site approvals locally.
- activeTab: acts on the page the user is filling.
- nativeMessaging: talks to the local personal-vault desktop app.
- Host permission / content script on all URLs: detects fillable form fields on any site the user chooses to fill; field attributes are processed locally and never sent anywhere.
- Remote code: No.

**Data usage disclosure:** collects nothing; check the three certifications (no sale, no unrelated use, no creditworthiness use). Declare "Personally identifiable information" and "Website content" as handled locally only if the form requires listing them.
