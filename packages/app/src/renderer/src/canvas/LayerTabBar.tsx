/**
 * LayerTabBar.tsx — Purdue Reference Model layer navigation tabs.
 *
 * Renders five tabs corresponding to ISA-95 / IEC 62443-3-2 Purdue Model levels,
 * displayed between the toolbar and the 3-column workspace. The active tab scopes
 * the canvas, device palette, and properties panel to that Purdue layer.
 *
 * Tab order (left → right) follows the Purdue model from field level to internet:
 *   OT Process     — Levels 0–2:  PLCs, RTUs, IEDs, field sensors/actuators
 *   Control Center — Level 3:     HMIs, historians, application/database servers
 *   Plant DMZ      — Level 3.5:   Firewalls, IDS/IPS, jump hosts, Suricata/Zeek
 *   Enterprise     — Level 4:     Domain controllers, web/business servers, desktops
 *   Internet DMZ   — Level 5:     Email servers, internet-facing servers
 *
 * The 'attacker' zone is intentionally excluded from tabs — the attack machine is
 * launched via a dedicated toolbar button and runs in a separate OS window.
 *
 * Each tab shows:
 *   - Zone color accent (left border + active bottom underline)
 *   - Layer name + Purdue level badge
 *   - Sub-label describing what lives in this layer
 *   - Device count badge (devices currently placed in this layer)
 *
 * @param activeLayer   - The currently selected Purdue layer.
 * @param scenario      - Active scenario (null = no scenario open). Used to
 *                        count devices per layer for the count badge.
 * @param onLayerChange - Callback when the user clicks a different tab.
 * @param simIsRunning  - Whether a simulation is currently running. Gates the trailing
 *                        SCADA button the same way the toolbar's "Open HMI" button is gated.
 * @param onScadaOpen   - Callback when the trailing SCADA button is clicked. Unlike the
 *                        five Purdue tabs, this is an action (opens a popup window), not a
 *                        zone filter — it does not call onLayerChange.
 */

import type { NetworkZone, OTForgeScenario } from '@otforge/schema'

/**
 * The five Purdue zones that appear as navigable layer tabs.
 * 'attacker' is a valid NetworkZone but is excluded from tabs — the red team
 * machine has its own launcher window separate from the canvas workflow.
 */
type PurdueLayerZone = 'ot' | 'control' | 'plant-dmz' | 'enterprise' | 'internet-dmz'

/** Display name for each Purdue layer tab. */
const LAYER_LABELS: Record<PurdueLayerZone, string> = {
  ot: 'OT Process',
  control: 'Control Center',
  'plant-dmz': 'Plant DMZ',
  enterprise: 'Enterprise',
  'internet-dmz': 'Internet DMZ'
}

/** Purdue level badge text shown inside each tab. */
const LAYER_LEVEL: Record<PurdueLayerZone, string> = {
  ot: 'L0–L2',
  control: 'L3',
  'plant-dmz': 'L3.5',
  enterprise: 'L4',
  'internet-dmz': 'L5'
}

/** One-line description of what belongs in each layer. */
const LAYER_SUBLABEL: Record<PurdueLayerZone, string> = {
  ot: 'PLCs · RTUs · IEDs · Field devices',
  control: 'HMIs · Historians · App/DB servers',
  'plant-dmz': 'Firewalls · IDS/IPS · Jump hosts',
  enterprise: 'Domain ctrl · Web · Business · Desktops',
  'internet-dmz': 'Email servers · Internet-facing servers'
}

/**
 * Zone accent colors — match ZONE_COLORS in DeviceNode.tsx.
 * Exported so other components (PropertiesPanel, etc.) can reference the same palette.
 */
export const LAYER_COLORS: Record<NetworkZone, string> = {
  ot: '#39d0b0',
  control: '#388bfd',
  'plant-dmz': '#d29922',
  enterprise: '#a371f7',
  'internet-dmz': '#f78166',
  attacker: '#f85149'
}

/** Tab rendering order — Purdue model from field devices (OT) through internet (L5). */
const LAYER_ORDER: PurdueLayerZone[] = ['ot', 'control', 'plant-dmz', 'enterprise', 'internet-dmz']

/**
 * Maps a device category to its Purdue layer for the count badge fallback.
 * Used only when no visual layer positions have been saved yet.
 */
