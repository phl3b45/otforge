import type { DeviceConfig } from '@ics-sim/schema'
import { DeviceIcon } from '../icons/DeviceIcons'
import { ZONE_COLORS } from '../canvas/DeviceNode'

const CATEGORY_LABELS: Record<string, string> = {
  plc: 'Programmable Logic Controller',
  rtu: 'Remote Terminal Unit',
  ied: 'Intelligent Electronic Device',
  hmi: 'Human Machine Interface',
  historian: 'Data Historian',
  sensor: 'Field Sensor',
  actuator: 'Actuator',
  pump: 'Pump',
  valve: 'Control Valve',
  'flow-meter': 'Flow Meter',
  'pressure-transmitter': 'Pressure Transmitter',
  firewall: 'Firewall',
  'ids-ips': 'IDS / IPS',
  switch: 'Network Switch',
  router: 'Router',
  'attack-machine': 'Attack Machine'
}

const ZONE_LABELS: Record<string, string> = {
  ot: 'OT Network',
  it: 'IT Network',
  dmz: 'DMZ',
  external: 'External'
}

interface PropertiesPanelProps {
  device: DeviceConfig | null
  zone: string | null
  onIpChange?: (nodeId: string, newIp: string) => void
}

export function PropertiesPanel({ device, zone }: PropertiesPanelProps) {
  if (!device) {
    return (
      <aside className="properties-panel empty">
        <div className="properties-empty">
          <span className="properties-empty-icon">⬡</span>
          <p>
            Select a device
            <br />
            to view properties
          </p>
        </div>
      </aside>
    )
  }

  const zoneColor = zone ? (ZONE_COLORS[zone as keyof typeof ZONE_COLORS] ?? '#8b949e') : '#8b949e'
  const zoneLabel = zone ? (ZONE_LABELS[zone] ?? zone) : '—'

  return (
    <aside className="properties-panel">
      <div className="properties-header">
        <DeviceIcon category={device.category} size={22} color={zoneColor} />
        <div className="properties-title">
          <div className="properties-name">{device.nodeId}</div>
          <div className="properties-type" style={{ color: zoneColor }}>
            {CATEGORY_LABELS[device.category] ?? device.category}
          </div>
        </div>
      </div>

      <div className="properties-body">
        <section className="prop-section">
          <div className="prop-row">
            <span className="prop-label">Node ID</span>
            <code className="prop-value">{device.nodeId}</code>
          </div>
          <div className="prop-row">
            <span className="prop-label">Zone</span>
            <span className="prop-value" style={{ color: zoneColor }}>
              {zoneLabel}
            </span>
          </div>
          <div className="prop-row">
            <span className="prop-label">IP Address</span>
            <code className="prop-value">{device.ipAddress}</code>
          </div>
        </section>

        <section className="prop-section">
          <div className="prop-section-title">Protocols</div>
          <div className="prop-tags">
            {device.protocols.length > 0 ? (
              device.protocols.map(p => (
                <span key={p} className="prop-tag">
                  {p}
                </span>
              ))
            ) : (
              <span className="prop-tag muted">none</span>
            )}
          </div>
        </section>

        {device.modbus && (
          <section className="prop-section">
            <div className="prop-section-title">Modbus</div>
            <div className="prop-row">
              <span className="prop-label">Mode</span>
              <code className="prop-value">{device.modbus.mode}</code>
            </div>
            <div className="prop-row">
              <span className="prop-label">Port</span>
              <code className="prop-value">{device.modbus.port}</code>
            </div>
            <div className="prop-row">
              <span className="prop-label">Unit ID</span>
              <code className="prop-value">{device.modbus.unitId}</code>
            </div>
          </section>
        )}

        {device.dnp3 && (
          <section className="prop-section">
            <div className="prop-section-title">DNP3</div>
            <div className="prop-row">
              <span className="prop-label">Master Addr</span>
              <code className="prop-value">{device.dnp3.masterAddress}</code>
            </div>
            <div className="prop-row">
              <span className="prop-label">Outstation</span>
              <code className="prop-value">{device.dnp3.outstationAddress}</code>
            </div>
            <div className="prop-row">
              <span className="prop-label">Port</span>
              <code className="prop-value">{device.dnp3.port}</code>
            </div>
          </section>
        )}

        {device.opcua && (
          <section className="prop-section">
            <div className="prop-section-title">OPC UA</div>
            <div className="prop-row">
              <span className="prop-label">Port</span>
              <code className="prop-value">{device.opcua.port}</code>
            </div>
            <div className="prop-row">
              <span className="prop-label">Namespace</span>
              <code className="prop-value">{device.opcua.namespace}</code>
            </div>
          </section>
        )}

        {device.category === 'attack-machine' && (
          <div className="prop-warning">
            Kali Linux — only reachable from External network segment. Requires Docker Desktop with
            additional RAM allocation.
          </div>
        )}
      </div>
    </aside>
  )
}
