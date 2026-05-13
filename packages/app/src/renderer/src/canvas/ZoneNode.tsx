import { memo } from 'react'
import type { NodeProps, Node } from '@xyflow/react'
import type { NetworkZone } from '@ics-sim/schema'
import { ZONE_COLORS } from './DeviceNode'

export type ZoneNodeData = {
  zone: NetworkZone
  label: string
  subnet: string
  width: number
  height: number
}

export type ZoneNodeType = Node<ZoneNodeData, 'zoneNode'>

const ZONE_BG: Record<NetworkZone, string> = {
  ot: 'rgba(57, 208, 176, 0.06)',
  it: 'rgba(56, 139, 253, 0.06)',
  dmz: 'rgba(210, 153, 34, 0.06)',
  external: 'rgba(248, 81, 73, 0.06)'
}

export const ZoneNode = memo(function ZoneNode({ data }: NodeProps<ZoneNodeType>) {
  const color = ZONE_COLORS[data.zone]
  const bg = ZONE_BG[data.zone]

  return (
    <div
      className="zone-node"
      style={{
        width: data.width,
        height: data.height,
        borderColor: color,
        background: bg
      }}
    >
      <div className="zone-node-header" style={{ color }}>
        <span className="zone-node-name">{data.label}</span>
        <span className="zone-node-subnet">{data.subnet}</span>
      </div>
    </div>
  )
})
