# get-updates.ps1 -- Pull the latest OTForge changes and rebuild.
#
# Run this instead of "git pull" whenever you want to update.
# DO NOT run "npm ci" manually -- it deletes node_modules and forces a fresh
# Electron download (~90 MB) that fails on many campus networks.
#
# Usage: .\get-updates.ps1
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot

# ── Step 1: Pull new code ────────────────────────────────────────────────────
Write-Host "[otforge] Pulling latest changes..." -ForegroundColor Cyan
# Capture which files changed so we know whether package-lock.json was updated.
$changedFiles = git pull --no-rebase 2>&1 | Out-String

# ── Step 2: Reinstall packages only if package-lock.json changed ─────────────
# npm ci would delete node_modules entirely (including the Electron binary)
# every time. Instead, npm install only adds or removes the packages that
# actually changed -- node_modules and the already-installed Electron binary
# are left intact.
if ($changedFiles -match 'package-lock\.json') {
    Write-Host "[otforge] Dependencies changed -- running npm install..." -ForegroundColor Cyan
    npm install --legacy-peer-deps
} else {
    Write-Host "[otforge] No dependency changes -- skipping npm install." -ForegroundColor Gray
}

# ── Step 3: Ensure Electron binary is present ────────────────────────────────
# After the initial setup this binary should already exist. We only re-run
# install.js when it has somehow gone missing (corrupt download, manual delete,
# etc.). This avoids the ~90 MB GitHub download on every update.
$electronExe = Join-Path $root "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
    Write-Host "[otforge] Electron binary missing -- reinstalling..." -ForegroundColor Yellow
    $installJs = Join-Path $root "node_modules\electron\install.js"
    if (Test-Path $installJs) {
        node $installJs
    } else {
        Write-Host "[otforge] install.js not found. Run .\fix-electron.ps1 to repair." -ForegroundColor Red
    }
} else {
    Write-Host "[otforge] Electron binary present -- skipping download." -ForegroundColor Gray
}

# ── Step 4: Rebuild TypeScript packages ──────────────────────────────────────
Write-Host "[otforge] Building packages..." -ForegroundColor Cyan
npm run build:packages

Write-Host ""
Write-Host "[otforge] Done. Run 'npm run dev' to launch." -ForegroundColor Green
