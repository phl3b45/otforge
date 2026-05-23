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
 *   - scenario:          The active OTForgeScenario document (null = no scenario loaded)
 *   - selectedDevice:    The device config for the currently selected canvas node
 *   - selectedZone:      The zone key for the selected node (for PropertiesPanel color)
 *   - simStatus:         The simulation lifecycle state machine
 *   - containerStatuses: Live container health data from Docker Compose ps
 *   - showMonitor:       Whether the Grafana+Loki monitor panel drawer is open
 *   - builderModeActive: Whether the instructor has explicitly activated edit mode
 *                        (default false — canvas is view-only until Scenario Builder is saved)
 *   - pullActive:        Whether Docker is currently pulling container images
 *
 * Simulation status state machine:
 *   idle ──→ starting ──→ running ──→ stopping ──→ idle
 *
 * Editor mode state machine:
 *   view mode (default after open/import)
 *     ──→ [click Scenario Builder + save metadata] ──→ builder mode
 *     ──→ [load new scenario] ──→ view mode (reset)
 *
 * IPC flow:
 *   All Docker/scenario/simulation operations call window.electronAPI (contextBridge),
 *   which proxies to ipcMain handlers in main/index.ts via ipcRenderer.invoke().
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import type {
  DockerStatus,
  OTForgeScenario,
  OTForgeMeta,
  DeviceConfig,
  ContainerStatus,
  PLCProgramConfig,
  NetworkZone,
  SecurityLayer,
  InstalledPack,
  ResolvedPackDeviceType
} from '@otforge/schema'
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
import { PackManagerModal } from './packs/PackManagerModal'
import { TutorialPanel } from './tutorial/TutorialPanel'
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
 * Open .otflab buttons are disabled until Docker is confirmed running, because
 * a simulation cannot start without Docker Desktop.
 *
 * @param docker   - Docker status from the main process (null while checking).
 * @param onImport - Opens the native file picker to import a .otflab scenario.
 * @param onNew    - Creates a blank canvas and transitions to the canvas view.
 */
