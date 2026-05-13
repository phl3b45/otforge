import type { DeviceCategory } from '@ics-sim/schema'

const S = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

function PlcSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="4" width="20" height="16" rx="1" />
      <line x1="6" y1="9" x2="18" y2="9" />
      <line x1="6" y1="12" x2="18" y2="12" />
      <line x1="6" y1="15" x2="18" y2="15" />
      <circle cx="5" cy="4" r="1" fill="currentColor" />
      <circle cx="19" cy="4" r="1" fill="currentColor" />
    </svg>
  )
}

function RtuSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="3" y="5" width="18" height="14" rx="1" />
      <circle cx="7.5" cy="12" r="2" />
      <line x1="12" y1="9" x2="19" y2="9" />
      <line x1="12" y1="12" x2="19" y2="12" />
      <line x1="12" y1="15" x2="19" y2="15" />
    </svg>
  )
}

function IedSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <polyline points="14,7 10,12 14,12 10,17" />
    </svg>
  )
}

function HmiSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="3" width="20" height="14" rx="1" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <rect x="5" y="6" width="10" height="6" rx="0.5" />
    </svg>
  )
}

function HistorianSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <line x1="4" y1="6" x2="4" y2="18" />
      <line x1="20" y1="6" x2="20" y2="18" />
      <ellipse cx="12" cy="18" rx="8" ry="3" />
      <path d="M4 12 Q12 15 20 12" />
    </svg>
  )
}

function SensorSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <line x1="12" y1="3" x2="12" y2="7" />
    </svg>
  )
}

function ActuatorSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <polygon points="12,2 22,12 12,22 2,12" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="9" y1="12" x2="15" y2="12" />
    </svg>
  )
}

function PumpSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M 9 8 A 5 5 0 1 0 15 8" strokeLinecap="round" />
      <polyline points="13,6 15,8 13,10" />
    </svg>
  )
}

function ValveSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <polygon points="2,5 12,12 2,19" />
      <polygon points="22,5 12,12 22,19" />
      <line x1="12" y1="2" x2="12" y2="22" />
    </svg>
  )
}

function FlowMeterSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <polyline points="8,8 12,4 16,8" />
    </svg>
  )
}

function PressureTransmitterSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M 8 16 Q 8 8 12 8 Q 16 8 16 16" />
      <line x1="12" y1="16" x2="12" y2="18" />
    </svg>
  )
}

function FirewallSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="4" width="9" height="5" />
      <rect x="13" y="4" width="9" height="5" />
      <rect x="2" y="10" width="12" height="5" />
      <rect x="16" y="10" width="6" height="5" />
      <rect x="2" y="16" width="7" height="4" />
      <rect x="11" y="16" width="11" height="4" />
    </svg>
  )
}

function IdsIpsSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M12 2 L20 6 L20 12 Q20 19 12 22 Q4 19 4 12 L4 6 Z" />
      <ellipse cx="12" cy="13" rx="4" ry="2.5" />
      <circle cx="12" cy="13" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

function SwitchSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="9" width="20" height="7" rx="1" />
      <line x1="6" y1="9" x2="6" y2="6" />
      <line x1="10" y1="9" x2="10" y2="6" />
      <line x1="14" y1="9" x2="14" y2="6" />
      <line x1="18" y1="9" x2="18" y2="6" />
      <circle cx="6" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="10" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="14" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

function RouterSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="2" x2="12" y2="7" />
      <line x1="12" y1="17" x2="12" y2="22" />
      <line x1="2" y1="12" x2="7" y2="12" />
      <line x1="17" y1="12" x2="22" y2="12" />
      <polyline points="10,4 12,2 14,4" />
      <polyline points="10,20 12,22 14,20" />
    </svg>
  )
}

function AttackMachineSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="3" width="20" height="14" rx="1" />
      <line x1="9" y1="21" x2="15" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <circle cx="12" cy="10" r="4" />
      <line x1="12" y1="6" x2="12" y2="3" />
      <line x1="12" y1="14" x2="12" y2="17" />
      <line x1="8" y1="10" x2="5" y2="10" />
      <line x1="16" y1="10" x2="19" y2="10" />
    </svg>
  )
}

const ICON_MAP: Record<DeviceCategory, () => JSX.Element> = {
  plc: PlcSvg,
  rtu: RtuSvg,
  ied: IedSvg,
  hmi: HmiSvg,
  historian: HistorianSvg,
  sensor: SensorSvg,
  actuator: ActuatorSvg,
  pump: PumpSvg,
  valve: ValveSvg,
  'flow-meter': FlowMeterSvg,
  'pressure-transmitter': PressureTransmitterSvg,
  firewall: FirewallSvg,
  'ids-ips': IdsIpsSvg,
  switch: SwitchSvg,
  router: RouterSvg,
  'attack-machine': AttackMachineSvg
}

export function DeviceIcon({
  category,
  size = 24,
  color = 'currentColor',
  className
}: {
  category: DeviceCategory
  size?: number
  color?: string
  className?: string
}) {
  const IconComponent = ICON_MAP[category]
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', width: size, height: size, color, flexShrink: 0 }}
    >
      <IconComponent />
    </span>
  )
}
