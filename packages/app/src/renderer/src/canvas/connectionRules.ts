/**
 * connectionRules.ts — ICS protocol compatibility matrix for connection validation.
 *
 * Defines which protocols are architecturally valid between device categories in
 * the Purdue Reference Model (ISA-99 / IEC 62443-3-2). Used by ScadaCanvas to
 * enforce realistic ICS topologies: invalid connections are blocked at the moment
 * the student clicks a target, and an educational tooltip explains why.
 *
 * Design rules encoded here:
 *
 *   Field devices (sensor / actuator / pump / valve / flow-meter /
 *   pressure-transmitter) are Modbus slaves. They speak only to a Modbus master
 *   (PLC, RTU) or a DNP3 outstation via an IED. They have no HMI-facing or
 *   historian-facing protocols — connecting a sensor directly to an HMI is a
 *   common student error and should be blocked with an explanation.
 *
 *   PLCs aggregate field data and expose it upward:
 *     - Modbus RTU/TCP/ASCII to field devices (master role)
 *     - EtherNet/IP to Allen-Bradley I/O and peer PLCs
 *     - OPC-UA or Modbus TCP to HMI and Historian
 *
 *   RTUs are remote concentrators for DNP3/Modbus over serial or TCP:
 *     - Modbus RTU/TCP, DNP3 to field devices
 *     - DNP3 upward to the SCADA master (HMI / Historian)
 *
 *   IEDs implement IEC 61850 and DNP3 for substation automation:
 *     - IEC 61850 GOOSE/MMS between IEDs (peer protection scheme)
 *     - DNP3 to RTU, PLC, or SCADA master
 *
 *   HMI and Historian sit on the IT layer and read process data via OPC-UA,
 *   DNP3 polling, or Modbus TCP — they never write Modbus to field devices
 *   directly (that would bypass the PLC safety layer).
 *
 *   Infrastructure devices (firewall, IDS/IPS, switch, router) are pure Ethernet
 *   pass-through; they do not speak any ICS application protocol.
 *
 *   Attack machines can inject any protocol as part of red-team exercises —
 *   they appear in the External zone and can "attempt" any connection.
 *
 * Sources:
 *   IEC 62443-3-3:2013 — System Security Requirements and Security Levels
 *   NIST SP 800-82 Rev 3 — Guide to OT Security
 *   IEEE Std 1646-2004 — Communication Delivery Time Performance Requirements for EPSS
 *   IEC 61850-8-1 — GOOSE/MMS over Ethernet
 *   DNP3 Subset Definition (DNP3 Technical Committee, 2012)
 *   Modbus Application Protocol Specification v1.1b3 (Modbus Organization)
 *   OPC Unified Architecture Part 1 (OPC Foundation)
 */

import type { DeviceCategory, Protocol } from '@ics-sim/schema'

/**
 * The ICS device category compatibility matrix.
 *
 * VALID_CONNECTIONS[source][target] = Protocol[]
 *   source  — category of the device that was right-clicked (connection initiator)
 *   target  — category of the device the student clicks as the destination
 *   value   — ordered list of valid protocols (first = most common / recommended)
 *
 * An undefined source key means that device type cannot initiate connections
 * to any device that isn't already listed (treated the same as an empty array).
 * A missing inner target key means the pair is incompatible — blocked.
 *
 * 'none' = untagged Ethernet cable (infrastructure pass-through; no application-layer protocol).
 */
export const VALID_CONNECTIONS: Partial<
  Record<DeviceCategory, Partial<Record<DeviceCategory, Protocol[]>>>
