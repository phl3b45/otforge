/**
 * ScadaCanvas.tsx — React Flow SCADA topology canvas, layer-tab model.
 *
 * One canvas scoped to the active Purdue layer tab (OT Process, IT Network,
 * DMZ, External). Nodes and edges for all layers live in the scenario document;
 * this component displays only the subset that belongs to the active layer.
 *
 * Layer-tab model vs. the old zone-band model:
 *   - No more zone background rectangles (ZoneNode) — each tab IS the zone.
 *   - Zone assignment comes from the activeLayer prop, not y-coordinate lookup.
 *   - Edges are filtered so only connections between nodes in the current layer
 *     are visible on this tab.
 *   - Position persistence: onNodeDragStop writes updated positions back to the
 *     scenario so they survive tab switches.
 *
 * OT Process tab visual differences:
 *   - Dark P&ID background (#060d14) with fine grid lines (BackgroundVariant.Lines)
 *   - PipeEdge (orthogonal routing, 3 px, filled arrowhead) instead of ProtocolEdge
 *   - Slightly wider fitView padding to show spacing between field devices
 *
 * All other tabs (IT, DMZ, External) keep the standard dark dot-grid style and
 * bezier ProtocolEdge connectors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
  type OnConnect,
  type Node,
  type Edge,
  type ReactFlowInstance,
  type OnSelectionChangeParams,
  type OnNodeDrag
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  OTForgeScenario,
  DeviceCategory,
  NetworkZone,
  DeviceConfig,
  Protocol
} from '@otforge/schema'
import { DeviceNode, type DeviceNodeData, type DeviceNodeType, ZONE_COLORS } from './DeviceNode'
import { ProtocolEdge, type ProtocolEdgeType } from './ProtocolEdge'
import { PipeEdge, type PipeEdgeType } from './PipeEdge'
import { getSourceProtocols, isConnectionValid, getRejectionReason } from './connectionRules'

/**
 * Protocol / cable options shown in the right-click connection context menu.
 * Each entry maps a schema Protocol value to a human-readable label and an
 * accent color matching the Purdue-zone palette (teal = OT, blue = DNP3, etc.).
 */
const CONNECTION_OPTIONS: { protocol: Protocol; label: string; color: string }[] = [
  { protocol: 'modbus-tcp', label: 'Modbus TCP', color: '#39d0b0' },
  { protocol: 'modbus-rtu', label: 'Modbus RTU', color: '#39d0b0' },
  { protocol: 'modbus-ascii', label: 'Modbus ASCII', color: '#39d0b0' },
  { protocol: 'dnp3', label: 'DNP3', color: '#388bfd' },
  { protocol: 'opc-ua', label: 'OPC-UA', color: '#d29922' },
  { protocol: 'bacnet', label: 'BACnet', color: '#d29922' },
  { protocol: 'ethernet-ip', label: 'EtherNet/IP', color: '#f85149' },
  { protocol: 'iec61850', label: 'IEC 61850', color: '#a371f7' },
  { protocol: 'none', label: 'Ethernet Cable', color: '#484f58' }
]

/** State shape for the right-click connection context menu. */
interface ContextMenuState {
  /** ID of the source device node that was right-clicked. */
  nodeId: string
  /** Viewport X coordinate for menu placement (used with position: fixed). */
  x: number
  /** Viewport Y coordinate for menu placement (used with position: fixed). */
  y: number
}

/**
 * State shape for a pending two-click edge connection.
 * Set when the user picks a protocol from the context menu; cleared when they
 * click a target node or press Escape.
 */
interface PendingConnectionState {
  /** The node that was right-clicked — becomes the edge source. */
  sourceId: string
  /** Protocol selected from the menu — written into the new edge's data. */
  protocol: Protocol
}

/** Registration map: React Flow node type key → component. */
const nodeTypes: NodeTypes = {
  deviceNode: DeviceNode
}

/**
 * Registration map: React Flow edge type key → component.
 * Both edge types registered so the canvas can handle scenarios that mix
 * edges created on different layer tabs.
 */
const edgeTypes: EdgeTypes = {
  protocolEdge: ProtocolEdge,
  pipeEdge: PipeEdge
}

/**
 * Fixed cell size in flow-units (pixels at zoom = 1).
 * Device nodes occupy exactly one cell; the snap grid and background gap both
 * use this value so nodes always align precisely with the visible grid lines.
 * Exported so the DeviceNode CSS and any other canvas consumers stay in sync.
 */
export const CELL_SIZE = 80

/** Default canvas is 25 columns × 25 rows of CELL_SIZE cells. */
const GRID_COLS = 25
const GRID_ROWS = 25

/** Total canvas extent in flow-units. Used as the fitBounds target rect. */
const CANVAS_W = GRID_COLS * CELL_SIZE // 2000 px at zoom = 1
const CANVAS_H = GRID_ROWS * CELL_SIZE // 2000 px at zoom = 1

/**
 * Bounding box for the full 25 × 25 canvas area.
 * Every fitBounds call targets this rect so the initial view always shows
 * the complete grid with a small margin.
 */
const CANVAS_BOUNDS = { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H }

/**
 * Default IP address for newly dropped devices, by zone.
 *
 * Must match ZONE_DEFAULTS in packages/orchestrator/src/network-config.ts — both
 * use 10.200.x.x so devices land inside the Docker bridge network on first drop.
 * Users can override in PropertiesPanel; the compose generator will also translate
 * these IPs if subnet auto-detection picks a different range at simulation start.
 *
 * Third octets: OT=10, Control=20, PlantDMZ=30, Enterprise=40, InternetDMZ=50, Attacker=60
 */
const DEFAULT_IP: Record<NetworkZone, string> = {
  ot: '10.200.10.10',
  control: '10.200.20.10',
  'plant-dmz': '10.200.30.10',
  enterprise: '10.200.40.10',
  'internet-dmz': '10.200.50.10',
  attacker: '10.200.60.10'
}

