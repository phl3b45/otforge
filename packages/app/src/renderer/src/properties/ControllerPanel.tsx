/**
 * ControllerPanel.tsx — smart-controller configuration panel for the Properties Panel.
 *
 * Renders the configuration form for the consolidated smart-controller device type.
 * Rather than a separate DeviceCategory per physical device, smart-controller carries
 * a single `kind` field (pump/valve/vfd/actuator/wellhead-controller) selected here via
 * dropdown — the canvas icon and the set of kind-specific fields shown below follow that
 * choice. Unlike SensorPanel's kinds (which share one field shape with different
 * defaults), controller kinds have genuinely different fields — ControllerConfig models
 * this as one flat interface with all kind-specific fields optional, same pattern as
 * ProcessUnitConfig. This keeps adding a future controller kind a config-only change: no
 * new DeviceCategory, no touching every Record<DeviceCategory, ...> exhaustiveness table
 * across the renderer and orchestrator packages.
 *
 * Unlike smart-sensor, smart-controller DOES spawn a real Docker container (the same
 * otforge-modbus image rtu uses) — these fields are informational/educational, injected
 * as CONTROLLER_* env vars by compose-generator. Real protocol behavior comes from the
 * device's generic modbus/dnp3 config blocks.
 *
 * Author Mode: all fields are editable dropdowns / inputs; changes committed
 *              immediately (select) or on blur (text/number inputs).
 * Student Mode (readOnly): all values rendered as read-only badges.
 */

import { useEffect, useState } from 'react'
import type { ControllerConfig } from '@otforge/schema'

type ControllerKind = ControllerConfig['kind']

// ── Option tables ────────────────────────────────────────────────────────────

const KIND_OPTIONS: { value: ControllerKind; label: string }[] = [
  { value: 'pump', label: 'Pump' },
  { value: 'valve', label: 'Valve' },
  { value: 'vfd', label: 'VFD / Motor Drive' },
  { value: 'actuator', label: 'Actuator' },
  { value: 'wellhead-controller', label: 'Wellhead Controller' }
]

const ACTUATOR_TYPE_OPTIONS: NonNullable<ControllerConfig['actuatorType']>[] = [
  'pneumatic',
  'electric',
  'hydraulic'
]
const FAIL_POSITION_OPTIONS: NonNullable<ControllerConfig['failPosition']>[] = [
  'open',
  'closed',
  'last'
]
const TRAVEL_TYPE_OPTIONS: NonNullable<ControllerConfig['travelType']>[] = ['linear', 'rotary']
const SIGNAL_TYPE_OPTIONS: NonNullable<ControllerConfig['signalType']>[] = [
  '4-20mA',
  'discrete',
  'modbus'
]
const LIFT_METHOD_OPTIONS: NonNullable<ControllerConfig['liftMethod']>[] = [
  'natural',
  'rod-pump',
  'esp',
  'gas-lift'
]

/**
 * Sensible kind-specific field defaults. Applied whenever the author switches the
 * Kind dropdown — clears the previous kind's fields since they're not relevant.
 */
const KIND_DEFAULTS: Record<ControllerKind, Partial<ControllerConfig>> = {
  pump: { ratedFlowLpm: 150, motorPowerKw: 7.5 },
  valve: { actuatorType: 'electric', failPosition: 'closed' },
  vfd: { maxFrequencyHz: 60 },
  actuator: { travelType: 'linear', signalType: '4-20mA' },
  'wellhead-controller': {
    chokePositionPercent: 50,
    downholePressureSetpointBar: 200,
    liftMethod: 'natural'
  }
}

// ── Default config ────────────────────────────────────────────────────────────

/**
 * Sensible default values used when a smart-controller is first dropped onto the
 * canvas and no ControllerConfig has been set yet.
 */
