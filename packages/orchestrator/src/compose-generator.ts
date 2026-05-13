import yaml from 'js-yaml'
import type { ICSLabScenario, DeviceCategory, NetworkZone } from '@ics-sim/schema'
import { ZONE_DEFAULTS } from './network-config'

// GHCR image references — all images built and pushed by .github/workflows/docker.yml
const DEVICE_IMAGES: Record<DeviceCategory, string> = {
  plc: 'ghcr.io/iburres/ics-sim-openplc:latest',
  rtu: 'ghcr.io/iburres/ics-sim-modbus:latest',
  ied: 'ghcr.io/iburres/ics-sim-dnp3:latest',
  hmi: 'frangoteam/fuxa:latest',
  historian: 'influxdb:1.8-alpine',
  sensor: 'ghcr.io/iburres/ics-sim-modbus:latest',
  actuator: 'ghcr.io/iburres/ics-sim-modbus:latest',
  pump: 'ghcr.io/iburres/ics-sim-modbus:latest',
  valve: 'ghcr.io/iburres/ics-sim-modbus:latest',
  'flow-meter': 'ghcr.io/iburres/ics-sim-modbus:latest',
  'pressure-transmitter': 'ghcr.io/iburres/ics-sim-modbus:latest',
  firewall: 'ghcr.io/iburres/ics-sim-firewall:latest',
  'ids-ips': 'ghcr.io/iburres/ics-sim-suricata:latest',
  switch: 'ghcr.io/iburres/ics-sim-switch:latest',
  router: 'ghcr.io/iburres/ics-sim-router:latest',
  'attack-machine': 'ghcr.io/iburres/ics-sim-attack-base:latest'
}

// Resource limits per device category (memory in MB, cpu as fraction of a core)
const DEVICE_LIMITS: Record<DeviceCategory, { memory: number; cpus: string }> = {
  plc: { memory: 128, cpus: '0.5' },
  rtu: { memory: 80, cpus: '0.25' },
  ied: { memory: 80, cpus: '0.25' },
  hmi: { memory: 256, cpus: '0.5' },
  historian: { memory: 256, cpus: '0.5' },
  sensor: { memory: 64, cpus: '0.15' },
  actuator: { memory: 64, cpus: '0.15' },
  pump: { memory: 64, cpus: '0.15' },
  valve: { memory: 64, cpus: '0.15' },
  'flow-meter': { memory: 64, cpus: '0.15' },
  'pressure-transmitter': { memory: 64, cpus: '0.15' },
  firewall: { memory: 32, cpus: '0.25' },
  'ids-ips': { memory: 256, cpus: '0.5' },
  switch: { memory: 32, cpus: '0.1' },
  router: { memory: 32, cpus: '0.1' },
  'attack-machine': { memory: 512, cpus: '1.0' }
}

interface ComposeService {
  image: string
  container_name: string
  restart: string
  networks: Record<string, { ipv4_address: string }>
  environment: string[] | undefined
  volumes: string[] | undefined
  cap_add: string[] | undefined
  deploy: { resources: { limits: { memory: string; cpus: string } } }
}

interface ComposeNetwork {
  driver: string
  driver_opts?: Record<string, string>
  ipam: { driver: string; config: Array<{ subnet: string; gateway: string }> }
}

interface ComposeFile {
  name: string
  services: Record<string, ComposeService>
  networks: Record<string, ComposeNetwork>
  volumes: Record<string, unknown> | undefined
}

