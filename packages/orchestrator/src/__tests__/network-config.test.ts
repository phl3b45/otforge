/**
 * network-config.test.ts — Unit tests for the six-zone Purdue Reference Model
 * network architecture (IEC 62443-3-2 / NIST SP 800-82).
 *
 * The 10.200.x.x address space is the architectural backbone of the simulator.
 * Every device, infrastructure container, and Docker network references these
 * subnets. These tests lock in the exact values so that accidental edits to
 * ZONE_DEFAULTS immediately break CI before any containers get wrong IPs.
 *
 * Purdue Model zone mapping used throughout the simulator:
 *   ot           (L0-L2)  — PLCs, RTUs, IEDs, sensors, actuators
 *   control      (L3)     — HMIs, historians, application/DB servers, Grafana, Loki
 *   plant-dmz    (L3.5)   — Firewalls, IDS/IPS, Suricata, Zeek, jump hosts
 *   enterprise   (L4)     — Domain controllers, web/business servers, desktops
 *   internet-dmz (L5)     — Email servers, internet-facing servers
 *   attacker     (Red Team) — Attack machine (Kali Linux) — isolated subnet
 */

import { describe, it, expect } from 'vitest'
import { ZONE_DEFAULTS, findFreeSubnets, dockerNetworkName, zoneIpPrefix } from '../network-config'

// ── ZONE_DEFAULTS ─────────────────────────────────────────────────────────────

describe('ZONE_DEFAULTS', () => {
  it('defines entries for all six Purdue Reference Model zones', () => {
    const zones = Object.keys(ZONE_DEFAULTS)
    expect(zones).toContain('ot')
    expect(zones).toContain('control')
    expect(zones).toContain('plant-dmz')
    expect(zones).toContain('enterprise')
    expect(zones).toContain('internet-dmz')
    expect(zones).toContain('attacker')
  })

  it('assigns the OT zone (L0-L2) to 10.200.10.0/24 with gateway .1', () => {
    expect(ZONE_DEFAULTS.ot.subnet).toBe('10.200.10.0/24')
    expect(ZONE_DEFAULTS.ot.gateway).toBe('10.200.10.1')
  })

  it('assigns the Control Center zone (L3) to 10.200.20.0/24 with gateway .1', () => {
    expect(ZONE_DEFAULTS.control.subnet).toBe('10.200.20.0/24')
    expect(ZONE_DEFAULTS.control.gateway).toBe('10.200.20.1')
  })

  it('assigns the Plant DMZ zone (L3.5) to 10.200.30.0/24 with gateway .1', () => {
    expect(ZONE_DEFAULTS['plant-dmz'].subnet).toBe('10.200.30.0/24')
    expect(ZONE_DEFAULTS['plant-dmz'].gateway).toBe('10.200.30.1')
  })

  it('assigns the Enterprise zone (L4) to 10.200.40.0/24 with gateway .1', () => {
    expect(ZONE_DEFAULTS.enterprise.subnet).toBe('10.200.40.0/24')
    expect(ZONE_DEFAULTS.enterprise.gateway).toBe('10.200.40.1')
  })

  it('assigns the Internet DMZ zone (L5) to 10.200.50.0/24 with gateway .1', () => {
    expect(ZONE_DEFAULTS['internet-dmz'].subnet).toBe('10.200.50.0/24')
    expect(ZONE_DEFAULTS['internet-dmz'].gateway).toBe('10.200.50.1')
  })

  it('assigns the Attacker zone (Red Team) to 10.200.60.0/24 with gateway .1', () => {
    expect(ZONE_DEFAULTS.attacker.subnet).toBe('10.200.60.0/24')
    expect(ZONE_DEFAULTS.attacker.gateway).toBe('10.200.60.1')
  })

  it('uses the 10.200.x.x range — above the common 10.0–10.100.x ranges used by VPNs', () => {
    for (const zone of Object.values(ZONE_DEFAULTS)) {
      expect(zone.subnet).toMatch(/^10\.200\./)
    }
  })

  it('uses /24 CIDR blocks for all zones, giving 254 usable host addresses each', () => {
    for (const zone of Object.values(ZONE_DEFAULTS)) {
      expect(zone.subnet).toMatch(/\/24$/)
    }
  })

  it('places each zone in its own /24 so zones cannot overlap', () => {
    const prefixes = Object.values(ZONE_DEFAULTS).map(z =>
      z.subnet.split('.').slice(0, 3).join('.')
    )
    const uniquePrefixes = new Set(prefixes)
    expect(uniquePrefixes.size).toBe(Object.keys(ZONE_DEFAULTS).length)
  })
})

