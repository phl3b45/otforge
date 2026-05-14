/**
 * LayerTabBar.tsx — Purdue model layer navigation tabs.
 *
 * Renders four tabs, one per ISA-95 / Purdue level, displayed between the
 * toolbar and the 3-column workspace. The active tab determines which layer
 * the canvas, palette, and properties panel are scoped to.
 *
 * Tab order (left → right) matches the Purdue model top-down:
 *   OT Process   — Levels 0–2: PLCs, RTUs, IEDs, field sensors/actuators
 *   IT Network   — Level 4:    Historians, HMIs, business systems
 *   DMZ          — Level 3.5:  Firewalls, jump hosts, IDS/IPS sensors
 *   External     — Level 5:    Internet-facing, red-team attack machine
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
 */

import type { NetworkZone, ICSLabScenario } from '@ics-sim/schema'

/** Display name for each Purdue layer tab. */
const LAYER_LABELS: Record<NetworkZone, string> = {
  ot: 'OT Process',
  it: 'IT Network',
  dmz: 'DMZ',
  external: 'External'
}

/** Purdue level badge text shown inside each tab. */
const LAYER_LEVEL: Record<NetworkZone, string> = {
  ot: 'L0–L2',
  it: 'L4',
  dmz: 'L3.5',
  external: 'L5'
}

/** One-line description of what belongs in each layer. */
const LAYER_SUBLABEL: Record<NetworkZone, string> = {
  ot: 'PLCs · RTUs · IEDs · Field devices',
  it: 'Historians · HMIs · Business systems',
  dmz: 'Firewalls · Jump hosts · IDS/IPS',
  external: 'Attack machine · Internet-facing'
}

/** Zone accent colors — match ZONE_COLORS in DeviceNode.tsx. */
export const LAYER_COLORS: Record<NetworkZone, string> = {
  ot: '#39d0b0',
  it: '#388bfd',
  dmz: '#d29922',
  external: '#f85149'
}

/** Tab rendering order — Purdue model from field (OT) to enterprise (External). */
const LAYER_ORDER: NetworkZone[] = ['ot', 'it', 'dmz', 'external']

/**
 * Counts devices per zone in a scenario by reading each CanvasNode's data.zone.
 * Falls back to counting from device category when no visual layer is saved.
 *
 * @param scenario - The active scenario, or null.
 * @returns A map from NetworkZone to device count.
 */
function countDevicesByLayer(scenario: ICSLabScenario | null): Record<NetworkZone, number> {
  const counts: Record<NetworkZone, number> = { ot: 0, it: 0, dmz: 0, external: 0 }
  if (!scenario) return counts

  if (scenario.visual.nodes.length > 0) {
    // Count from saved visual layer — each node carries its zone in data.zone
    for (const node of scenario.visual.nodes) {
      const z = node.data.zone as NetworkZone
      if (z in counts) counts[z]++
    }
  } else {
    // No visual data yet — infer from device category (matches ScadaCanvas auto-layout)
    for (const dev of Object.values(scenario.devices.devices)) {
      if (dev.category === 'attack-machine') counts.external++
      else if (dev.category === 'firewall' || dev.category === 'ids-ips') counts.dmz++
      else if (dev.category === 'historian' || dev.category === 'hmi') counts.it++
      else counts.ot++
    }
  }
  return counts
}

interface LayerTabBarProps {
  activeLayer: NetworkZone
  scenario: ICSLabScenario | null
  onLayerChange: (layer: NetworkZone) => void
}

/**
 * Horizontal tab bar for switching between Purdue model layers.
 */
export function LayerTabBar({ activeLayer, scenario, onLayerChange }: LayerTabBarProps) {
  const counts = countDevicesByLayer(scenario)

  return (
    <nav className="layer-tab-bar" role="tablist" aria-label="Purdue model layers">
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
            {/* Level badge */}
            <span className="layer-tab-level" style={{ color }}>
              {LAYER_LEVEL[layer]}
            </span>

            {/* Layer name + device count */}
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
    </nav>
  )
}
