/**
 * index.ts — Electron main process entry point.
 *
 * This is the "backend" of the Electron application. It runs in Node.js with full
 * system access and is responsible for:
 *
 *   1. Creating and managing the BrowserWindow (renderer host)
 *   2. Registering IPC handlers that the renderer calls via window.electronAPI
 *   3. Checking whether Docker Desktop is installed and running
 *   4. Driving the simulation lifecycle (start / stop / status)
 *   5. Persisting scenario state to LevelDB across app restarts
 *
 * Security model:
 *   - contextIsolation: true — renderer cannot access Node.js APIs directly
 *   - nodeIntegration: false — no require() in renderer
 *   - All communication goes through contextBridge (preload/index.ts)
 *
 * IPC channel naming convention:  "<domain>:<action>"
 *   app:info, docker:check, scenario:import, simulation:start, etc.
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type {
  AppInfo,
  DockerStatus,
  ScenarioImportResult,
  ScenarioExportResult,
  ScenarioExportOptions,
  SimulationStartResult,
  SimulationStopResult,
  ContainerStatus,
  ICSLabScenario,
  PLCDeployResult,
  PLCRuntimeStatus
} from '@ics-sim/schema'
import { readFile, writeFile, access } from 'fs/promises'
import { exec, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { promisify } from 'util'
import { join as pathJoin } from 'path'
import os from 'os'
import http from 'http'
import net from 'net'
import {
  generateCompose,
  DockerClient,
  estimateResources,
  checkSystemMemory,
  validateScenario,
  toProjectName,
  writeGrafanaProvisioning,
  findFreeSubnets,
  ZONE_DEFAULTS
} from '@ics-sim/orchestrator'
import type { NetworkZone } from '@ics-sim/schema'
import { initDb, saveActiveScenario, loadActiveScenario, clearActiveScenario } from './db'

const execAsync = promisify(exec)

// ── Network settings ───────────────────────────────────────────────────────────

/**
 * Persisted network configuration for Docker subnet assignment.
 *
 * Stored as JSON at <userData>/settings.json. Controls whether the simulator
 * auto-detects non-conflicting subnets at each simulation start or uses a
 * user-pinned set of subnets instead.
 *
 * autoDetect:     When true (default), findFreeSubnets() scans os.networkInterfaces()
 *                 at every simulation start and picks /24 subnets in the 10.200–10.210.x
 *                 range that don't conflict with any existing host interface.
 *
 * pinnedSubnets:  Used only when autoDetect is false. The renderer's Settings modal
 *                 populates this from user-edited subnet inputs. Should include all six
 *                 zones (ot, control, plant-dmz, enterprise, internet-dmz, attacker).
 */
interface NetworkSettings {
  autoDetect: boolean
  pinnedSubnets?: Record<string, { subnet: string; gateway: string }>
}

/**
 * Returns the absolute path to the settings JSON file.
 * Computed at call time (not module load) so app.getPath() is always ready.
 */
function settingsPath(): string {
  return pathJoin(app.getPath('userData'), 'settings.json')
}

/**
 * Reads the stored NetworkSettings from disk.
 *
 * Returns a safe default ({ autoDetect: true }) if the file does not exist yet
 * (first launch, or user deleted the file) or cannot be parsed. This guarantees
 * the app always has a valid settings object to work with.
 */
async function readSettings(): Promise<NetworkSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf-8'))
    // Merge with default so any added fields in future versions get defaults
    return { autoDetect: true, ...raw }
  } catch {
    // File absent on first launch, or corrupted — fall back to auto-detect
    return { autoDetect: true }
  }
}

/**
 * Persists a NetworkSettings object to <userData>/settings.json.
 * The file is created if it does not exist (mkdir not needed — userData always exists).
 *
 * @param settings - The settings to write.
 */
async function writeSettings(settings: NetworkSettings): Promise<void> {
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

/**
 * Scans the host's network interfaces via os.networkInterfaces() and returns
 * a deduplicated list of CIDR strings normalized to network base addresses.
 *
 * Normalization: os.networkInterfaces() returns addr.cidr as the host address
 * with prefix length (e.g., "192.168.1.100/24"). We convert this to the network
 * base ("192.168.1.0/24") so findFreeSubnets() can correctly detect whether a
 * candidate subnet overlaps with an existing interface's range — even when the
 * existing interface uses a broad mask like /8 or /16.
 *
 * Internal loopback addresses (127.0.0.1, ::1) are excluded.
 * Single-host /32 addresses are excluded (they don't define a subnet to avoid).
 *
 * @returns Array of unique network-base CIDR strings (e.g., ["192.168.1.0/24", "10.8.0.0/16"]).
 */
function getInUseCidrs(): string[] {
  const cidrs: string[] = []
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue
    for (const addr of iface) {
      // Skip IPv6 (Docker networks are IPv4), loopback, and addresses without CIDR notation
      if (addr.family !== 'IPv4' || addr.internal || !addr.cidr) continue
      const [ip, bits] = addr.cidr.split('/')
      const prefix = parseInt(bits)
      // /32 means a single host address — not a routable subnet to avoid
      if (prefix === 32) continue
      // Compute the network base by zeroing host bits using bitwise AND with the mask
      const mask = prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1) >>> 0
      const ipInt =
        ip.split('.').reduce((acc: number, o: string) => (acc << 8) + parseInt(o), 0) >>> 0
      const netInt = (ipInt & mask) >>> 0
      const net = [
        (netInt >>> 24) & 0xff,
        (netInt >>> 16) & 0xff,
        (netInt >>> 8) & 0xff,
        netInt & 0xff
      ].join('.')
      cidrs.push(`${net}/${bits}`)
    }
  }
  // Deduplicate — multiple interfaces can share the same network segment
  return [...new Set(cidrs)]
}

