// .icspack community scenario pack format.
//
// A pack is a ZIP archive with a pack.json manifest at its root. Packs are the
// community contribution mechanism for ICS Simulator — instructors can share
// pre-built scenarios, custom device types, sector-specific Suricata rules, and
// Zeek scripts without modifying the core application.
//
// Pack ZIP layout:
//   pack.json                  — this manifest (required)
//   scenarios/                 — .icslab scenario files
//   devices/
//     registry.json            — array of PackDeviceType definitions
//     icons/                   — SVG icon files referenced by registry.json
//   rules/
//     suricata/                — .rules files (Emerging Threats format)
//     zeek/                    — .zeek script files

import type { Sector, DeviceCategory, Protocol } from './icslab'

// ── Pack manifest ──────────────────────────────────────────────────────────────

/**
 * Root manifest stored as pack.json at the top level of an .icspack ZIP.
 *
 * All path strings are relative to the pack's root directory (i.e., relative
 * to where pack.json lives after the ZIP is extracted).
 */
export interface ICSPackManifest {
  /** Always "1.0" — used to detect future format breaking changes. */
  formatVersion: '1.0'

  /**
   * Unique identifier for this pack. Use kebab-case, e.g. "oil-gas-attack".
   * Two installed packs with the same id cannot coexist — installing a pack
   * with an existing id overwrites the previous version.
   */
  id: string

  /** Human-readable display name shown in the Pack Manager. */
  name: string

  /** Semantic version string, e.g. "1.0.0". */
  version: string

  /** Short description shown beneath the pack name in the Pack Manager. */
  description: string

  /** Author name or GitHub username. */
  author: string

  /**
   * Primary sector this pack targets.
   * Omit (undefined) for multi-sector or generic packs.
   */
  sector?: Sector

  /**
   * Relative paths to .icslab scenario files bundled in this pack.
   * e.g. ["scenarios/pipeline-attack.icslab", "scenarios/pump-station.icslab"]
   */
  scenarios: string[]

  /**
   * Relative path to the device registry JSON file.
   * The file must contain an array of PackDeviceType objects.
   * Omit if this pack adds no new device types.
   */
  deviceRegistry?: string

  /**
   * Relative paths to Suricata .rules files bundled in this pack.
   * Rules are surfaced in the IDS panel as available rulesets.
   * e.g. ["rules/suricata/oil-gas-scada.rules"]
   */
  suricataRules: string[]

  /**
   * Relative paths to Zeek .zeek script files bundled in this pack.
   * Scripts are surfaced in the IDS panel as available Zeek scripts.
   * e.g. ["rules/zeek/modbus-anomaly.zeek"]
   */
  zeekScripts: string[]
}

// ── Pack device type ───────────────────────────────────────────────────────────

/**
 * A custom device type contributed by a pack.
 *
 * Pack device types must use an existing DeviceCategory (they cannot introduce
 * new categories in v1). The primary value they add is a custom Docker image,
 * a recognizable label, and optionally a custom icon.
 *
 * Stored in devices/registry.json inside the pack ZIP. Fields map onto
 * DeviceTypeDefinition from icslab.ts — a subset sufficient for the palette.
 */
export interface PackDeviceType {
  /**
   * Unique identifier within the pack, e.g. "plc-siemens-s7-300".
   * Prefixed with the pack id when registered in-memory to avoid collisions:
   * "oil-gas-attack:plc-siemens-s7-300".
   */
  id: string

  /** Must be an existing DeviceCategory — packs cannot add new categories in v1. */
  category: DeviceCategory

  /** Display name shown in the palette, e.g. "Siemens S7-300 PLC". */
  label: string

  /**
   * Path to an SVG icon file relative to the pack's devices/ folder.
   * e.g. "icons/siemens-s7.svg"
   * Omit to use the standard category icon.
   */
  iconPath?: string

  /** Default protocols for this device type. */
  defaultProtocols: Protocol[]

  /**
   * Docker image to use for this device type, overriding the built-in default.
   * e.g. "ghcr.io/iburres/ics-sim/openplc:latest"
   */
  defaultDockerImage: string

  /**
   * Which sector this device type applies to.
   * Omit to show in all sectors.
   */
  sector?: Sector
}

// ── Installed pack (runtime, not stored on disk) ───────────────────────────────

/**
 * An installed pack as seen by the renderer.
 * The main process assembles this from the pack manifest + resolved assets
 * (SVG icons read from disk and converted to data URLs).
 */
export interface InstalledPack {
  /** The parsed pack.json manifest. */
  manifest: ICSPackManifest

  /** Absolute path to the extracted pack directory on disk. */
  installPath: string

  /** ISO 8601 timestamp of when the pack was installed. */
  installedAt: string

  /**
   * Resolved device types from deviceRegistry, with iconDataUrl pre-loaded.
   * Empty array if the pack has no deviceRegistry or it failed to parse.
   */
  deviceTypes: ResolvedPackDeviceType[]

  /**
   * Display metadata for each bundled scenario.
   * Populated by reading each .icslab file's meta.name (or falling back to
   * the filename if the file cannot be parsed).
   */
  scenarioMetas: PackScenarioMeta[]
}

/**
 * PackDeviceType with the icon resolved to a base64 data URL (or empty string
 * if no icon file was found). Used by the renderer so it never needs to do
 * file I/O directly.
 */
export interface ResolvedPackDeviceType extends PackDeviceType {
  /**
   * Base64 data URL of the SVG icon, e.g. "data:image/svg+xml;base64,...".
   * Empty string if iconPath was absent or the file could not be read.
   */
  iconDataUrl: string

  /** The pack id that contributed this type (for display in the palette). */
  packId: string
}

/**
 * Lightweight scenario metadata entry read from a bundled .icslab file.
 * Avoids sending the full scenario object just to populate the Pack Manager list.
 */
export interface PackScenarioMeta {
  /** Relative path to the .icslab file within the pack (matches manifest.scenarios entry). */
  relativePath: string
  /** Scenario name from meta.name, or the filename if parsing failed. */
  name: string
  /** Scenario description from meta.description. */
  description: string
  /** Whether the scenario is locked (student copy). */
  locked: boolean
}
