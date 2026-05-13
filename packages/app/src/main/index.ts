import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type {
  AppInfo,
  DockerStatus,
  ScenarioImportResult,
  ScenarioExportResult,
  ScenarioExportOptions
} from '@ics-sim/schema'
import { readFile, writeFile } from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Electron's child processes don't inherit the full user PATH on Windows.
// Build an augmented PATH that includes all common Docker installation locations.
const DOCKER_PATHS: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Docker\\Docker\\resources\\bin',
    'C:\\ProgramData\\DockerDesktop\\version-bin',
    'C:\\Program Files\\Docker\\cli-plugins'
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
  return {
    ...process.env,
    PATH: `${extra}${sep}${process.env.PATH ?? ''}`
  }
}

let mainWindow: BrowserWindow | null = null

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
      webviewTag: true // needed to embed Grafana, FUXA via <webview>
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

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

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()
  registerIPCHandlers()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

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

  ipcMain.handle('app:openExternal', async (_event, { url }: { url: string }) => {
    await shell.openExternal(url)
  })

  // Docker availability check
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

  // Scenario import — opens file picker, reads and parses .icslab JSON
  ipcMain.handle('scenario:import', async (): Promise<ScenarioImportResult> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import ICS Scenario',
      filters: [{ name: 'ICS Lab Scenario', extensions: ['icslab'] }],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'Import cancelled' }
    }

    try {
      const raw = await readFile(result.filePaths[0], 'utf-8')
      const scenario = JSON.parse(raw)
      return { ok: true, scenario }
    } catch (err) {
      return { ok: false, error: `Failed to parse scenario: ${(err as Error).message}` }
    }
  })

  // Scenario export — serializes scenario to .icslab JSON, with locked flag
  ipcMain.handle(
    'scenario:export',
    async (
      _event,
      { scenario, options }: { scenario: unknown; options: ScenarioExportOptions }
    ): Promise<ScenarioExportResult> => {
      let targetPath = options.filePath

      if (!targetPath) {
        const result = await dialog.showSaveDialog(mainWindow!, {
          title: 'Export ICS Scenario',
          filters: [{ name: 'ICS Lab Scenario', extensions: ['icslab'] }],
          defaultPath: 'scenario.icslab'
        })

        if (result.canceled || !result.filePath) {
          return { ok: false, error: 'Export cancelled' }
        }
        targetPath = result.filePath
      }

      try {
        const data = JSON.stringify(scenario, null, 2)
        await writeFile(targetPath, data, 'utf-8')
        return { ok: true, filePath: targetPath }
      } catch (err) {
        return { ok: false, error: `Failed to write scenario: ${(err as Error).message}` }
      }
    }
  )

  // Simulation lifecycle stubs — implemented in Phase 1 (orchestrator package)
  ipcMain.handle('simulation:start', async () => ({
    ok: false,
    error: 'Simulation engine not yet implemented (Phase 1)'
  }))

  ipcMain.handle('simulation:stop', async () => ({
    ok: false,
    error: 'Simulation engine not yet implemented (Phase 1)'
  }))

  ipcMain.handle('simulation:status', async () => [])

  // License stubs — implemented in Phase 12
  ipcMain.handle('license:validate', async () => ({
    valid: true,
    userId: 'dev-mode',
    packScopes: ['*'],
    error: undefined
  }))

  ipcMain.handle('license:info', async () => ({
    valid: true,
    userId: 'dev-mode',
    packScopes: ['*']
  }))
}
