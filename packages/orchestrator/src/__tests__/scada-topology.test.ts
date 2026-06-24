import { describe, it, expect } from 'vitest'
import { getOtZoneTopology } from '../scada-topology'
import type {
  CanvasEdge,
  CanvasNode,
  DeviceConfig,
  NetworkZone,
  OTForgeScenario
} from '@otforge/schema'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(id: string, zone: NetworkZone): CanvasNode {
  return { id, type: 'device', position: { x: 0, y: 0 }, data: { label: id, zone } }
}

function makeEdge(id: string, source: string, target: string): CanvasEdge {
  return { id, source, target, data: { protocol: 'modbus-tcp' } }
}

/** Builds a minimal type-correct OTForgeScenario for testing getOtZoneTopology(). */
function makeScenario(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  deviceEntries: Array<
    [string, Partial<DeviceConfig> & Pick<DeviceConfig, 'category' | 'ipAddress'>]
  >
): OTForgeScenario {
  const devices: OTForgeScenario['devices']['devices'] = {}
  for (const [id, d] of deviceEntries) {
    devices[id] = { nodeId: id, protocols: [], ...d }
  }
  return {
    meta: {
      formatVersion: '1.0',
      name: 'Test',
      description: '',
      sector: 'water-treatment',
      author: 'test',
      createdAt: '',
      updatedAt: '',
      appVersion: '0.1.0',
      locked: false,
      brief: '',
      requirements: { estimatedRamMb: 0, estimatedCpuCores: 0, containerCount: 0 }
    },
    visual: { nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } },
    network: { segments: [], routes: [] },
    devices: { devices },
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getOtZoneTopology', () => {
  it('includes only OT-zone devices', () => {
    const scenario = makeScenario(
      [makeNode('pump-1', 'ot'), makeNode('hmi-1', 'control')],
      [],
      [
        ['pump-1', { category: 'smart-controller', ipAddress: '10.0.0.10' }],
        ['hmi-1', { category: 'hmi', ipAddress: '10.0.0.20' }]
      ]
    )
    const { nodes } = getOtZoneTopology(scenario)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].node.id).toBe('pump-1')
    expect(nodes[0].device.category).toBe('smart-controller')
  })

  it('excludes an edge unless both endpoints are OT-zone', () => {
    const scenario = makeScenario(
      [makeNode('pump-1', 'ot'), makeNode('valve-1', 'ot'), makeNode('hmi-1', 'control')],
      [makeEdge('e1', 'pump-1', 'valve-1'), makeEdge('e2', 'pump-1', 'hmi-1')],
      [
        ['pump-1', { category: 'smart-controller', ipAddress: '10.0.0.10' }],
        ['valve-1', { category: 'smart-controller', ipAddress: '10.0.0.11' }],
        ['hmi-1', { category: 'hmi', ipAddress: '10.0.0.20' }]
      ]
    )
    const { edges } = getOtZoneTopology(scenario)
    expect(edges).toHaveLength(1)
    expect(edges[0].id).toBe('e1')
  })

  it('drops an OT-zone node that has no matching DeviceConfig', () => {
    const scenario = makeScenario([makeNode('ghost-1', 'ot')], [], [])
    const { nodes } = getOtZoneTopology(scenario)
    expect(nodes).toHaveLength(0)
  })

  it('returns empty results for a scenario with no OT-zone devices', () => {
    const scenario = makeScenario(
      [makeNode('hmi-1', 'control')],
      [],
      [['hmi-1', { category: 'hmi', ipAddress: '10.0.0.20' }]]
    )
    const { nodes, edges } = getOtZoneTopology(scenario)
    expect(nodes).toHaveLength(0)
    expect(edges).toHaveLength(0)
  })
})
