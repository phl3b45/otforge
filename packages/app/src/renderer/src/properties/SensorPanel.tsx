/**
 * SensorPanel.tsx — smart-sensor configuration panel for the Properties Panel.
 *
 * Renders the configuration form for the consolidated smart-sensor device type.
 * Rather than a separate DeviceCategory per physical instrument, smart-sensor
 * carries a single `kind` field (temperature/gas/vibration/flow/pressure/level/
 * analyzer/pmu) selected here via dropdown — the canvas icon, default engineering
 * units, and default range follow that choice automatically. This keeps adding a
 * future sensor kind a config-only change: no new DeviceCategory, no touching
 * every Record<DeviceCategory, ...> exhaustiveness table across the renderer and
 * orchestrator packages.
 *
 * smart-sensor spawns a real otforge-modbus container (containers/modbus/server.py)
 * that generates this waveform itself and serves it as a Modbus TCP holding register
 * at `modbusRegister` — FUXA cannot act as a Modbus server, so it polls this container
 * as a client (configureFuxa() in main/index.ts) exactly like it does for rtu/sensor.
 * The PLC polls the same register directly.
 *
 * Author Mode: all fields are editable dropdowns / inputs; changes committed
 *              immediately (select) or on blur (text/number inputs).
 * Student Mode (readOnly): all values rendered as read-only badges.
 */

import { useEffect, useState } from 'react'
import type { SensorConfig } from '@otforge/schema'

type SensorKind = SensorConfig['kind']
type Waveform = SensorConfig['waveform']

// ── Option tables ────────────────────────────────────────────────────────────

const KIND_OPTIONS: { value: SensorKind; label: string }[] = [
  { value: 'temperature', label: 'Temperature' },
  { value: 'gas', label: 'Gas Detector' },
  { value: 'vibration', label: 'Vibration' },
  { value: 'flow', label: 'Flow Meter' },
  { value: 'pressure', label: 'Pressure Transmitter' },
  { value: 'level', label: 'Level Transmitter' },
  { value: 'analyzer', label: 'Process Analyzer' },
  { value: 'pmu', label: 'Phasor Measurement Unit' }
]

const WAVEFORM_OPTIONS: { value: Waveform; label: string }[] = [
  { value: 'sine', label: 'Sine (smooth oscillation)' },
  { value: 'random', label: 'Random (white noise)' },
  { value: 'sawtooth', label: 'Sawtooth (ramp + reset)' },
  { value: 'square', label: 'Square (two-state)' },
  { value: 'constant', label: 'Constant' }
]

/**
 * Sensible engineering-unit / range / waveform defaults per sensor kind.
 * Applied whenever the author switches the Kind dropdown, since a temperature
 * range in °C makes no sense once the node becomes a gas detector reading ppm.
 */
const KIND_DEFAULTS: Record<
  SensorKind,
  Pick<SensorConfig, 'units' | 'minValue' | 'maxValue' | 'waveform' | 'noisePercent'>
> = {
  temperature: { units: '°C', minValue: -20, maxValue: 150, waveform: 'sine', noisePercent: 5 },
  gas: { units: 'ppm', minValue: 0, maxValue: 100, waveform: 'random', noisePercent: 10 },
  vibration: { units: 'mm/s²', minValue: 0, maxValue: 50, waveform: 'sine', noisePercent: 15 },
  flow: { units: 'L/min', minValue: 0, maxValue: 300, waveform: 'sawtooth', noisePercent: 5 },
  pressure: { units: 'bar', minValue: 0, maxValue: 16, waveform: 'sine', noisePercent: 5 },
  level: { units: 'm', minValue: 0, maxValue: 10, waveform: 'sawtooth', noisePercent: 3 },
  analyzer: { units: 'pH', minValue: 0, maxValue: 14, waveform: 'sine', noisePercent: 8 },
  pmu: { units: 'Hz', minValue: 49.5, maxValue: 50.5, waveform: 'sine', noisePercent: 2 }
}

// ── Default config ────────────────────────────────────────────────────────────

/**
 * Sensible default values used when a smart-sensor is first dropped onto the
 * canvas and no SensorConfig has been set yet.
 */
export const DEFAULT_SENSOR_CONFIG: SensorConfig = {
  kind: 'temperature',
  ...KIND_DEFAULTS.temperature,
  modbusRegister: 0
}

// ── Component ─────────────────────────────────────────────────────────────────

interface SensorPanelProps {
  /** Current sensor configuration (may be undefined if device predates this feature). */
  sensorConfig?: SensorConfig
  /** Node ID of the smart-sensor device — passed through to the onChange callback. */
  nodeId: string
  /** When true, all fields are rendered as read-only text (Student Mode). */
  readOnly: boolean
  /**
   * Called whenever any sensor configuration field changes.
   * Receives the complete updated SensorConfig so App.tsx can replace the stored config atomically.
   */
  onChange?: (nodeId: string, config: SensorConfig) => void
}

/**
 * Menu-driven smart-sensor configuration panel.
 *
 * Manages a local copy of the SensorConfig and calls onChange whenever the
 * author commits a change (immediately for selects; on blur for text/number inputs).
 */
