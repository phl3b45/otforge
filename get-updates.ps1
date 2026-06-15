# get-updates.ps1 -- Pull the latest OTForge changes and rebuild.
#
# Run this instead of "git pull" whenever you want to update.
#
# Usage: .\get-updates.ps1
$ErrorActionPreference = 'Stop'

Write-Host "[otforge] Pulling latest changes..."
git pull

Write-Host "[otforge] Installing dependencies..."
npm ci

Write-Host "[otforge] Installing Electron binary..."
node node_modules/electron/install.js

Write-Host "[otforge] Building packages..."
npm run build:packages

Write-Host "[otforge] Done. Run 'npm run dev' to launch."