/**
 * Resolves the Docker zone-to-subnet map to use for the next simulation.
 *
 * Logic:
 *   1. Read settings.json.
 *   2. If autoDetect is false AND pinnedSubnets covers all four zones, use pinned subnets.
 *   3. Otherwise, run findFreeSubnets() against the current host interface list.
 *
 * The returned map is passed to generateCompose() and writeGrafanaProvisioning()
 * so every container IP and every Grafana datasource URL uses the same subnets.
 *
 * @returns Promise resolving to a complete zone → { subnet, gateway } map.
 */
async function resolveZones(): Promise<Record<NetworkZone, { subnet: string; gateway: string }>> {
  const settings = await readSettings()

  if (!settings.autoDetect && settings.pinnedSubnets) {
    // Use pinned values, falling back to ZONE_DEFAULTS for any missing zone.
    // This guards against partially-filled pinnedSubnets from older settings files
    // (e.g., saved before the 6-zone Purdue refactor added plant-dmz/enterprise/internet-dmz).
    const pins = settings.pinnedSubnets
    return {
      ot: { ...(pins.ot ?? ZONE_DEFAULTS.ot) },
      control: { ...(pins.control ?? ZONE_DEFAULTS.control) },
      'plant-dmz': { ...(pins['plant-dmz'] ?? ZONE_DEFAULTS['plant-dmz']) },
      enterprise: { ...(pins.enterprise ?? ZONE_DEFAULTS.enterprise) },
      'internet-dmz': { ...(pins['internet-dmz'] ?? ZONE_DEFAULTS['internet-dmz']) },
      attacker: { ...(pins.attacker ?? ZONE_DEFAULTS.attacker) }
    }
  }

  // Auto-detect: walk os.networkInterfaces() and pick non-conflicting /24 subnets
  return findFreeSubnets(getInUseCidrs())
}

/**
 * Platform-specific directories where Docker CLI binaries may live.
 *
 * Electron inherits a stripped PATH from the OS launcher (not a terminal),
 * so on Windows the Docker Desktop install directory is typically absent.
 * We prepend these paths before every `docker` invocation.
 */
const DOCKER_PATHS: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Docker\\Docker\\resources\\bin',
    'C:\\ProgramData\\DockerDesktop\\version-bin'
  ],
  darwin: [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/Applications/Docker.app/Contents/Resources/bin'
  ],
  linux: ['/usr/bin', '/usr/local/bin']
}

/**
 * Builds a process environment with Docker's CLI directories prepended to PATH.
 *
 * @returns A copy of process.env with Docker binary paths prepended so that
 *   `docker` commands succeed regardless of how the app was launched.
 */
function buildDockerEnv(): NodeJS.ProcessEnv {
  const extra = (DOCKER_PATHS[process.platform] ?? []).join(
    process.platform === 'win32' ? ';' : ':'
  )
  const sep = process.platform === 'win32' ? ';' : ':'
  return { ...process.env, PATH: `${extra}${sep}${process.env.PATH ?? ''}` }
}

/**
 * Direct download URLs shown when the user needs to install Docker Desktop.
 * Linux points to the docs page rather than a binary — Docker Desktop on Linux
 * requires distribution-specific package manager steps.
 */
const DOCKER_DOWNLOAD_URLS: Record<string, string> = {
  win32: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
  darwin: 'https://desktop.docker.com/mac/main/arm64/Docker.dmg',
  linux: 'https://docs.docker.com/desktop/install/linux/'
}

/**
 * Determines whether this is the first time the app has launched on this machine.
 *
 * Uses a sentinel file `<userData>/.launched` as a flag. On the first run the
 * file does not exist — we create it and return true. Every subsequent run the
 * file exists and we return false immediately.
 *
 * @returns true on the very first launch, false on all subsequent launches.
 */
async function isFirstLaunch(): Promise<boolean> {
  const flagPath = pathJoin(app.getPath('userData'), '.launched')
  try {
    await access(flagPath)
    return false
  } catch {
    // File absent → first launch. Create it so future runs return false.
    await writeFile(flagPath, '1', 'utf-8')
    return true
  }
}

/**
 * Pings the Docker daemon to verify it is running.
 *
 * Runs `docker version` which requires the daemon to respond. If the command
 * throws (daemon not running, docker not installed), returns available: false.
 *
 * @returns Object with `available` boolean.
 */
async function checkDocker(): Promise<{ available: boolean }> {
  try {
    await execAsync('docker version --format "{{.Server.Version}}"', { env: buildDockerEnv() })
    return { available: true }
  } catch {
    return { available: false }
  }
}

/**
 * Displays a native dialog prompting the user to install Docker Desktop.
 *
 * Called only on the first launch when Docker is not detected. Offers a button
 * that opens the appropriate platform download URL in the system browser.
 */
function showDockerInstallPrompt(): void {
  const url = DOCKER_DOWNLOAD_URLS[process.platform] ?? DOCKER_DOWNLOAD_URLS['linux']
  dialog
    .showMessageBox(mainWindow!, {
      type: 'info',
      title: 'Docker Desktop Required',
      message: 'ICS Simulator requires Docker Desktop',
      detail:
        'Docker Desktop creates the isolated virtual networks that power every simulation.\n\n' +
        'Click "Download Docker Desktop" to get the installer. Once installed, start Docker Desktop ' +
        'and look for the whale icon in your system tray before launching a simulation.\n\n' +
        'Docker Desktop is free for personal and educational use.',
      buttons: ['Download Docker Desktop', 'I Already Have It'],
      defaultId: 0,
      cancelId: 1
    })
    .then(({ response }) => {
      if (response === 0) shell.openExternal(url)
    })
}

/** The single BrowserWindow instance — null before the window is created. */
let mainWindow: BrowserWindow | null = null

