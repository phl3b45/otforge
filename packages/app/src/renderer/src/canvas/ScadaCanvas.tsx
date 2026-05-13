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

const nodeTypes: NodeTypes = {
  deviceNode: DeviceNode,
  zoneNode: ZoneNode
}

const edgeTypes: EdgeTypes = {
  protocolEdge: ProtocolEdge
}

// Zone layout: 2×2 grid with 40px gap
const ZONE_W = 500
const ZONE_H = 320
const ZONE_GAP = 40

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

const DEFAULT_IP: Record<NetworkZone, string> = {
  ot: '172.20.10.10',
  it: '172.20.20.10',
  dmz: '172.20.30.10',
  external: '172.20.40.10'
}

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

function getZoneForPosition(pos: { x: number; y: number }): NetworkZone {
  const inRightCol = pos.x >= ZONE_W + ZONE_GAP / 2
  const inBottomRow = pos.y >= ZONE_H + ZONE_GAP / 2
  if (inRightCol && inBottomRow) return 'external'
  if (inRightCol) return 'it'
  if (inBottomRow) return 'dmz'
  return 'ot'
}

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

  // Auto-layout: categorize devices into zones
  const byZone: Record<NetworkZone, string[]> = { ot: [], it: [], dmz: [], external: [] }
  for (const [id, dev] of Object.entries(scenario.devices.devices)) {
    if (dev.category === 'attack-machine') byZone.external.push(id)
    else if (dev.category === 'firewall' || dev.category === 'ids-ips') byZone.dmz.push(id)
    else if (dev.category === 'historian' || dev.category === 'hmi') byZone.it.push(id)
    else byZone.ot.push(id)
  }

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

export function ScadaCanvas({ scenario, onSelectDevice, onScenarioChange }: ScadaCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(INITIAL_ZONE_NODES)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const rfInstance = useRef<ReactFlowInstance | null>(null)

  // Sync canvas when scenario is imported
  useEffect(() => {
    if (!scenario) {
      setNodes(INITIAL_ZONE_NODES)
      setEdges([])
      return
    }
    const deviceNodes = scenarioToNodes(scenario)
    setNodes([...INITIAL_ZONE_NODES, ...deviceNodes])
    setEdges(scenarioToEdges(scenario))
  }, [scenario, setNodes, setEdges])

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
        fitViewOptions={{ padding: 0.15 }}
        defaultEdgeOptions={{ type: 'protocolEdge', animated: false }}
        deleteKeyCode="Delete"
        multiSelectionKeyCode="Shift"
        minZoom={0.2}
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
