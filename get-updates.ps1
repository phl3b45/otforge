# get-updates.ps1 -- Pull the latest OTForge changes and rebuild.
#
# Run this instead of "git pull" whenever you want to update.
# It resets package-lock.json before and after npm ci so that the
# file stays clean even though npm rewrites it with platform-specific
# native-binary resolutions (win32-x64 vs darwin-arm64).
#
# Usage: .\get-updates.ps1
$ErrorActionPreference = 'Stop'

Write-Host "[otforge] Resetting package-lock.json..."
git restore package-lock.json 2>$null
if (-not $?) { git checkout -- package-lock.json }

Write-Host "[otforge] Pulling latest changes..."
git pull

Write-Host "[otforge] Installing dependencies..."
npm ci

Write-Host "[otforge] Installing Electron binary..."
node node_modules/electron/install.js

Write-Host "[otforge] Building packages..."
npm run build:packages

# Reset again so the NEXT get-updates run won't hit a conflict.
Write-Host "[otforge] Resetting package-lock.json..."
git restore package-lock.json 2>$null
if (-not $?) { git checkout -- package-lock.json }

Write-Host "[otforge] Done. Run 'npm run dev' to launch."
