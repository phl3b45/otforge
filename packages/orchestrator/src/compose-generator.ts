/**
 * compose-generator.ts — Generates a docker-compose.yml from an ICSLabScenario.
 *
 * This is the core of the simulation orchestration layer. Given a scenario JSON
 * document, it produces a complete Docker Compose v2 file that, when run with
 * `docker compose up`, creates:
 *
 *   - One container per device in the scenario (PLC, RTU, sensor, etc.)
 *   - Fixed infrastructure containers always present in every simulation:
 *       Suricata IDS/IPS, Zeek network monitor, InfluxDB historian,
 *       Loki log aggregator, Grafana dashboards, FUXA HMI
 *   - Four Docker bridge networks matching the 4-zone Purdue Model:
 *       ot-net, it-net, dmz-net, external-net
 *
 * Key design decisions:
 *   - All device containers get static IP addresses so protocol scripts can
 *     reference each other by a predictable address.
 *   - Resource limits (memory cap, CPU fraction) are set per container category
 *     to prevent runaway containers from starving the host system.
 *   - The firewall container is attached to ot-net, it-net, and dmz-net so it
 *     can enforce inter-zone access control rules via nftables.
 *   - GPL/AGPL-licensed images (Grafana, Loki, OpenPLC) are pulled from public
 *     registries at runtime rather than bundled in the installer binary — this
 *     keeps the commercial distribution legally clean.
 *
 * Usage:
 *   const yaml = generateCompose(scenario, 'ics-sim-water-plant')
 *   await writeFile('docker-compose.yml', yaml)
 */

import yaml from 'js-yaml'
import type { ICSLabScenario, DeviceCategory, NetworkZone } from '@ics-sim/schema'
import { ZONE_DEFAULTS } from './network-config'

/**
 * Maps each DeviceCategory to its Docker image reference on GHCR.
 *
 * All custom images are built by .github/workflows/docker.yml and pushed to
 * ghcr.io/iburres/. Third-party images (fuxa, influxdb) are pulled from Docker Hub.
 * PLCs use the OpenPLC Runtime image; most OT devices use the Modbus server; IEDs
 * use the pure-Python DNP3 outstation.
 */
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

/**
 * Per-category resource limits written into each service's `deploy.resources.limits`.
 *
 * Memory is in MB; cpus is a fraction of a single host CPU core.
 * These values match the resource-estimator.ts budgets — if you change one, update
 * the other. The limits prevent runaway containers from consuming all host resources.
 */
const DEVICE_LIMITS: Record<DeviceCategory, { memory: number; cpus: string }> = {
  plc: { memory: 128, cpus: '0.5' }, // OpenPLC Runtime (Ubuntu base)
  rtu: { memory: 80, cpus: '0.25' }, // pymodbus on Alpine
  ied: { memory: 80, cpus: '0.25' }, // pure-Python DNP3 on Alpine
  hmi: { memory: 256, cpus: '0.5' }, // FUXA Node.js HMI
  historian: { memory: 256, cpus: '0.5' }, // InfluxDB 1.8
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
  'attack-machine': { memory: 512, cpus: '1.0' } // Kali with Metasploit, etc.
}

/** Shape of a single service entry in the generated compose file. */
interface ComposeService {
  image: string
  container_name: string
  restart: string
  networks: Record<string, { ipv4_address: string }>
  environment: string[] | undefined
  volumes: string[] | undefined
  cap_add: string[] | undefined
  /** Port mappings in "hostPort:containerPort" format. Used for PLC web UIs. */
  ports?: string[]
  deploy: { resources: { limits: { memory: string; cpus: string } } }
}

/** Shape of a Docker network entry in the generated compose file. */
interface ComposeNetwork {
  driver: string
  driver_opts?: Record<string, string>
  ipam: { driver: string; config: Array<{ subnet: string; gateway: string }> }
}

/** Top-level structure of the generated docker-compose.yml. */
interface ComposeFile {
  name: string
  services: Record<string, ComposeService>
  networks: Record<string, ComposeNetwork>
  volumes: Record<string, unknown> | undefined
}