/**
 * Returns the lowest unused host address in the given zone, starting from .10.
 *
 * Looks at every device currently in the scenario, collects the host octets
 * (last octet) of IPs that share the same /24 prefix as the zone default, and
 * increments until it finds a gap. This prevents duplicate IPs when two or more
 * devices are dropped onto the same zone — Docker rejects any compose file that
 * assigns the same IP to multiple containers on the same bridge network.
 *
 * @param zone    - The Purdue zone the new device will join.
 * @param devices - All devices already present in the scenario.
 * @returns A unique IPv4 string within the zone's /24 subnet, e.g. "10.200.10.11".
 */
function nextAvailableIp(zone: NetworkZone, devices: Record<string, DeviceConfig>): string {
  const base = DEFAULT_IP[zone] // e.g. "10.200.10.10"
  const prefix = base.substring(0, base.lastIndexOf('.') + 1) // e.g. "10.200.10."

  // Collect host octets already in use on this zone's subnet
  const used = new Set<number>()
  for (const d of Object.values(devices)) {
    if (d.ipAddress.startsWith(prefix)) {
      const host = parseInt(d.ipAddress.split('.')[3], 10)
      if (!isNaN(host)) used.add(host)
    }
  }

  // .10–.239 are available for user devices.
  // .240–.249 are reserved for system services (influxdb, loki, grafana, fuxa, promtail).
  // .250–.254 are reserved for network infrastructure (zeek .252, suricata .253, firewall .254).
  let host = 10
  while (used.has(host) && host < 240) host++
  return `${prefix}${host}`
}

/**
 * Default protocol assignments for newly created devices by category.
 * Matches the container images: Modbus for PLCs/RTUs/field devices,
 * DNP3 for IEDs, no protocol for infrastructure and IT devices.
 */
const DEFAULT_PROTOCOLS: Record<DeviceCategory, Protocol[]> = {
  // ── OT Process ──────────────────────────────────────────────────────────────
  plc: ['modbus-tcp'],
  rtu: ['modbus-rtu'],
  ied: ['dnp3'],
  'legacy-plc': ['s7comm'], // Siemens S7 — S7comm primary protocol (Phase 10)
  'iec104-rtu': ['iec-104'], // IEC 60870-5-104 RTU (Phase 10)
  'process-unit': ['modbus-tcp'], // physics process sim — Modbus TCP server (Phase 11)
  sensor: ['modbus-tcp'],
  actuator: ['modbus-tcp'],
  pump: ['modbus-tcp'],
  valve: ['modbus-tcp'],
  'flow-meter': ['modbus-tcp'],
  'pressure-transmitter': ['modbus-tcp'],
  // ── Control Center (L3) ─────────────────────────────────────────────────────
  hmi: ['none'],
  historian: ['none'],
  'application-server': ['none'],
  'database-server': ['none'],
  'engineering-workstation': ['none'],
  // ── Plant DMZ (L3.5) ────────────────────────────────────────────────────────
  firewall: ['none'],
  'ids-ips': ['none'],
  switch: ['none'],
  router: ['none'],
  // ── Enterprise (L4) ─────────────────────────────────────────────────────────
  'domain-controller': ['none'],
  'web-server': ['none'],
  'business-server': ['none'],
  'enterprise-desktop': ['none'],
  // ── Internet DMZ (L5) ───────────────────────────────────────────────────────
  'email-server': ['none'],
  'internet-server': ['none'],
  'dns-server': ['none'], // authoritative DNS server — meridian-process.com zone (Phase 12)
  // ── Red Team ─────────────────────────────────────────────────────────────────
  'attack-machine': ['none']
}

/** Short display labels for device nodes on the canvas. */
const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  plc: 'PLC',
  rtu: 'RTU',
  ied: 'IED',
  'legacy-plc': 'S7 PLC', // Phase 10
  'iec104-rtu': 'IEC 104', // Phase 10
  'process-unit': 'Process Unit', // Phase 11
  sensor: 'Sensor',
  actuator: 'Actuator',
  pump: 'Pump',
  valve: 'Valve',
  'flow-meter': 'Flow Meter',
  'pressure-transmitter': 'Pressure TX',
  hmi: 'HMI',
  historian: 'Historian',
  'application-server': 'App Server',
  'database-server': 'DB Server',
  'engineering-workstation': 'Eng. WS',
  firewall: 'Firewall',
  'ids-ips': 'IDS/IPS',
  switch: 'Switch',
  router: 'Router',
  'domain-controller': 'Domain Ctrl',
  'web-server': 'Web Server',
  'business-server': 'Biz Server',
  'enterprise-desktop': 'Desktop',
  'email-server': 'Email Server',
  'internet-server': 'Internet Srv',
  'dns-server': 'DNS Server', // Phase 12
  'attack-machine': 'Attack Machine'
}

/**
 * Maps a device category to its default Purdue zone.
 * Used during auto-layout when no visual positions have been saved yet,
 * and when the canvas needs to infer the zone of a newly dropped device.
 */
function categoryToZone(category: DeviceCategory): NetworkZone {
  // Red Team — isolated subnet, not shown in any Purdue layer tab
  if (category === 'attack-machine') return 'attacker'
  // Level 4 Enterprise Zone
  if (
    ['domain-controller', 'web-server', 'business-server', 'enterprise-desktop'].includes(category)
  )
    return 'enterprise'
  // Level 5 Internet DMZ
  if (['email-server', 'internet-server', 'dns-server'].includes(category)) return 'internet-dmz'
  // Level 3.5 Plant DMZ (firewall and IDS/IPS go here; switch/router can appear in multiple zones
  // but default to plant-dmz as the primary network boundary layer)
  if (category === 'firewall' || category === 'ids-ips') return 'plant-dmz'
  // Level 3 Control Center
  if (
    [
      'hmi',
      'historian',
      'application-server',
      'database-server',
      'engineering-workstation'
    ].includes(category)
  )
    return 'control'
  // Level 0–2 OT (PLCs, RTUs, sensors, actuators, switches, routers on the field network)
  return 'ot'
}

/**
 * Converts a scenario's visual layer into React Flow DeviceNode objects,
 * filtered to the given activeLayer only.
 *
 * Two layout paths:
 *   1. Saved positions (scenario.visual.nodes.length > 0) — restored directly.
 *   2. No saved positions — simple 6-column grid starting at (80, 80); no zone
 *      band y-offsets needed since each tab shows only its own devices.
 */
