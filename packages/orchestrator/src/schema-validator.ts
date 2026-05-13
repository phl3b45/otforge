import type { ICSLabScenario } from '@ics-sim/schema'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

const MAX_DEVICES = 20

export function validateScenario(raw: unknown): ValidationResult {
  const errors: string[] = []

  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, errors: ['Scenario must be a JSON object'] }
  }

  const s = raw as Partial<ICSLabScenario>

  // meta
  if (!s.meta) errors.push('Missing required field: meta')
  else {
    if (!s.meta.name) errors.push('meta.name is required')
    if (!s.meta.sector) errors.push('meta.sector is required')
    if (s.meta.formatVersion !== '1.0') errors.push('meta.formatVersion must be "1.0"')
  }

  // network
  if (!s.network) errors.push('Missing required field: network')
  else if (!Array.isArray(s.network.segments) || s.network.segments.length === 0) {
    errors.push('network.segments must be a non-empty array')
  }

  // devices
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
    for (const [id, device] of deviceEntries) {
      if (!device.ipAddress) errors.push(`Device "${id}" is missing ipAddress`)
      if (!device.category) errors.push(`Device "${id}" is missing category`)
    }
  }

  // security
  if (!s.security) errors.push('Missing required field: security')

  return { valid: errors.length === 0, errors }
}

// Sanitize a scenario name into a Docker Compose project name
export function toProjectName(scenarioName: string): string {
  return `ics-sim-${scenarioName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`
}