/** Manages Docker Compose lifecycle for scenario containers. */
let dockerClient: DockerClient

/**
 * The Docker Compose project name for the currently running simulation.
 * Null when no simulation is active. Used by stop/status IPC handlers.
 */
let activeProjectName: string | null = null

/**
 * Maps PLC device nodeIds to their published host ports for the OpenPLC web
 * interface. Populated when a simulation starts (same ordering as the compose
 * generator's PLC_WEB_PORT_BASE + index logic) and cleared when it stops.
 *
 * Used by the plc:deploy IPC handler to route HTTP API calls to the correct
 * container. Ports start at 18080 (first PLC in Object.entries iteration order,
 * matching compose-generator.ts).
 */
const activePlcPorts = new Map<string, number>()

/**
 * Maps attack-machine device nodeIds to their published host ports.
 * Populated on simulation start with the same index ordering as the compose
 * generator's ATTACK_NOVNC_PORT_BASE=6900 logic (host port → container port 3000).
 *
 * Used by attack:launchWindow and terminal:getVncUrl to build the KasmVNC URL.
 */
const activeAttackPorts = new Map<string, number>()

/**
 * The currently active terminal process (docker exec session).
 * Only one terminal session is supported at a time — opening a second one
 * kills the previous. Null when no terminal is open.
 */
let activeTerminalProcess: ChildProcess | null = null

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const userData = app.getPath('userData')

  // Initialize LevelDB persistence store (singleton — safe to call multiple times)
  initDb(userData)

  // Initialize the Docker Compose client, pointing its work directory at userData/scenarios/
  dockerClient = new DockerClient(userData)

  createWindow()
  registerIPCHandlers()

  // Run first-launch check and Docker check concurrently to minimize startup latency
  const [first, dockerStatus] = await Promise.all([isFirstLaunch(), checkDocker()])
  if (first && !dockerStatus.available) {
    // Prompt new users who don't have Docker — existing users have already seen it
    showDockerInstallPrompt()
  }

  // macOS: re-create the window when the dock icon is clicked and no windows exist
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// On all platforms except macOS, quit the app when the last window is closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Window ─────────────────────────────────────────────────────────────────────

/**
 * Creates the main application window.
 *
 * Key settings:
 *   - `show: false` — window stays hidden until `ready-to-show` fires, preventing
 *     a white-flash on startup while the renderer loads
 *   - `contextIsolation: true` + `nodeIntegration: false` — renderer is sandboxed;
 *     all Node access goes through the preload contextBridge
 *   - `webviewTag: true` — required by Phase 6/7 for embedded Grafana and FUXA panels
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    autoHideMenuBar: true,
    title: 'ICS Simulator',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  // Show the window only after the renderer has painted — avoids white-flash
  mainWindow.on('ready-to-show', () => mainWindow!.show())

  // Any link that would normally open a new Electron window should open in the system browser
  mainWindow.webContents.setWindowOpenHandler(details => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // In development: load Vite's dev server URL; in production: load the compiled HTML file
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── IPC handlers ───────────────────────────────────────────────────────────────

/**
 * Registers all ipcMain.handle() listeners.
 *
 * Called once during app startup. Each handler corresponds to a method on the
 * `window.electronAPI` object exposed by the preload script. Handlers are
 * grouped by domain: app, docker, scenario, simulation, license, system.
 */
