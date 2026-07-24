#!/usr/bin/env bash
# Build the native messaging host binary and stage it for Tauri bundling.
#
# Run this once before `npm run tauri build` (or `npm run tauri dev` on first setup):
#   cd desktop && ./build-native-host.sh
#
# The binary and manifest are copied to src-tauri/resources/ where tauri.conf.json
# picks them up as bundle resources.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_HOST_DIR="$REPO_ROOT/native-host"
RESOURCES_DIR="$REPO_ROOT/desktop/src-tauri/resources"
BINARY_NAME="personal-vault-native-host"
MANIFEST_NAME="com.personal_vault.json"

echo "Building native host..."
(cd "$NATIVE_HOST_DIR" && cargo build --release)

echo "Staging resources..."
mkdir -p "$RESOURCES_DIR"
cp "$NATIVE_HOST_DIR/target/release/$BINARY_NAME" "$RESOURCES_DIR/$BINARY_NAME"
cp "$NATIVE_HOST_DIR/$MANIFEST_NAME" "$RESOURCES_DIR/$MANIFEST_NAME"

echo "Done. Resources staged at $RESOURCES_DIR"
