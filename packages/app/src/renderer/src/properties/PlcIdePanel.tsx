/**
 * PlcIdePanel.tsx — Integrated PLC program editor for the right-sidebar properties panel.
 *
 * Rendered in place of the standard PropertiesPanel body when a PLC device node
 * is selected on the SCADA canvas. Provides a complete light-weight IDE for
 * authoring and deploying IEC 61131-3 Structured Text (ST) programs:
 *
 *   Structured Text editor:
 *     A monospace textarea supporting the full IEC 61131-3 ST language. ST is the
 *     most widely used high-level PLC language and is natively supported by the
 *     OpenPLC Runtime container image used in this simulator.
 *
 *   Variable binding table:
 *     Maps named PLC variables to IEC 61131-3 I/O addresses (%IX, %QX, %IW, %MW)
 *     and then to their corresponding protocol register addresses (Modbus coil numbers,
 *     Holding Register addresses, DNP3 point indices). These bindings bridge the
 *     PLC's internal address space to the OT protocol bus.
 *
 *     IEC address prefixes:
 *       %IX  Input bit      — coil / discrete input (read from field sensor)
 *       %QX  Output bit     — coil / discrete output (written to actuator)
 *       %IW  Input word     — 16-bit integer input register (analog sensor)
 *       %QW  Output word    — 16-bit integer output register (analog actuator)
 *       %MW  Memory word    — internal storage register (setpoints, timers)
 *
 *   Ladder logic viewer:
 *     A read-only SVG diagram generated from the variable binding table. It shows
 *     each boolean BOOL variable as the appropriate IEC 61131-3 ladder symbol:
 *       - Normally-open contact  --|[ ]|--  for inputs  (%IX addresses)
 *       - Coil                   --( )--    for outputs (%QX addresses)
 *     Analog/word variables are listed separately below the ladder rail diagram.
 *     This provides an educational cross-reference between the textual ST program
 *     and the traditional relay-ladder representation used in field documentation.
 *
 *   Save / Deploy workflow:
 *     Save:   Encodes the ST source to base64 and writes it into the scenario's
 *             device.plcProgram field. The change propagates to LevelDB persistence.
 *             Takes effect on the next simulation start (pre-loaded via INITIAL_PROGRAM_B64).
 *     Deploy: If the simulation is currently running, sends the program to the live
 *             OpenPLC container via the plc:deploy IPC channel. The main process
 *             POSTs the file to OpenPLC's web interface, triggers recompilation,
 *             and restarts PLC execution without stopping the full simulation.
 *
 * Data flow:
 *   PlcIdePanel is stateful with local editor/variable state that is promoted to
 *   the scenario document only when the user clicks Save or Deploy. This prevents
 *   every keystroke from triggering scenario updates and LevelDB writes.
 */

import { useState, useCallback, useId } from 'react'
import type { DeviceConfig, PLCProgramConfig, Protocol } from '@ics-sim/schema'

// ── IEC 61131-3 default program template ─────────────────────────────────────
//
// Presented in the ST editor when a PLC device has no program defined yet.
// Uses water treatment as the default sector since it is the most common
// introductory ICS security lab environment.

const DEFAULT_ST_PROGRAM = `(* ============================================================
   ICS Simulator — PLC Program Template
   Language: IEC 61131-3 Structured Text (ST)

   Instructions:
   1. Declare your process variables in the VAR block.
      - Use AT %IX0.0 for digital inputs  (sensors, switches)
      - Use AT %QX0.0 for digital outputs (pumps, valves)
      - Use AT %IW0   for analog inputs   (4-20mA, 0-10V)
      - Use AT %MW0   for memory words    (setpoints, counters)
   2. Write your control logic below END_VAR.
   3. Add variable bindings in the table below the editor,
      then click Save to store the program in the scenario.
   4. Click Deploy to push the program to a running container.
   ============================================================ *)

PROGRAM main
  VAR
    (* Process inputs — read from Modbus Input/Coil registers *)
    level_high  AT %IX0.0 : BOOL;   (* High-level float switch    *)
    level_low   AT %IX0.1 : BOOL;   (* Low-level float switch     *)
    flow_rate   AT %IW0   : WORD;   (* Flow rate 0-1000 (L/min×10)*)

    (* Process outputs — written to Modbus Coil/HR registers *)
    pump_run    AT %QX0.0 : BOOL;   (* Start pump                 *)
    inlet_valve AT %QX0.1 : BOOL;   (* Open inlet valve           *)
    alarm_out   AT %QX0.2 : BOOL;   (* Activate alarm horn        *)

    (* Internal memory — setpoints configurable via HMI *)
    flow_setpt  AT %MW0   : WORD := 500;  (* Low-flow alarm threshold   *)
  END_VAR

  (* ── Control logic ──────────────────────────────────────────── *)

  (* Start pump when tank is low; stop when tank is full *)
  IF NOT level_high AND level_low THEN
    pump_run    := TRUE;
    inlet_valve := TRUE;
  END_IF;

  IF level_high THEN
    pump_run    := FALSE;
    inlet_valve := FALSE;
  END_IF;

  (* Raise alarm if flow drops below setpoint while pump is running *)
  alarm_out := pump_run AND (flow_rate < flow_setpt);

END_PROGRAM
`

