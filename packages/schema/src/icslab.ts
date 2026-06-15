// .otflab scenario file format — the canonical exchange format for OTForge scenarios.
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
  | 's7comm' // Siemens S7 Communication (S7-300/400/1200/1500, port 102)
  | 'iec-104' // IEC 60870-5-104 telecontrol protocol (port 2404)
  | 'mqtt' // Message Queuing Telemetry Transport — IIoT sensors, cloud gateways, broker-based pub/sub
  | 'none'

/**
 * Physical cable / media types used in ICS and IT network infrastructure.
 *
 * Organized by media family:
 *   Ethernet twisted-pair — cat5e (100 Mbps), cat6 (1 Gbps), cat6a (10 Gbps)
 *   Fiber optic            — smf (single-mode, long-haul), mmf (multi-mode, in-building)
 *   Wireless               — wifi (802.11 a/b/g/n/ac/ax; WirelessHART; ISA100)
 *   Serial                 — rs232 (point-to-point console), rs485 (multi-drop field bus)
 *   Storage                — sata (Serial ATA; direct-attached storage, server disk buses)
 *   Power                  — ac (mains power), dc (24 VDC instrument power)
 *
 * Cable type is OPTIONAL on canvas edges; omitting it means the physical medium
 * is not specified. When present, connectionRules enforces that:
 *   1. Both endpoint device categories can physically terminate that medium.
 *   2. The chosen application protocol is compatible with that medium
 *      (e.g., Modbus RTU only runs on RS-232/RS-485; Modbus TCP requires Ethernet/WiFi).
 */
export type CableType =
  | 'cat5e' // Ethernet Cat5e — 100 Mbps, twisted pair, typical OT field network
  | 'cat6' // Ethernet Cat6  — 1 Gbps, twisted pair, control center / enterprise
  | 'cat6a' // Ethernet Cat6a — 10 Gbps, twisted pair, data center / spine links
  | 'smf' // Single-Mode Fiber — long-distance backbone (inter-building, inter-zone)
  | 'mmf' // Multi-Mode Fiber  — short-distance fiber (within substation / building)
  | 'wifi' // Wireless 802.11 / WirelessHART / ISA100 — mobile HMI, wireless field devices
  | 'rs232' // Serial RS-232 — point-to-point console / programming cable
  | 'rs485' // Serial RS-485 — multi-drop field bus, Modbus RTU / serial instruments
  | 'sata' // Serial ATA — direct-attached storage, server/historian disk interface
  | 'ac' // AC mains power cable
  | 'dc' // DC instrument power (24 VDC, loop-powered sensors and actuators)

/**
 * Network zones following the Purdue Reference Model (IEC 62443-3-2 / NIST SP 800-82).
 *   ot           — Levels 0–2:   Field devices — PLCs, RTUs, IEDs, sensors, actuators
 *   control      — Level 3:      Control Center/Processing LAN — HMIs, historians, app/db servers
 *   plant-dmz    — Level 3.5:    Plant DMZ — firewalls, IDS/IPS, jump hosts
 *   enterprise   — Level 4:      Enterprise Zone — domain controllers, business servers, desktops
 *   internet-dmz — Level 5:      Internet DMZ — email and internet-facing servers
 *   attacker     — Red Team:     Isolated attack machine subnet (not shown in Purdue layer tabs)
 */
export type NetworkZone =
  | 'ot'
  | 'control'
  | 'plant-dmz'
  | 'enterprise'
  | 'internet-dmz'
  | 'attacker'

