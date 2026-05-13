import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type Edge
} from '@xyflow/react'
import type { Protocol } from '@ics-sim/schema'

export type ProtocolEdgeData = {
  protocol: Protocol
  label?: string
}

export type ProtocolEdgeType = Edge<ProtocolEdgeData, 'protocolEdge'>

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
  const displayLabel = data?.label ?? protocol

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? '#e6edf3' : color,
          strokeWidth: selected ? 2 : 1.5,
          opacity: protocol === 'none' ? 0.4 : 1
        }}
      />
      {protocol !== 'none' && (
        <EdgeLabelRenderer>
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