function registerIPCHandlers(): void {
  // ── App metadata ─────────────────────────────────────────────────────────────

  /** Returns version strings displayed in the launch screen and about panel. */
  ipcMain.handle(
    'app:info',
    (): AppInfo => ({
      version: app.getVersion(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      platform: process.platform as AppInfo['platform']
    })
  )

  /** Opens a URL in the system browser (used for documentation links). */
  ipcMain.handle('app:openExternal', async (_e, { url }: { url: string }) => {
    await shell.openExternal(url)
  })

  // ── Docker health check ───────────────────────────────────────────────────────

  /**
   * Checks whether the Docker daemon is running and returns its version.
   *
   * The renderer calls this on mount to enable/disable the Run Simulation button.
   * Error messages are user-facing and tuned for the most common failure mode
   * (Docker Desktop installed but not started).
   */
  ipcMain.handle('docker:check', async (): Promise<DockerStatus> => {
    try {
      const { stdout } = await execAsync('docker version --format "{{.Server.Version}}"', {
        env: buildDockerEnv()
      })
      return { available: true, version: stdout.trim() }
    } catch (err) {
      const msg = (err as Error).message ?? ''
      // Distinguish "not running" from "not installed" for a better error message
      const notRunning =
        msg.includes('pipe') || msg.includes('connect') || msg.includes('Cannot connect')
      return {
        available: false,
        message: notRunning
          ? 'Docker Desktop is not running. Open Docker Desktop from the Start Menu and wait for the whale icon to appear in the system tray.'
          : `Docker error: ${msg}`
      }
    }
  })

  /** Returns the raw `docker --version` string for display in the status bar. */
  ipcMain.handle('docker:version', async (): Promise<string> => {
    try {
      const { stdout } = await execAsync('docker --version', { env: buildDockerEnv() })
      return stdout.trim()
    } catch {
      return 'unavailable'
    }
  })

  // ── Scenario management ───────────────────────────────────────────────────────

  /**
   * Opens a native file picker, reads the selected .icslab file, validates the
   * JSON schema, estimates memory requirements, optionally warns the user, then
   * persists the scenario to LevelDB so it survives an app restart.
   *
   * @returns ScenarioImportResult with the parsed scenario on success, or an
   *   error message string on failure/cancellation.
   */
  ipcMain.handle('scenario:import', async (): Promise<ScenarioImportResult> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import ICS Scenario',
      filters: [{ name: 'ICS Lab Scenario', extensions: ['icslab'] }],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'Import cancelled' }
    }

    let raw: unknown
    try {
      raw = JSON.parse(await readFile(result.filePaths[0], 'utf-8'))
    } catch (err) {
      return { ok: false, error: `Failed to parse scenario: ${(err as Error).message}` }
    }

    // Validate JSON structure matches the ICSLabScenario schema
    const { validateScenario: validate } = await import('@ics-sim/orchestrator')
    const validation = validate(raw)
    if (!validation.valid) {
      return { ok: false, error: `Invalid scenario:\n${validation.errors.join('\n')}` }
    }

    const scenario = raw as ICSLabScenario
    const resourceEstimate = estimateResources(scenario)
    const memCheck = checkSystemMemory(resourceEstimate)

    // Warn if scenario will consume more than 60% of free RAM; block at 85%
    if (memCheck.warningThreshold) {
      const level = memCheck.criticalThreshold ? 'warning' : 'info'
      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: level,
        title: memCheck.criticalThreshold ? 'High Memory Warning' : 'Memory Notice',
        message: `This scenario requires ~${resourceEstimate.estimatedRamMb}MB RAM`,
        detail: `Your system has ${memCheck.freeMb}MB free of ${memCheck.totalMb}MB total.\n\n${
          memCheck.criticalThreshold
            ? 'Your system may become unresponsive. Consider closing other applications first.'
            : 'Performance may be affected. Close other applications if you experience slowness.'
        }`,
        buttons: ['Continue', 'Cancel'],
        // Default to Cancel on critical threshold so users don't accidentally proceed
        defaultId: memCheck.criticalThreshold ? 1 : 0,
        cancelId: 1
      })
      if (response === 1) return { ok: false, error: 'Import cancelled' }
    }

    await saveActiveScenario(scenario)
    return { ok: true, scenario, resourceEstimate }
  })

  /**
   * Validates an in-memory scenario object without showing a file picker.
   * Used by the canvas editor to check user-constructed scenarios before export.
   *
   * @param scenario - Any value (typically the canvas's current scenario state).
   * @returns { valid, errors } — errors is an empty array when valid.
   */
  ipcMain.handle('scenario:validate', async (_e, scenario: unknown) => {
    return validateScenario(scenario)
  })

  /**
   * Exports a scenario to a .icslab file.
   *
   * If options.locked is true, the visual layer (node positions) and the security
   * layer (firewall rules, IDS config) are stripped from the output. This produces
   * a "student copy" that cannot be reverse-engineered to extract the full topology.
   *
   * @param scenario - The full scenario object from the canvas.
   * @param options  - Export options including optional target path and locked flag.
   */
  ipcMain.handle(
    'scenario:export',
    async (
      _e,
      { scenario, options }: { scenario: ICSLabScenario; options: ScenarioExportOptions }
    ): Promise<ScenarioExportResult> => {
      let targetPath = options.filePath

      // Show a save dialog if no explicit path was provided
      if (!targetPath) {
        const result = await dialog.showSaveDialog(mainWindow!, {
          title: 'Export ICS Scenario',
          filters: [{ name: 'ICS Lab Scenario', extensions: ['icslab'] }],
          defaultPath: `${scenario.meta.name.replace(/\s+/g, '-')}.icslab`
        })
        if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled' }
        targetPath = result.filePath
      }

      // Locked scenarios omit visual and security layers (student distribution format)
      const exportData = options.locked
        ? {
            ...scenario,
            meta: { ...scenario.meta, locked: true },
            visual: undefined,
            security: undefined
          }
        : scenario

      try {
        await writeFile(targetPath, JSON.stringify(exportData, null, 2), 'utf-8')
        return { ok: true, filePath: targetPath }
      } catch (err) {
        return { ok: false, error: `Failed to write scenario: ${(err as Error).message}` }
      }
    }
  )

  // ── Simulation lifecycle ──────────────────────────────────────────────────────

  /**
   * Starts a simulation for a given scenario.
   *
   * Sequence:
   *   1. Verify Docker is reachable.
   *   2. Generate a docker-compose.yml from the scenario device graph.
   *   3. Write the compose file to userData/scenarios/<projectName>/.
   *   4. Run `docker compose up -d` to launch all containers.
   *   5. Wait 2 s for containers to enter the running state.
   *   6. Return the list of container names that came up successfully.
   *
   * @param scenario - The full scenario to simulate.
   * @returns SimulationStartResult with containersStarted list on success.
   */
  ipcMain.handle(
    'simulation:start',
    async (_e, scenario: ICSLabScenario): Promise<SimulationStartResult> => {
      // Top-level try/catch converts any thrown error into a structured { ok: false }
      // result. Without this, an uncaught throw rejects the ipcMain handler's promise,
      // which causes ipcRenderer.invoke() to throw on the renderer side — and since
      // handleStart() in App.tsx had no catch block, simStatus would hang at 'starting'.
      try {
        const dockerAvailable = await dockerClient.isAvailable()
        if (!dockerAvailable) {
          return { ok: false, error: 'Docker Desktop is not running.' }
        }

        const projectName = toProjectName(scenario.meta.name)
        activeProjectName = projectName

        // Build PLC and attack-machine port maps with the same iteration order and base ports
        // as compose-generator.ts so the IPC handlers can find host ports without re-parsing
        // the generated compose file.
        activePlcPorts.clear()
        activeAttackPorts.clear()
        let plcIdx = 0
        let attackIdx = 0
        for (const [nodeId, device] of Object.entries(scenario.devices.devices)) {
          if (device.category === 'plc') {
            activePlcPorts.set(nodeId, 18080 + plcIdx)
            plcIdx++
          }
          if (device.category === 'attack-machine') {
            // Base port 6900 matches ATTACK_NOVNC_PORT_BASE in compose-generator.ts
            activeAttackPorts.set(nodeId, 6900 + attackIdx)
            attackIdx++
          }
        }

        // Resolve Docker subnets for all four network zones.
        //
        // resolveZones() reads settings.json: if autoDetect is true (default), it
        // calls findFreeSubnets(getInUseCidrs()) to pick /24 subnets in 10.200–10.210.x
        // that don't conflict with any current host network interface. If the user has
        // pinned specific subnets via the Settings modal, those are used instead.
        //
        // The resolved map is threaded into writeGrafanaProvisioning() (so Grafana
        // datasource URLs point to the correct InfluxDB/Loki IPs) and generateCompose()
        // (so every Docker bridge network and container static IP falls inside the
        // resolved subnets).
        const zones = await resolveZones()
        // Monitoring infrastructure (InfluxDB, Loki, Grafana, FUXA) lives on the
        // Control Center (Level 3) network. Pass its prefix so Grafana datasource
        // URLs in the provisioning files point to the resolved subnet.
        const controlBase = zones.control.subnet.replace('.0/24', '')

        // Write Grafana and Promtail provisioning files to the scenario directory.
        // These must exist before generateCompose() references their paths in volume
        // mounts, and before docker compose up starts the Grafana container.
        const scenarioDir = pathJoin(app.getPath('userData'), 'scenarios', projectName)
        await writeGrafanaProvisioning(scenarioDir, projectName, controlBase)

        const composeYaml = generateCompose(scenario, projectName, scenarioDir, zones)
        const result = await dockerClient.startScenario(projectName, composeYaml)

        if (!result.ok) {
          activeProjectName = null
          return { ok: false, error: result.error }
        }

        // Brief delay to allow containers to transition from "created" to "running"
        // before we poll their status for the success report
        await new Promise(resolve => setTimeout(resolve, 2000))
        const statuses = await dockerClient.getStatus(projectName)
        const started = statuses.filter(s => s.status === 'running').map(s => s.nodeId)

        return { ok: true, containersStarted: started }
      } catch (err) {
        // Reset active project so a retry doesn't think a simulation is already running
        activeProjectName = null
        activePlcPorts.clear()
        activeAttackPorts.clear()
        return { ok: false, error: `Simulation start failed: ${(err as Error).message}` }
      }
    }
  )

  /**
   * Stops the running simulation and cleans up the active project reference.
   *
   * Runs `docker compose down --volumes` which removes containers AND their
   * anonymous volumes, returning the environment to a clean state.
   * The LevelDB active-scenario key is cleared so the next app launch starts fresh.
   */
  ipcMain.handle('simulation:stop', async (): Promise<SimulationStopResult> => {
    if (!activeProjectName) return { ok: false, error: 'No simulation is running' }

    // Kill any open terminal session before tearing down the containers
    if (activeTerminalProcess) {
      activeTerminalProcess.kill()
      activeTerminalProcess = null
    }

    const result = await dockerClient.stopScenario(activeProjectName)
    if (result.ok) {
      await clearActiveScenario()
      activeProjectName = null
      activePlcPorts.clear()
      activeAttackPorts.clear()
    }
    return result
  })

  /**
   * Returns the current container health/state for all containers in the active simulation.
   * Returns an empty array when no simulation is running (renderer uses this to clear the UI).
   */
  ipcMain.handle('simulation:status', async (): Promise<ContainerStatus[]> => {
    if (!activeProjectName) return []
    return dockerClient.getStatus(activeProjectName)
  })

  // ── Monitoring — Loki log query proxy (Phase 6) ───────────────────────────────

  /**
   * Proxies a Loki HTTP query_range request from the renderer to the local Loki
   * container (localhost:3100). Running the request in the main process avoids
   * CORS and Content-Security-Policy issues that would arise if the renderer
   * fetched directly from an HTTP origin different from its own page origin.
   *
   * The caller passes a LogQL query string and a time range in nanoseconds.
   * Results are returned as the raw Loki API JSON object — the renderer is
   * responsible for parsing the streams/values structure.
   *
   * @param query  - LogQL expression, e.g. '{job="suricata"} | json | event_type="alert"'
   * @param fromNs - Range start as a nanosecond Unix timestamp string.
   * @param toNs   - Range end as a nanosecond Unix timestamp string.
   * @param limit  - Maximum number of log lines to return (default 200).
   */
  ipcMain.handle(
    'monitor:getLogs',
    (
      _e,
      {
        query,
        fromNs,
        toNs,
        limit = 200
      }: { query: string; fromNs: string; toNs: string; limit?: number }
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
      return new Promise(resolve => {
        const params = new URLSearchParams({
          query,
          start: fromNs,
          end: toNs,
          limit: String(limit),
          direction: 'backward'
        })
        const reqUrl = `http://localhost:3100/loki/api/v1/query_range?${params}`
        const req = http.get(reqUrl, res => {
          let body = ''
          res.on('data', (chunk: Buffer) => (body += chunk.toString()))
          res.on('end', () => {
            try {
              resolve({ ok: true, data: JSON.parse(body) })
            } catch {
              resolve({ ok: false, error: 'Invalid JSON response from Loki' })
            }
          })
        })
        req.on('error', (err: Error) => resolve({ ok: false, error: err.message }))
        // 5 s timeout — Loki should respond immediately; if not, it hasn't started yet
        req.setTimeout(5000, () => {
          req.destroy()
          resolve({ ok: false, error: 'Loki request timed out — container may still be starting' })
        })
      })
    }
  )

  // ── PLC IDE — live program deployment (Phase 4) ───────────────────────────────

  /**
   * Uploads a Structured Text program to a running OpenPLC container and
   * triggers recompilation + PLC restart.
   *
   * Workflow:
   *   1. Look up the OpenPLC container's published host port from activePlcPorts.
   *   2. POST credentials to /login to obtain a Flask session cookie.
   *   3. POST the ST source as a multipart file upload to /upload-program.
   *   4. GET /start_plc to compile and begin execution.
   *   5. Return the compiler output for display in the PlcIdePanel status area.
   *
   * If no simulation is running (activePlcPorts is empty), returns a notice
   * telling the user to restart the simulation to apply the saved program.
   *
   * OpenPLC default credentials are openplc / openplc (set during install.sh).
   * These are intentionally insecure defaults for lab use — in production ICS
   * environments, credentials would be rotated and the web interface would be
   * isolated behind a VLAN.
   *
   * @param nodeId - Canvas node ID of the target PLC device.
   * @param source - Decoded ST source text (not base64 — the preload decodes it).
   */
  ipcMain.handle(
    'plc:deploy',
    async (
      _e,
      { nodeId, source }: { nodeId: string; source: string }
    ): Promise<PLCDeployResult> => {
      // If no simulation is running, the program can only be pre-loaded at next start
      if (!activeProjectName || activePlcPorts.size === 0) {
        return {
          ok: true,
          output: 'Program saved to scenario. Restart simulation to deploy to PLC container.'
        }
      }

      const hostPort = activePlcPorts.get(nodeId)
      if (!hostPort) {
        return {
          ok: false,
          error: `No running OpenPLC container found for device "${nodeId}". Check simulation status.`
        }
      }

      try {
        return await deployToOpenPLC(hostPort, source, nodeId)
      } catch (err) {
        return { ok: false, error: `Deploy error: ${(err as Error).message}` }
      }
    }
  )

  /**
   * Polls the OpenPLC Runtime's web interface to determine whether the PLC
   * is actively executing a program or is stopped/idle.
   *
   * Makes a lightweight GET request to the /dashboard endpoint and inspects
   * the response HTML for the "PLC Status" indicator text. Returns running=false
   * if the request fails (container not yet ready, network not available, etc.).
   *
   * @param nodeId - Canvas node ID of the PLC device to query.
   */
  ipcMain.handle(
    'plc:status',
    async (_e, { nodeId }: { nodeId: string }): Promise<PLCRuntimeStatus> => {
      const hostPort = activePlcPorts.get(nodeId)
      if (!hostPort) {
        return { nodeId, running: false, error: 'No active container for this device' }
      }

      try {
        const body = await httpGet(`http://localhost:${hostPort}/dashboard`)
        // OpenPLC dashboard HTML contains "PLC Status: Running" or "PLC Status: Stopped"
        const running = body.includes('Running') && !body.includes('PLC Status: Stopped')
        return { nodeId, running }
      } catch {
        return { nodeId, running: false }
      }
    }
  )

  // ── Attack terminal ───────────────────────────────────────────────────────────

  /**
   * Opens an interactive bash session in the attack machine container by
   * spawning `docker exec -i` and piping its stdout/stderr back to the renderer
   * as 'terminal:data' push events. The renderer's xterm.js instance writes
   * incoming data directly.
   *
   * Only one terminal session is active at a time. Opening a second session
   * automatically closes the previous one.
   *
   * docker exec flags:
   *   -i  — keep stdin open so we can write keystrokes to it
   *   -e  — pass TERM and COLORTERM so bash and tools render colors correctly
   *
   * @param nodeId - Canvas node ID of the attack-machine device to exec into.
   */
  ipcMain.handle('terminal:open', async (_e, { nodeId }: { nodeId: string }) => {
    // Derive the container name the same way compose-generator.ts does
    const sanitized = nodeId.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const containerName = `${activeProjectName}-${sanitized}`

    // Kill any existing session before starting a new one
    if (activeTerminalProcess) {
      activeTerminalProcess.kill()
      activeTerminalProcess = null
    }

    const proc = spawn(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'TERM=xterm-256color',
        '-e',
        'COLORTERM=truecolor',
        containerName,
        '/bin/bash',
        '-l'
      ],
      { env: buildDockerEnv(), stdio: 'pipe' }
    )

    activeTerminalProcess = proc

    // Stream stdout + stderr to the renderer as raw terminal data
    proc.stdout?.on('data', (chunk: Buffer) => {
      mainWindow?.webContents.send('terminal:data', chunk.toString())
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      mainWindow?.webContents.send('terminal:data', chunk.toString())
    })

    proc.on('close', code => {
      mainWindow?.webContents.send('terminal:data', `\r\n[session closed — exit code ${code}]\r\n`)
      if (activeTerminalProcess === proc) activeTerminalProcess = null
    })

    return { ok: true, containerName }
  })

  /**
   * Writes a keystroke or paste payload to the active terminal's stdin.
   * Called by the renderer's xterm.js onData handler for every key press.
   *
   * @param data - Raw string from xterm.js onData (may include escape sequences).
   */
  ipcMain.handle('terminal:write', (_e, { data }: { data: string }) => {
    if (activeTerminalProcess?.stdin) {
      activeTerminalProcess.stdin.write(data)
    }
  })

  /**
   * Closes the active terminal session and kills the docker exec process.
   * Called when the AttackTerminalModal is closed.
   */
  ipcMain.handle('terminal:close', () => {
    if (activeTerminalProcess) {
      activeTerminalProcess.kill()
      activeTerminalProcess = null
    }
  })

  /**
   * Returns the localhost URL for the noVNC web interface of the given attack
   * machine device. The URL points to the websockify bridge running inside the
   * container at the host-published port tracked in activeAttackPorts.
   *
   * @param nodeId - Canvas node ID of the attack-machine device.
   * @returns { url } on success, { error } if the simulation is not running
   *   or the device is not found in the active port map.
   */
  ipcMain.handle('terminal:getVncUrl', (_e, { nodeId }: { nodeId: string }) => {
    const port = activeAttackPorts.get(nodeId)
    if (!port) {
      return { error: 'No noVNC port found — is the simulation running?' }
    }
    // The linuxserver/kali-linux image serves KasmVNC at the root path on port 3000.
    // No path suffix, no query params needed — KasmVNC auto-connects on page load.
    return { url: `http://localhost:${port}/` }
  })

  // ── License (Phase 12 stubs) ──────────────────────────────────────────────────
  // Real license validation is implemented in Phase 12. During development,
  // these stubs return a permissive dev-mode grant so all features are accessible.
  ipcMain.handle('license:validate', async () => ({
    valid: true,
    userId: 'dev-mode',
    packScopes: ['*'] // '*' grants access to all scenario packs
  }))
  ipcMain.handle('license:info', async () => ({
    valid: true,
    userId: 'dev-mode',
    packScopes: ['*']
  }))

  // ── Scenario restoration ──────────────────────────────────────────────────────
  // If the app was closed while a scenario was active (e.g., app crash or system
  // shutdown), restore it to the renderer after the window finishes loading.
  // The 'did-finish-load' event ensures the renderer's event listener is ready.
  loadActiveScenario().then(scenario => {
    if (scenario && mainWindow) {
      mainWindow.webContents.on('did-finish-load', () => {
        mainWindow!.webContents.send('scenario:restored', scenario)
      })
    }
  })

  // ── System info ───────────────────────────────────────────────────────────────
  /** Returns host memory and CPU count for the resource estimator display. */
  ipcMain.handle('system:meminfo', async () => ({
    totalMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMb: Math.round(os.freemem() / 1024 / 1024),
    cpus: os.cpus().length
  }))

  // ── Network settings ──────────────────────────────────────────────────────────

  /**
   * Returns the current NetworkSettings from <userData>/settings.json.
   * Returns { autoDetect: true } on first launch (file not yet created).
   */
  ipcMain.handle('settings:get', async (): Promise<NetworkSettings> => {
    return readSettings()
  })

  /**
   * Persists updated NetworkSettings to <userData>/settings.json.
   * Called when the user clicks Save in the Settings modal.
   *
   * @param settings - Updated settings object from the renderer.
   * @returns { ok: true } on success, { ok: false, error } on write failure.
   */
  ipcMain.handle(
    'settings:set',
    async (_e, settings: NetworkSettings): Promise<{ ok: boolean; error?: string }> => {
      try {
        await writeSettings(settings)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /**
   * Runs subnet auto-detection against the current host network interfaces and
   * returns the computed zone → subnet/gateway map.
   *
   * Called by the Settings modal "Detect" button so users can preview which
   * subnets would be chosen before enabling auto-detect or saving pinned values.
   *
   * Does NOT write to settings.json — the user must click Save to persist.
   *
   * @returns { ok: true, zones } on success where zones is the full zone map.
   */
  ipcMain.handle(
    'settings:detectSubnets',
    (): { ok: boolean; zones?: Record<string, { subnet: string; gateway: string }> } => {
      try {
        const zones = findFreeSubnets(getInUseCidrs())
        return { ok: true, zones }
      } catch {
        return { ok: false }
      }
    }
  )

  // ── Attack Machine window ──────────────────────────────────────────────────────

  /**
   * Opens the attack machine's Kali Linux Xfce4 desktop in a separate Electron
   * BrowserWindow loading the container's noVNC WebSocket interface.
   *
   * The window is a fully independent OS-level window: it can be moved to a second
   * monitor, resized, and operated independently of the main ICS Simulator window.
   * This is intentional — instructors typically put the attack machine on a
   * projector or second display while students view the SCADA canvas on the main screen.
   *
   * noVNC URL parameters:
   *   autoconnect=true — immediately connects to the VNC server without a button click
   *   resize=scale     — scales the Kali desktop to fill the window without scrollbars
   *   No password param — VNC runs with SecurityTypes None inside Docker's isolated network
   *
   * Window security:
   *   sandbox: true + nodeIntegration: false — the noVNC page runs in a fully sandboxed
   *   renderer with no Electron or Node.js access. This is safe because the noVNC page
   *   is served by the Kali container over localhost; it cannot reach the host filesystem.
   *
   * @param nodeId - Canvas node ID of the attack-machine device to open.
   * @returns { ok: true } on success, { ok: false, error } if the simulation is not
   *   running or the device's port mapping was not found.
   */
  ipcMain.handle(
    'attack:launchWindow',
    async (_e, { nodeId }: { nodeId: string }): Promise<{ ok: boolean; error?: string }> => {
      const port = activeAttackPorts.get(nodeId)
      if (!port) {
        return {
          ok: false,
          error: 'No noVNC port found for this attack machine — is the simulation running?'
        }
      }

      // Probe the noVNC websockify port before opening the window.
      // If the container is still starting (image pull, OS boot, VNC server init),
      // the port will be closed and we return a clear message instead of opening a
      // window that immediately shows a "Connection refused" or noVNC error page.
      const ready = await isPortOpen(port)
      if (!ready) {
        return {
          ok: false,
          error:
            `Attack machine is not ready yet (port ${port} is not open). ` +
            'The container may still be pulling its image or starting the VNC server — ' +
            'wait a few seconds and try again.'
        }
      }

      // KasmVNC (linuxserver/kali-linux) serves the XFCE4 desktop at the root path.
      const vncUrl = `http://localhost:${port}/`

      const attackWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: `Attack Machine — ${nodeId}`,
        autoHideMenuBar: true,
        // Dark red background flash-prevention (Kali's default terminal colors)
        backgroundColor: '#1a0000',
        webPreferences: {
          // Full sandbox — the noVNC page needs no Electron APIs
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // webviewTag off — the noVNC page renders directly in the window
          webviewTag: false
        }
      })

      attackWindow.loadURL(vncUrl)

      // Prevent the noVNC page from opening any additional windows
      attackWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      return { ok: true }
    }
  )
}

