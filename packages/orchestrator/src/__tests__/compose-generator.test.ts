/**
 * compose-generator.test.ts — Unit tests for Docker Compose file generation.
 *
 * generateCompose() is the core of the simulation engine. A bug here means
 * containers get wrong IPs, wrong images, wrong capabilities, or wrong port
 * mappings — all silent until someone tries to run the scenario. These tests
 * catch regressions before they reach a user's machine.
 *
 * Testing approach:
 *   - Call generateCompose() with controlled scenario fixtures.
 *   - Parse the resulting YAML string with js-yaml.
 *   - Assert on the parsed object structure rather than on raw YAML text, so
 *     tests do not break when formatting or key ordering changes.
 *
 * Coverage target — each special-case branch in generateCompose():
 *   - Firewall multi-zone attachment + capability grants
 *   - Attack machine external-only isolation + capability grants
 *   - PLC web UI port publishing (deterministic sequential assignment)
 *   - Protocol environment variable injection (Modbus, DNP3, OPC-UA)
 *   - PLC program pre-load via INITIAL_PROGRAM_B64
 *   - Infrastructure services always present (Suricata, Zeek, InfluxDB, etc.)
 *   - Default zone subnet backfill for zones not defined in the scenario
 */

import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { generateCompose } from '../compose-generator'
import type { ICSLabScenario, DeviceConfig, NetworkZone } from '@ics-sim/schema'

// ── Parsed compose types ──────────────────────────────────────────────────────

interface ParsedService {
  image: string
  container_name: string
  restart: string
  networks: Record<string, { ipv4_address: string }>
  environment?: string[]
  cap_add?: string[]
  ports?: string[]
  volumes?: string[]
  deploy: { resources: { limits: { memory: string; cpus: string } } }
}

interface ParsedCompose {
  name: string
  services: Record<string, ParsedService>
  networks: Record<
    string,
    {
      driver: string
      ipam: { config: Array<{ subnet: string; gateway: string }> }
    }
  >
  volumes?: Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generates compose YAML and returns the parsed object. */
function gen(scenario: ICSLabScenario, projectName = 'test-proj'): ParsedCompose {
  return yaml.load(generateCompose(scenario, projectName)) as ParsedCompose
}

type DeviceOverrides = Partial<DeviceConfig> & Pick<DeviceConfig, 'category' | 'ipAddress'>

/**
 * Builds a minimal type-correct ICSLabScenario for testing.
 * Only fields that generateCompose() reads are populated.
 */
function makeScenario(
  deviceEntries: Array<[string, DeviceOverrides]>,
  segmentZones: Array<{ zone: NetworkZone; subnet: string; gateway: string }> = []
): ICSLabScenario {
  const devices: ICSLabScenario['devices']['devices'] = {}
  for (const [id, d] of deviceEntries) {
    devices[id] = { nodeId: id, protocols: [], ...d }
  }
  return {
    meta: {
      formatVersion: '1.0',
      name: 'Test',
      description: '',
      sector: 'water-treatment',
      author: 'test',
      createdAt: '',
      updatedAt: '',
      appVersion: '0.1.0',
      locked: false,
      brief: '',
      requirements: { estimatedRamMb: 0, estimatedCpuCores: 0, containerCount: 0 }
    },
    visual: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    network: {
      segments: segmentZones.map(s => ({ ...s, dockerNetwork: `ics-sim-${s.zone}-net` })),
      routes: []
    },
    devices: { devices },
    security: {
      defaultFirewallPolicy: 'deny',
      firewallRules: [],
      ids: { enabledRulesets: [], disabledRuleIds: [], zeekScripts: [] },
      logging: { retentionDays: 30, influxdbEnabled: true, lokiEnabled: true }
    },
    registry: [],
    packLayers: []
  }
}

// ── Docker networks ───────────────────────────────────────────────────────────

describe('Docker networks', () => {
  it('always emits all four zone networks even when the scenario only defines one segment', () => {
    const scenario = makeScenario(
      [['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }]],
      [{ zone: 'ot', subnet: '172.20.10.0/24', gateway: '172.20.10.1' }]
    )
    const compose = gen(scenario)
    expect(compose.networks).toHaveProperty('ot-net')
    expect(compose.networks).toHaveProperty('it-net')
    expect(compose.networks).toHaveProperty('dmz-net')
    expect(compose.networks).toHaveProperty('external-net')
  })

  it('uses an explicit scenario subnet when a zone segment is provided', () => {
    const scenario = makeScenario(
      [['plc-1', { category: 'plc', ipAddress: '10.0.1.10' }]],
      [{ zone: 'ot', subnet: '10.0.1.0/24', gateway: '10.0.1.1' }]
    )
    const compose = gen(scenario)
    expect(compose.networks['ot-net'].ipam.config[0].subnet).toBe('10.0.1.0/24')
    expect(compose.networks['ot-net'].ipam.config[0].gateway).toBe('10.0.1.1')
  })

  it('fills in ZONE_DEFAULT subnets for zones not present in the scenario segments', () => {
    // No segments defined — all four should come from defaults
    const scenario = makeScenario([['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }]])
    const compose = gen(scenario)
    expect(compose.networks['ot-net'].ipam.config[0].subnet).toBe('172.20.10.0/24')
    expect(compose.networks['it-net'].ipam.config[0].subnet).toBe('172.20.20.0/24')
    expect(compose.networks['dmz-net'].ipam.config[0].subnet).toBe('172.20.30.0/24')
    expect(compose.networks['external-net'].ipam.config[0].subnet).toBe('172.20.40.0/24')
  })

  it('sets driver to "bridge" for all zone networks', () => {
    const compose = gen(makeScenario([['s1', { category: 'sensor', ipAddress: '172.20.10.10' }]]))
    for (const net of Object.values(compose.networks)) {
      expect(net.driver).toBe('bridge')
    }
  })
})

// ── Device service generation ─────────────────────────────────────────────────

describe('image assignment', () => {
  it('uses the GHCR OpenPLC image for PLC devices', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }]]))
    expect(compose.services['plc-1'].image).toMatch(/ics-sim-openplc/)
  })

  it('uses the Modbus server image for RTU devices', () => {
    const compose = gen(makeScenario([['rtu-1', { category: 'rtu', ipAddress: '172.20.10.10' }]]))
    expect(compose.services['rtu-1'].image).toMatch(/ics-sim-modbus/)
  })

  it('uses the DNP3 outstation image for IED devices', () => {
    const compose = gen(makeScenario([['ied-1', { category: 'ied', ipAddress: '172.20.10.10' }]]))
    expect(compose.services['ied-1'].image).toMatch(/ics-sim-dnp3/)
  })

  it('uses a custom dockerImage override when provided on the device', () => {
    const compose = gen(
      makeScenario([
        [
          'plc-custom',
          {
            category: 'plc',
            ipAddress: '172.20.10.10',
            dockerImage: 'my.registry.com/custom-plc:v2'
          }
        ]
      ])
    )
    expect(compose.services['plc-custom'].image).toBe('my.registry.com/custom-plc:v2')
  })
})

