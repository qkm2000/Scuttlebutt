#!/bin/bash
# Install Scuttlebutt into your Obsidian vault.
# Usage: bash install.sh [path/to/vault]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="scuttlebutt"

if [ ! -f "$SCRIPT_DIR/main.js" ]; then
  echo "main.js not found — run 'npm run build' first."
  exit 1
fi

if [ -n "$1" ]; then
  VAULT_DIR="$1"
else
  read -r -p "Path to your Obsidian vault: " VAULT_DIR
fi

# Expand a leading ~ but leave absolute paths untouched.
case "$VAULT_DIR" in
  "~"*) VAULT_DIR="${HOME}${VAULT_DIR#\~}" ;;
esac

if [ ! -d "$VAULT_DIR" ]; then
  echo "Directory not found: $VAULT_DIR"
  exit 1
fi

PLUGIN_DIR="$VAULT_DIR/.obsidian/plugins/$PLUGIN_NAME"
mkdir -p "$PLUGIN_DIR"

cp "$SCRIPT_DIR/manifest.json" "$PLUGIN_DIR/"
cp "$SCRIPT_DIR/main.js" "$PLUGIN_DIR/"
cp "$SCRIPT_DIR/styles.css" "$PLUGIN_DIR/"

echo "Installed Scuttlebutt to: $PLUGIN_DIR"
echo "Enable it in Obsidian: Settings → Community plugins → turn on 'Scuttlebutt'"
