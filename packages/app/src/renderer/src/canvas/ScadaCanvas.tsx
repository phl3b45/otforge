/**
 * ScadaCanvas.tsx — React Flow SCADA topology editor canvas.
 *
 * This is the central interactive component of the ICS Simulator UI. It renders
 * a pannable, zoomable canvas where users:
 *   - See four network zone regions (OT, IT, DMZ, External) as background nodes
 *   - Drag device types from the DevicePalette and drop them onto a zone
 *   - Connect devices by dragging between their Handle endpoints
 *   - Select a device node to populate the PropertiesPanel
 *   - Delete nodes/edges with the Delete key
 *
 * State architecture:
 *   - React Flow manages its own node/edge state via useNodesState / useEdgesState
 *   - The parent (App.tsx) holds the authoritative ICSLabScenario object
 *   - ScadaCanvas translates between the two representations:
 *       scenario → nodes/edges via scenarioToNodes() / scenarioToEdges()
 *       user action → scenario via onScenarioChange() callback
 *
 * Zone layout (canvas coordinate system):
 *   ┌────────────────────┬────────────────────┐
 *   │  OT (0,0)          │  IT (540,0)         │  ZONE_W = 500
 *   │  172.20.10.0/24    │  172.20.20.0/24     │  ZONE_H = 320
 *   ├────────────────────┼────────────────────┤  ZONE_GAP = 40
 *   │  DMZ (0,360)       │  External (540,360) │
 *   │  172.20.30.0/24    │  172.20.40.0/24     │
 *   └────────────────────┴────────────────────┘
 *
 * Drop-to-zone mapping:
 *   The drop position (in canvas coordinates) determines zone by quadrant:
 *     x < ZONE_W + GAP/2  →  left column  (OT or DMZ)
 *     x >= ZONE_W + GAP/2 →  right column (IT or External)
 *     y < ZONE_H + GAP/2  →  top row      (OT or IT)
 *     y >= ZONE_H + GAP/2 →  bottom row   (DMZ or External)
 *
 * React Flow instance ref:
 *   rfInstance.current is used for screenToFlowPosition() in onDrop. We use a ref
 *   (set via onInit) rather than useReactFlow() because this component is the one
 *   that renders <ReactFlow> — useReactFlow() must be called from a child component,
 *   which would require wrapping in <ReactFlowProvider>.
 */

import { useCallback, useEffect, useRef } from 'react'
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
  type OnSelectionChangeParams
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  ICSLabScenario,
  DeviceCategory,
  NetworkZone,
  DeviceConfig,
  Protocol
} from '@ics-sim/schema'
import { DeviceNode, type DeviceNodeData, type DeviceNodeType, ZONE_COLORS } from './DeviceNode'
import { ZoneNode, type ZoneNodeType } from './ZoneNode'
import { ProtocolEdge, type ProtocolEdgeType } from './ProtocolEdge'

/** Registration map: React Flow node type key → component. */
const nodeTypes: NodeTypes = {
  deviceNode: DeviceNode,
  zoneNode: ZoneNode
}

/** Registration map: React Flow edge type key → component. */
const edgeTypes: EdgeTypes = {
  protocolEdge: ProtocolEdge
}

// ── Zone layout constants ──────────────────────────────────────────────────────
/** Width of each zone rectangle in canvas pixels. */
const ZONE_W = 500
/** Height of each zone rectangle in canvas pixels. */
const ZONE_H = 320
/** Gap between zone rectangles in canvas pixels. */
const ZONE_GAP = 40

/**
 * Fixed zone background nodes that always exist on the canvas.
 *
 * ZoneNodes are non-interactive (draggable/selectable/connectable: false) and
 * sit behind device nodes (zIndex: -10). They are never added to or removed from
 * the canvas — they are always present as the visual grid structure.
 */
const INITIAL_ZONE_NODES: ZoneNodeType[] = [
  {
    id: 'zone-ot',
    type: 'zoneNode',
    position: { x: 0, y: 0 },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    zIndex: -10,
    data: {
      zone: 'ot',
      label: 'OT Network',
      subnet: '172.20.10.0/24',
      width: ZONE_W,
      height: ZONE_H
    }
  },
  {
    id: 'zone-it',
    type: 'zoneNode',
    position: { x: ZONE_W + ZONE_GAP, y: 0 },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    zIndex: -10,
    data: {
      zone: 'it',
      label: 'IT Network',
      subnet: '172.20.20.0/24',
      width: ZONE_W,
      height: ZONE_H
    }
  },
  {
    id: 'zone-dmz',
    type: 'zoneNode',
    position: { x: 0, y: ZONE_H + ZONE_GAP },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    zIndex: -10,
    data: { zone: 'dmz', label: 'DMZ', subnet: '172.20.30.0/24', width: ZONE_W, height: ZONE_H }
  },
  {
    id: 'zone-external',
    type: 'zoneNode',
    position: { x: ZONE_W + ZONE_GAP, y: ZONE_H + ZONE_GAP },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    zIndex: -10,
    data: {
      zone: 'external',
      label: 'External Network',
      subnet: '172.20.40.0/24',
      width: ZONE_W,
      height: ZONE_H
    }
  }
]

