/**
 * DevicePalette.tsx — Drag-and-drop device library panel for the SCADA canvas.
 *
 * The palette is a sidebar panel on the left side of the workspace that lists all
 * available device types for the currently active Purdue layer tab. Users drag
 * items from the palette onto the canvas to add new devices to their scenario.
 *
 * Layer-aware filtering (Purdue Reference Model):
 *   OT Process (L0-L2)    — PLCs, RTUs, IEDs, field devices (sensors, actuators, pumps, etc.)
 *   Control Center (L3)   — HMIs, historians, application servers, database servers, engineering workstations
 *   Plant DMZ (L3.5)      — Firewalls, IDS/IPS, switches, routers
 *   Enterprise (L4)       — Domain controllers, web servers, business servers, enterprise desktops
 *   Internet DMZ (L5)     — Email servers, internet-facing servers
 *
 * Attack Machine is intentionally absent from the palette — the red team machine
 * is added via the dedicated "Add Attack Machine" toolbar button and launched in
 * a separate OS window when the simulation is running.
 *
 * Drag protocol:
 *   - onDragStart sets `event.dataTransfer.setData('deviceCategory', category)`
 *   - The ScadaCanvas.onDrop handler reads this value and creates a new DeviceNode
 *     assigned to the active layer (no y-coordinate zone detection needed).
 *
 * Color overrides:
 *   Security devices (Firewall, IDS/IPS) use amber to mark them as boundary devices.
 *   Enterprise/internet devices use purple and orange matching their zone accent.
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
 * Master palette definition — all device categories grouped by Purdue layer and function.
 * The `layers` array restricts which tab each section appears on.
 * Order within each section reflects typical design-order for that layer.
 */
const PALETTE: PaletteSection[] = [
  // ── OT Process (Levels 0–2) ────────────────────────────────────────────────
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
  // ── Control Center (Level 3) ────────────────────────────────────────────────
  {
    label: 'SCADA / HMI',
    layers: ['control'],
    items: [
      { category: 'hmi', label: 'HMI' },
      { category: 'historian', label: 'Historian' }
    ]
  },
  {
    label: 'Servers',
    layers: ['control'],
    items: [
      { category: 'application-server', label: 'App Server' },
      { category: 'database-server', label: 'DB Server' },
      { category: 'engineering-workstation', label: 'Eng. Workstation' }
    ]
  },
  // ── Plant DMZ (Level 3.5) ───────────────────────────────────────────────────
  {
    label: 'Security',
    layers: ['plant-dmz'],
    items: [
      { category: 'firewall', label: 'Firewall' },
      { category: 'ids-ips', label: 'IDS/IPS' }
    ]
  },
  {
    label: 'Network',
    layers: ['plant-dmz'],
    items: [
      { category: 'switch', label: 'Switch' },
      { category: 'router', label: 'Router' }
    ]
  },
  // ── Enterprise Zone (Level 4) ───────────────────────────────────────────────
  {
    label: 'Directory & Servers',
    layers: ['enterprise'],
    items: [
      { category: 'domain-controller', label: 'Domain Controller' },
      { category: 'web-server', label: 'Web Server' },
      { category: 'business-server', label: 'Business Server' }
    ]
  },
  {
    label: 'Endpoints',
    layers: ['enterprise'],
    items: [
      { category: 'enterprise-desktop', label: 'Enterprise Desktop' },
      { category: 'switch', label: 'Switch' },
      { category: 'router', label: 'Router' }
    ]
  },
  // ── Internet DMZ (Level 5) ───────────────────────────────────────────────────
  {
    label: 'Internet-Facing',
    layers: ['internet-dmz'],
    items: [
      { category: 'email-server', label: 'Email Server' },
      { category: 'internet-server', label: 'Internet Server' },
      { category: 'firewall', label: 'Firewall' }
    ]
  }
]

/**
 * Per-category icon color overrides for visually distinctive palette entries.
 * Categories not listed here use the default muted gray (#8b949e).
 */
const PALETTE_COLORS: Partial<Record<DeviceCategory, string>> = {
  // Security boundary devices — amber
  firewall: '#d29922',
  'ids-ips': '#d29922',
  // Enterprise devices — purple
  'domain-controller': '#a371f7',
  'web-server': '#a371f7',
  'business-server': '#a371f7',
  'enterprise-desktop': '#a371f7',
  // Internet DMZ devices — orange
  'email-server': '#f78166',
  'internet-server': '#f78166'
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
          <div
            key={`${section.label}-${section.layers?.join('-') ?? 'all'}`}
            className="palette-section"
          >
            <div className="palette-section-label">{section.label}</div>
            {section.items.map(item => (
              <PaletteItem key={`${item.category}-${section.label}`} {...item} />
            ))}
          </div>
        ))}
      </div>
      <div className="palette-hint">Drag devices onto the canvas</div>
    </aside>
  )
}
