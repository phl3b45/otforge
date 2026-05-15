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
  SimulationStartResult,
  SimulationStopResult,
  ContainerStatus,
  LicenseValidationResult,
  ICSLabScenario,
  PLCDeployResult,
  PLCRuntimeStatus
} from '@ics-sim/schema'

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
     * Opens a native file picker and imports a .icslab scenario file.
     * Validates schema and checks memory requirements before returning.
     */
    import: (): Promise<ScenarioImportResult> => ipcRenderer.invoke('scenario:import'),

    /**
     * Saves the current scenario to a .icslab file.
     * @param scenario - Current canvas scenario state.
     * @param options  - Export options (locked flag, optional file path).
     */
    export: (
      scenario: ICSLabScenario,
      options: ScenarioExportOptions
    ): Promise<ScenarioExportResult> =>
      ipcRenderer.invoke('scenario:export', { scenario, options }),

    /**
     * Validates an in-memory scenario without reading from disk.
     * Used to check a user-built canvas scenario before export.
     */
    validate: (scenario: ICSLabScenario): Promise<{ valid: boolean; errors: string[] }> =>
      ipcRenderer.invoke('scenario:validate', scenario)
  },

  // ── Simulation lifecycle ──────────────────────────────────────────────────────
  simulation: {
    /**
     * Generates docker-compose.yml, writes it to disk, and runs `docker compose up`.
     * @param scenario - The full scenario to simulate.
     */
    start: (scenario: ICSLabScenario): Promise<SimulationStartResult> =>
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
      ipcRenderer.invoke('plc:status', { nodeId })
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
    }
  }
}

// Expose the API to the renderer under window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', api)

/**
 * TypeScript type for `window.electronAPI`.
 *
 * The renderer declares `declare global { interface Window { electronAPI: ElectronAPI } }`
 * using this export so that all `window.electronAPI.*` calls are fully typed.
 */
export type ElectronAPI = typeof api
