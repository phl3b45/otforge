/**
 * RtuPanel.tsx — RTU deployment configuration panel for the Properties Panel.
 *
 * Renders a menu-driven configuration form for Remote Terminal Unit (RTU) devices.
 * Unlike PLCs — which are programmed with structured text or ladder logic — RTUs
 * are pre-configured via drop-down menus reflecting real-world deployment choices:
 *   Communication type (wired Ethernet, RS-485, cellular, radio, satellite)
 *   Primary protocol  (DNP3, Modbus RTU/TCP, IEC 60870-5-104)
 *   Operating mode    (Report by Exception, Polled, Hybrid)
 *   Power source      (AC, Solar+Battery, Battery, DC)
 *   Site type         (free-text installation descriptor)
 *
 * Each communication type carries a different attack surface; the Security Note
 * callout at the bottom educates students on the risk implication of the selected
 * link type so they understand WHY an adversary targets remote RTUs differently
 * from control-center PLCs.
 *
 * Author Mode: all fields are editable dropdowns / inputs; changes committed
 *              immediately (select) or on blur (text/number inputs).
 * Student Mode (readOnly): all values rendered as read-only badges.
 */

import { useEffect, useState } from 'react'
import type {
  RtuConfig,
  RtuCommType,
  RtuProtocol,
  RtuOperatingMode,
  RtuPowerSource
} from '@otforge/schema'

// ── Option tables ────────────────────────────────────────────────────────────

const COMM_OPTIONS: { value: RtuCommType; label: string }[] = [
  { value: 'cellular', label: 'Cellular 4G/5G' },
  { value: 'radio', label: 'Radio (900 MHz)' },
  { value: 'satellite', label: 'Satellite (VSAT)' },
  { value: 'mqtt', label: 'MQTT (IIoT Broker)' },
  { value: 'dnp3-serial', label: 'DNP3 over Serial' }
]

const PROTOCOL_OPTIONS: { value: RtuProtocol; label: string }[] = [
  { value: 'dnp3', label: 'DNP3' },
  { value: 'modbus-rtu', label: 'Modbus RTU' },
  { value: 'modbus-tcp', label: 'Modbus TCP' },
  { value: 'iec-104', label: 'IEC 60870-5-104' }
]

const MODE_OPTIONS: { value: RtuOperatingMode; label: string }[] = [
  { value: 'report-by-exception', label: 'Report by Exception' },
  { value: 'polled', label: 'Polled' },
  { value: 'hybrid', label: 'Hybrid' }
]

const POWER_OPTIONS: { value: RtuPowerSource; label: string }[] = [
  { value: 'ac', label: 'AC Mains' },
  { value: 'solar-battery', label: 'Solar + Battery' },
  { value: 'battery', label: 'Battery Only' },
  { value: 'dc', label: 'DC (24 VDC Instrument)' }
]

// ── Security callouts keyed by commType ──────────────────────────────────────

/**
 * Maps each communication type to a concise security teaching note.
 * Shown in the panel so students immediately understand the risk implication
 * of the selected link without leaving the scenario builder.
 */
const COMM_SECURITY_NOTES: Record<RtuCommType, string> = {
  cellular:
    'Cellular-connected RTUs are often internet-exposed when using a public APN instead of a private one or VPN tunnel. This is one of the most common misconfigurations found in pipeline and power-grid ICS assessments.',
  radio:
    '900 MHz licensed-band and ISM-band radio links transmit frames without encryption or authentication by default. An attacker within radio range can replay or inject control commands using a software-defined radio (SDR).',
  satellite:
    'Satellite uplinks (VSAT) introduce 500–1500 ms round-trip latency and often route outside the corporate security stack, bypassing IDS/SIEM visibility. Jamming the uplink is a viable physical denial-of-service technique.',
  mqtt: 'MQTT brokers are commonly cloud-hosted with shared or hardcoded credentials and wildcard topic ACLs. Any subscriber with the broker address can enumerate all RTU telemetry topics and inject spoofed sensor readings.',
  'dnp3-serial':
    'DNP3 over serial (RS-485/232) to a radio or telephone modem is unauthenticated by default — DNP3 Secure Authentication v5 exists but is rarely deployed. Physical access to the serial bus allows frame injection and replay.'
}

// ── Default config ────────────────────────────────────────────────────────────

/**
 * Sensible default values used when an RTU is first dropped onto the canvas
 * and no rtuConfig has been set yet.
 */
export const DEFAULT_RTU_CONFIG: RtuConfig = {
  commType: 'cellular',
  primaryProtocol: 'dnp3',
  operatingMode: 'report-by-exception',
  pollIntervalSec: 60,
  powerSource: 'solar-battery'
}

// ── Component ─────────────────────────────────────────────────────────────────

interface RtuPanelProps {
  /** Current RTU configuration (may be undefined if device was created before this feature). */
  rtuConfig?: RtuConfig
  /** Node ID of the RTU device — passed through to the onChange callback. */
  nodeId: string
  /** When true, all fields are rendered as read-only text (Student Mode). */
  readOnly: boolean
  /**
   * Called whenever any RTU configuration field changes.
   * Receives the complete updated RtuConfig so App.tsx can replace the stored config atomically.
   */
  onChange?: (nodeId: string, config: RtuConfig) => void
}

