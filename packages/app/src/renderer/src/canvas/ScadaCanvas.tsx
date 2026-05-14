/**
 * ScadaCanvas.tsx — React Flow SCADA topology editor canvas.
 *
 * Renders a pannable, zoomable canvas structured as a Purdue ISA-95 model
 * with four horizontal bands stacked top-to-bottom:
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │  Level 5 — Enterprise / External  (y=0, h=170)   │
 *   ├──────────────────────────────────────────────────┤
 *   │  Level 4 — IT / Business          (y=190, h=210) │
 *   ├──────────────────────────────────────────────────┤
 *   │  Level 3.5 — Industrial DMZ       (y=420, h=140) │
 *   ├──────────────────────────────────────────────────┤
 *   │  Levels 0–2 — OT / Control        (y=580, h=320) │
 *   └──────────────────────────────────────────────────┘
 *
 * Users drag device types from the DevicePalette and drop them onto a zone band.
 * The drop y-coordinate determines zone membership. Devices are connected by
 * dragging between Handle endpoints; Delete removes selected nodes/edges.
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

// ── Purdue model canvas constants ──────────────────────────────────────────────
/** Width of every zone band in canvas pixels — all zones share the same width. */
const CANVAS_W = 1400
/** Vertical gap between zone bands in canvas pixels. */
const ZONE_GAP = 30
/** Padding fraction used for every fitView call — keeps a small margin around zones. */
const FIT_PADDING = 0.08

/*
 * Zone heights — sized so the four bands together fill most of the viewport after
 * fitView. OT is the tallest (most field devices), DMZ the thinnest (boundary only).
 */
const H_EXTERNAL = 240
const H_IT = 300
const H_DMZ = 190
const H_OT = 480

// Zone Y origins (top of each band)
const Y_EXTERNAL = 0
const Y_IT = Y_EXTERNAL + H_EXTERNAL + ZONE_GAP // 270
const Y_DMZ = Y_IT + H_IT + ZONE_GAP // 600
const Y_OT = Y_DMZ + H_DMZ + ZONE_GAP // 820

/**
 * Fixed zone background nodes — always present on the canvas regardless of
 * whether a scenario is loaded. They are non-interactive (draggable/selectable/
 * connectable: false) and render behind device nodes (zIndex: -10).
 */
const INITIAL_ZONE_NODES: ZoneNodeType[] = [
  {
    id: 'zone-external',
    type: 'zoneNode',
    position: { x: 0, y: Y_EXTERNAL },
    /*
     * width / height are set directly on the node object (not just in data) so that
     * React Flow knows the dimensions immediately — before ResizeObserver fires.
     * Without this, fitView computes a near-zero bounding box and zooms way out.
     */
    width: CANVAS_W,
    height: H_EXTERNAL,
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    zIndex: -10,
    data: {
      zone: 'external',
      label: 'Enterprise / External Network',
      subnet: '172.20.40.0/24',
      purdueLevel: 'Level 5',
      description: 'Internet-facing systems, red-team attack machine (Kali Linux)',
      width: CANVAS_W,
      height: H_EXTERNAL
    }
  },
  {
    id: 'zone-it',
    type: 'zoneNode',
    position: { x: 0, y: Y_IT },
    width: CANVAS_W,
    height: H_IT,
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    zIndex: -10,
    data: {
      zone: 'it',
      label: 'IT / Business Network',
      subnet: '172.20.20.0/24',
      purdueLevel: 'Level 4',
      description: 'Business applications, data historians, HMI workstations, patch servers',
      width: CANVAS_W,
      height: H_IT
    }
  },
  {
    id: 'zone-dmz',
    type: 'zoneNode',
    position: { x: 0, y: Y_DMZ },
    width: CANVAS_W,
    height: H_DMZ,
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    zIndex: -10,
    data: {
      zone: 'dmz',
      label: 'Industrial DMZ',
      subnet: '172.20.30.0/24',
      purdueLevel: 'Level 3.5',
      description: 'IT/OT boundary — firewalls, jump hosts, IDS/IPS sensors, data diodes',
      width: CANVAS_W,
      height: H_DMZ
    }
  },
  {
    id: 'zone-ot',
    type: 'zoneNode',
    position: { x: 0, y: Y_OT },
    width: CANVAS_W,
    height: H_OT,
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    zIndex: -10,
    data: {
      zone: 'ot',
      label: 'OT / Control Network',
      subnet: '172.20.10.0/24',
      purdueLevel: 'Levels 0–2',
      description:
        'Field devices (Level 0), basic control — PLCs, RTUs, IEDs (Level 1), supervisory SCADA (Level 2)',
      width: CANVAS_W,
      height: H_OT
    }
  }
]

