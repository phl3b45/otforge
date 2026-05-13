/**
 * DevicePalette.tsx — Drag-and-drop device library panel for the SCADA canvas.
 *
 * The palette is a sidebar panel on the left side of the workspace that lists all
 * available device types. Users drag items from the palette onto the canvas to add
 * new devices to their scenario.
 *
 * Drag protocol:
 *   - onDragStart sets `event.dataTransfer.setData('deviceCategory', category)`
 *   - The ScadaCanvas.onDrop handler reads this value, determines the drop zone,
 *     and creates a new DeviceNode + DeviceConfig at the drop position
 *
 * Organization:
 *   Devices are grouped into five thematic sections matching ICS/SCADA taxonomy:
 *     Control      — PLC, RTU, IED (programmable automation controllers)
 *     Field Devices — sensors and actuating elements (on the physical process)
 *     Monitoring   — HMI workstation and data historian
 *     Network      — firewall, IDS/IPS, switch, router (network infrastructure)
 *     Red Team     — Kali attack machine (always placed in External zone)
 *
 * Color overrides:
 *   - Attack Machine and security devices (Firewall, IDS/IPS) use distinct colors
 *     to make them visually distinguishable from benign OT/IT devices at a glance
 */

import type { DeviceCategory } from '@ics-sim/schema'
import { DeviceIcon } from '../icons/DeviceIcons'

/** Describes a group of related palette items shown under a section header. */
interface PaletteSection {
  /** Section header text displayed above the group. */
  label: string
  /** Ordered list of draggable items in this section. */
  items: { category: DeviceCategory; label: string }[]
}

/**
 * The master palette definition — all 16 device categories grouped by function.
 * Order within each section reflects typical P&ID reading order (controllers first,
 * then field devices they control, then monitoring, then infrastructure).
 */
const PALETTE: PaletteSection[] = [
  {
    label: 'Control',
    items: [
      { category: 'plc', label: 'PLC' },
      { category: 'rtu', label: 'RTU' },
      { category: 'ied', label: 'IED' }
    ]
  },
  {
    label: 'Field Devices',
    items: [
      { category: 'sensor', label: 'Sensor' },
      { category: 'actuator', label: 'Actuator' },
      { category: 'pump', label: 'Pump' },
      { category: 'valve', label: 'Valve' },
      { category: 'flow-meter', label: 'Flow Meter' },
      { category: 'pressure-transmitter', label: 'Pressure TX' }
    ]
  },
  {
    label: 'Monitoring',
    items: [
      { category: 'hmi', label: 'HMI' },
      { category: 'historian', label: 'Historian' }
    ]
  },
  {
    label: 'Network',
    items: [
      { category: 'firewall', label: 'Firewall' },
      { category: 'ids-ips', label: 'IDS/IPS' },
      { category: 'switch', label: 'Switch' },
      { category: 'router', label: 'Router' }
    ]
  },
  {
    label: 'Red Team',
    items: [{ category: 'attack-machine', label: 'Attack Machine' }]
  }
]

/**
 * Per-category icon color overrides for visually distinctive palette entries.
 * Categories not listed here use the default muted gray (#8b949e).
 */
const PALETTE_COLORS: Partial<Record<DeviceCategory, string>> = {
  'attack-machine': '#f85149', // Red — hostile/adversarial device
  firewall: '#d29922', // Amber — security boundary device
  'ids-ips': '#d29922' // Amber — security monitoring device
}

/**
 * A single draggable item in the palette.
 *
 * Sets the HTML Drag and Drop API's transfer data so ScadaCanvas.onDrop
 * can read the category and create the appropriate device node.
 *
 * @param category - The DeviceCategory this item represents.
 * @param label    - Human-readable display name.
 */
function PaletteItem({ category, label }: { category: DeviceCategory; label: string }) {
  function onDragStart(event: React.DragEvent) {
    // Pass the category string to the drop handler via the drag data store
    event.dataTransfer.setData('deviceCategory', category)
    event.dataTransfer.effectAllowed = 'copy'
  }

  const color = PALETTE_COLORS[category] ?? '#8b949e'

  return (
    <div
      className="palette-item"
      draggable
      onDragStart={onDragStart}
      title={`Drag to canvas to add a ${label}`}
    >
      <DeviceIcon category={category} size={20} color={color} />
      <span className="palette-item-label">{label}</span>
    </div>
  )
}

/**
 * Renders the full device palette sidebar.
 *
 * Iterates over PALETTE sections and renders each section with a header and
 * its list of draggable PaletteItems. A hint text at the bottom reminds new
 * users of the drag interaction.
 */
export function DevicePalette() {
  return (
    <aside className="device-palette">
      <div className="palette-header">Devices</div>
      <div className="palette-sections">
        {PALETTE.map(section => (
          <div key={section.label} className="palette-section">
            <div className="palette-section-label">{section.label}</div>
            {section.items.map(item => (
              <PaletteItem key={item.category} {...item} />
            ))}
          </div>
        ))}
      </div>
      <div className="palette-hint">Drag devices onto the canvas</div>
    </aside>
  )
}