function scenarioToNodes(scenario: OTForgeScenario, activeLayer: NetworkZone): DeviceNodeType[] {
  const hasVisual = scenario.visual.nodes.length > 0

  if (hasVisual) {
    return scenario.visual.nodes
      .filter(cn => cn.data.zone === activeLayer)
      .map(cn => ({
        id: cn.id,
        type: 'deviceNode' as const,
        position: cn.position,
        // Pre-declare dimensions so React Flow knows node size before DOM measurement.
        // Keeps edges positioned correctly on first render and after layer switches.
        width: CELL_SIZE,
        height: CELL_SIZE,
        data: {
          device: scenario.devices.devices[cn.id] ?? {
            nodeId: cn.id,
            // Visual-only nodes (pump, valve, sensor) live in visual.nodes but not in
            // devices.devices because they have no container. Use cn.type (the category
            // written at drop time) so the correct icon appears instead of defaulting
            // to 'sensor' for everything. ipAddress '' suppresses the IP label display.
            category: (cn.type as DeviceCategory) ?? ('sensor' as DeviceCategory),
            ipAddress: '',
            protocols: ['none' as Protocol]
          },
          label: cn.data.label,
          zone: cn.data.zone as NetworkZone
        }
      }))
  }

  // Auto-layout: collect only devices belonging to this layer, then grid them
  const layerDeviceIds = Object.keys(scenario.devices.devices).filter(
    id => categoryToZone(scenario.devices.devices[id].category) === activeLayer
  )

  return layerDeviceIds.map((id, i) => {
    const dev = scenario.devices.devices[id]
    return {
      id,
      type: 'deviceNode' as const,
      // Auto-layout in a 6-column grid aligned to CELL_SIZE boundaries so nodes
      // land precisely on grid lines when a scenario is first loaded.
      position: {
        x: (i % 6) * CELL_SIZE,
        y: Math.floor(i / 6) * CELL_SIZE
      },
      width: CELL_SIZE,
      height: CELL_SIZE,
      data: {
        device: dev,
        label: CATEGORY_LABELS[dev.category],
        zone: activeLayer
      }
    }
  })
}

/**
 * Converts a scenario's visual edge list into typed React Flow edge objects,
 * filtered so only edges where BOTH endpoints are in the current layer are shown.
 *
 * OT layer → PipeEdgeType (orthogonal P&ID routing)
 * All other layers → ProtocolEdgeType (bezier curves)
 */
function scenarioToEdges(
  scenario: OTForgeScenario,
  activeLayer: NetworkZone,
  layerNodeIds: Set<string>
): (ProtocolEdgeType | PipeEdgeType)[] {
  const edgeType = activeLayer === 'ot' ? ('pipeEdge' as const) : ('protocolEdge' as const)
  return scenario.visual.edges
    .filter(ce => layerNodeIds.has(ce.source) && layerNodeIds.has(ce.target))
    .map(ce => ({
      id: ce.id,
      source: ce.source,
      target: ce.target,
      type: edgeType,
      data: {
        protocol: ce.data.protocol,
        ...(ce.data.label !== undefined ? { label: ce.data.label } : {}),
        // Pass coilSource through to PipeEdge so the ScadaCanvas polling loop
        // knows which PLC coil drives this edge's flow-state animation.
        // Only present on OT-layer edges that have a coilSource in the scenario.
        ...(activeLayer === 'ot' && ce.data.coilSource !== undefined
          ? { coilSource: ce.data.coilSource }
          : {})
      }
    }))
}

interface ScadaCanvasProps {
  scenario: OTForgeScenario | null
  /** The currently active Purdue layer — scopes which nodes and edges are visible. */
  activeLayer: NetworkZone
  /**
   * Whether to show and snap to the 25 × 25 cell grid.
   * When true, enables visual grid lines (BackgroundVariant.Lines at CELL_SIZE gap)
   * and React Flow's snap-to-grid behavior. Passed as false during simulation so
   * the grid disappears and snap is disabled while containers are running.
   */
  showGrid: boolean
  /**
   * When true, the canvas is view-only: devices cannot be added, moved, connected,
   * or deleted. Used in Student mode (locked scenario) to prevent topology modification.
   * Pan, zoom, and node selection (for PropertiesPanel) still work.
   */
  readOnly?: boolean
  /**
   * Flat list of all pack-contributed device types from installed community packs.
   * When a device is dropped from the pack palette section, the canvas looks up the
   * matching entry here to resolve the custom Docker image and canonical label.
   * Passed down from App so the canvas doesn't need to call the IPC directly.
   */
  packDeviceTypes?: import('@otforge/schema').ResolvedPackDeviceType[]
  /**
   * Whether the simulation is currently running.
   * When true and the OT layer is active, the canvas polls PLC coil states every
   * 2 s and applies flow-state colors and animations to coil-sourced pipe edges.
   */
  simRunning?: boolean
  onSelectDevice: (nodeId: string | null, device: DeviceConfig | null) => void
  onScenarioChange: (updater: (s: OTForgeScenario | null) => OTForgeScenario | null) => void
}

/**
 * The main SCADA topology canvas, scoped to the active Purdue layer tab.
 *
 * Renders the React Flow canvas showing only the devices and connections that
 * belong to the active layer. Dropping a device assigns it to activeLayer. The
 * OT tab uses a dark P&ID style; other tabs use the standard dark dot-grid.
 */
