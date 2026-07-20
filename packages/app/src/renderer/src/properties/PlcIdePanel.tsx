/**
 * PlcIdePanel.tsx — PLC program editor for IEC 61131-3 ST and Ladder Logic.
 *
 * Renders in two modes:
 *
 *   panel (modal=false, default)
 *     Compact single-column layout for the right-sidebar properties panel.
 *     Used as a fallback; the modal is the primary UX in this release.
 *
 *   modal (modal=true)
 *     Full-screen two-column IDE layout:
 *       Left column  — ST / Ladder tab pane (large code editor or ladder diagram)
 *       Right column — Variable binding table (always visible for cross-reference)
 *     Action bar spans the full width at the bottom.
 *
 * The variable binding table maps named PLC variables to IEC 61131-3 I/O
 * addresses (%IX, %QX, %IW, %MW) and then to protocol register addresses
 * (Modbus coil/HR, DNP3 point index). These bindings bridge the PLC's internal
 * address space to the OT field bus.
 *
 * Save / Deploy workflow:
 *   Save   — base64-encodes the ST source, writes to scenario.devices.devices[id].plcProgram.
 *             Survives app restart via LevelDB. Pre-loaded into the OpenPLC container as
 *             INITIAL_PROGRAM_B64 on next simulation start.
 *   Deploy — when simulation is running: POSTs the program to the live OpenPLC Runtime
 *             web API (/upload-program → /start_plc) without stopping the simulation.
 *
 * OpenPLC Runtime v3 is the target — it natively runs IEC 61131-3 ST programs
 * compiled by MATIEC to C++ and linked against its real-time scan-cycle engine.
 */

import { useState, useCallback, useId } from 'react'
import type {
  DeviceConfig,
  PLCProgramConfig,
  Protocol,
  ImportedRoutine,
  OTForgeScenario
} from '@otforge/schema'
import { buildAutoPlcProgram, toB64, fromB64 } from '@plc-gen'

// ── Types ─────────────────────────────────────────────────────────────────────

const IEC_TYPES = ['BOOL', 'WORD', 'INT', 'DINT', 'REAL'] as const
type IECType = (typeof IEC_TYPES)[number]

interface VarRow {
  id: string
  name: string
  type: IECType
  address: string
  protocol: Protocol
  protocolAddress: string
}