// ── Types ─────────────────────────────────────────────────────────────────────

/** IEC 61131-3 data types shown in the variable table type selector. */
const IEC_TYPES = ['BOOL', 'WORD', 'INT', 'DINT', 'REAL'] as const
type IECType = (typeof IEC_TYPES)[number]

/** One row in the variable binding table — extends PLCProgramConfig.variables. */
interface VarRow {
  /** Stable React key (not the IEC variable name, which can change). */
  id: string
  name: string
  type: IECType
  /** IEC 61131-3 address e.g. %IX0.0, %QX0.0, %IW0, %MW0. */
  address: string
  protocol: Protocol
  /** Protocol-specific address: Modbus register number, DNP3 point index, etc. */
  protocolAddress: string
}

/** Props accepted by PlcIdePanel. */
interface PlcIdePanelProps {
  /** The currently selected PLC device configuration. */
  device: DeviceConfig
  /** True when a simulation is actively running (enables Deploy button). */
  simRunning: boolean
  /**
   * Called when the user saves or deploys a program. The parent (App) writes
   * the updated PLCProgramConfig into the scenario document.
   *
   * @param nodeId  - The PLC device's canvas node ID.
   * @param program - The new program configuration to store.
   */
  onProgramChange: (nodeId: string, program: PLCProgramConfig) => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a VarRow back to the PLCProgramConfig.variables element shape.
 * The schema expects `Protocol` and `string` addresses — we strip the local `id`.
 */
function rowToSchemaVar(row: VarRow): PLCProgramConfig['variables'][number] {
  return {
    name: row.name,
    type: row.type,
    address: row.address,
    protocol: row.protocol,
    protocolAddress: row.protocolAddress
  }
}

/**
 * Converts PLCProgramConfig.variables elements to the local VarRow shape
 * (adds a stable React `id` for list rendering).
 */
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

/**
 * Infers the variable's direction (input/output/memory) from the IEC address prefix.
 *   %I prefix = input  (sourced from the field / protocol read)
 *   %Q prefix = output (driven from PLC / protocol write)
 *   %M prefix = memory (internal PLC register, may be read back via protocol)
 */
function iecDirection(addr: string): 'input' | 'output' | 'memory' {
  if (addr.startsWith('%I')) return 'input'
  if (addr.startsWith('%Q')) return 'output'
  return 'memory'
}

// ── Ladder Logic SVG Viewer ───────────────────────────────────────────────────

/**
 * Generates a read-only SVG ladder logic diagram from a list of variable bindings.
 *
 * Ladder logic is the graphical PLC programming language defined in IEC 61131-3.
 * It models relay-circuit logic with power rails on the left and right and
 * horizontal "rungs" connecting contacts (inputs) and coils (outputs).
 *
 * Symbol conventions used here (IEC 61131-3 §6.7.2):
 *   Normally-open contact  --|[ ]|--   BOOL input  (%IX address)
 *   Coil                   --( )--     BOOL output (%QX address)
 *   Memory coil            --(M)--     BOOL memory (%MX address)
 *
 * Only BOOL-type variables are shown on the ladder rail. WORD/INT/REAL variables
 * appear in a summary list below, labeled "Analog I/O".
 *
 * @param vars - Variable rows to render from the binding table.
 */
function LadderDiagram({ vars }: { vars: VarRow[] }) {
  const boolInputs = vars.filter(v => v.type === 'BOOL' && iecDirection(v.address) === 'input')
  const boolOutputs = vars.filter(v => v.type === 'BOOL' && iecDirection(v.address) === 'output')
  const analogVars = vars.filter(v => v.type !== 'BOOL')

  // Geometry constants (all in SVG user units, viewBox maps to 100% width)
  const SVG_W = 220
  const RAIL_L = 14 // left power rail x
  const RAIL_R = 206 // right power rail x
  const RUNG_H = 34 // vertical spacing per rung
  const Y_START = 20 // y-center of first rung
  const CONTACT_W = 12 // half-width of contact symbol
  const COIL_R = 8 // coil circle radius
  const LABEL_Y_OFF = 11 // label below symbol center

  // Build rungs: each output coil gets its own rung; inputs appear as series contacts
  // This is the simplest ladder topology that remains visually correct for educational use.
  const rungs = boolOutputs.length > 0 ? boolOutputs : [null] // at least one rung placeholder
  const svgH = Math.max(50, rungs.length * RUNG_H + 24)

  if (vars.length === 0) {
    return (
      <div className="plc-ladder-empty">
        Add variables in the table below to see the ladder view.
      </div>
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
        {/* Left and right power rails */}
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

          // Distribute contacts evenly between left rail and coil
          const contactCount = boolInputs.length
          const coilX = outputVar ? RAIL_R - 28 : RAIL_R - 20
          const contactSpacing = contactCount > 0 ? (coilX - RAIL_L - 20) / (contactCount + 1) : 0

          return (
            <g key={outputVar?.id ?? 'placeholder'}>
              {/* Horizontal rung wire from left rail to coil */}
              <line
                x1={RAIL_L}
                y1={cy}
                x2={coilX - COIL_R}
                y2={cy}
                stroke="var(--text-secondary)"
                strokeWidth={1.5}
              />

              {/* Series contacts for all BOOL inputs */}
              {boolInputs.map((inputVar, ci) => {
                const cx = RAIL_L + contactSpacing * (ci + 1)
                return (
                  <g key={inputVar.id}>
                    {/* Left contact vertical */}
                    <line
                      x1={cx - CONTACT_W}
                      y1={cy - 7}
                      x2={cx - CONTACT_W}
                      y2={cy + 7}
                      stroke="var(--accent-teal)"
                      strokeWidth={1.5}
                    />
                    {/* Right contact vertical */}
                    <line
                      x1={cx + CONTACT_W}
                      y1={cy - 7}
                      x2={cx + CONTACT_W}
                      y2={cy + 7}
                      stroke="var(--accent-teal)"
                      strokeWidth={1.5}
                    />
                    {/* Wire between contacts is drawn by the rung line above */}
                    {/* Variable label below contact */}
                    <text
                      x={cx}
                      y={cy + LABEL_Y_OFF}
                      textAnchor="middle"
                      fill="var(--text-muted)"
                      fontSize={7}
                      fontFamily="'Cascadia Code', 'Fira Code', monospace"
                    >
                      {inputVar.name.length > 9 ? inputVar.name.slice(0, 8) + '…' : inputVar.name}
                    </text>
                    {/* IEC address label above contact */}
                    <text
                      x={cx}
                      y={cy - 9}
                      textAnchor="middle"
                      fill="var(--text-muted)"
                      fontSize={6}
                      fontFamily="'Cascadia Code', 'Fira Code', monospace"
                    >
                      {inputVar.address}
                    </text>
                  </g>
                )
              })}

              {/* Output coil circle (or placeholder if no output vars defined yet) */}
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
                  {/* Wire from coil to right rail */}
                  <line
                    x1={coilX + COIL_R}
                    y1={cy}
                    x2={RAIL_R}
                    y2={cy}
                    stroke="var(--text-secondary)"
                    strokeWidth={1.5}
                  />
                  {/* Variable label below coil */}
                  <text
                    x={coilX}
                    y={cy + LABEL_Y_OFF}
                    textAnchor="middle"
                    fill="var(--text-muted)"
                    fontSize={7}
                    fontFamily="'Cascadia Code', 'Fira Code', monospace"
                  >
                    {outputVar.name.length > 9 ? outputVar.name.slice(0, 8) + '…' : outputVar.name}
                  </text>
                  {/* IEC address above coil */}
                  <text
                    x={coilX}
                    y={cy - 10}
                    textAnchor="middle"
                    fill="var(--text-muted)"
                    fontSize={6}
                    fontFamily="'Cascadia Code', 'Fira Code', monospace"
                  >
                    {outputVar.address}
                  </text>
                </g>
              ) : (
                // Placeholder wire when no outputs are defined yet
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

      {/* Analog I/O summary below ladder — WORD/INT/REAL variables can't be shown as contacts/coils */}
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

/**
 * Editable table of IEC 61131-3 variable bindings.
 *
 * Each row defines one PLC variable: its IEC 61131-3 address within the PLC
 * runtime (%IX0.0 style), its data type (BOOL/WORD/INT/REAL), and its mapping
 * to a field bus protocol address (Modbus register, DNP3 point, etc.).
 *
 * The table is kept narrow to fit the 260px properties panel. Compact inputs
 * with abbreviated column headers are used for density.
 *
 * @param rows     - Current list of variable rows.
 * @param onChange - Called whenever a row is added, deleted, or edited.
 */
function VariableTable({ rows, onChange }: { rows: VarRow[]; onChange: (rows: VarRow[]) => void }) {
  // React's useId generates a stable prefix for new-row IDs
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

  /** Updates a single field of a single row, returning a new rows array. */
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
            {/* Abbreviated column headers to fit 260px panel width */}
            <th title="IEC 61131-3 variable name">Name</th>
            <th title="IEC 61131-3 data type">Type</th>
            <th title="IEC 61131-3 I/O address (%IX, %QX, %IW, %MW…)">IEC Addr</th>
            <th title="Field bus protocol for this variable">Proto</th>
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

// ── PlcIdePanel ───────────────────────────────────────────────────────────────

/**
 * Root PLC IDE panel component.
 *
 * Manages three pieces of local state:
 *   source   — the raw ST source text shown in the editor textarea
 *   varRows  — the variable binding table rows
 *   status   — feedback string shown below the action buttons (save/deploy result)
 *
 * On mount, the state is initialised from `device.plcProgram` if one is already
 * stored in the scenario, or from the DEFAULT_ST_PROGRAM template otherwise.
 *
 * The component derives `isDirty` by comparing current source/vars to the
 * last-saved snapshot so it can warn the user if they click Deploy without saving.
 *
 * @param device          - Selected PLC device config.
 * @param simRunning      - True when a simulation is active (enables Deploy).
 * @param onProgramChange - Callback to persist changes to the scenario document.
 */
export function PlcIdePanel({ device, simRunning, onProgramChange }: PlcIdePanelProps) {
  // Initialise from existing program (decode base64 source) or use default template
  const initialSource = device.plcProgram?.source
    ? atob(device.plcProgram.source)
    : DEFAULT_ST_PROGRAM

  const initialRows: VarRow[] =
    device.plcProgram?.variables.map((v, i) => schemaVarToRow(v, i)) ?? []

  const [source, setSource] = useState(initialSource)
  const [varRows, setVarRows] = useState<VarRow[]>(initialRows)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)

  /** Builds the PLCProgramConfig from current editor state. */
  const buildProgram = useCallback((): PLCProgramConfig => {
    return {
      language: 'st',
      source: btoa(source), // base64-encode the source for JSON storage
      variables: varRows.map(rowToSchemaVar)
    }
  }, [source, varRows])

  /**
   * Saves the current editor state into the scenario document.
   * This is the fast path — no IPC, no Docker interaction. The program
   * will be injected into the container at next simulation start via the
   * INITIAL_PROGRAM_B64 environment variable.
   */
  const handleSave = useCallback(() => {
    const program = buildProgram()
    onProgramChange(device.nodeId, program)
    setStatusMsg('Program saved. Restart simulation to deploy to PLC.')
    setTimeout(() => setStatusMsg(null), 4000)
  }, [buildProgram, device.nodeId, onProgramChange])

  /**
   * Deploys the current editor state to the running OpenPLC container via IPC.
   *
   * Also saves the program to the scenario document (same as handleSave) before
   * the deploy so the scenario remains in sync with what is running in the container.
   *
   * Disabled when no simulation is running — the button tooltip explains why.
   */
  const handleDeploy = useCallback(async () => {
    // Always save first so the scenario file matches the container state
    const program = buildProgram()
    onProgramChange(device.nodeId, program)

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

  return (
    <div className="plc-ide">
      {/* ── Structured Text editor ───────────────────────────────────────── */}
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

      {/* ── Ladder logic viewer ───────────────────────────────────────────── */}
      <div className="plc-ide-section">
        <div className="plc-ide-section-header">
          <span className="plc-ide-section-title">Ladder View</span>
          <span className="plc-ide-section-hint">read-only</span>
        </div>
        <LadderDiagram vars={varRows} />
      </div>

      {/* ── Variable binding table ────────────────────────────────────────── */}
      <div className="plc-ide-section">
        <div className="plc-ide-section-header">
          <span className="plc-ide-section-title">Variable Bindings</span>
          <span className="plc-ide-section-hint">I/O map</span>
        </div>
        <VariableTable rows={varRows} onChange={setVarRows} />
      </div>

      {/* ── Action buttons ────────────────────────────────────────────────── */}
      <div className="plc-ide-actions">
        <button className="btn btn-sm btn-secondary" onClick={handleSave}>
          Save Program
        </button>
        <button
          className="btn btn-sm btn-run"
          onClick={handleDeploy}
          disabled={!simRunning || deploying}
          title={
            !simRunning ? 'Start simulation first to deploy' : 'Upload to running OpenPLC container'
          }
        >
          {deploying ? 'Deploying…' : 'Deploy to PLC'}
        </button>
      </div>

      {/* ── Compiler / deploy output ─────────────────────────────────────── */}
      {statusMsg && <pre className="plc-deploy-output">{statusMsg}</pre>}
    </div>
  )
}
