/**
 * App.tsx — Root React component and application shell.
 *
 * Manages the top-level application state and renders one of two views:
 *   - LaunchScreen: shown on startup, checks Docker status, offers New/Open actions
 *   - Canvas view: the full editor shell (toolbar + SCADA canvas + properties panel + status bar)
 *
 * State owned here:
 *   - view:              'launch' | 'canvas' — which top-level screen to show
 *   - appInfo:           Electron version metadata (displayed in launch screen)
 *   - docker:            Docker status (available, version, error message)
 *   - scenario:          The active ICSLabScenario document (null = no scenario loaded)
 *   - selectedDevice:    The device config for the currently selected canvas node
 *   - selectedZone:      The zone key for the selected node (for PropertiesPanel color)
 *   - simStatus:         The simulation lifecycle state machine
 *   - containerStatuses: Live container health data from Docker Compose ps
 *   - showMonitor:       Whether the Grafana+Loki monitor panel drawer is open
 *
 * Simulation status state machine:
 *   idle ──→ starting ──→ running ──→ stopping ──→ idle
 *
 * IPC flow:
 *   All Docker/scenario/simulation operations call window.electronAPI (contextBridge),
 *   which proxies to ipcMain handlers in main/index.ts via ipcRenderer.invoke().
 */

import { useEffect, useState, useCallback } from 'react'
import type {
  AppInfo,
  DockerStatus,
  ICSLabScenario,
  ICSLabMeta,
  DeviceConfig,
  ContainerStatus,
  PLCProgramConfig,
  NetworkZone,
  SecurityLayer
} from '@ics-sim/schema'
import { ScadaCanvas } from './canvas/ScadaCanvas'
import { DevicePalette } from './palette/DevicePalette'
import { LayerTabBar } from './canvas/LayerTabBar'
import { PropertiesPanel } from './properties/PropertiesPanel'
import { PlcIdePanel } from './properties/PlcIdePanel'
import { AttackTerminalModal } from './terminal/AttackTerminalModal'
import { MonitorPanel } from './monitor/MonitorPanel'
import { SettingsModal } from './settings/SettingsModal'
import { MetadataModal } from './metadata/MetadataModal'
import { ExportModal } from './export/ExportModal'
import { MissionPanel } from './mission/MissionPanel'
import './index.css'

/**
 * Simulation lifecycle states.
 *   idle     — no simulation running; controls enabled
 *   starting — `docker compose up` in progress; controls disabled
 *   running  — all containers healthy; Stop button active
 *   stopping — `docker compose down` in progress; controls disabled
 */
type SimStatus = 'idle' | 'starting' | 'running' | 'stopping'

// ── Launch screen ──────────────────────────────────────────────────────────────

/**
 * First screen shown when the app opens.
 *
 * Displays Docker availability status and version info. The New Scenario and
 * Open .icslab buttons are disabled until Docker is confirmed running, because
 * a simulation cannot start without Docker Desktop.
 *
 * @param docker   - Docker status from the main process (null while checking).
 * @param appInfo  - Electron/Node version info for the status row.
 * @param onImport - Opens the native file picker to import a .icslab scenario.
 * @param onNew    - Creates a blank canvas and transitions to the canvas view.
 */
function LaunchScreen({
  docker,
  appInfo,
  onImport,
  onNew
}: {
  docker: DockerStatus | null
  appInfo: AppInfo | null
  onImport: () => void
  onNew: () => void
}) {
  return (
    <div className="launch-screen">
      <div className="launch-content">
        <div className="logo-mark">
          <span className="logo-bracket">[</span>
          <span className="logo-text">ICS</span>
          <span className="logo-bracket">]</span>
        </div>
        <h1>ICS Simulator</h1>
        <p className="tagline">ICS/SCADA Security Research &amp; Education Platform</p>

        {/* Docker and app version status indicators */}
        <div className="launch-status">
          <div className="status-row">
            <span className={`status-dot ${docker?.available ? 'ok' : 'error'}`} />
            <span>
              Docker:{' '}
              {docker === null
                ? 'Checking…'
                : docker.available
                  ? `Ready (v${docker.version})`
                  : (docker.message ?? 'Not available')}
            </span>
          </div>
          {appInfo && (
            <div className="status-row">
              <span className="status-dot ok" />
              <span>
                v{appInfo.version} · Electron {appInfo.electronVersion} · {appInfo.platform}
              </span>
            </div>
          )}
        </div>

        <div className="launch-actions">
          {/* Buttons disabled until Docker is ready to prevent attempting to start without it */}
          <button className="btn btn-primary btn-lg" onClick={onNew} disabled={!docker?.available}>
            New Scenario
          </button>
          <button
            className="btn btn-secondary btn-lg"
            onClick={onImport}
            disabled={!docker?.available}
          >
            Open .icslab File
          </button>
        </div>

        {!docker?.available && docker !== null && (
          <p className="launch-warning">Docker Desktop must be running to use the simulator.</p>
        )}
      </div>
    </div>
  )
}

// ── Toolbar ────────────────────────────────────────────────────────────────────

