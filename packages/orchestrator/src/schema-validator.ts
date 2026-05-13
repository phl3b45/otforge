/**
 * schema-validator.ts — Runtime validation for ICSLabScenario JSON documents.
 *
 * .icslab files are user-created JSON files that the app imports from disk. Because
 * the files come from an untrusted source (filesystem, email attachment, USB drive),
 * we validate their structure before doing anything with them. This prevents silent
 * data corruption and gives the user a clear error message if the file is malformed.
 *
 * Validation approach:
 *   - We do not use a JSON Schema library (ajv, zod) to keep the orchestrator package
 *     free of heavy runtime dependencies. The validation logic is hand-written and
 *     targeted at the fields that the orchestrator actually reads.
 *   - The renderer can also call this via IPC (scenario:validate) to pre-check a
 *     scenario that the user built in the canvas editor before exporting it.
 *
 * Device limit:
 *   MAX_DEVICES is set to 20 to keep resource consumption within the bounds of a
 *   typical developer/researcher laptop. Each device adds at least one Docker container.
 */

import type { ICSLabScenario } from '@ics-sim/schema'

/** Returned by validateScenario() — callers check `valid` and display `errors` if false. */
export interface ValidationResult {
  valid: boolean
  /** Human-readable error messages suitable for display in a dialog or alert. */
  errors: string[]
}

/** Maximum number of devices allowed in a single scenario. */
const MAX_DEVICES = 20

/**
 * Validates that a raw JSON value conforms to the ICSLabScenario schema.
 *
 * Checks the four required top-level sections (meta, network, devices, security)
 * and validates critical fields within each. The check is intentionally shallow —
 * we verify the fields the orchestrator depends on, not every possible field.
 *
 * @param raw - The parsed JSON value to validate (typically JSON.parse() output).
 * @returns ValidationResult with `valid: true` and empty errors when the scenario
 *   is structurally sound, or `valid: false` with a list of specific error strings.
 *
 * @example
 *   const result = validateScenario(JSON.parse(fileContent))
 *   if (!result.valid) throw new Error(result.errors.join('\n'))
 */
export function validateScenario(raw: unknown): ValidationResult {
  const errors: string[] = []

  // Guard: must be a non-null object — arrays and primitives are rejected early
  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, errors: ['Scenario must be a JSON object'] }
  }

  const s = raw as Partial<ICSLabScenario>

  // ── meta section ────────────────────────────────────────────────────────────
  if (!s.meta) errors.push('Missing required field: meta')
  else {
    if (!s.meta.name) errors.push('meta.name is required')
    if (!s.meta.sector) errors.push('meta.sector is required')
    // formatVersion must be exactly "1.0" — future versions will add migration logic
    if (s.meta.formatVersion !== '1.0') errors.push('meta.formatVersion must be "1.0"')
  }

  // ── network section ──────────────────────────────────────────────────────────
  if (!s.network) errors.push('Missing required field: network')
  else if (!Array.isArray(s.network.segments) || s.network.segments.length === 0) {
    // At least one subnet segment is required for the compose generator to create Docker networks
    errors.push('network.segments must be a non-empty array')
  }

  // ── devices section ──────────────────────────────────────────────────────────
  if (!s.devices) {
    errors.push('Missing required field: devices')
  } else {
    const deviceEntries = Object.entries(s.devices.devices ?? {})

    if (deviceEntries.length === 0) errors.push('Scenario must contain at least one device')
    if (deviceEntries.length > MAX_DEVICES) {
      errors.push(
        `Scenario exceeds maximum device count of ${MAX_DEVICES} (found ${deviceEntries.length})`
      )
    }

    // Each device must have an IP and category — both are required by the compose generator
    for (const [id, device] of deviceEntries) {
      if (!device.ipAddress) errors.push(`Device "${id}" is missing ipAddress`)
      if (!device.category) errors.push(`Device "${id}" is missing category`)
    }
  }

  // ── security section ─────────────────────────────────────────────────────────
  // Presence-only check — the compose generator injects default Suricata/Zeek regardless
  if (!s.security) errors.push('Missing required field: security')

  return { valid: errors.length === 0, errors }
}

/**
 * Converts a human-readable scenario name into a Docker Compose project name.
 *
 * Docker Compose project names must be lowercase and contain only letters, digits,
 * and hyphens. We prefix with "ics-sim-" to namespace all project resources and
 * avoid collisions with other Docker projects on the same machine.
 *
 * @param scenarioName - The scenario's display name (e.g., "Water Treatment Plant #1").
 * @returns A sanitized project name (e.g., "ics-sim-water-treatment-plant-1").
 *
 * @example
 *   toProjectName('Oil & Gas — Refinery')  // → 'ics-sim-oil-gas-refinery'
 */
export function toProjectName(scenarioName: string): string {
  return `ics-sim-${scenarioName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // Replace any non-alphanumeric run with a single hyphen
    .replace(/^-+|-+$/g, '')}` // Strip leading/trailing hyphens from the result
}
