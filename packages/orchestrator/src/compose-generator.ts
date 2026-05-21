/**
 * compose-generator.ts — Generates a docker-compose.yml from an OTForgeScenario.
 *
 * This is the core of the simulation orchestration layer. Given a scenario JSON
 * document, it produces a complete Docker Compose v2 file that, when run with
 * `docker compose up`, creates:
 *
 *   - One container per device in the scenario (PLC, RTU, sensor, etc.)
 *   - Fixed infrastructure containers always present in every simulation:
 *       Suricata IDS/IPS, Zeek network monitor, InfluxDB historian,
 *       Loki log aggregator, Grafana dashboards, FUXA HMI
 *   - Six Docker bridge networks matching the full Purdue Reference Model:
 *       ot-net, control-net, plant-dmz-net, enterprise-net, internet-dmz-net, attacker-net
 *
 * Key design decisions:
 *   - All device containers get static IP addresses so protocol scripts can
 *     reference each other by a predictable address.
 *   - Resource limits (memory cap, CPU fraction) are set per container category
 *     to prevent runaway containers from starving the host system.
 *   - The firewall container is attached to ot-net, control-net, and plant-dmz-net so it
 *     can enforce inter-zone access control rules via nftables.
 *   - GPL/AGPL-licensed images (Grafana, Loki, OpenPLC) are pulled from public
 *     registries at runtime rather than bundled in the installer binary — this
 *     keeps the commercial distribution legally clean.
 *
 * Usage:
 *   const yaml = generateCompose(scenario, 'otforge-water-plant')
 *   await writeFile('docker-compose.yml', yaml)
 */

import yaml from 'js-yaml'
import type { OTForgeScenario, DeviceCategory, NetworkZone } from '@otforge/schema'
import { ZONE_DEFAULTS } from './network-config'

/**
 * Maps each DeviceCategory to its Docker image reference on GHCR.
 *
 * All custom images are built by .github/workflows/docker.yml and pushed to
 * ghcr.io/iburres/. Third-party images (fuxa, influxdb) are pulled from Docker Hub.
 * PLCs use the OpenPLC Runtime image; most OT devices use the Modbus server; IEDs
 * use the pure-Python DNP3 outstation.
 */
// Images marked "STUB" are placeholders used until the corresponding custom
// otforge-* image is built and published to GHCR. Stubs use well-known public
// images that start cleanly and join the correct Docker network; they do not
// implement the full ICS protocol the device represents.
const DEVICE_IMAGES: Record<DeviceCategory, string> = {
  // ── OT Process (Levels 0–2) ────────────────────────────────────────────────
  plc: 'ghcr.io/iburres/otforge-openplc:latest',
  // STUB: alpine provides a minimal container that starts and joins the network.
  // Replace with otforge-modbus (Modbus TCP outstation) once published.
  rtu: 'alpine:latest',
  // STUB: Replace with otforge-dnp3 (DNP3 outstation) once published.
  ied: 'alpine:latest',
  // Phase 10: Conpot legacy device emulation (S7comm + IEC 104)
  'legacy-plc': 'ghcr.io/iburres/otforge-conpot:latest',
  'iec104-rtu': 'ghcr.io/iburres/otforge-conpot:latest',
  // Phase 11: Physics-simulated process unit (water tank, pipeline, generator, generic)
  'process-unit': 'ghcr.io/iburres/otforge-process:latest',
  sensor: 'alpine:latest',
  actuator: 'alpine:latest',
  pump: 'alpine:latest',
  valve: 'alpine:latest',
  'flow-meter': 'alpine:latest',
  'pressure-transmitter': 'alpine:latest',
  // ── Control Center (Level 3) ────────────────────────────────────────────────
  hmi: 'frangoteam/fuxa:latest',
  historian: 'influxdb:1.8-alpine',
  // STUB: nginx:alpine serves HTTP so the container appears "up" on the network.
  // Replace with otforge-appserver once published.
  'application-server': 'nginx:alpine',
  // STUB: Replace with otforge-dbserver (PostgreSQL + ICS schema) once published.
  'database-server': 'postgres:16-alpine',
  // linuxserver webtop: Ubuntu XFCE desktop via KasmVNC on port 3000.
  // Replace with otforge-workstation once published.
  'engineering-workstation': 'lscr.io/linuxserver/webtop:ubuntu-xfce',
  // ── Plant DMZ (Level 3.5) ───────────────────────────────────────────────────
  firewall: 'ghcr.io/iburres/otforge-firewall:latest',
  'ids-ips': 'ghcr.io/iburres/otforge-suricata:latest',
  // STUB: alpine with NET_ADMIN cap acts as a placeholder network device.
  // Replace with otforge-switch / otforge-router once published.
  switch: 'alpine:latest',
  router: 'alpine:latest',
  // ── Enterprise Zone (Level 4) ───────────────────────────────────────────────
  // STUB: Replace with otforge-dc (Samba AD domain controller) once published.
  'domain-controller': 'alpine:latest',
  // STUB: nginx:alpine serves HTTP. Replace with otforge-webserver once published.
  'web-server': 'nginx:alpine',
  // STUB: Replace with otforge-bizserver once published.
  'business-server': 'nginx:alpine',
  // linuxserver webtop: Ubuntu XFCE desktop via KasmVNC on port 3000.
  // Replace with otforge-workstation once published.
  'enterprise-desktop': 'lscr.io/linuxserver/webtop:ubuntu-xfce',
  // ── Internet DMZ (Level 5) ───────────────────────────────────────────────────
  // STUB: mailhog provides a lightweight SMTP+web UI for email simulation.
  // Replace with otforge-mail once published.
  'email-server': 'mailhog/mailhog:latest',
  // STUB: nginx:alpine for generic internet-facing servers.
  // The tutorial scenario overrides this with otforge-web-company via deviceConfig.dockerImage.
  'internet-server': 'nginx:alpine',
  // Phase 12: Authoritative DNS server — dnsmasq serving the meridian-process.com zone.
  'dns-server': 'ghcr.io/iburres/otforge-dns:latest',
  // ── Red Team ─────────────────────────────────────────────────────────────────
  // Custom Kali rolling image with full Xfce4 + noVNC (port 6080) + ICS attack tools.
  // Built from containers/attack-base — replaces the old linuxserver/kali-linux stub.
  'attack-machine': 'ghcr.io/iburres/otforge-attack-base:latest'
}

