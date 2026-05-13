/**
 * network-config.test.ts — Unit tests for the four-zone network architecture.
 *
 * The 172.20.x.x address space is the architectural backbone of the simulator.
 * Every device, infrastructure container, and Docker network references these
 * subnets. These tests lock in the exact values so that accidental edits to
 * ZONE_DEFAULTS immediately break CI before any containers get wrong IPs.
 *
 * Purdue Model zone mapping used throughout the simulator:
 *   OT  (Operational Technology) — PLCs, RTUs, sensors, actuators
 *   IT  (Information Technology) — Historian, HMI, Grafana, Loki
 *   DMZ (Demilitarized Zone)     — IDS/IPS, network monitoring tap
 *   External                     — Attack machine (isolated, out-of-band)
 */

import { describe, it, expect } from 'vitest'
import { ZONE_DEFAULTS, dockerNetworkName, zoneIpPrefix } from '../network-config'

// ── ZONE_DEFAULTS ─────────────────────────────────────────────────────────────

describe('ZONE_DEFAULTS', () => {
  it('defines entries for all four Purdue Model zones', () => {
    const zones = Object.keys(ZONE_DEFAULTS)
    expect(zones).toContain('ot')
    expect(zones).toContain('it')
    expect(zones).toContain('dmz')
    expect(zones).toContain('external')
  })

  it('assigns the OT zone to 172.20.10.0/24 with gateway .1', () => {
    expect(ZONE_DEFAULTS.ot.subnet).toBe('172.20.10.0/24')
    expect(ZONE_DEFAULTS.ot.gateway).toBe('172.20.10.1')
  })

  it('assigns the IT zone to 172.20.20.0/24 with gateway .1', () => {
    expect(ZONE_DEFAULTS.it.subnet).toBe('172.20.20.0/24')
    expect(ZONE_DEFAULTS.it.gateway).toBe('172.20.20.1')
  })

  it('assigns the DMZ zone to 172.20.30.0/24 with gateway .1', () => {
    expect(ZONE_DEFAULTS.dmz.subnet).toBe('172.20.30.0/24')
    expect(ZONE_DEFAULTS.dmz.gateway).toBe('172.20.30.1')
  })

  it('assigns the External zone to 172.20.40.0/24 with gateway .1', () => {
    expect(ZONE_DEFAULTS.external.subnet).toBe('172.20.40.0/24')
    expect(ZONE_DEFAULTS.external.gateway).toBe('172.20.40.1')
  })

  it('uses the private 172.20.x.x range — avoiding common 10.x and 192.168.x conflicts', () => {
    for (const zone of Object.values(ZONE_DEFAULTS)) {
      expect(zone.subnet).toMatch(/^172\.20\./)
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

// ── dockerNetworkName ─────────────────────────────────────────────────────────

describe('dockerNetworkName', () => {
  it('produces "<projectName>_<zone>-net" format', () => {
    expect(dockerNetworkName('ics-sim-demo', 'ot')).toBe('ics-sim-demo_ot-net')
  })

  it('works for all four zones', () => {
    const zones = ['ot', 'it', 'dmz', 'external'] as const
    for (const zone of zones) {
      expect(dockerNetworkName('proj', zone)).toBe(`proj_${zone}-net`)
    }
  })

  it('preserves the project name exactly — no additional sanitization', () => {
    expect(dockerNetworkName('ics-sim-water-treatment-plant', 'it')).toBe(
      'ics-sim-water-treatment-plant_it-net'
    )
  })
})

// ── zoneIpPrefix ──────────────────────────────────────────────────────────────

describe('zoneIpPrefix', () => {
  it('returns "172.20.10" for the OT zone', () => {
    expect(zoneIpPrefix('ot')).toBe('172.20.10')
  })

  it('returns the correct prefix for each zone', () => {
    expect(zoneIpPrefix('it')).toBe('172.20.20')
    expect(zoneIpPrefix('dmz')).toBe('172.20.30')
    expect(zoneIpPrefix('external')).toBe('172.20.40')
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
