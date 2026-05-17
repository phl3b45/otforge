/**
 * SecurityPanel.tsx — Firewall ACL editor and IDS/IPS configuration panels (Phase 5).
 *
 * Exports two sub-panels rendered inside PropertiesPanel when a security device is selected:
 *
 *   FirewallPanel — shown when a "firewall" device is selected on the canvas.
 *     Edits scenario.security.defaultFirewallPolicy (deny-by-default toggle) and
 *     scenario.security.firewallRules (ACL rule list with source/dest zone, protocol,
 *     port, and allow/deny action). These values are serialized to FW_DEFAULT_POLICY
 *     and FW_RULES_JSON env vars by compose-generator.ts and applied via nftables
 *     inside the firewall container at simulation startup.
 *
 *   IDSPanel — shown when an "ids-ips" device is selected on the canvas.
 *     Edits scenario.security.ids.enabledRulesets (Suricata Emerging Threats rulesets),
 *     scenario.security.ids.zeekScripts (Zeek ICS protocol analyzers), and
 *     scenario.security.ids.disabledRuleIds (SIDs to suppress in threshold.conf).
 *     These values are serialized to IDS_RULESETS, IDS_DISABLED_SIDS, and ZEEK_SCRIPTS
 *     env vars by compose-generator.ts and read by the Suricata/Zeek entrypoints.
 *
 * Neither panel modifies DeviceConfig directly — security config lives at the scenario
 * level (SecurityLayer), not per-device. The selected firewall/IDS-IPS node is just
 * the UI entry point into the shared security configuration.
 *
 * Data flow:
 *   App.tsx holds scenario.security in state
 *   → passes it as `security` prop to PropertiesPanel
 *   → PropertiesPanel passes it to FirewallPanel / IDSPanel
 *   → panels call onSecurityChange(updater) to write back
 *   → App.tsx applies updater to scenario.security and re-renders
 */

import { useState, useCallback } from 'react'
import type { SecurityLayer, ACLRule, NetworkZone } from '@ics-sim/schema'

/** Props shared by both security sub-panels. */
interface SecurityPanelProps {
  /** Full scenario-level security configuration. */
  security: SecurityLayer
  /** Updater callback — same (prev => next) pattern used across the app. */
  onSecurityChange: (updater: (s: SecurityLayer) => SecurityLayer) => void
}

// ── Firewall Panel ─────────────────────────────────────────────────────────────

/**
 * Zone dropdown options for ACL rule source/destination selectors.
 * "Any" maps to no subnet restriction in the nftables rule.
 */
const ZONE_OPTIONS: { value: NetworkZone | 'any'; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'ot', label: 'OT' },
  { value: 'control', label: 'CTRL' },
  { value: 'plant-dmz', label: 'PDMZ' },
  { value: 'enterprise', label: 'ENT' },
  { value: 'internet-dmz', label: 'IDMZ' },
  { value: 'attacker', label: 'RED' }
]

/** Protocol options for the ACL rule form. Maps to nft protocol matchers. */
const PROTO_OPTIONS = ['tcp', 'udp', 'icmp', 'any'] as const
type AclProto = (typeof PROTO_OPTIONS)[number]

/** Empty state for the "add rule" inline form. */
const EMPTY_FORM = {
  sourceZone: 'any' as NetworkZone | 'any',
  destinationZone: 'any' as NetworkZone | 'any',
  protocol: 'tcp' as AclProto,
  destinationPort: '',
  action: 'allow' as 'allow' | 'deny',
  comment: ''
}

/**
 * FirewallPanel — edits scenario.security.defaultFirewallPolicy and firewallRules.
 *
 * Shows:
 *   1. Default policy toggle (DENY / ALLOW) — determines the nftables chain policy
 *      when no ACL rule matches a forwarded packet.
 *   2. ACL rules table — compact grid showing all saved rules with delete buttons.
 *   3. Add-rule form — inline two-row form for building a new ACLRule.
 *
 * Saved rules are written to FW_RULES_JSON by compose-generator.ts and applied
 * one-for-one as `nft add rule inet ics_fw forward …` lines in entrypoint.sh.
 */