/**
 * Per-category resource limits written into each service's `deploy.resources.limits`.
 *
 * Memory is in MB; cpus is a fraction of a single host CPU core.
 * These values match the resource-estimator.ts budgets — if you change one, update
 * the other. The limits prevent runaway containers from consuming all host resources.
 */
const DEVICE_LIMITS: Record<DeviceCategory, { memory: number; cpus: string }> = {
  // ── OT Process (Levels 0–2) ────────────────────────────────────────────────
  plc: { memory: 128, cpus: '0.5' }, // OpenPLC Runtime (Ubuntu base)
  rtu: { memory: 80, cpus: '0.25' }, // pymodbus on Alpine
  ied: { memory: 80, cpus: '0.25' }, // pure-Python DNP3 on Alpine
  'legacy-plc': { memory: 80, cpus: '0.25' }, // pure-Python S7comm on Alpine (Phase 10)
  'iec104-rtu': { memory: 80, cpus: '0.25' }, // pure-Python IEC 104 on Alpine (Phase 10)
  'process-unit': { memory: 96, cpus: '0.25' }, // pymodbus + physics loop on Alpine (Phase 11)
  sensor: { memory: 64, cpus: '0.15' },
  actuator: { memory: 64, cpus: '0.15' },
  pump: { memory: 64, cpus: '0.15' },
  valve: { memory: 64, cpus: '0.15' },
  'flow-meter': { memory: 64, cpus: '0.15' },
  'pressure-transmitter': { memory: 64, cpus: '0.15' },
  // ── Control Center (Level 3) ────────────────────────────────────────────────
  hmi: { memory: 256, cpus: '0.5' }, // FUXA Node.js HMI
  historian: { memory: 256, cpus: '0.5' }, // InfluxDB 1.8
  'application-server': { memory: 256, cpus: '0.5' }, // generic app server
  'database-server': { memory: 256, cpus: '0.5' }, // generic database
  'engineering-workstation': { memory: 128, cpus: '0.25' }, // lightweight workstation sim
  // ── Plant DMZ (Level 3.5) ───────────────────────────────────────────────────
  firewall: { memory: 32, cpus: '0.25' },
  'ids-ips': { memory: 256, cpus: '0.5' },
  switch: { memory: 32, cpus: '0.1' },
  router: { memory: 32, cpus: '0.1' },
  // ── Enterprise Zone (Level 4) ───────────────────────────────────────────────
  'domain-controller': { memory: 256, cpus: '0.5' }, // Samba AD / directory service
  'web-server': { memory: 128, cpus: '0.25' }, // nginx / web app
  'business-server': { memory: 256, cpus: '0.5' }, // generic business application
  'enterprise-desktop': { memory: 128, cpus: '0.25' }, // lightweight desktop
  // ── Internet DMZ (Level 5) ───────────────────────────────────────────────────
  'email-server': { memory: 128, cpus: '0.25' }, // Postfix / mail relay
  'internet-server': { memory: 128, cpus: '0.25' }, // internet-facing web server
  // Phase 12: dnsmasq on Alpine — extremely lightweight DNS server
  'dns-server': { memory: 32, cpus: '0.05' },
  // ── Red Team ─────────────────────────────────────────────────────────────────
  // 2 GB: full Xfce4 desktop + Wireshark GUI + Armitage + Metasploit + noVNC server.
  // Students are expected to have 16+ GB RAM; this budget reflects that baseline.
  'attack-machine': { memory: 2048, cpus: '2.0' }
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
  /** Port mappings in "hostPort:containerPort" format. Used for PLC web UIs and attack machine. */
  ports?: string[]
  /**
   * Shared memory size for containers that run a GUI desktop (linuxserver Kali).
   * Without adequate shm, the Chromium instance inside KasmVNC crashes on startup.
   */
  shm_size?: string
  /**
   * DNS resolver override — set on the attack machine to point at the scenario's
   * dns-server device so exercise hostnames resolve inside the simulation.
   */
  dns?: string[]
  /**
   * Container healthcheck configuration. Docker runs `test` at `interval` after
   * `start_period` grace; after `retries` consecutive failures the container is
   * marked unhealthy. Dependent services use `depends_on.condition: service_healthy`
   * to wait until this service passes its healthcheck before starting.
   */
  healthcheck?: {
    /** Shell command array. Use ['CMD', 'curl', '-f', 'url'] or ['CMD-SHELL', 'cmd || exit 1']. */
    test: string[]
    /** How often to run the check (e.g., '5s', '10s'). */
    interval: string
    /** Max time to wait for a single check (e.g., '3s'). */
    timeout: string
    /** Consecutive failures before the container is marked unhealthy. */
    retries: number
    /** Grace period after container start before health checks begin (e.g., '10s'). */
    start_period: string
  }
  /**
   * Startup ordering constraints. 'service_healthy' requires the named dependency's
   * healthcheck to pass before Docker starts this service. 'service_started' only
   * requires the dependency container to be running (no healthcheck required).
   */
  depends_on?: Record<string, { condition: 'service_healthy' | 'service_started' }>
  deploy: { resources: { limits: { memory: string; cpus: string } } }
}

