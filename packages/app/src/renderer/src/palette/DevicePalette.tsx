/**
 * DevicePalette.tsx — Drag-and-drop device library panel for the SCADA canvas.
 *
 * The palette is a sidebar panel on the left side of the workspace that lists all
 * available device types for the currently active Purdue layer tab. Users drag
 * items from the palette onto the canvas to add new devices to their scenario.
 *
 * Layer-aware filtering:
 *   Each Purdue layer tab shows only the device types that make sense there:
 *     OT Process  — PLCs, RTUs, IEDs, field devices (sensors, actuators, pumps, etc.)
 *     IT Network  — HMI workstations, historians, switches, routers
 *     DMZ         — Firewalls, IDS/IPS sensors, switches, routers
 *     External    — Attack machine (Kali Linux) only
 *
 * Drag protocol:
 *   - onDragStart sets `event.dataTransfer.setData('deviceCategory', category)`
 *   - The ScadaCanvas.onDrop handler reads this value and creates a new DeviceNode
 *     assigned to the active layer (no y-coordinate zone detection needed).
 *
 * Color overrides:
 *   Attack Machine and security devices (Firewall, IDS/IPS) use distinct colors
 *   to make them visually distinguishable from benign OT/IT devices at a glance.
 */

import type { DeviceCategory, NetworkZone } from '@ics-sim/schema'
import { DeviceIcon } from '../icons/DeviceIcons'

/** Describes a group of related palette items shown under a section header. */
interface PaletteSection {
  /** Section header text displayed above the group. */
  label: string
  /** Ordered list of draggable items in this section. */
  items: { category: DeviceCategory; label: string }[]
  /** Which layers this section is shown on. Omit to show on all layers. */
  layers?: NetworkZone[]
}

/**
 * Master palette definition — all 16 device categories, grouped by function.
 * The `layers` array restricts which tab each section appears on.
 * Order within each section reflects typical P&ID reading order (controllers first,
 * then field devices they control, then monitoring, then infrastructure).
 */
const PALETTE: PaletteSection[] = [
  {
    label: 'Control',
    layers: ['ot'],
    items: [
      { category: 'plc', label: 'PLC' },
      { category: 'rtu', label: 'RTU' },
      { category: 'ied', label: 'IED' }
    ]
  },
  {
    label: 'Field Devices',
    layers: ['ot'],
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
    layers: ['it'],
    items: [
      { category: 'hmi', label: 'HMI' },
      { category: 'historian', label: 'Historian' }
    ]
  },
  {
    label: 'Network',
    layers: ['it', 'dmz'],
    items: [
      { category: 'switch', label: 'Switch' },
      { category: 'router', label: 'Router' }
    ]
  },
  {
    label: 'Security',
    layers: ['dmz'],
    items: [
      { category: 'firewall', label: 'Firewall' },
      { category: 'ids-ips', label: 'IDS/IPS' }
    ]
  },
  {
    label: 'Red Team',
    layers: ['external'],
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
      <DeviceIcon category={category} size={28} color={color} />
      <span className="palette-item-label">{label}</span>
    </div>
  )
}

interface DevicePaletteProps {
  /** The currently active Purdue layer — controls which sections are shown. */
  activeLayer: NetworkZone
}

/**
 * Renders the device palette sidebar filtered to the active Purdue layer.
 *
 * Iterates over PALETTE sections, skipping any that don't include the current
 * layer in their `layers` array. A hint text at the bottom reminds new users
 * of the drag interaction.
 */
export function DevicePalette({ activeLayer }: DevicePaletteProps) {
  const visibleSections = PALETTE.filter(
    section => !section.layers || section.layers.includes(activeLayer)
  )

  return (
    <aside className="device-palette">
      <div className="palette-header">Devices</div>
      <div className="palette-sections">
        {visibleSections.map(section => (
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