export function ScadaCanvas({
  scenario,
  activeLayer,
  showGrid,
  readOnly = false,
  packDeviceTypes = [],
  simRunning = false,
  onSelectDevice,
  onScenarioChange
}: ScadaCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  /**
   * Live coil state map — keyed by "${nodeId}:${coilIndex}", value is boolean.
   * Populated by the polling useEffect below when the simulation is running and
   * the OT layer is active. Empty map = simulation not running or no coil edges.
   */
  const [coilStates, setCoilStates] = useState<Map<string, boolean>>(new Map())

  /**
   * Live holding-register map — keyed by PLC nodeId, value is HR0 (tank_level, 0–1000 cm).
   * Populated alongside coilStates in the same polling loop via FC03 Read Holding Registers.
   * Empty map = simulation not running. Used to derive fillLevel for process-unit nodes.
   */
  const [levelStates, setLevelStates] = useState<Map<string, number>>(new Map())

  /** Right-click context menu — null when closed. */
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  /**
   * Pending two-click connection state.
   * After the user picks a protocol from the context menu, this holds the source
   * node ID and chosen protocol until they click a target (or press Escape).
   */
  const [pendingConnection, setPendingConnection] = useState<PendingConnectionState | null>(null)

  /**
   * Tooltip displayed when the student clicks an invalid target during a pending
   * connection. Shows the rejection reason from getRejectionReason() and auto-clears
   * after 3 seconds. Positioned at the cursor's clientX/clientY.
   */
  const [invalidTooltip, setInvalidTooltip] = useState<{
    message: string
    x: number
    y: number
  } | null>(null)

  /**
   * Ref to the React Flow instance — needed for screenToFlowPosition() in onDrop.
   * Using a ref avoids wrapping in ReactFlowProvider just to call useReactFlow().
   */
  const rfInstance = useRef<ReactFlowInstance | null>(null)

  /**
   * Tracks the last layer that triggered a fitView call.
   * fitView must only run when the user switches layer tabs, NOT on every scenario
   * mutation (node added, node dragged, edge added). Without this guard, dropping a
   * device triggers a scenario update which fires the useEffect, which calls fitView,
   * which re-centers the viewport — making the device appear to "snap to center".
   */
  const prevLayerRef = useRef<NetworkZone | null>(null)

  /**
   * Timer ref for auto-dismissing the invalid connection tooltip.
   * Stored in a ref so the previous timer can be cancelled before setting a new one
   * (prevents stale closures from clearing a tooltip the user just triggered).
   */
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Polls PLC coil states AND holding registers via Modbus TCP while the simulation
   * is running on the OT layer.
   *
   * Every 2 s:
   *   - FC01 Read Coils  → coilStates  → pipe-edge flow animation (green/red)
   *   - FC03 Read Holding Registers → levelStates → process-unit fill animation
   *
   * Groups reads by PLC nodeId so one IPC round-trip covers all coil edges for a PLC.
   * Holding registers always read 3 registers (HR0=tank_level, HR1=inlet_flow,
   * HR2=outlet_flow) from the same PLCs found via coilSource edges.
   *
   * The polling interval clears when the simulation stops, the layer changes, or the
   * component unmounts so there are no dangling timers.
   *
   * All failures are silent (readCoils/readHoldingRegisters return [] on error) so a
   * temporarily unreachable PLC does not break the canvas — last known state persists.
   */
  useEffect(() => {
    if (!simRunning || activeLayer !== 'ot') {
      setCoilStates(new Map())
      setLevelStates(new Map())
      return
    }

    // Collect edges that carry a coilSource binding (the wired OT pipe edges)
    const coilEdges = edges.filter(e => {
      const d = e.data as import('./PipeEdge').PipeEdgeData
      return d?.coilSource !== undefined
    })
    if (coilEdges.length === 0) return

    // Group by PLC nodeId, tracking the highest coilIndex needed for each PLC so
    // a single FC01 frame reads all coils in one round-trip.
    const plcMaxCoil = new Map<string, number>()
    for (const edge of coilEdges) {
      const { nodeId, coilIndex } = (edge.data as import('./PipeEdge').PipeEdgeData).coilSource!
      const current = plcMaxCoil.get(nodeId) ?? -1
      if (coilIndex > current) plcMaxCoil.set(nodeId, coilIndex)
    }

    const poll = async () => {
      const nextCoils = new Map<string, boolean>()
      const nextLevels = new Map<string, number>()

      for (const [nodeId, maxIdx] of plcMaxCoil.entries()) {
        // ── FC01 Read Coils — drives pipe-edge flow animation ──────────────────
        try {
          const coils = await window.electronAPI.modbus.readCoils(nodeId, maxIdx + 1)
          for (let i = 0; i <= maxIdx; i++) {
            if (coils[i] !== undefined) nextCoils.set(`${nodeId}:${i}`, coils[i])
          }
        } catch {
          // Non-fatal: keep previous coil state for this PLC
        }

        // ── FC03 Read Holding Registers — drives Water Tank fill animation ─────
        // Read 3 registers: HR0=tank_level (0–1000 cm), HR1=inlet_flow, HR2=outlet_flow
        try {
          const regs = await window.electronAPI.modbus.readHoldingRegisters(nodeId, 3)
          if (regs.length > 0) nextLevels.set(nodeId, regs[0]) // HR0 = tank_level
        } catch {
          // Non-fatal: keep previous level state for this PLC
        }
      }

      setCoilStates(nextCoils)
      setLevelStates(nextLevels)
    }

    poll() // Immediate first poll — don't wait 2 s for initial values
    const timer = setInterval(poll, 2000)
    return () => clearInterval(timer)
  }, [simRunning, activeLayer, edges])

  /**
   * Edges augmented with live `flowActive` values for coil-sourced pipe edges.
   * Derived from `edges` (React Flow state) and `coilStates` (polling result).
   * Only pipe edges with a `coilSource` binding are modified; all others pass through.
   * Passed to ReactFlow's `edges` prop while the underlying state stays clean for
   * position/type mutations.
   */
  const displayEdges = useMemo(() => {
    if (coilStates.size === 0) return edges
    return edges.map(edge => {
      const pipeData = edge.data as import('./PipeEdge').PipeEdgeData
      if (!pipeData?.coilSource) return edge
      const key = `${pipeData.coilSource.nodeId}:${pipeData.coilSource.coilIndex}`
      const flowActive = coilStates.get(key)
      if (flowActive === undefined) return edge
      return { ...edge, data: { ...pipeData, flowActive } }
    })
  }, [edges, coilStates])

  /**
   * Context-menu protocol options filtered to only those valid for the source device.
   * When the student right-clicks a Sensor, for example, they see only Modbus and DNP3
   * instead of the full list — this prevents picking a protocol that would then be
   * immediately rejected when they click the target.
   *
   * Falls back to the full CONNECTION_OPTIONS list when the source node cannot be
   * resolved (defensive case — should not occur in normal usage).
   */
  const filteredConnectionOptions = useMemo(() => {
    if (!contextMenu) return CONNECTION_OPTIONS
    const sourceNode = nodes.find(n => n.id === contextMenu.nodeId)
    if (!sourceNode) return CONNECTION_OPTIONS
    const sourceCategory = (sourceNode.data as DeviceNodeData).device.category
    const validProtocols = getSourceProtocols(sourceCategory)
    return CONNECTION_OPTIONS.filter(opt => validProtocols.has(opt.protocol))
  }, [contextMenu, nodes])

  /**
   * Nodes augmented with two kinds of live data, merged into a single memoised array:
   *
   * 1. Connection-state CSS classes (when a pending connection is active):
   *    'connection-source' — the node that was right-clicked to start the connection;
   *                          gets a teal glow so the student knows which device is FROM.
   *    'invalid-target'    — nodes that cannot receive the selected protocol;
   *                          dimmed to 30% opacity, cursor changes to not-allowed.
   *    React Flow applies node.className to its wrapper div, so CSS selectors like
   *    `.invalid-target .device-node { ... }` work correctly.
   *
   * 2. fillLevel for process-unit (Water Tank) nodes — a 0.0–1.0 fraction derived
   *    from HR0 (tank_level, 0–1000 cm) polled from the PLC every 2 s. DeviceNode
   *    uses this to render a rising water fill animation that makes the overflow attack
   *    visible to students without needing a separate Grafana dashboard.
   *
   * The underlying `nodes` state is never mutated — changes live only in displayNodes.
   */
  const displayNodes = useMemo(() => {
    // Step 1 — apply connection-state class names when a pending connection is active
    let result: typeof nodes = nodes

    if (pendingConnection) {
      const sourceNode = nodes.find(n => n.id === pendingConnection.sourceId)
      if (sourceNode) {
        const sourceCategory = (sourceNode.data as DeviceNodeData).device.category
        result = nodes.map(n => {
          if (n.id === pendingConnection.sourceId) {
            return { ...n, className: 'connection-source' }
          }
          const targetCategory = (n.data as DeviceNodeData).device.category
          const valid = isConnectionValid(
            sourceCategory,
            targetCategory,
            pendingConnection.protocol
          )
          return { ...n, className: valid ? '' : 'invalid-target' }
        })
      }
    }

    // Step 2 — inject fillLevel into process-unit nodes from live HR0 register polling.
    // Only runs while the simulation is active (levelStates is empty map otherwise).
    if (levelStates.size > 0) {
      result = result.map(n => {
        const data = n.data as DeviceNodeData
        if (data.device.category !== 'process-unit') return n

        // Find any connected edge that carries a coilSource to identify which PLC
        // owns the tank_level register. The coilSource.nodeId is the PLC node.
        const connectedEdge = edges.find(e => {
          const d = e.data as import('./PipeEdge').PipeEdgeData
          return d?.coilSource !== undefined && (e.source === n.id || e.target === n.id)
        })
        if (!connectedEdge) return n

        const { nodeId: plcId } = (connectedEdge.data as import('./PipeEdge').PipeEdgeData)
          .coilSource!
        const raw = levelStates.get(plcId)
        if (raw === undefined) return n

        // Scale tank_level (0–1000 cm) → fillLevel (0.0–1.0), clamped for safety
        const fillLevel = Math.min(1, Math.max(0, raw / 1000))
        return { ...n, data: { ...data, fillLevel } }
      })
    }

    return result
  }, [nodes, pendingConnection, levelStates, edges])

  // Sync canvas state when the scenario or active layer changes
  useEffect(() => {
    if (!scenario) {
      setNodes([])
      setEdges([])
      // No nodes — show the full 25 × 25 canvas area so the user sees the grid
      setTimeout(
        () => rfInstance.current?.fitBounds(CANVAS_BOUNDS, { padding: 0.04, duration: 0 }),
        100
      )
      prevLayerRef.current = null
      return
    }
    const deviceNodes = scenarioToNodes(scenario, activeLayer)
    const layerNodeIds = new Set(deviceNodes.map(n => n.id))
    setNodes(deviceNodes)
    setEdges(scenarioToEdges(scenario, activeLayer, layerNodeIds) as Edge[])
    // Only re-fit when the active layer tab changes — not on every node/edge mutation.
    // Scenario edits (drops, drags, connections) must not re-center the viewport.
    if (prevLayerRef.current !== activeLayer) {
      prevLayerRef.current = activeLayer
      setTimeout(
        () => rfInstance.current?.fitBounds(CANVAS_BOUNDS, { padding: 0.04, duration: 0 }),
        50
      )
    }
  }, [scenario, activeLayer, setNodes, setEdges])

  /*
   * Re-fit whenever the browser window is resized or maximized.
   * Without this the canvas stays zoomed to the window size at mount time
   * even after the user resizes to a larger viewport.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const handleResize = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        rfInstance.current?.fitBounds(CANVAS_BOUNDS, { padding: 0.04, duration: 0 })
      }, 150)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      clearTimeout(timer)
    }
  }, [])

  /**
   * New protocol edge — OT tab creates a pipeEdge, all others a protocolEdge.
   * Default protocol is modbus-tcp; user can change via edge properties.
   */
  const onConnect: OnConnect = useCallback(
    connection => {
      const edgeType = activeLayer === 'ot' ? 'pipeEdge' : 'protocolEdge'
      const newEdge = {
        ...connection,
        id: `${connection.source}-${connection.target}-${Date.now()}`,
        type: edgeType,
        data: { protocol: 'modbus-tcp' as Protocol }
      }
      setEdges(eds => addEdge(newEdge as Edge, eds))

      if (connection.source && connection.target) {
        onScenarioChange(prev => {
          if (!prev) return prev
          const ce = {
            id: newEdge.id,
            source: connection.source!,
            target: connection.target!,
            data: { protocol: 'modbus-tcp' as Protocol }
          }
          return { ...prev, visual: { ...prev.visual, edges: [...prev.visual.edges, ce] } }
        })
      }
    },
    [setEdges, onScenarioChange, activeLayer]
  )

  /** Only single device node selections populate the PropertiesPanel. */
  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams) => {
      if (selectedNodes.length !== 1) {
        onSelectDevice(null, null)
        return
      }
      const node = selectedNodes[0]
      if (node.type !== 'deviceNode') {
        onSelectDevice(null, null)
        return
      }
      const data = node.data as DeviceNodeData
      onSelectDevice(node.id, data.device)
    },
    [onSelectDevice]
  )

  const onDragOver = useCallback(
    (event: React.DragEvent) => {
      if (readOnly) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    [readOnly]
  )

  /**
   * Node deletion — called by React Flow after it removes nodes from canvas state.
   * Persists the removal to scenario.visual.nodes, scenario.visual.edges (prune
   * any edges that referenced a deleted node), and scenario.devices.devices.
   * Also clears the PropertiesPanel selection so it doesn't show a stale device.
   */
  const onNodesDelete = useCallback(
    (deletedNodes: Node[]) => {
      const deletedIds = new Set(deletedNodes.map(n => n.id))
      onSelectDevice(null, null)
      onScenarioChange(prev => {
        if (!prev) return prev
        return {
          ...prev,
          visual: {
            ...prev.visual,
            nodes: prev.visual.nodes.filter(n => !deletedIds.has(n.id)),
            edges: prev.visual.edges.filter(
              e => !deletedIds.has(e.source) && !deletedIds.has(e.target)
            )
          },
          devices: {
            devices: Object.fromEntries(
              Object.entries(prev.devices.devices).filter(([id]) => !deletedIds.has(id))
            )
          }
        }
      })
    },
    [onScenarioChange, onSelectDevice]
  )

  /**
   * Edge deletion — called by React Flow after it removes edges from canvas state.
   * Persists the removal to scenario.visual.edges.
   */
  const onEdgesDelete = useCallback(
    (deletedEdges: Edge[]) => {
      const deletedIds = new Set(deletedEdges.map(e => e.id))
      onScenarioChange(prev => {
        if (!prev) return prev
        return {
          ...prev,
          visual: {
            ...prev.visual,
            edges: prev.visual.edges.filter(e => !deletedIds.has(e.id))
          }
        }
      })
    },
    [onScenarioChange]
  )

  /**
   * Cancels any open context menu, in-progress pending connection, or invalid tooltip.
   * Bound to clicking empty canvas space, pressing Escape, and the Cancel menu item.
   */
  const cancelConnection = useCallback(() => {
    setContextMenu(null)
    setPendingConnection(null)
    setInvalidTooltip(null)
    if (tooltipTimerRef.current !== null) {
      clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = null
    }
  }, [])

  /**
   * Right-click on a canvas device node — opens the protocol selection menu at the
   * cursor position and cancels any previously pending connection.
   * Disabled in readOnly mode (Student mode) — no new edges can be created.
   */
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (readOnly) return
      event.preventDefault()
      setPendingConnection(null)
      setContextMenu({ nodeId: node.id, x: event.clientX, y: event.clientY })
    },
    [readOnly]
  )

  /**
   * Called when the user picks a protocol from the right-click context menu.
   * Transitions from "menu open" to "awaiting target click" mode.
   * The canvas cursor changes to a crosshair (via .connecting CSS class) to
   * signal that the next node click will complete the connection.
   */
  const startConnection = useCallback(
    (protocol: Protocol) => {
      if (!contextMenu) return
      setPendingConnection({ sourceId: contextMenu.nodeId, protocol })
      setContextMenu(null)
    },
    [contextMenu]
  )

  /**
   * Click on a canvas device node.
   *
   * If a pending connection is active:
   *   1. Self-click → cancel the connection (no self-loops).
   *   2. Valid target → create the edge and persist it to the scenario.
   *   3. Invalid target → show a rejection tooltip at the cursor position with an
   *      educational explanation. The connection is NOT created and the pending state
   *      stays active so the student can click a valid target instead.
   *
   * Validation uses the VALID_CONNECTIONS matrix from connectionRules.ts, which
   * encodes the ICS Purdue Reference Model (IEC 62443-3-2 / NIST SP 800-82).
   *
   * If no pending connection is active this is a no-op — selection is handled by
   * onSelectionChange via React Flow's built-in machinery.
   */
  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (!pendingConnection) return

      if (node.id === pendingConnection.sourceId) {
        // Clicked the source again — treat as cancel
        cancelConnection()
        return
      }

      // ── Protocol / Purdue-model validation ────────────────────────────────
      // Look up both ends of the attempted connection and check the matrix.
      const sourceNode = nodes.find(n => n.id === pendingConnection.sourceId)
      if (sourceNode) {
        const sourceCategory = (sourceNode.data as DeviceNodeData).device.category
        const targetCategory = (node.data as DeviceNodeData).device.category

        if (!isConnectionValid(sourceCategory, targetCategory, pendingConnection.protocol)) {
          // Block the connection and show a short educational tooltip at the cursor.
          // The pending connection stays active — student can pick a valid target.
          const message = getRejectionReason(
            sourceCategory,
            targetCategory,
            pendingConnection.protocol
          )
          if (tooltipTimerRef.current !== null) clearTimeout(tooltipTimerRef.current)
          setInvalidTooltip({ message, x: event.clientX, y: event.clientY })
          // Auto-dismiss after 3 seconds so the tooltip doesn't stay forever
          tooltipTimerRef.current = setTimeout(() => setInvalidTooltip(null), 3000)
          return
        }
      }

      // ── Valid connection — create the edge ────────────────────────────────
      const edgeType = activeLayer === 'ot' ? 'pipeEdge' : 'protocolEdge'
      const newEdge: Edge = {
        id: `${pendingConnection.sourceId}-${node.id}-${Date.now()}`,
        source: pendingConnection.sourceId,
        target: node.id,
        type: edgeType,
        data: { protocol: pendingConnection.protocol }
      }

      setEdges(eds => addEdge(newEdge, eds))

      onScenarioChange(prev => {
        if (!prev) return prev
        const ce = {
          id: newEdge.id,
          source: pendingConnection.sourceId,
          target: node.id,
          data: { protocol: pendingConnection.protocol }
        }
        return { ...prev, visual: { ...prev.visual, edges: [...prev.visual.edges, ce] } }
      })

      setPendingConnection(null)
    },
    [pendingConnection, nodes, activeLayer, setEdges, onScenarioChange, cancelConnection]
  )

  // Escape key cancels the open menu or pending connection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
        setPendingConnection(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  /**
   * Persist node positions after a drag ends.
   * Updates scenario.visual.nodes with the new positions so they survive
   * tab switches and file saves.
   */
  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, _node, allNodes) => {
      onScenarioChange(prev => {
        if (!prev) return prev
        const updatedVisualNodes = prev.visual.nodes.map(cn => {
          const moved = allNodes.find(n => n.id === cn.id)
          return moved ? { ...cn, position: moved.position } : cn
        })
        return { ...prev, visual: { ...prev.visual, nodes: updatedVisualNodes } }
      })
    },
    [onScenarioChange]
  )

  /**
   * Device drop from palette onto canvas.
   * Zone assignment comes from activeLayer — no y-coordinate lookup needed.
   * No-op in readOnly mode (Student mode).
   *
   * Handles two drop sources:
   *   1. Built-in palette items — only `deviceCategory` drag data is set.
   *   2. Pack palette items — both `deviceCategory` and `packDeviceTypeId` are set.
   *      The `packDeviceTypeId` format is `<packId>:<typeId>`. The canvas resolves
   *      it against `packDeviceTypes` to get the custom Docker image and label.
   */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      if (readOnly) return
      const category = event.dataTransfer.getData('deviceCategory') as DeviceCategory
      if (!category || !rfInstance.current) return

      // Check if this is a pack device type drop
      const packDeviceTypeId = event.dataTransfer.getData('packDeviceTypeId') || null
      const packDeviceType = packDeviceTypeId
        ? (packDeviceTypes.find(dt => `${dt.packId}:${dt.id}` === packDeviceTypeId) ?? null)
        : null

      const rawPos = rfInstance.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      })
      // Snap to the nearest cell boundary on drop.
      // React Flow's snapToGrid prop only activates during drag; the initial drop
      // position must be rounded manually to keep icons on the grid.
      const position = showGrid
        ? {
            x: Math.round(rawPos.x / CELL_SIZE) * CELL_SIZE,
            y: Math.round(rawPos.y / CELL_SIZE) * CELL_SIZE
          }
        : rawPos

      const zone = activeLayer
      const nodeId = `${category}-${Date.now()}`
      // Assign the lowest unused IP in the zone so multiple devices on the same
      // network don't collide — Docker rejects compose files with duplicate IPs.
      const existingDevices = scenario?.devices.devices ?? {}
      const device: DeviceConfig = {
        nodeId,
        category,
        ipAddress: nextAvailableIp(zone, existingDevices),
        // Pack device types supply their own default protocols; built-ins use the map.
        protocols: packDeviceType?.defaultProtocols ?? DEFAULT_PROTOCOLS[category],
        // dockerImage override: pack device types specify the exact image to use.
        // This is read by compose-generator.ts to substitute the default category image.
        ...(packDeviceType?.defaultDockerImage
          ? { dockerImage: packDeviceType.defaultDockerImage }
          : {})
      }

      // IED devices run the DNP3 outstation container — pre-populate default DNP3
      // config so the PropertiesPanel shows the addresses immediately and the compose
      // generator can inject the correct env vars without the user having to configure
      // them first. outstationAddress 10 is a recognisable non-zero default; users can
      // change it in PropertiesPanel. port 20000 is the IANA-registered DNP3 TCP port.
      if (category === 'ied') {
        device.dnp3 = { masterAddress: 1, outstationAddress: 10, port: 20000 }
      }

      // Use the pack device type's label if available; fall back to the built-in label.
      const nodeLabel = packDeviceType?.label ?? CATEGORY_LABELS[category]

      const newNode: DeviceNodeType = {
        id: nodeId,
        type: 'deviceNode',
        position,
        // Pre-declare node dimensions so edges connect correctly before DOM measurement
        width: CELL_SIZE,
        height: CELL_SIZE,
        data: { device, label: nodeLabel, zone }
      }

      setNodes(nds => [...nds, newNode])

      onScenarioChange(prev => {
        const base = prev ?? buildEmptyScenario()
        return {
          ...base,
          visual: {
            ...base.visual,
            nodes: [
              ...base.visual.nodes,
              {
                id: nodeId,
                type: category,
                position,
                data: { label: nodeLabel, zone }
              }
            ]
          },
          devices: {
            devices: { ...base.devices.devices, [nodeId]: device }
          }
        }
      })
    },
    [setNodes, onScenarioChange, activeLayer, showGrid, scenario, readOnly, packDeviceTypes]
  )

  const isOT = activeLayer === 'ot'

  return (
    /* .connecting class switches the cursor to a crosshair when the user has
       picked a protocol and is waiting to click a target node. */
    <div
      className={`canvas-container${isOT ? ' canvas-ot' : ''}${pendingConnection ? ' connecting' : ''}`}
    >
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodesDelete={readOnly ? undefined : onNodesDelete}
        onEdgesDelete={readOnly ? undefined : onEdgesDelete}
        onConnect={readOnly ? undefined : onConnect}
        onSelectionChange={onSelectionChange}
        onNodeDragStop={readOnly ? undefined : onNodeDragStop}
        onNodeContextMenu={onNodeContextMenu}
        onNodeClick={onNodeClick}
        onPaneClick={cancelConnection}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : 'Delete'}
        onInit={instance => {
          rfInstance.current = instance
          // Fit the full 25 × 25 grid immediately on mount — no setTimeout needed
          // because onInit fires exactly when the React Flow instance is ready and
          // the canvas has its final dimensions. This prevents the flash at zoom=1
          // that would otherwise appear before the useEffect fitBounds fires.
          instance.fitBounds(CANVAS_BOUNDS, { padding: 0.04, duration: 0 })
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: isOT ? 'pipeEdge' : 'protocolEdge', animated: false }}
        multiSelectionKeyCode="Shift"
        minZoom={0.08}
        maxZoom={2}
        snapToGrid={showGrid}
        snapGrid={[CELL_SIZE, CELL_SIZE]}
        proOptions={{ hideAttribution: true }}
      >
        {/*
         * Background grid:
         * - OT tab always uses Lines on the dark P&ID navy background.
         *   When a grid size is set, the line gap matches the snap grid so
         *   users can see exactly where nodes will snap.
         * - Other tabs use Dots (no grid) or Lines (grid active).
         */}
        {/*
         * Background pattern — shown only when the grid toggle is on.
         * When grid is off the canvas is plain (no dots, no lines) so the user
         * sees a clean workspace. Snap-to-grid is also disabled via snapToGrid={showGrid}.
         *
         * The teal color rgba(57,208,176,0.5) is the OT zone accent at 50% opacity —
         * clearly visible against both the navy OT background (#060d14) and the
         * standard dark canvas (#0d1117).
         */}
        {showGrid && (
          <Background
            variant={BackgroundVariant.Lines}
            gap={CELL_SIZE}
            color="rgba(57, 208, 176, 0.5)"
            lineWidth={1}
          />
        )}
        <Controls
          style={{ background: '#1c2128', border: '1px solid #30363d', borderRadius: 6 }}
          showInteractive={false}
        />
        <MiniMap
          style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6 }}
          nodeColor={node => {
            const data = node.data as DeviceNodeData
            return ZONE_COLORS[data.zone] ?? '#484f58'
          }}
          maskColor="rgba(13, 17, 23, 0.7)"
        />
      </ReactFlow>

      {/* ── Right-click protocol selection menu ─────────────────────────────── */}
      {/* Rendered outside ReactFlow so it sits above the canvas SVG layer.
          Uses position:fixed so clientX/clientY coordinates work directly. */}
      {contextMenu && (
        <div
          className="connection-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={e => e.preventDefault()}
        >
          <div className="connection-context-menu-title">Connect via…</div>
          <div className="connection-context-menu-sep" />
          {filteredConnectionOptions.map(opt => (
            <button
              key={opt.protocol}
              className="connection-context-menu-item"
              onClick={() => startConnection(opt.protocol)}
            >
              {/* Color dot matches the protocol accent (teal = Modbus, blue = DNP3, etc.) */}
              <span className="connection-context-menu-dot" style={{ background: opt.color }} />
              {opt.label}
            </button>
          ))}
          <div className="connection-context-menu-sep" />
          <button
            className="connection-context-menu-item connection-context-menu-cancel"
            onClick={cancelConnection}
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Connecting mode hint banner ──────────────────────────────────────── */}
      {/* Shown at the bottom of the canvas while awaiting a target node click. */}
      {pendingConnection && (
        <div className="connection-mode-hint">
          Click a device to connect — press <kbd>Esc</kbd> to cancel
        </div>
      )}

      {/* ── Invalid connection tooltip ────────────────────────────────────────── */}
      {/* Appears at the cursor position when the student clicks an incompatible   */}
      {/* target. Explains why the connection is rejected and what protocols ARE   */}
      {/* valid, so the student learns the Purdue model without reading docs.      */}
      {/* Auto-dismisses after 3 s; the pending connection stays active so the    */}
      {/* student can immediately click a valid target node instead.              */}
      {invalidTooltip && (
        <div
          className="connection-invalid-tooltip"
          style={{ left: invalidTooltip.x, top: invalidTooltip.y }}
        >
          <span className="connection-invalid-tooltip-icon">⚠</span>
          <span>{invalidTooltip.message}</span>
        </div>
      )}
    </div>
  )
}

