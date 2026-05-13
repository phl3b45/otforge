/**
 * schema-validator.test.ts — Unit tests for ICSLabScenario runtime validation.
 *
 * .icslab files come from disk (import dialog, USB, email attachment) and must
 * be fully validated before the compose generator or renderer touches them.
 * These tests verify every check in validateScenario() and all edge cases in
 * toProjectName() so that malformed files are caught with clear error messages
 * rather than silent failures downstream.
 *
 * Testing strategy:
 *   - Start from a known-good "golden" raw object that passes every check.
 *   - Mutate one field per test to isolate exactly which rule fires.
 *   - Check the specific error message text so that UI error dialogs stay accurate.
 */

import { describe, it, expect } from 'vitest'
import { validateScenario, toProjectName } from '../schema-validator'

// ── Test fixtures ────────────────────────────────────────────────────────────

/**
 * Minimal raw JSON object that satisfies every field checked by validateScenario().
 *
 * The validator casts to Partial<ICSLabScenario> so it only needs the fields
 * it actually reads — it does not require a fully populated ICSLabScenario.
 * This fixture therefore only provides those exact fields.
 */
const VALID_RAW = {
  meta: {
    formatVersion: '1.0',
    name: 'Water Treatment Plant',
    sector: 'water-treatment'
  },
  network: {
    segments: [
      {
        zone: 'ot',
        subnet: '172.20.10.0/24',
        gateway: '172.20.10.1',
        dockerNetwork: 'ics-sim-ot-net'
      }
    ]
  },
  devices: {
    devices: {
      'plc-1': { nodeId: 'plc-1', category: 'plc', ipAddress: '172.20.10.10' }
    }
  },
  security: { defaultFirewallPolicy: 'deny' }
}

// ── validateScenario ─────────────────────────────────────────────────────────

