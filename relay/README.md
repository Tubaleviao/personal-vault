# relay/ — removed

The Cloudflare Worker + KV sync relay (`relay/worker.ts`, `src/relay.ts`) was removed in Phase 3.5.2.

**Why:** the relay needed a deployed server, an account and a URL configured in every client, and only worked online. Vault sync now writes the already-encrypted vault file to a user-chosen folder (iCloud Drive, Dropbox, Google Drive, or a flash drive) via `src/storage.ts`. The provider only ever sees opaque ciphertext, and the vault works fully offline.

This directory is kept only as a tombstone. See `ROADMAP.md`, Phase 3.5.2.