/**
 * Minimal OTForgeScenario with all four Purdue network segments pre-defined.
 * Created when the user drops their first device onto a blank canvas.
 */
function buildEmptyScenario(): OTForgeScenario {
  return {
    meta: {
      formatVersion: '1.0',
      name: 'Untitled Scenario',
      description: '',
      sector: 'generic',
      author: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      appVersion: '0.1.0',
      locked: false,
      brief: '',
      requirements: { estimatedRamMb: 0, estimatedCpuCores: 1, containerCount: 0 }
    },
    visual: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    network: {
      // Subnets match ZONE_DEFAULTS in network-config.ts (10.200.x.x).
      // The compose generator translates these at simulation start if subnet
      // auto-detection picks a different range to avoid host interface conflicts.
      // The 'attacker' zone is omitted here — it is created automatically by the
      // compose generator when an attack-machine device is present in the scenario.
      segments: [
        { zone: 'ot', subnet: '10.200.10.0/24', gateway: '10.200.10.1', dockerNetwork: 'ot-net' },
        {
          zone: 'control',
          subnet: '10.200.20.0/24',
          gateway: '10.200.20.1',
          dockerNetwork: 'control-net'
        },
        {
          zone: 'plant-dmz',
          subnet: '10.200.30.0/24',
          gateway: '10.200.30.1',
          dockerNetwork: 'plant-dmz-net'
        },
        {
          zone: 'enterprise',
          subnet: '10.200.40.0/24',
          gateway: '10.200.40.1',
          dockerNetwork: 'enterprise-net'
        },
        {
          zone: 'internet-dmz',
          subnet: '10.200.50.0/24',
          gateway: '10.200.50.1',
          dockerNetwork: 'internet-dmz-net'
        }
      ],
      routes: []
    },
    devices: { devices: {} },
    security: {
      defaultFirewallPolicy: 'deny',
      firewallRules: [],
      ids: { enabledRulesets: [], disabledRuleIds: [], zeekScripts: [] },
      logging: { retentionDays: 30, influxdbEnabled: true, lokiEnabled: true }
    },
    registry: [],
    packLayers: []
  }
}
