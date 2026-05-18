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
 *   - When the simulation is running, a stroke-dasharray animation (CSS) gives
 *     the impression of fluid/signal moving through the pipe.
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
import type { Protocol } from '@ics-sim/schema'

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

export interface PipeEdgeData {
  /** The ICS protocol carried by this pipe connection. */
  protocol: Protocol
  /** Optional label override — shown instead of the protocol name when set. */
  label?: string
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
  const color = PIPE_COLORS[protocol] ?? '#484f58'
  const isNone = protocol === 'none'

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

  // Unique marker ID so multiple edges don't share the same arrowhead color
  const markerId = `pipe-arrow-${id}`

  const strokeWidth = 3
  const opacity = isNone ? 0.3 : selected ? 1 : 0.85
  const displayLabel = edgeData?.label ?? (isNone ? '' : (PROTOCOL_LABELS[protocol] ?? protocol))

  return (
    <>
      {/* SVG defs: arrowhead marker in the pipe color */}
      <defs>
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L8,3 z" fill={color} opacity={opacity} />
        </marker>
      </defs>

      {/* Pipe body using BaseEdge for React Flow's built-in interaction handling */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth,
          opacity,
          markerEnd: `url(#${markerId})`,
          // CSS animation class applied via data attribute; the actual keyframe
          // is defined in index.css and only triggers when .simulation-running
          // class is present on a parent element (added by App.tsx when running).
          strokeDasharray: isNone ? 'none' : undefined
        }}
        className={`pipe-edge${isNone ? ' pipe-edge--none' : ''}`}
      />

      {/* Protocol label chip — only shown for named protocols */}
      {!isNone && displayLabel && (
        <EdgeLabelRenderer>
          <div
            className={`pipe-edge-label${selected ? ' selected' : ''}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: color,
              color,
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
