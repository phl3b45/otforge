#!/usr/bin/env bash
# get-updates.sh — Pull the latest OTForge changes and rebuild.
#
# Run this instead of "git pull" whenever you want to update.
# It resets package-lock.json before and after npm ci so that the
# file stays clean even though npm rewrites it with platform-specific
# native-binary resolutions (darwin-arm64 vs win32-x64).
set -e

echo "[otforge] Resetting package-lock.json..."
git restore package-lock.json 2>/dev/null || git checkout -- package-lock.json

echo "[otforge] Pulling latest changes..."
git pull

echo "[otforge] Installing dependencies..."
npm ci

echo "[otforge] Building packages..."
npm run build:packages

# Reset again so the NEXT get-updates run won't hit a conflict.
git restore package-lock.json 2>/dev/null || git checkout -- package-lock.json

echo "[otforge] Done. Run 'npm run dev' to launch."