/**
 * Top application toolbar with scenario identity, simulation status badge,
 * and simulation controls.
 *
 * TypeScript note:
 *   Boolean flags (isIdle, isRunning, etc.) are pre-computed BEFORE the JSX so
 *   TypeScript does not narrow `simStatus` inside ternary branches. When TypeScript
 *   sees `canStop = simStatus === 'running' || simStatus === 'starting'`, it narrows
 *   `simStatus` inside the branches — making `simStatus === 'stopping'` always-false
 *   on the false branch. Pre-computed booleans avoid this narrowing entirely.
 *
 * @param scenario           - Current scenario (null for blank canvas).
 * @param simStatus          - Current simulation lifecycle state.
 * @param docker             - Docker status (used to enable/disable the Run button).
 * @param appMode            - 'author' or 'student' — determines which toolbar actions are shown.
 * @param showMonitor        - Whether the monitor panel drawer is currently open.
 * @param onImport           - Opens the file picker.
 * @param onNew              - Clears the canvas for a new scenario.
 * @param onStart            - Starts the simulation.
 * @param onStop             - Stops the simulation.
 * @param onHome             - Returns to the launch screen (disabled while running).
 * @param onMonitorToggle    - Toggles the Grafana+Loki monitor panel open/closed.
 * @param onSettingsOpen     - Opens the Network Settings modal.
 * @param onDelete           - Clears all devices and resets the scenario after confirmation.
 * @param onAttackMachineAdd - Adds an attack machine device to the current scenario.
 * @param onAttackMachineLaunch - Opens the attack machine OS window.
 * @param onHmiOpen          - Opens the FUXA HMI in a separate OS window.
 * @param onMetadataOpen     - Opens the Scenario Metadata editor modal (Author mode only).
 * @param onExportOpen       - Opens the Export dialog (Author mode only).
 */
