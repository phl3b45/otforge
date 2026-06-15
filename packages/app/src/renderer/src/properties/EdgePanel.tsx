/**
 * EdgePanel.tsx — Properties inspector for selected pipe edges on the OT canvas.
 *
 * Shown in the right sidebar when a PipeEdge is selected in Author Mode.
 * Currently exposes a single editable field: fluidType (the substance flowing
 * through the pipe). All other edge properties (protocol, cableType, coilSource)
 * are set at connection-creation time via the canvas context menu and are shown
 * here as read-only reference.
 *
 * The fluidType dropdown drives the animated fluid icons in PipeEdge.tsx:
 *   electric  — yellow lightning bolt (power lines, electrical feeds)
 *   water     — blue teardrop (process water, cooling water, condensate)
 *   gas       — gray cloud (natural gas, steam, pneumatic air)
 *   oil       — dark teardrop (crude oil, refined product, hydraulic fluid)
 *   chemical  — green teardrop (process chemicals, reagents, solvents)
 *   none      — legacy green-dash animation (backwards compatible default)
 */

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
  /** Optional author-assigned label. */
  label?: string
  /** Optional cable type set at connection creation. */
  cableType?: CableType
  /** Whether a coil binding exists for this edge. */
  hasCoilSource: boolean
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
}

/**
 * Renders the pipe edge property inspector.
 *
 * @param edge              - Selected edge data.
 * @param onFluidTypeChange - Callback invoked when fluidType dropdown changes.
 */
export function EdgePanel({ edge, onFluidTypeChange }: EdgePanelProps) {
  const currentFluid: FluidType = edge.fluidType ?? 'none'
  const protocolLabel =
    edge.protocol === 'none' ? 'None' : (PROTOCOL_LABELS[edge.protocol] ?? edge.protocol)

  return (
    <aside className="properties-panel">
      {/* Header */}
      <div className="properties-header">
        {/* Pipe icon — a simple horizontal line with arrowhead to represent an edge */}
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
        {/* Read-only edge identity */}
        <section className="prop-section">
          <div className="prop-row">
            <span className="prop-label">Protocol</span>
            <span className="prop-value">{protocolLabel}</span>
          </div>
          {edge.label && (
            <div className="prop-row">
              <span className="prop-label">Label</span>
              <span className="prop-value">{edge.label}</span>
            </div>
          )}
          {edge.cableType && (
            <div className="prop-row">
              <span className="prop-label">Cable</span>
              <span className="prop-value">{CABLE_LABELS[edge.cableType] ?? edge.cableType}</span>
            </div>
          )}
          <div className="prop-row">
            <span className="prop-label">Coil binding</span>
            <span className="prop-value">{edge.hasCoilSource ? 'Yes' : 'None'}</span>
          </div>
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
      </div>
    </aside>
  )
}
