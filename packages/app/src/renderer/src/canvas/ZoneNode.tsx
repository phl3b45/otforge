/**
 * ZoneNode.tsx — React Flow background node that renders a Purdue-model network zone.
 *
 * The SCADA canvas uses a Purdue ISA-95 hierarchical layout with four horizontal
 * bands stacked top-to-bottom:
 *
 *   Level 5  — Enterprise / External Network  (attack machine, internet)
 *   Level 4  — IT / Business Network          (historian, HMI workstations)
 *   Level 3.5 — Industrial DMZ               (firewalls, IDS/IPS, jump hosts)
 *   Levels 0–2 — OT / Control Network        (PLCs, RTUs, IEDs, field devices)
 *
 * Each zone is a large, non-interactive rectangle (zIndex: -10) that sits behind
 * device nodes. The header shows the Purdue level badge, zone name, description,
 * and subnet in one row.
 */

import { memo } from 'react'
import type { NodeProps, Node } from '@xyflow/react'
import type { NetworkZone } from '@ics-sim/schema'
import { ZONE_COLORS } from './DeviceNode'

/**
 * Data payload for a ZoneNode.
 * Width and height are passed as data (not style) so React Flow's node
 * positioning system tracks the zone's bounds correctly for minimap rendering.
 */
export type ZoneNodeData = {
  /** The zone this background represents. */
  zone: NetworkZone
  /** Display name shown in the zone header (e.g., "OT / Control Network"). */
  label: string
  /** Subnet CIDR shown in the header (e.g., "172.20.10.0/24"). */
  subnet: string
  /** Purdue ISA-95 level string, e.g., "Level 5" or "Levels 0–2". */
  purdueLevel: string
  /** Short description of what belongs in this zone, shown below the name. */
  description: string
  /** Width of the zone rectangle in canvas pixels. */
  width: number
  /** Height of the zone rectangle in canvas pixels. */
  height: number
}

/** Typed React Flow node shape for use with useNodesState and NodeTypes. */
export type ZoneNodeType = Node<ZoneNodeData, 'zoneNode'>

/**
 * Background fill colors at 5% opacity — subtle tint so device nodes remain
 * legible over the zone background. The full zone accent at full opacity would
 * make the canvas unreadable.
 */
const ZONE_BG: Record<NetworkZone, string> = {
  ot: 'rgba(57, 208, 176, 0.05)',
  control: 'rgba(56, 139, 253, 0.05)',
  'plant-dmz': 'rgba(210, 153, 34, 0.05)',
  enterprise: 'rgba(163, 113, 247, 0.05)',
  'internet-dmz': 'rgba(247, 129, 102, 0.05)',
  attacker: 'rgba(248, 81, 73, 0.05)'
}

/**
 * Renders a Purdue-model zone background rectangle.
 *
 * Header layout (left to right):
 *   [LEVEL X] zone name     subnet
 *             description
 */
export const ZoneNode = memo(function ZoneNode({ data }: NodeProps<ZoneNodeType>) {
  const color = ZONE_COLORS[data.zone]
  const bg = ZONE_BG[data.zone]

  return (
    <div
      className="zone-node"
      style={{
        width: data.width,
        height: data.height,
        borderColor: color,
        background: bg
      }}
    >
      <div className="zone-node-header">
        {/* Left: level badge + name + description */}
        <div className="zone-node-left">
          <span
            className="zone-node-level-badge"
            style={{ color, borderColor: `${color}55`, background: `${color}15` }}
          >
            {data.purdueLevel}
          </span>
          <div className="zone-node-labels">
            <span className="zone-node-name" style={{ color }}>
              {data.label}
            </span>
            <span className="zone-node-description">{data.description}</span>
          </div>
        </div>

        {/* Right: subnet */}
        <span className="zone-node-subnet">{data.subnet}</span>
      </div>
    </div>
  )
})