describe('service name and container name', () => {
  it('lowercases node IDs and replaces underscores with hyphens', () => {
    const compose = gen(
      makeScenario([['PLC_Main_Unit', { category: 'plc', ipAddress: '172.20.10.10' }]])
    )
    expect(compose.services).toHaveProperty('plc-main-unit')
  })

  it('prefixes container_name with the project name', () => {
    const compose = gen(
      makeScenario([['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }]]),
      'my-project'
    )
    expect(compose.services['plc-1'].container_name).toBe('my-project-plc-1')
  })

  it('sets project name from the projectName argument', () => {
    const compose = gen(
      makeScenario([['s1', { category: 'sensor', ipAddress: '172.20.10.10' }]]),
      'ics-sim-water-plant'
    )
    expect(compose.name).toBe('ics-sim-water-plant')
  })
})

describe('resource limits', () => {
  it('assigns 128m memory limit to PLC devices (OpenPLC needs Ubuntu + build tools)', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }]]))
    expect(compose.services['plc-1'].deploy.resources.limits.memory).toBe('128m')
  })

  it('assigns 80m memory limit to RTU devices (pymodbus on Alpine)', () => {
    const compose = gen(makeScenario([['rtu-1', { category: 'rtu', ipAddress: '172.20.10.10' }]]))
    expect(compose.services['rtu-1'].deploy.resources.limits.memory).toBe('80m')
  })

  it('assigns 2048m memory limit to attack machine (Kali + Xfce4 desktop + Metasploit)', () => {
    const compose = gen(
      makeScenario([['kali-1', { category: 'attack-machine', ipAddress: '172.20.40.10' }]])
    )
    expect(compose.services['kali-1'].deploy.resources.limits.memory).toBe('2048m')
  })
})

