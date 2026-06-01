# OTForge Student Setup Guide

This guide walks you through installing everything you need to run OTForge on your personal computer. By the end you will have Docker Desktop and OTForge running, and your computer will be ready to load lab scenario files.

**Your instructor will distribute Lab 01 (`.otflab` file) through Canvas. You do not need it before completing this setup — just make sure your `scenarios` folder is ready when it arrives.**

---

## What You Are Installing

| Component | Purpose |
|---|---|
| **Docker Desktop** | Runs the virtual ICS/OT devices (PLCs, sensors, network equipment) as containers |
| **Git** | Downloads the OTForge source code from GitHub |
| **Node.js 22** | Builds and runs the OTForge desktop application |
| **OTForge** | The SCADA canvas application you will use for all labs |

**Estimated time:** 30–45 minutes, depending on download speed.

**Disk space needed:** ~8 GB total (Docker, Node.js, Docker images).

---

## System Requirements

| | Windows | macOS |
|---|---|---|
| **OS version** | Windows 10 22H2 (build 19045) or later; Windows 11 23H2 (build 22631) or later | macOS 12 Monterey or later |
| **RAM** | 8 GB minimum, 16 GB recommended | 8 GB minimum, 16 GB recommended |
| **Disk** | 20 GB free | 20 GB free |
| **CPU** | 64-bit, virtualization enabled in BIOS | Intel or Apple Silicon (M1/M2/M3/M4) |

> **Windows only — Virtualization check:**  
> Open Task Manager → Performance → CPU. Confirm "Virtualization: Enabled". If it says Disabled, ask your instructor for BIOS help before proceeding.

---

## Windows Setup

### Step 1 — Install Docker Desktop

1. Go to **https://www.docker.com/products/docker-desktop** and click **Download for Windows**.
2. Run the installer (`Docker Desktop Installer.exe`).
3. When prompted, leave **Use WSL 2 instead of Hyper-V** checked (recommended for most systems).
4. Click **OK** and let the installer finish. Your computer may restart.
5. After restart, Docker Desktop launches automatically and shows a whale icon in your taskbar.
6. Wait for the status to say **"Engine running"** (green circle) before continuing.

> **First-time Docker sign-in is not required.** You can skip account creation by clicking "Continue without signing in."

**Verify Docker works:**

Open **PowerShell** (search the Start menu) and run:
```
docker --version
```
You should see something like `Docker version 27.x.x`. If you get an error, restart Docker Desktop and try again.

---

### Step 2 — Install Git

1. Go to **https://git-scm.com/download/win** and download the latest **64-bit** installer.
2. Run the installer. Accept all defaults — the standard options work fine.
3. When the installer finishes, close and reopen PowerShell.

**Verify Git works:**
```
git --version
```
You should see `git version 2.x.x`.

---

### Step 3 — Install Node.js 22

1. Go to **https://nodejs.org** and click the **LTS** download button (Long Term Support).  
   Make sure it says **v22.x.x** — if the site shows a different major version, click "Other Downloads" and select v22.