/**
 * Default IP address assigned to newly dropped devices in each zone.
 * The .10 host address is chosen as a memorable starting point; users can edit
 * addresses in the PropertiesPanel once Phase 4 lands.
 */
const DEFAULT_IP: Record<NetworkZone, string> = {
  ot: '172.20.10.10',
  it: '172.20.20.10',
  dmz: '172.20.30.10',
  external: '172.20.40.10'
}

/**
 * Default protocol assignments for newly created devices.
 * These match the container images: Modbus devices use modbus-tcp,
 * IEDs use DNP3, infrastructure devices have no protocol.
 */
const DEFAULT_PROTOCOLS: Record<DeviceCategory, Protocol[]> = {
  plc: ['modbus-tcp'],
  rtu: ['modbus-rtu'],
  ied: ['dnp3'],
  hmi: ['none'],
  historian: ['none'],
  sensor: ['modbus-tcp'],
  actuator: ['modbus-tcp'],
  pump: ['modbus-tcp'],
  valve: ['modbus-tcp'],
  'flow-meter': ['modbus-tcp'],
  'pressure-transmitter': ['modbus-tcp'],
  firewall: ['none'],
  'ids-ips': ['none'],
  switch: ['none'],
  router: ['none'],
  'attack-machine': ['none']
}

/** Short display labels used on device nodes and during auto-layout. */
const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  plc: 'PLC',
  rtu: 'RTU',
  ied: 'IED',
  hmi: 'HMI',
  historian: 'Historian',
  sensor: 'Sensor',
  actuator: 'Actuator',
  pump: 'Pump',
  valve: 'Valve',
  'flow-meter': 'Flow Meter',
  'pressure-transmitter': 'Pressure TX',
  firewall: 'Firewall',
  'ids-ips': 'IDS/IPS',
  switch: 'Switch',
  router: 'Router',
  'attack-machine': 'Attack Machine'
}

/**
 * Determines which network zone a canvas drop position falls in.
 *
 * Uses the 2×2 grid coordinate system: left column is OT/DMZ, right column is IT/External;
 * top row is OT/IT, bottom row is DMZ/External. The threshold is the center of the gap
 * between zones (GAP/2 past the end of the first zone).
 *
 * @param pos - Canvas coordinates from screenToFlowPosition().
 * @returns The NetworkZone at that position.
 */
function getZoneForPosition(pos: { x: number; y: number }): NetworkZone {
  const inRightCol = pos.x >= ZONE_W + ZONE_GAP / 2
  const inBottomRow = pos.y >= ZONE_H + ZONE_GAP / 2
  if (inRightCol && inBottomRow) return 'external'
  if (inRightCol) return 'it'
  if (inBottomRow) return 'dmz'
  return 'ot'
}

/**
 * Converts a scenario's visual layer into React Flow DeviceNode objects.
 *
 * Two paths:
 *   1. If the scenario has saved node positions (scenario.visual.nodes.length > 0),
 *      those positions are used directly. This preserves user layout after reimport.
 *   2. If there are no saved positions (e.g., a freshly imported scenario without a
 *      visual layer), devices are auto-laid out in a 3-per-row grid within their zone.
 *
 * @param scenario - The scenario to convert.
 * @returns Array of DeviceNodeType objects for useNodesState.
 */
