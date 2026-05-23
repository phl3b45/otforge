/**
 * PipeEdge.tsx — P&ID process-pipe style edge for the OT Process canvas.
 *
 * Used exclusively on the OT layer tab where the canvas represents a physical
 * process diagram (P&ID). Key visual differences from ProtocolEdge:
 *
 *   - Orthogonal routing (getSmoothStepPath) instead of bezier — produces the
 *     right-angle bends characteristic of piping diagrams.
 *   - Thicker stroke (3 px vs 1.5 px) to suggest physical pipe weight.
 *   - Filled arrowhead at the target, indicating flow direction.
 *   - Same protocol color scheme as ProtocolEdge so users learn one legend
 *     that applies across both OT and IT layer canvases.
 *
 * Flow state animation (when coilSource is set and simulation is running):
 *   - flowActive === true  → bright green (#22c55e) animated dashes — fluid flowing
 *   - flowActive === false → red (#ef4444) solid stroke — flow stopped/blocked
 *   - flowActive undefined → default protocol color, no animation
 *
 * The `coilSource` field identifies which PLC coil drives this pipe's state.
 * ScadaCanvas polls coil states via the `modbus:readCoils` IPC channel and
 * sets `flowActive` on each edge before passing them to React Flow.
 *
 * Protocol color mapping (matches ProtocolEdge.tsx):
 *   modbus-tcp/rtu/ascii → #39d0b0  teal   (most common OT signal)
 *   dnp3                 → #388bfd  blue
 *   opc-ua               → #d29922  amber
 *   bacnet               → #7ee787  green
 *   ethernet-ip          → #ce93d8  purple
 *   iec61850             → #f48fb1  pink
 *   none                 → #484f58  gray   (hidden label, low opacity)
 */

import { type EdgeProps, getSmoothStepPath, EdgeLabelRenderer, BaseEdge } from '@xyflow/react'
import type { Protocol } from '@otforge/schema'

/** Pipe stroke color by protocol — matches ProtocolEdge color scheme. */
const PIPE_COLORS: Record<Protocol, string> = {
  'modbus-tcp': '#39d0b0',
  'modbus-rtu': '#39d0b0',
  'modbus-ascii': '#39d0b0',
  dnp3: '#388bfd',
  'opc-ua': '#d29922',
  bacnet: '#7ee787',
  'ethernet-ip': '#ce93d8',
  iec61850: '#f48fb1',
  s7comm: '#79b8ff', // Siemens S7comm — blue (Phase 10)
  'iec-104': '#e3b341', // IEC 60870-5-104 — gold (Phase 10)
  none: '#484f58'
}

/** Short display label for each protocol — same as ProtocolEdge. */
const PROTOCOL_LABELS: Partial<Record<Protocol, string>> = {
  'modbus-tcp': 'Modbus TCP',
  'modbus-rtu': 'Modbus RTU',
  'modbus-ascii': 'Modbus ASCII',
  dnp3: 'DNP3',
  'opc-ua': 'OPC-UA',
  bacnet: 'BACnet',
  'ethernet-ip': 'EtherNet/IP',
  iec61850: 'IEC 61850',
  s7comm: 'S7comm', // Phase 10
  'iec-104': 'IEC 104' // Phase 10
}

/** Bright green used when a coil-driven flow is active. */
const FLOW_ACTIVE_COLOR = '#22c55e'
/** Red used when a coil-driven flow is stopped or blocked. */
const FLOW_INACTIVE_COLOR = '#ef4444'

export interface PipeEdgeData {
  /** The ICS protocol carried by this pipe connection. */
  protocol: Protocol
  /** Optional label override — shown instead of the protocol name when set. */
  label?: string
  /**
   * Identifies which PLC coil state drives this pipe's flow animation.
   * When set, ScadaCanvas polls the coil at runtime and writes `flowActive`.
   * When absent, the edge uses the static protocol color with no animation.
   */
  coilSource?: {
    /** nodeId of the PLC device in the scenario device map. */
    nodeId: string
    /** Zero-based coil index (Modbus FC01 address). */
    coilIndex: number
  }
  /**
   * Computed by ScadaCanvas from live Modbus coil polling.
   *   true  → coil is ON  — render as green flowing animation
   *   false → coil is OFF — render as solid red (stopped)
   *   undefined → coilSource not set or simulation not running — use protocol color
   */
  flowActive?: boolean
}