function Toolbar({
  scenario,
  simStatus,
  docker,
  showGrid,
  showMonitor,
  appMode,
  onImport,
  onNew,
  onDelete,
  onStart,
  onStop,
  onHome,
  onGridToggle,
  onMonitorToggle,
  onSettingsOpen,
  onAttackMachineAdd,
  onAttackMachineLaunch,
  onHmiOpen,
  onMetadataOpen,
  onExportOpen
}: {
  scenario: ICSLabScenario | null
  simStatus: SimStatus
  docker: DockerStatus | null
  /**
   * Whether the 25 × 25 snap grid is currently visible.
   * False is passed during simulation so the grid toggle disappears entirely;
   * the underlying showGrid state in App is preserved for when idle resumes.
   */
  showGrid: boolean
  /** Whether the Grafana+Loki monitor drawer is open. Used to style the toggle button. */
  showMonitor: boolean
  /** Current app mode — 'author' for unlocked scenarios, 'student' for locked ones. */
  appMode: 'author' | 'student'
  onImport: () => void
  onNew: () => void
  /** Clears all devices and resets the current scenario after a confirmation prompt. */
  onDelete: () => void
  onStart: () => void
  onStop: () => void
  onHome: () => void
  /** Toggles the snap grid on/off. */
  onGridToggle: () => void
  /** Toggles the monitor panel open or closed. Only callable when sim is running. */
  onMonitorToggle: () => void
  /** Opens the Network Settings modal for subnet configuration. */
  onSettingsOpen: () => void
  /** Adds a default attack machine device to the current scenario. */
  onAttackMachineAdd: () => void
  /**
   * Opens the attack machine's Xfce4 desktop in a separate OS window via noVNC.
   * Only callable when simulation is running and an attack machine is in the scenario.
   *
   * @param nodeId - Canvas node ID of the attack-machine device to launch.
   */
  onAttackMachineLaunch: (nodeId: string) => void
  /**
   * Opens the FUXA process HMI in a separate Electron BrowserWindow (localhost:1881).
   * FUXA always runs as simulation infrastructure — this button is shown whenever
   * the simulation is running so users can inspect live process data.
   */
  onHmiOpen: () => void
  /** Opens the Scenario Metadata editor. Only available in Author mode while idle. */
  onMetadataOpen: () => void
  /** Opens the Export dialog. Only available in Author mode while idle. */
  onExportOpen: () => void
}) {
  const scenarioName = scenario?.meta.name ?? 'Untitled Scenario'
  const deviceCount = scenario ? Object.keys(scenario.devices.devices).length : 0

  // Pre-compute booleans to prevent TypeScript narrowing inside JSX ternaries
  const isIdle = simStatus === 'idle'
  const isStarting = simStatus === 'starting'
  const isRunning = simStatus === 'running'
  const isStopping = simStatus === 'stopping'
  // showStop controls which button variant appears in the toolbar right section
  const showStop = isRunning || isStarting
  const canStart = !!docker?.available && !!scenario && deviceCount > 0 && isIdle
  const startTitle = !docker?.available
    ? 'Docker is not running'
    : deviceCount === 0
      ? 'Add at least one device'
      : ''
  // Monitor button is only meaningful when the simulation is running
  const canMonitor = isRunning
  // Settings button is always available (network config applies to the next simulation start)
  const canOpenSettings = !isStarting && !isStopping

  // Find any attack-machine devices in the current scenario
  const attackDevices = scenario
    ? Object.entries(scenario.devices.devices).filter(([, d]) => d.category === 'attack-machine')
    : []
  const hasAttackMachine = attackDevices.length > 0
  // First attack machine nodeId — used by the Launch button when simulation is running
  const firstAttackNodeId = attackDevices[0]?.[0] ?? null

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        {/* Logo acts as a home button */}
        <button className="toolbar-logo" onClick={onHome} title="Home">
          <span className="logo-bracket">[</span>
          <span className="logo-text-sm">ICS</span>
          <span className="logo-bracket">]</span>
        </button>
        <div className="toolbar-scenario">
          <span className="toolbar-scenario-name">{scenarioName}</span>
          {deviceCount > 0 && (
            <span className="toolbar-scenario-meta">
              {deviceCount} device{deviceCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Centered simulation status badge + mode badge */}
      <div className="toolbar-center">
        <SimStatusBadge status={simStatus} />
        {scenario && (
          <div className={`mode-badge mode-badge-${appMode}`}>
            {appMode === 'student' ? '🔒 Student Mode' : '✎ Author Mode'}
          </div>
        )}
      </div>

      <div className="toolbar-right">
        <button className="btn btn-sm btn-ghost" onClick={onNew} title="New scenario">
          New
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onImport} title="Open .icslab file">
          Open
        </button>

        {/*
         * Metadata — edit scenario name, description, author, sector, mission brief.
         * Only visible to the instructor (Author mode) while idle.
         */}
        {isIdle && scenario && appMode === 'author' && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={onMetadataOpen}
            title="Edit scenario name, description, and mission brief"
          >
            Metadata
          </button>
        )}

        {/*
         * Export — choose Author Copy (full) or Student Copy (locked, stripped).
         * Only visible to the instructor (Author mode) while idle with a scenario loaded.
         */}
        {isIdle && scenario && appMode === 'author' && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={onExportOpen}
            title="Export scenario as Author Copy or Student Copy"
          >
            Export
          </button>
        )}

        {/*
         * Delete scenario — only visible when idle with a scenario loaded in Author mode.
         * Asks for confirmation before clearing all devices so accidental clicks
         * don't lose unsaved work.
         */}
        {isIdle && scenario && appMode === 'author' && (
          <button
            className="btn btn-sm btn-ghost btn-delete-scenario"
            onClick={onDelete}
            title="Clear all devices and reset this scenario"
          >
            Delete Scenario
          </button>
        )}

        {/*
         * Grid toggle — only shown in Author mode while idle (students cannot edit,
         * so a snap grid has no utility for them). The grid is always 25 × 25 cells.
         */}
        {isIdle && appMode === 'author' && (
          <button
            className={`btn btn-sm ${showGrid ? 'btn-secondary' : 'btn-ghost'}`}
            onClick={onGridToggle}
            title={showGrid ? 'Hide 25 × 25 snap grid' : 'Show 25 × 25 snap grid'}
          >
            Grid
          </button>
        )}

        {/*
         * Open HMI — only shown while simulation is running.
         * Opens the FUXA process HMI in a standalone window (localhost:1881).
         * FUXA is always started as simulation infrastructure and is automatically
         * provisioned with Modbus connections to PLCs in the scenario (via
         * configureFuxa() in the main process).
         */}
        {isRunning && (
          <button
            className="btn btn-sm btn-hmi"
            onClick={onHmiOpen}
            title="Open FUXA process HMI — live Modbus data from PLCs"
          >
            Open HMI
          </button>
        )}

        {/*
         * Monitor toggle — only shown while simulation is running.
         * Opens/closes the Grafana + Live Logs drawer below the canvas.
         * .active class adds a teal ring so operators know the panel is open.
         */}
        {canMonitor && (
          <button
            className={`btn btn-sm btn-monitor ${showMonitor ? 'active' : ''}`}
            onClick={onMonitorToggle}
            title={showMonitor ? 'Hide monitor panel' : 'Open Grafana + Live Logs monitor'}
          >
            Monitor
          </button>
        )}

        {/*
         * Attack Machine section — two-state button:
         *   idle + no attack machine  → "Add Attack Machine" adds a default kali device
         *   idle + attack machine     → shows "⚔ Attack Machine" as an indicator (disabled)
         *   running + attack machine  → "Launch Attack Machine" opens a separate OS window
         *
         * The attack machine is intentionally excluded from the Purdue layer canvas tabs.
         * Instructors add it here; students launch it from this button when the sim runs.
         */}
        {isRunning && hasAttackMachine && firstAttackNodeId ? (
          <button
            className="btn btn-sm btn-attack-launch"
            onClick={() => onAttackMachineLaunch(firstAttackNodeId)}
            title="Open Kali Linux attack machine in a separate window (can be moved to a second monitor)"
          >
            ⚔ Attack Machine
          </button>
        ) : (
          !isRunning && (
            <button
              className={`btn btn-sm ${hasAttackMachine ? 'btn-attack-active' : 'btn-attack-add'}`}
              onClick={hasAttackMachine ? undefined : onAttackMachineAdd}
              // Only disable during transitional states when there is no machine yet.
              // When a machine IS present the button is an indicator (no click action);
              // keeping it enabled prevents the browser from auto-dimming the red color.
              disabled={!hasAttackMachine && (isStarting || isStopping)}
              title={
                hasAttackMachine
                  ? 'Attack machine is included in this scenario — launch it when the simulation is running'
                  : 'Add a Kali Linux attack machine to this scenario'
              }
            >
              {hasAttackMachine ? '⚔ Attack Ready' : '+ Attack Machine'}
            </button>
          )
        )}

        {/*
         * Settings gear button — always visible (before the divider) so users can
         * configure subnet preferences at any time. Disabled only during transitional
         * states (starting / stopping) to avoid modifying settings while Docker is
         * already reading them. Changes take effect on the next simulation start.
         */}
        <button
          className="btn btn-sm btn-ghost btn-settings-gear"
          onClick={onSettingsOpen}
          disabled={!canOpenSettings}
          title="Network settings — configure Docker subnet addresses"
          aria-label="Open network settings"
        >
          ⚙
        </button>

        <div className="toolbar-divider" />
        {/* Stop button shown while running/starting; Run button shown while idle/stopping */}
        {showStop ? (
          <button className="btn btn-sm btn-danger" onClick={onStop} disabled={isStopping}>
            {isStopping ? 'Stopping…' : 'Stop Simulation'}
          </button>
        ) : (
          <button
            className="btn btn-sm btn-run"
            onClick={onStart}
            disabled={!canStart}
            title={startTitle}
          >
            {isStarting ? 'Starting…' : 'Run Simulation'}
          </button>
        )}
      </div>
    </header>
  )
}