// ── findFreeSubnets ───────────────────────────────────────────────────────────

describe('findFreeSubnets', () => {
  it('returns ZONE_DEFAULTS unchanged when no CIDRs are in use', () => {
    const result = findFreeSubnets([])
    for (const zone of Object.keys(ZONE_DEFAULTS) as Array<keyof typeof ZONE_DEFAULTS>) {
      expect(result[zone]).toEqual(ZONE_DEFAULTS[zone])
    }
  })

  it('bumps only the OT zone when 10.200.10.0/24 conflicts', () => {
    const result = findFreeSubnets(['10.200.10.0/24'])
    expect(result.ot.subnet).toBe('10.201.10.0/24')
    expect(result.ot.gateway).toBe('10.201.10.1')
    expect(result.control).toEqual(ZONE_DEFAULTS.control)
    expect(result.attacker).toEqual(ZONE_DEFAULTS.attacker)
  })

  it('bumps OT and Control independently when both conflict', () => {
    const result = findFreeSubnets(['10.200.10.0/24', '10.200.20.0/24'])
    expect(result.ot.subnet).toBe('10.201.10.0/24')
    expect(result.control.subnet).toBe('10.201.20.0/24')
    expect(result['plant-dmz']).toEqual(ZONE_DEFAULTS['plant-dmz'])
  })

  it('skips multiple blocked candidates before finding a free slot', () => {
    // Block 10.200 and 10.201 for OT — should land on 10.202.10.0/24
    const result = findFreeSubnets(['10.200.10.0/24', '10.201.10.0/24'])
    expect(result.ot.subnet).toBe('10.202.10.0/24')
    expect(result.ot.gateway).toBe('10.202.10.1')
  })

  it('bumps all zones when a /16 covers the default second octet (10.200.0.0/16)', () => {
    const result = findFreeSubnets(['10.200.0.0/16'])
    for (const zone of Object.keys(ZONE_DEFAULTS) as Array<keyof typeof ZONE_DEFAULTS>) {
      expect(result[zone].subnet).not.toBe(ZONE_DEFAULTS[zone].subnet)
      // All should move to the first available second octet (10.201.x.0/24)
      expect(result[zone].subnet).toMatch(/^10\.201\./)
    }
  })

  it('falls back to ZONE_DEFAULTS when all 11 candidates are blocked (10.0.0.0/8 VPN)', () => {
    // A /8 covers all of 10.x.x.x — no candidate in 10.200–10.210 can be used
    const result = findFreeSubnets(['10.0.0.0/8'])
    for (const zone of Object.keys(ZONE_DEFAULTS) as Array<keyof typeof ZONE_DEFAULTS>) {
      expect(result[zone]).toEqual(ZONE_DEFAULTS[zone])
    }
  })

  it('does not conflict with a completely separate RFC 1918 range (192.168.1.0/24)', () => {
    const result = findFreeSubnets(['192.168.1.0/24'])
    for (const zone of Object.keys(ZONE_DEFAULTS) as Array<keyof typeof ZONE_DEFAULTS>) {
      expect(result[zone]).toEqual(ZONE_DEFAULTS[zone])
    }
  })

  it('does not conflict with an adjacent /24 that shares the second octet but differs in the third', () => {
    // 10.200.11.0/24 does not overlap 10.200.10.0/24
    const result = findFreeSubnets(['10.200.11.0/24'])
    expect(result.ot).toEqual(ZONE_DEFAULTS.ot)
  })

  it('detects containment — a /24 inside a broader CIDR counts as a conflict', () => {
    // 10.200.0.0/16 contains 10.200.10.0/24, so OT must move
    const broadResult = findFreeSubnets(['10.200.0.0/16'])
    const exactResult = findFreeSubnets(['10.200.10.0/24'])
    expect(broadResult.ot.subnet).not.toBe(ZONE_DEFAULTS.ot.subnet)
    expect(exactResult.ot.subnet).not.toBe(ZONE_DEFAULTS.ot.subnet)
  })

  it('returns valid /24 CIDRs and .1 gateways for all results', () => {
    const result = findFreeSubnets(['10.200.10.0/24', '10.200.20.0/24'])
    for (const [, cfg] of Object.entries(result)) {
      expect(cfg.subnet).toMatch(/^10\.\d+\.\d+\.0\/24$/)
      expect(cfg.gateway).toMatch(/^10\.\d+\.\d+\.1$/)
    }
  })

  it('handles a /0 CIDR (0.0.0.0/0 — entire address space) without throwing', () => {
    // 0.0.0.0/0 covers every IP address — all candidates fail, falls back to defaults
    expect(() => findFreeSubnets(['0.0.0.0/0'])).not.toThrow()
    const result = findFreeSubnets(['0.0.0.0/0'])
    // Falls back to ZONE_DEFAULTS (all candidates blocked)
    for (const zone of Object.keys(ZONE_DEFAULTS) as Array<keyof typeof ZONE_DEFAULTS>) {
      expect(result[zone]).toEqual(ZONE_DEFAULTS[zone])
    }
  })

  it('zones at the same pool index do not conflict with each other', () => {
    // Bump all zones by blocking the full default second octet
    const result = findFreeSubnets(['10.200.0.0/16'])
    const subnets = Object.values(result).map(z => z.subnet)
    // All subnets must be unique (no two zones can land on the same /24)
    expect(new Set(subnets).size).toBe(subnets.length)
  })
})