export type DeviceCategory =
  // ── OT Process (Levels 0–2) ──────────────────────────────────────────────────
  | 'plc'
  | 'rtu'
  | 'ied'
  | 'safety-plc' // Safety Instrumented System / Safety PLC (IEC 61511) — Triconex, Siemens Safety
  | 'dcs-controller' // Distributed Control System controller — Honeywell, Emerson DeltaV, ABB 800xA
  | 'vfd' // Variable Frequency Drive / motor drive — AC drives with Modbus/EtherNet/IP
  | 'legacy-plc' // Siemens S7-300/400/1200/1500 via S7comm (Phase 10)
  | 'iec104-rtu' // IEC 60870-5-104 RTU via conpot emulation (Phase 10)
  | 'process-unit' // Physics-simulated process unit: water tank, pipeline, generator (Phase 11)
  | 'sensor'
  | 'actuator'
  | 'pump'
  | 'valve'
  | 'flow-meter'
  | 'pressure-transmitter'
  | 'level-transmitter' // Tank/vessel level measurement — ultrasonic, radar, float (4-20 mA / HART)
  | 'analyzer' // Online process analyzer — chromatograph, pH, TOC, conductivity
  | 'pmu' // Phasor Measurement Unit — IEEE C37.118 synchrophasor, GPS-timestamped grid telemetry
  | 'iiot-sensor' // IIoT wireless sensor node — WirelessHART, ISA100.11a, MQTT publisher
  | 'iot-gateway' // IIoT protocol gateway — Modbus-to-MQTT/REST bridge, edge aggregator
  // ── Control Center (Level 3) ─────────────────────────────────────────────────
  | 'hmi'
  | 'historian'
  | 'scada-server' // SCADA master station / polling engine — distinct from HMI operator console
  | 'application-server'
  | 'database-server'
  | 'engineering-workstation'
  // ── Plant DMZ (Level 3.5) ────────────────────────────────────────────────────
  | 'firewall'
  | 'ids-ips'
  | 'switch'
  | 'router'
  | 'jump-server' // Bastion host / jump server — hardened remote-access gateway into OT network
  | 'data-diode' // Unidirectional security gateway (Waterfall, Owl) — OT→IT data-only, no reverse path
  | 'wap' // Wireless Access Point — industrial 802.11, WirelessHART AP, mobile HMI uplink
  // ── Enterprise Zone (Level 4) ────────────────────────────────────────────────
  | 'domain-controller'
  | 'web-server'
  | 'business-server'
  | 'enterprise-desktop'
  // ── Internet DMZ (Level 5) ───────────────────────────────────────────────────
  | 'email-server'
  | 'internet-server'
  | 'dns-server' // Authoritative/recursive DNS server — meridian-process.com zone (Phase 12)
  // ── Red Team ─────────────────────────────────────────────────────────────────
  | 'attack-machine'

// ── Visual layer ─────────────────────────────────────────────────────────────

export interface CanvasPosition {
  x: number
  y: number
}

export interface CanvasNode {
  id: string
  type: string // matches DeviceTypeDefinition.id
  position: CanvasPosition
  data: {
    label: string
    zone: NetworkZone
  }
}