/**
 * Small status indicator badge in the toolbar center.
 *
 * Uses a pulsing dot (CSS animation on .checking) for transitional states and
 * a solid dot for stable states. Each SimStatus maps to a distinct dot color
 * and label so operators know the simulation state at a glance.
 *
 * @param status - Current SimStatus value.
 */
function SimStatusBadge({ status }: { status: SimStatus }) {
  const configs: Record<SimStatus, { dot: string; label: string }> = {
    idle: { dot: 'muted', label: 'Idle' },
    starting: { dot: 'checking', label: 'Starting containers…' },
    running: { dot: 'ok', label: 'Simulation running' },
    stopping: { dot: 'checking', label: 'Stopping…' }
  }
  const { dot, label } = configs[status]
  return (
    <div className="sim-badge">
      <span className={`status-dot ${dot}`} />
      <span>{label}</span>
    </div>
  )
}

// ── Status bar ─────────────────────────────────────────────────────────────────

/**
 * Bottom status bar showing Docker status and container health pills.
 *
 * Container pills are shown for up to 6 containers with color-coded borders:
 *   green border = running, red border = error, gray border = other.
 * When more than 6 containers are running, a "+N more" chip is shown.
 *
 * @param docker           - Docker status for the left section.
 * @param simStatus        - Determines when container count is shown.
 * @param containerStatuses - Live container health data.
 */
function StatusBar({
  docker,
  simStatus,
  containerStatuses
}: {
  docker: DockerStatus | null
  simStatus: SimStatus
  containerStatuses: ContainerStatus[]
}) {
  const running = containerStatuses.filter(c => c.status === 'running').length
  const total = containerStatuses.length

  return (
    <footer className="status-bar">
      <div className="status-bar-left">
        <span className={`status-dot ${docker?.available ? 'ok' : 'error'}`} />
        <span>Docker {docker?.available ? `v${docker.version}` : 'not ready'}</span>
        {/* Container count only shown when a simulation is actively running */}
        {simStatus === 'running' && total > 0 && (
          <>
            <span className="status-sep">·</span>
            <span>
              {running}/{total} containers running
            </span>
          </>
        )}
      </div>
      <div className="status-bar-right">
        {/* Show up to 6 container health pills with color-coded borders */}
        {containerStatuses.slice(0, 6).map(c => (
          <span
            key={c.nodeId}
            className="container-pill"
            title={`${c.nodeId}: ${c.status}`}
            style={{
              borderColor:
                c.status === 'running' ? '#3fb950' : c.status === 'error' ? '#f85149' : '#484f58'
            }}
          >
            <span
              className={`status-dot xs ${c.status === 'running' ? 'ok' : c.status === 'error' ? 'error' : 'checking'}`}
            />
            {c.nodeId}
          </span>
        ))}
        {/* Overflow count when more than 6 containers are present */}
        {containerStatuses.length > 6 && (
          <span className="container-pill-more">+{containerStatuses.length - 6}</span>
        )}
      </div>
    </footer>
  )
}

// ── PLC IDE Modal ─────────────────────────────────────────────────────────────

/**
 * Full-screen overlay modal wrapping PlcIdePanel in two-column IDE mode.
 *
 * Layout:
 *   - Fixed backdrop dims and blurs the canvas beneath
 *   - Centered panel:
 *       Header — device node ID · "OpenPLC Runtime v3 · IEC 61131-3" label · × close
 *       Body   — PlcIdePanel (modal=true): ST/Ladder tabs on left, var table on right
 *
 * Dismiss with:
 *   - × button in the header
 *   - Click anywhere on the dim backdrop
 *   - Escape key (captured via window event listener)
 *
 * @param device          - The PLC DeviceConfig whose program is being edited.
 * @param simRunning      - Whether a simulation is running (enables Deploy button).
 * @param onProgramChange - Persists PLC program changes back into App state.
 * @param onClose         - Callback to close this modal.
 */
