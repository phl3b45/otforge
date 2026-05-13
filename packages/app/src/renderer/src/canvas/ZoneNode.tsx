/**
 * ZoneNode.tsx — React Flow background node that renders a network zone region.
 *
 * The SCADA canvas uses a 2×2 grid layout:
 *   OT (top-left)     | IT (top-right)
 *   DMZ (bottom-left) | External (bottom-right)
 *
 * Each zone is represented by a ZoneNode — a large, non-interactive rectangle
 * that sits behind the device nodes (zIndex: -10). Its purpose is visual only:
 *   - A translucent zone-colored background tints the area
 *   - A header bar shows the zone name and subnet address
 *   - The border color matches the zone accent from ZONE_COLORS
 *
 * Non-interactive flags (draggable: false, selectable: false, connectable: false,
 * focusable: false) prevent zone backgrounds from interfering with device node
 * interactions — clicks and drags pass through to device nodes or the canvas.
 *
 * Size is data-driven (width, height in ZoneNodeData) so the canvas can adjust
 * zone dimensions without touching this component.
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
  /** Display name shown in the zone header (e.g., "OT Network", "DMZ"). */
  label: string
  /** Subnet CIDR shown in the header (e.g., "172.20.10.0/24"). */
  subnet: string
  /** Width of the zone rectangle in canvas pixels. */
  width: number
  /** Height of the zone rectangle in canvas pixels. */
  height: number
}

/** Typed React Flow node shape for use with useNodesState and NodeTypes. */
export type ZoneNodeType = Node<ZoneNodeData, 'zoneNode'>

/**
 * Background fill colors at 6% opacity — just enough to tint the area without
 * obscuring the device nodes or the dot-grid background. Full zone colors at
 * full opacity would make the canvas illegible.
 */
const ZONE_BG: Record<NetworkZone, string> = {
  ot: 'rgba(57, 208, 176, 0.06)',
  it: 'rgba(56, 139, 253, 0.06)',
  dmz: 'rgba(210, 153, 34, 0.06)',
  external: 'rgba(248, 81, 73, 0.06)'
}

/**
 * Renders a colored background rectangle that visually defines a network zone.
 *
 * The component receives `data` from NodeProps and uses it to size itself and
 * apply zone-specific colors. Width/height are applied inline (not via CSS class)
 * because they are dynamic values from the scenario's zone configuration.
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
        borderColor: color, // Zone accent color for the 1px border
        background: bg // Translucent tint fill
      }}
    >
      {/* Header bar: zone name on the left, subnet on the right */}
      <div className="zone-node-header" style={{ color }}>
        <span className="zone-node-name">{data.label}</span>
        <span className="zone-node-subnet">{data.subnet}</span>
      </div>
    </div>
  )
})