// ── TCP port connectivity helper ──────────────────────────────────────────────

/**
 * Probes whether a TCP port on localhost is accepting connections.
 *
 * Used by the `attack:launchWindow` handler to verify the attack machine's
 * noVNC websockify server is ready before opening the BrowserWindow. Without
 * this check, the window opens to an immediate "Connection refused" or noVNC
 * "Unable to connect" error if the container is still starting up.
 *
 * @param port    - Host port to probe (e.g., 6900 for the first attack machine).
 * @param timeout - Milliseconds to wait before declaring the port closed (default 2000).
 * @returns true if the port accepted a TCP connection; false otherwise.
 */
function isPortOpen(port: number, timeout = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: 'localhost' })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeout)
    socket.on('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

// ── OpenPLC HTTP API helpers ───────────────────────────────────────────────────
//
// These helpers implement the OpenPLC Runtime v3 web API using Node.js's built-in
// `http` module. The native module is used (rather than global `fetch`) because it
// gives us direct access to individual Set-Cookie headers without the redirect
// handling complexities of the Fetch API's cookie model.
//
// OpenPLC Runtime v3 web API summary (Flask backend):
//   POST /login                  — Form auth: username + password → session cookie
//   POST /upload-program         — Multipart file upload: field name = "file"
//   GET  /start_plc              — Compile uploaded file and start scan cycle
//   GET  /stop_plc               — Halt scan cycle (program remains loaded)
//   GET  /dashboard              — HTML status page (scraped for PLC Status text)
//
// Default credentials installed by install.sh: openplc / openplc
// These are intentionally weak — lab environments rotate them via the web UI.

/**
 * Makes a raw HTTP GET request and returns the response body as a string.
 *
 * @param url - Full URL to GET (http://localhost:PORT/path).
 * @returns Response body text.
 * @throws If the connection is refused or times out.
 */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = ''
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString()
      })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    // 5-second timeout — containers may be slow to respond during startup
    req.setTimeout(5000, () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
  })
}

