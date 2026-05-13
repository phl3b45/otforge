/**
 * DeviceNode.tsx — React Flow custom node for a single ICS device on the SCADA canvas.
 *
 * Each device the user places on the canvas is rendered as a DeviceNode. The node
 * shows:
 *   - The device's ISA-5.1 icon (from DeviceIcons.tsx), colored by zone
 *   - A label (device category name, e.g., "PLC", "Pump")
 *   - The device's static IP address
 *   - A top Handle (connection target) and bottom Handle (connection source)
 *     for drawing protocol edges between devices
 *
 * Visual feedback:
 *   - Border color matches the device's zone (OT=teal, IT=blue, DMZ=gold, External=red)
 *   - When selected, the border turns white and a colored box-shadow ring appears,
 *     providing double visual confirmation of the active selection
 *
 * Performance:
 *   - Wrapped in React.memo so nodes only re-render when their data or selection
 *     state changes — important when the canvas has 15-20+ nodes
 *
 * Zone color constants (ZONE_COLORS) are exported so PropertiesPanel and ZoneNode
 * can use the same palette without duplication.
 */

import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { DeviceConfig, NetworkZone } from '@ics-sim/schema'
import { DeviceIcon } from '../icons/DeviceIcons'

/**
 * Data payload carried by each DeviceNode in the React Flow node graph.
 * Stored in node.data and passed to the component via NodeProps.
 */
export type DeviceNodeData = {
  /** Full device configuration object (IP, category, protocols, etc.). */
  device: DeviceConfig
  /** Display label shown below the icon (e.g., "PLC", "Pressure TX"). */
  label: string
  /** Network zone this device belongs to — determines border/icon color. */
  zone: NetworkZone
}

/** Typed React Flow node shape for use with useNodesState and NodeTypes. */
export type DeviceNodeType = Node<DeviceNodeData, 'deviceNode'>

/**
 * Zone-to-accent-color mapping used across the canvas, palette, and properties panel.
 * Colors are chosen to match GitHub's dark theme accent palette for visual consistency:
 *   OT (Operational Technology)  — #39d0b0 (teal/green — "safe, running")
 *   IT (Information Technology)  — #388bfd (blue — "data/network")
 *   DMZ (Demilitarized Zone)     — #d29922 (amber/gold — "boundary/caution")
 *   External                      — #f85149 (red — "hostile/untrusted")
 */
export const ZONE_COLORS: Record<NetworkZone, string> = {
  ot: '#39d0b0',
  it: '#388bfd',
  dmz: '#d29922',
  external: '#f85149'
}

/**
 * Renders a single device on the SCADA canvas.
 *
 * React Flow passes NodeProps including `data` (DeviceNodeData) and `selected`
 * (boolean from the flow's selection state). The component reads these to apply
 * zone-appropriate colors and selection highlighting.
 *
 * Connection handles:
 *   - Top Handle type="target" — accepts incoming edges (e.g., PLC → Sensor)
 *   - Bottom Handle type="source" — emits outgoing edges
 *   Both handles are colored with the zone accent color for visual continuity.
 */
export const DeviceNode = memo(function DeviceNode({ data, selected }: NodeProps<DeviceNodeType>) {
  const zoneColor = ZONE_COLORS[data.zone]

  return (
    <div
      className="device-node"
      style={{
        // White border when selected (high contrast), zone color when unselected
        borderColor: selected ? '#e6edf3' : zoneColor,
        // Outer ring in zone color when selected so zone membership stays visible
        boxShadow: selected ? `0 0 0 2px ${zoneColor}` : 'none'
      }}
    >
      {/* Incoming connection handle — positioned at the top of the node */}
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: zoneColor, border: 'none', width: 8, height: 8 }}
      />

      {/* ISA-5.1 device icon, colored by zone */}
      <div className="device-node-icon" style={{ color: zoneColor }}>
        <DeviceIcon category={data.device.category} size={28} />
      </div>

      {/* Label and IP address stacked below the icon */}
      <div className="device-node-info">
        <div className="device-node-label">{data.label}</div>
        <div className="device-node-meta">{data.device.ipAddress}</div>
      </div>

      {/* Outgoing connection handle — positioned at the bottom of the node */}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: zoneColor, border: 'none', width: 8, height: 8 }}
      />
    </div>
  )
})
