/**
 * ProtocolEdge.tsx — React Flow custom edge for ICS protocol connections.
 *
 * Edges on the SCADA canvas represent communication links between devices.
 * Each edge carries a Protocol tag (e.g., "modbus-tcp", "dnp3", "opc-ua") which
 * is rendered as:
 *   - A colored Bezier curve whose hue indicates the protocol family
 *   - A floating label chip at the midpoint showing the protocol name
 *
 * Protocol color coding (practitioners use these colors in real P&ID diagrams):
 *   Modbus variants  — teal  (#39d0b0) — matches OT zone color
 *   DNP3             — blue  (#388bfd) — matches IT zone color
 *   OPC UA           — amber (#d29922) — matches DMZ zone color
 *   BACnet           — green (#7ee787) — HVAC/building automation
 *   EtherNet/IP      — purple (#ce93d8) — Rockwell/Allen-Bradley
 *   IEC 61850        — pink  (#f48fb1) — substation automation
 *   none             — gray  (#484f58) — logical/unlabeled connection
 *
 * When selected, the edge strokes to white so it stands out against the colored
 * zone backgrounds regardless of which protocol color is assigned.
 *
 * The label is rendered via React Flow's EdgeLabelRenderer into a portal that
 * sits above the SVG layer — this allows HTML styling (border, padding, font)
 * rather than trying to style text inside SVG.
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type Edge
} from '@xyflow/react'
import type { Protocol } from '@ics-sim/schema'

/**
 * Data payload carried by each ProtocolEdge in the React Flow edge graph.
 * `label` is optional — when absent, the protocol name is shown as the label.
 */
export type ProtocolEdgeData = {
  /** The ICS protocol this connection uses. */
  protocol: Protocol
  /** Optional override label (e.g., "Control Loop 1"). Defaults to protocol name. */
  label?: string
}

/** Typed React Flow edge shape for use with useEdgesState and EdgeTypes. */
export type ProtocolEdgeType = Edge<ProtocolEdgeData, 'protocolEdge'>

/**
 * Maps each Protocol to its accent color for the edge stroke and label border.
 * Uses Partial<Record> because future Protocol values may not have a color yet;
 * the component falls back to gray (#484f58) for unmapped protocols.
 */
const PROTOCOL_COLORS: Partial<Record<Protocol, string>> = {
  'modbus-tcp': '#39d0b0',
  'modbus-rtu': '#39d0b0',
  'modbus-ascii': '#39d0b0',
  dnp3: '#388bfd',
  'opc-ua': '#d29922',
  bacnet: '#7ee787',
  'ethernet-ip': '#ce93d8',
  iec61850: '#f48fb1',
  none: '#484f58'
}

/**
 * Renders a protocol-colored Bezier edge with a floating protocol label.
 *
 * Uses React Flow's `getBezierPath` to compute the SVG path data and label
 * center point. The edge itself is rendered via `BaseEdge` (an SVG <path>),
 * while the label uses `EdgeLabelRenderer` to place an HTML div via CSS transform.
 *
 * The `none` protocol renders at reduced opacity and hides its label — it
 * represents a logical or unlabeled connection (e.g., network infrastructure).
 */
export function ProtocolEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected
}: EdgeProps<ProtocolEdgeType>) {
  // Compute the SVG path string and the midpoint coordinates for the label
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })

  const protocol = data?.protocol ?? 'none'
  const color = PROTOCOL_COLORS[protocol] ?? '#484f58'
  // Show custom label if provided; otherwise show the protocol name as the label
  const displayLabel = data?.label ?? protocol

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          // White stroke when selected so the edge is visible against any background
          stroke: selected ? '#e6edf3' : color,
          strokeWidth: selected ? 2 : 1.5,
          // Dim unlabeled/none connections so they don't compete with protocol-labeled edges
          opacity: protocol === 'none' ? 0.4 : 1
        }}
      />
      {/* Only show the label chip for edges with a meaningful protocol */}
      {protocol !== 'none' && (
        <EdgeLabelRenderer>
          {/*
           * CSS transform positions the label at the edge midpoint (labelX, labelY).
           * translate(-50%, -50%) centers the div on that point, then the translate(Xpx, Ypx)
           * moves it to the computed position. This is the standard React Flow pattern
           * for HTML edge labels.
           */}
          <div
            className="protocol-edge-label"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: color,
              color
            }}
          >
            {displayLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
