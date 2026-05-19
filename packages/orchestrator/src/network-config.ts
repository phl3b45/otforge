/**
 * network-config.ts — Default subnet and gateway configuration for the 6-zone Purdue Model.
 *
 * OTForge implements the full Purdue Reference Model (IEC 62443-3-2 / NIST SP 800-82):
 *
 *   OT           (Levels 0–2)  10.200.10.0/24 — PLCs, RTUs, IEDs, sensors, actuators
 *   Control      (Level 3)     10.200.20.0/24 — HMIs, historians, application/database servers
 *   Plant DMZ    (Level 3.5)   10.200.30.0/24 — Firewalls, IDS/IPS, Suricata/Zeek, jump hosts
 *   Enterprise   (Level 4)     10.200.40.0/24 — Domain controllers, web/business servers, desktops
 *   Internet DMZ (Level 5)     10.200.50.0/24 — Email and internet-facing servers
 *   Attacker     (Red Team)    10.200.60.0/24 — Attack machine (Kali Linux) — isolated subnet
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

import type { NetworkZone } from '@otforge/schema'

/**
 * Default subnet and gateway for each network zone.
 *
 * Used by the compose generator to create Docker bridge networks when the
 * scenario does not provide an explicit segment for a zone.
 */
/**
 * Subnet selection rationale:
 *   The original 172.20.x.x range sits in the middle of Docker Desktop's
 *   auto-assignment pool (172.17–172.31) and is commonly consumed by corporate
 *   VPN clients and university network adapters, causing "Address already in use"
 *   errors on first launch.
 *
 *   10.200.x.x is an RFC 1918 private range that VPN clients and institutional
 *   networks almost never assign, making conflicts highly unlikely in lab settings.
 *
 *   When even 10.200.x.x conflicts (e.g., an enterprise 10.0.0.0/8 VPN),
 *   findFreeSubnets() walks candidates 10.200–10.210 until it finds a free slot.
 *
 *   Third-octet assignment (fixed per zone so zones at the same second-octet slot
 *   never overlap):
 *     10  → OT (Levels 0–2)
 *     20  → Control Center (Level 3)
 *     30  → Plant DMZ (Level 3.5)
 *     40  → Enterprise (Level 4)
 *     50  → Internet DMZ (Level 5)
 *     60  → Attacker / Red Team
 */
export const ZONE_DEFAULTS: Record<NetworkZone, { subnet: string; gateway: string }> = {
  ot: { subnet: '10.200.10.0/24', gateway: '10.200.10.1' },
  control: { subnet: '10.200.20.0/24', gateway: '10.200.20.1' },
  'plant-dmz': { subnet: '10.200.30.0/24', gateway: '10.200.30.1' },
  enterprise: { subnet: '10.200.40.0/24', gateway: '10.200.40.1' },
  'internet-dmz': { subnet: '10.200.50.0/24', gateway: '10.200.50.1' },
  attacker: { subnet: '10.200.60.0/24', gateway: '10.200.60.1' }
}

// ── Subnet conflict detection ──────────────────────────────────────────────────

/**
 * Converts a dotted-decimal IPv4 address to an unsigned 32-bit integer.
 *
 * Uses reduce with left-shift accumulation to avoid floating-point precision
 * issues: each octet is shifted 8 bits left before adding the next one.
 * The `>>> 0` converts the signed JS number to unsigned so bitwise ops work
 * correctly when the high bit of the address is set.
 *
 * @param ip - Dotted-decimal IPv4 string (e.g., "10.200.10.5").
 * @returns Unsigned 32-bit integer representation.
 */
function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0
}

/**
 * Converts a CIDR string to a [networkAddress, broadcastAddress] integer pair.
 *
 * The network address has all host bits zeroed; the broadcast address has all
 * host bits set to 1. Used for range-overlap checking.
 *
 * @param cidr - CIDR notation string (e.g., "10.8.0.0/16" or "10.200.10.0/24").
 * @returns [networkInt, broadcastInt] — both unsigned 32-bit integers.
 */
function cidrToRange(cidr: string): [number, number] {
  const [base, bits] = cidr.split('/')
  const prefix = parseInt(bits)
  // /0 means the entire address space — mask is all zeros (no network bits masked)
  const mask = prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1) >>> 0
  const net = (ipToInt(base) & mask) >>> 0
  const broadcast = (net | (~mask >>> 0)) >>> 0
  return [net, broadcast]
}