function inferLayerFromCategory(category: string): PurdueLayerZone {
  // Level 3 Control Center devices
  if (
    [
      'hmi',
      'historian',
      'application-server',
      'database-server',
      'engineering-workstation'
    ].includes(category)
  )
    return 'control'
  // Level 3.5 Plant DMZ devices
  if (['firewall', 'ids-ips', 'switch', 'router'].includes(category)) return 'plant-dmz'
  // Level 4 Enterprise devices
  if (
    ['domain-controller', 'web-server', 'business-server', 'enterprise-desktop'].includes(category)
  )
    return 'enterprise'
  // Level 5 Internet DMZ devices
  if (['email-server', 'internet-server'].includes(category)) return 'internet-dmz'
  // attack-machine is excluded from tabs — it lives in the 'attacker' zone
  // Default OT for all other devices (PLCs, RTUs, sensors, field devices)
  return 'ot'
}

/**
 * Counts devices per Purdue layer tab in a scenario.
 *
 * Reads each CanvasNode's data.zone when visual positions are saved.
 * Falls back to category-based inference when no visual layer exists yet.
 * Attack machines (zone='attacker') are excluded from all counts.
 *
 * @param scenario - The active scenario, or null.
 * @returns A map from PurdueLayerZone to device count.
 */
function countDevicesByLayer(scenario: OTForgeScenario | null): Record<PurdueLayerZone, number> {
  const counts: Record<PurdueLayerZone, number> = {
    ot: 0,
    control: 0,
    'plant-dmz': 0,
    enterprise: 0,
    'internet-dmz': 0
  }
  if (!scenario) return counts

  if (scenario.visual.nodes.length > 0) {
    // Count from saved visual layer — each node carries its zone in data.zone
    for (const node of scenario.visual.nodes) {
      const z = node.data.zone as NetworkZone
      if (z in counts) counts[z as PurdueLayerZone]++
      // attacker zone nodes are silently excluded from tab counts
    }
  } else {
    // No visual data yet — infer from device category
    for (const dev of Object.values(scenario.devices.devices)) {
      if (dev.category === 'attack-machine') continue // excluded from tabs
      const layer = inferLayerFromCategory(dev.category)
      counts[layer]++
    }
  }
  return counts
}

interface LayerTabBarProps {
  activeLayer: NetworkZone
  scenario: OTForgeScenario | null
  onLayerChange: (layer: NetworkZone) => void
  simIsRunning: boolean
  onScadaOpen: () => void
}

/**
 * Horizontal tab bar for switching between Purdue Reference Model layers, plus a
 * trailing SCADA action button.
 *
 * Only the five ISA-95 Purdue zones appear as tabs. The 'attacker' zone is
 * intentionally absent — the attack machine has its own OS window workflow.
 */
export function LayerTabBar({
  activeLayer,
  scenario,
  onLayerChange,
  simIsRunning,
  onScadaOpen
}: LayerTabBarProps) {
  const counts = countDevicesByLayer(scenario)

  return (
    <nav className="layer-tab-bar" role="tablist" aria-label="Purdue Reference Model layers">
      {LAYER_ORDER.map(layer => {
        const isActive = layer === activeLayer
        const color = LAYER_COLORS[layer]
        const count = counts[layer]

        return (
          <button
            key={layer}
            role="tab"
            aria-selected={isActive}
            className={`layer-tab ${isActive ? 'active' : ''}`}
            style={
              {
                '--layer-color': color,
                borderLeftColor: color
              } as React.CSSProperties
            }
            onClick={() => onLayerChange(layer)}
          >
            {/* Level badge — e.g. "L0–L2", "L3", "L3.5" */}
            <span className="layer-tab-level" style={{ color }}>
              {LAYER_LEVEL[layer]}
            </span>

            {/* Layer name + device count badge */}
            <span className="layer-tab-name">
              {LAYER_LABELS[layer]}
              {count > 0 && (
                <span className="layer-tab-count" style={{ background: color }}>
                  {count}
                </span>
              )}
            </span>

            {/* Description sub-label */}
            <span className="layer-tab-sublabel">{LAYER_SUBLABEL[layer]}</span>
          </button>
        )
      })}

      {/* Trailing SCADA action button — opens a popup window (like the toolbar's "Open
          HMI"/Grafana buttons), not a zone filter, so it doesn't call onLayerChange. */}
      <button
        className="layer-tab layer-tab-action"
        disabled={!simIsRunning}
        onClick={onScadaOpen}
        title={
          simIsRunning
            ? 'Open auto-generated SCADA Overview (OT-zone devices only) in a new window'
            : 'Start the simulation to open the SCADA Overview'
        }
        style={
          {
            '--layer-color': LAYER_COLORS.ot,
            borderLeftColor: LAYER_COLORS.ot
          } as React.CSSProperties
        }
      >
        <span className="layer-tab-level" style={{ color: LAYER_COLORS.ot }}>
          ↗
        </span>
        <span className="layer-tab-name">SCADA</span>
        <span className="layer-tab-sublabel">Auto-generated P&amp;ID + alarms</span>
      </button>
    </nav>
  )
}