/**
 * Generates a complete docker-compose.yml YAML string for a given scenario.
 *
 * The output is suitable for passing directly to `docker compose up`. It includes:
 *   - Docker bridge networks for each zone (from scenario segments + defaults)
 *   - One service per device in scenario.devices.devices
 *   - Fixed infrastructure services: suricata, zeek, influxdb, loki, grafana, fuxa
 *
 * @param scenario    - The validated scenario document to generate compose for.
 * @param projectName - Docker Compose project name (sanitized scenario name).
 *   All container/network/volume names are prefixed with this value.
 * @returns Complete YAML string ready to write to docker-compose.yml.
 */
export function generateCompose(scenario: ICSLabScenario, projectName: string): string {
  const services: Record<string, ComposeService> = {}
  const networks: Record<string, ComposeNetwork> = {}
  const volumes: Record<string, unknown> = {}

  // ── Docker networks from scenario segments ─────────────────────────────────
  // Build one Docker bridge network per network segment defined in the scenario.
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

  // Fill in default subnets for any zones not explicitly defined in the scenario.
  // This ensures all four zone networks always exist, even in minimal scenarios.
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
  // One service per device node in the scenario's device graph.
  //
  // PLC port assignment (Phase 4):
  //   Each PLC container's OpenPLC web interface (port 8080) is published on a
  //   deterministic host port starting at PLC_WEB_PORT_BASE. The same ordering
  //   is replicated in main/index.ts to build the activePlcPorts map used by
  //   the plc:deploy IPC handler.
  const PLC_WEB_PORT_BASE = 18080
  let plcPortIndex = 0

  for (const [nodeId, device] of Object.entries(scenario.devices.devices)) {
    // Use a custom image if specified (for advanced scenarios), otherwise use the category default
    const image = device.dockerImage ?? DEVICE_IMAGES[device.category]
    const limits = DEVICE_LIMITS[device.category]

    // Service names must be lowercase alphanumeric + hyphen for Docker Compose compatibility
    const serviceName = sanitizeServiceName(nodeId)

    // Determine which zone network to attach this device to by matching its IP to a subnet
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

    // PLC containers publish their OpenPLC web interface (port 8080) on a
    // deterministic host port so the main process can reach the REST API for
    // live ST program deployment (plc:deploy IPC handler).
    if (device.category === 'plc') {
      const hostPort = PLC_WEB_PORT_BASE + plcPortIndex
      services[serviceName].ports = [`${hostPort}:8080`]
      plcPortIndex++
    }

    // Firewall bridges all three internal zones to enforce inter-zone ACLs.
    // NET_ADMIN is required to create and manage nftables rules.
    // NET_RAW is required for raw socket access (ICMP, packet capture).
    if (device.category === 'firewall') {
      services[serviceName].cap_add = ['NET_ADMIN', 'NET_RAW']
      // Attach to OT, IT, and DMZ at the .254 address (last usable host in each /24)
      services[serviceName].networks = {
        'ot-net': { ipv4_address: `${ZONE_DEFAULTS.ot.subnet.replace('.0/24', '.254')}` },
        'it-net': { ipv4_address: `${ZONE_DEFAULTS.it.subnet.replace('.0/24', '.254')}` },
        'dmz-net': { ipv4_address: `${ZONE_DEFAULTS.dmz.subnet.replace('.0/24', '.254')}` }
      }
    }

    // Attack machine is always isolated on the External network.
    // NET_ADMIN + NET_RAW enable nmap raw scans, ARP poisoning, etc.
    if (device.category === 'attack-machine') {
      services[serviceName].networks = {
        'external-net': { ipv4_address: device.ipAddress }
      }
      services[serviceName].cap_add = ['NET_ADMIN', 'NET_RAW']
    }
  }

  // ── Fixed infrastructure services ─────────────────────────────────────────
  // These run in every simulation regardless of scenario contents.
  // .253 and .252 are reserved host addresses in the /24 subnets.

  const otBase = ZONE_DEFAULTS.ot.subnet.replace('.0/24', '')
  const itBase = ZONE_DEFAULTS.it.subnet.replace('.0/24', '')

  // ── Suricata — inline IPS/IDS on OT and IT networks ──────────────────────
  // Placed on both OT and IT nets so it can analyze cross-zone traffic.
  // Eve JSON logs go to a named volume, then Loki reads them (Phase 6).
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
    cap_add: ['NET_ADMIN', 'NET_RAW'], // AF_PACKET mode requires raw socket access
    volumes: [`${projectName}-suricata-logs:/var/log/suricata`],
    deploy: { resources: { limits: { memory: '150m', cpus: '0.5' } } }
  }

  // ── Zeek — passive network analysis tap on OT network ────────────────────
  // Zeek monitors traffic passively; it does not block or modify packets.
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

  // ── InfluxDB 1.8 — time-series process historian ──────────────────────────
  // InfluxDB 1.8 (MIT licensed) is used instead of 2.x to avoid the BSL license.
  // Auth is disabled so protocol containers can write without credentials.
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
      'INFLUXDB_HTTP_AUTH_ENABLED=false' // Auth off so containers can write without credentials
    ],
    cap_add: undefined,
    volumes: [`${projectName}-influxdb-data:/var/lib/influxdb`],
    deploy: { resources: { limits: { memory: '256m', cpus: '0.5' } } }
  }

  // ── Loki — log aggregation (AGPL — pulled at runtime, not bundled) ─────────
  // Loki ingests Eve JSON from Suricata and Zeek logs for querying in Grafana.
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

  // ── Grafana — dashboards (AGPL — pulled at runtime, not bundled) ──────────
  // Anonymous viewer access is enabled so the embedded Electron webview panel
  // (Phase 6) can display dashboards without a login step.
  volumes[`${projectName}-grafana-data`] = {}
  services['grafana'] = {
    image: 'grafana/grafana:latest',
    container_name: `${projectName}-grafana`,
    restart: 'unless-stopped',
    networks: { 'it-net': { ipv4_address: `${itBase}.12` } },
    environment: [
      'GF_SECURITY_ADMIN_USER=admin',
      'GF_SECURITY_ADMIN_PASSWORD=icslab',
      'GF_AUTH_ANONYMOUS_ENABLED=true', // Allows the embedded panel to load without login
      'GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer' // Restrict anonymous sessions to read-only
    ],
    cap_add: undefined,
    volumes: [`${projectName}-grafana-data:/var/lib/grafana`],
    deploy: { resources: { limits: { memory: '150m', cpus: '0.5' } } }
  }

  // ── FUXA — web-based HMI (MIT licensed) ──────────────────────────────────
  // FUXA connects to Modbus/OPC-UA servers and renders live process graphics.
  // The _appdata volume persists user-configured HMI projects across restarts.
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
    // Omit volumes key entirely if no named volumes were added (cleaner output)
    volumes: Object.keys(volumes).length > 0 ? volumes : undefined
  }

  return yaml.dump(compose, { lineWidth: 120, noRefs: true })
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Sanitizes a React Flow node ID into a Docker Compose service name.
 *
 * Docker Compose service names must match /^[a-z0-9-]+$/. Node IDs use
 * lowercase with hyphens by convention but may contain underscores or other
 * characters depending on how the canvas generates them.
 *
 * @param nodeId - The canvas node ID string.
 * @returns Lowercase alphanumeric + hyphen string safe for Docker Compose.
 */
