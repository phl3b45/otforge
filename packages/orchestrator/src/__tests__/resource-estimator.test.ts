/**
 * resource-estimator.test.ts — Unit tests for RAM/CPU resource estimation.
 *
 * The estimator warns users when a scenario would consume too much of their
 * host system's RAM before Docker even starts the containers. Getting this
 * arithmetic wrong could silently allow scenarios to launch on underpowered
 * machines, causing the host OS to page-thrash or OOM-kill containers.
 *
 * Testing strategy:
 *   - estimateResources() tests use a scenario factory so each test controls
 *     exactly which devices are present without duplicating fixture setup.
 *   - checkSystemMemory() tests spy on os.freemem / os.totalmem so results
 *     are deterministic regardless of the CI runner's actual available RAM.
 *
 * RAM budget constants (must match compose-generator.ts DEVICE_LIMITS):
 *   Standard device (Alpine container): 80 MB
 *   PLC (OpenPLC Runtime on Ubuntu):   128 MB
 *   Attack machine (Kali + tooling):   512 MB bonus on top of 80 MB device slot
 *   Fixed infrastructure total:        850 MB
 *     (Suricata 150 + Zeek 150 + InfluxDB 200 + Grafana 150 + Loki 80 + FUXA 100 + Firewall 20)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import { estimateResources, checkSystemMemory } from '../resource-estimator'
import type { ICSLabScenario, ResourceEstimate } from '@ics-sim/schema'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Sum of all fixed infrastructure container RAM budgets (MB). */
const FIXED_INFRA_MB =
  150 + // Suricata
  150 + // Zeek
  200 + // InfluxDB 1.8
  150 + // Grafana
  80 + // Loki
  100 + // FUXA
  20 // Firewall nftables container
// Total: 850

const RAM_DEVICE_MB = 80 // Standard Alpine-based device
const RAM_PLC_MB = 128 // OpenPLC Runtime (Ubuntu 22.04)
const RAM_ATTACK_BONUS_MB = 512 // Added on top of device slot for attack machine

// ── Test fixture factory ───────────────────────────────────────────────────────

type CategoryEntry = {
  category: ICSLabScenario['devices']['devices'][string]['category']
  ipAddress: string
}

/**
 * Builds a minimal but type-correct ICSLabScenario with the given devices.
 *
 * Only the fields that estimateResources() and checkSystemMemory() read are
 * populated — the rest are set to empty/zero defaults so the factory stays lean.
 */
