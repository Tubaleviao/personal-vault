#!/usr/bin/env bash
# Install the Personal Vault native messaging host.
#
# Usage:
#   ./native-host/install.sh [--extension-id EXTENSION_ID] [--binary PATH]
#
# The script:
#   1. Copies (or symlinks) the native host binary to /usr/local/bin/ (or ~/.local/bin/ if no sudo).
#   2. Writes the host manifest to the Chrome / Chromium native-messaging config directory.
#   3. Updates the extension ID in the manifest.
#
# Supported platforms: Linux, macOS.
# Windows: use install.ps1 instead (registers the manifest path in the registry).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_TEMPLATE="$SCRIPT_DIR/com.personal_vault.json"
HOST_NAME="com.personal_vault"
BINARY_NAME="personal-vault-native-host"

# ── Parse args ────────────────────────────────────────────────────────────────

EXTENSION_ID=""
BINARY_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id) EXTENSION_ID="$2"; shift 2 ;;
    --binary)       BINARY_PATH="$2";  shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Locate the compiled binary ────────────────────────────────────────────────

if [[ -z "$BINARY_PATH" ]]; then
  # Look in the Cargo release / debug output directories for the standalone crate
  RELEASE_BIN="$SCRIPT_DIR/target/release/$BINARY_NAME"
  DEBUG_BIN="$SCRIPT_DIR/target/debug/$BINARY_NAME"

  if [[ -f "$RELEASE_BIN" ]]; then
    BINARY_PATH="$RELEASE_BIN"
  elif [[ -f "$DEBUG_BIN" ]]; then
    BINARY_PATH="$DEBUG_BIN"
    echo "Warning: using debug build. Run 'cargo build --release' in native-host/ for production."
  else
    echo "Error: compiled binary not found." >&2
    echo "Build it first:" >&2
    echo "  cd native-host && cargo build --release" >&2
    exit 1
  fi
fi

BINARY_PATH="$(realpath "$BINARY_PATH")"
echo "Using binary: $BINARY_PATH"

# ── Install binary ────────────────────────────────────────────────────────────

if command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
  INSTALL_DIR="/usr/local/bin"
  INSTALLED_BIN="$INSTALL_DIR/$BINARY_NAME"
  sudo install -m 755 "$BINARY_PATH" "$INSTALLED_BIN"
  echo "Installed to $INSTALLED_BIN (system-wide)"
else
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
  INSTALLED_BIN="$INSTALL_DIR/$BINARY_NAME"
  install -m 755 "$BINARY_PATH" "$INSTALLED_BIN"
  echo "Installed to $INSTALLED_BIN (user-local)"
fi

# ── Chrome native-messaging manifest directory ────────────────────────────────

OS="$(uname -s)"

case "$OS" in
  Linux)
    SYSTEM_MANIFEST_DIR="/etc/opt/chrome/native-messaging-hosts"
    USER_MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    CHROMIUM_USER_DIR="$HOME/.config/chromium/NativeMessagingHosts"
    ;;
  Darwin)
    SYSTEM_MANIFEST_DIR="/Library/Google/Chrome/NativeMessagingHosts"
    USER_MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    CHROMIUM_USER_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported OS: $OS. Use install.ps1 on Windows." >&2
    exit 1
    ;;
esac

mkdir -p "$USER_MANIFEST_DIR"
MANIFEST_DEST="$USER_MANIFEST_DIR/$HOST_NAME.json"

# ── Write manifest with correct binary path and extension ID ──────────────────

if [[ -z "$EXTENSION_ID" ]]; then
  echo ""
  echo "No --extension-id supplied."
  echo "To find your extension ID: open chrome://extensions, enable Developer Mode,"
  echo "and note the ID shown under 'Personal Vault Form Filler'."
  echo ""
  echo "You can re-run this script with --extension-id <ID> to update it."
  echo "For now, writing manifest with placeholder ID (extension will not connect)."
  EXTENSION_ID="EXTENSION_ID_PLACEHOLDER"
fi

cat > "$MANIFEST_DEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Personal Vault native messaging host — vault file I/O bridge",
  "path": "$INSTALLED_BIN",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Manifest written to $MANIFEST_DEST"

# Also install for Chromium if present
if [[ -d "$(dirname "$CHROMIUM_USER_DIR")" ]]; then
  mkdir -p "$CHROMIUM_USER_DIR"
  cp "$MANIFEST_DEST" "$CHROMIUM_USER_DIR/$HOST_NAME.json"
  echo "Also installed for Chromium: $CHROMIUM_USER_DIR/$HOST_NAME.json"
fi

echo ""
echo "Done. Reload your Chrome extension (chrome://extensions → reload) for the change to take effect."
echo "The extension will now prefer the desktop app for vault file I/O when the desktop app is running."
