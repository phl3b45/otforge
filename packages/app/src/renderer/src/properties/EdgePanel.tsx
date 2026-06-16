/**
 * EdgePanel.tsx — Properties inspector for selected pipe edges on the OT canvas.
 *
 * Shown in the right sidebar when a PipeEdge is selected in Author Mode.
 * Exposes four editable fields:
 *   - label       — free-text annotation shown on the edge midpoint
 *   - fluidType   — substance flowing through the pipe (drives animated icons)
 *   - coilSource  — binds the edge flow animation to a PLC coil (FC01 poll)
 *                   nodeId: scenario device ID of the PLC
 *                   coilIndex: zero-based Modbus coil address
 *
 * Read-only display fields (set at connection-creation time):
 *   - protocol    — ICS/OT or IT protocol for the connection
 *   - cableType   — physical medium (Cat5e, RS-485, fiber, etc.)
 *
 * The fluidType dropdown drives the animated fluid icons in PipeEdge.tsx:
 *   electric  — yellow lightning bolt (power lines, electrical feeds)
 *   water     — blue teardrop (process water, cooling water, condensate)
 *   gas       — gray cloud (natural gas, steam, pneumatic air)
 *   oil       — dark teardrop (crude oil, refined product, hydraulic fluid)
 *   chemical  — green teardrop (process chemicals, reagents, solvents)
 *   none      — legacy green-dash animation (backwards-compatible default)
 *
 * The coilSource binding tells the canvas runtime to poll the PLC at nodeId
 * using FC01 ReadCoils at coilIndex. When the coil is ON, the flow animation
 * plays; when OFF, the edge turns red (stopped). This lets Lab scenarios tie
 * physical pump/valve state to the pipe animation without hard-coding logic.
 */

import { useState, useEffect } from 'react'
import type { FluidType, Protocol, CableType } from '@otforge/schema'

/** Human-readable labels shown in the dropdown and as read-only chips. */
const FLUID_LABELS: Record<FluidType, string> = {
  none: 'None (default animation)',
  electric: 'Electric',
  water: 'Water',
  gas: 'Gas / Steam / Air',
  oil: 'Oil / Hydraulic',
  chemical: 'Chemical'
}

/** Short display labels for protocol — mirrors PipeEdge and ProtocolEdge. */
const PROTOCOL_LABELS: Partial<Record<Protocol, string>> = {
  'modbus-tcp': 'Modbus TCP',
  'modbus-rtu': 'Modbus RTU',
  'modbus-ascii': 'Modbus ASCII',
  dnp3: 'DNP3',
  'opc-ua': 'OPC-UA',
  bacnet: 'BACnet',
  'ethernet-ip': 'EtherNet/IP',
  iec61850: 'IEC 61850',
  s7comm: 'S7comm',
  'iec-104': 'IEC 104',
  mqtt: 'MQTT'
}

/** Short display labels for cable type — mirrors PipeEdge. */
const CABLE_LABELS: Record<CableType, string> = {
  cat5e: 'Cat5e',
  cat6: 'Cat6',
  cat6a: 'Cat6a',
  smf: 'SMF Fiber',
  mmf: 'MMF Fiber',
  wifi: 'Wi-Fi',
  rs232: 'RS-232',
  rs485: 'RS-485',
  sata: 'SATA',
  ac: 'AC Pwr',
  dc: 'DC Pwr'
}

export interface SelectedEdgeInfo {
  /** React Flow edge ID. */
  edgeId: string
  /** Protocol assigned at connection creation. */
  protocol: Protocol
  /** Optional author-assigned label shown on the edge. */
  label?: string
  /** Optional cable type set at connection creation. */
  cableType?: CableType
  /**
   * Full coil binding when present — polls PLC FC01 at runtime to drive
   * the flow animation. null / undefined means no binding.
   */
  coilSource?: {
    /** Scenario device ID of the PLC to poll (e.g. "plc_1"). */
    nodeId: string
    /** Zero-based Modbus coil address (FC01 ReadCoils). */
    coilIndex: number
  }
  /** Current fluid type — undefined means the field was never set (treat as 'none'). */
  fluidType?: FluidType
}