export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = {
  kind: 'pump',
  ...KIND_DEFAULTS.pump
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ControllerPanelProps {
  /** Current controller configuration (may be undefined if device predates this feature). */
  controllerConfig?: ControllerConfig
  /** Node ID of the smart-controller device — passed through to the onChange callback. */
  nodeId: string
  /** When true, all fields are rendered as read-only text (Student Mode). */
  readOnly: boolean
  /**
   * Called whenever any controller configuration field changes.
   * Receives the complete updated ControllerConfig so App.tsx can replace the stored config atomically.
   */
  onChange?: (nodeId: string, config: ControllerConfig) => void
}

/**
 * Menu-driven smart-controller configuration panel.
 *
 * Manages a local copy of the ControllerConfig and calls onChange whenever the
 * author commits a change (immediately for selects; on blur for text/number inputs).
 */
export function ControllerPanel({
  controllerConfig,
  nodeId,
  readOnly,
  onChange
}: ControllerPanelProps) {
  // Merge incoming config with defaults so every field always has a valid value.
  const [cfg, setCfg] = useState<ControllerConfig>({
    ...DEFAULT_CONTROLLER_CONFIG,
    ...controllerConfig
  })

  // Re-sync local state when the selected device changes or its config is updated externally.
  useEffect(() => {
    setCfg({ ...DEFAULT_CONTROLLER_CONFIG, ...controllerConfig })
  }, [nodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Switches the controller kind and resets to that kind's field defaults. */
  function handleKindChange(kind: ControllerKind): void {
    const next: ControllerConfig = { kind, ...KIND_DEFAULTS[kind] }
    setCfg(next)
    onChange?.(nodeId, next)
  }

  /** Commits the current local config immediately (used by selects). */
  function commitNow(next: ControllerConfig): void {
    setCfg(next)
    onChange?.(nodeId, next)
  }

  /** Commits the current local config on blur — used by all numeric inputs. */
  function commit(): void {
    onChange?.(nodeId, cfg)
  }

  const kindLabel = KIND_OPTIONS.find(o => o.value === cfg.kind)?.label ?? cfg.kind

  return (
    <section className="prop-section">
      <div className="prop-section-title">Controller Configuration</div>

      {/* Kind — Pump / Valve / VFD / Actuator / Wellhead Controller */}
      <div className="prop-row">
        <span className="prop-label">Kind</span>
        {readOnly ? (
          <span className="prop-value">{kindLabel}</span>
        ) : (
          <select
            className="rtu-select"
            value={cfg.kind}
            onChange={e => handleKindChange(e.target.value as ControllerKind)}
          >
            {KIND_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* ── pump fields ──────────────────────────────────────────────────── */}
      {cfg.kind === 'pump' && (
        <>
          <div className="prop-row">
            <span className="prop-label">Rated Flow</span>
            {readOnly ? (
              <span className="prop-value">{cfg.ratedFlowLpm} L/min</span>
            ) : (
              <input
                className="prop-input prop-input-mono"
                type="number"
                min={0}
                value={cfg.ratedFlowLpm ?? 0}
                onChange={e =>
                  setCfg(prev => ({ ...prev, ratedFlowLpm: Number(e.target.value) || 0 }))
                }
                onBlur={commit}
              />
            )}
          </div>
          <div className="prop-row">
            <span className="prop-label">Motor Power</span>
            {readOnly ? (
              <span className="prop-value">{cfg.motorPowerKw} kW</span>
            ) : (
              <input
                className="prop-input prop-input-mono"
                type="number"
                min={0}
                value={cfg.motorPowerKw ?? 0}
                onChange={e =>
                  setCfg(prev => ({ ...prev, motorPowerKw: Number(e.target.value) || 0 }))
                }
                onBlur={commit}
              />
            )}
          </div>
        </>
      )}

      {/* ── valve fields ─────────────────────────────────────────────────── */}
      {cfg.kind === 'valve' && (
        <>
          <div className="prop-row">
            <span className="prop-label">Actuator Type</span>
            {readOnly ? (
              <span className="prop-value">{cfg.actuatorType}</span>
            ) : (
              <select
                className="rtu-select"
                value={cfg.actuatorType ?? 'electric'}
                onChange={e =>
                  commitNow({
                    ...cfg,
                    actuatorType: e.target.value as ControllerConfig['actuatorType']
                  })
                }
              >
                {ACTUATOR_TYPE_OPTIONS.map(v => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="prop-row">
            <span className="prop-label">Fail Position</span>
            {readOnly ? (
              <span className="prop-value">{cfg.failPosition}</span>
            ) : (
              <select
                className="rtu-select"
                value={cfg.failPosition ?? 'closed'}
                onChange={e =>
                  commitNow({
                    ...cfg,
                    failPosition: e.target.value as ControllerConfig['failPosition']
                  })
                }
              >
                {FAIL_POSITION_OPTIONS.map(v => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </div>
        </>
      )}

      {/* ── vfd fields ───────────────────────────────────────────────────── */}
      {cfg.kind === 'vfd' && (
        <div className="prop-row">
          <span className="prop-label">Max Frequency</span>
          {readOnly ? (
            <span className="prop-value">{cfg.maxFrequencyHz} Hz</span>
          ) : (
            <input
              className="prop-input prop-input-mono"
              type="number"
              min={0}
              value={cfg.maxFrequencyHz ?? 0}
              onChange={e =>
                setCfg(prev => ({ ...prev, maxFrequencyHz: Number(e.target.value) || 0 }))
              }
              onBlur={commit}
            />
          )}
        </div>
      )}

      {/* ── actuator fields ──────────────────────────────────────────────── */}
      {cfg.kind === 'actuator' && (
        <>
          <div className="prop-row">
            <span className="prop-label">Travel Type</span>
            {readOnly ? (
              <span className="prop-value">{cfg.travelType}</span>
            ) : (
              <select
                className="rtu-select"
                value={cfg.travelType ?? 'linear'}
                onChange={e =>
                  commitNow({
                    ...cfg,
                    travelType: e.target.value as ControllerConfig['travelType']
                  })
                }
              >
                {TRAVEL_TYPE_OPTIONS.map(v => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="prop-row">
            <span className="prop-label">Signal Type</span>
            {readOnly ? (
              <span className="prop-value">{cfg.signalType}</span>
            ) : (
              <select
                className="rtu-select"
                value={cfg.signalType ?? '4-20mA'}
                onChange={e =>
                  commitNow({
                    ...cfg,
                    signalType: e.target.value as ControllerConfig['signalType']
                  })
                }
              >
                {SIGNAL_TYPE_OPTIONS.map(v => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </div>
        </>
      )}

      {/* ── wellhead-controller fields ───────────────────────────────────── */}
      {cfg.kind === 'wellhead-controller' && (
        <>
          <div className="prop-row">
            <span className="prop-label">Choke Position</span>
            {readOnly ? (
              <span className="prop-value">{cfg.chokePositionPercent}%</span>
            ) : (
              <input
                className="prop-input prop-input-mono"
                type="number"
                min={0}
                max={100}
                value={cfg.chokePositionPercent ?? 0}
                onChange={e =>
                  setCfg(prev => ({
                    ...prev,
                    chokePositionPercent: Number(e.target.value) || 0
                  }))
                }
                onBlur={commit}
              />
            )}
          </div>
          <div className="prop-row">
            <span className="prop-label">Downhole Pressure SP</span>
            {readOnly ? (
              <span className="prop-value">{cfg.downholePressureSetpointBar} bar</span>
            ) : (
              <input
                className="prop-input prop-input-mono"
                type="number"
                min={0}
                value={cfg.downholePressureSetpointBar ?? 0}
                onChange={e =>
                  setCfg(prev => ({
                    ...prev,
                    downholePressureSetpointBar: Number(e.target.value) || 0
                  }))
                }
                onBlur={commit}
              />
            )}
          </div>
          <div className="prop-row">
            <span className="prop-label">Lift Method</span>
            {readOnly ? (
              <span className="prop-value">{cfg.liftMethod}</span>
            ) : (
              <select
                className="rtu-select"
                value={cfg.liftMethod ?? 'natural'}
                onChange={e =>
                  commitNow({
                    ...cfg,
                    liftMethod: e.target.value as ControllerConfig['liftMethod']
                  })
                }
              >
                {LIFT_METHOD_OPTIONS.map(v => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </div>
        </>
      )}
    </section>
  )
}
