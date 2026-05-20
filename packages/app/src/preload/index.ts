/**
 * preload/index.ts — Electron contextBridge preload script.
 *
 * This script runs in a privileged context that has access to both the renderer's
 * DOM and Electron's Node.js APIs (specifically ipcRenderer). Its only job is to
 * expose a typed, controlled API surface to the renderer via contextBridge.
 *
 * Security model:
 *   - The renderer CANNOT import 'electron' or call ipcRenderer directly because
 *     nodeIntegration is false and contextIsolation is true.
 *   - This script acts as a gatekeeper: it exposes exactly the methods the renderer
 *     needs, nothing more. There is no arbitrary IPC passthrough.
 *   - Each method maps 1:1 to an ipcMain.handle() listener in main/index.ts.
 *
 * Renderer access pattern:
 *   window.electronAPI.simulation.start(scenario)
 *   window.electronAPI.docker.check()
 *   window.electronAPI.on.containerStatusUpdate(cb)
 *
 * The `ElectronAPI` type export allows the renderer to declare:
 *   declare global { interface Window { electronAPI: ElectronAPI } }
 * giving full TypeScript completion on `window.electronAPI` calls.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  DockerStatus,
  ScenarioImportResult,
  ScenarioExportResult,
  ScenarioExportOptions,
  ScenarioDeleteFileResult,
  SimulationStartResult,
  SimulationStopResult,
  ContainerStatus,
  LicenseValidationResult,
  OTForgeScenario,
  PLCDeployResult,
  PLCRuntimeStatus,
  PlcImportResult,
  PackInstallResult,
  PackListResult,
  PackUninstallResult
} from '@otforge/schema'

/**
 * The complete API surface exposed to the renderer via window.electronAPI.
 *
 * Grouped by domain to mirror the IPC channel naming convention (<domain>:<action>).
 * All methods return Promises because ipcRenderer.invoke() is always asynchronous.
 */
