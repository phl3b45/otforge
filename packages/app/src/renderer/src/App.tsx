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
  DeviceConfig,
  ContainerStatus
} from '@ics-sim/schema'
import { ScadaCanvas } from './canvas/ScadaCanvas'
import { DevicePalette } from './palette/DevicePalette'
import { PropertiesPanel } from './properties/PropertiesPanel'
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
 * @param scenario  - Current scenario (null for blank canvas).
 * @param simStatus - Current simulation lifecycle state.
 * @param docker    - Docker status (used to enable/disable the Run button).
 * @param onImport  - Opens the file picker.
 * @param onNew     - Clears the canvas for a new scenario.
 * @param onStart   - Starts the simulation.
 * @param onStop    - Stops the simulation.
 * @param onHome    - Returns to the launch screen (disabled while running).
 */
function Toolbar({
  scenario,
  simStatus,
  docker,
  onImport,
  onNew,
  onStart,
  onStop,
  onHome
}: {
  scenario: ICSLabScenario | null
  simStatus: SimStatus
  docker: DockerStatus | null
  onImport: () => void
  onNew: () => void
  onStart: () => void
  onStop: () => void
  onHome: () => void
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

      {/* Centered simulation status badge */}
      <div className="toolbar-center">
        <SimStatusBadge status={simStatus} />
      </div>

      <div className="toolbar-right">
        <button className="btn btn-sm btn-ghost" onClick={onNew} title="New scenario">
          New
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onImport} title="Open .icslab file">
          Open
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
    setView('canvas')
  }, [])

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
   * Starts the simulation:
   *   1. Transition to 'starting' (disables controls)
   *   2. Call simulation:start IPC which generates compose and runs docker compose up
   *   3. Transition to 'running' on success, back to 'idle' on failure
   */
  const handleStart = useCallback(async () => {
    if (!scenario) return
    setSimStatus('starting')
    setContainerStatuses([])
    const result = await window.electronAPI.simulation.start(scenario)
    if (result.ok) {
      setSimStatus('running')
    } else {
      setSimStatus('idle')
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
        onImport={handleImport}
        onNew={handleNew}
        onStart={handleStart}
        onStop={handleStop}
        onHome={handleHome}
      />
      {/* 3-column workspace: palette | canvas | properties */}
      <div className="workspace">
        <DevicePalette />
        <ScadaCanvas
          scenario={scenario}
          onSelectDevice={handleSelectDevice}
          onScenarioChange={handleScenarioChange}
        />
        <PropertiesPanel device={selectedDevice} zone={selectedZone} />
      </div>
      <StatusBar docker={docker} simStatus={simStatus} containerStatuses={containerStatuses} />
    </div>
  )
}