export interface CanvasEdge {
  id: string
  source: string // node id
  target: string // node id
  data: {
    protocol: Protocol
    label?: string
    /**
     * Optional physical cable / media type for this connection.
     * When set, the canvas renders a second label chip on the edge showing the
     * cable type. connectionRules validates that the cable is appropriate for
     * the source and target device categories.
     * When absent, the physical medium is not specified (protocol-only view).
     */
    cableType?: CableType
    /**
     * Optional coil binding for OT-layer pipe flow animation.
     * When set, the SCADA canvas polls the named PLC coil at runtime and colors
     * the pipe edge green (flowing) or red (stopped) based on the coil state.
     */
    coilSource?: {
      /** nodeId of the PLC device in the scenario device map. */
      nodeId: string
      /** Zero-based Modbus coil address (FC01). */
      coilIndex: number
    }
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
  subnet: string // e.g. "172.20.10.0/24"
  gateway: string // e.g. "172.20.10.1"
  dockerNetwork: string // e.g. "otforge-ot-net"
}

export interface StaticRoute {
  destination: string
  gateway: string
  via: NetworkZone // which segment the route is on
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
    coils?: Record<string, number> // address → initial value (0/1)
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

/**
 * Configuration for a Siemens S7 legacy PLC emulated by containers/conpot.
 * The emulator presents a real S7comm handshake (RFC 1006 / COTP / S7 PDU)
 * that Nmap s7-enumerate and Metasploit siemens_simatic_manager can fingerprint.
 */
export interface S7Config {
  /** Siemens CPU model series — determines order number and firmware in SZL responses. */
  deviceType: '300' | '400' | '1200' | '1500'
  /** S7 TSAP rack number (0 for S7-300, configurable for S7-400 multi-rack). */
  rack: number
  /** S7 TSAP slot number (2 for S7-300/400 CPU, 1 for S7-1200/1500). */
  slot: number
  /** ISO-TSAP port (RFC 1006) — always 102 in standard configurations. */
  port: number
}

/**
 * Configuration for an IEC 60870-5-104 RTU emulated by containers/conpot.
 * The emulator responds to STARTDT, TESTFR, and General Interrogation commands
 * and sends periodic floating-point process values (type M_ME_NC_1).
 */
export interface Iec104Config {
  /** ASDU Common Address — identifies this RTU on a multi-RTU segment (1–65535). */
  commonAddress: number
  /** TCP listening port (IEC 104 standard default is 2404). */
  port: number
}

export interface BacnetConfig {
  /**
   * BACnet device instance number — uniquely identifies this device on the
   * BACnet internetwork (0–4194302). Each device in the scenario must have
   * a distinct instance number for Who-Is / I-Am discovery to work correctly.
   */
  deviceInstance: number
  /** UDP port for BACnet/IP (standard default is 47808). */
  port?: number
}

export interface OpcUaConfig {
  port: number
  namespace: string
  nodes: Array<{ nodeId: string; name: string; dataType: string; value: unknown }>
}

/**
 * EtherNet/IP (CIP over TCP/UDP) configuration for PLCs and RTUs.
 *
 * EtherNet/IP is the primary Ethernet-based industrial protocol used by
 * Rockwell Automation (Allen-Bradley) controllers and most modern OT devices.
 * It carries the Common Industrial Protocol (CIP) and supports both:
 *   - Explicit messaging (TCP 44818) — configuration, programming, on-demand reads
 *   - Implicit messaging / I/O (UDP 2222) — real-time cyclic I/O data exchange
 *
 * OpenPLC Runtime v3's Linux driver compiles in a CIP server on port 44818 by
 * default. The same process variables exposed over Modbus are accessible via CIP
 * object classes (Assembly, Identity, MessageRouter).
 *
 * Tools that use this configuration:
 *   - FUXA HMI (EtherNet/IP driver) — connects to port/slot for live tag reads
 *   - pycomm3 / cpppo — Python libraries used in red-team exercises on Kali
 *   - Nmap NSE scripts (enip-info, cip-info) — fingerprinting during recon
 */
export interface EtherNetIPConfig {
  /**
   * TCP port for CIP explicit messaging.
   * Standard EtherNet/IP port — should always be 44818 unless a non-standard
   * deployment is being simulated.
   */
  port: number
  /**
   * Backplane slot number for the controller in its chassis.
   * 0 for single-controller chassis (most lab PLCs).
   * Needed by FUXA and pycomm3 when forming CIP connection paths.
   */
  slot: number
}

export interface PLCProgramConfig {
  language: 'ladder' | 'st'
  source: string // base64-encoded .st source file
  variables: Array<{
    name: string
    type: string
    address: string // IEC 61131-3 address e.g. %IX0.0
    protocol: Protocol
    protocolAddress: string
  }>
}

/**
 * Configuration for a physics-simulated process unit (Phase 11).
 * The process-sim container runs a real-time physics model and exposes
 * sensor values and control points as Modbus TCP registers.
 *
 * Process types and their primary Modbus outputs:
 *   water-tank  — HR 0 level (m), HR 1/2 inlet/outlet flow (L/min),
 *                 HR 3 hydrostatic pressure (bar), HR 4 temperature (°C)
 *   pipeline    — HR 3 line pressure (bar), HR 1/2 pump/outlet flow,
 *                 HR 0 fill % mapped to 0–10 m scale
 *   generator   — HR 6 frequency (Hz), HR 7 terminal voltage (%),
 *                 HR 8/9 active/reactive power (MW/MVAR)
 *   generic     — HR 0–3 configurable sine/sawtooth signals
 */
export interface ProcessUnitConfig {
  /** Physics model to run inside the container. */
  processType: 'water-tank' | 'pipeline' | 'generator' | 'generic'
  /** Simulation timestep in milliseconds (default 1000). Lower = faster transients. */
  simDtMs?: number

  // ── Water tank parameters ──────────────────────────────────────────────────
  /** Total tank capacity in liters (default 1000). */
  tankVolumeL?: number
  /** Tank cross-sectional area in m² — determines level from volume (default 1.0). */
  tankAreaM2?: number
  /** Maximum outlet pump flow rate in L/min at 100 % VFD speed (default 150). */
  pumpFlowMaxLpm?: number
  /** Maximum inlet flow rate in L/min at 100 % valve opening (default 200). */
  valveFlowMaxLpm?: number
  /** Starting fill level as 0–100 % of TANK_VOLUME_L (default 50). */
  initialLevelPct?: number

  // ── Generator parameters ───────────────────────────────────────────────────
  /** Rated active power output in MW (default 100). */
  generatorRatedMw?: number
  /** Generator inertia constant H in seconds (default 6). Higher = slower frequency swings. */
  generatorInertiaH?: number
  /** Nominal (synchronous) frequency in Hz: 50 for European, 60 for North American (default 50). */
  generatorFreqBase?: number

