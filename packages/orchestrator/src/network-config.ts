import type { NetworkZone } from '@ics-sim/schema'

export const ZONE_DEFAULTS: Record<NetworkZone, { subnet: string; gateway: string }> = {
  ot: { subnet: '172.20.10.0/24', gateway: '172.20.10.1' },
  it: { subnet: '172.20.20.0/24', gateway: '172.20.20.1' },
  dmz: { subnet: '172.20.30.0/24', gateway: '172.20.30.1' },
  external: { subnet: '172.20.40.0/24', gateway: '172.20.40.1' }
}

// Stable Docker network names scoped to a scenario project
export function dockerNetworkName(projectName: string, zone: NetworkZone): string {
  return `${projectName}_${zone}-net`
}

// Convert zone to its default IP range prefix for auto-assignment hints
export function zoneIpPrefix(zone: NetworkZone): string {
  return ZONE_DEFAULTS[zone].subnet.replace('.0/24', '')
}
