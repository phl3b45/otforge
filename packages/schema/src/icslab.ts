// .icslab scenario file format — the canonical exchange format for ICS Simulator scenarios.
// All four layers are present in unlocked scenarios. Locked scenarios omit visual/security
// layer details to prevent topology extraction by students.

export type Sector = 'oil-gas' | 'power-electric' | 'water-treatment' | 'automotive' | 'generic'

export type Protocol =
  | 'modbus-tcp'
  | 'modbus-rtu'
  | 'modbus-ascii'
  | 'dnp3'
  | 'opc-ua'
  | 'bacnet'
  | 'ethernet-ip'
  | 'iec61850'
  | 'none'

export type NetworkZone = 'ot' | 'it' | 'dmz' | 'external'

export type DeviceCategory =
  | 'plc'
  | 'rtu'
  | 'ied'
  | 'hmi'
  | 'historian'
  | 'sensor'
  | 'actuator'
  | 'pump'
  | 'valve'
  | 'flow-meter'
  | 'pressure-transmitter'
  | 'firewall'
  | 'ids-ips'
  | 'switch'
  | 'router'
  | 'attack-machine'

// ── Visual layer ─────────────────────────────────────────────────────────────

export interface CanvasPosition {
  x: number
  y: number
}

export interface CanvasNode {
  id: string
  type: string          // matches DeviceTypeDefinition.id
  position: CanvasPosition
  data: {
    label: string
    zone: NetworkZone
  }
}

export interface CanvasEdge {
  id: string
  source: string        // node id
  target: string        // node id
  data: {
    protocol: Protocol
    label?: string
  }
}

export interface VisualLayer {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport: {
    x: number
    y: number
    zoom: number
  }
}

// ── Network layer ─────────────────────────────────────────────────────────────

export interface NetworkSegment {
  zone: NetworkZone
  subnet: string        // e.g. "172.20.10.0/24"
  gateway: string       // e.g. "172.20.10.1"
  dockerNetwork: string // e.g. "ics-sim-ot-net"
}

export interface StaticRoute {
  destination: string
  gateway: string
  via: NetworkZone      // which segment the route is on
}

export interface NetworkLayer {
  segments: NetworkSegment[]
  routes: StaticRoute[]
}

// ── Device layer ──────────────────────────────────────────────────────────────

export interface ModbusConfig {
  mode: 'tcp' | 'rtu' | 'ascii'
  port: number
  unitId: number
  registers: {
    coils?: Record<string, number>       // address → initial value (0/1)
    discreteInputs?: Record<string, number>
    holdingRegisters?: Record<string, number>
    inputRegisters?: Record<string, number>
  }
}

export interface DNP3Config {
  masterAddress: number
  outstationAddress: number
  port: number
}

export interface OpcUaConfig {
  port: number
  namespace: string
  nodes: Array<{ nodeId: string; name: string; dataType: string; value: unknown }>
}

export interface PLCProgramConfig {
  language: 'ladder' | 'st'
  source: string        // base64-encoded .st source file
  variables: Array<{
    name: string
    type: string
    address: string     // IEC 61131-3 address e.g. %IX0.0
    protocol: Protocol
    protocolAddress: string
  }>
}

export interface DeviceConfig {
  nodeId: string        // matches CanvasNode.id
  category: DeviceCategory
  ipAddress: string
  protocols: Protocol[]
  modbus?: ModbusConfig
  dnp3?: DNP3Config
  opcua?: OpcUaConfig
  plcProgram?: PLCProgramConfig
  dockerImage?: string  // override default image for this device type
}

export interface DeviceLayer {
  devices: Record<string, DeviceConfig>  // keyed by nodeId
}

// ── Security layer ─────────────────────────────────────────────────────────────

export type ACLAction = 'allow' | 'deny'

export interface ACLRule {
  id: string
  sourceZone: NetworkZone | 'any'
  destinationZone: NetworkZone | 'any'
  protocol: 'tcp' | 'udp' | 'icmp' | 'any'
  destinationPort: number | 'any'
  action: ACLAction
  comment?: string
}

export interface IDSConfig {
  enabledRulesets: string[]             // e.g. ["emerging-scada", "emerging-modbus"]
  disabledRuleIds: number[]             // individual Suricata SID overrides
  zeekScripts: string[]                 // e.g. ["modbus.zeek", "dnp3.zeek"]
}

export interface SecurityLayer {
  defaultFirewallPolicy: ACLAction      // default-deny or default-allow
  firewallRules: ACLRule[]
  ids: IDSConfig
  logging: {
    retentionDays: number
    influxdbEnabled: boolean
    lokiEnabled: boolean
  }
}

// ── Device type registry ───────────────────────────────────────────────────────

export interface DeviceTypeDefinition {
  id: string                           // unique key e.g. "plc-siemens-s7"
  category: DeviceCategory
  label: string                        // display name e.g. "Siemens S7-300 PLC"
  iconPath: string                     // relative path to SVG icon
  defaultProtocols: Protocol[]
  defaultDockerImage: string           // GHCR image reference
  defaultPorts: number[]
  configSchema: string                 // JSON Schema for DeviceConfig validation
  sector?: Sector                      // null = available in all sectors
}

// ── Scenario pack attack layer ─────────────────────────────────────────────────

export interface DockerLayer {
  image: string                        // GHCR image e.g. "ghcr.io/ics-sim/attack-oilgas:1.0"
  extendsImage: string                 // base image this FROM-extends
  description: string
}

// ── Resource estimation ────────────────────────────────────────────────────────

export interface ResourceEstimate {
  estimatedRamMb: number
  estimatedCpuCores: number
  containerCount: number
}

// ── Root .icslab document ──────────────────────────────────────────────────────

export interface ICSLabMeta {
  formatVersion: '1.0'
  name: string
  description: string
  sector: Sector
  author: string
  createdAt: string                    // ISO 8601
  updatedAt: string
  appVersion: string                   // minimum ICS Simulator version required
  locked: boolean
  brief: string                        // Markdown — mission objectives shown in Student mode
  requirements: ResourceEstimate
}

export interface ICSLabScenario {
  meta: ICSLabMeta
  visual: VisualLayer                  // omitted in locked export
  network: NetworkLayer
  devices: DeviceLayer
  security: SecurityLayer              // omitted in locked export
  registry: DeviceTypeDefinition[]     // pack-supplied device type extensions
  packLayers: DockerLayer[]            // attack tool layers from scenario pack
}