/**
 * Menu-driven RTU configuration panel.
 *
 * Manages a local copy of the RtuConfig and calls onChange whenever the
 * author commits a change (immediately for selects; on blur for text inputs).
 */
export function RtuPanel({ rtuConfig, nodeId, readOnly, onChange }: RtuPanelProps) {
  // Merge incoming config with defaults so every field always has a valid value.
  // This handles RTU devices created before RtuConfig was added to the schema.
  const [cfg, setCfg] = useState<RtuConfig>({ ...DEFAULT_RTU_CONFIG, ...rtuConfig })

  // Re-sync local state when the selected device changes or its config is updated externally.
  useEffect(() => {
    setCfg({ ...DEFAULT_RTU_CONFIG, ...rtuConfig })
  }, [nodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Updates one field in the local config and immediately notifies App.tsx.
   * Used for <select> fields — no blur needed since selecting an option is an explicit commit.
   */
  function handleSelectChange<K extends keyof RtuConfig>(field: K, value: RtuConfig[K]): void {
    const next = { ...cfg, [field]: value }
    setCfg(next)
    onChange?.(nodeId, next)
  }

  /**
   * Updates the poll interval from the number input.
   * Notified on blur (when the user leaves the field) to avoid repeated updates mid-type.
   */
  function handlePollBlur(): void {
    onChange?.(nodeId, cfg)
  }

  /**
   * Updates the site type from the text input.
   * Notified on blur.
   */
  function handleSiteBlur(): void {
    onChange?.(nodeId, cfg)
  }

  // Label lookup helpers for read-only mode
  const commLabel = COMM_OPTIONS.find(o => o.value === cfg.commType)?.label ?? cfg.commType
  const protocolLabel =
    PROTOCOL_OPTIONS.find(o => o.value === cfg.primaryProtocol)?.label ?? cfg.primaryProtocol
  const modeLabel =
    MODE_OPTIONS.find(o => o.value === cfg.operatingMode)?.label ?? cfg.operatingMode
  const powerLabel = POWER_OPTIONS.find(o => o.value === cfg.powerSource)?.label ?? cfg.powerSource
  const showPollInterval = cfg.operatingMode === 'polled' || cfg.operatingMode === 'hybrid'

  return (
    <section className="prop-section">
      <div className="prop-section-title">RTU Configuration</div>

      {/* Communication Type */}
      <div className="prop-row">
        <span className="prop-label">Communication</span>
        {readOnly ? (
          <span className="prop-value">{commLabel}</span>
        ) : (
          <select
            className="rtu-select"
            value={cfg.commType}
            onChange={e => handleSelectChange('commType', e.target.value as RtuCommType)}
          >
            {COMM_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Primary Protocol */}
      <div className="prop-row">
        <span className="prop-label">Protocol</span>
        {readOnly ? (
          <code className="prop-value">{protocolLabel}</code>
        ) : (
          <select
            className="rtu-select rtu-select-mono"
            value={cfg.primaryProtocol}
            onChange={e => handleSelectChange('primaryProtocol', e.target.value as RtuProtocol)}
          >
            {PROTOCOL_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Operating Mode */}
      <div className="prop-row">
        <span className="prop-label">Mode</span>
        {readOnly ? (
          <span className="prop-value">{modeLabel}</span>
        ) : (
          <select
            className="rtu-select"
            value={cfg.operatingMode}
            onChange={e => handleSelectChange('operatingMode', e.target.value as RtuOperatingMode)}
          >
            {MODE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Poll Interval — only shown when mode is Polled or Hybrid */}
      {showPollInterval && (
        <div className="prop-row">
          <span className="prop-label">Poll Interval</span>
          {readOnly ? (
            <span className="prop-value">{cfg.pollIntervalSec} s</span>
          ) : (
            <div className="rtu-interval-row">
              <input
                className="prop-input prop-input-mono rtu-interval-input"
                type="number"
                min={1}
                max={3600}
                value={cfg.pollIntervalSec}
                onChange={e =>
                  setCfg(prev => ({ ...prev, pollIntervalSec: Number(e.target.value) || 60 }))
                }
                onBlur={handlePollBlur}
              />
              <span className="rtu-interval-unit">s</span>
            </div>
          )}
        </div>
      )}

      {/* Power Source */}
      <div className="prop-row">
        <span className="prop-label">Power</span>
        {readOnly ? (
          <span className="prop-value">{powerLabel}</span>
        ) : (
          <select
            className="rtu-select"
            value={cfg.powerSource}
            onChange={e => handleSelectChange('powerSource', e.target.value as RtuPowerSource)}
          >
            {POWER_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Site Type — free text */}
      <div className="prop-row">
        <span className="prop-label">Site</span>
        {readOnly ? (
          <span className="prop-value">
            {cfg.siteType || <em className="prop-value-muted">—</em>}
          </span>
        ) : (
          <input
            className="prop-input rtu-site-input"
            type="text"
            placeholder="e.g. Pipeline pump station 3"
            value={cfg.siteType ?? ''}
            onChange={e => setCfg(prev => ({ ...prev, siteType: e.target.value }))}
            onBlur={handleSiteBlur}
          />
        )}
      </div>

      {/* Security note — dynamic based on selected communication type */}
      <div className="rtu-security-note">
        <span className="rtu-security-note-icon">&#9888;</span>
        <p className="rtu-security-note-text">{COMM_SECURITY_NOTES[cfg.commType]}</p>
      </div>
    </section>
  )
}
