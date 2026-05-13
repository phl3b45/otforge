/**
 * PropertiesPanel.tsx — Device properties inspector for the right sidebar.
 *
 * When the user clicks a device node on the SCADA canvas, the PropertiesPanel
 * shows that device's full configuration: identity, zone, IP address, assigned
 * protocols, and protocol-specific parameters (Modbus unit ID, DNP3 addresses, etc.).
 *
 * State management:
 *   - The panel is stateless; it receives `device` and `zone` props from App.tsx
 *     which tracks the selection from the canvas's onSelectionChange event.
 *   - When no device is selected, the panel shows an empty-state placeholder.
 *
 * Protocol sections:
 *   - Modbus: mode (TCP/RTU/ASCII), port, unit ID
 *   - DNP3: master address, outstation address, port
 *   - OPC UA: port, namespace URI
 *   Only the sections relevant to the device's configured protocols are shown.
 *
 * PLC IDE delegation (Phase 4):
 *   When `device.category === 'plc'`, the panel renders PlcIdePanel instead of
 *   the standard property rows. PlcIdePanel provides a full Structured Text editor,
 *   variable binding table, ladder logic viewer, and deploy controls.
 *
 * Attack machine warning:
 *   The Kali Linux container has special network placement requirements. A warning
 *   banner is shown when an attack machine is selected to explain the constraints.
 */

import type { DeviceConfig, PLCProgramConfig } from '@ics-sim/schema'
import { DeviceIcon } from '../icons/DeviceIcons'
import { ZONE_COLORS } from '../canvas/DeviceNode'
import { PlcIdePanel } from './PlcIdePanel'

/** Full human-readable names for the properties panel header. */
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

/** Zone display labels for the Zone row. */
const ZONE_LABELS: Record<string, string> = {
  ot: 'OT Network',
  it: 'IT Network',
  dmz: 'DMZ',
  external: 'External'
}

interface PropertiesPanelProps {
  /** The currently selected device, or null when nothing is selected. */
  device: DeviceConfig | null
  /** The zone key of the selected device (e.g., "ot", "it"). Null when no device selected. */
  zone: string | null
  /**
   * True when a simulation is actively running. Passed to PlcIdePanel to enable
   * the Deploy button — deployment requires a live OpenPLC container.
   */
  simRunning: boolean
  /**
   * Callback for PLC program changes from the PlcIdePanel editor.
   * Called when the user saves or deploys a program. The App component
   * writes the update into the scenario.devices.devices[nodeId].plcProgram field.
   *
   * @param nodeId  - The PLC device's canvas node ID.
   * @param program - The updated PLCProgramConfig to store in the scenario.
   */
  onProgramChange: (nodeId: string, program: PLCProgramConfig) => void
}

/**
 * Renders the device properties inspector panel.
 *
 * Shows an empty state with a hexagon icon when no device is selected.
 * When a device is selected, renders sections for:
 *   - Header: device icon + category name (in zone color) + node ID
 *   - PLC IDE (PlcIdePanel) if category === 'plc'  [Phase 4]
 *   - Identity: node ID, zone, IP address
 *   - Protocols: list of assigned protocol tags
 *   - Modbus config (if device.modbus is defined)
 *   - DNP3 config (if device.dnp3 is defined)
 *   - OPC UA config (if device.opcua is defined)
 *   - Attack machine warning banner (if category === 'attack-machine')
 *
 * @param device          - Selected DeviceConfig or null.
 * @param zone            - Zone key string or null.
 * @param simRunning      - Whether a simulation is active (for Deploy button state).
 * @param onProgramChange - Callback to persist PLC program changes.
 */
export function PropertiesPanel({
  device,
  zone,
  simRunning,
  onProgramChange
}: PropertiesPanelProps) {
  // Empty state — shown when no node is selected on the canvas
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

  // Resolve zone color — fall back to muted gray if the zone key is unrecognized
  const zoneColor = zone ? (ZONE_COLORS[zone as keyof typeof ZONE_COLORS] ?? '#8b949e') : '#8b949e'
  const zoneLabel = zone ? (ZONE_LABELS[zone] ?? zone) : '—'

  return (
    // The panel widens slightly when a PLC is selected to give the ST editor more room
    <aside className={`properties-panel${device.category === 'plc' ? ' plc-mode' : ''}`}>
      {/* Header: icon + category type label (colored by zone) + node ID */}
      <div className="properties-header">
        <DeviceIcon category={device.category} size={22} color={zoneColor} />
        <div className="properties-title">
          <div className="properties-name">{device.nodeId}</div>
          <div className="properties-type" style={{ color: zoneColor }}>
            {CATEGORY_LABELS[device.category] ?? device.category}
          </div>
        </div>
      </div>

      {/* PLC IDE takes over the full panel body for PLC devices */}
      {device.category === 'plc' && (
        <div className="properties-body">
          <PlcIdePanel device={device} simRunning={simRunning} onProgramChange={onProgramChange} />
        </div>
      )}

      {/* Standard property rows for all non-PLC devices */}
      {device.category !== 'plc' && (
        <div className="properties-body">
          {/* ── Identity section ─────────────────────────────────────────────── */}
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

          {/* ── Protocols section ────────────────────────────────────────────── */}
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

          {/* ── Modbus config (shown only when device has Modbus enabled) ─────── */}
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

          {/* ── DNP3 config (shown only when device has DNP3 enabled) ─────────── */}
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

          {/* ── OPC UA config (shown only when device has OPC UA enabled) ──────── */}
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

          {/* ── Attack machine warning ────────────────────────────────────────── */}
          {device.category === 'attack-machine' && (
            <div className="prop-warning">
              Kali Linux — only reachable from External network segment. Requires Docker Desktop
              with additional RAM allocation.
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