export interface PlcIdePanelProps {
  device: DeviceConfig
  /** Full scenario — used to seed edge-aware auto ST when no plcProgram is saved. */
  scenario: OTForgeScenario
  simRunning: boolean
  onProgramChange: (nodeId: string, program: PLCProgramConfig) => void
  /** When true, renders in the full-screen two-column IDE modal layout. */
  modal?: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToSchemaVar(row: VarRow): PLCProgramConfig['variables'][number] {
  return {
    name: row.name,
    type: row.type,
    address: row.address,
    protocol: row.protocol,
    protocolAddress: row.protocolAddress
  }
}

function schemaVarToRow(v: PLCProgramConfig['variables'][number], idx: number): VarRow {
  return {
    id: `var-${idx}-${v.name}`,
    name: v.name,
    type: (IEC_TYPES.includes(v.type as IECType) ? v.type : 'BOOL') as IECType,
    address: v.address,
    protocol: v.protocol,
    protocolAddress: v.protocolAddress
  }
}

function iecDirection(addr: string): 'input' | 'output' | 'memory' {
  if (addr.startsWith('%I')) return 'input'
  if (addr.startsWith('%Q')) return 'output'
  return 'memory'
}

// ── Ladder Logic SVG Viewer ───────────────────────────────────────────────────

/**
 * Read-only SVG ladder logic diagram generated from variable bindings.
 *
 * Symbol conventions (IEC 61131-3 §6.7.2):
 *   Normally-open contact  --|[ ]|--   BOOL input  (%IX)
 *   Coil                   --( )--     BOOL output (%QX)
 * WORD/INT/REAL variables appear in an "Analog I/O" summary below the rails.
 */
function LadderDiagram({ vars, large }: { vars: VarRow[]; large?: boolean }) {
  const boolInputs = vars.filter(v => v.type === 'BOOL' && iecDirection(v.address) === 'input')
  const boolOutputs = vars.filter(v => v.type === 'BOOL' && iecDirection(v.address) === 'output')
  const analogVars = vars.filter(v => v.type !== 'BOOL')

  const SVG_W = large ? 520 : 220
  const RAIL_L = large ? 24 : 14
  const RAIL_R = large ? 496 : 206
  const RUNG_H = large ? 50 : 34
  const Y_START = large ? 30 : 20
  const CONTACT_W = large ? 16 : 12
  const COIL_R = large ? 12 : 8
  const LABEL_Y_OFF = large ? 16 : 11
  const FONT_SM = large ? 9 : 7
  const FONT_XS = large ? 8 : 6

  const rungs = boolOutputs.length > 0 ? boolOutputs : [null]
  const svgH = Math.max(60, rungs.length * RUNG_H + (large ? 36 : 24))

  if (vars.length === 0) {
    return (
      <div className="plc-ladder-empty">Add variables in the table to see the ladder diagram.</div>
    )
  }

  return (
    <div className="plc-ladder-wrap">
      <svg
        viewBox={`0 0 ${SVG_W} ${svgH}`}
        width="100%"
        className="plc-ladder-svg"
        role="img"
        aria-label="Ladder logic diagram"
      >
        {/* Power rails */}
        <line
          x1={RAIL_L}
          y1={8}
          x2={RAIL_L}
          y2={svgH - 8}
          stroke="var(--text-muted)"
          strokeWidth={3}
        />
        <line
          x1={RAIL_R}
          y1={8}
          x2={RAIL_R}
          y2={svgH - 8}
          stroke="var(--text-muted)"
          strokeWidth={3}
        />

        {rungs.map((outputVar, rungIdx) => {
          const cy = Y_START + rungIdx * RUNG_H
          const contactCount = boolInputs.length
          const coilX = outputVar ? RAIL_R - COIL_R * 4 : RAIL_R - 20
          const contactSpacing = contactCount > 0 ? (coilX - RAIL_L - 20) / (contactCount + 1) : 0

          return (
            <g key={outputVar?.id ?? 'placeholder'}>
              {/* Rung wire */}
              <line
                x1={RAIL_L}
                y1={cy}
                x2={coilX - COIL_R}
                y2={cy}
                stroke="var(--text-secondary)"
                strokeWidth={1.5}
              />

              {/* Series contacts */}
              {boolInputs.map((inputVar, ci) => {
                const cx = RAIL_L + contactSpacing * (ci + 1)
                return (
                  <g key={inputVar.id}>
                    <line
                      x1={cx - CONTACT_W}
                      y1={cy - 7}
                      x2={cx - CONTACT_W}
                      y2={cy + 7}
                      stroke="var(--accent-teal)"
                      strokeWidth={1.5}
                    />
                    <line
                      x1={cx + CONTACT_W}
                      y1={cy - 7}
                      x2={cx + CONTACT_W}
                      y2={cy + 7}
                      stroke="var(--accent-teal)"
                      strokeWidth={1.5}
                    />
                    <text
                      x={cx}
                      y={cy + LABEL_Y_OFF}
                      textAnchor="middle"
                      fill="var(--text-muted)"
                      fontSize={FONT_SM}
                      fontFamily="'Cascadia Code','Fira Code',monospace"
                    >
                      {inputVar.name.length > 9 ? inputVar.name.slice(0, 8) + '…' : inputVar.name}
                    </text>
                    <text
                      x={cx}
                      y={cy - 9}
                      textAnchor="middle"
                      fill="var(--text-muted)"
                      fontSize={FONT_XS}
                      fontFamily="'Cascadia Code','Fira Code',monospace"
                    >
                      {inputVar.address}
                    </text>
                  </g>
                )
              })}

              {/* Coil or placeholder */}
              {outputVar ? (
                <g>
                  <circle
                    cx={coilX}
                    cy={cy}
                    r={COIL_R}
                    fill="none"
                    stroke="var(--accent-orange)"
                    strokeWidth={1.5}
                  />
                  <line
                    x1={coilX + COIL_R}
                    y1={cy}
                    x2={RAIL_R}
                    y2={cy}
                    stroke="var(--text-secondary)"
                    strokeWidth={1.5}
                  />
                  <text
                    x={coilX}
                    y={cy + LABEL_Y_OFF}
                    textAnchor="middle"
                    fill="var(--text-muted)"
                    fontSize={FONT_SM}
                    fontFamily="'Cascadia Code','Fira Code',monospace"
                  >
                    {outputVar.name.length > 9 ? outputVar.name.slice(0, 8) + '…' : outputVar.name}
                  </text>
                  <text
                    x={coilX}
                    y={cy - 10}
                    textAnchor="middle"
                    fill="var(--text-muted)"
                    fontSize={FONT_XS}
                    fontFamily="'Cascadia Code','Fira Code',monospace"
                  >
                    {outputVar.address}
                  </text>
                </g>
              ) : (
                <line
                  x1={RAIL_L + 10}
                  y1={cy}
                  x2={RAIL_R - 10}
                  y2={cy}
                  stroke="var(--text-muted)"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
              )}
            </g>
          )
        })}
      </svg>

      {analogVars.length > 0 && (
        <div className="plc-ladder-analog">
          <span className="plc-ladder-analog-label">Analog I/O:</span>
          {analogVars.map(v => (
            <span
              key={v.id}
              className="plc-ladder-analog-chip"
              title={`${v.address} → ${v.protocol}:${v.protocolAddress}`}
            >
              {v.name} <code>{v.address}</code>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Variable binding table ────────────────────────────────────────────────────

function VariableTable({ rows, onChange }: { rows: VarRow[]; onChange: (rows: VarRow[]) => void }) {
  const idPrefix = useId()

  const handleAdd = useCallback(() => {
    const newRow: VarRow = {
      id: `${idPrefix}-${Date.now()}`,
      name: `var${rows.length + 1}`,
      type: 'BOOL',
      address: `%IX${rows.length}.0`,
      protocol: 'modbus-tcp',
      protocolAddress: String(rows.length)
    }
    onChange([...rows, newRow])
  }, [rows, onChange, idPrefix])

  const handleDelete = useCallback(
    (id: string) => {
      onChange(rows.filter(r => r.id !== id))
    },
    [rows, onChange]
  )

  const handleChange = useCallback(
    (id: string, field: keyof Omit<VarRow, 'id'>, value: string) => {
      onChange(rows.map(r => (r.id === id ? { ...r, [field]: value } : r)))
    },
    [rows, onChange]
  )

  return (
    <div className="plc-var-table-wrap">
      <table className="plc-var-table">
        <thead>
          <tr>
            <th title="IEC 61131-3 variable name">Name</th>
            <th title="IEC 61131-3 data type">Type</th>
            <th title="IEC 61131-3 I/O address (%IX, %QX, %IW, %MW…)">IEC Addr</th>
            <th title="Field bus protocol">Proto</th>
            <th title="Protocol register / point address">Reg</th>
            <th aria-label="Delete row" />
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id}>
              <td>
                <input
                  className="plc-var-input"
                  value={row.name}
                  onChange={e => handleChange(row.id, 'name', e.target.value)}
                  aria-label="Variable name"
                />
              </td>
              <td>
                <select
                  className="plc-var-select"
                  value={row.type}
                  onChange={e => handleChange(row.id, 'type', e.target.value)}
                  aria-label="Variable type"
                >
                  {IEC_TYPES.map(t => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  className="plc-var-input plc-var-mono"
                  value={row.address}
                  onChange={e => handleChange(row.id, 'address', e.target.value)}
                  aria-label="IEC address"
                  placeholder="%IX0.0"
                />
              </td>
              <td>
                <select
                  className="plc-var-select"
                  value={row.protocol}
                  onChange={e => handleChange(row.id, 'protocol', e.target.value as Protocol)}
                  aria-label="Protocol"
                >
                  <option value="modbus-tcp">Modbus-TCP</option>
                  <option value="modbus-rtu">Modbus-RTU</option>
                  <option value="dnp3">DNP3</option>
                  <option value="opc-ua">OPC-UA</option>
                  <option value="none">none</option>
                </select>
              </td>
              <td>
                <input
                  className="plc-var-input plc-var-mono"
                  value={row.protocolAddress}
                  onChange={e => handleChange(row.id, 'protocolAddress', e.target.value)}
                  aria-label="Protocol address"
                  placeholder="0"
                />
              </td>
              <td>
                <button
                  className="plc-var-del"
                  onClick={() => handleDelete(row.id)}
                  aria-label={`Delete variable ${row.name}`}
                  title="Delete variable"
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="plc-var-add btn btn-sm btn-ghost" onClick={handleAdd}>
        + Add variable
      </button>
    </div>
  )
}

// ── Routine picker modal ──────────────────────────────────────────────────────

/**
 * Modal dialog shown when a PLC project file contains multiple Structured Text
 * routines (common in multi-routine L5X files from Logix Designer).
 *
 * Displays each routine's name, source format badge, variable count, and any
 * parse warnings. The user clicks "Load" to apply one routine to the editor;
 * Cancel closes the modal without changing the current program.
 *
 * @param routines  - Routines extracted from the parsed PLC file.
 * @param fileName  - Source file base name shown in the modal header.
 * @param onSelect  - Called with the chosen routine when the user clicks Load.
 * @param onClose   - Called when the user dismisses the modal without selecting.
 */
function RoutinePickerModal({
  routines,
  fileName,
  onSelect,
  onClose
}: {
  routines: ImportedRoutine[]
  fileName: string
  onSelect: (routine: ImportedRoutine) => void
  onClose: () => void
}) {
  /** Human-readable label for each source format code. */
  function formatLabel(fmt: string): string {
    if (fmt === 'l5x-st') return 'Logix ST'
    if (fmt === 'plcopen-st') return 'PLCopen ST'
    return 'ST'
  }

  return (
    <div
      className="modal-overlay routine-picker-overlay"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-panel routine-picker-modal">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title">
            <span className="modal-title-icon">📂</span>
            Select Routine to Import
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close routine picker">
            ×
          </button>
        </div>

        {/* File name context */}
        <div className="routine-picker-source">
          Source file: <span className="routine-picker-filename">{fileName}</span> —{' '}
          {routines.length} routine{routines.length !== 1 ? 's' : ''} found
        </div>

        {/* Routine list */}
        <div className="routine-picker-list modal-body">
          {routines.map(routine => (
            <div key={routine.name} className="routine-picker-row">
              <div className="routine-picker-info">
                <div className="routine-picker-name">
                  {routine.name}
                  <span className="routine-picker-format-badge">
                    {formatLabel(routine.sourceFormat)}
                  </span>
                </div>
                <div className="routine-picker-meta">
                  {routine.variables.length} variable{routine.variables.length !== 1 ? 's' : ''}
                  {routine.warnings.length > 0 && (
                    <span className="routine-picker-warn" title={routine.warnings.join('\n')}>
                      ⚠ {routine.warnings.length} warning{routine.warnings.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                {/* Show first warning inline so users can quickly decide */}
                {routine.warnings.length > 0 && (
                  <div className="routine-picker-warn-text">{routine.warnings[0]}</div>
                )}
              </div>
              <button className="btn btn-sm btn-primary" onClick={() => onSelect(routine)}>
                Load
              </button>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── PlcIdePanel ───────────────────────────────────────────────────────────────

/**
 * PLC IDE panel — renders in either compact sidebar mode or full-screen modal mode.
 *
 * Local state:
 *   source    — raw ST source in the editor textarea
 *   varRows   — variable binding table rows
 *   statusMsg — feedback from save operations
 *   importing — true while the native file-picker + parse operation is in flight
 */
export function PlcIdePanel({
  device,
  scenario,
  simRunning,
  onProgramChange,
  modal = false
}: PlcIdePanelProps) {
  const auto = !device.plcProgram?.source ? buildAutoPlcProgram(scenario, device.nodeId) : null
  const initialSource = device.plcProgram?.source
    ? fromB64(device.plcProgram.source)
    : fromB64(auto!.source)
  const initialRows: VarRow[] = (
    device.plcProgram?.variables?.length ? device.plcProgram.variables : (auto?.variables ?? [])
  ).map((v, i) => schemaVarToRow(v, i))

  const [source, setSource] = useState(initialSource)
  const [varRows, setVarRows] = useState<VarRow[]>(initialRows)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)

  /** True while the native file picker + parse operation is in flight. */
  const [importing, setImporting] = useState(false)
  /**
   * Routines returned by a successful parse of a multi-routine file.
   * Non-null triggers the RoutinePickerModal. Cleared after selection or cancel.
   */
  const [importPickerRoutines, setImportPickerRoutines] = useState<ImportedRoutine[] | null>(null)
  /** Base file name of the last imported file — shown in the picker modal header. */
  const [importPickerFileName, setImportPickerFileName] = useState<string>('')

  const buildProgram = useCallback(
    (): PLCProgramConfig => ({
      language: 'st',
      source: toB64(source),
      variables: varRows.map(rowToSchemaVar)
    }),
    [source, varRows]
  )

  const handleSave = useCallback(() => {
    try {
      onProgramChange(device.nodeId, buildProgram())
      setStatusMsg('Program saved. Restart simulation to deploy to PLC.')
      setTimeout(() => setStatusMsg(null), 4000)
    } catch (err) {
      setStatusMsg(`Save failed: ${(err as Error).message}`)
    }
  }, [buildProgram, device.nodeId, onProgramChange])

  const handleOpenWebUI = useCallback(() => {
    window.electronAPI.plc.openWebUI(device.nodeId)
  }, [device.nodeId])

  const handleDeploy = useCallback(async () => {
    onProgramChange(device.nodeId, buildProgram())
    setDeploying(true)
    setStatusMsg('Compiling and deploying…')
    try {
      const result = await window.electronAPI.plc.deploy(device.nodeId, source)
      if (result.ok) {
        setStatusMsg(result.output ? `Deployed.\n${result.output}` : 'Deployed successfully.')
      } else {
        setStatusMsg(`Deploy failed: ${result.error ?? 'unknown error'}`)
      }
    } catch (err) {
      setStatusMsg(`Deploy error: ${(err as Error).message}`)
    } finally {
      setDeploying(false)
    }
  }, [buildProgram, device.nodeId, onProgramChange, source])

  /**
   * Loads a routine from the picker into the ST editor and variable table.
   *
   * Converts ImportedVariable entries to VarRow objects. Because imported
   * variables don't carry protocol or protocolAddress information, they default
   * to modbus-tcp with auto-incremented addresses (0, 1, 2…). The user can
   * change these in the variable table before deploying.
   *
   * After applying, switches to the ST tab so the user can immediately see
   * the loaded source code.
   */
  const applyImportedRoutine = useCallback(
    (routine: ImportedRoutine) => {
      setSource(routine.source)
      setVarRows(
        routine.variables.map((v, i) => ({
          id: `import-${i}-${v.name}`,
          name: v.name,
          type: ((['BOOL', 'WORD', 'INT', 'DINT', 'REAL'] as string[]).includes(v.type)
            ? v.type
            : 'DINT') as VarRow['type'],
          address: v.address || `%MW${i}`,
          protocol: 'modbus-tcp' as Protocol,
          protocolAddress: String(i)
        }))
      )
      setImportPickerRoutines(null)
      const warnNote =
        routine.warnings.length > 0
          ? `\n${routine.warnings.length} warning(s) — check variable table.`
          : ''
      setStatusMsg(
        `Imported "${routine.name}" from ${importPickerFileName}.${warnNote} Review bindings then Save.`
      )
      setTimeout(() => setStatusMsg(null), 8000)
    },
    [importPickerFileName]
  )

  /**
   * Opens the native file picker for PLC project files and parses the selection.
   *
   * On success: if one routine is found it is loaded immediately; if multiple
   * routines are found the RoutinePickerModal is shown. On failure (including
   * user cancellation) a status message is shown briefly.
   */
  const handleImport = useCallback(async () => {
    setImporting(true)
    setStatusMsg(null)
    try {
      const result = await window.electronAPI.plc.importProgram()
      if (!result.ok) {
        // 'Import cancelled' is a normal user action — show no error for that case
        if (result.error && result.error !== 'Import cancelled') {
          setStatusMsg(`Import failed: ${result.error}`)
          setTimeout(() => setStatusMsg(null), 6000)
        }
        return
      }

      const routines = result.routines ?? []
      const fileName = result.fileName ?? 'unknown'
      setImportPickerFileName(fileName)

      if (routines.length === 0) {
        setStatusMsg('No importable routines found in the selected file.')
        setTimeout(() => setStatusMsg(null), 5000)
        return
      }

      if (routines.length === 1) {
        // Single routine — apply directly, no picker needed
        applyImportedRoutine(routines[0])
      } else {
        // Multiple routines — show the picker modal
        setImportPickerRoutines(routines)
      }
    } catch (err) {
      setStatusMsg(`Import error: ${(err as Error).message}`)
      setTimeout(() => setStatusMsg(null), 6000)
    } finally {
      setImporting(false)
    }
  }, [applyImportedRoutine])

  // ── Save Program modal layout ────────────────────────────────────────────────
  //
  // Single-column sheet: ST textarea on top, variable bindings below, Save +
  // Import buttons at the bottom. Deploy and Ladder are intentionally absent —
  // students write, compile, and deploy directly in the OpenPLC web IDE at
  // localhost:18080. This modal only exists to persist the ST source and I/O
  // bindings to the scenario JSON so they survive simulation restarts.
  if (modal) {
    return (
      <>
        {/* Routine picker — shown when an imported file contains multiple routines */}
        {importPickerRoutines && (
          <RoutinePickerModal
            routines={importPickerRoutines}
            fileName={importPickerFileName}
            onSelect={applyImportedRoutine}
            onClose={() => setImportPickerRoutines(null)}
          />
        )}

        <div className="plc-save-body">
          {/* ST editor — fills the top portion of the modal */}
          <div className="plc-save-editor-section">
            <div className="plc-ide-section-header plc-ide-section-header-modal">
              <span className="plc-ide-section-title">Structured Text Program</span>
              <span className="plc-ide-section-hint">
                IEC 61131-3 ST · saved to scenario file on Save
              </span>
            </div>
            <textarea
              className="plc-st-editor plc-save-editor"
              value={source}
              onChange={e => setSource(e.target.value)}
              spellCheck={false}
              aria-label="Structured Text program source"
            />
          </div>

          {/* Variable bindings — fixed-height scrollable section below the editor */}
          <div className="plc-save-vars-section">
            <div className="plc-ide-section-header plc-ide-section-header-modal">
              <span className="plc-ide-section-title">Variable Bindings</span>
              <span className="plc-ide-section-hint">IEC address ↔ protocol register map</span>
            </div>
            <div className="plc-save-vars-scroll">
              <VariableTable rows={varRows} onChange={setVarRows} />
            </div>
          </div>

          {/* Action bar */}
          <div className="plc-ide-actions plc-save-actions">
            <button
              className="btn btn-sm btn-ghost plc-import-btn"
              onClick={handleImport}
              disabled={importing}
              title="Import ST from a PLC project file (.l5x, .xml, .st, .scl)"
            >
              {importing ? 'Importing…' : '↑ Import Program'}
            </button>
            <button className="btn btn-secondary" onClick={handleSave}>
              Save Program
            </button>
          </div>

          {statusMsg && <pre className="plc-deploy-output">{statusMsg}</pre>}

          <div className="plc-ide-runtime-info">
            <span className="plc-ide-runtime-badge">OpenPLC Runtime v3</span>
            <span>IEC 61131-3 · MATIEC compiler · {device.nodeId}</span>
          </div>
        </div>
      </>
    )
  }

  // ── Compact sidebar layout (default) ─────────────────────────────────────────
  return (
    <div className="plc-ide">
      <div className="plc-ide-section">
        <div className="plc-ide-section-header">
          <span className="plc-ide-section-title">Structured Text</span>
          <span className="plc-ide-section-hint">IEC 61131-3 ST</span>
        </div>
        <textarea
          className="plc-st-editor"
          value={source}
          onChange={e => setSource(e.target.value)}
          spellCheck={false}
          aria-label="Structured Text program source"
          rows={12}
        />
      </div>

      <div className="plc-ide-section">
        <div className="plc-ide-section-header">
          <span className="plc-ide-section-title">Ladder View</span>
          <span className="plc-ide-section-hint">read-only</span>
        </div>
        <LadderDiagram vars={varRows} />
      </div>

      <div className="plc-ide-section">
        <div className="plc-ide-section-header">
          <span className="plc-ide-section-title">Variable Bindings</span>
          <span className="plc-ide-section-hint">I/O map</span>
        </div>
        <VariableTable rows={varRows} onChange={setVarRows} />
      </div>

      <div className="plc-ide-actions">
        <button
          className="btn btn-sm btn-ghost plc-import-btn"
          onClick={handleImport}
          disabled={importing}
          title="Import ST program from a PLC project file (.l5x, .xml, .st, .scl)"
        >
          {importing ? 'Importing…' : '↑ Import'}
        </button>
        <button className="btn btn-sm btn-secondary" onClick={handleSave}>
          Save
        </button>
        <button
          className="btn btn-sm btn-ghost plc-openui-btn"
          onClick={handleOpenWebUI}
          disabled={!simRunning}
          title={
            simRunning
              ? 'Open OpenPLC web IDE in browser — Ladder Logic, monitoring (openplc / openplc)'
              : 'Start simulation first'
          }
        >
          OpenPLC ↗
        </button>
        <button
          className="btn btn-sm btn-run"
          onClick={handleDeploy}
          disabled={!simRunning || deploying}
          title={
            !simRunning ? 'Start simulation first to deploy' : 'Upload to running OpenPLC container'
          }
        >
          {deploying ? 'Deploying…' : 'Deploy'}
        </button>
      </div>

      {statusMsg && <pre className="plc-deploy-output">{statusMsg}</pre>}

      {/* Routine picker modal — shown when a multi-routine file is imported in sidebar mode */}
      {importPickerRoutines && (
        <RoutinePickerModal
          routines={importPickerRoutines}
          fileName={importPickerFileName}
          onSelect={applyImportedRoutine}
          onClose={() => setImportPickerRoutines(null)}
        />
      )}
    </div>
  )
}