/** React Flow typed edge record for PipeEdge. */
export type PipeEdgeType = {
  id: string
  source: string
  target: string
  type: 'pipeEdge'
  data: PipeEdgeData
  sourceHandle?: string | null
  targetHandle?: string | null
}

/**
 * PipeEdge — orthogonal P&ID pipe connector for the OT Process canvas.
 *
 * @param props - Standard React Flow EdgeProps with PipeEdgeData payload.
 */
export function PipeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected
}: EdgeProps) {
  const edgeData = data as unknown as PipeEdgeData
  const protocol = edgeData?.protocol ?? 'none'
  const isNone = protocol === 'none'
  const { flowActive, coilSource } = edgeData ?? {}

  // Flow state overrides the default protocol color when a coilSource is configured.
  // The three states give students immediate visual feedback about PLC coil changes:
  //   green + animated  = process is running (coil ON)
  //   red + static      = process stopped/blocked (coil OFF)
  //   protocol color    = no coil binding, normal network topology display
  let strokeColor: string
  let flowClass: string
  let strokeDasharray: string | undefined

  if (coilSource !== undefined) {
    if (flowActive === true) {
      strokeColor = FLOW_ACTIVE_COLOR
      flowClass = 'pipe-edge--active'
      strokeDasharray = '8 4'
    } else if (flowActive === false) {
      strokeColor = FLOW_INACTIVE_COLOR
      flowClass = 'pipe-edge--inactive'
      strokeDasharray = undefined
    } else {
      // coilSource set but simulation not running — show protocol color, no animation
      strokeColor = PIPE_COLORS[protocol] ?? '#484f58'
      flowClass = ''
      strokeDasharray = undefined
    }
  } else {
    strokeColor = PIPE_COLORS[protocol] ?? '#484f58'
    flowClass = ''
    strokeDasharray = isNone ? 'none' : undefined
  }

  // Orthogonal routing — getSmoothStepPath produces right-angle bends
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 6 // Slight radius on corners to soften the right angles
  })

  // Unique marker IDs so multiple edges don't share the same arrowhead definition.
  // Two markers per edge:
  //   markerId      — target-end arrowhead (flow arrives at destination)
  //   markerIdStart — source-end arrowhead (flow leaves source)
  // Both use orient="auto" so both tips point in the direction of flow.
  const markerId = `pipe-arrow-${id}`
  const markerIdStart = `pipe-arrow-start-${id}`

  const strokeWidth = 3
  const opacity = isNone ? 0.3 : selected ? 1 : 0.85
  const displayLabel = edgeData?.label ?? (isNone ? '' : (PROTOCOL_LABELS[protocol] ?? protocol))

  return (
    <>
      {/* SVG defs: arrowhead markers in the pipe color.
          Both triangles use the same geometry (M0,0 L0,6 L8,3) so tips point in
          the path direction. refX="6" for target end places the tip just past the
          endpoint to account for stroke width; refX="2" for source end anchors
          the base near the connection handle so the tip shoots forward into the pipe. */}
      <defs>
        {/* Source-end arrowhead — shows flow leaving the source node */}
        <marker
          id={markerIdStart}
          markerWidth="8"
          markerHeight="8"
          refX="2"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L8,3 z" fill={strokeColor} opacity={opacity} />
        </marker>
        {/* Target-end arrowhead — shows flow entering the destination node */}
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L8,3 z" fill={strokeColor} opacity={opacity} />
        </marker>
      </defs>

      {/* Pipe body using BaseEdge for React Flow's built-in interaction handling */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth,
          opacity,
          markerStart: `url(#${markerIdStart})`,
          markerEnd: `url(#${markerId})`,
          strokeDasharray
        }}
        className={`pipe-edge${isNone ? ' pipe-edge--none' : ''}${flowClass ? ` ${flowClass}` : ''}`}
      />

      {/* Protocol label chip — only shown for named protocols */}
      {!isNone && displayLabel && (
        <EdgeLabelRenderer>
          <div
            className={`pipe-edge-label${selected ? ' selected' : ''}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: strokeColor,
              color: strokeColor,
              pointerEvents: 'all'
            }}
          >
            {displayLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