export function SensorPanel({ sensorConfig, nodeId, readOnly, onChange }: SensorPanelProps) {
  // Merge incoming config with defaults so every field always has a valid value.
  // This handles smart-sensor devices created before SensorConfig had a required `kind`.
  const [cfg, setCfg] = useState<SensorConfig>({ ...DEFAULT_SENSOR_CONFIG, ...sensorConfig })

  // Re-sync local state when the selected device changes or its config is updated externally.
  useEffect(() => {
    setCfg({ ...DEFAULT_SENSOR_CONFIG, ...sensorConfig })
  }, [nodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Switches the sensor kind and resets units/range/waveform/noise to that
   * kind's sensible defaults. Modbus register, sample rate, alarm band, and
   * tag name are left untouched since those are placement-specific, not kind-specific.
   */
  function handleKindChange(kind: SensorKind): void {
    const next = { ...cfg, kind, ...KIND_DEFAULTS[kind] }
    setCfg(next)
    onChange?.(nodeId, next)
  }

  /** Updates the waveform — selecting an option is an explicit commit, no blur needed. */
  function handleWaveformChange(waveform: Waveform): void {
    const next = { ...cfg, waveform }
    setCfg(next)
    onChange?.(nodeId, next)
  }

  /** Commits the current local config on blur — used by all numeric/text inputs. */
  function commit(): void {
    onChange?.(nodeId, cfg)
  }

  const kindLabel = KIND_OPTIONS.find(o => o.value === cfg.kind)?.label ?? cfg.kind
  const waveformLabel = WAVEFORM_OPTIONS.find(o => o.value === cfg.waveform)?.label ?? cfg.waveform

  return (
    <section className="prop-section">
      <div className="prop-section-title">Sensor Configuration</div>

      {/* Kind — Temperature / Gas / Vibration */}
      <div className="prop-row">
        <span className="prop-label">Kind</span>
        {readOnly ? (
          <span className="prop-value">{kindLabel}</span>
        ) : (
          <select
            className="rtu-select"
            value={cfg.kind}
            onChange={e => handleKindChange(e.target.value as SensorKind)}
          >
            {KIND_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Waveform */}
      <div className="prop-row">
        <span className="prop-label">Waveform</span>
        {readOnly ? (
          <span className="prop-value">{waveformLabel}</span>
        ) : (
          <select
            className="rtu-select"
            value={cfg.waveform}
            onChange={e => handleWaveformChange(e.target.value as Waveform)}
          >
            {WAVEFORM_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Range — min/max engineering value */}
      <div className="prop-row">
        <span className="prop-label">Range</span>
        {readOnly ? (
          <span className="prop-value">
            {cfg.minValue} – {cfg.maxValue} {cfg.units}
          </span>
        ) : (
          <div className="rtu-interval-row">
            <input
              className="prop-input prop-input-mono rtu-interval-input"
              type="number"
              value={cfg.minValue}
              onChange={e => setCfg(prev => ({ ...prev, minValue: Number(e.target.value) || 0 }))}
              onBlur={commit}
            />
            <span className="rtu-interval-unit">–</span>
            <input
              className="prop-input prop-input-mono rtu-interval-input"
              type="number"
              value={cfg.maxValue}
              onChange={e => setCfg(prev => ({ ...prev, maxValue: Number(e.target.value) || 0 }))}
              onBlur={commit}
            />
          </div>
        )}
      </div>

      {/* Units — free text, e.g. °C, ppm, mm/s² */}
      <div className="prop-row">
        <span className="prop-label">Units</span>
        {readOnly ? (
          <code className="prop-value">{cfg.units}</code>
        ) : (
          <input
            className="prop-input prop-input-mono"
            type="text"
            value={cfg.units}
            onChange={e => setCfg(prev => ({ ...prev, units: e.target.value }))}
            onBlur={commit}
          />
        )}
      </div>

      {/* Noise % */}
      <div className="prop-row">
        <span className="prop-label">Noise</span>
        {readOnly ? (
          <span className="prop-value">{cfg.noisePercent}%</span>
        ) : (
          <div className="rtu-interval-row">
            <input
              className="prop-input prop-input-mono rtu-interval-input"
              type="number"
              min={0}
              max={100}
              value={cfg.noisePercent}
              onChange={e =>
                setCfg(prev => ({ ...prev, noisePercent: Number(e.target.value) || 0 }))
              }
              onBlur={commit}
            />
            <span className="rtu-interval-unit">%</span>
          </div>
        )}
      </div>

      {/* Modbus register — FC03 holding register address FUXA exposes this tag on */}
      <div className="prop-row">
        <span className="prop-label">Modbus Reg</span>
        {readOnly ? (
          <code className="prop-value">{cfg.modbusRegister}</code>
        ) : (
          <input
            className="prop-input prop-input-mono"
            type="number"
            min={0}
            value={cfg.modbusRegister}
            onChange={e =>
              setCfg(prev => ({ ...prev, modbusRegister: Number(e.target.value) || 0 }))
            }
            onBlur={commit}
          />
        )}
      </div>

      {/* Tag name override — optional, free text */}
      <div className="prop-row">
        <span className="prop-label">Tag Name</span>
        {readOnly ? (
          <span className="prop-value">
            {cfg.tagName || <em className="prop-value-muted">auto</em>}
          </span>
        ) : (
          <input
            className="prop-input"
            type="text"
            placeholder="auto from label"
            value={cfg.tagName ?? ''}
            onChange={e => setCfg(prev => ({ ...prev, tagName: e.target.value }))}
            onBlur={commit}
          />
        )}
      </div>
    </section>
  )
}
