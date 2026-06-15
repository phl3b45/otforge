#!/usr/bin/env bash
# get-updates.sh -- Pull the latest OTForge changes and rebuild.
#
# Run this instead of "git pull" whenever you want to update.
set -e

echo "[otforge] Pulling latest changes..."
git pull

echo "[otforge] Installing dependencies..."
npm ci

echo "[otforge] Installing Electron binary..."
node node_modules/electron/install.js

echo "[otforge] Building packages..."
npm run build:packages

echo "[otforge] Done. Run 'npm run dev' to launch."
