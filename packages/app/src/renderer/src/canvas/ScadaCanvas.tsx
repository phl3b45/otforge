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

import { useCallback, useEffect, useRef, useState } from 'react'
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
  ICSLabScenario,
  DeviceCategory,
  NetworkZone,
  DeviceConfig,
  Protocol
} from '@ics-sim/schema'
import { DeviceNode, type DeviceNodeData, type DeviceNodeType, ZONE_COLORS } from './DeviceNode'
import { ProtocolEdge, type ProtocolEdgeType } from './ProtocolEdge'
import { PipeEdge, type PipeEdgeType } from './PipeEdge'

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

/** Padding fraction used for fitView calls — keeps a small margin around nodes. */
const FIT_PADDING = 0.12

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

/** Short display labels for device nodes on the canvas. */
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
 * Maps a device category to its default Purdue zone.
 * Used during auto-layout when no visual positions have been saved yet.
 */
function categoryToZone(category: DeviceCategory): NetworkZone {
  if (category === 'attack-machine') return 'external'
  if (category === 'firewall' || category === 'ids-ips') return 'dmz'
  if (category === 'historian' || category === 'hmi') return 'it'
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
function scenarioToNodes(scenario: ICSLabScenario, activeLayer: NetworkZone): DeviceNodeType[] {
  const hasVisual = scenario.visual.nodes.length > 0

  if (hasVisual) {
    return scenario.visual.nodes
      .filter(cn => cn.data.zone === activeLayer)
      .map(cn => ({
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
      position: {
        x: 80 + (i % 6) * 160,
        y: 80 + Math.floor(i / 6) * 110
      },
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
  scenario: ICSLabScenario,
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
        ...(ce.data.label !== undefined ? { label: ce.data.label } : {})
      }
    }))
}

interface ScadaCanvasProps {
  scenario: ICSLabScenario | null
  /** The currently active Purdue layer — scopes which nodes and edges are visible. */
  activeLayer: NetworkZone
  onSelectDevice: (nodeId: string | null, device: DeviceConfig | null) => void
  onScenarioChange: (updater: (s: ICSLabScenario | null) => ICSLabScenario | null) => void
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
  onSelectDevice,
  onScenarioChange
}: ScadaCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  /** Right-click context menu — null when closed. */
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  /**
   * Pending two-click connection state.
   * After the user picks a protocol from the context menu, this holds the source
   * node ID and chosen protocol until they click a target (or press Escape).
   */
  const [pendingConnection, setPendingConnection] = useState<PendingConnectionState | null>(null)

  /**
   * Ref to the React Flow instance — needed for screenToFlowPosition() in onDrop.
   * Using a ref avoids wrapping in ReactFlowProvider just to call useReactFlow().
   */
  const rfInstance = useRef<ReactFlowInstance | null>(null)

  // Sync canvas state when the scenario or active layer changes
  useEffect(() => {
    if (!scenario) {
      setNodes([])
      setEdges([])
      setTimeout(() => rfInstance.current?.fitView({ padding: FIT_PADDING, maxZoom: 0.75 }), 100)
      return
    }
    const deviceNodes = scenarioToNodes(scenario, activeLayer)
    const layerNodeIds = new Set(deviceNodes.map(n => n.id))
    setNodes(deviceNodes)
    setEdges(scenarioToEdges(scenario, activeLayer, layerNodeIds) as Edge[])
    // Defer fitView one frame so React Flow has measured the new nodes
    setTimeout(() => rfInstance.current?.fitView({ padding: FIT_PADDING, maxZoom: 0.75 }), 50)
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
        rfInstance.current?.fitView({ padding: FIT_PADDING, maxZoom: 0.75 })
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

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

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
   * Cancels any open context menu or in-progress pending connection.
   * Bound to clicking empty canvas space, pressing Escape, and the Cancel menu item.
   */
  const cancelConnection = useCallback(() => {
    setContextMenu(null)
    setPendingConnection(null)
  }, [])

  /**
   * Right-click on a canvas device node — opens the protocol selection menu at the
   * cursor position and cancels any previously pending connection.
   */
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault()
    setPendingConnection(null)
    setContextMenu({ nodeId: node.id, x: event.clientX, y: event.clientY })
  }, [])

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
   * If a pending connection is active, creates an edge from the source (right-clicked)
   * node to this target node using the previously selected protocol.
   * Self-clicks cancel the pending connection rather than creating a self-loop.
   * If no pending connection is active this is a no-op — selection is handled by
   * onSelectionChange via React Flow's built-in machinery.
   */
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (!pendingConnection) return

      if (node.id === pendingConnection.sourceId) {
        // Clicked the source again — treat as cancel
        cancelConnection()
        return
      }

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
    [pendingConnection, activeLayer, setEdges, onScenarioChange, cancelConnection]
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

      const zone = activeLayer
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
    [setNodes, onScenarioChange, activeLayer]
  )

  const isOT = activeLayer === 'ot'

  return (
    /* .connecting class switches the cursor to a crosshair when the user has
       picked a protocol and is waiting to click a target node. */
    <div
      className={`canvas-container${isOT ? ' canvas-ot' : ''}${pendingConnection ? ' connecting' : ''}`}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onNodeDragStop={onNodeDragStop}
        onNodeContextMenu={onNodeContextMenu}
        onNodeClick={onNodeClick}
        onPaneClick={cancelConnection}
        onInit={instance => {
          rfInstance.current = instance
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: FIT_PADDING, maxZoom: 0.75 }}
        defaultEdgeOptions={{ type: isOT ? 'pipeEdge' : 'protocolEdge', animated: false }}
        deleteKeyCode="Delete"
        multiSelectionKeyCode="Shift"
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        {/* OT tab: fine grid lines on dark ground give a SCADA/DCS screen feel */}
        {isOT ? (
          <Background variant={BackgroundVariant.Lines} gap={40} color="#0f2233" />
        ) : (
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#30363d" />
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
          {CONNECTION_OPTIONS.map(opt => (
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
        {
          zone: 'dmz',
          subnet: '172.20.30.0/24',
          gateway: '172.20.30.1',
          dockerNetwork: 'dmz-net'
        },
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