/**
 * Makes an HTTP POST request with a raw body and returns status code,
 * response headers, and body text.
 *
 * @param options - Node.js http.RequestOptions (host, port, path, headers).
 * @param body    - Request body as a string.
 */
function httpPost(
  options: http.RequestOptions,
  body: string
): Promise<{ statusCode: number; headers: http.IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = ''
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString()
      })
      res.on('end', () =>
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data })
      )
    })
    req.on('error', reject)
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
    req.write(body)
    req.end()
  })
}

/**
 * Deploys a Structured Text program to a running OpenPLC Runtime container.
 *
 * Authentication flow:
 *   1. POST /login with form-encoded credentials → 302 redirect with Set-Cookie
 *   2. All subsequent requests carry the session cookie in the Cookie header
 *
 * Upload flow:
 *   3. POST /upload-program with multipart/form-data body containing the .st file
 *   4. GET /start_plc to recompile and restart the PLC scan cycle
 *
 * The multipart body is constructed manually (without a form-data library) to
 * avoid adding a production runtime dependency to the main process.
 *
 * @param hostPort - Host-side published port for the container's port 8080.
 * @param source   - Raw ST source text (UTF-8, not base64).
 * @param nodeId   - Device node ID, used as the uploaded filename.
 * @returns PLCDeployResult with compiler output or error message.
 */
