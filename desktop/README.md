# Personal Vault — Desktop App

Tauri v2 desktop app for the personal data vault. The vault crypto library runs entirely in the WebView (Vite-bundled TypeScript); the Rust backend is a thin file I/O layer only.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 20+ | https://nodejs.org |
| Rust | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Tauri CLI | 2.x | `cargo install tauri-cli --version "^2"` |
| OS WebView | — | Linux: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev` |

On macOS and Windows the WebView is already installed. On Linux you need the webkit2gtk package above.

## Development

```bash
cd desktop
npm install
cargo tauri dev
```

This starts the Vite dev server on `localhost:5173` and opens the app window with hot-reload.

## Production build

```bash
cd desktop
npm install
cargo tauri build
```

Output lands in `src-tauri/target/release/bundle/`:

| Platform | Format | Location |
|---|---|---|
| Linux | `.deb`, `.AppImage` | `deb/`, `appimage/` |
| macOS | `.dmg`, `.app` | `dmg/`, `macos/` |
| Windows | `.msi`, `.exe` (NSIS) | `msi/`, `nsis/` |

## Vault file location

The encrypted vault blob is stored at the platform data directory:

| OS | Path |
|---|---|
| Linux | `~/.local/share/personal-vault/vault.json` |
| macOS | `~/Library/Application Support/personal-vault/vault.json` |
| Windows | `%APPDATA%\personal-vault\vault.json` |

The file is XChaCha20-Poly1305 encrypted — the Rust backend never touches plaintext.

## Architecture

```
desktop/
  src-tauri/          Rust backend (Tauri commands only)
    src/
      main.rs         App entry — registers Tauri commands
      commands.rs     read_vault_file / write_vault_file / vault_file_exists
    build.rs
    Cargo.toml
    tauri.conf.json

  src/                TypeScript frontend (Vite + React 18)
    main.tsx          React root
    App.tsx           Shell — sidebar nav + lock button
    tauriVault.ts     Thin invoke() bridge; screens never call @tauri-apps/api directly
    screens/
      Unlock.tsx      Create new vault or open existing; shows BIP-39 phrase on create
      Claims.tsx      List / add / edit / delete claims
      Audit.tsx       Full audit log with hash-chain integrity badge
      Sync.tsx        Relay URL config + manual sync trigger

  index.html
  vite.config.ts      @vault/* alias resolves ../src/ — vault library shared with extension
  tsconfig.json
  package.json
```

The `@vault/*` path alias means `import { Vault } from '@vault/vault'` resolves to `../src/vault.ts` — the same vault library used by the browser extension, with no duplication.

## Sync

The Sync screen uses the same Cloudflare Worker relay as the extension (`src/relay.ts`). To use it:

1. Deploy the relay worker (`src/relay.ts` / `relay/worker.ts`) to Cloudflare Workers.
2. Enter the worker URL in the Sync screen.
3. Re-unlock the vault with your 12-word recovery phrase — this loads the Ed25519 keypair used to authenticate relay requests.
4. Click **Sync now**.

The relay stores only the encrypted blob. It never sees plaintext.