interface EdgePanelProps {
  /** The currently selected pipe edge. */
  edge: SelectedEdgeInfo
  /**
   * Called when the author changes the fluid type.
   * App.tsx applies the change to scenario.visual.edges.
   */
  onFluidTypeChange: (edgeId: string, fluidType: FluidType) => void
  /**
   * Called when the author edits the edge label.
   * Passing an empty string removes the label from the scenario.
   */
  onLabelChange: (edgeId: string, label: string) => void
  /**
   * Called when the author changes the coil binding.
   * Passing null removes the binding (no coil → animation always off).
   */
  onCoilSourceChange: (
    edgeId: string,
    coilSource: { nodeId: string; coilIndex: number } | null
  ) => void
}

/**
 * Renders the pipe edge property inspector.
 *
 * Local state for label and coilSource is synced with the edge prop when
 * the selected edge changes (edgeId changes). Changes commit on blur.
 *
 * @param edge                - Selected edge data.
 * @param onFluidTypeChange   - Fires immediately on fluid select change.
 * @param onLabelChange       - Fires on label input blur.
 * @param onCoilSourceChange  - Fires on nodeId or coilIndex input blur when both are valid.
 */
export function EdgePanel({
  edge,
  onFluidTypeChange,
  onLabelChange,
  onCoilSourceChange
}: EdgePanelProps) {
  const currentFluid: FluidType = edge.fluidType ?? 'none'
  const protocolLabel =
    edge.protocol === 'none' ? 'None' : (PROTOCOL_LABELS[edge.protocol] ?? edge.protocol)

  /* ---------- local controlled state ---------- */

  /** Draft label — synced from edge.label when the selected edge changes. */
  const [labelDraft, setLabelDraft] = useState(edge.label ?? '')

  /** Draft coil nodeId — synced from edge.coilSource when the edge changes. */
  const [coilNodeId, setCoilNodeId] = useState(edge.coilSource?.nodeId ?? '')

  /** Draft coil index — synced from edge.coilSource when the edge changes. */
  const [coilIndex, setCoilIndex] = useState(
    edge.coilSource?.coilIndex !== undefined ? String(edge.coilSource.coilIndex) : ''
  )

  /** Re-sync local draft state whenever a different edge is selected. */
  useEffect(() => {
    setLabelDraft(edge.label ?? '')
    setCoilNodeId(edge.coilSource?.nodeId ?? '')
    setCoilIndex(edge.coilSource?.coilIndex !== undefined ? String(edge.coilSource.coilIndex) : '')
  }, [edge.edgeId]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- commit helpers ---------- */

  /** Persist label on blur — empty string removes the label from the scenario. */
  function commitLabel() {
    onLabelChange(edge.edgeId, labelDraft)
  }

  /**
   * Persist coil binding on blur.
   * If both nodeId and coilIndex are filled and coilIndex is a valid integer,
   * writes the binding. If both are empty, removes it. Mixed state is ignored
   * until the user fills or clears the other field.
   */
  function commitCoilSource() {
    const trimmedId = coilNodeId.trim()
    const parsedIndex = parseInt(coilIndex, 10)

    if (trimmedId === '' && coilIndex.trim() === '') {
      // Both empty — remove binding
      onCoilSourceChange(edge.edgeId, null)
    } else if (trimmedId !== '' && !Number.isNaN(parsedIndex) && parsedIndex >= 0) {
      // Both valid — save binding
      onCoilSourceChange(edge.edgeId, { nodeId: trimmedId, coilIndex: parsedIndex })
    }
    // Mixed / invalid — do nothing; let user keep editing
  }

  return (
    <aside className="properties-panel">
      {/* Header */}
      <div className="properties-header">
        {/* Pipe icon — horizontal line with arrowhead */}
        <svg width="22" height="22" viewBox="0 0 22 22" style={{ flexShrink: 0 }}>
          <line x1="2" y1="11" x2="17" y2="11" stroke="#39d0b0" strokeWidth="3" />
          <polygon points="17,8 22,11 17,14" fill="#39d0b0" />
        </svg>
        <div className="properties-title">
          <div className="properties-name">{edge.edgeId}</div>
          <div className="properties-type" style={{ color: '#39d0b0' }}>
            Pipe Connection
          </div>
        </div>
      </div>

      <div className="properties-body">
        {/* Read-only protocol / cable */}
        <section className="prop-section">
          <div className="prop-row">
            <span className="prop-label">Protocol</span>
            <span className="prop-value">{protocolLabel}</span>
          </div>
          {edge.cableType && (
            <div className="prop-row">
              <span className="prop-label">Cable</span>
              <span className="prop-value">{CABLE_LABELS[edge.cableType] ?? edge.cableType}</span>
            </div>
          )}
        </section>

        {/* Editable label */}
        <section className="prop-section">
          <div className="prop-section-title">Label</div>
          <div className="prop-row">
            <span className="prop-label">Text</span>
            <input
              className="prop-input"
              type="text"
              placeholder="e.g. Outlet Flow"
              value={labelDraft}
              onChange={e => setLabelDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={e => {
                if (e.key === 'Enter') commitLabel()
              }}
            />
          </div>
          <p className="prop-hint">Short description shown on the edge midpoint.</p>
        </section>

        {/* Fluid type — editable */}
        <section className="prop-section">
          <div className="prop-section-title">Fluid Type</div>
          <div className="prop-row">
            <span className="prop-label">Substance</span>
            <select
              className="prop-select"
              value={currentFluid}
              onChange={e => onFluidTypeChange(edge.edgeId, e.target.value as FluidType)}
            >
              {(Object.keys(FLUID_LABELS) as FluidType[]).map(ft => (
                <option key={ft} value={ft}>
                  {FLUID_LABELS[ft]}
                </option>
              ))}
            </select>
          </div>
          <p className="prop-hint">
            {currentFluid === 'none'
              ? 'Default animation — set a fluid type to show substance-specific icons.'
              : `${FLUID_LABELS[currentFluid]} icons travel along this pipe when flow is active.`}
          </p>
        </section>

        {/* Coil binding — editable */}
        <section className="prop-section">
          <div className="prop-section-title">Coil Binding</div>
          <p className="prop-hint" style={{ marginBottom: 8 }}>
            Links this pipe&apos;s flow animation to a PLC coil. When the coil is ON the pipe shows
            flowing substance; when OFF it turns red (stopped). Leave blank for always-on animation.
          </p>
          <div className="prop-row">
            <span className="prop-label">PLC Device ID</span>
            <input
              className="prop-input"
              type="text"
              placeholder="e.g. plc_1"
              value={coilNodeId}
              onChange={e => setCoilNodeId(e.target.value)}
              onBlur={commitCoilSource}
              onKeyDown={e => {
                if (e.key === 'Enter') commitCoilSource()
              }}
            />
          </div>
          <div className="prop-row">
            <span className="prop-label">Coil Address</span>
            <input
              className="prop-input"
              type="number"
              min={0}
              placeholder="e.g. 0"
              value={coilIndex}
              onChange={e => setCoilIndex(e.target.value)}
              onBlur={commitCoilSource}
              onKeyDown={e => {
                if (e.key === 'Enter') commitCoilSource()
              }}
            />
          </div>
          {edge.coilSource ? (
            <p className="prop-hint" style={{ color: '#39d0b0' }}>
              Bound to {edge.coilSource.nodeId} coil[{edge.coilSource.coilIndex}]
            </p>
          ) : (
            <p className="prop-hint">No coil binding — animation plays continuously.</p>
          )}
        </section>
      </div>
    </aside>
  )
}
