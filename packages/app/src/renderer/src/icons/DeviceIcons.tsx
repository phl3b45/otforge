/**
 * DeviceIcons.tsx — ISA-5.1-inspired SVG icons for every ICS device category.
 *
 * Provides one inline SVG icon per DeviceCategory, loosely following the P&ID
 * (Piping and Instrumentation Diagram) symbol conventions from ISA-5.1 and
 * IEC 60617. Icons are designed on a 24×24 viewBox with 1.5px stroke weight,
 * consistent with Heroicons/Feather icon families that practitioners recognize.
 *
 * Design principles:
 *   - All icons use `stroke: 'currentColor'` so the caller controls color via CSS
 *     or the `color` prop — no hardcoded fill colors.
 *   - ISA-5.1 instrument bubbles (circles) represent measurement devices.
 *   - Standard P&ID symbols used where practical:
 *       Valve → butterfly valve outline (two opposing triangles)
 *       Pump  → centrifugal pump circle with flow arrow
 *       Sensor → instrument bubble with connection nub
 *       PLC/RTU/IED → rectangular controller/DCS shapes
 *
 * Usage:
 *   <DeviceIcon category="plc" size={24} color="#39d0b0" />
 *   <DeviceIcon category="sensor" size={20} className="my-icon" />
 */

import type { DeviceCategory } from '@otforge/schema'

/**
 * Shared SVG presentation attributes applied to every icon.
 * Spreading this object onto <svg> ensures consistent stroke style
 * without repeating attributes on each individual icon component.
 */
const S = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

// ── Individual icon components ─────────────────────────────────────────────────
// Each component renders a single 24×24 SVG. They are not exported — callers
// use the DeviceIcon wrapper which maps category → component.

/** PLC — rectangular controller body with horizontal rungs (ladder logic reference). */
function PlcSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="4" width="20" height="16" rx="1" />
      <line x1="6" y1="9" x2="18" y2="9" />
      <line x1="6" y1="12" x2="18" y2="12" />
      <line x1="6" y1="15" x2="18" y2="15" />
      <circle cx="5" cy="4" r="1" fill="currentColor" />
      <circle cx="19" cy="4" r="1" fill="currentColor" />
    </svg>
  )
}

/** RTU — Remote Terminal Unit; box with an analog indicator dial and register lines. */
function RtuSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="3" y="5" width="18" height="14" rx="1" />
      <circle cx="7.5" cy="12" r="2" />
      <line x1="12" y1="9" x2="19" y2="9" />
      <line x1="12" y1="12" x2="19" y2="12" />
      <line x1="12" y1="15" x2="19" y2="15" />
    </svg>
  )
}

/** IED — Intelligent Electronic Device; lightning/zigzag symbol inside a rectangle
 *  (references the power-system relay function these devices often perform). */
function IedSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <polyline points="14,7 10,12 14,12 10,17" />
    </svg>
  )
}

/** HMI — monitor with stand and a small screen region (workstation operator interface). */
function HmiSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="3" width="20" height="14" rx="1" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <rect x="5" y="6" width="10" height="6" rx="0.5" />
    </svg>
  )
}

/** Historian — cylinder shape (ISA database/storage symbol) with mid-section data line. */
function HistorianSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <line x1="4" y1="6" x2="4" y2="18" />
      <line x1="20" y1="6" x2="20" y2="18" />
      <ellipse cx="12" cy="18" rx="8" ry="3" />
      <path d="M4 12 Q12 15 20 12" />
    </svg>
  )
}

/** Sensor — ISA instrument bubble (circle) with a connection nub at the top. */
function SensorSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <line x1="12" y1="3" x2="12" y2="7" />
    </svg>
  )
}

/** Actuator — diamond shape with crosshairs (generic actuating element symbol). */
function ActuatorSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <polygon points="12,2 22,12 12,22 2,12" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="9" y1="12" x2="15" y2="12" />
    </svg>
  )
}

/** Pump — centrifugal pump symbol: circle body with curved impeller arc and flow arrow. */
function PumpSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M 9 8 A 5 5 0 1 0 15 8" strokeLinecap="round" />
      <polyline points="13,6 15,8 13,10" />
    </svg>
  )
}

/**
 * Valve — ISA-5.1 butterfly / gate valve symbol: two opposing triangles meeting
 * at the centerline with a vertical stem line indicating actuator position.
 */
function ValveSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <polygon points="2,5 12,12 2,19" />
      <polygon points="22,5 12,12 22,19" />
      <line x1="12" y1="2" x2="12" y2="22" />
    </svg>
  )
}

/** Flow Meter — instrument bubble with horizontal flow line and a direction arrow. */
function FlowMeterSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <polyline points="8,8 12,4 16,8" />
    </svg>
  )
}

/**
 * Pressure Transmitter — instrument bubble with an arch representing a Bourdon tube
 * (the sensing element inside an analog pressure gauge).
 */
function PressureTransmitterSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M 8 16 Q 8 8 12 8 Q 16 8 16 16" />
      <line x1="12" y1="16" x2="12" y2="18" />
    </svg>
  )
}

/**
 * Firewall — staggered brick pattern; the deliberate misalignment of blocks evokes
 * a physical firewall barrier (common in network security iconography).
 */
function FirewallSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="4" width="9" height="5" />
      <rect x="13" y="4" width="9" height="5" />
      <rect x="2" y="10" width="12" height="5" />
      <rect x="16" y="10" width="6" height="5" />
      <rect x="2" y="16" width="7" height="4" />
      <rect x="11" y="16" width="11" height="4" />
    </svg>
  )
}

/**
 * IDS/IPS — shield shape with a radar/target reticle inside, representing
 * detection and monitoring (Suricata/Zeek in this stack).
 */
function IdsIpsSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M12 2 L20 6 L20 12 Q20 19 12 22 Q4 19 4 12 L4 6 Z" />
      <ellipse cx="12" cy="13" rx="4" ry="2.5" />
      <circle cx="12" cy="13" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Switch — network switch chassis with port lines and indicator LEDs (filled circles). */
function SwitchSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="9" width="20" height="7" rx="1" />
      <line x1="6" y1="9" x2="6" y2="6" />
      <line x1="10" y1="9" x2="10" y2="6" />
      <line x1="14" y1="9" x2="14" y2="6" />
      <line x1="18" y1="9" x2="18" y2="6" />
      <circle cx="6" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="10" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="14" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Router — center node with four directional spokes and bidirectional arrows. */
function RouterSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="2" x2="12" y2="7" />
      <line x1="12" y1="17" x2="12" y2="22" />
      <line x1="2" y1="12" x2="7" y2="12" />
      <line x1="17" y1="12" x2="22" y2="12" />
      <polyline points="10,4 12,2 14,4" />
      <polyline points="10,20 12,22 14,20" />
    </svg>
  )
}

// ── Level 3 Control Center icons ──────────────────────────────────────────────

/**
 * Application Server — rack chassis with three horizontal server unit slots,
 * each with a status LED. Distinguishes from generic servers by the rack enclosure.
 */
function ApplicationServerSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="2" width="20" height="20" rx="1" />
      <rect x="4" y="4" width="16" height="4" rx="0.5" />
      <rect x="4" y="10" width="16" height="4" rx="0.5" />
      <rect x="4" y="16" width="16" height="4" rx="0.5" />
      <circle cx="18" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="18" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Database Server — three-tier cylinder representing a relational or time-series
 * database. Two mid-section rings distinguish it from the single-ring Historian.
 */
function DatabaseServerSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <ellipse cx="12" cy="5" rx="8" ry="2.5" />
      <line x1="4" y1="5" x2="4" y2="19" />
      <line x1="20" y1="5" x2="20" y2="19" />
      <ellipse cx="12" cy="19" rx="8" ry="2.5" />
      <path d="M4 10 Q12 12.5 20 10" />
      <path d="M4 14.5 Q12 17 20 14.5" />
    </svg>
  )
}

/**
 * Engineering Workstation — wide monitor displaying a process/CAD screen
 * alongside a tower unit with drive bay indicators. Represents an operator
 * or engineer's full-sized workstation in the Control Center.
 */
function EngineeringWorkstationSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      {/* Monitor */}
      <rect x="1" y="2" width="14" height="11" rx="1" />
      <rect x="3" y="4" width="10" height="7" rx="0.5" />
      <line x1="6" y1="13" x2="6" y2="16" />
      <line x1="3" y1="16" x2="9" y2="16" />
      {/* Tower on the right */}
      <rect x="17" y="3" width="6" height="12" rx="1" />
      <line x1="18" y1="7" x2="22" y2="7" />
      <line x1="18" y1="10" x2="22" y2="10" />
      <circle cx="20" cy="13" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

