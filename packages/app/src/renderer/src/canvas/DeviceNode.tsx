import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { DeviceConfig, NetworkZone } from '@ics-sim/schema'
import { DeviceIcon } from '../icons/DeviceIcons'

export type DeviceNodeData = {
  device: DeviceConfig
  label: string
  zone: NetworkZone
}

export type DeviceNodeType = Node<DeviceNodeData, 'deviceNode'>

export const ZONE_COLORS: Record<NetworkZone, string> = {
  ot: '#39d0b0',
  it: '#388bfd',
  dmz: '#d29922',
  external: '#f85149'
}

export const DeviceNode = memo(function DeviceNode({ data, selected }: NodeProps<DeviceNodeType>) {
  const zoneColor = ZONE_COLORS[data.zone]

  return (
    <div
      className="device-node"
      style={{
        borderColor: selected ? '#e6edf3' : zoneColor,
        boxShadow: selected ? `0 0 0 2px ${zoneColor}` : 'none'
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: zoneColor, border: 'none', width: 8, height: 8 }}
      />

      <div className="device-node-icon" style={{ color: zoneColor }}>
        <DeviceIcon category={data.device.category} size={28} />
      </div>

      <div className="device-node-info">
        <div className="device-node-label">{data.label}</div>
        <div className="device-node-meta">{data.device.ipAddress}</div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: zoneColor, border: 'none', width: 8, height: 8 }}
      />
    </div>
  )
})
