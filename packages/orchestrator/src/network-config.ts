/**
 * network-config.ts — Default subnet and gateway configuration for the 4-zone network model.
 *
 * ICS Simulator uses a four-zone Purdue Model-inspired network architecture:
 *
 *   OT  (Operational Technology)  172.20.10.0/24 — PLCs, RTUs, sensors, actuators
 *   IT  (Information Technology)  172.20.20.0/24 — Historian, HMI, Grafana, Loki
 *   DMZ (Demilitarized Zone)      172.20.30.0/24 — Suricata IDS/IPS, Zeek tap
 *   External                       172.20.40.0/24 — Attack machine (Kali Linux)
 *
 * The 172.20.x.x range is chosen to avoid conflicts with common home/office networks
 * (192.168.x.x, 10.x.x.x) while still being RFC 1918 private space.
 *
 * These defaults are used when:
 *   1. A scenario does not explicitly define a segment for a zone (compose-generator.ts
 *      fills in any missing zones from these defaults).
 *   2. The canvas auto-assigns IPs to newly dropped devices.
 *   3. Fixed infrastructure containers (Suricata .253, Zeek .252) need static IPs.
 *
 * Scenarios can override these defaults by specifying custom subnets/gateways in
 * their network.segments array.
 */

import type { NetworkZone } from '@ics-sim/schema'

/**
 * Default subnet and gateway for each network zone.
 *
 * Used by the compose generator to create Docker bridge networks when the
 * scenario does not provide an explicit segment for a zone.
 */
export const ZONE_DEFAULTS: Record<NetworkZone, { subnet: string; gateway: string }> = {
  ot: { subnet: '172.20.10.0/24', gateway: '172.20.10.1' },
  it: { subnet: '172.20.20.0/24', gateway: '172.20.20.1' },
  dmz: { subnet: '172.20.30.0/24', gateway: '172.20.30.1' },
  external: { subnet: '172.20.40.0/24', gateway: '172.20.40.1' }
}

/**
 * Returns the Docker-assigned name for a zone's bridge network within a project.
 *
 * Docker Compose names networks as `<project>_<network-name>`. The network name
 * is `<zone>-net` (e.g., `ot-net`), so the full Docker name is
 * `<projectName>_ot-net`.
 *
 * @param projectName - The Docker Compose project name (sanitized scenario name).
 * @param zone        - The network zone identifier.
 * @returns The full Docker network name string.
 *
 * @example
 *   dockerNetworkName('ics-sim-demo', 'ot')  // → 'ics-sim-demo_ot-net'
 */
export function dockerNetworkName(projectName: string, zone: NetworkZone): string {
  return `${projectName}_${zone}-net`
}

/**
 * Returns the first three octets of a zone's default subnet for use as an IP prefix.
 *
 * Useful when auto-assigning IP addresses to newly dropped devices — the canvas
 * appends a host octet to this prefix (e.g., `.10`, `.20`).
 *
 * @param zone - The network zone to get the prefix for.
 * @returns The subnet base with the last octet removed (e.g., "172.20.10").
 *
 * @example
 *   zoneIpPrefix('ot')  // → '172.20.10'
 */
export function zoneIpPrefix(zone: NetworkZone): string {
  return ZONE_DEFAULTS[zone].subnet.replace('.0/24', '')
}