/**
 * Default IP address for newly dropped devices, by zone.
 * The .10 host is a memorable starting point; users can edit in PropertiesPanel.
 */
const DEFAULT_IP: Record<NetworkZone, string> = {
  ot: '172.20.10.10',
  it: '172.20.20.10',
  dmz: '172.20.30.10',
  external: '172.20.40.10'
}

/**
 * Default protocol assignments for newly created devices by category.
 * Matches the container images: Modbus for PLCs/RTUs/field devices,
 * DNP3 for IEDs, no protocol for infrastructure.
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

/** Short display labels for device nodes. */
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
 * Maps a canvas drop y-coordinate to a Purdue network zone.
 *
 * Uses horizontal band thresholds based on each zone's y origin:
 *   y < Y_IT   → external (top band)
 *   y < Y_DMZ  → it
 *   y < Y_OT   → dmz
 *   y >= Y_OT  → ot  (bottom band, default)
 */
function getZoneForPosition(pos: { x: number; y: number }): NetworkZone {
  if (pos.y < Y_IT) return 'external'
  if (pos.y < Y_DMZ) return 'it'
  if (pos.y < Y_OT) return 'dmz'
  return 'ot'
}

/**
 * Converts a scenario's visual layer into React Flow DeviceNode objects.
 *
 * Two paths:
 *   1. Saved positions (scenario.visual.nodes.length > 0) — restored directly.
 *   2. No saved positions — devices auto-laid out in a 6-column grid within
 *      their Purdue zone band. Matches the zone assignments in getZoneForPosition.
 */
