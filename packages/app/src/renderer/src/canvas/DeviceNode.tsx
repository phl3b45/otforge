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
 * Zone color constants (ZONE_COLORS) are exported so PropertiesPanel and LayerTabBar
 * can use the same palette without duplication.
 */

import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { DeviceConfig, NetworkZone } from '@otforge/schema'
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
  /**
   * Water fill level for process-unit (Water Tank) nodes — 0.0 (empty) to 1.0 (full/overflow).
   * Derived from HR0 (tank_level, 0–1000 cm) polled via FC03 Read Holding Registers.
   * When undefined, no fill indicator is shown (simulation not running or node is not a tank).
   *
   * Fill color changes with level to give students an immediate visual warning:
   *   0.0–0.5  → blue   (safe operating range, inlet and outlet balanced)
   *   0.5–0.8  → amber  (elevated — outlet may be restricted)
   *   0.8–1.0  → red    (critical — overflow imminent or occurring)
   */
  fillLevel?: number
}

/** Typed React Flow node shape for use with useNodesState and NodeTypes. */
export type DeviceNodeType = Node<DeviceNodeData, 'deviceNode'>

/**
 * Zone-to-accent-color mapping used across the canvas, palette, and properties panel.
 * Colors are chosen to match GitHub's dark theme accent palette for visual consistency:
 *   OT (Levels 0–2)         — #39d0b0 (teal/green — "safe, running field devices")
 *   Control Center (L3)    — #388bfd (blue — "data/network/SCADA infrastructure")
 *   Plant DMZ (L3.5)       — #d29922 (amber/gold — "security boundary/caution")
 *   Enterprise (L4)        — #a371f7 (purple — "corporate IT systems")
 *   Internet DMZ (L5)      — #f78166 (orange — "internet-facing, reduced trust")
 *   Attacker (Red Team)    — #f85149 (red — "hostile/adversarial")
 */
export const ZONE_COLORS: Record<NetworkZone, string> = {
  ot: '#39d0b0',
  control: '#388bfd',
  'plant-dmz': '#d29922',
  enterprise: '#a371f7',
  'internet-dmz': '#f78166',
  attacker: '#f85149'
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
 *
 * Process-unit nodes additionally render a water fill indicator that rises as
 * tank_level increases. The fill color shifts blue → amber → red so students can
 * see the overflow condition developing without consulting Grafana.
 */
export const DeviceNode = memo(function DeviceNode({ data, selected }: NodeProps<DeviceNodeType>) {
  const zoneColor = ZONE_COLORS[data.zone]
  const isProcessUnit = data.device.category === 'process-unit'
  const fillLevel = isProcessUnit ? (data.fillLevel ?? 0) : 0

  // Water fill color transitions blue (safe) → amber (elevated) → red (critical)
  const fillColor =
    fillLevel < 0.5
      ? 'rgba(56, 139, 253, 0.28)'
      : fillLevel < 0.8
        ? 'rgba(210, 153, 34, 0.35)'
        : 'rgba(248, 81, 73, 0.42)'

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

      {/*
       * Water fill indicator — only rendered for process-unit (Water Tank) nodes while
       * the simulation is running (fillLevel is set by ScadaCanvas polling HR0).
       * Positioned behind the icon/label via z-index so content remains legible.
       * CSS transition animates the rising level smoothly between 2 s poll ticks.
       */}
      {isProcessUnit && data.fillLevel !== undefined && (
        <div
          className="device-node-water-fill"
          style={{ height: `${fillLevel * 100}%`, background: fillColor }}
        />
      )}

      {/* ISA-5.1 device icon, colored by zone — sized to fill the cell */}
      <div className="device-node-icon" style={{ color: zoneColor }}>
        <DeviceIcon category={data.device.category} size={44} />
      </div>

      {/* Label and IP address, compact layout to fit the 80 × 80 cell.
          IP address row is suppressed when empty (visual-only nodes like pump/valve/sensor
          have no container so they carry no real IP address). */}
      <div className="device-node-info">
        <div className="device-node-label">{data.label}</div>
        {data.device.ipAddress && <div className="device-node-meta">{data.device.ipAddress}</div>}
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