function PlcIdeModal({
  device,
  simRunning,
  onProgramChange,
  onClose
}: {
  device: DeviceConfig
  simRunning: boolean
  onProgramChange: (nodeId: string, program: PLCProgramConfig) => void
  onClose: () => void
}) {
  // Listen for Escape on the global window so focus doesn't need to be inside the modal
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div
      className="plc-modal-overlay"
      onClick={e => {
        // Only close when clicking the dim backdrop itself, not child elements
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="plc-modal">
        {/* Header: device name, runtime label, close button */}
        <div className="plc-modal-header">
          <div className="plc-modal-title">
            <span className="plc-modal-device-name">{device.nodeId}</span>
            <span className="plc-modal-runtime">OpenPLC Runtime v3 · IEC 61131-3</span>
          </div>
          <button className="plc-modal-close" onClick={onClose} aria-label="Close PLC IDE">
            ×
          </button>
        </div>

        {/* Two-column IDE body rendered by PlcIdePanel in modal mode */}
        <PlcIdePanel
          device={device}
          simRunning={simRunning}
          onProgramChange={onProgramChange}
          modal={true}
        />
      </div>
    </div>
  )
}

// ── Root App ───────────────────────────────────────────────────────────────────

/** Top-level view routes. */
type View = 'launch' | 'canvas'

/**
 * Root application component.
 *
 * Initializes on mount by fetching app info and Docker status from the main process.
 * Subscribes to container status push events for live health updates during a running
 * simulation. Manages the simulation lifecycle state machine transitions.
 */
export default function App() {
  const [view, setView] = useState<View>('launch')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [docker, setDocker] = useState<DockerStatus | null>(null)
  const [scenario, setScenario] = useState<ICSLabScenario | null>(null)
  const [selectedDevice, setSelectedDevice] = useState<DeviceConfig | null>(null)
  const [selectedZone, setSelectedZone] = useState<string | null>(null)
  const [simStatus, setSimStatus] = useState<SimStatus>('idle')
  const [containerStatuses, setContainerStatuses] = useState<ContainerStatus[]>([])
  /**
   * Whether the Grafana + Live Logs monitor panel is open.
   * Collapses automatically when the simulation stops (see useEffect below).
   */
  const [showMonitor, setShowMonitor] = useState<boolean>(false)

  /**
   * Whether the Network Settings modal is open.
   * The modal allows users to configure Docker subnet assignments — either
   * auto-detected (default) or pinned to specific CIDR ranges for power users
   * who need to avoid conflicts with VPN clients or institutional networks.
   */
  const [showSettings, setShowSettings] = useState<boolean>(false)

  /** Whether the Scenario Metadata editor modal is open (Author mode only). */
  const [showMetadataModal, setShowMetadataModal] = useState<boolean>(false)

  /** Whether the Export dialog modal is open (Author mode only). */
  const [showExportModal, setShowExportModal] = useState<boolean>(false)

  /**
   * Current app mode derived from the scenario's locked flag.
   *   'author'  — scenario is unlocked; full editor UI is available.
   *   'student' — scenario is locked; read-only canvas + Mission Brief panel.
   */
  const appMode: 'author' | 'student' = scenario?.meta.locked ? 'student' : 'author'

  /**
   * Error message from the most recent failed simulation start.
   * Shown in a dismissible banner below the toolbar. Cleared when
   * the user retries or starts a new scenario.
   */
  const [simError, setSimError] = useState<string | null>(null)
  /** PLC device currently open in the full-screen IDE modal. Null when modal is closed. */
  const [plcIdeDevice, setPlcIdeDevice] = useState<DeviceConfig | null>(null)
  /** Attack-machine device currently open in the terminal modal. Null when closed. */
  const [attackTerminalDevice, setAttackTerminalDevice] = useState<DeviceConfig | null>(null)
  /** Active Purdue layer tab — controls which canvas, palette section, and properties are shown. */
  const [activeLayer, setActiveLayer] = useState<NetworkZone>('ot')
  /**
   * Whether the 25 × 25 cell snap grid is visible and active.
   * Default true — grid appears on first launch so new users see the layout structure.
   * Stored at the App level so the preference persists across layer-tab switches.
   */
  const [showGrid, setShowGrid] = useState<boolean>(true)

  useEffect(() => {
    // Fetch app metadata and Docker status concurrently on first render
    Promise.all([window.electronAPI.app.info(), window.electronAPI.docker.check()]).then(
      ([info, dockerStatus]) => {
        setAppInfo(info)
        setDocker(dockerStatus)
      }
    )

    // Subscribe to live container status push events from the main process
    const unsubStatus = window.electronAPI.on.containerStatusUpdate(status => {
      setContainerStatuses(prev => {
        const idx = prev.findIndex(s => s.nodeId === status.nodeId)
        if (idx >= 0) {
          // Update existing entry in-place
          return prev.map((s, i) => (i === idx ? status : s))
        }
        // New container — append to the list
        return [...prev, status]
      })
    })

    // Clean up IPC listeners when the component unmounts
    return () => {
      unsubStatus()
    }
  }, [])

  /** Opens the file picker, imports a .icslab file, and navigates to the canvas. */
  const handleImport = useCallback(async () => {
    const result = await window.electronAPI.scenario.import()
    if (result.scenario) {
      setScenario(result.scenario)
      setView('canvas')
    }
  }, [])

  /** Clears all state and opens a blank canvas (new scenario workflow). */
  const handleNew = useCallback(() => {
    setScenario(null)
    setSelectedDevice(null)
    setSelectedZone(null)
    setSimStatus('idle')
    setContainerStatuses([])
    setSimError(null)
    setView('canvas')
  }, [])

  /**
   * Prompts for confirmation then clears all devices from the current scenario,
   * resetting it to an empty canvas. Leaves the scenario object in place (name
   * and network config are preserved) so the user doesn't lose their settings.
   * Only callable when the simulation is idle.
   */
  const handleDelete = useCallback(() => {
    if (!scenario) return
    const confirmed = window.confirm(
      `Delete all devices in "${scenario.meta.name}"?\n\nThis cannot be undone.`
    )
    if (!confirmed) return
    setScenario(prev => {
      if (!prev) return prev
      return {
        ...prev,
        devices: { devices: {}, connections: [] },
        // Clear visual positions too — scenarioToNodes reads visual.nodes first,
        // so leaving them populated keeps icons on screen even with no devices.
        visual: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
      }
    })
    setSelectedDevice(null)
    setSelectedZone(null)
    setSimError(null)
  }, [scenario])

  /** Returns to the launch screen. Blocked while a simulation is running. */
  const handleHome = useCallback(() => {
    if (simStatus === 'running') return
    setView('launch')
  }, [simStatus])

  /**
   * Updates the selected device state when the user clicks a canvas node.
   * Also resolves the zone from the canvas visual layer for PropertiesPanel coloring.
   */
  const handleSelectDevice = useCallback(
    (nodeId: string | null, device: DeviceConfig | null) => {
      setSelectedDevice(device)
      // Find zone by locating the canvas node in the visual layer
      if (nodeId && scenario) {
        const canvasNode = scenario.visual.nodes.find(n => n.id === nodeId)
        setSelectedZone(canvasNode?.data.zone ?? null)
      } else {
        setSelectedZone(null)
      }
    },
    [scenario]
  )

  /**
   * Applies a scenario update from the canvas (device added, edge added, etc.).
   * Uses an updater function pattern so changes can be based on the previous state.
   */
  const handleScenarioChange = useCallback(
    (updater: (s: ICSLabScenario | null) => ICSLabScenario | null) => {
      setScenario(prev => updater(prev))
    },
    []
  )

  /**
   * Stores a PLC program into the scenario's device config.
   *
   * Called by PlcIdePanel (via PropertiesPanel) when the user saves or deploys
   * a Structured Text program. Performs a deep-merge update into the nested
   * scenario.devices.devices[nodeId] object, preserving all other device fields.
   *
   * The updated scenario is immediately available to handleStart() for the next
   * simulation launch. The compose generator will include INITIAL_PROGRAM_B64
   * in the PLC service's environment when a plcProgram is present.
   *
   * @param nodeId  - Canvas node ID of the PLC device being updated.
   * @param program - New PLCProgramConfig to write into the scenario.
   */
  const handleProgramChange = useCallback((nodeId: string, program: PLCProgramConfig) => {
    setScenario(prev => {
      if (!prev) return prev
      const updatedDevice = { ...prev.devices.devices[nodeId], plcProgram: program }
      return {
        ...prev,
        devices: {
          ...prev.devices,
          devices: { ...prev.devices.devices, [nodeId]: updatedDevice }
        }
      }
    })
  }, [])

  /** Toggles the 25 × 25 snap grid on/off. */
  const handleGridToggle = useCallback(() => {
    setShowGrid(prev => !prev)
  }, [])

  /**
   * Collapses the monitor panel automatically when the simulation transitions
   * out of 'running' (either stopped by the user or killed externally).
   * This prevents the panel from persisting in an empty/error state after teardown.
   */
  useEffect(() => {
    if (simStatus !== 'running') {
      setShowMonitor(false)
    }
  }, [simStatus])

  /**
   * Polls container statuses every 3 seconds while the simulation is running.
   *
   * The main process never pushes container:statusUpdate events proactively, so the
   * renderer polls simulation:status on an interval. The entire status array is
   * replaced on each poll (simpler than merging, equally correct at 3 s cadence).
   * The interval is cleared as soon as simStatus leaves 'running' so there are no
   * stale polls after the simulation stops.
   */
  useEffect(() => {
    if (simStatus !== 'running') return

    const poll = async (): Promise<void> => {
      const statuses = await window.electronAPI.simulation.status()
      setContainerStatuses(statuses)
    }

    poll() // immediate first poll — don't wait 3 s for the first pill to appear
    const id = setInterval(poll, 3000)
    return () => clearInterval(id)
  }, [simStatus])

  /** Toggles the Grafana + Live Logs monitor panel open or closed. */
  const handleMonitorToggle = useCallback(() => {
    setShowMonitor(prev => !prev)
  }, [])

  /** Collapses the monitor panel — wired to MonitorPanel's onClose prop. */
  const handleCloseMonitor = useCallback(() => {
    setShowMonitor(false)
  }, [])

  /** Opens the Network Settings modal. */
  const handleSettingsOpen = useCallback(() => {
    setShowSettings(true)
  }, [])

  /** Closes the Network Settings modal. Changes take effect on next simulation start. */
  const handleSettingsClose = useCallback(() => {
    setShowSettings(false)
  }, [])

  /** Opens the Scenario Metadata editor modal. */
  const handleMetadataOpen = useCallback(() => {
    setShowMetadataModal(true)
  }, [])

  /** Closes the Metadata modal without saving. */
  const handleMetadataClose = useCallback(() => {
    setShowMetadataModal(false)
  }, [])

  /**
   * Applies updated metadata from the MetadataModal back into the scenario.
   * Called when the user clicks Save in the metadata editor.
   *
   * @param updated - The new ICSLabMeta object from the form.
   */
  const handleMetadataSave = useCallback((updated: ICSLabMeta) => {
    setScenario(prev => {
      if (!prev) return prev
      return { ...prev, meta: updated }
    })
    setShowMetadataModal(false)
  }, [])

  /** Opens the Export dialog modal. */
  const handleExportOpen = useCallback(() => {
    setShowExportModal(true)
  }, [])

  /** Closes the Export dialog modal. */
  const handleExportClose = useCallback(() => {
    setShowExportModal(false)
  }, [])

  /**
   * Adds a default attack machine device to the scenario's device list.
   *
   * The attack machine is NOT placed on any canvas tab (it lives in the 'attacker'
   * zone which has no Purdue layer tab). It is added directly to scenario.devices
   * so the compose generator creates the Kali Linux container and noVNC port mapping
   * at simulation start. The device's IP defaults to 10.200.60.10 (attacker subnet).
   */
  const handleAttackMachineAdd = useCallback(() => {
    const nodeId = `attack-machine-${Date.now()}`
    const device = {
      nodeId,
      category: 'attack-machine' as const,
      ipAddress: '10.200.60.10',
      protocols: ['none' as const]
    }
    setScenario(prev => {
      const base = prev ?? {
        meta: {
          formatVersion: '1.0' as const,
          name: 'Untitled Scenario',
          description: '',
          sector: 'generic' as const,
          author: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          appVersion: '0.1.0',
          locked: false,
          brief: '',
          requirements: { estimatedRamMb: 0, estimatedCpuCores: 1, containerCount: 0 }
        },
        visual: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        network: { segments: [], routes: [] },
        devices: { devices: {} },
        security: {
          defaultFirewallPolicy: 'deny' as const,
          firewallRules: [],
          ids: { enabledRulesets: [], disabledRuleIds: [], zeekScripts: [] },
          logging: { retentionDays: 30, influxdbEnabled: true, lokiEnabled: true }
        },
        registry: [],
        packLayers: []
      }
      return {
        ...base,
        devices: { devices: { ...base.devices.devices, [nodeId]: device } }
      }
    })
  }, [])

  /**
   * Opens the FUXA process HMI in a separate Electron BrowserWindow.
   *
   * Calls the `hmi:open` IPC handler which creates a new BrowserWindow loading
   * localhost:1881 (FUXA's web UI). The window is a native OS window that can be
   * moved to a second monitor independently of the main app.
   *
   * FUXA is always started as part of the simulation infrastructure — no HMI device
   * needs to be placed on the canvas. Modbus connections to PLCs in the scenario are
   * provisioned automatically by configureFuxa() in the main process after start.
   */
  const handleHmiOpen = useCallback(async () => {
    const result = await window.electronAPI.hmi.open()
    if (!result.ok) {
      setSimError(result.error ?? 'Failed to open FUXA HMI window.')
    }
  }, [])

  /**
   * Opens the attack machine's Kali Linux desktop in a separate Electron OS window.
   *
   * Calls the `attack:launchWindow` IPC handler which creates a new BrowserWindow
   * loading the noVNC URL for the attack container's Xfce4 desktop (port 6080 →
   * host port 6900+). The window is a native OS window so it can be dragged to a
   * second monitor independently of the main app.
   *
   * @param nodeId - Canvas node ID of the attack-machine device to open.
   */
  const handleAttackMachineLaunch = useCallback(async (nodeId: string) => {
    const result = await window.electronAPI.attack.launchWindow(nodeId)
    if (!result.ok) {
      // Surface the error in the same dismissible banner used for simulation start failures
      // so the instructor sees a clear message rather than a blank window or VNC error page.
      setSimError(result.error ?? 'Failed to open attack machine window.')
    }
  }, [])

  /**
   * Applies a security-layer update from FirewallPanel or IDSPanel.
   * The updater receives the current SecurityLayer and returns the modified copy.
   * Writes back into scenario.security so compose-generator.ts picks it up at
   * simulation start. No-ops if no scenario is open.
   */
  const handleSecurityChange = useCallback((updater: (s: SecurityLayer) => SecurityLayer) => {
    setScenario(prev => {
      if (!prev) return prev
      return { ...prev, security: updater(prev.security) }
    })
  }, [])

  /**
   * Effective grid visibility passed to the canvas and toolbar.
   * Grid is suppressed during simulation so operators aren't distracted by the
   * snap-to-grid behavior while monitoring live containers. The underlying
   * showGrid state is preserved so the grid reappears when idle resumes.
   */
  const effectiveShowGrid = simStatus === 'idle' ? showGrid : false

  /**
   * Starts the simulation:
   *   1. Transition to 'starting' (disables controls)
   *   2. Call simulation:start IPC which generates compose and runs docker compose up
   *   3. Transition to 'running' on success, back to 'idle' on failure
   *
   * The try/catch is critical: if the main process handler throws (e.g., because
   * writeGrafanaProvisioning or generateCompose errors), ipcRenderer.invoke() rejects
   * and without a catch the simStatus would hang at 'starting' forever.
   */
  const handleStart = useCallback(async () => {
    if (!scenario) return
    setSimError(null)
    setSimStatus('starting')
    setContainerStatuses([])
    try {
      const result = await window.electronAPI.simulation.start(scenario)
      if (result.ok) {
        setSimStatus('running')
      } else {
        setSimStatus('idle')
        setSimError(result.error ?? 'Simulation failed to start.')
      }
    } catch (err) {
      // IPC handler threw an unhandled exception — surface it to the user
      setSimStatus('idle')
      setSimError(`Unexpected error: ${(err as Error).message}`)
    }
  }, [scenario])

  /**
   * Stops the simulation:
   *   1. Transition to 'stopping'
   *   2. Call simulation:stop IPC which runs docker compose down --volumes
   *   3. Transition back to 'idle' and clear container status pills
   */
  const handleStop = useCallback(async () => {
    setSimStatus('stopping')
    await window.electronAPI.simulation.stop()
    setSimStatus('idle')
    setContainerStatuses([])
  }, [])

  /** Opens the PLC IDE modal for the given device. Called by PropertiesPanel. */
  const handleOpenPlcIde = useCallback((device: DeviceConfig) => {
    setPlcIdeDevice(device)
  }, [])

  /** Closes the PLC IDE modal and returns to the normal canvas view. */
  const handleClosePlcIde = useCallback(() => {
    setPlcIdeDevice(null)
  }, [])

  /** Opens the attack terminal modal for the given attack-machine device. */
  const handleOpenAttackTerminal = useCallback((device: DeviceConfig) => {
    setAttackTerminalDevice(device)
  }, [])

  /** Closes the attack terminal modal. The modal itself calls terminal:close on unmount. */
  const handleCloseAttackTerminal = useCallback(() => {
    setAttackTerminalDevice(null)
  }, [])

  // ── Render ──────────────────────────────────────────────────────────────────

  if (view === 'launch') {
    return (
      <LaunchScreen docker={docker} appInfo={appInfo} onImport={handleImport} onNew={handleNew} />
    )
  }

  return (
    <div className="app-shell">
      <Toolbar
        scenario={scenario}
        simStatus={simStatus}
        docker={docker}
        showGrid={effectiveShowGrid}
        showMonitor={showMonitor}
        appMode={appMode}
        onImport={handleImport}
        onNew={handleNew}
        onDelete={handleDelete}
        onStart={handleStart}
        onStop={handleStop}
        onHome={handleHome}
        onGridToggle={handleGridToggle}
        onMonitorToggle={handleMonitorToggle}
        onSettingsOpen={handleSettingsOpen}
        onAttackMachineAdd={handleAttackMachineAdd}
        onAttackMachineLaunch={handleAttackMachineLaunch}
        onHmiOpen={handleHmiOpen}
        onMetadataOpen={handleMetadataOpen}
        onExportOpen={handleExportOpen}
      />
      {/*
       * Simulation error banner — shown when the most recent start attempt failed.
       * Includes the error message from the main process (compose error, Docker pull
       * failure, path error, etc.) so the student/instructor can diagnose the issue.
       * Dismissed by clicking × or by starting a new simulation.
       */}
      {simError && (
        <div className="sim-error-banner">
          <span className="sim-error-icon">⚠</span>
          <span className="sim-error-message">{simError}</span>
          <button className="sim-error-dismiss" onClick={() => setSimError(null)} title="Dismiss">
            ×
          </button>
        </div>
      )}
      {/* Purdue model layer tabs — sit between toolbar and the 3-column workspace */}
      <LayerTabBar activeLayer={activeLayer} scenario={scenario} onLayerChange={setActiveLayer} />
      {/* 3-column workspace: (palette | mission) | canvas | properties */}
      <div className="workspace">
        {/*
         * Left column: DevicePalette in Author mode, MissionPanel in Student mode.
         * MissionPanel replaces the palette entirely — students cannot add devices,
         * so showing a device library would be confusing and misleading.
         */}
        {appMode === 'student' && scenario ? (
          <MissionPanel
            name={scenario.meta.name}
            author={scenario.meta.author}
            brief={scenario.meta.brief}
          />
        ) : (
          <DevicePalette activeLayer={activeLayer} readOnly={appMode === 'student'} />
        )}
        <ScadaCanvas
          scenario={scenario}
          activeLayer={activeLayer}
          showGrid={effectiveShowGrid}
          readOnly={appMode === 'student'}
          onSelectDevice={handleSelectDevice}
          onScenarioChange={handleScenarioChange}
        />
        <PropertiesPanel
          device={selectedDevice}
          zone={selectedZone}
          simRunning={simStatus === 'running'}
          security={scenario?.security ?? null}
          readOnly={appMode === 'student'}
          onSecurityChange={handleSecurityChange}
          onOpenPlcIde={handleOpenPlcIde}
          onOpenAttackTerminal={handleOpenAttackTerminal}
        />
      </div>
      {/*
       * Monitor panel drawer — rendered between workspace and status bar so it
       * slides in without pushing the toolbar or status bar out of view.
       * Unmounted entirely when closed to stop the Loki poll loop and
       * Grafana webview network requests when the panel is not in use.
       */}
      {showMonitor && <MonitorPanel onClose={handleCloseMonitor} />}
      <StatusBar docker={docker} simStatus={simStatus} containerStatuses={containerStatuses} />
      {/* PLC IDE full-screen modal — fixed overlay rendered on top of the workspace */}
      {plcIdeDevice && (
        <PlcIdeModal
          device={plcIdeDevice}
          simRunning={simStatus === 'running'}
          onProgramChange={handleProgramChange}
          onClose={handleClosePlcIde}
        />
      )}
      {/* Attack terminal + Desktop modal — opens when user clicks "Open Attack Terminal" */}
      {attackTerminalDevice && (
        <AttackTerminalModal device={attackTerminalDevice} onClose={handleCloseAttackTerminal} />
      )}
      {/*
       * Network Settings modal — fixed overlay rendered on top of everything.
       * Unmounted entirely when closed so it re-runs detection fresh each open.
       * Changes take effect on the next simulation start (not retroactively).
       */}
      {showSettings && <SettingsModal onClose={handleSettingsClose} />}

      {/*
       * Metadata editor modal — lets the instructor edit scenario name, description,
       * author, sector, and mission brief. Only available in Author mode while idle.
       * Unmounted when closed so the form always initializes fresh from current meta.
       */}
      {showMetadataModal && scenario && (
        <MetadataModal
          meta={scenario.meta}
          onSave={handleMetadataSave}
          onClose={handleMetadataClose}
        />
      )}

      {/*
       * Export dialog — presents Author Copy vs Student Copy options, then calls
       * scenario:export IPC which triggers the native save dialog.
       * Only available in Author mode while idle.
       */}
      {showExportModal && scenario && (
        <ExportModal scenario={scenario} onClose={handleExportClose} />
      )}
    </div>
  )
}