function scenarioToNodes(scenario: ICSLabScenario): DeviceNodeType[] {
  const hasVisual = scenario.visual.nodes.length > 0

  if (hasVisual) {
    return scenario.visual.nodes.map(cn => ({
      id: cn.id,
      type: 'deviceNode' as const,
      position: cn.position,
      data: {
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

  // Auto-layout: bucket each device into its Purdue zone band
  const byZone: Record<NetworkZone, string[]> = { ot: [], it: [], dmz: [], external: [] }
  for (const [id, dev] of Object.entries(scenario.devices.devices)) {
    if (dev.category === 'attack-machine') byZone.external.push(id)
    else if (dev.category === 'firewall' || dev.category === 'ids-ips') byZone.dmz.push(id)
    else if (dev.category === 'historian' || dev.category === 'hmi') byZone.it.push(id)
    else byZone.ot.push(id)
  }

  // Origins at top-left of each band with padding from the border
  const zoneOrigins: Record<NetworkZone, { x: number; y: number }> = {
    external: { x: 80, y: Y_EXTERNAL + 70 },
    it: { x: 80, y: Y_IT + 75 },
    dmz: { x: 80, y: Y_DMZ + 55 },
    ot: { x: 80, y: Y_OT + 80 }
  }

  const nodes: DeviceNodeType[] = []
  for (const zone of ['external', 'it', 'dmz', 'ot'] as NetworkZone[]) {
    const origin = zoneOrigins[zone]
    byZone[zone].forEach((id, i) => {
      const dev = scenario.devices.devices[id]
      nodes.push({
        id,
        type: 'deviceNode' as const,
        position: {
          // 6 columns × 160px wide, rows 110px tall — fills the full-width bands
          x: origin.x + (i % 6) * 160,
          y: origin.y + Math.floor(i / 6) * 110
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
    if (ce.data.label !== undefined) {
      base.data = { protocol: ce.data.protocol, label: ce.data.label }
    }
    return base
  })
}

interface ScadaCanvasProps {
  scenario: ICSLabScenario | null
  onSelectDevice: (nodeId: string | null, device: DeviceConfig | null) => void
  onScenarioChange: (updater: (s: ICSLabScenario | null) => ICSLabScenario | null) => void
}

/**
 * The main SCADA topology canvas.
 *
 * Renders the React Flow canvas with Purdue model zone bands, device nodes,
 * protocol edges, and standard canvas controls (zoom, minimap, dot-grid).
 */
export function ScadaCanvas({ scenario, onSelectDevice, onScenarioChange }: ScadaCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(INITIAL_ZONE_NODES)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  /**
   * Ref to the React Flow instance — needed for screenToFlowPosition() in onDrop.
   * Using a ref avoids wrapping in ReactFlowProvider just to call useReactFlow().
   */
  const rfInstance = useRef<ReactFlowInstance | null>(null)

  // Sync canvas state when the scenario prop changes (import, new, or canvas edit)
  useEffect(() => {
    if (!scenario) {
      setNodes(INITIAL_ZONE_NODES)
      setEdges([])
      /*
       * Re-center after a blank canvas reset. The fitView prop only fires on the
       * initial component mount; ScadaCanvas is NOT re-mounted when the user clicks
       * "New Scenario" from within the canvas view — so we need to call fitView
       * manually here after the nodes state has settled.
       */
      setTimeout(() => rfInstance.current?.fitView({ padding: FIT_PADDING }), 100)
      return
    }
    const deviceNodes = scenarioToNodes(scenario)
    setNodes([...INITIAL_ZONE_NODES, ...deviceNodes])
    setEdges(scenarioToEdges(scenario))
  }, [scenario, setNodes, setEdges])

  /*
   * Re-fit whenever the browser window is resized or maximized.
   * Without this, the zones scale to the window size at mount time and stay fixed
   * even if the window grows — making them appear small in the new larger viewport.
   * The 150 ms debounce prevents excessive fitView calls during a live drag-resize.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const handleResize = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        rfInstance.current?.fitView({ padding: FIT_PADDING })
      }, 150)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      clearTimeout(timer)
    }
  }, [])

  /** New protocol edge — defaults to modbus-tcp; user can change via edge properties. */
  const onConnect: OnConnect = useCallback(
    connection => {
      const newEdge: ProtocolEdgeType = {
        ...connection,
        id: `${connection.source}-${connection.target}-${Date.now()}`,
        type: 'protocolEdge',
        data: { protocol: 'modbus-tcp' }
      }
      setEdges(eds => addEdge(newEdge, eds))

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

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  /**
   * Device drop from palette onto canvas.
   * Determines Purdue zone from the y-coordinate of the drop position.
   */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const category = event.dataTransfer.getData('deviceCategory') as DeviceCategory
      if (!category || !rfInstance.current) return

      const position = rfInstance.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      })

      const zone = getZoneForPosition(position)
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
        fitViewOptions={{ padding: FIT_PADDING }}
        defaultEdgeOptions={{ type: 'protocolEdge', animated: false }}
        deleteKeyCode="Delete"
        multiSelectionKeyCode="Shift"
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#30363d" />
        <Controls
          style={{ background: '#1c2128', border: '1px solid #30363d', borderRadius: 6 }}
          showInteractive={false}
        />
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
 * Minimal ICSLabScenario with all four Purdue network segments pre-defined.
 * Created when the user drops their first device onto a blank canvas.
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