function makeScenario(deviceMap: Record<string, CategoryEntry>): ICSLabScenario {
  const devices: ICSLabScenario['devices']['devices'] = {}
  for (const [id, d] of Object.entries(deviceMap)) {
    devices[id] = { nodeId: id, category: d.category, ipAddress: d.ipAddress, protocols: [] }
  }

  return {
    meta: {
      formatVersion: '1.0',
      name: 'Test',
      description: '',
      sector: 'generic',
      author: 'test',
      createdAt: '',
      updatedAt: '',
      appVersion: '0.1.0',
      locked: false,
      brief: '',
      requirements: { estimatedRamMb: 0, estimatedCpuCores: 0, containerCount: 0 }
    },
    visual: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    network: { segments: [], routes: [] },
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

// ── estimateResources ─────────────────────────────────────────────────────────

describe('estimateResources', () => {
  describe('RAM budgeting', () => {
    it('allocates the standard 80 MB device budget for a sensor', () => {
      const scenario = makeScenario({
        'sensor-1': { category: 'sensor', ipAddress: '172.20.10.10' }
      })
      const estimate = estimateResources(scenario)
      expect(estimate.estimatedRamMb).toBe(RAM_DEVICE_MB + FIXED_INFRA_MB)
    })

    it('allocates 128 MB for a PLC (OpenPLC Runtime needs Ubuntu base + build toolchain)', () => {
      const scenario = makeScenario({ 'plc-1': { category: 'plc', ipAddress: '172.20.10.10' } })
      const estimate = estimateResources(scenario)
      expect(estimate.estimatedRamMb).toBe(RAM_PLC_MB + FIXED_INFRA_MB)
    })

    it('PLC budget is 48 MB more than the standard device budget', () => {
      const withPlc = estimateResources(
        makeScenario({ 'plc-1': { category: 'plc', ipAddress: '172.20.10.10' } })
      )
      const withSensor = estimateResources(
        makeScenario({ 's-1': { category: 'sensor', ipAddress: '172.20.10.10' } })
      )
      expect(withPlc.estimatedRamMb - withSensor.estimatedRamMb).toBe(RAM_PLC_MB - RAM_DEVICE_MB)
    })

    it('adds the fixed infrastructure RAM regardless of scenario contents', () => {
      const empty_ish = makeScenario({ s: { category: 'sensor', ipAddress: '172.20.10.10' } })
      const estimate = estimateResources(empty_ish)
      // Infrastructure containers always run: Suricata, Zeek, InfluxDB, Grafana, Loki, FUXA, Firewall
      expect(estimate.estimatedRamMb).toBeGreaterThanOrEqual(FIXED_INFRA_MB)
    })

    it('adds a 512 MB attack machine bonus when an attack-machine device is present', () => {
      const withAttack = estimateResources(
        makeScenario({ 'kali-1': { category: 'attack-machine', ipAddress: '172.20.40.10' } })
      )
      const withoutAttack = estimateResources(
        makeScenario({ 'sensor-1': { category: 'sensor', ipAddress: '172.20.10.10' } })
      )
      // Both have 1 device (80 MB device slot), same infra. Only the attack bonus differs.
      expect(withAttack.estimatedRamMb - withoutAttack.estimatedRamMb).toBe(RAM_ATTACK_BONUS_MB)
    })

    it('does not add attack bonus when no attack-machine device exists', () => {
      const scenario = makeScenario({ 'plc-1': { category: 'plc', ipAddress: '172.20.10.10' } })
      const estimate = estimateResources(scenario)
      expect(estimate.estimatedRamMb).toBe(RAM_PLC_MB + FIXED_INFRA_MB)
    })

    it('sums RAM correctly for a mixed scenario with multiple device types', () => {
      const scenario = makeScenario({
        'plc-1': { category: 'plc', ipAddress: '172.20.10.10' }, // 128 MB
        'sensor-1': { category: 'sensor', ipAddress: '172.20.10.11' }, // 80 MB
        'rtu-1': { category: 'rtu', ipAddress: '172.20.10.12' } // 80 MB
      })
      const estimate = estimateResources(scenario)
      expect(estimate.estimatedRamMb).toBe(128 + 80 + 80 + FIXED_INFRA_MB)
    })
  })

  describe('container count', () => {
    it('adds 7 fixed infrastructure containers on top of user device count', () => {
      const scenario = makeScenario({
        'plc-1': { category: 'plc', ipAddress: '172.20.10.10' },
        'rtu-1': { category: 'rtu', ipAddress: '172.20.10.11' }
      })
      // 2 user devices + 7 fixed infra (Suricata, Zeek, InfluxDB, Grafana, Loki, FUXA, Firewall)
      expect(estimateResources(scenario).containerCount).toBe(9)
    })

    it('includes the attack machine in the base device count (plus 7 infra)', () => {
      const scenario = makeScenario({
        'kali-1': { category: 'attack-machine', ipAddress: '172.20.40.10' }
      })
      expect(estimateResources(scenario).containerCount).toBe(8)
    })
  })

  describe('CPU estimation', () => {
    it('estimates 1 core for 5 or fewer user devices', () => {
      const scenario = makeScenario({ 'plc-1': { category: 'plc', ipAddress: '172.20.10.10' } })
      expect(estimateResources(scenario).estimatedCpuCores).toBe(1)
    })

    it('estimates 4 cores for 20 user devices — ceil(20/5)', () => {
      const devices: Record<string, CategoryEntry> = {}
      for (let i = 0; i < 20; i++) {
        devices[`sensor-${i}`] = { category: 'sensor', ipAddress: `172.20.10.${i + 10}` }
      }
      const estimate = estimateResources(makeScenario(devices))
      expect(estimate.estimatedCpuCores).toBe(4)
    })

    it('always estimates at least 1 core even for very small scenarios', () => {
      const scenario = makeScenario({ s: { category: 'sensor', ipAddress: '172.20.10.10' } })
      expect(estimateResources(scenario).estimatedCpuCores).toBeGreaterThanOrEqual(1)
    })
  })
})

// ── checkSystemMemory ─────────────────────────────────────────────────────────

describe('checkSystemMemory', () => {
  let freememSpy: ReturnType<typeof vi.spyOn>
  let totalmemSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    freememSpy = vi.spyOn(os, 'freemem')
    totalmemSpy = vi.spyOn(os, 'totalmem')
    // Stable baseline: 16 GB total, 8 GB free (8192 MB)
    totalmemSpy.mockReturnValue(16 * 1024 * 1024 * 1024)
    freememSpy.mockReturnValue(8 * 1024 * 1024 * 1024)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Builds a synthetic ResourceEstimate from a raw MB figure for threshold testing. */
  function estimateAt(mb: number): ResourceEstimate {
    return { estimatedRamMb: mb, estimatedCpuCores: 1, containerCount: 1 }
  }

  it('reports sufficient and no warnings when estimate is well below 60% of free RAM', () => {
    // 8192 MB free; 1024 MB estimate = 12.5% → no threshold triggered
    const result = checkSystemMemory(estimateAt(1024))
    expect(result.sufficientForScenario).toBe(true)
    expect(result.warningThreshold).toBe(false)
    expect(result.criticalThreshold).toBe(false)
  })

  it('sets warningThreshold (≥60%) while leaving sufficientForScenario true', () => {
    // 8192 MB free; 5120 MB = 62.5% → warning fires, not yet critical
    const result = checkSystemMemory(estimateAt(5120))
    expect(result.warningThreshold).toBe(true)
    expect(result.criticalThreshold).toBe(false)
    expect(result.sufficientForScenario).toBe(true)
  })

  it('sets both criticalThreshold and sufficientForScenario=false when estimate ≥85% of free RAM', () => {
    // 8192 MB free; 7168 MB = 87.5% → both warning and critical fire
    const result = checkSystemMemory(estimateAt(7168))
    expect(result.criticalThreshold).toBe(true)
    expect(result.warningThreshold).toBe(true) // 87.5% also exceeds 60% threshold
    expect(result.sufficientForScenario).toBe(false)
  })

  it('returns freeMb and totalMb expressed in megabytes (not bytes)', () => {
    const result = checkSystemMemory(estimateAt(100))
    // 8 GB = 8192 MB, 16 GB = 16384 MB
    expect(result.freeMb).toBe(8192)
    expect(result.totalMb).toBe(16384)
  })

  it('reflects changes to available memory — different spy values produce different results', () => {
    // Simulate a machine with only 1 GB free
    freememSpy.mockReturnValue(1 * 1024 * 1024 * 1024)
    const result = checkSystemMemory(estimateAt(900))
    // 900 MB out of 1024 MB free = 87.9% → critical
    expect(result.criticalThreshold).toBe(true)
  })
})