function LaunchScreen({
  docker,
  onImport,
  onNew
}: {
  docker: DockerStatus | null
  onImport: () => void
  onNew: () => void
}) {
  return (
    <div className="launch-screen">
      <div className="launch-content">
        {/*
         * Brand mark: hexagonal circuit icon + split wordmark.
         * "OT" is bold teal (Operational Technology), "Forge" is gradient white —
         * the two halves visually represent the digital-meets-industrial identity.
         */}
        <div className="logo-mark">
          {/* Hexagonal circuit icon — two concentric hexagons with circuit-node connectors */}
          <svg
            className="logo-icon"
            viewBox="0 0 60 66"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            {/* Outer hexagon */}
            <path
              d="M30 2 L56 17 L56 49 L30 64 L4 49 L4 17 Z"
              fill="rgba(57,208,176,0.05)"
              stroke="#39d0b0"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            {/* Inner hexagon (dimmer) */}
            <path
              d="M30 14 L47 23.5 L47 42.5 L30 52 L13 42.5 L13 23.5 Z"
              fill="none"
              stroke="rgba(57,208,176,0.25)"
              strokeWidth="1"
              strokeLinejoin="round"
            />
            {/* Central node */}
            <circle cx="30" cy="33" r="3.5" fill="#39d0b0" />
            {/* Radial connectors from centre to inner-hex top and side vertices */}
            <line x1="30" y1="29.5" x2="30" y2="14" stroke="#39d0b0" strokeWidth="1.5" />
            <line
              x1="27.2"
              y1="31.2"
              x2="13"
              y2="23.5"
              stroke="rgba(57,208,176,0.5)"
              strokeWidth="1"
            />
            <line
              x1="32.8"
              y1="31.2"
              x2="47"
              y2="23.5"
              stroke="rgba(57,208,176,0.5)"
              strokeWidth="1"
            />
            <line x1="30" y1="36.5" x2="30" y2="52" stroke="rgba(57,208,176,0.3)" strokeWidth="1" />
            {/* Accent dots at top and upper-side vertices */}
            <circle cx="30" cy="14" r="2" fill="#39d0b0" />
            <circle cx="47" cy="23.5" r="1.5" fill="rgba(57,208,176,0.7)" />
            <circle cx="13" cy="23.5" r="1.5" fill="rgba(57,208,176,0.7)" />
          </svg>

          {/* Wordmark: OT in teal, Forge in gradient white */}
          <div className="logo-wordmark">
            <span className="logo-ot">OT</span>
            <span className="logo-forge">Forge</span>
          </div>
        </div>
        <p className="tagline">ICS / SCADA Security Research &amp; Education Platform</p>

        {/* Docker status indicator */}
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
            Open .otflab File
          </button>
        </div>

        {!docker?.available && docker !== null && (
          <p className="launch-warning">Docker Desktop must be running to use the simulator.</p>
        )}
      </div>
    </div>
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

// ── Canvas View Hint ───────────────────────────────────────────────────────────

/**
 * Left-panel placeholder shown when the canvas is in View Mode (author + builder
 * mode not yet activated).
 *
 * During simulation the instructional text and builder shortcut are hidden because
 * the user cannot edit while a sim is running — only the lock reminder is shown.
 * Outside simulation the full prompt is shown so instructors know how to enable editing.
 *
 * @param onOpenBuilder - Opens the MetadataModal to activate builder mode.
 * @param simRunning    - When true, hide the Scenario Builder prompt and button.
 */
function CanvasViewHint({ simRunning }: { simRunning?: boolean }) {
  return (
    <div className="canvas-view-hint">
      <div className="canvas-view-hint-icon">🔒</div>
      <p>
        <strong>Student Mode</strong>
      </p>
      <p>
        {simRunning
          ? 'Simulation is running. Canvas is read-only.'
          : 'Canvas is read-only. Use New Scenario in the toolbar to enter Author Mode.'}
      </p>
    </div>
  )
}

// ── Status bar ─────────────────────────────────────────────────────────────────

/**
 * Bottom status bar showing Docker status, container health pills, and the
 * Delete Scenario button (Author mode only, idle only — bottom-right corner).
 *
 * Container pills are shown for up to 6 containers with color-coded borders:
 *   green border = running, red border = error, gray border = other.
 * When more than 6 containers are running, a "+N more" chip is shown.
 *
 * @param docker            - Docker status for the left section.
 * @param simStatus         - Determines when container count is shown.
 * @param containerStatuses - Live container health data.
 * @param showDelete        - True when the Delete Scenario button should appear.
 * @param onDelete          - Callback for the Delete Scenario button.
 */
function StatusBar({
  docker,
  simStatus,
  containerStatuses,
  showDelete,
  onDelete
}: {
  docker: DockerStatus | null
  simStatus: SimStatus
  containerStatuses: ContainerStatus[]
  /** Show the Delete Scenario button in the bottom-right corner. */
  showDelete?: boolean
  /** Handler for the Delete Scenario button. */
  onDelete?: () => void
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
        {/*
         * Delete Scenario — shown in the bottom-right corner in Author mode while idle.
         * Separated from the container pills by the existing right-flex layout.
         */}
        {showDelete && onDelete && (
          <button
            className="btn btn-sm btn-delete-scenario btn-delete-status-bar"
            onClick={onDelete}
            title="Clear all devices from this scenario and optionally delete the file from disk"
          >
            Delete Scenario
          </button>
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
      onMouseDown={e => {
        // Only close when clicking the dim backdrop itself, not child elements
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="plc-modal">
        {/* Header: modal title + device name + close button */}
        <div className="plc-modal-header">
          <div className="plc-modal-title">
            <span className="plc-modal-device-name">Save Program — {device.nodeId}</span>
            <span className="plc-modal-runtime">
              Persists ST source + variable bindings to scenario · Use OpenPLC ↗ to write and deploy
            </span>
          </div>
          <button className="plc-modal-close" onClick={onClose} aria-label="Close Save Program">
            ×
          </button>
        </div>

        {/* Single-column Save Program body rendered by PlcIdePanel in modal mode */}
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
  const [docker, setDocker] = useState<DockerStatus | null>(null)
  const [scenario, setScenario] = useState<OTForgeScenario | null>(null)
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

  /** Whether the Pack Manager modal is open. */
  const [showPackManager, setShowPackManager] = useState<boolean>(false)

  /**
   * Whether the TutorialPanel guided overlay is visible.
   * Auto-shown when a scenario containing tutorialSteps is loaded or opened.
   * The student can dismiss it at any time; it does not reappear on the same
   * scenario unless the app is relaunched (no persistence intentional — always
   * available via a "Tutorial" button in the toolbar or on scenario open).
   */
  const [showTutorial, setShowTutorial] = useState<boolean>(false)

  /**
   * Whether the instructor has activated Builder Mode for the current scenario.
   *
   * Default: false (View Mode) — canvas is read-only and the device palette is hidden.
   * Activated by: clicking Scenario Builder → filling metadata → clicking Save.
   * Reset to false whenever a new scenario is loaded or imported, so each session
   * starts in View/Tutorial mode by default.
   *
   * Purpose: prevents accidental drag-and-drop edits when the scenario is opened
   * for review or when a student is following the tutorial.
   */
  const [builderModeActive, setBuilderModeActive] = useState<boolean>(false)

  /**
   * Whether Docker is actively pulling container images during a simulation start.
   * Set to true via the simulation:pullStatus IPC push event from the main process.
   * Triggers the "Importing Containers" overlay during the 'starting' phase.
   * Reset automatically when simStatus leaves 'starting'.
   */
  const [pullActive, setPullActive] = useState<boolean>(false)

  // attackLaunched state removed — toolbar button now opens AttackTerminalModal directly
  // so button color uses (attackTerminalDevice !== null) instead of a separate flag.

  /**
   * Absolute path of the .otflab file currently open in the canvas.
   * Set when a scenario is loaded via Open (scenario:import) or saved via
   * Export (scenario:export). Cleared when a new blank scenario is created.
   * Used by the Delete Scenario action to remove the file from disk.
   */
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null)

  /**
   * All community scenario packs currently installed in <userData>/packs/.
   * Loaded on mount via pack:list IPC and refreshed after any install/uninstall.
   * Empty array on first launch.
   */
  const [installedPacks, setInstalledPacks] = useState<InstalledPack[]>([])

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
  /** Attack-machine device currently open in the terminal modal (canvas right-click path). Null when closed. */
  const [attackTerminalDevice, setAttackTerminalDevice] = useState<DeviceConfig | null>(null)
  /**
   * Increments each time the toolbar ⚔ Attack Machine button is clicked while the
   * simulation is running.  AttackTerminalModal watches this value and pastes the host
   * clipboard into the xterm.js terminal whenever it changes.
   *
   * Reset to 0 when the modal closes or the simulation stops so the next open does not
   * auto-paste unless the button was actually clicked.
   */
  const [pasteSignal, setPasteSignal] = useState<number>(0)
  /**
   * True after the ⚔ Attack Machine toolbar button opens the standalone terminal
   * BrowserWindow via attack:openTerminalWindow. Used to switch the button to its
   * "launched" (red) style so the user can see the window is active.
   * Reset when the simulation stops.
   */
  const [terminalWindowOpen, setTerminalWindowOpen] = useState<boolean>(false)
  /**
   * Controls the "GUI tools only / paste unavailable" hint toast that appears
   * when the 🖥 Kali Desktop button is clicked. Auto-dismissed after 6 seconds.
   */
  const [desktopHintVisible, setDesktopHintVisible] = useState<boolean>(false)
  /** Holds the auto-dismiss timer so it can be cleared on manual close. */
  const desktopHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Active Purdue layer tab — controls which canvas, palette section, and properties are shown. */
  const [activeLayer, setActiveLayer] = useState<NetworkZone>('ot')
  /**
   * Whether the 25 × 25 cell snap grid is visible and active.
   * Default true — grid appears on first launch so new users see the layout structure.
   * Stored at the App level so the preference persists across layer-tab switches.
   */
  const [showGrid, setShowGrid] = useState<boolean>(true)

  useEffect(() => {
    // Fetch app metadata, Docker status, and installed packs concurrently on first render
    Promise.all([window.electronAPI.docker.check(), window.electronAPI.packs.list()]).then(
      ([dockerStatus, packList]) => {
        setDocker(dockerStatus)
        setInstalledPacks(packList.packs)
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

    // Subscribe to Docker image pull progress events.
    // The main process sends this when it detects that at least one required image
    // is not cached locally and a docker compose up will trigger a pull.
    // We show the "Importing Containers" overlay so the user knows a long operation
    // is in progress rather than seeing the app appear to hang.
    const unsubPull = window.electronAPI.on.simulationPullStatus(({ pulling }) => {
      setPullActive(pulling)
    })

    // Clean up IPC listeners when the component unmounts
    return () => {
      unsubStatus()
      unsubPull()
    }
  }, [])

  // Automatically clear the "Importing Containers" overlay when the simulation
  // leaves the 'starting' phase (either to 'running' on success or 'idle' on failure)
  useEffect(() => {
    if (simStatus !== 'starting') {
      setPullActive(false)
    }
  }, [simStatus])

  /**
   * Opens the file picker, imports a .otflab scenario, and navigates to the canvas.
   *
   * Builder mode is reset to false (View Mode) on every import so the canvas starts
   * read-only regardless of whether the scenario is locked or not. Instructors must
   * explicitly click Scenario Builder to activate editing. Students (locked scenarios)
   * never enter builder mode.
   *
   * If the scenario has tutorial steps, the Tutorial panel is auto-shown so students
   * immediately see their guided instructions.
   */
  const handleImport = useCallback(async () => {
    const result = await window.electronAPI.scenario.import()
    if (result.scenario) {
      setScenario(result.scenario)
      setBuilderModeActive(false) // always start in View Mode after opening a file
      setView('canvas')
      // Track the file path so Delete Scenario can remove it from disk.
      setCurrentFilePath(result.filePath ?? null)
      // Auto-show the tutorial panel when the imported scenario has guided steps
      if (result.scenario.meta.tutorialSteps?.length) {
        setShowTutorial(true)
      }
    } else if (result.error && result.error !== 'Import cancelled') {
      // Surface validation and parse errors — without this the user sees a blank
      // screen with no feedback when a .otflab file fails schema validation.
      window.alert(`Could not open scenario:\n\n${result.error}`)
    }
  }, [])

  /**
   * Creates a blank scenario and navigates to the canvas in View Mode.
   *
   * Immediately opens the Scenario Builder (MetadataModal) so the instructor fills
   * in the scenario name, sector, and mission brief before editing the canvas.
   * Saving the modal activates Builder Mode; cancelling leaves the canvas in View Mode
   * (the user can click Scenario Builder in the toolbar to re-open it later).
   *
   * If there are unsaved devices on the current canvas, prompts for confirmation
   * before discarding work.
   */
  const handleNew = useCallback(() => {
    // Warn if current canvas has unsaved devices
    if (scenario && Object.keys(scenario.devices.devices).length > 0) {
      const ok = window.confirm(
        `Start a new scenario? All devices on the current canvas will be lost.`
      )
      if (!ok) return
      // window.confirm() creates a native OS dialog that steals focus from the
      // Electron BrowserWindow. After it closes the renderer window is no longer
      // the foreground window, so keyboard events don't reach inputs. Calling
      // window.focus() here returns OS focus to the renderer before the
      // MetadataModal mounts and its auto-focus timer fires.
      window.focus()
    }
    const now = new Date().toISOString()
    setScenario({
      meta: {
        formatVersion: '1.0' as const,
        name: 'Untitled Scenario',
        description: '',
        sector: 'generic' as const,
        author: '',
        createdAt: now,
        updatedAt: now,
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
    })
    setSelectedDevice(null)
    setSelectedZone(null)
    setSimStatus('idle')
    setContainerStatuses([])
    setSimError(null)
    setBuilderModeActive(false)
    setShowTutorial(false)
    setCurrentFilePath(null) // new blank scenario has no associated file yet
    setView('canvas')
    // Open Scenario Builder immediately so the instructor fills in metadata first
    setShowMetadataModal(true)
  }, [scenario])

  /**
   * Prompts for confirmation then clears all devices from the current scenario,
   * resetting it to an empty canvas. Leaves the scenario object in place (name
   * and network config are preserved) so the user doesn't lose their settings.
   * Only callable when the simulation is idle.
   */
  const handleDelete = useCallback(async () => {
    if (!scenario) return

    // Tailor the confirmation message based on whether we have a file to delete.
    const fileNote = currentFilePath
      ? '\n\nThis will also delete the file from the scenarios folder.'
      : ''
    const confirmed = window.confirm(
      `Delete "${scenario.meta.name}"?\n\nThis will clear all devices from the canvas.${fileNote}\n\nThis cannot be undone.`
    )
    if (!confirmed) return

    // Remove the file from disk if we know where it came from.
    if (currentFilePath) {
      const del = await window.electronAPI.scenario.deleteFile(currentFilePath)
      if (!del.ok) {
        // Non-fatal — the canvas is still cleared; warn the user but continue.
        window.alert(`Could not delete scenario file:\n${del.error}`)
      }
      setCurrentFilePath(null)
    }

    // Clear devices and visual layout from the canvas.
    setScenario(prev => {
      if (!prev) return prev
      return {
        ...prev,
        devices: { devices: {} },
        // Clear visual positions too — scenarioToNodes reads visual.nodes first,
        // so leaving them populated keeps icons on screen even with no devices.
        visual: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
      }
    })
    setSelectedDevice(null)
    setSelectedZone(null)
    setSimError(null)
  }, [scenario, currentFilePath])

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
    (updater: (s: OTForgeScenario | null) => OTForgeScenario | null) => {
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
      // Close the attack terminal modal when the simulation stops so xterm.js
      // doesn't remain open against a dead docker exec session.
      setAttackTerminalDevice(null)
      setPasteSignal(0)
      // Reset the standalone terminal window open indicator — the BrowserWindow
      // is destroyed by main when simulation stops and the PTY process is killed.
      setTerminalWindowOpen(false)
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

  /** Opens the Scenario Metadata editor modal against the current scenario (edit-in-place). */
  const handleMetadataOpen = useCallback(() => {
    setShowMetadataModal(true)
  }, [])

  /**
   * Scenario Builder button handler.
   *
   * Clears the current scenario from memory (no file is deleted from disk) and
   * immediately opens the MetadataModal for a fresh blank scenario. This guarantees
   * that the modal always mounts against a brand-new createdAt timestamp so React
   * re-initialises all form state — no stale tutorial data, no leftover devices.
   *
   * The canvas stays in view mode until the user saves the metadata form, which
   * activates builder mode and unlocks the device palette.
   */
  const handleScenarioBuilderClick = useCallback(() => {
    const now = new Date().toISOString()
    setScenario({
      meta: {
        formatVersion: '1.0' as const,
        name: 'Untitled Scenario',
        description: '',
        sector: 'generic' as const,
        author: '',
        createdAt: now,
        updatedAt: now,
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
    })
    setSelectedDevice(null)
    setSelectedZone(null)
    setSimError(null)
    setBuilderModeActive(false)
    setShowTutorial(false)
    setCurrentFilePath(null)
    setShowMetadataModal(true)
  }, [])

  /** Closes the Metadata modal without saving. */
  const handleMetadataClose = useCallback(() => {
    setShowMetadataModal(false)
  }, [])

  /**
   * Applies updated metadata from the MetadataModal back into the scenario and
   * activates Builder Mode so the instructor can now drag and drop devices.
   *
   * This is the gating mechanism for edit access: the canvas is read-only until
   * the instructor clicks Scenario Builder, fills in the metadata, and clicks Save.
   * After that, `builderModeActive = true` unlocks the DevicePalette and canvas.
   *
   * @param updated - The new OTForgeMeta object from the form.
   */
  const handleMetadataSave = useCallback((updated: OTForgeMeta) => {
    setScenario(prev => {
      if (!prev) return prev
      return { ...prev, meta: updated }
    })
    setBuilderModeActive(true) // Scenario Builder saved → activate builder/edit mode
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
   * Receives the absolute file path from ExportModal after a successful save.
   * Updates currentFilePath so the Delete Scenario action can remove the
   * file from disk if the user later wants to delete it.
   */
  const handleExportSuccess = useCallback((filePath: string) => {
    setCurrentFilePath(filePath)
  }, [])

  /** Opens the Pack Manager modal. */
  const handlePacksOpen = useCallback(() => {
    setShowPackManager(true)
  }, [])

  /** Closes the Pack Manager modal. */
  const handlePacksClose = useCallback(() => {
    setShowPackManager(false)
  }, [])

  /**
   * Refreshes the installed packs list after an install or uninstall operation.
   * Called by PackManagerModal via its onPacksChange prop.
   *
   * @param updated - The new pack array returned by the modal after mutation.
   */
  const handlePacksChange = useCallback((updated: InstalledPack[]) => {
    setInstalledPacks(updated)
  }, [])

  /**
   * Opens a scenario bundled inside a community pack and transitions to the canvas.
   *
   * Calls the pack:openScenario IPC handler which reads the .otflab file from the
   * pack directory, validates it, and returns it as a ScenarioImportResult. If the
   * import succeeds, the scenario replaces whatever is currently open on the canvas.
   * The Pack Manager modal closes immediately after the user clicks Open.
   *
   * @param packId       - Pack id from the manifest.
   * @param relativePath - Path to the .otflab file relative to the pack root.
   */
  const handlePackOpenScenario = useCallback(async (packId: string, relativePath: string) => {
    setShowPackManager(false) // close the modal before navigating
    const result = await window.electronAPI.packs.openScenario(packId, relativePath)
    if (result.scenario) {
      setScenario(result.scenario)
      setView('canvas')
      setSelectedDevice(null)
      setSelectedZone(null)
      setSimError(null)
    }
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
   * Removes all attack-machine devices from the scenario device list.
   *
   * Attack machines live only in scenario.devices.devices (they have no visual node
   * on any canvas layer), so removal is a simple key filter on the devices map.
   * Only callable when the simulation is idle — the button is not shown while running.
   */
  const handleAttackMachineRemove = useCallback(() => {
    setScenario(prev => {
      if (!prev) return prev
      const filtered = Object.fromEntries(
        Object.entries(prev.devices.devices).filter(([, d]) => d.category !== 'attack-machine')
      )
      return { ...prev, devices: { devices: filtered } }
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

  // handleAttackMachineLaunch removed — the toolbar button now opens AttackTerminalModal
  // which has both a Terminal tab (docker exec + xterm.js, paste works) and a Desktop
  // tab (noVNC Xfce4, with Paste to Kali button). The modal's own handleLaunchDesktop
  // callback handles calling attack:launchWindow when the user clicks the Desktop tab.

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
   * Flat list of all pack device types contributed by installed community packs.
   * Derived by flattening the deviceTypes array from every InstalledPack.
   * Passed to DevicePalette (for the "Pack Devices" section) and ScadaCanvas
   * (so the drop handler can resolve custom Docker images and labels).
   */
  const allPackDeviceTypes: ResolvedPackDeviceType[] = installedPacks.flatMap(p => p.deviceTypes)

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
    // docker compose down runs native processes that can steal OS focus from the
    // Electron BrowserWindow. Restoring focus here ensures inputs are immediately
    // interactive after stopping the simulation (e.g. MetadataModal, Scenario Builder).
    window.focus()
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

  /** Closes the attack terminal modal and resets paste signal. */
  const handleCloseAttackTerminal = useCallback(() => {
    setAttackTerminalDevice(null)
    setPasteSignal(0)
  }, [])

  /**
   * Toolbar ⚔ Attack Machine button handler (sim running).
   *
   * Opens (or focuses) the standalone xterm.js terminal BrowserWindow for the
   * attack machine and auto-pastes the current host clipboard into bash.
   *
   * Flow:
   *   1. Reads the host clipboard via Electron's native module (no HTTPS required).
   *   2. Calls attack:openTerminalWindow, which:
   *        a. Opens a new OS window loading terminal.html with the nodeId.
   *        b. The terminal page calls terminal:open to start a docker exec PTY session.
   *        c. After ~800 ms (bash ready), writes the clipboard text to PTY stdin.
   *   3. If the window is already open, the text is written to the active PTY immediately.
   *
   * This is a direct one-hop PTY write — zero intermediate protocol layers.
   * The noVNC/xdotool path was abandoned because its 4-layer async chain was unreliable.
   *
   * @param device - DeviceConfig for the attack-machine canvas node.
   */
  const handleOpenAttackTerminalAndPaste = useCallback((device: DeviceConfig) => {
    setTerminalWindowOpen(true)
    window.electronAPI.clipboard
      .readText()
      .then(text => {
        window.electronAPI.attack
          .openTerminalWindow(device.nodeId, text || undefined)
          .catch(() => {})
      })
      .catch(() => {
        // Clipboard read failed — open the window without paste
        window.electronAPI.attack.openTerminalWindow(device.nodeId).catch(() => {})
      })
  }, [])

  /**
   * Opens the Kali Xfce4 desktop in a noVNC BrowserWindow and shows a one-time
   * hint toast reminding students that clipboard paste is unavailable there.
   *
   * The desktop is intended for GUI-based tools that cannot run in the xterm
   * terminal: Armitage (Metasploit GUI), Wireshark, and Firefox. For command-line
   * work and clipboard paste, students should use the ⚔ Attack Machine terminal.
   *
   * @param device - DeviceConfig for the attack-machine canvas node.
   */
  const handleOpenDesktop = useCallback((device: DeviceConfig) => {
    window.electronAPI.attack.launchWindow(device.nodeId).catch(() => {})
    // Show the hint toast and auto-dismiss it after 6 seconds
    if (desktopHintTimerRef.current) clearTimeout(desktopHintTimerRef.current)
    setDesktopHintVisible(true)
    desktopHintTimerRef.current = setTimeout(() => setDesktopHintVisible(false), 6000)
  }, [])

  // ── Simulation control state (used in sim-tabs-row Run/Stop button) ────────────
  // These mirror the lifecycle booleans inside Toolbar but live in App so the
  // Run/Stop button can be rendered alongside LayerTabBar in the sim-tabs-row,
  // and the sim-actions-row can reference them for conditional button rendering.
  const simIsIdle = simStatus === 'idle'
  const simIsStarting = simStatus === 'starting'
  const simIsRunning = simStatus === 'running'
  const simIsStopping = simStatus === 'stopping'
  const simShowStop = simIsRunning || simIsStarting
  const simDeviceCount = scenario ? Object.keys(scenario.devices.devices).length : 0
  const simCanStart = !!docker?.available && !!scenario && simDeviceCount > 0 && simIsIdle
  const simStartTitle = !docker?.available
    ? 'Docker is not running'
    : simDeviceCount === 0
      ? 'Add at least one device'
      : ''
  // ── sim-actions-row state (moved from Toolbar so they render below the ribbon) ─
  // Attack machine helpers and tutorial flag — used in the sim-actions-row that
  // sits between the toolbar and the layer-tab bar row.
  const attackDevices = scenario
    ? Object.entries(scenario.devices.devices).filter(([, d]) => d.category === 'attack-machine')
    : []
  const hasAttackMachine = attackDevices.length > 0
  // First attack machine — device object passed to handlers and the terminal modal
  const firstAttackDevice = (attackDevices[0]?.[1] as DeviceConfig) ?? null
  const hasTutorial = !!scenario?.meta.tutorialSteps?.length

  // ── Render ──────────────────────────────────────────────────────────────────

  if (view === 'launch') {
    return <LaunchScreen docker={docker} onImport={handleImport} onNew={handleNew} />
  }

  return (
    <div className="app-shell">
      {/*
       * ── Toolbar: three-row header ────────────────────────────────────────────
       *
       * Row 1 (toolbar-actions-row): three-section layout.
       *   Left   — file/editor operations: New Scenario, Open, Edit Scenario, Export,
       *             Packs, Grid, Settings.
       *   Center — OTForge Home button + scenario name + device count (always centred).
       *   Right  — simulation tools: Tutorial, Attack Machine, Open HMI, Monitor.
       *
       * Row 2 (toolbar-status-row): simulation status badge (Idle / Running / …)
       *   centred on its own line so it is always easy to spot at a glance.
       *
       * Row 3 (sim-mode-row): Author / Student mode indicator directly below.
       */}
      <header className="toolbar">
        {/* Row 1 — action buttons */}
        <div className="toolbar-actions-row">
          {/*
           * Left toolbar buttons — all disabled while the simulation is running,
           * starting, or stopping so the instructor cannot modify the scenario
           * mid-simulation. They remain visible (not hidden) so the layout is stable.
           */}
          <div className="toolbar-actions-left">
            {/* New Scenario — always visible; clears canvas and opens fresh metadata form */}
            <button
              className="btn btn-sm btn-ghost"
              onClick={handleScenarioBuilderClick}
              disabled={!simIsIdle}
              title={
                simIsIdle
                  ? 'Clear the canvas and create a new scenario'
                  : 'Stop the simulation to create a new scenario'
              }
            >
              New Scenario
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={handleImport}
              disabled={!simIsIdle}
              title={simIsIdle ? 'Open .otflab file' : 'Stop the simulation to open a file'}
            >
              Open
            </button>
            {/*
             * Edit Scenario — shown whenever a scenario is open.
             * Grayed in Student Mode (builderModeActive = false) because editing
             * requires Author Mode — activate it via New Scenario first.
             */}
            {scenario && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={handleMetadataOpen}
                disabled={!simIsIdle || !builderModeActive}
                title={
                  !simIsIdle
                    ? 'Stop the simulation to edit scenario metadata'
                    : !builderModeActive
                      ? 'Enter Author Mode via New Scenario to edit metadata'
                      : 'Edit scenario name, description, and mission brief'
                }
              >
                Edit Scenario
              </button>
            )}
            {/* Export — shown when a scenario is open; grayed in Student Mode or during sim */}
            {scenario && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={handleExportOpen}
                disabled={!simIsIdle || !builderModeActive}
                title={
                  !simIsIdle
                    ? 'Stop the simulation to export'
                    : !builderModeActive
                      ? 'Enter Author Mode to export the scenario'
                      : 'Export scenario as Author Copy or Student Copy'
                }
              >
                Export
              </button>
            )}
            {/* Pack Manager — Author mode only; grayed while sim is active */}
            {appMode === 'author' && (
              <button
                className="btn btn-sm btn-ghost btn-packs"
                onClick={handlePacksOpen}
                disabled={!simIsIdle}
                title={
                  simIsIdle
                    ? 'Manage community scenario packs (.otfpack files)'
                    : 'Stop the simulation to manage packs'
                }
              >
                Packs
                {installedPacks.length > 0 && (
                  <span className="packs-badge">{installedPacks.length}</span>
                )}
              </button>
            )}
            {/* Grid toggle — Author mode only; grayed while sim is active */}
            {appMode === 'author' && (
              <button
                className={`btn btn-sm ${effectiveShowGrid ? 'btn-secondary' : 'btn-ghost'}`}
                onClick={handleGridToggle}
                disabled={!simIsIdle}
                title={
                  simIsIdle
                    ? effectiveShowGrid
                      ? 'Hide 25 × 25 snap grid'
                      : 'Show 25 × 25 snap grid'
                    : 'Stop the simulation to toggle grid'
                }
              >
                Grid
              </button>
            )}
            {/* Settings gear — grayed in Student Mode and during sim */}
            <button
              className="btn btn-sm btn-ghost btn-settings-gear"
              onClick={handleSettingsOpen}
              disabled={!simIsIdle || !builderModeActive}
              title={
                !simIsIdle
                  ? 'Stop the simulation to change network settings'
                  : !builderModeActive
                    ? 'Enter Author Mode to change network settings'
                    : 'Network settings — configure Docker subnet addresses'
              }
              aria-label="Open network settings"
            >
              ⚙
            </button>
          </div>

          {/* Center: scenario name + device count (Home button moved to status row) */}
          <div className="toolbar-actions-center">
            {scenario && (
              <div className="toolbar-scenario">
                <span className="toolbar-scenario-name">
                  {scenario.meta.name ?? 'Untitled Scenario'}
                </span>
                {simDeviceCount > 0 && (
                  <span className="toolbar-scenario-meta">
                    {simDeviceCount} device{simDeviceCount !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="toolbar-actions-right">
            {/*
             * Tutorial — shown whenever the active scenario has tutorial steps.
             * Available in both Author and Student modes.
             */}
            {hasTutorial && (
              <button
                className="btn btn-sm btn-tutorial"
                onClick={() => setShowTutorial(true)}
                title="Open the step-by-step tutorial guide"
              >
                🎓 Tutorial
              </button>
            )}
            {/*
             * Attack Machine — four visual states:
             *   idle (no machine)  → "+ Attack Machine" teal outline — click to add
             *   idle (has machine) → "⚔ Attack Ready" solid teal — click to remove
             *   running (ready)    → "⚔ Kali Terminal" solid teal — click to open terminal
             *   running (launched) → "⚔ Kali Terminal" solid red — click to re-open / paste
             */}
            {simIsRunning && hasAttackMachine && firstAttackDevice ? (
              <>
                <button
                  className={`btn btn-sm btn-attack-launch${terminalWindowOpen ? ' btn-attack-launched' : ''}`}
                  onClick={() => handleOpenAttackTerminalAndPaste(firstAttackDevice)}
                  title={
                    terminalWindowOpen
                      ? 'Terminal open — click to paste clipboard into Kali'
                      : 'Open Kali terminal and paste clipboard contents'
                  }
                >
                  ⚔ Kali Terminal
                </button>
                <button
                  className="btn btn-sm btn-desktop"
                  onClick={() => handleOpenDesktop(firstAttackDevice)}
                  title="Open Kali desktop (GUI tools: Armitage, Wireshark, Firefox) — clipboard paste not available"
                >
                  🖥 Kali Desktop
                </button>
              </>
            ) : (
              !simIsRunning && (
                <button
                  className={`btn btn-sm ${hasAttackMachine ? 'btn-attack-active' : 'btn-attack-add'}`}
                  onClick={hasAttackMachine ? handleAttackMachineRemove : handleAttackMachineAdd}
                  disabled={simIsStarting || simIsStopping}
                  title={
                    hasAttackMachine
                      ? 'Remove the Kali Linux attack machine from this scenario'
                      : 'Add a Kali Linux attack machine to this scenario'
                  }
                >
                  {hasAttackMachine ? '⚔ Attack Ready' : '+ Attack Machine'}
                </button>
              )
            )}
            {/* Open HMI — only while simulation is running */}
            {simIsRunning && (
              <button
                className="btn btn-sm btn-hmi"
                onClick={handleHmiOpen}
                title="Open FUXA process HMI — live Modbus data from PLCs"
              >
                Open HMI
              </button>
            )}
            {/* Monitor toggle — only while simulation is running */}
            {simIsRunning && (
              <button
                className={`btn btn-sm btn-monitor ${showMonitor ? 'active' : ''}`}
                onClick={handleMonitorToggle}
                title={showMonitor ? 'Hide monitor panel' : 'Open Grafana + Live Logs monitor'}
              >
                Monitor
              </button>
            )}
          </div>
        </div>

        {/* Row 2 — OTForge Home (left) + simulation status badge (centred) */}
        <div className="toolbar-status-row">
          <button className="toolbar-logo toolbar-status-home" onClick={handleHome} title="Home">
            <span className="logo-ot-sm">OT</span>
            <span className="logo-forge-sm">Forge</span>
          </button>
          <SimStatusBadge status={simStatus} />
        </div>
      </header>

      {/*
       * Simulation error banner — shown when the most recent start attempt failed.
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

      {/*
       * Mode badge row — directly below the toolbar identity row (below the sim status
       * badge with the blinking dot). Only shown when a scenario is open.
       */}
      {scenario && (
        <div className="sim-mode-row">
          {/*
           * Two-state mode badge:
           *   Author Mode  — builderModeActive = true; instructor can drag/drop/edit
           *   Student Mode — builderModeActive = false; default after any file import
           */}
          <div
            className={`mode-badge ${builderModeActive ? 'mode-badge-author' : 'mode-badge-student'}`}
          >
            {builderModeActive ? '✎ Author Mode' : '🔒 Student Mode'}
          </div>
        </div>
      )}

      {/* Layer tab bar + Run/Stop control */}
      <div className="sim-tabs-row">
        <LayerTabBar activeLayer={activeLayer} scenario={scenario} onLayerChange={setActiveLayer} />
        <div className="sim-control-slot">
          {simShowStop ? (
            <button
              className="btn btn-sim btn-danger"
              onClick={handleStop}
              disabled={simIsStopping}
            >
              {simIsStopping ? 'Stopping…' : 'Stop Simulation'}
            </button>
          ) : (
            <button
              className="btn btn-sim btn-run"
              onClick={handleStart}
              disabled={!simCanStart}
              title={simStartTitle}
            >
              {simIsStarting ? 'Starting…' : 'Run Simulation'}
            </button>
          )}
        </div>
      </div>
      {/* 3-column workspace: (palette | mission) | canvas | properties */}
      <div className="workspace">
        {/*
         * Left column — three possible panels:
         *
         *   Locked scenario (meta.locked = true):
         *     MissionPanel — read-only mission brief + objectives from scenario.meta.brief
         *
         *   Author Mode (builderModeActive = true):
         *     DevicePalette — drag-and-drop device library for building scenarios
         *
         *   Student Mode (builderModeActive = false, default after any file import):
         *     CanvasViewHint — explains the mode; no edit buttons
         */}
        {scenario?.meta.locked ? (
          <MissionPanel
            name={scenario.meta.name}
            author={scenario.meta.author}
            brief={scenario.meta.brief}
          />
        ) : builderModeActive ? (
          <DevicePalette
            activeLayer={activeLayer}
            readOnly={false}
            packDeviceTypes={allPackDeviceTypes}
          />
        ) : (
          <CanvasViewHint simRunning={simIsRunning} />
        )}
        <ScadaCanvas
          scenario={scenario}
          activeLayer={activeLayer}
          showGrid={effectiveShowGrid}
          readOnly={!builderModeActive}
          packDeviceTypes={allPackDeviceTypes}
          simRunning={simStatus === 'running'}
          onSelectDevice={handleSelectDevice}
          onScenarioChange={handleScenarioChange}
          onLayerChange={setActiveLayer}
        />
        <PropertiesPanel
          device={selectedDevice}
          zone={selectedZone}
          simRunning={simStatus === 'running'}
          security={scenario?.security ?? null}
          readOnly={false}
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
      <StatusBar
        docker={docker}
        simStatus={simStatus}
        containerStatuses={containerStatuses}
        showDelete={simIsIdle && !!scenario && appMode === 'author'}
        onDelete={handleDelete}
      />
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
        <AttackTerminalModal
          device={attackTerminalDevice}
          pasteSignal={pasteSignal}
          onClose={handleCloseAttackTerminal}
        />
      )}
      {/*
       * Kali Desktop hint toast — appears for 6 seconds after the 🖥 Kali Desktop
       * button is clicked. Reminds students that the noVNC desktop is for GUI tools
       * only (Armitage, Wireshark, Firefox) and that clipboard paste is not available.
       * For paste + CLI work, the ⚔ Attack Machine terminal is the correct tool.
       */}
      {desktopHintVisible && (
        <div className="desktop-hint-toast" role="status" aria-live="polite">
          <div className="desktop-hint-toast-header">
            <span className="desktop-hint-toast-title">🖥 Kali Desktop — GUI Tools Only</span>
            <button
              className="desktop-hint-toast-close"
              onClick={() => {
                if (desktopHintTimerRef.current) clearTimeout(desktopHintTimerRef.current)
                setDesktopHintVisible(false)
              }}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
          <div className="desktop-hint-toast-body">
            Use this window for <strong>Armitage</strong>, <strong>Wireshark</strong>, and{' '}
            <strong>Firefox</strong>.<br />
            <strong>Clipboard paste does not work here.</strong> For command-line work and pasting
            tutorial commands, use the <strong>⚔ Attack Machine</strong> terminal instead.
          </div>
        </div>
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
          // key forces a full remount (fresh useState) whenever the scenario changes.
          // Without this, if the modal was already mounted before handleNew ran,
          // setState(initialValue) would not reinitialize from the new blank meta.
          key={scenario.meta.createdAt}
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
        <ExportModal
          scenario={scenario}
          onClose={handleExportClose}
          onExportSuccess={handleExportSuccess}
        />
      )}

      {/*
       * Pack Manager — install, browse, and uninstall community scenario packs.
       * Accessible via the Packs toolbar button in Author mode at any time.
       * Unmounted when closed so it re-fetches the pack list fresh on next open.
       */}
      {showPackManager && (
        <PackManagerModal
          installedPacks={installedPacks}
          onPacksChange={handlePacksChange}
          onOpenScenario={handlePackOpenScenario}
          onClose={handlePacksClose}
        />
      )}

      {/*
       * Tutorial panel — floating guided overlay shown when the active scenario
       * contains tutorialSteps. Rendered on top of all workspace content but below
       * full-screen modals (PlcIde, AttackTerminal). The student can close it with
       * × and re-open it via the "Tutorial" button that appears in the toolbar
       * whenever the active scenario has tutorial steps.
       *
       * devices is passed so the panel can resolve {{nodeId.ip}} template variables
       * in step commands and body text with the actual configured device IP addresses,
       * making tutorial commands copy-paste correct for the current scenario config.
       */}
      {showTutorial && scenario?.meta.tutorialSteps?.length && (
        <TutorialPanel
          steps={scenario.meta.tutorialSteps}
          devices={scenario.devices.devices}
          onClose={() => setShowTutorial(false)}
        />
      )}

      {/*
       * "Importing Containers" overlay — displayed during simulation start when Docker
       * needs to pull at least one container image for the first time. The main process
       * sends a simulation:pullStatus event with { pulling: true } before running
       * docker compose up, and we show this overlay so the user understands why
       * startup is taking longer than normal.
       *
       * z-index 400 puts it above the toolbar (z 50), workspace (100), tutorial panel
       * (150), and all modals (200-300) so it is never obscured.
       */}
      {simStatus === 'starting' && pullActive && (
        <div className="pull-overlay" role="alertdialog" aria-label="Importing containers">
          <div className="pull-overlay-card">
            <div className="pull-spinner" aria-hidden="true" />
            <div className="pull-overlay-text">
              <strong>Importing Containers</strong>
              <p>
                Downloading Docker images for the first time.
                <br />
                This may take a few minutes depending on your connection speed.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