/** Shape of a Docker network entry in the generated compose file. */
interface ComposeNetwork {
  driver: string
  driver_opts?: Record<string, string>
  /**
   * When true, Docker creates an isolated bridge with no outbound NAT.
   * All Purdue Model zones except attacker-net set this to enforce that
   * OT/IT/enterprise/DMZ devices cannot reach the public internet.
   * attacker-net omits this flag so Kali retains outbound internet access
   * for tool updates, package installs, and student browsing exercises.
   */
  internal?: boolean
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
 * @param scenarioDir   - Absolute host path to the scenario directory
 *   (<userData>/scenarios/<projectName>/). When provided, Grafana and Loki
 *   publish their ports to the host (3000 and 3100) and Grafana provisioning
 *   files are mounted from <scenarioDir>/grafana/. Promtail is added as a
 *   log-shipping sidecar. Omit in tests where host paths are unavailable.
 * @param resolvedZones - Optional zone → subnet/gateway map produced by
 *   findFreeSubnets() in the main process. When provided, overrides ZONE_DEFAULTS
 *   so every Docker network and infrastructure container IP uses the conflict-free
 *   subnets chosen at simulation start. When omitted (e.g., in tests), falls back
 *   to ZONE_DEFAULTS unchanged.
 * @returns Complete YAML string ready to write to docker-compose.yml.
 */
export function generateCompose(
  scenario: OTForgeScenario,
  projectName: string,
  scenarioDir?: string,
  resolvedZones?: Record<NetworkZone, { subnet: string; gateway: string }>
): string {
  // effectiveZones is the authoritative zone → subnet/gateway map used throughout
  // this function. It is the caller-supplied resolved map when subnet auto-detection
  // ran, or ZONE_DEFAULTS when called from tests or scenarios without auto-detection.
  const effectiveZones = resolvedZones ?? ZONE_DEFAULTS
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
      // Isolate every zone from outbound internet except attacker-net.
      // Kali (attacker-net) is the only host that should reach the public internet.
      ...(seg.zone !== 'attacker' && { internal: true }),
      ipam: {
        driver: 'default',
        config: [{ subnet: seg.subnet, gateway: seg.gateway }]
      }
    }
  }

  // Fill in subnets for any zones not explicitly defined in the scenario.
  // Uses effectiveZones (resolved at runtime) rather than ZONE_DEFAULTS so that
  // auto-detected or user-pinned subnets take effect for zones the scenario leaves unset.
  const allZones: NetworkZone[] = [
    'ot',
    'control',
    'plant-dmz',
    'enterprise',
    'internet-dmz',
    'attacker'
  ]
  for (const zone of allZones) {
    if (!segmentByZone[zone]) {
      const netName = `${zone}-net`
      networks[netName] = {
        driver: 'bridge',
        // Same isolation policy as the segment loop above.
        ...(zone !== 'attacker' && { internal: true }),
        ipam: {
          driver: 'default',
          config: [{ subnet: effectiveZones[zone].subnet, gateway: effectiveZones[zone].gateway }]
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
  //
  // Attack machine port assignment:
  //   Each attack container's noVNC WebSocket (port 6080) is published on a
  //   deterministic host port starting at ATTACK_NOVNC_PORT_BASE. The same
  //   ordering is replicated in main/index.ts → activeAttackPorts map, which
  //   the terminal:getVncUrl IPC handler uses to build the noVNC URL.
  const PLC_WEB_PORT_BASE = 18080
  let plcPortIndex = 0
  const ATTACK_NOVNC_PORT_BASE = 6900
  let attackPortIndex = 0
  // Collected during the device loop so we can attach PLC services to
  // monitoring-net after that network is defined (later in this function).
  const plcServiceNames: string[] = []

  // ── IP deduplication ────────────────────────────────────────────────────────
  // Tracks host octets already assigned per Docker network so that stale or
  // duplicate IPs in the scenario JSON never produce an invalid compose file.
  // Pre-seeded with all system-service and infrastructure reservations so user
  // devices automatically avoid them without any manual coordination.
  //
  // Reserved ranges per network:
  //   .1        — bridge gateway (Docker)
  //   .240–.249 — system services (influxdb, loki, grafana, fuxa, promtail)
  //   .250      — attack machine's second leg on internet-dmz-net
  //   .252      — zeek
  //   .253      — suricata
  //   .254      — firewall
  const reservedHosts = new Set([1, 240, 241, 242, 243, 244, 250, 252, 253, 254])
  const usedIpsPerNet = new Map<string, Set<number>>([
    ['ot-net', new Set(reservedHosts)],
    ['control-net', new Set(reservedHosts)],
    ['plant-dmz-net', new Set(reservedHosts)],
    ['enterprise-net', new Set(reservedHosts)],
    ['internet-dmz-net', new Set(reservedHosts)],
    ['attacker-net', new Set(reservedHosts)]
  ])

  /**
   * Records the final Docker IP claimed for each device (nodeId → IP string).
   * Used when setting the attack machine's `dns:` field so it points to the
   * actual container IP rather than the scenario's declared IP, which may have
   * been bumped by claimIp() if the host octet was in a reserved range.
   */
  const claimedDeviceIps = new Map<string, string>()

  /**
   * Returns a unique IP on netName for the given preferredIp.
   * If the preferred host octet is already taken, increments until a free slot
   * in the user-device range (.10–.239) is found and reserves it.
   */
  function claimIp(netName: string, preferredIp: string): string {
    const parts = preferredIp.split('.')
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`
    let host = parseInt(parts[3], 10)
    const used = usedIpsPerNet.get(netName) ?? new Set<number>()
    // Clamp starting point to the user range (.10–.239)
    if (host < 10) host = 10
    while (used.has(host) && host < 240) host++
    used.add(host)
    usedIpsPerNet.set(netName, used)
    return `${prefix}${host}`
  }

  for (const [nodeId, device] of Object.entries(scenario.devices.devices)) {
    // Use a custom image if specified (for advanced scenarios), otherwise use the category default
    const image = device.dockerImage ?? DEVICE_IMAGES[device.category]
    const limits = DEVICE_LIMITS[device.category]

    // Service names must be lowercase alphanumeric + hyphen for Docker Compose compatibility
    const serviceName = sanitizeServiceName(nodeId)

    // Determine which zone network to attach this device to. Primary lookup checks the
    // scenario's declared network segments; secondary lookup falls back to ZONE_DEFAULTS
    // so that devices still land on the correct network when segments is empty (e.g., a
    // scenario created by handleAttackMachineAdd with no explicit segment definitions).
    const zone =
      findZoneForIp(device.ipAddress, scenario) ?? findZoneForIpInDefaults(device.ipAddress) ?? 'ot'
    const netName = `${zone}-net`

    const env: string[] = buildDeviceEnv(device, scenario)

    // Translate the scenario IP to the effective zone subnet, then deduplicate.
    // claimIp() guarantees uniqueness within the network even if the scenario JSON
    // has stale or duplicate IPs — the compose file is always self-consistent.
    const resolvedIp = resolveDeviceIp(device.ipAddress, scenario, effectiveZones)
    const effectiveIp = claimIp(netName, resolvedIp)
    // Record so attack-machine DNS lookup can reference the actual assigned IP
    claimedDeviceIps.set(nodeId, effectiveIp)

    services[serviceName] = {
      image,
      container_name: `${projectName}-${serviceName}`,
      restart: 'unless-stopped',
      networks: { [netName]: { ipv4_address: effectiveIp } },
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
    // live ST program deployment (plc:deploy IPC handler) and so the user can
    // open the full OpenPLC IDE (Ladder Logic, monitoring) in a browser.
    // NOTE: the ports: binding only works because we also attach PLCs to the
    // non-internal monitoring-net below — ot-net is internal: true and Docker
    // silently drops port bindings on internal-only networks.
    if (device.category === 'plc') {
      const hostPort = PLC_WEB_PORT_BASE + plcPortIndex
      services[serviceName].ports = [`${hostPort}:8080`]
      plcServiceNames.push(serviceName)
      plcPortIndex++
    }

    // Firewall bridges OT, Control Center, and Plant DMZ to enforce inter-zone ACLs.
    // NET_ADMIN is required to create and manage nftables rules.
    // NET_RAW is required for raw socket access (ICMP, packet capture).
    if (device.category === 'firewall') {
      services[serviceName].cap_add = ['NET_ADMIN', 'NET_RAW']
      // Attach to OT (L0-2), Control (L3), and Plant DMZ (L3.5) at .254 (last usable host in /24).
      // Uses effectiveZones so the address stays inside the resolved (possibly auto-detected) subnet.
      services[serviceName].networks = {
        'ot-net': { ipv4_address: `${effectiveZones.ot.subnet.replace('.0/24', '.254')}` },
        'control-net': {
          ipv4_address: `${effectiveZones.control.subnet.replace('.0/24', '.254')}`
        },
        'plant-dmz-net': {
          ipv4_address: `${effectiveZones['plant-dmz'].subnet.replace('.0/24', '.254')}`
        }
      }
      // Inject scenario security config so the entrypoint can build the nftables ruleset.
      // FW_DEFAULT_POLICY maps schema "deny"/"allow" to nftables "drop"/"accept".
      // FW_RULES_JSON is the full ACLRule array serialized to JSON — parsed by jq in the entrypoint.
      const fwEnv: string[] = services[serviceName].environment ?? []
      fwEnv.push(
        `FW_DEFAULT_POLICY=${scenario.security.defaultFirewallPolicy === 'allow' ? 'accept' : 'drop'}`
      )
      if (scenario.security.firewallRules.length > 0) {
        fwEnv.push(`FW_RULES_JSON=${JSON.stringify(scenario.security.firewallRules)}`)
      }
      // Inject effective zone subnets so the firewall entrypoint builds nftables rules
      // against the real (auto-detected or user-pinned) subnets, not hardcoded defaults.
      // These override the Dockerfile ENV defaults at runtime.
      fwEnv.push(`FW_ZONE_OT=${effectiveZones.ot.subnet}`)
      fwEnv.push(`FW_ZONE_CONTROL=${effectiveZones.control.subnet}`)
      fwEnv.push(`FW_ZONE_PLANT_DMZ=${effectiveZones['plant-dmz'].subnet}`)
      fwEnv.push(`FW_ZONE_ENTERPRISE=${effectiveZones.enterprise.subnet}`)
      fwEnv.push(`FW_ZONE_INTERNET_DMZ=${effectiveZones['internet-dmz'].subnet}`)
      fwEnv.push(`FW_ZONE_ATTACKER=${effectiveZones.attacker.subnet}`)
      services[serviceName].environment = fwEnv
    }

    // Attack machine is always isolated on the dedicated Attacker network.
    // It is NOT on any Purdue Model zone — it lives outside the OT/IT/Enterprise perimeter.
    //
    // Image: ghcr.io/iburres/otforge-attack-base:latest (built from containers/attack-base)
    //   Full Kali rolling desktop (Xfce4 + TigerVNC + noVNC) served on container port 6080.
    //   Includes ICS attack tools: nmap, pymodbus, metasploit, wireshark, scapy, etc.
    //   Students browse to http://localhost:<hostPort>/vnc.html to get the desktop GUI.
    //   docker exec -it <name> /bin/bash also works for scripted CLI exercises.
    //
    // NET_ADMIN + NET_RAW enable nmap raw scans, ARP poisoning, tcpdump, etc.
    //
    // Port 6080 (noVNC WebSocket) is published to a deterministic host port so
    // the Electron main process can open a separate OS BrowserWindow at the noVNC URL.
    // The same port index ordering is reproduced in main/index.ts → activeAttackPorts map.
    if (device.category === 'attack-machine') {
      const webPort = ATTACK_NOVNC_PORT_BASE + attackPortIndex
      // Kali is dual-homed:
      //   attacker-net   — primary interface; no internal: true so Docker NATs outbound
      //                    traffic through the host, giving Kali internet access.
      //   internet-dmz-net — second leg giving direct L2 adjacency to the scenario's
      //                    web server and DNS server. .250 is reserved for this purpose
      //                    (see reservedHosts above).
      const internetDmzBase = effectiveZones['internet-dmz'].subnet.replace('.0/24', '')
      services[serviceName].networks = {
        'attacker-net': { ipv4_address: device.ipAddress },
        'internet-dmz-net': { ipv4_address: `${internetDmzBase}.250` }
      }
      services[serviceName].cap_add = ['NET_ADMIN', 'NET_RAW']
      // Port 6080: noVNC WebSocket bridge served by our custom otforge-attack-base image
      services[serviceName].ports = [`${webPort}:6080`]
      attackPortIndex++
      // Point Kali's resolver at the scenario's dns-server so exercise hostnames
      // (e.g., meridian-process.com) resolve inside the simulation without needing
      // the public internet.
      const dnsDevice = Object.values(scenario.devices.devices).find(
        d => d.category === 'dns-server'
      )
      if (dnsDevice) {
        // Use the claimed IP (post-dedup) rather than the raw resolved IP. claimIp()
        // may have bumped the host octet if the scenario assigned an IP below .10
        // (e.g., .5 for a "standalone appliance" convention). The claimed IP is always
        // populated by the time the attack machine is processed in well-ordered scenario
        // JSON (dns-server defined before attack-machine). Falls back to resolveDeviceIp
        // for scenarios where the DNS server appears later in the JSON object.
        const dnsIp =
          claimedDeviceIps.get(dnsDevice.nodeId) ??
          resolveDeviceIp(dnsDevice.ipAddress, scenario, effectiveZones)
        // Include 8.8.8.8 as a fallback so Kali can resolve public names (and browse the
        // internet) via attacker-net even when the scenario's DNS server is air-gapped
        // (DNS_UPSTREAM=""). Without this fallback, Firefox and apt can't reach the internet.
        services[serviceName].dns = [dnsIp, '8.8.8.8']
      }
    }

    // ── Extra network attachments (extraNetworks field) ────────────────────────
    // Attaches this device to additional zone networks beyond the one determined
    // by its ipAddress. Used to model intentional misconfigurations (e.g., an
    // attack machine given direct OT access to demonstrate missing segmentation)
    // or legitimately multi-homed devices (e.g., a jump host in two zones).
    //
    // IPs are auto-assigned in the .200–.239 host range via claimIp() to stay
    // clear of both user devices (.10–.199) and infrastructure reservations
    // (.240–.254). The auto-assigned range is non-overlapping with the device's
    // primary IP (which is already claimed above).
    if (device.extraNetworks) {
      for (const extraZone of device.extraNetworks) {
        const extraNetName = `${extraZone}-net`
        // Skip if the device is already on this network (avoids duplicate attachment)
        if (services[serviceName].networks[extraNetName]) continue
        // Pick a free IP in the .200–.239 "extra network" host range
        const extraBase = effectiveZones[extraZone].subnet.replace('.0/24', '')
        let extraHost = 200
        const usedSet = usedIpsPerNet.get(extraNetName) ?? new Set<number>()
        while (usedSet.has(extraHost) && extraHost < 240) extraHost++
        usedSet.add(extraHost)
        usedIpsPerNet.set(extraNetName, usedSet)
        services[serviceName].networks[extraNetName] = {
          ipv4_address: `${extraBase}.${extraHost}`
        }
      }
    }
  }

  // ── Fixed infrastructure services ─────────────────────────────────────────
  // These run in every simulation regardless of scenario contents.
  // .253 and .252 are reserved host addresses in the /24 subnets.

  // Base prefixes for infrastructure containers — derived from effectiveZones so
  // Suricata, Zeek, InfluxDB, Loki, Grafana, and Promtail all get IPs inside the
  // resolved subnets (auto-detected or user-pinned), not the hard-coded defaults.
  // Monitoring infrastructure lives on the Control Center (Level 3) network.
  const otBase = effectiveZones.ot.subnet.replace('.0/24', '')
  const controlBase = effectiveZones.control.subnet.replace('.0/24', '')

  // ── Monitoring bridge (non-internal) ─────────────────────────────────────────
  // All Purdue Model zones above are created with internal: true, which prevents
  // OT/IT containers from accessing the internet. However, Docker Desktop for
  // Windows silently drops host port bindings (localhost:3000, 3100, 1881) when
  // a container's ONLY networks are internal: true — Docker cannot create the
  // required NAT rules through an internal-only bridge.
  //
  // This dedicated non-internal bridge gives Grafana, Loki, FUXA, and PLC
  // containers a second interface through which Docker can publish ports to the
  // host. It carries no OT traffic and is not reachable from any device
  // container. Third octet 70 continues the zone numbering scheme
  // (OT=10, Control=20, …, Attacker=60).
  const monitorBase = `${controlBase.split('.').slice(0, 2).join('.')}.70`
  networks['monitoring-net'] = {
    driver: 'bridge',
    ipam: {
      driver: 'default',
      config: [{ subnet: `${monitorBase}.0/24`, gateway: `${monitorBase}.1` }]
    }
  }

  // Attach each PLC service to monitoring-net so its ports: binding is honoured
  // by Docker Desktop. IPs start at .10 (fixed infrastructure uses .1–.9).
  plcServiceNames.forEach((svcName, idx) => {
    services[svcName].networks['monitoring-net'] = {
      ipv4_address: `${monitorBase}.${10 + idx}`
    }
  })

  // ── Suricata — inline IPS/IDS on OT and IT networks ──────────────────────
  // Placed on both OT and IT nets so it can analyze cross-zone traffic.
  // Eve JSON logs go to a named volume, then Loki reads them (Phase 6).
  //
  // IDS_RULESETS       — comma-separated Emerging Threats ruleset IDs selected in the
  //   IDSPanel UI (scenario.security.ids.enabledRulesets). Defaults to
  //   "emerging-scada,emerging-modbus" when the scenario has no selection.
  // IDS_DISABLED_SIDS  — comma-separated SID numbers to suppress in threshold.conf.
  // IDS_CUSTOM_RULES_B64 — base64-encoded Suricata rule text from the IDSPanel custom
  //   rules textarea. Decoded to /etc/suricata/rules/custom.rules at container startup.
  //   Only injected when the scenario has non-empty custom rules.
  const suricataRulesets =
    scenario.security.ids.enabledRulesets.length > 0
      ? scenario.security.ids.enabledRulesets.join(',')
      : 'emerging-scada,emerging-modbus'
  const suricataDisabledSids = scenario.security.ids.disabledRuleIds.join(',')

  const suricataEnv: string[] = [
    `IDS_RULESETS=${suricataRulesets}`,
    `IDS_DISABLED_SIDS=${suricataDisabledSids}`
  ]
  const customRulesText = scenario.security.ids.customRules?.trim()
  if (customRulesText) {
    suricataEnv.push(
      `IDS_CUSTOM_RULES_B64=${Buffer.from(customRulesText, 'utf-8').toString('base64')}`
    )
  }

  volumes[`${projectName}-suricata-logs`] = {}
  services['suricata'] = {
    image: 'ghcr.io/iburres/otforge-suricata:latest',
    container_name: `${projectName}-suricata`,
    restart: 'unless-stopped',
    networks: {
      'ot-net': { ipv4_address: `${otBase}.253` },
      'control-net': { ipv4_address: `${controlBase}.253` }
    },
    environment: suricataEnv,
    cap_add: ['NET_ADMIN', 'NET_RAW'], // AF_PACKET mode requires raw socket access
    volumes: [`${projectName}-suricata-logs:/var/log/suricata`],
    deploy: { resources: { limits: { memory: '150m', cpus: '0.5' } } }
  }

  // ── Zeek — passive network analysis tap on OT network ────────────────────
  // Zeek monitors traffic passively; it does not block or modify packets.
  //
  // ZEEK_SCRIPTS — comma-separated script filenames from the Zeek site directory,
  //   selected in the IDSPanel UI (scenario.security.ids.zeekScripts).
  //   Defaults to "modbus.zeek,dnp3.zeek" when the scenario has no selection.
  const zeekScripts =
    scenario.security.ids.zeekScripts.length > 0
      ? scenario.security.ids.zeekScripts.join(',')
      : 'modbus.zeek,dnp3.zeek'

  volumes[`${projectName}-zeek-logs`] = {}
  services['zeek'] = {
    image: 'ghcr.io/iburres/otforge-zeek:latest',
    container_name: `${projectName}-zeek`,
    restart: 'unless-stopped',
    networks: { 'ot-net': { ipv4_address: `${otBase}.252` } },
    environment: [`ZEEK_SCRIPTS=${zeekScripts}`],
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
    // .240–.249 reserved for infrastructure/system services; user devices start at .10
    networks: { 'control-net': { ipv4_address: `${controlBase}.240` } },
    environment: [
      'INFLUXDB_DB=otflab',
      'INFLUXDB_ADMIN_USER=admin',
      'INFLUXDB_ADMIN_PASSWORD=otflab-admin',
      'INFLUXDB_HTTP_AUTH_ENABLED=false' // Auth off so containers can write without credentials
    ],
    cap_add: undefined,
    volumes: [`${projectName}-influxdb-data:/var/lib/influxdb`],
    // Healthcheck: use the bundled influx CLI (always present in influxdb:1.8-alpine)
    // rather than curl, which is NOT included in the Alpine variant of the image.
    // 'show databases' is a lightweight meta-query that succeeds as soon as the
    // HTTP API listener is accepting requests.
    healthcheck: {
      test: ['CMD', 'influx', '-execute', 'show databases'],
      interval: '5s',
      timeout: '3s',
      retries: 10,
      start_period: '10s'
    },
    deploy: { resources: { limits: { memory: '256m', cpus: '0.5' } } }
  }

  // ── Loki — log aggregation (AGPL — pulled at runtime, not bundled) ─────────
  // Loki ingests EVE JSON from Suricata and Zeek logs for querying in Grafana.
  // Port 3100 is published to the host so the Electron renderer can query the
  // Loki HTTP API directly for the native live-log panel (Phase 6).
  volumes[`${projectName}-loki-data`] = {}
  services['loki'] = {
    image: 'grafana/loki:latest',
    container_name: `${projectName}-loki`,
    restart: 'unless-stopped',
    networks: {
      'control-net': { ipv4_address: `${controlBase}.241` },
      // monitoring-net: non-internal bridge required for Docker Desktop to publish port 3100
      'monitoring-net': { ipv4_address: `${monitorBase}.3` }
    },
    environment: undefined,
    cap_add: undefined,
    volumes: [`${projectName}-loki-data:/loki`],
    // Publish so the Electron main process can proxy Loki API queries
    ports: ['3100:3100'],
    // Healthcheck: recent grafana/loki images use a distroless base with no shell
    // tools, so wget/curl are unavailable. /bin/sh redirected to a TCP device file
    // is also out. Use netcat (nc) via /proc/net/tcp instead — not available either.
    // The most portable check is a TCP connection attempt using bash's /dev/tcp,
    // but distroless has no bash. Safest: check if the port is open using a 0-byte
    // TCP write from the Loki binary's own /proc check — not feasible.
    // Practical solution: skip CMD-SHELL and call the Loki ready endpoint directly
    // with CMD against /usr/bin/wget which IS present in Loki's alpine-based builds.
    // If the loki image has moved to distroless, the healthcheck returns unhealthy
    // (informational only — no depends_on uses it so it cannot block startup).
    healthcheck: {
      test: [
        'CMD-SHELL',
        'wget -qO- http://localhost:3100/ready 2>/dev/null | grep -q ready || exit 1'
      ],
      interval: '5s',
      timeout: '3s',
      retries: 12,
      start_period: '15s'
    },
    deploy: { resources: { limits: { memory: '80m', cpus: '0.25' } } }
  }

  // ── Grafana — dashboards (AGPL — pulled at runtime, not bundled) ──────────
  // Anonymous viewer access is enabled so the embedded Electron webview panel
  // can display dashboards without a login step.
  // GF_SECURITY_ALLOW_EMBEDDING=true disables X-Frame-Options: DENY so the
  // dashboard renders correctly in the Electron <webview> tag.
  // Port 3000 is published to the host so the webview can reach localhost:3000.
  // Provisioning files are mounted from the scenario directory when scenarioDir
  // is provided — this wires the InfluxDB and Loki datasources automatically.
  volumes[`${projectName}-grafana-data`] = {}

  const grafanaEnv = [
    'GF_SECURITY_ADMIN_USER=admin',
    'GF_SECURITY_ADMIN_PASSWORD=otflab',
    'GF_AUTH_ANONYMOUS_ENABLED=true', // No login required in the embedded panel
    'GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer', // Restrict anonymous sessions to read-only
    'GF_SECURITY_ALLOW_EMBEDDING=true', // Required for Electron webview embedding
    'GF_SERVER_ROOT_URL=http://localhost:3000', // Canonical URL for link generation
    'GF_ANALYTICS_REPORTING_ENABLED=false' // No telemetry from lab environments
  ]

  const grafanaVolumes = [`${projectName}-grafana-data:/var/lib/grafana`]
  if (scenarioDir) {
    // Normalize path separators for Docker on Windows (Docker Desktop via WSL2
    // handles forward-slashed Windows paths transparently).
    const provDir = `${scenarioDir}/grafana/provisioning`.replace(/\\/g, '/')
    const dashDir = `${scenarioDir}/grafana/dashboards`.replace(/\\/g, '/')
    grafanaVolumes.push(`${provDir}:/etc/grafana/provisioning:ro`)
    grafanaVolumes.push(`${dashDir}:/var/lib/grafana/dashboards:ro`)
  }

  services['grafana'] = {
    image: 'grafana/grafana:latest',
    container_name: `${projectName}-grafana`,
    restart: 'unless-stopped',
    networks: {
      'control-net': { ipv4_address: `${controlBase}.242` },
      // monitoring-net: non-internal bridge required for Docker Desktop to publish port 3000
      'monitoring-net': { ipv4_address: `${monitorBase}.2` }
    },
    environment: grafanaEnv,
    cap_add: undefined,
    volumes: grafanaVolumes,
    // Publish on the standard Grafana port so the Electron webview embeds it
    ports: ['3000:3000'],
    // Healthcheck: /api/health returns 200 once Grafana is fully started.
    // Informational only — the MonitorPanel polls monitor:grafanaReady on the app
    // side before mounting the webview, so no depends_on is needed here.
    healthcheck: {
      test: ['CMD-SHELL', 'curl -f http://localhost:3000/api/health || exit 1'],
      interval: '5s',
      timeout: '3s',
      retries: 15,
      start_period: '20s'
    },
    deploy: { resources: { limits: { memory: '150m', cpus: '0.5' } } }
  }

  // ── Promtail — log shipping sidecar (AGPL — pulled at runtime) ───────────
  // Promtail reads Suricata EVE JSON and Zeek log files from their named Docker
  // volumes and pushes each line to the Loki HTTP ingestion endpoint. Without
  // Promtail, Loki would receive no log data even though both analysis tools are
  // writing to disk.
  //
  // The shared named volumes (suricata-logs, zeek-logs) allow Promtail to read
  // files that Suricata and Zeek write without any direct network connection.
  // Promtail runs on the IT network so it can reach the Loki container at its
  // fixed IT-zone IP.
  if (scenarioDir) {
    const promtailConfigPath = `${scenarioDir}/promtail/config.yaml`.replace(/\\/g, '/')
    services['promtail'] = {
      image: 'grafana/promtail:latest',
      container_name: `${projectName}-promtail`,
      restart: 'unless-stopped',
      networks: { 'control-net': { ipv4_address: `${controlBase}.244` } },
      environment: undefined,
      cap_add: undefined,
      volumes: [
        `${promtailConfigPath}:/etc/promtail/config.yaml:ro`,
        `${projectName}-suricata-logs:/var/log/suricata:ro`, // shared read-only
        `${projectName}-zeek-logs:/var/log/zeek:ro` // shared read-only
      ],
      // Promtail retries failed pushes automatically, so it is safe to start
      // concurrently with Loki — any lines logged before Loki is ready are replayed.
      deploy: { resources: { limits: { memory: '64m', cpus: '0.1' } } }
    }
  }

  // ── FUXA — web-based HMI (MIT licensed) ──────────────────────────────────
  // FUXA connects to Modbus/OPC-UA servers and renders live process graphics.
  // The _appdata volume persists user-configured HMI projects across restarts.
  //
  // Dual-homed networking (control-net + ot-net):
  //   FUXA runs on control-net so Grafana and the Electron app can reach port 1881.
  //   It ALSO needs ot-net so it can open TCP connections to PLC Modbus servers
  //   (port 502). Without ot-net the FUXA→PLC Modbus poll would be unreachable
  //   because Docker containers on different networks cannot communicate.
  //
  // Port 1881 is published to the host so the Electron main process can open FUXA
  // in a standalone BrowserWindow via the hmi:open IPC channel.
  volumes[`${projectName}-fuxa-data`] = {}
  services['fuxa'] = {
    image: 'frangoteam/fuxa:latest',
    container_name: `${projectName}-fuxa`,
    restart: 'unless-stopped',
    networks: {
      'control-net': { ipv4_address: `${controlBase}.243` },
      // Second leg on ot-net lets FUXA reach PLC Modbus servers (port 502) directly
      'ot-net': { ipv4_address: `${otBase}.243` },
      // monitoring-net: non-internal bridge required for Docker Desktop to publish port 1881
      'monitoring-net': { ipv4_address: `${monitorBase}.4` }
    },
    // Publish port 1881 so Electron can open FUXA in a separate BrowserWindow
    ports: ['1881:1881'],
    environment: undefined,
    cap_add: undefined,
    volumes: [`${projectName}-fuxa-data:/usr/src/app/FUXA/server/_appdata`],
    // Healthcheck: FUXA's Node.js HTTP server responds once the process graphics engine
    // is ready. wget is used since curl is not in the frangoteam/fuxa image.
    healthcheck: {
      test: ['CMD-SHELL', 'wget --quiet --tries=1 --spider http://localhost:1881 || exit 1'],
      interval: '5s',
      timeout: '3s',
      retries: 15,
      start_period: '30s'
    },
    // Increased from 100m — FUXA's Node.js runtime needs ~180m when polling multiple PLCs
    deploy: { resources: { limits: { memory: '256m', cpus: '0.5' } } }
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
function findZoneForIp(ip: string, scenario: OTForgeScenario): NetworkZone | null {
  for (const seg of scenario.network.segments) {
    if (ipInSubnet(ip, seg.subnet)) return seg.zone
  }
  return null
}

/**
 * Determines which Purdue Model zone a device IP belongs to using the canonical
 * ZONE_DEFAULTS subnets, independent of any scenario-declared segments.
 *
 * This is the fallback used when findZoneForIp returns null — most commonly when
 * the scenario was created without explicit network segments (e.g., via
 * handleAttackMachineAdd which initialises segments as []). Without this fallback
 * every device would be assigned to 'ot-net' regardless of its IP address, causing
 * Docker to reject IPs that fall outside the OT subnet (10.200.10.0/24).
 *
 * @param ip - The device's static IPv4 address.
 * @returns  The NetworkZone whose ZONE_DEFAULTS subnet contains the IP, or null.
 */
function findZoneForIpInDefaults(ip: string): NetworkZone | null {
  const zoneOrder: NetworkZone[] = [
    'ot',
    'control',
    'plant-dmz',
    'enterprise',
    'internet-dmz',
    'attacker'
  ]
  for (const zone of zoneOrder) {
    if (ipInSubnet(ip, ZONE_DEFAULTS[zone].subnet)) return zone
  }
  return null
}

/**
 * Translates a device's scenario IP to the corresponding IP in the effective
 * Docker network subnet, preserving the host octet.
 *
 * When subnet auto-detection (or user-pinned settings) selects a different /24
 * than the scenario's network.segments declare, Docker rejects the original IP
 * as "address not in network". This function keeps the last octet (the host part
 * of a /24) and replaces the first three octets with the effective prefix.
 *
 * Example:
 *   scenario segment:  OT = 10.200.10.0/24
 *   effectiveZones:    OT = 10.201.10.0/24   (auto-detect chose this to avoid conflict)
 *   device IP:             10.200.10.15
 *   → translated IP:       10.201.10.15       (same host octet .15, new prefix)
 *
 * No translation is performed when the effective subnet already matches the
 * scenario segment. Falls back to matching against ZONE_DEFAULTS for scenarios
 * that pre-date the full four-segment definition.
 *
 * @param deviceIp      - Device's IPv4 address from the scenario document.
 * @param scenario      - Scenario whose segments identify the device's zone.
 * @param effectiveZones - Resolved zone → subnet map (auto-detected or pinned).
 * @returns The device's IP rewritten for the effective subnet, or the original if
 *   no matching segment is found (conservative fallback, should not occur in practice).
 */
function resolveDeviceIp(
  deviceIp: string,
  scenario: OTForgeScenario,
  effectiveZones: Record<NetworkZone, { subnet: string; gateway: string }>
): string {
  // Walk the scenario's declared segments first (most specific match)
  for (const seg of scenario.network.segments) {
    if (!ipInSubnet(deviceIp, seg.subnet)) continue
    const effectiveSub = effectiveZones[seg.zone].subnet
    if (effectiveSub === seg.subnet) return deviceIp // already in the right subnet
    const hostOctet = deviceIp.split('.')[3]
    return `${effectiveSub.replace('.0/24', '')}.${hostOctet}`
  }
  // Fallback: match against ZONE_DEFAULTS for legacy scenarios without full segment lists.
  // Includes old zone names (it, dmz, external) so scenarios built before the 6-zone
  // Purdue refactor continue to translate IPs correctly after an upgrade.
  for (const zone of [
    'ot',
    'control',
    'plant-dmz',
    'enterprise',
    'internet-dmz',
    'attacker'
  ] as NetworkZone[]) {
    if (!ipInSubnet(deviceIp, ZONE_DEFAULTS[zone].subnet)) continue
    const effectiveSub = effectiveZones[zone].subnet
    if (effectiveSub === ZONE_DEFAULTS[zone].subnet) return deviceIp
    const hostOctet = deviceIp.split('.')[3]
    return `${effectiveSub.replace('.0/24', '')}.${hostOctet}`
  }
  return deviceIp // unrecognized subnet — pass through unchanged
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
  device: OTForgeScenario['devices']['devices'][string],
  _scenario: OTForgeScenario
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

  // EtherNet/IP CIP configuration — consumed by OpenPLC Runtime (port 44818 always
  // active on the Linux driver) and any future standalone EtherNet/IP adapter containers.
  // ENIP_PORT and ENIP_SLOT are read by the OpenPLC entrypoint for logging and by
  // custom EtherNet/IP server images that need runtime configuration.
  if (device.ethernetip) {
    env.push(`ENIP_PORT=${device.ethernetip.port}`)
    env.push(`ENIP_SLOT=${device.ethernetip.slot}`)
  }

  // Siemens S7comm configuration — consumed by containers/conpot/server.py
  // (DEVICE_CATEGORY=legacy-plc). S7_DEVICE_TYPE selects the CPU model which
  // determines the order number and firmware version returned in SZL responses.
  if (device.s7) {
    env.push(`S7_DEVICE_TYPE=${device.s7.deviceType}`)
    env.push(`S7_PORT=${device.s7.port}`)
  }

  // IEC 60870-5-104 configuration — consumed by containers/conpot/server.py
  // (DEVICE_CATEGORY=iec104-rtu). The common address identifies this RTU on
  // a multi-drop IEC 104 segment; each RTU must have a unique common address.
  if (device.iec104) {
    env.push(`IEC104_COMMON_ADDRESS=${device.iec104.commonAddress}`)
    env.push(`IEC104_PORT=${device.iec104.port}`)
  }

  // Phase 11: Physical process simulation — consumed by containers/process-sim/sim.py.
  // All parameters have sensible defaults in the container; only set env vars for
  // values that differ from the Dockerfile defaults to keep the Compose YAML clean.
  if (device.processUnit) {
    const pu = device.processUnit
    env.push(`PROCESS_TYPE=${pu.processType}`)
    if (pu.simDtMs !== undefined) env.push(`SIM_DT_MS=${pu.simDtMs}`)
    if (pu.tankVolumeL !== undefined) env.push(`TANK_VOLUME_L=${pu.tankVolumeL}`)
    if (pu.tankAreaM2 !== undefined) env.push(`TANK_AREA_M2=${pu.tankAreaM2}`)
    if (pu.pumpFlowMaxLpm !== undefined) env.push(`PUMP_FLOW_MAX_LPM=${pu.pumpFlowMaxLpm}`)
    if (pu.valveFlowMaxLpm !== undefined) env.push(`VALVE_FLOW_MAX_LPM=${pu.valveFlowMaxLpm}`)
    if (pu.initialLevelPct !== undefined) env.push(`INITIAL_LEVEL_PCT=${pu.initialLevelPct}`)
    if (pu.generatorRatedMw !== undefined) env.push(`GENERATOR_RATED_MW=${pu.generatorRatedMw}`)
    if (pu.generatorInertiaH !== undefined) env.push(`GENERATOR_INERTIA_H=${pu.generatorInertiaH}`)
    if (pu.generatorFreqBase !== undefined) env.push(`GENERATOR_FREQ_BASE=${pu.generatorFreqBase}`)
    if (pu.pipelineVolumeL !== undefined) env.push(`PIPELINE_VOLUME_L=${pu.pipelineVolumeL}`)
    if (pu.pipelinePumpMaxLpm !== undefined)
      env.push(`PIPELINE_PUMP_MAX_LPM=${pu.pipelinePumpMaxLpm}`)
  }

  // Phase 12: DNS server — inject domain and web server IP from the optional DnsConfig.
  // The container Dockerfile already sets DNS_DOMAIN=meridian-process.com and
  // WEB_SERVER_IP=203.0.113.10 as defaults; these overrides are only emitted when
  // the scenario explicitly configures different values, keeping the Compose YAML clean.
  if (device.dns) {
    if (device.dns.domain) env.push(`DNS_DOMAIN=${device.dns.domain}`)
    if (device.dns.webServerIp) env.push(`WEB_SERVER_IP=${device.dns.webServerIp}`)
    // Use !== undefined (not truthiness check) so that upstream: "" correctly
    // injects DNS_UPSTREAM= (empty), overriding the container default of 8.8.8.8.
    // An empty value triggers air-gapped mode in the dns entrypoint.sh.
    if (device.dns.upstream !== undefined) env.push(`DNS_UPSTREAM=${device.dns.upstream}`)
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
