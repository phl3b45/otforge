import type { DeviceCategory } from '@ics-sim/schema'
import { DeviceIcon } from '../icons/DeviceIcons'

interface PaletteSection {
  label: string
  items: { category: DeviceCategory; label: string }[]
}

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

const PALETTE_COLORS: Partial<Record<DeviceCategory, string>> = {
  'attack-machine': '#f85149',
  firewall: '#d29922',
  'ids-ips': '#d29922'
}

function PaletteItem({ category, label }: { category: DeviceCategory; label: string }) {
  function onDragStart(event: React.DragEvent) {
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
