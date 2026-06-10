# fix-electron.ps1
# Repairs a missing or broken Electron binary installation.
# Works from any drive (C:\OTForge, D:\OTForge, etc.) -- all paths are
# resolved dynamically from $PSScriptRoot and $env:LOCALAPPDATA.
#
# Usage (run from your OTForge folder, NOT as Administrator):
#   .\fix-electron.ps1
#
# Recovery sequence:
#   Step 1 -- Ensure path.txt contains the correct value
#   Step 2 -- Check whether electron.exe is already present and valid
#   Step 3 -- Try install.js (uses npm network cache if available)
#   Step 4 -- Check the local AppData electron cache (no download needed)
#   Step 5 -- Download from GitHub as a last resort (~90 MB)
#   Step 6 -- Verify the installation

$ErrorActionPreference = 'Stop'

$electronDir   = Join-Path $PSScriptRoot "node_modules\electron"
$distDir       = Join-Path $electronDir  "dist"
$electronExe   = Join-Path $distDir      "electron.exe"
$pathTxt       = Join-Path $electronDir  "path.txt"
$version       = "42.0.1"
$zipName       = "electron-v$version-win32-x64.zip"
$zipUrl        = "https://github.com/electron/electron/releases/download/v$version/$zipName"
$tempZip       = Join-Path $env:TEMP     "otforge-electron.zip"
$tempExtract   = Join-Path $env:TEMP     "otforge-electron-extract"

# AppData cache written by @electron/get (the downloader used by install.js).
# If Electron was ever downloaded on this machine the zip lives here -- no
# internet required to recover from it.
$appdataCache  = Join-Path $env:LOCALAPPDATA "electron\Cache\$zipName"

Write-Host ""
Write-Host "OTForge - Electron repair script" -ForegroundColor Cyan
Write-Host "=================================" -ForegroundColor Cyan
Write-Host "Working directory: $PSScriptRoot"
Write-Host ""

# Step 1: ensure path.txt is correct
Write-Host "Step 1  Checking path.txt..." -ForegroundColor Yellow

if (-not (Test-Path $pathTxt)) {
    Write-Host "        path.txt missing - creating it." -ForegroundColor Gray
    [System.IO.File]::WriteAllText($pathTxt, "electron.exe")
} else {
    $content = [System.IO.File]::ReadAllText($pathTxt)
    if ($content -ne "electron.exe") {
        Write-Host "        path.txt has wrong content - fixing." -ForegroundColor Gray
        [System.IO.File]::WriteAllText($pathTxt, "electron.exe")
    } else {
        Write-Host "        path.txt OK." -ForegroundColor Green
    }
}

# Step 2: check if the binary already exists and is the right version
Write-Host "Step 2  Checking for electron.exe in dist\..." -ForegroundColor Yellow

if (Test-Path $electronExe) {
    Write-Host "        electron.exe found - testing version..." -ForegroundColor Gray
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
    Write-Host "        electron.exe not found - will attempt repair." -ForegroundColor DarkYellow
}

# Step 3: try install.js (uses npm's network cache if available)
Write-Host "Step 3  Trying install.js..." -ForegroundColor Yellow

$installJs = Join-Path $electronDir "install.js"
if (Test-Path $installJs) {
    try {
        & node $installJs
        if (Test-Path $electronExe) {
            [System.IO.File]::WriteAllText($pathTxt, "electron.exe")
            Write-Host "        install.js succeeded." -ForegroundColor Green
            Write-Host ""
            Write-Host "All good. Run: npm run dev" -ForegroundColor Cyan
            exit 0
        }
    } catch {
        Write-Host "        install.js failed - trying local cache." -ForegroundColor DarkYellow
    }
} else {
    Write-Host "        install.js not found - skipping." -ForegroundColor Gray
}

# Step 4: check the AppData electron cache (no internet required)
# @electron/get stores downloaded zips at %LOCALAPPDATA%\electron\Cache\.
# This catches the common classroom scenario where npm previously installed
# Electron on the same machine (another drive, another clone, etc.).
Write-Host "Step 4  Checking local AppData cache..." -ForegroundColor Yellow
Write-Host "        Looking for: $appdataCache" -ForegroundColor Gray

if (Test-Path $appdataCache) {
    Write-Host "        Cache hit! Extracting $zipName from AppData..." -ForegroundColor Green

    if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
    Expand-Archive -Path $appdataCache -DestinationPath $tempExtract -Force

    if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
    Copy-Item -Recurse "$tempExtract\*" "$distDir\" -Force
    [System.IO.File]::WriteAllText($pathTxt, "electron.exe")

    Remove-Item -Recurse -Force $tempExtract

    if (Test-Path $electronExe) {
        Write-Host "        Extracted from cache successfully." -ForegroundColor Green
        Write-Host ""
        Write-Host "All good. Run: npm run dev" -ForegroundColor Cyan
        exit 0
    } else {
        Write-Host "        Cache extract failed - falling back to download." -ForegroundColor DarkYellow
    }
} else {
    Write-Host "        No cache found - will download from GitHub." -ForegroundColor Gray
}

# Step 5: download from GitHub (~90 MB)
Write-Host "Step 5  Downloading Electron v$version from GitHub..." -ForegroundColor Yellow
Write-Host "        This is ~90 MB - please wait." -ForegroundColor Gray

try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "ERROR: Download failed. Check your internet connection and try again." -ForegroundColor Red
    Write-Host "       If your campus network blocks GitHub, connect to a hotspot and re-run this script." -ForegroundColor Red
    exit 1
}

Write-Host "        Download complete. Extracting..." -ForegroundColor Gray

if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force

if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
Copy-Item -Recurse "$tempExtract\*" "$distDir\" -Force
[System.IO.File]::WriteAllText($pathTxt, "electron.exe")

Write-Host "        Cleaning up temp files..." -ForegroundColor Gray
Remove-Item -Recurse -Force $tempExtract, $tempZip

# Step 6: verify
Write-Host "Step 6  Verifying installation..." -ForegroundColor Yellow

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
    Write-Host "WARNING: Unexpected version '$ver' - expected v$version." -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "Done. Run: npm run dev" -ForegroundColor Cyan
Write-Host ""