export function generateCompose(scenario: ICSLabScenario, projectName: string): string {
  const services: Record<string, ComposeService> = {}
  const networks: Record<string, ComposeNetwork> = {}
  const volumes: Record<string, unknown> = {}

  // ── Docker networks from scenario segments ─────────────────────────────────
  const segmentByZone: Partial<Record<NetworkZone, { subnet: string; gateway: string }>> = {}

  for (const seg of scenario.network.segments) {
    const netName = `${seg.zone}-net`
    segmentByZone[seg.zone] = { subnet: seg.subnet, gateway: seg.gateway }
    networks[netName] = {
      driver: 'bridge',
      ipam: {
        driver: 'default',
        config: [{ subnet: seg.subnet, gateway: seg.gateway }]
      }
    }
  }

  // Fill in any missing zones with defaults
  const allZones: NetworkZone[] = ['ot', 'it', 'dmz', 'external']
  for (const zone of allZones) {
    if (!segmentByZone[zone]) {
      const netName = `${zone}-net`
      networks[netName] = {
        driver: 'bridge',
        ipam: {
          driver: 'default',
          config: [{ subnet: ZONE_DEFAULTS[zone].subnet, gateway: ZONE_DEFAULTS[zone].gateway }]
        }
      }
    }
  }

  // ── Device containers ──────────────────────────────────────────────────────
  for (const [nodeId, device] of Object.entries(scenario.devices.devices)) {
    const image = device.dockerImage ?? DEVICE_IMAGES[device.category]
    const limits = DEVICE_LIMITS[device.category]
    const serviceName = sanitizeServiceName(nodeId)

    // Find which zone this device belongs to by matching its IP to a segment subnet
    const zone = findZoneForIp(device.ipAddress, scenario) ?? 'ot'
    const netName = `${zone}-net`

    const env: string[] = buildDeviceEnv(device, scenario)

    services[serviceName] = {
      image,
      container_name: `${projectName}-${serviceName}`,
      restart: 'unless-stopped',
      networks: { [netName]: { ipv4_address: device.ipAddress } },
      environment: env.length > 0 ? env : undefined,
      volumes: undefined,
      cap_add: undefined,
      deploy: {
        resources: {
          limits: { memory: `${limits.memory}m`, cpus: limits.cpus }
        }
      }
    }

    // Firewall container needs NET_ADMIN to manage nftables
    if (device.category === 'firewall') {
      services[serviceName].cap_add = ['NET_ADMIN', 'NET_RAW']
      // Firewall bridges all internal zones — attach to ot, it, dmz
      services[serviceName].networks = {
        'ot-net': { ipv4_address: `${ZONE_DEFAULTS.ot.subnet.replace('.0/24', '.254')}` },
        'it-net': { ipv4_address: `${ZONE_DEFAULTS.it.subnet.replace('.0/24', '.254')}` },
        'dmz-net': { ipv4_address: `${ZONE_DEFAULTS.dmz.subnet.replace('.0/24', '.254')}` }
      }
    }

    // Attack machine only on external network
    if (device.category === 'attack-machine') {
      services[serviceName].networks = {
        'external-net': { ipv4_address: device.ipAddress }
      }
      services[serviceName].cap_add = ['NET_ADMIN', 'NET_RAW']
    }
  }

  // ── Fixed infrastructure services ─────────────────────────────────────────

  const otBase = ZONE_DEFAULTS.ot.subnet.replace('.0/24', '')
  const itBase = ZONE_DEFAULTS.it.subnet.replace('.0/24', '')

  // Suricata — inline IPS on OT and IT networks
  volumes[`${projectName}-suricata-logs`] = {}
  services['suricata'] = {
    image: 'ghcr.io/iburres/ics-sim-suricata:latest',
    container_name: `${projectName}-suricata`,
    restart: 'unless-stopped',
    networks: {
      'ot-net': { ipv4_address: `${otBase}.253` },
      'it-net': { ipv4_address: `${itBase}.253` }
    },
    environment: undefined,
    cap_add: ['NET_ADMIN', 'NET_RAW'],
    volumes: [`${projectName}-suricata-logs:/var/log/suricata`],
    deploy: { resources: { limits: { memory: '150m', cpus: '0.5' } } }
  }

  // Zeek — passive analysis tap on OT network
  volumes[`${projectName}-zeek-logs`] = {}
  services['zeek'] = {
    image: 'ghcr.io/iburres/ics-sim-zeek:latest',
    container_name: `${projectName}-zeek`,
    restart: 'unless-stopped',
    networks: { 'ot-net': { ipv4_address: `${otBase}.252` } },
    environment: undefined,
    cap_add: ['NET_ADMIN', 'NET_RAW'],
    volumes: [`${projectName}-zeek-logs:/var/log/zeek`],
    deploy: { resources: { limits: { memory: '150m', cpus: '0.5' } } }
  }

  // InfluxDB 1.8 — process historian (MIT licensed)
  volumes[`${projectName}-influxdb-data`] = {}
  services['influxdb'] = {
    image: 'influxdb:1.8-alpine',
    container_name: `${projectName}-influxdb`,
    restart: 'unless-stopped',
    networks: { 'it-net': { ipv4_address: `${itBase}.10` } },
    environment: [
      'INFLUXDB_DB=icslab',
      'INFLUXDB_ADMIN_USER=admin',
      'INFLUXDB_ADMIN_PASSWORD=icslab-admin',
      'INFLUXDB_HTTP_AUTH_ENABLED=false'
    ],
    cap_add: undefined,
    volumes: [`${projectName}-influxdb-data:/var/lib/influxdb`],
    deploy: { resources: { limits: { memory: '256m', cpus: '0.5' } } }
  }

  // Loki — log aggregation (pulled at runtime, AGPL compliant)
  volumes[`${projectName}-loki-data`] = {}
  services['loki'] = {
    image: 'grafana/loki:latest',
    container_name: `${projectName}-loki`,
    restart: 'unless-stopped',
    networks: { 'it-net': { ipv4_address: `${itBase}.11` } },
    environment: undefined,
    cap_add: undefined,
    volumes: [`${projectName}-loki-data:/loki`],
    deploy: { resources: { limits: { memory: '80m', cpus: '0.25' } } }
  }

  // Grafana — dashboards (pulled at runtime, AGPL compliant)
  volumes[`${projectName}-grafana-data`] = {}
  services['grafana'] = {
    image: 'grafana/grafana:latest',
    container_name: `${projectName}-grafana`,
    restart: 'unless-stopped',
    networks: { 'it-net': { ipv4_address: `${itBase}.12` } },
    environment: [
      'GF_SECURITY_ADMIN_USER=admin',
      'GF_SECURITY_ADMIN_PASSWORD=icslab',
      'GF_AUTH_ANONYMOUS_ENABLED=true',
      'GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer'
    ],
    cap_add: undefined,
    volumes: [`${projectName}-grafana-data:/var/lib/grafana`],
    deploy: { resources: { limits: { memory: '150m', cpus: '0.5' } } }
  }

  // FUXA — HMI (MIT licensed)
  volumes[`${projectName}-fuxa-data`] = {}
  services['fuxa'] = {
    image: 'frangoteam/fuxa:latest',
    container_name: `${projectName}-fuxa`,
    restart: 'unless-stopped',
    networks: { 'it-net': { ipv4_address: `${itBase}.13` } },
    environment: undefined,
    cap_add: undefined,
    volumes: [`${projectName}-fuxa-data:/usr/src/app/FUXA/server/_appdata`],
    deploy: { resources: { limits: { memory: '100m', cpus: '0.25' } } }
  }

  const compose: ComposeFile = {
    name: projectName,
    services,
    networks,
    volumes: Object.keys(volumes).length > 0 ? volumes : undefined
  }

  return yaml.dump(compose, { lineWidth: 120, noRefs: true })
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sanitizeServiceName(nodeId: string): string {
  return nodeId.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

function findZoneForIp(ip: string, scenario: ICSLabScenario): NetworkZone | null {
  for (const seg of scenario.network.segments) {
    if (ipInSubnet(ip, seg.subnet)) return seg.zone
  }
  return null
}

function ipInSubnet(ip: string, subnet: string): boolean {
  const [base, bits] = subnet.split('/')
  const mask = ~((1 << (32 - parseInt(bits))) - 1) >>> 0
  const ipInt = ipToInt(ip)
  const baseInt = ipToInt(base)
  return (ipInt & mask) === (baseInt & mask)
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0
}

function buildDeviceEnv(
  device: ICSLabScenario['devices']['devices'][string],
  _scenario: ICSLabScenario
): string[] {
  const env: string[] = [`DEVICE_ID=${device.nodeId}`, `DEVICE_CATEGORY=${device.category}`]

  if (device.modbus) {
    env.push(`MODBUS_MODE=${device.modbus.mode}`)
    env.push(`MODBUS_PORT=${device.modbus.port}`)
    env.push(`MODBUS_UNIT_ID=${device.modbus.unitId}`)
  }

  if (device.dnp3) {
    env.push(`DNP3_MASTER_ADDRESS=${device.dnp3.masterAddress}`)
    env.push(`DNP3_OUTSTATION_ADDRESS=${device.dnp3.outstationAddress}`)
    env.push(`DNP3_PORT=${device.dnp3.port}`)
  }

  if (device.opcua) {
    env.push(`OPCUA_PORT=${device.opcua.port}`)
    env.push(`OPCUA_NAMESPACE=${device.opcua.namespace}`)
  }

  return env
}
