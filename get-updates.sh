#!/usr/bin/env bash
# get-updates.sh -- Pull the latest OTForge changes and rebuild.
#
# For routine updates all you need is:
#   git pull && npm run dev
#
# This script is only needed when new npm packages were added to package.json.
# Running it unnecessarily causes npm to rewrite package-lock.json, which
# breaks future git pulls.
#
# Usage: bash get-updates.sh
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Step 1: Pull new code ────────────────────────────────────────────────────
echo "[otforge] Pulling latest changes..."
CHANGED=$(git pull --no-rebase 2>&1)
echo "$CHANGED"

# ── Step 2: Reinstall packages only if package-lock.json changed ─────────────
# npm ci would delete node_modules entirely (including the Electron binary)
# every time. Use npm install instead -- it only adds/removes packages that
# actually changed, leaving node_modules intact.
if echo "$CHANGED" | grep -q 'package-lock.json'; then
    echo "[otforge] Dependencies changed -- running npm install..."
    npm install --legacy-peer-deps
else
    echo "[otforge] No dependency changes -- skipping npm install."
fi

# ── Step 3: Ensure Electron binary is present ────────────────────────────────
ELECTRON_EXE="$ROOT/node_modules/electron/dist/Electron.app"
if [ ! -e "$ELECTRON_EXE" ]; then
    echo "[otforge] Electron binary missing -- reinstalling..."
    INSTALL_JS="$ROOT/node_modules/electron/install.js"
    if [ -f "$INSTALL_JS" ]; then
        node "$INSTALL_JS"
    else
        echo "[otforge] install.js not found. Run: node node_modules/electron/install.js"
    fi
else
    echo "[otforge] Electron binary present -- skipping download."
fi

# ── Step 4: Rebuild TypeScript packages ──────────────────────────────────────
echo "[otforge] Building packages..."
npm run build:packages

echo ""
echo "[otforge] Done. Run 'npm run dev' to launch."