function scenarioToNodes(scenario: ICSLabScenario): DeviceNodeType[] {
  const hasVisual = scenario.visual.nodes.length > 0

  if (hasVisual) {
    // Restore saved positions from the visual layer
    return scenario.visual.nodes.map(cn => ({
      id: cn.id,
      type: 'deviceNode' as const,
      position: cn.position,
      data: {
        // Fall back to a placeholder device if the devices map is missing the node
        device: scenario.devices.devices[cn.id] ?? {
          nodeId: cn.id,
          category: 'sensor' as DeviceCategory,
          ipAddress: '0.0.0.0',
          protocols: ['none' as Protocol]
        },
        label: cn.data.label,
        zone: cn.data.zone
      }
    }))
  }

  // Auto-layout: bucket devices into zones, then place in a 3-column grid
  const byZone: Record<NetworkZone, string[]> = { ot: [], it: [], dmz: [], external: [] }
  for (const [id, dev] of Object.entries(scenario.devices.devices)) {
    if (dev.category === 'attack-machine') byZone.external.push(id)
    else if (dev.category === 'firewall' || dev.category === 'ids-ips') byZone.dmz.push(id)
    else if (dev.category === 'historian' || dev.category === 'hmi') byZone.it.push(id)
    else byZone.ot.push(id)
  }

  // Origin offsets inside each zone rectangle (padding from the zone border)
  const zoneOrigins: Record<NetworkZone, { x: number; y: number }> = {
    ot: { x: 40, y: 60 },
    it: { x: ZONE_W + ZONE_GAP + 40, y: 60 },
    dmz: { x: 40, y: ZONE_H + ZONE_GAP + 60 },
    external: { x: ZONE_W + ZONE_GAP + 40, y: ZONE_H + ZONE_GAP + 60 }
  }

  const nodes: DeviceNodeType[] = []
  for (const zone of ['ot', 'it', 'dmz', 'external'] as NetworkZone[]) {
    const origin = zoneOrigins[zone]
    byZone[zone].forEach((id, i) => {
      const dev = scenario.devices.devices[id]
      nodes.push({
        id,
        type: 'deviceNode' as const,
        position: {
          // 3 columns × 140px wide, rows 110px tall
          x: origin.x + (i % 3) * 140,
          y: origin.y + Math.floor(i / 3) * 110
        },
        data: {
          device: dev,
          label: CATEGORY_LABELS[dev.category],
          zone
        }
      })
    })
  }
  return nodes
}

/**
 * Converts a scenario's visual edge list into React Flow ProtocolEdgeType objects.
 *
 * The label field requires special handling because TypeScript's
 * `exactOptionalPropertyTypes: true` requires that optional fields are either
 * set to a value or not set at all — `label: undefined` would fail the type check.
 * We only spread the label field when the source data has one.
 *
 * @param scenario - The scenario to extract edges from.
 * @returns Array of ProtocolEdgeType objects for useEdgesState.
 */
function scenarioToEdges(scenario: ICSLabScenario): ProtocolEdgeType[] {
  return scenario.visual.edges.map(ce => {
    const base: ProtocolEdgeType = {
      id: ce.id,
      source: ce.source,
      target: ce.target,
      type: 'protocolEdge' as const,
      data: { protocol: ce.data.protocol }
    }
    // Only include label in data when it is explicitly set — exactOptionalPropertyTypes
    if (ce.data.label !== undefined) {
      base.data = { protocol: ce.data.protocol, label: ce.data.label }
    }
    return base
  })
}

interface ScadaCanvasProps {
  /** The current scenario state from the parent, or null for a blank canvas. */
  scenario: ICSLabScenario | null
  /**
   * Called when the user selects or deselects a device node.
   * @param nodeId - The selected node's ID, or null when deselected.
   * @param device - The selected device config, or null when deselected.
   */
  onSelectDevice: (nodeId: string | null, device: DeviceConfig | null) => void
  /**
   * Called when the user makes a change that modifies the scenario (add device, add edge).
   * Uses an updater function pattern (like setState) so the parent can merge changes.
   */
  onScenarioChange: (updater: (s: ICSLabScenario | null) => ICSLabScenario | null) => void
}

/**
 * The main SCADA topology canvas component.
 *
 * Renders the React Flow canvas with zone backgrounds, device nodes, protocol edges,
 * and the standard canvas controls (zoom, minimap, background grid).
 */