describe('network attachment', () => {
  it('attaches a device to the zone that contains its IP address', () => {
    const scenario = makeScenario(
      [['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }]],
      [{ zone: 'ot', subnet: '172.20.10.0/24', gateway: '172.20.10.1' }]
    )
    const compose = gen(scenario)
    expect(compose.services['plc-1'].networks).toHaveProperty('ot-net')
    expect(compose.services['plc-1'].networks['ot-net'].ipv4_address).toBe('172.20.10.10')
  })

  it('falls back to ot-net when the device IP does not match any defined segment', () => {
    const scenario = makeScenario([['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }]])
    const compose = gen(scenario)
    expect(compose.services['plc-1'].networks).toHaveProperty('ot-net')
  })

  it('sets restart to "unless-stopped" for all device services', () => {
    const compose = gen(makeScenario([['s1', { category: 'sensor', ipAddress: '172.20.10.10' }]]))
    expect(compose.services['s1'].restart).toBe('unless-stopped')
  })
})

// ── Special device categories ─────────────────────────────────────────────────

describe('firewall device', () => {
  // Firewall must bridge OT/IT/DMZ at the same time to enforce inter-zone ACLs
  const firewallCompose = () =>
    gen(makeScenario([['fw-1', { category: 'firewall', ipAddress: '172.20.10.254' }]]))

  it('attaches to ot-net, it-net, and dmz-net simultaneously', () => {
    const nets = Object.keys(firewallCompose().services['fw-1'].networks)
    expect(nets).toContain('ot-net')
    expect(nets).toContain('it-net')
    expect(nets).toContain('dmz-net')
  })

  it('does NOT attach to external-net', () => {
    const nets = Object.keys(firewallCompose().services['fw-1'].networks)
    expect(nets).not.toContain('external-net')
  })

  it('grants NET_ADMIN for nftables rule management', () => {
    expect(firewallCompose().services['fw-1'].cap_add).toContain('NET_ADMIN')
  })

  it('grants NET_RAW for ICMP and raw socket access', () => {
    expect(firewallCompose().services['fw-1'].cap_add).toContain('NET_RAW')
  })
})

describe('attack-machine device', () => {
  // Kali must be on External only — it must not reach OT/IT directly
  const attackCompose = () =>
    gen(makeScenario([['kali-1', { category: 'attack-machine', ipAddress: '172.20.40.10' }]]))

  it('attaches ONLY to external-net, never to OT, IT, or DMZ', () => {
    const nets = Object.keys(attackCompose().services['kali-1'].networks)
    expect(nets).toEqual(['external-net'])
  })

  it('grants NET_ADMIN and NET_RAW for nmap raw scans and ARP operations', () => {
    expect(attackCompose().services['kali-1'].cap_add).toContain('NET_ADMIN')
    expect(attackCompose().services['kali-1'].cap_add).toContain('NET_RAW')
  })

  it('preserves the static IP on external-net', () => {
    expect(attackCompose().services['kali-1'].networks['external-net'].ipv4_address).toBe(
      '172.20.40.10'
    )
  })
})

// ── PLC port publishing ───────────────────────────────────────────────────────

describe('PLC port publishing', () => {
  it('publishes OpenPLC web UI on host port 18080 for the first PLC', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }]]))
    expect(compose.services['plc-1'].ports).toContain('18080:8080')
  })

  it('assigns sequential host ports to multiple PLCs — 18080, 18081, etc.', () => {
    // Object.entries() preserves insertion order (V8 guarantee for string keys),
    // mirroring the same ordering used by main/index.ts to build activePlcPorts.
    const compose = gen(
      makeScenario([
        ['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }],
        ['plc-2', { category: 'plc', ipAddress: '172.20.10.11' }]
      ])
    )
    expect(compose.services['plc-1'].ports).toContain('18080:8080')
    expect(compose.services['plc-2'].ports).toContain('18081:8080')
  })

  it('does not publish any ports for non-PLC devices', () => {
    const compose = gen(makeScenario([['rtu-1', { category: 'rtu', ipAddress: '172.20.10.10' }]]))
    expect(compose.services['rtu-1'].ports).toBeUndefined()
  })
})

// ── Environment variable injection ────────────────────────────────────────────

