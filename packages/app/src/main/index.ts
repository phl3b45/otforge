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
  ICSLabScenario
} from '@ics-sim/schema'
import { readFile, writeFile, access } from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join as pathJoin } from 'path'
import os from 'os'
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

function buildDockerEnv(): NodeJS.ProcessEnv {
  const extra = (DOCKER_PATHS[process.platform] ?? []).join(
    process.platform === 'win32' ? ';' : ':'
  )
  const sep = process.platform === 'win32' ? ';' : ':'
  return { ...process.env, PATH: `${extra}${sep}${process.env.PATH ?? ''}` }
}

const DOCKER_DOWNLOAD_URLS: Record<string, string> = {
  win32: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
  darwin: 'https://desktop.docker.com/mac/main/arm64/Docker.dmg',
  linux: 'https://docs.docker.com/desktop/install/linux/'
}

async function isFirstLaunch(): Promise<boolean> {
  const flagPath = pathJoin(app.getPath('userData'), '.launched')
  try {
    await access(flagPath)
    return false
  } catch {
    await writeFile(flagPath, '1', 'utf-8')
    return true
  }
}

async function checkDocker(): Promise<{ available: boolean }> {
  try {
    await execAsync('docker version --format "{{.Server.Version}}"', { env: buildDockerEnv() })
    return { available: true }
  } catch {
    return { available: false }
  }
}

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

let mainWindow: BrowserWindow | null = null
let dockerClient: DockerClient
let activeProjectName: string | null = null

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const userData = app.getPath('userData')

  // Init LevelDB working store
  initDb(userData)

  // Init Docker client
  dockerClient = new DockerClient(userData)

  createWindow()
  registerIPCHandlers()

  const [first, dockerStatus] = await Promise.all([isFirstLaunch(), checkDocker()])
  if (first && !dockerStatus.available) {
    showDockerInstallPrompt()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Window ─────────────────────────────────────────────────────────────────────

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

  mainWindow.on('ready-to-show', () => mainWindow!.show())

  mainWindow.webContents.setWindowOpenHandler(details => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── IPC handlers ───────────────────────────────────────────────────────────────

function registerIPCHandlers(): void {
  // App info
  ipcMain.handle(
    'app:info',
    (): AppInfo => ({
      version: app.getVersion(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      platform: process.platform as AppInfo['platform']
    })
  )

  ipcMain.handle('app:openExternal', async (_e, { url }: { url: string }) => {
    await shell.openExternal(url)
  })

  // Docker check
  ipcMain.handle('docker:check', async (): Promise<DockerStatus> => {
    try {
      const { stdout } = await execAsync('docker version --format "{{.Server.Version}}"', {
        env: buildDockerEnv()
      })
      return { available: true, version: stdout.trim() }
    } catch (err) {
      const msg = (err as Error).message ?? ''
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

  ipcMain.handle('docker:version', async (): Promise<string> => {
    try {
      const { stdout } = await execAsync('docker --version', { env: buildDockerEnv() })
      return stdout.trim()
    } catch {
      return 'unavailable'
    }
  })

  // Scenario import — validate, estimate resources, warn if needed, store in LevelDB
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

    // Validate schema
    const { validateScenario: validate } = await import('@ics-sim/orchestrator')
    const validation = validate(raw)
    if (!validation.valid) {
      return { ok: false, error: `Invalid scenario:\n${validation.errors.join('\n')}` }
    }

    const scenario = raw as ICSLabScenario
    const resourceEstimate = estimateResources(scenario)
    const memCheck = checkSystemMemory(resourceEstimate)

    // Warn if scenario will consume more than 60% of free RAM
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
        defaultId: memCheck.criticalThreshold ? 1 : 0,
        cancelId: 1
      })
      if (response === 1) return { ok: false, error: 'Import cancelled' }
    }

    await saveActiveScenario(scenario)
    return { ok: true, scenario, resourceEstimate }
  })

  // Scenario validate (without file picker — validates an in-memory scenario)
  ipcMain.handle('scenario:validate', async (_e, scenario: unknown) => {
    return validateScenario(scenario)
  })

  // Scenario export
  ipcMain.handle(
    'scenario:export',
    async (
      _e,
      { scenario, options }: { scenario: ICSLabScenario; options: ScenarioExportOptions }
    ): Promise<ScenarioExportResult> => {
      let targetPath = options.filePath

      if (!targetPath) {
        const result = await dialog.showSaveDialog(mainWindow!, {
          title: 'Export ICS Scenario',
          filters: [{ name: 'ICS Lab Scenario', extensions: ['icslab'] }],
          defaultPath: `${scenario.meta.name.replace(/\s+/g, '-')}.icslab`
        })
        if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled' }
        targetPath = result.filePath
      }

      // Locked scenarios omit visual and security layers
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

  // Simulation start — generate compose, write to disk, docker compose up
  ipcMain.handle(
    'simulation:start',
    async (_e, scenario: ICSLabScenario): Promise<SimulationStartResult> => {
      const dockerAvailable = await dockerClient.isAvailable()
      if (!dockerAvailable) {
        return { ok: false, error: 'Docker Desktop is not running.' }
      }

      const projectName = toProjectName(scenario.meta.name)
      activeProjectName = projectName

      const composeYaml = generateCompose(scenario, projectName)
      const result = await dockerClient.startScenario(projectName, composeYaml)

      if (!result.ok) {
        activeProjectName = null
        return { ok: false, error: result.error }
      }

      // Brief delay then report which containers started
      await new Promise(resolve => setTimeout(resolve, 2000))
      const statuses = await dockerClient.getStatus(projectName)
      const started = statuses.filter(s => s.status === 'running').map(s => s.nodeId)

      return { ok: true, containersStarted: started }
    }
  )

  // Simulation stop
  ipcMain.handle('simulation:stop', async (): Promise<SimulationStopResult> => {
    if (!activeProjectName) return { ok: false, error: 'No simulation is running' }

    const result = await dockerClient.stopScenario(activeProjectName)
    if (result.ok) {
      await clearActiveScenario()
      activeProjectName = null
    }
    return result
  })

  // Container status poll
  ipcMain.handle('simulation:status', async (): Promise<ContainerStatus[]> => {
    if (!activeProjectName) return []
    return dockerClient.getStatus(activeProjectName)
  })

  // License stubs — implemented Phase 12
  ipcMain.handle('license:validate', async () => ({
    valid: true,
    userId: 'dev-mode',
    packScopes: ['*']
  }))
  ipcMain.handle('license:info', async () => ({
    valid: true,
    userId: 'dev-mode',
    packScopes: ['*']
  }))

  // Restore active scenario on startup if one was running before app closed
  loadActiveScenario().then(scenario => {
    if (scenario && mainWindow) {
      mainWindow.webContents.on('did-finish-load', () => {
        mainWindow!.webContents.send('scenario:restored', scenario)
      })
    }
  })

  // System info for renderer
  ipcMain.handle('system:meminfo', async () => ({
    totalMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMb: Math.round(os.freemem() / 1024 / 1024),
    cpus: os.cpus().length
  }))
}