function sanitizeServiceName(nodeId: string): string {
  return nodeId.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

/**
 * Finds the zone a device belongs to by matching its IP address against
 * the scenario's network segment subnets.
 *
 * @param ip       - The device's static IPv4 address.
 * @param scenario - The scenario whose network segments to search.
 * @returns The NetworkZone the IP falls in, or null if no segment matches.
 */
function findZoneForIp(ip: string, scenario: ICSLabScenario): NetworkZone | null {
  for (const seg of scenario.network.segments) {
    if (ipInSubnet(ip, seg.subnet)) return seg.zone
  }
  return null
}

/**
 * Tests whether an IPv4 address falls within a CIDR subnet.
 *
 * Uses bitwise integer arithmetic:
 *   1. Convert prefix length to a 32-bit network mask (e.g., /24 → 0xFFFFFF00).
 *   2. AND both the IP and the base address with the mask.
 *   3. If the results match, the IP is in the subnet.
 *
 * The `>>> 0` converts the signed JavaScript number to an unsigned 32-bit integer,
 * preventing sign-extension bugs when the high bit of the mask is set.
 *
 * @param ip     - IPv4 address to test (e.g., "172.20.10.5").
 * @param subnet - CIDR notation subnet (e.g., "172.20.10.0/24").
 * @returns true if ip is within subnet.
 */
function ipInSubnet(ip: string, subnet: string): boolean {
  const [base, bits] = subnet.split('/')
  // Build mask: ~((1 << (32 - bits)) - 1) gives the host bits as 0, network bits as 1
  const mask = ~((1 << (32 - parseInt(bits))) - 1) >>> 0
  const ipInt = ipToInt(ip)
  const baseInt = ipToInt(base)
  return (ipInt & mask) === (baseInt & mask)
}

/**
 * Converts a dotted-decimal IPv4 address to an unsigned 32-bit integer.
 *
 * Uses reduce with left-shift to avoid float precision: each octet is
 * shifted 8 bits left as the next octet is added.
 *
 * @param ip - IPv4 address string (e.g., "172.20.10.5").
 * @returns Unsigned 32-bit integer representation.
 */
function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0
}