> = {
  // ── PLC (Modbus master, EtherNet/IP peer, OPC-UA server upward) ────────────
  plc: {
    sensor: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    actuator: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    pump: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    valve: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    'flow-meter': ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    'pressure-transmitter': ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    rtu: ['modbus-tcp', 'modbus-rtu', 'dnp3'],
    ied: ['modbus-tcp', 'iec61850'],
    plc: ['modbus-tcp', 'ethernet-ip'], // peer-to-peer PLC network
    hmi: ['modbus-tcp', 'opc-ua'],
    historian: ['modbus-tcp', 'opc-ua'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── RTU (remote terminal unit — serial concentrator for field and SCADA) ────
  rtu: {
    sensor: ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    actuator: ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    pump: ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    valve: ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    'flow-meter': ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    'pressure-transmitter': ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    plc: ['modbus-tcp', 'modbus-rtu', 'dnp3'],
    ied: ['dnp3', 'iec61850'],
    hmi: ['dnp3', 'modbus-tcp'],
    historian: ['dnp3'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── IED (substation IEC 61850 — peer protection + DNP3 telemetry) ──────────
  ied: {
    ied: ['iec61850', 'dnp3'], // GOOSE between peer IEDs
    rtu: ['iec61850', 'dnp3'],
    plc: ['iec61850', 'modbus-tcp'],
    hmi: ['dnp3', 'iec61850'],
    historian: ['dnp3', 'iec61850'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── HMI (reads process data; sits on IT layer above PLC/RTU/IED) ───────────
  hmi: {
    plc: ['modbus-tcp', 'opc-ua'],
    rtu: ['dnp3', 'modbus-tcp'],
    ied: ['dnp3', 'iec61850'],
    historian: ['opc-ua', 'none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Historian (time-series archive — reads from control layer, serves IT) ───
  historian: {
    plc: ['opc-ua', 'modbus-tcp'],
    rtu: ['dnp3'],
    ied: ['dnp3', 'iec61850'],
    hmi: ['opc-ua', 'none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Field devices — Modbus slaves, polled by PLC or RTU master ─────────────
  // Note: field devices do NOT connect to HMI/Historian directly; all process
  // data must flow through a PLC or RTU (a common student misconception).
  sensor: {
    plc: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    rtu: ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    ied: ['dnp3']
  },
  actuator: {
    plc: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    rtu: ['modbus-rtu', 'modbus-tcp'],
    ied: ['dnp3']
  },
  pump: {
    plc: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    rtu: ['modbus-rtu', 'modbus-tcp'],
    ied: ['dnp3']
  },
  valve: {
    plc: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    rtu: ['modbus-rtu', 'modbus-tcp'],
    ied: ['dnp3']
  },
  'flow-meter': {
    plc: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    rtu: ['modbus-rtu', 'modbus-tcp'],
    ied: ['dnp3']
  },
  'pressure-transmitter': {
    plc: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    rtu: ['modbus-rtu', 'modbus-tcp'],
    ied: ['dnp3']
  },

  // ── Infrastructure: Ethernet pass-through — no ICS application protocols ───
  firewall: {
    plc: ['none'],
    rtu: ['none'],
    ied: ['none'],
    hmi: ['none'],
    historian: ['none'],
    sensor: ['none'],
    actuator: ['none'],
    pump: ['none'],
    valve: ['none'],
    'flow-meter': ['none'],
    'pressure-transmitter': ['none'],
    firewall: ['none'],
    'ids-ips': ['none'],
    switch: ['none'],
    router: ['none'],
    'attack-machine': ['none']
  },
  'ids-ips': {
    plc: ['none'],
    rtu: ['none'],
    ied: ['none'],
    hmi: ['none'],
    historian: ['none'],
    sensor: ['none'],
    actuator: ['none'],
    pump: ['none'],
    valve: ['none'],
    'flow-meter': ['none'],
    'pressure-transmitter': ['none'],
    firewall: ['none'],
    'ids-ips': ['none'],
    switch: ['none'],
    router: ['none'],
    'attack-machine': ['none']
  },
  switch: {
    plc: ['none'],
    rtu: ['none'],
    ied: ['none'],
    hmi: ['none'],
    historian: ['none'],
    sensor: ['none'],
    actuator: ['none'],
    pump: ['none'],
    valve: ['none'],
    'flow-meter': ['none'],
    'pressure-transmitter': ['none'],
    firewall: ['none'],
    'ids-ips': ['none'],
    switch: ['none'],
    router: ['none'],
    'attack-machine': ['none']
  },
  router: {
    plc: ['none'],
    rtu: ['none'],
    ied: ['none'],
    hmi: ['none'],
    historian: ['none'],
    sensor: ['none'],
    actuator: ['none'],
    pump: ['none'],
    valve: ['none'],
    'flow-meter': ['none'],
    'pressure-transmitter': ['none'],
    firewall: ['none'],
    'ids-ips': ['none'],
    switch: ['none'],
    router: ['none'],
    'attack-machine': ['none']
  },

  // ── Attack machine — can attempt any protocol (External zone red team) ──────
  // All protocols listed because an attacker is not constrained by operational
  // intent. Students see this device can reach anything — that's the lesson.
  'attack-machine': {
    plc: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    rtu: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    ied: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    hmi: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    historian: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    sensor: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    actuator: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    pump: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    valve: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    'flow-meter': [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    'pressure-transmitter': [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    firewall: ['none'],
    'ids-ips': ['none'],
    switch: ['none'],
    router: ['none']
  }
}

/**
 * Returns the set of protocols that the given source device category can ever use,
 * across all possible target types. Used to filter the context menu so students
 * only see protocols that are meaningful for the device they right-clicked.
 *
 * @example
 * getSourceProtocols('sensor')
 * // → Set { 'modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip', 'dnp3' }
 */
export function getSourceProtocols(source: DeviceCategory): Set<Protocol> {
  const targets = VALID_CONNECTIONS[source] ?? {}
  const result = new Set<Protocol>()
  for (const protocols of Object.values(targets)) {
    for (const p of protocols) result.add(p)
  }
  return result
}

/**
 * Returns the list of protocols valid for a specific source→target device pair.
 * Returns an empty array when no valid protocol exists between the two categories.
 *
 * @param source - Category of the initiating device.
 * @param target - Category of the destination device.
 */
export function getValidProtocols(source: DeviceCategory, target: DeviceCategory): Protocol[] {
  return VALID_CONNECTIONS[source]?.[target] ?? []
}

/**
 * Returns true if `protocol` is a valid choice for the given source→target pair.
 *
 * @param source   - Category of the initiating device.
 * @param target   - Category of the destination device.
 * @param protocol - Protocol selected from the connection context menu.
 */
export function isConnectionValid(
  source: DeviceCategory,
  target: DeviceCategory,
  protocol: Protocol
): boolean {
  return getValidProtocols(source, target).includes(protocol)
}

/** Human-readable names used in rejection tooltip messages. */
const CATEGORY_NAMES: Record<DeviceCategory, string> = {
  plc: 'PLC',
  rtu: 'RTU',
  ied: 'IED',
  hmi: 'HMI',
  historian: 'Historian',
  sensor: 'Sensor',
  actuator: 'Actuator',
  pump: 'Pump',
  valve: 'Valve',
  'flow-meter': 'Flow Meter',
  'pressure-transmitter': 'Pressure Transmitter',
  firewall: 'Firewall',
  'ids-ips': 'IDS/IPS',
  switch: 'Switch',
  router: 'Router',
  'attack-machine': 'Attack Machine'
}

/**
 * Returns an educational rejection message explaining why an attempted connection
 * is invalid according to the Purdue Reference Model.
 *
 * Three rejection cases:
 *   1. Completely incompatible pair — no protocol can link these two categories.
 *   2. Valid pair, wrong protocol — the devices CAN be linked, but not this way.
 *   3. Fallback message (should not occur if matrix is complete).
 *
 * @param source   - Category of the initiating (source) device.
 * @param target   - Category of the destination (target) device.
 * @param protocol - Protocol the student selected from the context menu.
 * @returns Human-readable explanation shown in the canvas tooltip.
 *
 * @example
 * getRejectionReason('sensor', 'hmi', 'modbus-tcp')
 * // → 'Sensor → HMI: no valid connection in the Purdue model.
 * //    Field devices only connect to PLCs, RTUs, or IEDs.'
 */
export function getRejectionReason(
  source: DeviceCategory,
  target: DeviceCategory,
  protocol: Protocol
): string {
  const validProtocols = getValidProtocols(source, target)
  const src = CATEGORY_NAMES[source]
  const tgt = CATEGORY_NAMES[target]

  if (validProtocols.length === 0) {
    // No protocol can link these two device categories in the Purdue model
    return `${src} → ${tgt}: incompatible in the Purdue model. No valid protocol exists between these device types.`
  }

  if (!validProtocols.includes(protocol)) {
    // The pair is compatible, but not with the chosen protocol
    const supported = validProtocols.join(', ')
    return `${src} → ${tgt}: ${protocol} is not supported here. Valid protocols: ${supported}`
  }

  // Fallback (matrix should prevent this, but guard defensively)
  return `${src} → ${tgt}: connection blocked`
}