// ── dockerNetworkName ─────────────────────────────────────────────────────────

describe('dockerNetworkName', () => {
  it('produces "<projectName>_<zone>-net" format', () => {
    expect(dockerNetworkName('otforge-demo', 'ot')).toBe('otforge-demo_ot-net')
  })

  it('works for all six Purdue zones', () => {
    const zones = ['ot', 'control', 'plant-dmz', 'enterprise', 'internet-dmz', 'attacker'] as const
    for (const zone of zones) {
      expect(dockerNetworkName('proj', zone)).toBe(`proj_${zone}-net`)
    }
  })

  it('preserves the project name exactly — no additional sanitization', () => {
    expect(dockerNetworkName('otforge-water-treatment-plant', 'control')).toBe(
      'otforge-water-treatment-plant_control-net'
    )
  })
})

// ── zoneIpPrefix ──────────────────────────────────────────────────────────────

describe('zoneIpPrefix', () => {
  it('returns "10.200.10" for the OT zone', () => {
    expect(zoneIpPrefix('ot')).toBe('10.200.10')
  })

  it('returns the correct prefix for each Purdue zone', () => {
    expect(zoneIpPrefix('control')).toBe('10.200.20')
    expect(zoneIpPrefix('plant-dmz')).toBe('10.200.30')
    expect(zoneIpPrefix('enterprise')).toBe('10.200.40')
    expect(zoneIpPrefix('internet-dmz')).toBe('10.200.50')
    expect(zoneIpPrefix('attacker')).toBe('10.200.60')
  })

  it('strips the ".0/24" CIDR suffix', () => {
    const prefix = zoneIpPrefix('ot')
    expect(prefix).not.toContain('/')
    expect(prefix).not.toContain('.0')
  })

  it('returns exactly three octets with no trailing dot', () => {
    const prefix = zoneIpPrefix('ot')
    const octets = prefix.split('.')
    expect(octets).toHaveLength(3)
  })
})