/**
 * Builds the `environment` array for a device container.
 *
 * Protocol containers read DEVICE_ID and DEVICE_CATEGORY to determine their
 * behavior. Protocol-specific vars (MODBUS_PORT, DNP3_OUTSTATION_ADDRESS, etc.)
 * configure the server process when the container starts.
 *
 * @param device   - The device configuration to generate env vars for.
 * @param _scenario - Full scenario (reserved for future cross-device references).
 * @returns Array of "KEY=VALUE" strings for the compose environment field.
 */
function buildDeviceEnv(
  device: ICSLabScenario['devices']['devices'][string],
  _scenario: ICSLabScenario
): string[] {
  const env: string[] = [`DEVICE_ID=${device.nodeId}`, `DEVICE_CATEGORY=${device.category}`]

  // Modbus TCP/RTU configuration — consumed by containers/modbus/server.py
  if (device.modbus) {
    env.push(`MODBUS_MODE=${device.modbus.mode}`)
    env.push(`MODBUS_PORT=${device.modbus.port}`)
    env.push(`MODBUS_UNIT_ID=${device.modbus.unitId}`)
  }

  // DNP3 outstation configuration — consumed by containers/dnp3/outstation.py
  if (device.dnp3) {
    env.push(`DNP3_MASTER_ADDRESS=${device.dnp3.masterAddress}`)
    env.push(`DNP3_OUTSTATION_ADDRESS=${device.dnp3.outstationAddress}`)
    env.push(`DNP3_PORT=${device.dnp3.port}`)
  }

  // OPC UA server configuration — consumed by Phase 4+ OPC-UA container
  if (device.opcua) {
    env.push(`OPCUA_PORT=${device.opcua.port}`)
    env.push(`OPCUA_NAMESPACE=${device.opcua.namespace}`)
  }

  // PLC program pre-load (Phase 4):
  //   If the device has a saved Structured Text program, inject it as a base64-
  //   encoded environment variable. The OpenPLC entrypoint.sh reads this variable,
  //   decodes it to a .st file, and pre-loads it into the runtime at container
  //   startup — so the PLC runs the user's program from the very first second.
  //   The source field in PLCProgramConfig is already base64-encoded (btoa in the UI).
  if (device.plcProgram?.source) {
    env.push(`INITIAL_PROGRAM_B64=${device.plcProgram.source}`)
    // Also inject the Modbus variable binding count so the bridge script knows
    // how many protocol-mapped registers to initialise.
    env.push(`PLC_VAR_COUNT=${device.plcProgram.variables.length}`)
  }

  return env
}
