# fix-electron.ps1
# Run this script from C:\OTForge if you see the "Electron uninstall" error
# after npm run dev. It checks, repairs, or re-downloads the Electron binary.
#
# Usage:
#   cd C:\OTForge
#   .\fix-electron.ps1

$ErrorActionPreference = 'Stop'

$electronDir   = Join-Path $PSScriptRoot "node_modules\electron"
$distDir       = Join-Path $electronDir  "dist"
$electronExe   = Join-Path $distDir      "electron.exe"
$pathTxt       = Join-Path $electronDir  "path.txt"
$version       = "42.0.1"
$zipUrl        = "https://github.com/electron/electron/releases/download/v$version/electron-v$version-win32-x64.zip"
$tempZip       = Join-Path $env:TEMP     "otforge-electron.zip"
$tempExtract   = Join-Path $env:TEMP     "otforge-electron-extract"

Write-Host ""
Write-Host "OTForge — Electron repair script" -ForegroundColor Cyan
Write-Host "=================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: ensure path.txt is correct ────────────────────────────────────────
Write-Host "Step 1  Checking path.txt..." -ForegroundColor Yellow

if (-not (Test-Path $pathTxt)) {
    Write-Host "        path.txt missing — creating it." -ForegroundColor Gray
    "electron.exe" | Out-File -FilePath $pathTxt -Encoding ascii -NoNewline
} else {
    $content = (Get-Content $pathTxt -Raw).Trim()
    if ($content -ne "electron.exe") {
        Write-Host "        path.txt has wrong content ('$content') — fixing." -ForegroundColor Gray
        "electron.exe" | Out-File -FilePath $pathTxt -Encoding ascii -NoNewline
    } else {
        Write-Host "        path.txt OK." -ForegroundColor Green
    }
}

# ── Step 2: check if the binary already exists ────────────────────────────────
Write-Host "Step 2  Checking for electron.exe in dist\..." -ForegroundColor Yellow

if (Test-Path $electronExe) {
    Write-Host "        electron.exe found — testing version..." -ForegroundColor Gray
    $ver = & $electronExe --version 2>&1
    if ($ver -match $version) {
        Write-Host "        Electron v$version is installed correctly." -ForegroundColor Green
        Write-Host ""
        Write-Host "All good. Run: npm run dev" -ForegroundColor Cyan
        exit 0
    } else {
        Write-Host "        Version mismatch ($ver). Re-installing." -ForegroundColor DarkYellow
    }
} else {
    Write-Host "        electron.exe not found — will download." -ForegroundColor DarkYellow
}

# ── Step 3: try install.js (uses npm's cached download if available) ──────────
Write-Host "Step 3  Trying install.js (uses local cache if available)..." -ForegroundColor Yellow

$installJs = Join-Path $electronDir "install.js"
if (Test-Path $installJs) {
    try {
        & node $installJs
        if (Test-Path $electronExe) {
            Write-Host "        install.js succeeded." -ForegroundColor Green
            Write-Host ""
            Write-Host "All good. Run: npm run dev" -ForegroundColor Cyan
            exit 0
        }
    } catch {
        Write-Host "        install.js failed — falling back to manual download." -ForegroundColor DarkYellow
    }
} else {
    Write-Host "        install.js not found — skipping." -ForegroundColor Gray
}

# ── Step 4: manual download and extract ───────────────────────────────────────
Write-Host "Step 4  Downloading Electron v$version from GitHub..." -ForegroundColor Yellow
Write-Host "        This is ~90 MB — please wait." -ForegroundColor Gray

try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "ERROR: Download failed. Check your internet connection and try again." -ForegroundColor Red
    Write-Host "       If your campus network blocks GitHub, connect to a personal hotspot and re-run this script." -ForegroundColor Red
    exit 1
}

Write-Host "        Download complete. Extracting..." -ForegroundColor Gray

if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force

Write-Host "        Copying files into node_modules\electron\dist\..." -ForegroundColor Gray

if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

# The Electron zip extracts files flat (electron.exe, resources.pak, locales\, etc.)
# with no dist\ subfolder inside the zip. Copy everything into our dist\ folder.
Copy-Item -Recurse "$tempExtract\*" "$distDir\" -Force

Write-Host "        Cleaning up temp files..." -ForegroundColor Gray
Remove-Item -Recurse -Force $tempExtract, $tempZip

# ── Step 5: verify ────────────────────────────────────────────────────────────
Write-Host "Step 5  Verifying installation..." -ForegroundColor Yellow

if (-not (Test-Path $electronExe)) {
    Write-Host ""
    Write-Host "ERROR: electron.exe still not found after download. Something went wrong." -ForegroundColor Red
    Write-Host "       Please contact your instructor." -ForegroundColor Red
    exit 1
}

$ver = & $electronExe --version 2>&1
if ($ver -match $version) {
    Write-Host "        Electron $ver installed successfully." -ForegroundColor Green
} else {
    Write-Host "WARNING: Unexpected version '$ver' — expected v$version." -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "Done. Run: npm run dev" -ForegroundColor Cyan
Write-Host ""
