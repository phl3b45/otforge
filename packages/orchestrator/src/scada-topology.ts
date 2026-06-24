import type { CanvasEdge, CanvasNode, DeviceConfig, OTForgeScenario } from '@otforge/schema'

/**
 * One OT-zone device with its canvas node (position, label, zone) and full
 * protocol/physics config joined together.
 */
export interface OtZoneDevice {
  node: CanvasNode
  device: DeviceConfig
}

/** OT-zone devices and the edges that connect them, ready for SCADA view generation. */
export interface OtZoneTopology {
  nodes: OtZoneDevice[]
  edges: CanvasEdge[]
}

/**
 * Filters a scenario down to OT-zone devices and the edges that connect them.
 *
 * Zone lives solely on CanvasNode.data.zone (scenario.visual.nodes) -- never on
 * DeviceConfig -- so this is the only check needed (matches LayerTabBar.tsx's
 * countDevicesByLayer, the existing reader of this field). An edge is included only
 * when both endpoints are OT-zone devices, mirroring how a real plant's SCADA HMI never
 * shows connections into IT-zone equipment.
 *
 * @param scenario - The active scenario.
 * @returns OT-zone nodes (joined to their DeviceConfig) and fully-OT-zone edges.
 */
export function getOtZoneTopology(scenario: OTForgeScenario): OtZoneTopology {
  const otNodeIds = new Set<string>()
  const nodes: OtZoneDevice[] = []

  for (const node of scenario.visual.nodes) {
    if (node.data.zone !== 'ot') continue
    const device = scenario.devices.devices[node.id]
    if (!device) continue
    otNodeIds.add(node.id)
    nodes.push({ node, device })
  }

  const edges = scenario.visual.edges.filter(
    edge => otNodeIds.has(edge.source) && otNodeIds.has(edge.target)
  )

  return { nodes, edges }
}