async function deployToOpenPLC(
  hostPort: number,
  source: string,
  nodeId: string
): Promise<PLCDeployResult> {
  const host = 'localhost'

  // Step 1: Login — POST /login with URL-encoded form body
  const loginBody = `username=openplc&password=openplc`
  const loginResp = await httpPost(
    {
      host,
      port: hostPort,
      path: '/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(loginBody)
      }
    },
    loginBody
  )

  // Extract session cookie from the login response (Flask sets it on the 302 redirect).
  // Node.js types set-cookie as string[] | undefined — it is always an array when present.
  const rawCookie = loginResp.headers['set-cookie']
  const sessionCookie = rawCookie ? rawCookie.map(c => c.split(';')[0]).join('; ') : ''

  if (!sessionCookie) {
    return { ok: false, error: 'Login failed — could not obtain session cookie from OpenPLC.' }
  }

  // Step 2: Upload program — POST /upload-program with multipart/form-data
  // The boundary string separates the multipart body parts.
  const boundary = `----ICSSimBoundary${Date.now()}`
  const filename = `${nodeId}.st`
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `${source}\r\n` +
    `--${boundary}--\r\n`

  const uploadResp = await httpPost(
    {
      host,
      port: hostPort,
      path: '/upload-program',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(multipartBody),
        Cookie: sessionCookie
      }
    },
    multipartBody
  )

  // Step 3: Start PLC — GET /start_plc triggers compile + scan cycle restart
  // The response is an HTML page with compilation output; we extract the log text.
  let compileOutput = ''
  try {
    const startBody = await httpGet(`http://${host}:${hostPort}/start_plc`)
    // Scrape the compile log from the HTML (appears between <pre> tags in OpenPLC v3)
    const preMatch = startBody.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)
    compileOutput = preMatch ? preMatch[1].trim() : ''
  } catch {
    // /start_plc may redirect — treat as success if upload succeeded
  }

  const uploadOk = uploadResp.statusCode < 400
  return {
    ok: uploadOk,
    output: compileOutput || (uploadOk ? 'Program uploaded and PLC restarted.' : undefined),
    error: uploadOk ? undefined : `Upload failed (HTTP ${uploadResp.statusCode})`
  }
}