const api = {
  // ── App metadata ─────────────────────────────────────────────────────────────
  app: {
    /** Returns version strings for the about panel (app version, Electron, Node, platform). */
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    /** Opens a URL in the system's default browser (used for documentation links). */
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', { url })
  },

  // ── Docker health ─────────────────────────────────────────────────────────────
  docker: {
    /**
     * Checks whether Docker Desktop is running.
     * The renderer calls this on mount to enable/disable simulation controls.
     */
    check: (): Promise<DockerStatus> => ipcRenderer.invoke('docker:check'),
    /** Returns the raw `docker --version` string for display in the status bar. */
    version: (): Promise<string> => ipcRenderer.invoke('docker:version')
  },

  // ── Scenario file I/O ─────────────────────────────────────────────────────────
  scenario: {
    /**
     * Opens a native file picker and imports a .otflab scenario file.
     * Validates schema and checks memory requirements before returning.
     */
    import: (): Promise<ScenarioImportResult> => ipcRenderer.invoke('scenario:import'),

    /**
     * Saves the current scenario to a .otflab file.
     * @param scenario - Current canvas scenario state.
     * @param options  - Export options (locked flag, optional file path).
     */
    export: (
      scenario: OTForgeScenario,
      options: ScenarioExportOptions
    ): Promise<ScenarioExportResult> =>
      ipcRenderer.invoke('scenario:export', { scenario, options }),

    /**
     * Validates an in-memory scenario without reading from disk.
     * Used to check a user-built canvas scenario before export.
     */
    validate: (scenario: OTForgeScenario): Promise<{ valid: boolean; errors: string[] }> =>
      ipcRenderer.invoke('scenario:validate', scenario),

    /**
     * Deletes the .otflab file at the given absolute path from disk.
     *
     * Called by the Delete Scenario action in App.tsx after the user confirms.
     * The renderer passes the filePath it received from scenario:import or
     * scenario:export. Returns { ok: false, error } if the file cannot be
     * removed — the renderer clears the canvas regardless.
     *
     * @param filePath - Absolute path returned by scenario:import or scenario:export.
     */
    deleteFile: (filePath: string): Promise<ScenarioDeleteFileResult> =>
      ipcRenderer.invoke('scenario:deleteFile', { filePath })
  },

  // ── Simulation lifecycle ──────────────────────────────────────────────────────
  simulation: {
    /**
     * Generates docker-compose.yml, writes it to disk, and runs `docker compose up`.
     * @param scenario - The full scenario to simulate.
     */
    start: (scenario: OTForgeScenario): Promise<SimulationStartResult> =>
      ipcRenderer.invoke('simulation:start', scenario),

    /**
     * Runs `docker compose down --volumes` to stop and remove all containers.
     */
    stop: (): Promise<SimulationStopResult> => ipcRenderer.invoke('simulation:stop'),

    /**
     * Returns the current state and health of all containers in the active simulation.
     * Returns an empty array when no simulation is running.
     */
    status: (): Promise<ContainerStatus[]> => ipcRenderer.invoke('simulation:status')
  },

  // ── System info ───────────────────────────────────────────────────────────────
  system: {
    /**
     * Returns host memory and CPU count for the resource estimator display.
     * Values are in MB.
     */
    meminfo: (): Promise<{ totalMb: number; freeMb: number; cpus: number }> =>
      ipcRenderer.invoke('system:meminfo')
  },

  // ── Attack terminal ───────────────────────────────────────────────────────────
  terminal: {
    /**
     * Opens an interactive bash session in the named attack-machine container.
     * Stdout/stderr are pushed back to the renderer via the on.terminalData listener.
     *
     * @param nodeId - Canvas node ID of the attack-machine device.
     * @returns { ok, containerName } on success, { ok: false, error } on failure.
     */
    open: (nodeId: string): Promise<{ ok: boolean; containerName?: string; error?: string }> =>
      ipcRenderer.invoke('terminal:open', { nodeId }),

    /**
     * Sends a keystroke or paste payload to the running terminal's stdin.
     * Should be called from xterm.js onData handler on every key event.
     *
     * @param data - Raw string produced by xterm.js (may contain escape sequences).
     */
    write: (data: string): Promise<void> => ipcRenderer.invoke('terminal:write', { data }),

    /**
     * Kills the active terminal session. Should be called when the modal closes.
     */
    close: (): Promise<void> => ipcRenderer.invoke('terminal:close'),

    /**
     * Returns the noVNC URL for the Desktop tab webview.
     * The URL includes autoconnect and scale parameters for seamless embedding.
     *
     * @param nodeId - Canvas node ID of the attack-machine device.
     * @returns { url } on success, { error } if simulation is not running.
     */
    getVncUrl: (nodeId: string): Promise<{ url?: string; error?: string }> =>
      ipcRenderer.invoke('terminal:getVncUrl', { nodeId })
  },

  // ── Monitoring — Loki log query proxy (Phase 6) ──────────────────────────────
  monitor: {
    /**
     * Proxies a Loki query_range request through the main process (avoids CORS).
     * Returns the raw Loki API JSON object on success.
     *
     * @param query  - LogQL expression, e.g. '{job="suricata"} | json | event_type="alert"'
     * @param fromNs - Range start as a nanosecond Unix timestamp string.
     * @param toNs   - Range end as a nanosecond Unix timestamp string.
     * @param limit  - Max log lines to return (default 200).
     */
    getLogs: (
      query: string,
      fromNs: string,
      toNs: string,
      limit?: number
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke('monitor:getLogs', { query, fromNs, toNs, limit })
  },

  // ── License (Phase 12 stubs) ──────────────────────────────────────────────────
  license: {
    /** Validates a license key string. Returns dev-mode grant during development. */
    validate: (key: string): Promise<LicenseValidationResult> =>
      ipcRenderer.invoke('license:validate', { key }),
    /** Returns the current license state without a key argument. */
    info: (): Promise<LicenseValidationResult> => ipcRenderer.invoke('license:info')
  },

  // ── PLC IDE (Phase 4) ─────────────────────────────────────────────────────────
  plc: {
    /**
     * Uploads a Structured Text program to the running OpenPLC container for the
     * given device and triggers recompilation + PLC scan cycle restart.
     *
     * @param nodeId - Canvas node ID of the target PLC device.
     * @param source - Raw ST source text (UTF-8, decoded from base64 storage).
     * @returns PLCDeployResult with compiler output or error message.
     */
    deploy: (nodeId: string, source: string): Promise<PLCDeployResult> =>
      ipcRenderer.invoke('plc:deploy', { nodeId, source }),

    /**
     * Returns the current execution state of the OpenPLC runtime in the given
     * device's container (running vs. stopped/idle).
     *
     * @param nodeId - Canvas node ID of the PLC device to query.
     */
    status: (nodeId: string): Promise<PLCRuntimeStatus> =>
      ipcRenderer.invoke('plc:status', { nodeId }),

    /**
     * Opens a native file picker for PLC project files (.l5x, .xml, .export,
     * .st, .scl) and parses the selected file into one or more importable
     * Structured Text routines. The renderer presents a picker modal when
     * multiple routines are found so the user can choose which to load.
     *
     * @returns PlcImportResult with .routines[] on success, or .error string on failure.
     */
    importProgram: (): Promise<PlcImportResult> => ipcRenderer.invoke('plc:importProgram')
  },

  // ── Network settings ──────────────────────────────────────────────────────────
  settings: {
    /**
     * Returns the current NetworkSettings from <userData>/settings.json.
     * Returns { autoDetect: true } when the file does not exist yet (first launch).
     */
    get: (): Promise<NetworkSettings> => ipcRenderer.invoke('settings:get'),

    /**
     * Persists updated NetworkSettings to <userData>/settings.json.
     * Called when the user clicks Save in the Settings modal.
     *
     * @param settings - Updated settings from the renderer's form state.
     * @returns { ok: true } on success, { ok: false, error } on write failure.
     */
    set: (settings: NetworkSettings): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:set', settings),

    /**
     * Runs subnet auto-detection against the current host interfaces and returns
     * the proposed zone → subnet/gateway map without writing to disk.
     *
     * Used by the Settings modal "Detect" button so users can preview the chosen
     * subnets before deciding whether to save them as pinned values.
     *
     * @returns { ok: true, zones } on success — zones has all four zone keys.
     */
    detectSubnets: (): Promise<{
      ok: boolean
      zones?: Record<string, { subnet: string; gateway: string }>
    }> => ipcRenderer.invoke('settings:detectSubnets')
  },

  // ── HMI window ───────────────────────────────────────────────────────────────
  hmi: {
    /**
     * Opens the FUXA web HMI in a separate Electron BrowserWindow (localhost:1881).
     *
     * FUXA is auto-started as part of every simulation. This call opens its process
     * graphics editor in a standalone OS window that can be moved to a second monitor.
     * Modbus-TCP PLC connections are provisioned automatically by configureFuxa() in
     * the main process after simulation start — no manual FUXA configuration needed.
     *
     * @returns { ok: true } on success, { ok: false, error } if the simulation is not
     *   running or FUXA is not yet accepting connections on port 1881.
     */
    open: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('hmi:open')
  },

  // ── Community scenario packs (Phase 9) ───────────────────────────────────────
  packs: {
    /**
     * Opens a native file picker for .otfpack ZIP files, extracts the pack to
     * <userData>/packs/<packId>/, validates the manifest, and returns the resolved
     * InstalledPack with pre-loaded icon data URLs ready for display.
     *
     * Overwrites any previously installed pack with the same id (version upgrade).
     *
     * @returns PackInstallResult with the new InstalledPack on success.
     */
    install: (): Promise<PackInstallResult> => ipcRenderer.invoke('pack:install'),

    /**
     * Returns all packs currently installed in <userData>/packs/.
     * Device type icons are pre-loaded as base64 data URLs — no file I/O in renderer.
     */
    list: (): Promise<PackListResult> => ipcRenderer.invoke('pack:list'),

    /**
     * Removes an installed pack and all its assets from disk.
     *
     * @param packId - The pack id string from its manifest (folder name in packs dir).
     */
    uninstall: (packId: string): Promise<PackUninstallResult> =>
      ipcRenderer.invoke('pack:uninstall', { packId }),

    /**
     * Loads a bundled .otflab scenario from the given pack and returns it as a
     * ScenarioImportResult so the renderer can open it immediately.
     *
     * @param packId       - Pack id from the manifest.
     * @param relativePath - Scenario path relative to the pack root (from manifest.scenarios).
     */
    openScenario: (packId: string, relativePath: string): Promise<ScenarioImportResult> =>
      ipcRenderer.invoke('pack:openScenario', { packId, relativePath })
  },

  // ── Clipboard ─────────────────────────────────────────────────────────────────
  // Both methods use Electron's native clipboard module (not the Web Clipboard API)
  // so they work reliably in the non-HTTPS Electron renderer context.
  clipboard: {
    /**
     * Reads the system clipboard as plain text via Electron's native clipboard
     * module. Bypasses navigator.clipboard.readText() permission requirements.
     *
     * Used by AttackTerminalModal on Ctrl+V to paste host clipboard content into
     * the docker exec stdin (xterm.js terminal).
     */
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText'),

    /**
     * Writes plain text to the system clipboard via Electron's native clipboard
     * module. Bypasses navigator.clipboard.writeText() permission requirements so
     * copied text is always available to clipboard:readText in the terminal.
     *
     * Used by TutorialPanel's Copy button so commands paste correctly into the
     * attack terminal without the student needing to type them manually.
     *
     * @param text - The string to place on the system clipboard.
     */
    writeText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:writeText', { text })
  },

  // ── Attack Machine window ────────────────────────────────────────────────────
  attack: {
    /**
     * Opens the attack machine's Kali Linux Xfce4 desktop in a separate Electron
     * BrowserWindow that loads the noVNC WebSocket interface. The window is a native
     * OS window that can be freely moved to a second monitor, resized, or minimised
     * independently of the main simulator window.
     *
     * Only callable while the simulation is running. If the attack-machine container
     * has not yet been assigned a noVNC host port by the compose generator, the call
     * returns { ok: false, error } instead of opening a window.
     *
     * @param nodeId - Canvas node ID of the attack-machine device.
     * @returns { ok: true } on success, { ok: false, error } on failure.
     */
    launchWindow: (nodeId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('attack:launchWindow', { nodeId }),

    /**
     * Pushes the current host clipboard text into the open noVNC desktop session
     * for the given attack machine.
     *
     * Injects the text into noVNC's built-in clipboard textarea (#noVNC_clipboard_text)
     * and dispatches a 'change' event, which triggers rfb.clipboardPasteFrom() via
     * the RFB ClientCutText message. The text then becomes available as the guest X11
     * CLIPBOARD selection — paste in the Kali terminal with Ctrl+Shift+V.
     *
     * @param nodeId - Canvas node ID of the attack-machine device.
     * @returns { ok: true } on success; { ok: false, error } if the window is not
     *   open, the clipboard is empty, or the noVNC element is not yet in the DOM.
     */
    pasteClipboard: (nodeId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('attack:pasteClipboard', { nodeId })
  },

  // ── One-way push events from main → renderer ──────────────────────────────────
  // These listeners attach to ipcRenderer events and return an unsubscribe function
  // so the renderer can clean up in a useEffect return.
  on: {
    /**
     * Fires whenever a container's status changes (health check result, restart, exit).
     * @param cb - Callback that receives the updated ContainerStatus.
     * @returns Unsubscribe function — call in useEffect cleanup.
     */
    containerStatusUpdate: (cb: (status: ContainerStatus) => void) => {
      ipcRenderer.on('container:statusUpdate', (_event, status) => cb(status))
      return () => ipcRenderer.removeAllListeners('container:statusUpdate')
    },

    /**
     * Fires when the main process receives a log line from a running container.
     * @param cb - Callback receiving { nodeId, level, message }.
     * @returns Unsubscribe function.
     */
    simulationLog: (cb: (log: { nodeId: string; level: string; message: string }) => void) => {
      ipcRenderer.on('simulation:log', (_event, log) => cb(log))
      return () => ipcRenderer.removeAllListeners('simulation:log')
    },

    /**
     * Fires when Docker Desktop crashes or becomes unreachable during a simulation.
     * @param cb - Callback receiving { message }.
     * @returns Unsubscribe function.
     */
    dockerError: (cb: (err: { message: string }) => void) => {
      ipcRenderer.on('docker:error', (_event, err) => cb(err))
      return () => ipcRenderer.removeAllListeners('docker:error')
    },

    /**
     * Fires for each chunk of stdout/stderr from the active terminal session.
     * The callback should be wired to xterm.js terminal.write() so output
     * appears in the terminal as it arrives.
     *
     * @param cb - Callback receiving the raw terminal data string.
     * @returns Unsubscribe function — call in useEffect cleanup.
     */
    terminalData: (cb: (data: string) => void) => {
      ipcRenderer.on('terminal:data', (_event, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('terminal:data')
    },

    /**
     * Fires when the main process detects that a docker compose up operation will
     * need to pull container images that are not yet cached locally.
     *
     * { pulling: true }  — sent before docker compose up starts pulling images.
     *                      The renderer should show an "Importing Containers" overlay.
     * { pulling: false } — sent after all images are confirmed present locally.
     *                      The renderer can hide the overlay (simStatus will also
     *                      transition away from 'starting' shortly after).
     *
     * @param cb - Callback receiving { pulling: boolean }
     * @returns Unsubscribe function — call in useEffect cleanup.
     */
    simulationPullStatus: (cb: (status: { pulling: boolean }) => void) => {
      ipcRenderer.on('simulation:pullStatus', (_event, status) => cb(status))
      return () => ipcRenderer.removeAllListeners('simulation:pullStatus')
    }
  }
}

// Expose the API to the renderer under window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', api)

/**
 * Persisted network configuration for Docker subnet assignment.
 *
 * This type must stay structurally identical to the NetworkSettings interface
 * in main/index.ts and the local type in SettingsModal.tsx (TypeScript structural
 * typing means they're compatible, but keeping them in sync avoids confusion).
 *
 * autoDetect:    When true, findFreeSubnets() picks conflict-free /24 subnets at
 *                simulation start. When false, pinnedSubnets are used instead.
 * pinnedSubnets: User-configured zone → subnet/gateway map. All four zones should
 *                be present; missing zones fall back to ZONE_DEFAULTS in the main process.
 */
export interface NetworkSettings {
  autoDetect: boolean
  pinnedSubnets?: Record<string, { subnet: string; gateway: string }>
}

/**
 * TypeScript type for `window.electronAPI`.
 *
 * The renderer declares `declare global { interface Window { electronAPI: ElectronAPI } }`
 * using this export so that all `window.electronAPI.*` calls are fully typed.
 */
export type ElectronAPI = typeof api