export function FirewallPanel({ security, onSecurityChange }: SecurityPanelProps) {
  /** Local form state for the "add rule" inputs — not committed until Add is clicked. */
  const [form, setForm] = useState(EMPTY_FORM)

  /** Flip the default policy between deny-by-default and allow-by-default. */
  const togglePolicy = useCallback(() => {
    onSecurityChange(s => ({
      ...s,
      defaultFirewallPolicy: s.defaultFirewallPolicy === 'deny' ? 'allow' : 'deny'
    }))
  }, [onSecurityChange])

  /**
   * Commits the current form values as a new ACLRule and appends it to firewallRules.
   * Port validation: empty string or "any" both become the literal "any".
   */
  const addRule = useCallback(() => {
    const portRaw = form.destinationPort.trim()
    const portVal: number | 'any' = portRaw === '' || portRaw === 'any' ? 'any' : Number(portRaw)

    const newRule: ACLRule = {
      id: `rule-${Date.now()}`,
      sourceZone: form.sourceZone,
      destinationZone: form.destinationZone,
      protocol: form.protocol,
      destinationPort: portVal,
      action: form.action,
      comment: form.comment.trim() || undefined
    }
    onSecurityChange(s => ({ ...s, firewallRules: [...s.firewallRules, newRule] }))
    setForm(EMPTY_FORM)
  }, [form, onSecurityChange])

  /** Removes a single ACL rule by its id. */
  const deleteRule = useCallback(
    (id: string) => {
      onSecurityChange(s => ({ ...s, firewallRules: s.firewallRules.filter(r => r.id !== id) }))
    },
    [onSecurityChange]
  )

  const isDeny = security.defaultFirewallPolicy === 'deny'

  return (
    <>
      {/* ── Default policy toggle ─────────────────────────────────────────── */}
      {/* deny-by-default is the ICS best practice — explicit allows only.    */}
      <section className="prop-section">
        <div className="prop-section-title">Default Policy</div>
        <div className="prop-row">
          <span className="prop-label">Unmatched traffic</span>
          <button
            className={`fw-policy-btn ${isDeny ? 'fw-policy-deny' : 'fw-policy-allow'}`}
            onClick={togglePolicy}
            title="Click to toggle: DENY blocks all unmatched traffic; ALLOW passes it"
          >
            {isDeny ? 'DENY' : 'ALLOW'}
          </button>
        </div>
      </section>

      {/* ── ACL rules table ────────────────────────────────────────────────── */}
      <section className="prop-section">
        <div className="prop-section-title">
          ACL Rules
          {security.firewallRules.length > 0 && (
            <span className="prop-section-badge">{security.firewallRules.length}</span>
          )}
        </div>

        {security.firewallRules.length === 0 ? (
          <p className="fw-rules-empty">
            No rules — default policy applies to all forwarded traffic.
          </p>
        ) : (
          <div className="fw-rules-table">
            {/* Column header */}
            <div className="fw-rules-header">
              <span>Src</span>
              <span>Dst</span>
              <span>Proto</span>
              <span>Port</span>
              <span>Action</span>
              <span />
            </div>
            {/* One row per ACLRule */}
            {security.firewallRules.map(rule => (
              <div key={rule.id} className="fw-rule-row" title={rule.comment ?? ''}>
                <span className="fw-zone">{rule.sourceZone}</span>
                <span className="fw-zone">{rule.destinationZone}</span>
                <span className="fw-cell">{rule.protocol}</span>
                <span className="fw-cell">{String(rule.destinationPort)}</span>
                <span className={`fw-action fw-action-${rule.action}`}>{rule.action}</span>
                <button
                  className="fw-rule-delete"
                  onClick={() => deleteRule(rule.id)}
                  aria-label="Delete rule"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── Add rule form ────────────────────────────────────────────────── */}
        {/* Row 1: zone → zone, protocol, port, action dropdowns */}
        <div className="fw-add-form">
          <div className="fw-add-row1">
            <select
              className="fw-select"
              value={form.sourceZone}
              onChange={e =>
                setForm(f => ({ ...f, sourceZone: e.target.value as NetworkZone | 'any' }))
              }
              aria-label="Source zone"
            >
              {ZONE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            <span className="fw-arrow">→</span>

            <select
              className="fw-select"
              value={form.destinationZone}
              onChange={e =>
                setForm(f => ({ ...f, destinationZone: e.target.value as NetworkZone | 'any' }))
              }
              aria-label="Destination zone"
            >
              {ZONE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            <select
              className="fw-select fw-select-sm"
              value={form.protocol}
              onChange={e => setForm(f => ({ ...f, protocol: e.target.value as AclProto }))}
              aria-label="Protocol"
            >
              {PROTO_OPTIONS.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>

            <input
              className="fw-input fw-input-port"
              type="text"
              placeholder="port"
              value={form.destinationPort}
              onChange={e => setForm(f => ({ ...f, destinationPort: e.target.value }))}
              aria-label="Destination port"
            />

            <select
              className="fw-select fw-select-sm fw-select-action"
              value={form.action}
              onChange={e => setForm(f => ({ ...f, action: e.target.value as 'allow' | 'deny' }))}
              aria-label="Action"
            >
              <option value="allow">allow</option>
              <option value="deny">deny</option>
            </select>
          </div>

          {/* Row 2: optional comment + Add button */}
          <div className="fw-add-row2">
            <input
              className="fw-input fw-input-comment"
              type="text"
              placeholder="Comment (optional)"
              value={form.comment}
              onChange={e => setForm(f => ({ ...f, comment: e.target.value }))}
            />
            <button className="btn btn-sm btn-primary fw-add-btn" onClick={addRule}>
              + Add
            </button>
          </div>
        </div>
      </section>
    </>
  )
}

// ── IDS / IPS Panel ────────────────────────────────────────────────────────────

/**
 * Available Suricata Emerging Threats Open rulesets for ICS environments.
 * IDs match suricata-update source names; hint is shown as a tooltip.
 */
const SURICATA_RULESETS: { id: string; label: string; hint: string }[] = [
  {
    id: 'emerging-scada',
    label: 'Emerging SCADA',
    hint: 'Detects SCADA protocol anomalies and known attack patterns'
  },
  {
    id: 'emerging-modbus',
    label: 'Emerging Modbus',
    hint: 'Modbus TCP abuse, enumeration, and coil manipulation'
  },
  {
    id: 'emerging-dnp3',
    label: 'Emerging DNP3',
    hint: 'DNP3 protocol anomalies and outstation abuse'
  },
  {
    id: 'emerging-ics',
    label: 'Emerging ICS',
    hint: 'Broad ICS/SCADA threat intelligence signatures'
  }
]

/**
 * Zeek ICS protocol analysis scripts shipped with the zeek container image.
 * Script filenames must match files under /opt/zeek/share/zeek/site/ in the container.
 */
const ZEEK_SCRIPTS_OPTIONS: { id: string; label: string; hint: string }[] = [
  {
    id: 'modbus.zeek',
    label: 'Modbus analyzer',
    hint: 'Logs Modbus TCP transactions to modbus.log'
  },
  {
    id: 'dnp3.zeek',
    label: 'DNP3 analyzer',
    hint: 'Logs DNP3 sessions and function codes to dnp3.log'
  },
  {
    id: 'ics.zeek',
    label: 'ICS fingerprinting',
    hint: 'Passive device fingerprinting via protocol banners'
  }
]

/**
 * IDSPanel — edits scenario.security.ids (Suricata rulesets, Zeek scripts, disabled SIDs).
 *
 * Shows:
 *   1. Suricata ruleset checkboxes — which Emerging Threats Open categories to enable.
 *   2. Zeek script checkboxes — which ICS protocol analyzers to load.
 *   3. Disabled SIDs text input — comma-separated SID numbers to suppress (committed on blur).
 *
 * Changes write back to scenario.security.ids via onSecurityChange. The compose generator
 * reads these and passes IDS_RULESETS, ZEEK_SCRIPTS, and IDS_DISABLED_SIDS env vars to
 * the Suricata and Zeek containers at simulation start.
 */
export function IDSPanel({ security, onSecurityChange }: SecurityPanelProps) {
  /**
   * Local draft of the disabled-SIDs text field — committed to the scenario on blur.
   * Held locally to avoid re-rendering the scenario on every keystroke.
   */
  const [sidText, setSidText] = useState(security.ids.disabledRuleIds.join(', '))

  /** Toggle a single Suricata ruleset on or off. */
  const toggleRuleset = useCallback(
    (id: string) => {
      onSecurityChange(s => {
        const cur = s.ids.enabledRulesets
        const next = cur.includes(id) ? cur.filter(r => r !== id) : [...cur, id]
        return { ...s, ids: { ...s.ids, enabledRulesets: next } }
      })
    },
    [onSecurityChange]
  )

  /** Toggle a single Zeek script on or off. */
  const toggleZeekScript = useCallback(
    (id: string) => {
      onSecurityChange(s => {
        const cur = s.ids.zeekScripts
        const next = cur.includes(id) ? cur.filter(r => r !== id) : [...cur, id]
        return { ...s, ids: { ...s.ids, zeekScripts: next } }
      })
    },
    [onSecurityChange]
  )

  /**
   * Parse the SID text field and commit valid integers to the scenario.
   * Called on blur so the scenario isn't updated on every keystroke.
   * Invalid tokens (non-numeric) are silently discarded.
   */
  const commitSids = useCallback(() => {
    const sids = sidText
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n))
    onSecurityChange(s => ({ ...s, ids: { ...s.ids, disabledRuleIds: sids } }))
  }, [sidText, onSecurityChange])

  return (
    <>
      {/* ── Suricata rulesets ─────────────────────────────────────────────── */}
      <section className="prop-section">
        <div className="prop-section-title">Suricata Rulesets</div>
        <div className="ids-check-list">
          {SURICATA_RULESETS.map(rs => (
            <label key={rs.id} className="ids-check-item" title={rs.hint}>
              <input
                type="checkbox"
                className="ids-checkbox"
                checked={security.ids.enabledRulesets.includes(rs.id)}
                onChange={() => toggleRuleset(rs.id)}
              />
              <span className="ids-check-label">{rs.label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* ── Zeek scripts ─────────────────────────────────────────────────── */}
      <section className="prop-section">
        <div className="prop-section-title">Zeek Scripts</div>
        <div className="ids-check-list">
          {ZEEK_SCRIPTS_OPTIONS.map(sc => (
            <label key={sc.id} className="ids-check-item" title={sc.hint}>
              <input
                type="checkbox"
                className="ids-checkbox"
                checked={security.ids.zeekScripts.includes(sc.id)}
                onChange={() => toggleZeekScript(sc.id)}
              />
              <span className="ids-check-label">{sc.label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* ── Disabled SIDs ────────────────────────────────────────────────── */}
      {/* Writes suppress entries to threshold.conf in the Suricata container. */}
      <section className="prop-section">
        <div className="prop-section-title">Suppressed SIDs</div>
        <input
          className="ids-sids-input"
          type="text"
          placeholder="e.g. 2001219, 2010936"
          value={sidText}
          onChange={e => setSidText(e.target.value)}
          onBlur={commitSids}
        />
        <p className="ids-sids-hint">
          Comma-separated Suricata SID numbers to suppress (false-positive overrides).
        </p>
      </section>
    </>
  )
}