/**
 * Returns true if two CIDR ranges share at least one IP address.
 *
 * Two ranges [aStart, aEnd] and [bStart, bEnd] overlap when neither is entirely
 * before or after the other: aStart ≤ bEnd AND bStart ≤ aEnd. This handles all
 * containment cases — e.g., a VPN's /8 containing our /24 candidate.
 *
 * @param a - First CIDR string.
 * @param b - Second CIDR string.
 * @returns true if the two ranges overlap.
 */
function cidrsOverlap(a: string, b: string): boolean {
  const [aStart, aEnd] = cidrToRange(a)
  const [bStart, bEnd] = cidrToRange(b)
  return aStart <= bEnd && bStart <= aEnd
}

/**
 * Scans the provided list of in-use CIDRs and returns the first available /24
 * for each network zone from a candidate pool of 10.200–10.210.x.0/24 subnets.
 *
 * Each zone uses a fixed third octet (OT=10, IT=20, DMZ=30, External=40) so
 * zones at the same "pool index" never conflict with each other — e.g., OT gets
 * 10.201.10.0/24 and IT gets 10.201.20.0/24 even if both needed the same slot.
 *
 * If all 11 candidates for a zone conflict with in-use CIDRs, that zone falls
 * back to its ZONE_DEFAULTS entry (best-effort — highly unlikely in practice
 * unless a host has a 10.0.0.0/8 VPN tunnel consuming all of RFC 1918 10.x.x.x).
 *
 * @param usedCidrs - Array of CIDR strings already in use on the host, normalized
 *   to network base addresses (e.g., "192.168.1.0/24", not "192.168.1.100/24").
 *   Obtain these from os.networkInterfaces() in the Electron main process.
 * @returns A complete zone → { subnet, gateway } map ready to pass to generateCompose().
 *
 * @example
 *   // Host has a VPN on 10.200.0.0/16 — OT gets 10.201.10.0/24 instead of the default
 *   findFreeSubnets(['10.200.0.0/16', '192.168.1.0/24'])
 *   // → { ot: { subnet: '10.201.10.0/24', gateway: '10.201.10.1' }, control: {...}, ... }
 */
export function findFreeSubnets(
  usedCidrs: string[]
): Record<NetworkZone, { subnet: string; gateway: string }> {
  // Fixed third octet per zone — ensures zones at the same second-octet slot never overlap.
  // Third-octet values match the Purdue Model hierarchy: 10=OT, 20=Control, 30=PlantDMZ,
  // 40=Enterprise, 50=InternetDMZ, 60=Attacker.
  const THIRD_OCTET: Record<NetworkZone, number> = {
    ot: 10,
    control: 20,
    'plant-dmz': 30,
    enterprise: 40,
    'internet-dmz': 50,
    attacker: 60
  }

  // Shallow spread is safe — we replace (never mutate) zone values in the loop below
  const result = { ...ZONE_DEFAULTS }

  for (const zone of [
    'ot',
    'control',
    'plant-dmz',
    'enterprise',
    'internet-dmz',
    'attacker'
  ] as NetworkZone[]) {
    const third = THIRD_OCTET[zone]
    // Walk the candidate pool: 10.200.x.0/24 → 10.210.x.0/24 (11 options per zone)
    for (let second = 200; second <= 210; second++) {
      const candidate = `10.${second}.${third}.0/24`
      if (!usedCidrs.some(used => cidrsOverlap(candidate, used))) {
        result[zone] = { subnet: candidate, gateway: `10.${second}.${third}.1` }
        break // first non-conflicting candidate wins
      }
    }
    // If all candidates conflict, zone retains the ZONE_DEFAULTS fallback from the spread
  }

  return result
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
 *   dockerNetworkName('otforge-demo', 'ot')  // → 'otforge-demo_ot-net'
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
 *   zoneIpPrefix('ot')      // → '10.200.10'
 *   zoneIpPrefix('control') // → '10.200.20'
 */
export function zoneIpPrefix(zone: NetworkZone): string {
  return ZONE_DEFAULTS[zone].subnet.replace('.0/24', '')
}