2. Run the installer. When you reach each screen, do the following:

   | Installer screen | What to do |
   |---|---|
   | **End-User License Agreement** | Accept and click Next |
   | **Destination Folder** | Leave the default path (`C:\Program Files\nodejs\`) and click Next |
   | **Custom Setup** | Leave all four items checked (Node.js runtime, npm package manager, Add to PATH, Online documentation) — these are the defaults. Click Next. |
   | **Tools for Native Modules** | **Leave the checkbox unchecked.** This screen offers to install Chocolatey and Visual Studio Build Tools — OTForge does not need them. Checking it triggers a separate 1 GB download that is not required. Click Next. |
   | **Ready to Install** | Click Install. Windows may ask for administrator permission — click Yes. |

> **Node.js 20 will not work.** OTForge uses Vite 8, which requires Node.js 22 or later. If you have Node.js 20 installed, uninstall it first (Windows Settings → Apps → search "Node.js" → Uninstall), then install v22 from the link above.

**Verify Node.js works:**
```
node --version
npm --version
```
Both commands should return version numbers (e.g., `v22.x.x` and `10.x.x`).

---

### Step 4 — Configure PowerShell Script Execution

Windows blocks PowerShell scripts by default. Running `npm` commands requires scripts to be allowed. This is a one-time change — you will not need to repeat it.

In PowerShell, run:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Type **Y** and press Enter when prompted. This does not require administrator access and only affects your user account.

> **What this does:** Sets PowerShell to allow locally created scripts and signed remote scripts to run. Without this, `npm` commands will fail with a message saying scripts are disabled on your system.

---

### Step 5 — Clone the OTForge Repository

You will create a dedicated folder on your `C:` drive and download the project into it.

In PowerShell, run these commands **one at a time**:

```powershell
mkdir C:\OTForge
cd C:\OTForge
git clone https://github.com/iburres/otforge.git .
```

> The final `.` (period) tells Git to clone into the current folder instead of creating a subfolder. Make sure you include it.

When the clone finishes, you will see a list of files and folders inside `C:\OTForge`.

---

### Step 6 — Install OTForge Dependencies

Still in PowerShell (inside `C:\OTForge`), run:

```powershell
npm ci
```

This downloads all the JavaScript packages OTForge needs. It may take a few minutes. You will see a lot of output — that is normal. Wait for the prompt to return.

---

### Step 7 — Build the Support Packages

```powershell
npm run build:packages
```

This compiles two internal packages (`schema` and `orchestrator`) that the main app depends on. It takes about 30 seconds.

---

### Step 8 — Launch OTForge

```powershell
npm run dev
```

The OTForge window will open. The first time you run it, you may see a Windows Defender prompt asking to allow network access — click **Allow**.

You are now ready for lab work.

---

### Step 9 — Prepare Your Scenarios Folder

Your scenario files (`.otflab`) live in:

```
C:\OTForge\scenarios\
```

This folder already exists after cloning. When your instructor releases a lab file through Canvas, download it and save it to that folder.

---

## macOS Setup

### Step 1 — Install Docker Desktop

1. Go to **https://www.docker.com/products/docker-desktop** and click **Download for Mac**.
2. **Important:** On the download page, choose the correct version for your chip:
   - **Apple Silicon (M1/M2/M3/M4):** Choose "Mac with Apple Silicon"
   - **Intel Mac:** Choose "Mac with Intel chip"
   
   *To check your chip: Apple menu () → About This Mac. Look for "Chip" (Apple M-series) or "Processor" (Intel).*

3. Open the downloaded `.dmg` file and drag Docker to your Applications folder.
4. Open Docker from Applications. macOS will ask for your password to allow the Docker helper to install.
5. Wait for the Docker menu bar icon (whale) to show **"Docker Desktop is running"**.

> **Sign-in is not required.** Click "Continue without signing in" if prompted.

**Verify Docker works:**

Open **Terminal** (Applications → Utilities → Terminal) and run:
```bash
docker --version
```
You should see `Docker version 27.x.x`.

---

### Step 2 — Install Homebrew (Package Manager)

Homebrew makes installing Git and Node.js much easier on macOS. If you already have it, skip to Step 3.

In Terminal, run:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the prompts. You will need your macOS password. On Apple Silicon, the installer may ask you to add Homebrew to your PATH — copy and run the two commands it shows before continuing.

**Verify Homebrew works:**
```bash
brew --version
```

---

### Step 3 — Install Git

macOS often includes a system Git, but installing a newer version through Homebrew is recommended:

```bash
brew install git
```

**Verify:**
```bash
git --version
```

---

### Step 4 — Install Node.js 22

```bash
brew install node@22
```

After installation, Homebrew may ask you to add Node 22 to your PATH. If so, run the commands it prints (they look like `echo 'export PATH=...' >> ~/.zshrc`).

Then reload your shell configuration:
```bash
source ~/.zshrc
```

**Verify:**
```bash
node --version
npm --version
```
Both should return version numbers (`v22.x.x` and `10.x.x`).

> **Node.js 20 will not work.** OTForge uses Vite 8, which requires Node.js 22 or later. If you already have Node.js 20 via Homebrew, run `brew unlink node@20 && brew link --overwrite node@22` to switch.

> **Already have a different Node version?** You can use `nvm` (Node Version Manager) to switch versions. Run `nvm install 22 && nvm use 22` if you have nvm installed.

---

### Step 5 — Clone the OTForge Repository

In Terminal, run these commands **one at a time**:

```bash
mkdir ~/OTForge
cd ~/OTForge
git clone https://github.com/iburres/otforge.git .
```

> The final `.` (period) clones into the current folder. Do not omit it.

---

### Step 6 — Install OTForge Dependencies

```bash
npm ci
```

Wait for it to finish (a few minutes). You will see package installation output — that is normal.

---

### Step 7 — Build the Support Packages

```bash
npm run build:packages
```

This takes about 30 seconds.

---

### Step 8 — Launch OTForge

```bash
npm run dev
```

The OTForge window opens. On first launch, macOS may show a security dialog — click **Open** to allow the Electron application to run.

---

### Step 9 — Prepare Your Scenarios Folder

Your scenario files live in:

```
~/OTForge/scenarios/
```

(This is `/Users/yourname/OTForge/scenarios/` — the `~` is shorthand for your home folder.)

When your instructor releases a lab file through Canvas, download it and save it here.

---

## What Happens on First Simulation Run

When you open a lab scenario and click **Start Simulation** for the first time, OTForge will automatically pull the required Docker container images from GitHub's container registry. This is a **one-time download of approximately 2–4 GB** and may take several minutes depending on your internet connection. You will see a progress overlay in the application while this happens.

Subsequent runs use the cached images and start in seconds.

---

## Troubleshooting

### "Docker Desktop is not running" error in OTForge

Make sure Docker Desktop is open and the taskbar/menu bar icon shows a running state (green indicator). OTForge cannot start simulations if Docker is not running.

### `npm ci` fails with permission errors (Windows)

Right-click PowerShell in the Start menu and choose **Run as Administrator**, then retry the command from `C:\OTForge`.

### `npm ci` fails with permission errors (macOS)

Run `sudo npm ci` and enter your password, or fix npm permissions:
```bash
sudo chown -R $(whoami) ~/.npm
npm ci
```

### `npm run dev` fails with "Error: Electron uninstall"

The Electron binary did not download correctly during `npm ci` — Windows Defender and some campus antivirus tools sometimes block or interrupt the download.

**Step 1 — Try the manual Electron installer first (run from `C:\OTForge`):**
```powershell
node node_modules/electron/install.js
npm run dev
```

This downloads only the missing Electron binary and is faster than a full reinstall. If it works, you are done.

**Step 2 — If Step 1 does not fix it, do a full reinstall (regular PowerShell window, not Run as Administrator):**
```powershell
Remove-Item -Recurse -Force node_modules
npm ci
npm run dev
```

If you get a permission error on `Remove-Item`, right-click PowerShell and choose **Run as Administrator**, run `Remove-Item -Recurse -Force node_modules`, then close that window and repeat `npm ci` and `npm run dev` in a regular (non-admin) PowerShell.

### `npm run dev` opens no window

Check that `npm run build:packages` completed without errors first. If it did, try closing and reopening your terminal, then run `npm run dev` again.

### Docker images fail to pull

Confirm you have an internet connection and that Docker Desktop is signed in (or that your network does not block `ghcr.io`). On campus networks, check with IT if container registry traffic is blocked.

### "Virtualization not supported" on Windows

You need to enable virtualization in your computer's BIOS/UEFI firmware. The exact steps vary by manufacturer — search for your laptop model + "enable virtualization BIOS". Contact your instructor if you need help.

### Apple Silicon Mac — "image not found" or architecture mismatch

Make sure you downloaded the **Apple Silicon** version of Docker Desktop (not the Intel version). Check Docker Desktop → Settings → General → confirm "Use Virtualization Framework" is enabled.

### `TypeError: crypto.hash is not a function` (Mac or Windows)

You are running Node.js 20, which is too old. OTForge uses Vite 8, which requires Node.js 22 or later.

**Fix (macOS):**
```bash
brew install node@22
brew unlink node@20
brew link --overwrite node@22
node --version   # should print v22.x.x
npm ci
npm run dev
```

**Fix (Windows):** Uninstall Node.js from Windows Settings → Apps → search "Node.js" → Uninstall. Then install Node.js 22 LTS from **https://nodejs.org** and repeat the setup from Step 6.

---

## Keeping OTForge Updated

Your instructor may push updates to the repository during the semester. To get the latest version:

```bash
# Windows (PowerShell in C:\OTForge)
git pull
npm ci
npm run build:packages

# macOS (Terminal in ~/OTForge)
git pull
npm ci
npm run build:packages
```

Then relaunch with `npm run dev`.

---

## Network Isolation — Protect Your Lab Ports

When OTForge is running, Docker publishes several local ports so the app can open the Grafana dashboard, FUXA HMI, OpenPLC IDE, and VNC desktops in browser windows. On Windows, Docker binds these ports to **all network interfaces** (`0.0.0.0`), which means anyone on the same Wi-Fi network as your laptop could connect to your simulated devices while a lab is running.

Add a single Windows Firewall rule to block inbound connections to all OTForge ports. Open **PowerShell as Administrator** and paste:

```powershell
New-NetFirewallRule `
  -DisplayName "OTForge — Block inbound lab ports" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 1881,3000,3100,6800-6899,6900-6999,18080-18199 `
  -Action Block `
  -Profile Any
```

This blocks the following ports from being reachable by anyone other than your own machine:

| Port(s) | Service |
|---|---|
| 1881 | FUXA process HMI |
| 3000 | Grafana dashboards |
| 3100 | Loki log API |
| 6800–6899 | Engineering workstation VNC desktops |
| 6900–6999 | Kali Linux attack machine VNC desktop |
| 18080–18199 | OpenPLC web IDE and Modbus ports (per PLC) |

To verify the rule was created:

```powershell
Get-NetFirewallRule -DisplayName "OTForge*"
```

To remove the rule if you ever need to (e.g., for a collaborative demo):

```powershell
Remove-NetFirewallRule -DisplayName "OTForge — Block inbound lab ports"
```

> **macOS:** Docker Desktop for Mac binds published ports to `127.0.0.1` (localhost only) by default — they are not reachable from your network without custom configuration. No firewall rule is needed on macOS.

---

## Quick Reference

| Task | Windows | macOS |
|---|---|---|
| Open terminal | Start → PowerShell | Applications → Utilities → Terminal |
| Navigate to OTForge | `cd C:\OTForge` | `cd ~/OTForge` |
| Start OTForge | `npm run dev` | `npm run dev` |
| Scenarios folder | `C:\OTForge\scenarios\` | `~/OTForge/scenarios/` |
| Update OTForge | `git pull && npm ci && npm run build:packages` | `git pull && npm ci && npm run build:packages` |

---

*Questions? Post in the course discussion board or bring your laptop to office hours.*
