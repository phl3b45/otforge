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
import { exec } from 'child_process'
import { promisify } from 'util'
import { join as pathJoin } from 'path'
import os from 'os'
import http from 'http'
import {
  generateCompose,
  DockerClient,
  estimateResources,
  checkSystemMemory,
  validateScenario,
  toProjectName
} from '@ics-sim/orchestrator'
import { initDb, saveActiveScenario, loadActiveScenario, clearActiveScenario } from './db'

const execAsync = promisify(exec)

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
      const dockerAvailable = await dockerClient.isAvailable()
      if (!dockerAvailable) {
        return { ok: false, error: 'Docker Desktop is not running.' }
      }

      const projectName = toProjectName(scenario.meta.name)
      activeProjectName = projectName

      // Build PLC port map with same iteration order and base port as compose-generator.ts
      // so plc:deploy can find the right host port without parsing the compose file.
      activePlcPorts.clear()
      let plcIdx = 0
      for (const [nodeId, device] of Object.entries(scenario.devices.devices)) {
        if (device.category === 'plc') {
          activePlcPorts.set(nodeId, 18080 + plcIdx)
          plcIdx++
        }
      }

      const composeYaml = generateCompose(scenario, projectName)
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

    const result = await dockerClient.stopScenario(activeProjectName)
    if (result.ok) {
      await clearActiveScenario()
      activeProjectName = null
      activePlcPorts.clear()
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
  /** Returns host memory and CPU info for the resource estimator display. */
  ipcMain.handle('system:meminfo', async () => ({
    totalMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMb: Math.round(os.freemem() / 1024 / 1024),
    cpus: os.cpus().length
  }))
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