describe('environment variable injection', () => {
  it('always injects DEVICE_ID and DEVICE_CATEGORY for every device', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }]]))
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain('DEVICE_ID=plc-1')
    expect(env).toContain('DEVICE_CATEGORY=plc')
  })

  it('injects MODBUS_MODE, MODBUS_PORT, MODBUS_UNIT_ID when a Modbus config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'rtu-1',
          {
            category: 'rtu',
            ipAddress: '172.20.10.10',
            modbus: { mode: 'tcp', port: 502, unitId: 5, registers: {} }
          }
        ]
      ])
    )
    const env = compose.services['rtu-1'].environment ?? []
    expect(env).toContain('MODBUS_MODE=tcp')
    expect(env).toContain('MODBUS_PORT=502')
    expect(env).toContain('MODBUS_UNIT_ID=5')
  })

  it('injects DNP3_* vars when a DNP3 config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'ied-1',
          {
            category: 'ied',
            ipAddress: '172.20.10.10',
            dnp3: { masterAddress: 1, outstationAddress: 10, port: 20000 }
          }
        ]
      ])
    )
    const env = compose.services['ied-1'].environment ?? []
    expect(env).toContain('DNP3_MASTER_ADDRESS=1')
    expect(env).toContain('DNP3_OUTSTATION_ADDRESS=10')
    expect(env).toContain('DNP3_PORT=20000')
  })

  it('injects OPCUA_PORT and OPCUA_NAMESPACE when an OPC-UA config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'plc-1',
          {
            category: 'plc',
            ipAddress: '172.20.10.10',
            opcua: { port: 4840, namespace: 'urn:icslab:plc', nodes: [] }
          }
        ]
      ])
    )
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain('OPCUA_PORT=4840')
    expect(env).toContain('OPCUA_NAMESPACE=urn:icslab:plc')
  })

  it('injects INITIAL_PROGRAM_B64 when a saved PLC program source exists', () => {
    const b64 = Buffer.from('PROGRAM main VAR END_VAR END_PROGRAM').toString('base64')
    const compose = gen(
      makeScenario([
        [
          'plc-1',
          {
            category: 'plc',
            ipAddress: '172.20.10.10',
            plcProgram: {
              language: 'st',
              source: b64,
              variables: [
                {
                  name: 'pressure',
                  type: 'REAL',
                  address: '%IW0',
                  protocol: 'modbus-tcp',
                  protocolAddress: '0'
                }
              ]
            }
          }
        ]
      ])
    )
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain(`INITIAL_PROGRAM_B64=${b64}`)
  })

  it('injects PLC_VAR_COUNT equal to the number of variable bindings', () => {
    const b64 = Buffer.from('PROGRAM main VAR END_VAR END_PROGRAM').toString('base64')
    const compose = gen(
      makeScenario([
        [
          'plc-1',
          {
            category: 'plc',
            ipAddress: '172.20.10.10',
            plcProgram: {
              language: 'st',
              source: b64,
              variables: [
                {
                  name: 'v1',
                  type: 'BOOL',
                  address: '%IX0.0',
                  protocol: 'modbus-tcp',
                  protocolAddress: '0'
                },
                {
                  name: 'v2',
                  type: 'BOOL',
                  address: '%QX0.0',
                  protocol: 'modbus-tcp',
                  protocolAddress: '0'
                }
              ]
            }
          }
        ]
      ])
    )
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain('PLC_VAR_COUNT=2')
  })

  it('does NOT inject INITIAL_PROGRAM_B64 when plcProgram has no source', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '172.20.10.10' }]]))
    const env = compose.services['plc-1'].environment ?? []
    expect(env.some(v => v.startsWith('INITIAL_PROGRAM_B64'))).toBe(false)
  })
})

// ── Fixed infrastructure services ─────────────────────────────────────────────

describe('fixed infrastructure services', () => {
  // Infrastructure runs in every simulation regardless of scenario contents.
  // Using a single-sensor scenario as the minimal base.
  const infraScenario = makeScenario([['s1', { category: 'sensor', ipAddress: '172.20.10.10' }]])

  it('always includes Suricata IDS/IPS', () => {
    expect(gen(infraScenario).services).toHaveProperty('suricata')
  })

  it('always includes Zeek passive network analysis', () => {
    expect(gen(infraScenario).services).toHaveProperty('zeek')
  })

  it('always includes InfluxDB for the process historian', () => {
    expect(gen(infraScenario).services).toHaveProperty('influxdb')
  })

  it('always includes Loki for log aggregation', () => {
    expect(gen(infraScenario).services).toHaveProperty('loki')
  })

  it('always includes Grafana for dashboards', () => {
    expect(gen(infraScenario).services).toHaveProperty('grafana')
  })

  it('always includes FUXA for the HMI', () => {
    expect(gen(infraScenario).services).toHaveProperty('fuxa')
  })

  it('creates named volumes for all infrastructure services that need persistence', () => {
    const compose = gen(infraScenario, 'my-proj')
    expect(compose.volumes).toHaveProperty('my-proj-suricata-logs')
    expect(compose.volumes).toHaveProperty('my-proj-zeek-logs')
    expect(compose.volumes).toHaveProperty('my-proj-influxdb-data')
    expect(compose.volumes).toHaveProperty('my-proj-loki-data')
    expect(compose.volumes).toHaveProperty('my-proj-grafana-data')
    expect(compose.volumes).toHaveProperty('my-proj-fuxa-data')
  })

  it('grants Suricata NET_ADMIN + NET_RAW for AF_PACKET raw socket capture', () => {
    const compose = gen(infraScenario)
    expect(compose.services['suricata'].cap_add).toContain('NET_ADMIN')
    expect(compose.services['suricata'].cap_add).toContain('NET_RAW')
  })
})