  // ── Pipeline parameters ────────────────────────────────────────────────────
  /** Internal pipeline volume in liters — affects pressure response speed (default 500). */
  pipelineVolumeL?: number
  /** Maximum pump flow rate into the pipeline in L/min (default 300). */
  pipelinePumpMaxLpm?: number
}

/**
 * Runtime configuration for an otforge-dns container (Phase 12).
 *
 * The container runs dnsmasq serving an authoritative zone for a fictitious
 * industrial company. Students start here with OSINT and then pivot to the
 * OT network using IPs/credentials they discover in the web server HTML source.
 *
 * All fields are optional — the container Dockerfile sets safe defaults:
 *   DNS_DOMAIN      = meridian-process.com
 *   WEB_SERVER_IP   = 203.0.113.10   (RFC 5737 documentation prefix)
 *   DNS_UPSTREAM    = 8.8.8.8
 *   MAIL_SERVER_IP  = (same as WEB_SERVER_IP when omitted)
 */
export interface DnsConfig {
  /** Authoritative domain served by this dnsmasq instance (default: meridian-process.com). */
  domain?: string
  /** A-record IP injected for www.<domain> — should match the internet-server IP (default: 203.0.113.10). */
  webServerIp?: string
  /**
   * A-record IP injected for mail.<domain> and MX record target.
   * Should match the email-server device IP in the scenario.
   * When omitted the DNS entrypoint defaults to the same value as WEB_SERVER_IP.
   */
  mailServerIp?: string
  /** Upstream recursive resolver for non-authoritative queries (default: 8.8.8.8). */
  upstream?: string
}

/**
 * Runtime configuration for an otforge-mail container.
 *
 * The container runs an open-relay SMTP server (aiosmtpd on port 25) that
 * accepts all inbound mail without authentication -- modelling the insecure
 * legacy mail infrastructure common in ICS environments.
 *
 * Students exploit this to send phishing emails from Kali using:
 *   curl --url smtp://<mail-ip>:25/ \
 *        --mail-from attacker@evil.com \
 *        --mail-rcpt it@meridian-process.com \
 *        --upload-file phishing.txt
 *
 * All received messages are logged to stdout and saved to /var/mail/ inside
 * the container for forensic verification.
 *
 * All fields are optional — the container Dockerfile sets safe defaults:
 *   MAIL_DOMAIN = meridian-process.com
 */
export interface MailConfig {
  /**
   * Domain displayed in the startup banner and accepted by the SMTP server.
   * (default: meridian-process.com)
   */
  domain?: string
}

/**
 * Safety Instrumented System configuration for safety-plc devices (IEC 61511).
 *
 * These fields are informational — they are injected as environment variables
 * into the OpenPLC container so students can see the SIS parameters in the
 * properties panel and in container logs, reinforcing SIS design concepts.
 * The underlying runtime is OpenPLC; no SIL certification is implied.
 */
export interface SafetyPlcConfig {
  /**
   * Plain-language description of the safety function this SIS performs.
   * Displayed in the properties panel and injected as SIS_FUNCTION env var.
   * Example: "High Pressure Shutdown — reactor feed isolation"
   */
  sisFunction?: string
  /**
   * Voting architecture for redundant sensor inputs (IEC 61511 terminology).
   * Injected as SIS_VOTING env var.
   *   1oo1 = single sensor, trip on fault
   *   2oo3 = two-out-of-three (most common for SIL 2 applications)
   */
  votingConfig?: '1oo1' | '1oo2' | '2oo2' | '2oo3' | '1oo3'
  /**
   * Proof-test interval in hours — how often the SIS is functionally tested.
   * Injected as SIS_PROOF_TEST_INTERVAL_HR env var for display purposes.
   * Typical values: 8760 (annual), 4380 (semi-annual), 2190 (quarterly).
   */
  proofTestIntervalHr?: number
  /**
   * Human-readable description of the safe state this SIS drives to on trip.
   * Injected as SIS_SAFE_STATE env var.
   * Example: "Close SDV-101, de-energize ESD relay K1"
   */
  safeState?: string
}

/**
 * Telemetry-focused communication link used by field RTUs to reach the SCADA master.
 * RTUs are deployed in remote or harsh environments (pipelines, power grid, water)
 * where cellular, radio, and satellite are the primary uplink choices.
 *   cellular    — 4G/5G or legacy 2G/3G GPRS; internet-exposed unless on private APN/VPN
 *   radio       — licensed or 900 MHz ISM band; unauthenticated by default
 *   satellite   — VSAT; high latency, often bypasses corporate monitoring stack
 *   mqtt        — MQTT broker over IP/cellular (IIoT edge-to-cloud telemetry pattern)
 *   dnp3-serial — DNP3 over RS-485/232 serial to a radio or telephone modem (classic SCADA)
 */
export type RtuCommType = 'cellular' | 'radio' | 'satellite' | 'mqtt' | 'dnp3-serial'

/**
 * Primary industrial protocol carried between the RTU and the SCADA master.
 * DNP3 and IEC 60870-5-104 are the most common for electric utility and pipeline RTUs.
 * Modbus RTU / TCP is ubiquitous in legacy installations.
 */
export type RtuProtocol = 'dnp3' | 'modbus-rtu' | 'modbus-tcp' | 'iec-104'

/**
 * Whether the RTU sends data only when values change (Report by Exception),
 * is polled on a fixed interval by the master, or both.
 *
 * Security implication: Report-by-Exception makes anomaly detection harder because
 * the master only learns of a value change when the RTU decides to report it.
 * Subtle process drift can go unreported for extended periods.
 */
export type RtuOperatingMode = 'report-by-exception' | 'polled' | 'hybrid'

/**
 * Primary power supply for the RTU field unit.
 * Physical attack surface varies by supply type:
 *   ac            — mains-powered; disrupting shore power kills telemetry
 *   solar-battery — common on remote pipeline stations; battery drain = denial of service
 *   battery       — battery-only deployments have finite operational life
 *   dc            — 24 VDC instrument bus; loss of instrument power affects all loop devices
 */
export type RtuPowerSource = 'ac' | 'solar-battery' | 'battery' | 'dc'

/**
 * Deployment configuration for an RTU (Remote Terminal Unit).
 *
 * RTUs differ from PLCs in their intended environment (remote, harsh conditions),
 * communication medium (cellular, radio, satellite for SCADA backhaul), and
 * programming model (pre-configured drop-down menus, not ladder logic or ST programs).
 * These settings are injected as container environment variables so students can
 * inspect them during red-team and blue-team exercises.
 */
export interface RtuConfig {
  /** Physical or wireless link used to reach the SCADA master. */
  commType: RtuCommType
  /** Primary industrial protocol carried over the communication link. */
  primaryProtocol: RtuProtocol
  /** Whether the RTU reports by exception, is polled on a schedule, or both. */
  operatingMode: RtuOperatingMode
  /** Poll interval in seconds — relevant when operatingMode is polled or hybrid. Default: 60. */
  pollIntervalSec: number
  /** Power supply type — affects physical availability attack surface. */
  powerSource: RtuPowerSource
  /** Free-text description of the physical installation site (e.g. "Pipeline pump station 3"). */
  siteType?: string
}

export interface DeviceConfig {
  nodeId: string // matches CanvasNode.id
  category: DeviceCategory
  /** Author-assigned display name shown on the canvas node. Falls back to the category label when absent. */
  label?: string
  ipAddress: string
  protocols: Protocol[]
  modbus?: ModbusConfig
  dnp3?: DNP3Config
  opcua?: OpcUaConfig
  bacnet?: BacnetConfig // BACnet/IP config (sensor devices)
  ethernetip?: EtherNetIPConfig // EtherNet/IP CIP config (plc, rtu devices)
  s7?: S7Config // Siemens S7comm config (legacy-plc devices, Phase 10)
  iec104?: Iec104Config // IEC 60870-5-104 config (iec104-rtu devices, Phase 10)
  processUnit?: ProcessUnitConfig // Physics process simulation config (Phase 11)
  dns?: DnsConfig // DNS server config (dns-server devices, Phase 12)
  mail?: MailConfig // Mail server config (email-server devices)
  plcProgram?: PLCProgramConfig
  safetyPlc?: SafetyPlcConfig // SIS config for safety-plc devices
  rtuConfig?: RtuConfig // RTU deployment configuration (rtu, iec104-rtu devices)
  dockerImage?: string // override default image for this device type
  /**
   * Additional Purdue Model zone networks to attach this device to, beyond the
   * zone determined by its ipAddress. Used to model intentional misconfigurations
   * (e.g., an attack machine given direct OT access to simulate missing segmentation)
   * or multi-homed devices (e.g., a jump host spanning enterprise and control zones).
   *
   * Each zone name maps to that zone's Docker bridge network; the compose generator
   * auto-assigns a free IP in the .200-.239 host range of that subnet.
   */
  extraNetworks?: NetworkZone[]
}

export interface DeviceLayer {
  devices: Record<string, DeviceConfig> // keyed by nodeId
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
  enabledRulesets: string[] // e.g. ["emerging-scada", "emerging-modbus"]
  disabledRuleIds: number[] // individual Suricata SID overrides
  zeekScripts: string[] // e.g. ["modbus.zeek", "dnp3.zeek"]
  /**
   * Raw Suricata rule text authored in the IDSPanel.
   * Injected as IDS_CUSTOM_RULES_B64 (base64) by compose-generator and decoded
   * to /etc/suricata/rules/custom.rules inside the container at startup.
   * Undefined / empty string means no custom rules file is written.
   */
  customRules?: string
}

export interface SecurityLayer {
  defaultFirewallPolicy: ACLAction // default-deny or default-allow
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
  id: string // unique key e.g. "plc-siemens-s7"
  category: DeviceCategory
  label: string // display name e.g. "Siemens S7-300 PLC"
  iconPath: string // relative path to SVG icon
  defaultProtocols: Protocol[]
  defaultDockerImage: string // GHCR image reference
  defaultPorts: number[]
  configSchema: string // JSON Schema for DeviceConfig validation
  sector?: Sector // null = available in all sectors
}

// ── Scenario pack attack layer ─────────────────────────────────────────────────

export interface DockerLayer {
  image: string // GHCR image e.g. "ghcr.io/ics-sim/attack-oilgas:1.0"
  extendsImage: string // base image this FROM-extends
  description: string
}

// ── Resource estimation ────────────────────────────────────────────────────────

export interface ResourceEstimate {
  estimatedRamMb: number
  estimatedCpuCores: number
  containerCount: number
}

// ── Tutorial system ────────────────────────────────────────────────────────────

/**
 * A single step in a guided tutorial scenario (Phase 13 — Tutorial 01).
 *
 * Tutorial steps are embedded in the scenario's `meta.tutorialSteps` array and
 * displayed in the TutorialPanel floating overlay in both Author and Student modes.
 *
 * The `command` field, if present, is rendered in a copy-to-clipboard code block
 * so students can paste it directly into the attack terminal without typos.
 *
 * The `successCheck` field is a plain-English hint about what the student should
 * observe to confirm the step succeeded (not machine-evaluated — educational UX).
 */
export interface TutorialStep {
  /** Unique identifier for this step — used as React key and progress anchor. */
  id: string
  /** Short title shown in the step header (e.g. "Step 1 — Discover the Target"). */
  title: string
  /** Full instructional body in Markdown (rendered in the panel). */
  body: string
  /** Optional shell command shown in a copy-to-clipboard code block. */
  command?: string
  /** Optional plain-English hint describing what success looks like. */
  successCheck?: string
}

// ── Root .otflab document ──────────────────────────────────────────────────────

export interface OTForgeMeta {
  formatVersion: '1.0'
  name: string
  description: string
  sector: Sector
  author: string
  createdAt: string // ISO 8601
  updatedAt: string
  appVersion: string // minimum OTForge version required
  locked: boolean
  /**
   * When true, the mode badge in the toolbar is a clickable toggle that lets
   * the student switch between Student Mode and Author Mode. Only set on
   * scenarios specifically designed to teach the OTForge interface (e.g. the
   * Navigation Tutorial). All attack labs and regular Student Copy scenarios
   * leave this unset (defaults to false) so the Student Mode badge is always
   * static — students cannot accidentally enter edit mode mid-lab.
   */
  allowModeToggle?: boolean
  brief: string // Markdown — mission objectives shown in Student mode
  requirements: ResourceEstimate
  /**
   * Guided tutorial steps embedded in the scenario.
   * When present, the TutorialPanel floating overlay is shown automatically
   * on scenario load, walking the student through the attack chain step by step.
   */
  tutorialSteps?: TutorialStep[]
}

export interface OTForgeScenario {
  meta: OTForgeMeta
  visual: VisualLayer // omitted in locked export
  network: NetworkLayer
  devices: DeviceLayer
  security: SecurityLayer // omitted in locked export
  registry: DeviceTypeDefinition[] // pack-supplied device type extensions
  packLayers: DockerLayer[] // attack tool layers from scenario pack
}