describe('validateScenario', () => {
  // ── Valid input ────────────────────────────────────────────────────────────

  describe('valid scenario', () => {
    it('returns valid with empty errors array for a well-formed scenario', () => {
      const result = validateScenario(VALID_RAW)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('accepts scenarios with multiple devices up to the 20-device limit', () => {
      const devices: Record<string, { nodeId: string; category: string; ipAddress: string }> = {}
      for (let i = 0; i < 20; i++) {
        devices[`sensor-${i}`] = {
          nodeId: `sensor-${i}`,
          category: 'sensor',
          ipAddress: `172.20.10.${i + 10}`
        }
      }
      const raw = { ...VALID_RAW, devices: { devices } }
      expect(validateScenario(raw).valid).toBe(true)
    })
  })

  // ── Top-level type guards ──────────────────────────────────────────────────

  describe('top-level type guard', () => {
    it('rejects null — returns immediately with a single descriptive error', () => {
      const result = validateScenario(null)
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(/JSON object/)
    })

    it('rejects a plain array — arrays are not scenario documents', () => {
      expect(validateScenario([])).toMatchObject({ valid: false })
    })

    it('rejects a string — even a JSON string is not an object', () => {
      expect(validateScenario('{"meta":{}}' as unknown)).toMatchObject({ valid: false })
    })

    it('rejects a number', () => {
      expect(validateScenario(42 as unknown)).toMatchObject({ valid: false })
    })
  })

  // ── meta section ──────────────────────────────────────────────────────────

  describe('meta section', () => {
    it('rejects a scenario with no meta field', () => {
      const raw = { ...VALID_RAW, meta: undefined }
      const result = validateScenario(raw)
      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(expect.stringContaining('meta'))
    })

    it('rejects meta with an empty name', () => {
      const raw = { ...VALID_RAW, meta: { ...VALID_RAW.meta, name: '' } }
      expect(validateScenario(raw).errors).toContainEqual(expect.stringContaining('meta.name'))
    })

    it('rejects meta with no sector', () => {
      const raw = { ...VALID_RAW, meta: { ...VALID_RAW.meta, sector: '' } }
      expect(validateScenario(raw).errors).toContainEqual(expect.stringContaining('meta.sector'))
    })

    it('rejects formatVersion "2.0" — only "1.0" is supported', () => {
      const raw = { ...VALID_RAW, meta: { ...VALID_RAW.meta, formatVersion: '2.0' } }
      expect(validateScenario(raw).errors).toContainEqual(expect.stringContaining('formatVersion'))
    })

    it('rejects a missing formatVersion field', () => {
      const raw = { ...VALID_RAW, meta: { name: 'Test', sector: 'generic' } }
      expect(validateScenario(raw).valid).toBe(false)
    })
  })

  // ── network section ────────────────────────────────────────────────────────

  describe('network section', () => {
    it('rejects a scenario with no network field', () => {
      const raw = { ...VALID_RAW, network: undefined }
      expect(validateScenario(raw).valid).toBe(false)
    })

    it('rejects an empty segments array — compose generator needs at least one subnet', () => {
      const raw = { ...VALID_RAW, network: { segments: [] } }
      expect(validateScenario(raw).errors).toContainEqual(expect.stringContaining('segments'))
    })

    it('rejects a non-array segments value', () => {
      const raw = { ...VALID_RAW, network: { segments: 'ot' } }
      expect(validateScenario(raw).valid).toBe(false)
    })
  })

  // ── devices section ────────────────────────────────────────────────────────

  describe('devices section', () => {
    it('rejects a scenario with no devices field', () => {
      const raw = { ...VALID_RAW, devices: undefined }
      expect(validateScenario(raw).valid).toBe(false)
    })

    it('rejects an empty device map — every scenario needs at least one device', () => {
      const raw = { ...VALID_RAW, devices: { devices: {} } }
      expect(validateScenario(raw).errors).toContainEqual(
        expect.stringContaining('at least one device')
      )
    })

    it('rejects more than 20 devices — enforces the laptop resource limit', () => {
      const devices: Record<string, { nodeId: string; category: string; ipAddress: string }> = {}
      for (let i = 0; i < 21; i++) {
        devices[`sensor-${i}`] = {
          nodeId: `sensor-${i}`,
          category: 'sensor',
          ipAddress: `172.20.10.${i + 10}`
        }
      }
      const raw = { ...VALID_RAW, devices: { devices } }
      expect(validateScenario(raw).errors).toContainEqual(
        expect.stringContaining('maximum device count')
      )
    })

    it('rejects a device with an empty ipAddress', () => {
      const raw = {
        ...VALID_RAW,
        devices: {
          devices: {
            'rtu-1': { nodeId: 'rtu-1', category: 'rtu', ipAddress: '' }
          }
        }
      }
      expect(validateScenario(raw).errors).toContainEqual(expect.stringContaining('"rtu-1"'))
      expect(validateScenario(raw).errors).toContainEqual(expect.stringContaining('ipAddress'))
    })

    it('rejects a device with an empty category', () => {
      const raw = {
        ...VALID_RAW,
        devices: {
          devices: {
            'valve-1': { nodeId: 'valve-1', category: '', ipAddress: '172.20.10.20' }
          }
        }
      }
      expect(validateScenario(raw).errors).toContainEqual(expect.stringContaining('category'))
    })

    it('includes the device node ID in the error message to help the user identify the broken device', () => {
      const raw = {
        ...VALID_RAW,
        devices: {
          devices: {
            'my-important-plc': { nodeId: 'my-important-plc', category: 'plc', ipAddress: '' }
          }
        }
      }
      const result = validateScenario(raw)
      expect(result.errors.some(e => e.includes('my-important-plc'))).toBe(true)
    })
  })

  // ── security section ───────────────────────────────────────────────────────

  describe('security section', () => {
    it('rejects a scenario with no security field', () => {
      const raw = { ...VALID_RAW, security: undefined }
      const result = validateScenario(raw)
      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(expect.stringContaining('security'))
    })
  })

  // ── error accumulation ─────────────────────────────────────────────────────

  describe('error accumulation', () => {
    it('collects errors from all failing sections in a single pass', () => {
      // Only provide meta (with a valid formatVersion but missing name/sector)
      // so that network, devices, and security all fail too.
      const raw = {
        meta: { formatVersion: '1.0', name: '', sector: '' }
      }
      const result = validateScenario(raw)
      expect(result.valid).toBe(false)
      // Expect at least: meta.name, meta.sector, network missing, devices missing, security missing
      expect(result.errors.length).toBeGreaterThanOrEqual(4)
    })

    it('returns valid: false whenever any error exists', () => {
      // Even a single error must set valid to false
      const raw = { ...VALID_RAW, security: undefined }
      expect(validateScenario(raw).valid).toBe(false)
    })
  })
})

// ── toProjectName ─────────────────────────────────────────────────────────────

describe('toProjectName', () => {
  it('always prefixes the result with "ics-sim-"', () => {
    expect(toProjectName('Demo')).toMatch(/^ics-sim-/)
  })

  it('lowercases the entire name', () => {
    expect(toProjectName('Water Plant')).toBe('ics-sim-water-plant')
  })

  it('replaces spaces with hyphens', () => {
    expect(toProjectName('Oil Gas Refinery')).toBe('ics-sim-oil-gas-refinery')
  })

  it('collapses multiple consecutive spaces or special characters into a single hyphen', () => {
    expect(toProjectName('Water  Treatment   Plant')).toBe('ics-sim-water-treatment-plant')
  })

  it('strips ampersands, em-dashes, and other punctuation', () => {
    expect(toProjectName('Oil & Gas — Refinery!')).toBe('ics-sim-oil-gas-refinery')
  })

  it('strips leading and trailing hyphens from the sanitized portion', () => {
    expect(toProjectName('--Demo--')).toBe('ics-sim-demo')
  })

  it('preserves digits in the name', () => {
    expect(toProjectName('Plant 42')).toBe('ics-sim-plant-42')
  })

  it('handles a name that is already a valid kebab-case identifier', () => {
    expect(toProjectName('my-scenario')).toBe('ics-sim-my-scenario')
  })

  it('handles a name consisting entirely of special characters', () => {
    // Should produce just the prefix with nothing after it — or a prefix-only result
    const result = toProjectName('!!! ???')
    expect(result).toMatch(/^ics-sim/)
  })
})