// ── Level 4 Enterprise icons ───────────────────────────────────────────────────

/**
 * Domain Controller — hierarchical directory tree (three nodes with parent-child
 * relationships) representing an Active Directory / LDAP authentication authority.
 * The tree structure visually communicates centralized identity management.
 */
function DomainControllerSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="9" y="1" width="6" height="5" rx="1" />
      <line x1="12" y1="6" x2="12" y2="9" />
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="9" x2="4" y2="12" />
      <line x1="12" y1="9" x2="12" y2="12" />
      <line x1="20" y1="9" x2="20" y2="12" />
      <rect x="1" y="12" width="6" height="5" rx="1" />
      <rect x="9" y="12" width="6" height="5" rx="1" />
      <rect x="17" y="12" width="6" height="5" rx="1" />
    </svg>
  )
}

/**
 * Web Server — globe with vertical meridian, equator, and two latitude arcs.
 * The classic "world wide web" symbol immediately communicates internet/intranet
 * web service hosting.
 */
function WebServerSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4.5" ry="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M4.5 7.5 Q12 9.5 19.5 7.5" />
      <path d="M4.5 16.5 Q12 14.5 19.5 16.5" />
    </svg>
  )
}

/**
 * Business Server — multi-story office building silhouette with floor markers
 * and a door. Represents enterprise business application servers (ERP, CRM, etc.).
 * The building metaphor distinguishes it from rack/cylindrical server icons.
 */
function BusinessServerSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="3" y="2" width="18" height="20" rx="1" />
      <line x1="3" y1="7" x2="21" y2="7" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="17" x2="21" y2="17" />
      <rect x="10" y="18" width="4" height="4" />
      <rect x="6" y="3.5" width="3" height="2.5" />
      <rect x="15" y="3.5" width="3" height="2.5" />
    </svg>
  )
}

/**
 * Enterprise Desktop — monitor with a keyboard tray below. Differs from HMI
 * (process display) and the engineering workstation (tower + monitor) by showing
 * the classic keyboard/monitor combo that defines a generic office endpoint.
 */
function EnterpriseDesktopSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="2" width="20" height="13" rx="1" />
      <rect x="4" y="4" width="14" height="8" rx="0.5" />
      <line x1="10" y1="19" x2="14" y2="19" />
      <line x1="12" y1="15" x2="12" y2="19" />
      {/* Keyboard tray */}
      <rect x="3" y="20" width="18" height="2" rx="0.5" />
    </svg>
  )
}

// ── Level 5 Internet DMZ icons ─────────────────────────────────────────────────

/**
 * Email Server — standard envelope shape (open or closed) representing a mail
 * transfer agent (Postfix, Exchange, etc.). Universally recognized mail icon.
 */
function EmailServerSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="5" width="20" height="14" rx="1" />
      {/* Envelope flap — open V shape going to center */}
      <polyline points="2,6 12,14 22,6" />
    </svg>
  )
}

/**
 * Internet Server — cloud shape on top of a server base with connecting legs.
 * The cloud-over-server silhouette represents an internet-facing server exposed
 * to the public internet (content delivery, reverse proxy, etc.).
 */
function InternetServerSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      {/* Cloud top */}
      <path d="M6 13 Q4 13 4 11 Q4 8 7 8 Q8 5 12 5 Q16 5 17 8 Q20 8 20 11 Q20 13 18 13 Z" />
      {/* Server base */}
      <rect x="7" y="16" width="10" height="5" rx="1" />
      <line x1="7" y1="13" x2="7" y2="16" />
      <line x1="17" y1="13" x2="17" y2="16" />
      <circle cx="15" cy="18.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Process Unit (Phase 11) — vertical cylindrical vessel with inlet pipe at top,
 * outlet at bottom, and a level indicator column on the side. The symbol is
 * loosely based on ISA-5.1 vessel notation: a tall rectangle represents the
 * tank body, a vertical bar on the right side shows the fill level gauge
 * (instrument bubble convention), and short horizontal pipes at top and bottom
 * indicate inlet and outlet connections.
 *
 * Works equally well to represent a water tank, pipeline segment entry, or
 * generator stator block — the process type is configured in Properties.
 */
function ProcessUnitSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      {/* Tank body — tall rounded rectangle */}
      <rect x="5" y="3" width="12" height="18" rx="2" />
      {/* Inlet pipe at top center */}
      <line x1="11" y1="1" x2="11" y2="3" />
      <line x1="13" y1="1" x2="13" y2="3" />
      {/* Outlet pipe at bottom center */}
      <line x1="11" y1="21" x2="11" y2="23" />
      <line x1="13" y1="21" x2="13" y2="23" />
      {/* Level gauge column on right side — instrument bubble per ISA-5.1 */}
      <line x1="17" y1="5" x2="20" y2="5" />
      <line x1="17" y1="19" x2="20" y2="19" />
      <line x1="20" y1="5" x2="20" y2="19" />
      {/* Level indicator fill mark — shows ~50 % full */}
      <line x1="17" y1="12" x2="20" y2="12" strokeWidth={2} />
      {/* Internal horizontal line showing fluid surface at ~60 % */}
      <line x1="6" y1="10" x2="16" y2="10" strokeDasharray="2 1.5" />
    </svg>
  )
}

/**
 * Legacy PLC (Siemens S7) — compact CPU module silhouette with distinctive
 * Siemens-style front-panel indicators: a status LED strip on the left edge,
 * a mode selector dial, and a memory card slot recess. The narrow rectangle
 * reflects the S7-300 DIN-rail form factor. Colored amber in the palette to
 * visually distinguish legacy devices from modern PLC/RTU entries.
 */
function LegacyPlcSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      {/* CPU module body */}
      <rect x="4" y="2" width="16" height="20" rx="1" />
      {/* Front-panel status LED column (left side) */}
      <line x1="6" y1="5" x2="6" y2="5" strokeWidth={2} strokeLinecap="round" />
      <line x1="6" y1="8" x2="6" y2="8" strokeWidth={2} strokeLinecap="round" />
      <line x1="6" y1="11" x2="6" y2="11" strokeWidth={2} strokeLinecap="round" />
      {/* Mode selector keyswitch recess */}
      <rect x="8" y="4" width="8" height="5" rx="0.5" />
      <circle cx="12" cy="6.5" r="1.5" />
      {/* Memory card slot */}
      <rect x="8" y="11" width="8" height="3" rx="0.5" />
      {/* MPI/DP connector block at bottom */}
      <rect x="7" y="17" width="10" height="3" rx="0.5" />
      <line x1="9" y1="17" x2="9" y2="20" />
      <line x1="12" y1="17" x2="12" y2="20" />
      <line x1="15" y1="17" x2="15" y2="20" />
    </svg>
  )
}

/**
 * IEC 104 RTU — a Remote Terminal Unit in the telecontrol tradition: a wider
 * chassis than the S7 PLC with a front-panel analog process display (curved arc
 * representing a dial gauge), I/O terminal rows, and a communication port block.
 * Used for IEC 60870-5-104 / IEC 60870-5-101 field concentrators in substations,
 * water utilities, and energy distribution networks.
 */
function Iec104RtuSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      {/* RTU chassis body */}
      <rect x="2" y="3" width="20" height="18" rx="1" />
      {/* Analog display window (instrument bubble) */}
      <circle cx="8" cy="10" r="4" />
      {/* Gauge needle arc */}
      <path d="M5.5 12 Q8 7 10.5 12" />
      {/* I/O terminal rows on the right side */}
      <line x1="14" y1="6" x2="20" y2="6" />
      <line x1="14" y1="9" x2="20" y2="9" />
      <line x1="14" y1="12" x2="20" y2="12" />
      {/* Terminal screw symbols */}
      <circle cx="15" cy="6" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="0.8" fill="currentColor" stroke="none" />
      {/* Communication port block at bottom */}
      <rect x="5" y="17" width="14" height="2.5" rx="0.5" />
      <line x1="8" y1="17" x2="8" y2="19.5" />
      <line x1="12" y1="17" x2="12" y2="19.5" />
      <line x1="16" y1="17" x2="16" y2="19.5" />
    </svg>
  )
}

/**
 * DNS Server — a compact server chassis with a globe (world-wide resolution) and
 * a small "D" domain label above it. Instantly recognizable as a naming service
 * and visually distinct from the generic Web Server globe (which has latitude arcs).
 * The two short horizontal "query" lines below the globe represent A-record lookups.
 * Placed in the Internet DMZ palette alongside the email and internet-facing servers.
 */
function DnsServerSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      {/* Globe body */}
      <circle cx="12" cy="9" r="6" />
      {/* Vertical meridian */}
      <ellipse cx="12" cy="9" rx="2.5" ry="6" />
      {/* Equator */}
      <line x1="6" y1="9" x2="18" y2="9" />
      {/* Server chassis base */}
      <rect x="4" y="17" width="16" height="5" rx="1" />
      {/* Connecting legs from globe to chassis */}
      <line x1="8" y1="15" x2="8" y2="17" />
      <line x1="16" y1="15" x2="16" y2="17" />
      {/* Status LED */}
      <circle cx="18" cy="19.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Attack Machine — monitor with a crosshair/target overlay, clearly distinguishing
 * this device from the HMI. The red color (set via palette) reinforces that this is
 * a hostile/red-team tool (Kali Linux container).
 */
function AttackMachineSvg() {
  return (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="3" width="20" height="14" rx="1" />
      <line x1="9" y1="21" x2="15" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <circle cx="12" cy="10" r="4" />
      <line x1="12" y1="6" x2="12" y2="3" />
      <line x1="12" y1="14" x2="12" y2="17" />
      <line x1="8" y1="10" x2="5" y2="10" />
      <line x1="16" y1="10" x2="19" y2="10" />
    </svg>
  )
}

/**
 * Maps each DeviceCategory to its icon component function.
 * Used by DeviceIcon to look up the correct SVG without a switch statement.
 * Grouped by Purdue Reference Model layer for readability.
 */
const ICON_MAP: Record<DeviceCategory, () => JSX.Element> = {
  // ── OT Process (Levels 0–2) ────────────────────────────────────────────────
  plc: PlcSvg,
  rtu: RtuSvg,
  ied: IedSvg,
  'legacy-plc': LegacyPlcSvg, // Siemens S7-300/400/1200/1500 via S7comm (Phase 10)
  'iec104-rtu': Iec104RtuSvg, // IEC 60870-5-104 RTU via conpot emulation (Phase 10)
  'process-unit': ProcessUnitSvg, // physics-simulated process unit (Phase 11)
  sensor: SensorSvg,
  actuator: ActuatorSvg,
  pump: PumpSvg,
  valve: ValveSvg,
  'flow-meter': FlowMeterSvg,
  'pressure-transmitter': PressureTransmitterSvg,
  // ── Control Center (Level 3) ────────────────────────────────────────────────
  hmi: HmiSvg,
  historian: HistorianSvg,
  'application-server': ApplicationServerSvg,
  'database-server': DatabaseServerSvg,
  'engineering-workstation': EngineeringWorkstationSvg,
  // ── Plant DMZ (Level 3.5) ───────────────────────────────────────────────────
  firewall: FirewallSvg,
  'ids-ips': IdsIpsSvg,
  switch: SwitchSvg,
  router: RouterSvg,
  // ── Enterprise Zone (Level 4) ───────────────────────────────────────────────
  'domain-controller': DomainControllerSvg,
  'web-server': WebServerSvg,
  'business-server': BusinessServerSvg,
  'enterprise-desktop': EnterpriseDesktopSvg,
  // ── Internet DMZ (Level 5) ───────────────────────────────────────────────────
  'email-server': EmailServerSvg,
  'internet-server': InternetServerSvg,
  'dns-server': DnsServerSvg, // authoritative DNS for meridian-process.com (Phase 12)
  // ── Red Team ─────────────────────────────────────────────────────────────────
  'attack-machine': AttackMachineSvg
}

/**
 * Renders the ISA-5.1-inspired SVG icon for a given device category.
 *
 * Wraps the raw SVG in a `<span>` with `display: inline-flex` so it flows
 * correctly in both flex containers (palette items) and grid layouts (device nodes).
 * The `flexShrink: 0` prevents the icon from being squeezed in tight horizontal layouts.
 *
 * @param category  - The DeviceCategory to render an icon for.
 * @param size      - Width and height in pixels (defaults to 24).
 * @param color     - CSS color value passed as `color` to the span, inherited by
 *   `stroke: currentColor` inside the SVG. Defaults to 'currentColor'.
 * @param className - Optional CSS class for the wrapper span.
 */
export function DeviceIcon({
  category,
  size = 24,
  color = 'currentColor',
  className
}: {
  category: DeviceCategory
  size?: number
  color?: string
  className?: string
}) {
  const IconComponent = ICON_MAP[category]
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', width: size, height: size, color, flexShrink: 0 }}
    >
      <IconComponent />
    </span>
  )
}