export function ScadaCanvas({ scenario, onSelectDevice, onScenarioChange }: ScadaCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(INITIAL_ZONE_NODES)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  /**
   * Ref to the React Flow instance — needed for screenToFlowPosition() in the drop handler.
   * Using a ref avoids the need to wrap in ReactFlowProvider to use useReactFlow().
   */
  const rfInstance = useRef<ReactFlowInstance | null>(null)

  // Sync canvas node/edge state when the scenario prop changes (e.g., after file import)
  useEffect(() => {
    if (!scenario) {
      // Blank canvas: show only zone backgrounds
      setNodes(INITIAL_ZONE_NODES)
      setEdges([])
      return
    }
    const deviceNodes = scenarioToNodes(scenario)
    // Always include zone backgrounds (they are not stored in the scenario)
    setNodes([...INITIAL_ZONE_NODES, ...deviceNodes])
    setEdges(scenarioToEdges(scenario))
  }, [scenario, setNodes, setEdges])

  /**
   * Handles new edge connections created by dragging between device handles.
   *
   * Defaults to modbus-tcp as the protocol for all new connections — the user
   * can change the protocol via the edge properties panel (Phase 4).
   */
  const onConnect: OnConnect = useCallback(
    connection => {
      const newEdge: ProtocolEdgeType = {
        ...connection,
        id: `${connection.source}-${connection.target}-${Date.now()}`,
        type: 'protocolEdge',
        data: { protocol: 'modbus-tcp' }
      }
      setEdges(eds => addEdge(newEdge, eds))

      // Mirror the new edge in the scenario's visual layer
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
    [setEdges, onScenarioChange]
  )

  /**
   * Handles canvas selection changes — fires when the user clicks a node or the background.
   *
   * Only single device node selections populate the PropertiesPanel. Multi-selections
   * and zone background selections clear the panel.
   */
  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams) => {
      if (selectedNodes.length !== 1) {
        onSelectDevice(null, null)
        return
      }
      const node = selectedNodes[0]
      // Ignore zone background nodes (type === 'zoneNode')
      if (node.type !== 'deviceNode') {
        onSelectDevice(null, null)
        return
      }
      const data = node.data as DeviceNodeData
      onSelectDevice(node.id, data.device)
    },
    [onSelectDevice]
  )

  /** Sets the drag-over cursor to 'copy' to indicate a valid drop target. */
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  /**
   * Handles device drops from the DevicePalette onto the canvas.
   *
   * Sequence:
   *   1. Read category from drag data transfer (set by PaletteItem.onDragStart).
   *   2. Convert screen drop coordinates to canvas coordinates using rfInstance.
   *   3. Determine zone from the canvas position.
   *   4. Create a new DeviceConfig with default IP and protocol settings.
   *   5. Add the node to the React Flow state.
   *   6. Update the parent scenario via onScenarioChange (creates a new scenario if null).
   */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const category = event.dataTransfer.getData('deviceCategory') as DeviceCategory
      if (!category || !rfInstance.current) return

      // Convert browser screen coordinates to the canvas coordinate system
      const position = rfInstance.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      })

      const zone = getZoneForPosition(position)
      // Use timestamp for a unique node ID — avoids collisions within a session
      const nodeId = `${category}-${Date.now()}`
      const device: DeviceConfig = {
        nodeId,
        category,
        ipAddress: DEFAULT_IP[zone],
        protocols: DEFAULT_PROTOCOLS[category]
      }

      const newNode: DeviceNodeType = {
        id: nodeId,
        type: 'deviceNode',
        position,
        data: { device, label: CATEGORY_LABELS[category], zone }
      }

      setNodes(nds => [...nds, newNode])

      // Update scenario state — if no scenario exists yet, create a fresh one
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
                data: { label: CATEGORY_LABELS[category], zone }
              }
            ]
          },
          devices: {
            devices: { ...base.devices.devices, [nodeId]: device }
          }
        }
      })
    },
    [setNodes, onScenarioChange]
  )

  return (
    <div className="canvas-container">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onInit={instance => {
          rfInstance.current = instance
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        defaultEdgeOptions={{ type: 'protocolEdge', animated: false }}
        deleteKeyCode="Delete"
        multiSelectionKeyCode="Shift"
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        {/* Dot-grid background — 20px spacing, dark gray dots on near-black background */}
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#30363d" />

        {/* Zoom/pan controls — custom dark styling, no interactive toggle button */}
        <Controls
          style={{ background: '#1c2128', border: '1px solid #30363d', borderRadius: 6 }}
          showInteractive={false}
        />

        {/* Minimap — colored by zone for at-a-glance topology overview */}
        <MiniMap
          style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6 }}
          nodeColor={node => {
            if (node.type === 'zoneNode') return '#1c2128'
            const data = node.data as DeviceNodeData
            return ZONE_COLORS[data.zone] ?? '#484f58'
          }}
          maskColor="rgba(13, 17, 23, 0.7)"
        />
      </ReactFlow>
    </div>
  )
}

/**
 * Creates a minimal ICSLabScenario with all four network segments defined.
 *
 * Called when the user drops their first device onto a blank canvas (no scenario
 * loaded). The resulting scenario satisfies the schema validator's segment requirement
 * and provides default subnets for the compose generator.
 *
 * @returns A valid ICSLabScenario with no devices and all four default segments.
 */
function buildEmptyScenario(): ICSLabScenario {
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
      segments: [
        { zone: 'ot', subnet: '172.20.10.0/24', gateway: '172.20.10.1', dockerNetwork: 'ot-net' },
        { zone: 'it', subnet: '172.20.20.0/24', gateway: '172.20.20.1', dockerNetwork: 'it-net' },
        { zone: 'dmz', subnet: '172.20.30.0/24', gateway: '172.20.30.1', dockerNetwork: 'dmz-net' },
        {
          zone: 'external',
          subnet: '172.20.40.0/24',
          gateway: '172.20.40.1',
          dockerNetwork: 'external-net'
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
