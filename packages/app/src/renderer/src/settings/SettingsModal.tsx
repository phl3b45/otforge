/**
 * SettingsModal.tsx — Network subnet configuration modal.
 *
 * Presented when the user clicks the ⚙ Settings gear button in the Toolbar.
 * Allows instructors and advanced users to control how Docker subnet addresses
 * are assigned when a simulation starts, addressing common conflict scenarios:
 *
 *   - Corporate VPN clients that claim large RFC 1918 blocks (e.g., 10.x.x.x/8)
 *   - University networks with overlapping 172.x.x.x ranges
 *   - Docker Desktop's default bridge network at 172.17.0.0/16
 *
 * Two modes:
 *
 *   Auto-detect (default): On every simulation start, the main process scans
 *     os.networkInterfaces() and picks the first /24 subnet in the 10.200–10.210.x
 *     pool that doesn't conflict with any existing host interface. No user action
 *     needed — the correct subnets are chosen automatically.
 *
 *   Pinned subnets: Power users can disable auto-detect and enter specific CIDR
 *     subnets for each of the four Purdue Model zones (OT, IT, DMZ, External).
 *     The simulator will always use exactly these subnets, even if they conflict
 *     with other host interfaces.
 *
 * Interaction model:
 *   - On mount, loads current settings and runs detection to show current values.
 *   - Toggle pill switches between auto-detect and pinned modes.
 *   - "Detect now" button (auto-detect mode) re-runs detection and updates the preview.
 *   - Subnet inputs (pinned mode) are pre-filled from pinned values or last detection.
 *   - Save persists the current form state; Cancel or Escape discards changes.
 *
 * IPC calls used:
 *   settings:get          — load current settings on mount
 *   settings:set          — persist on Save
 *   settings:detectSubnets — run detection for preview without persisting
 */

import { useEffect, useState, useCallback } from 'react'

/**
 * Network zone → subnet/gateway entry.
 * One row in the subnet grid — one per Purdue Model zone.
 */
interface ZoneSubnet {
  subnet: string
  gateway: string
}

/**
 * Network settings shape — must stay structurally identical to the NetworkSettings
 * interface in preload/index.ts and main/index.ts (structural typing, not imported
 * to avoid crossing the renderer/preload boundary).
 */
interface NetworkSettings {
  autoDetect: boolean
  pinnedSubnets?: Record<string, ZoneSubnet>
}

/** Display metadata for each Purdue Model zone row in the subnet grid. */
interface ZoneRow {
  key: string
  label: string
  fullName: string
  color: string
  description: string
}

/**
 * Ordered list of zone rows shown in the subnet grid.
 * Order follows the full Purdue Reference Model hierarchy (L0-2 through L5 + Red Team).
 */
const ZONE_ROWS: ZoneRow[] = [
  {
    key: 'ot',
    label: 'OT',
    fullName: 'OT Process (L0–L2)',
    color: '#39d0b0',
    description: 'PLCs, RTUs, IEDs, sensors, actuators'
  },
  {
    key: 'control',
    label: 'CTRL',
    fullName: 'Control Center (L3)',
    color: '#388bfd',
    description: 'HMIs, historians, app/DB servers, Grafana, Loki'
  },
  {
    key: 'plant-dmz',
    label: 'PDMZ',
    fullName: 'Plant DMZ (L3.5)',
    color: '#d29922',
    description: 'Firewalls, IDS/IPS, Suricata, Zeek, jump hosts'
  },
  {
    key: 'enterprise',
    label: 'ENT',
    fullName: 'Enterprise Zone (L4)',
    color: '#a371f7',
    description: 'Domain controllers, web/business servers, desktops'
  },
  {
    key: 'internet-dmz',
    label: 'IDMZ',
    fullName: 'Internet DMZ (L5)',
    color: '#f78166',
    description: 'Email servers, internet-facing servers'
  },
  {
    key: 'attacker',
    label: 'RED',
    fullName: 'Red Team / Attacker',
    color: '#f85149',
    description: 'Attack machine (Kali Linux) — isolated from Purdue zones'
  }
]

/** Default subnet grid state — shown as placeholders until detection completes. */
const DEFAULT_ZONES: Record<string, ZoneSubnet> = {
  ot: { subnet: '10.200.10.0/24', gateway: '10.200.10.1' },
  control: { subnet: '10.200.20.0/24', gateway: '10.200.20.1' },
  'plant-dmz': { subnet: '10.200.30.0/24', gateway: '10.200.30.1' },
  enterprise: { subnet: '10.200.40.0/24', gateway: '10.200.40.1' },
  'internet-dmz': { subnet: '10.200.50.0/24', gateway: '10.200.50.1' },
  attacker: { subnet: '10.200.60.0/24', gateway: '10.200.60.1' }
}

/**
 * Network Settings modal.
 *
 * Closes when the user clicks Save, Cancel, the × button, or presses Escape.
 * A dim backdrop click also closes the modal (same dismiss pattern as PlcIdeModal).
 *
 * @param onClose - Callback invoked when the modal should be dismissed.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  /** Whether auto-detect is enabled (toggle pill state). */
  const [autoDetect, setAutoDetect] = useState<boolean>(true)

  /**
   * Current values shown in the subnet grid.
   * In auto-detect mode: read-only, populated by detection.
   * In pinned mode: editable, pre-filled from pinned settings or last detection.
   */
  const [zones, setZones] = useState<Record<string, ZoneSubnet>>(DEFAULT_ZONES)

  /** True while the settings:detectSubnets IPC call is in flight. */
  const [detecting, setDetecting] = useState<boolean>(false)

  /** True while the settings:set IPC call is in flight. */
  const [saving, setSaving] = useState<boolean>(false)

  /** Non-null when a save error occurs — shown in the footer. */
  const [saveError, setSaveError] = useState<string | null>(null)

  // ── Escape key handler ───────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  // ── On-mount: load settings and run detection for preview ────────────────────
  // Both calls run concurrently. Detection result populates the grid immediately;
  // if the user has pinned subnets, those override the detected values in edit mode.
  useEffect(() => {
    let cancelled = false

    const init = async (): Promise<void> => {
      setDetecting(true)
      try {
        const [settings, detected] = await Promise.all([
          window.electronAPI.settings.get(),
          window.electronAPI.settings.detectSubnets()
        ])
        if (cancelled) return

        setAutoDetect(settings.autoDetect)

        if (!settings.autoDetect && settings.pinnedSubnets) {
          // Show pinned values — user is in manual mode
          setZones(prev => ({ ...prev, ...settings.pinnedSubnets }))
        } else if (detected.ok && detected.zones) {
          // Show detected values — auto mode (or manual without any pins yet)
          setZones(prev => ({ ...prev, ...detected.zones }))
        }
      } finally {
        if (!cancelled) setDetecting(false)
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Re-runs detection on demand. Updates the subnet grid with fresh values.
   * Called by the "Detect now" button in auto-detect mode.
   * Does NOT save to disk — user must click Save to persist.
   */
  const handleDetect = useCallback(async (): Promise<void> => {
    setDetecting(true)
    try {
      const result = await window.electronAPI.settings.detectSubnets()
      if (result.ok && result.zones) {
        setZones(prev => ({ ...prev, ...result.zones }))
      }
    } finally {
      setDetecting(false)
    }
  }, [])

  /**
   * Toggles between auto-detect and pinned modes.
   * When switching to auto-detect, immediately re-runs detection to refresh values.
   * When switching to pinned, current grid values become the starting pin point.
   */
  const handleToggle = useCallback(async (): Promise<void> => {
    const next = !autoDetect
    setAutoDetect(next)
    if (next) {
      // Switched to auto — refresh detected subnets so the read-only grid shows
      // what would actually be used (may differ from what was in pinned settings)
      setDetecting(true)
      try {
        const result = await window.electronAPI.settings.detectSubnets()
        if (result.ok && result.zones) {
          setZones(prev => ({ ...prev, ...result.zones }))
        }
      } finally {
        setDetecting(false)
      }
    }
    // Switched to pinned — grid already has values (detected or previously pinned)
    // and will become editable so no extra action needed
  }, [autoDetect])

  /**
   * Updates a single field (subnet or gateway) for one zone row.
   * Only active when autoDetect is false (inputs are editable).
   *
   * @param zoneKey - Zone identifier ('ot', 'it', 'dmz', 'external').
   * @param field   - Which field to update ('subnet' or 'gateway').
   * @param value   - New string value from the input element.
   */
  const handleZoneChange = useCallback(
    (zoneKey: string, field: keyof ZoneSubnet, value: string): void => {
      setZones(prev => ({
        ...prev,
        [zoneKey]: { ...prev[zoneKey], [field]: value }
      }))
    },
    []
  )

  /**
   * Persists the current form state to <userData>/settings.json and closes the modal.
   * In auto-detect mode: saves { autoDetect: true } without pinnedSubnets.
   * In pinned mode: saves { autoDetect: false, pinnedSubnets: zones }.
   */
  const handleSave = useCallback(async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      const settings: NetworkSettings = {
        autoDetect,
        // Only persist pinnedSubnets when in manual mode — auto-detect mode ignores them
        pinnedSubnets: autoDetect ? undefined : zones
      }
      const result = await window.electronAPI.settings.set(settings)
      if (result.ok) {
        onClose()
      } else {
        setSaveError(result.error ?? 'Failed to save settings.')
      }
    } finally {
      setSaving(false)
    }
  }, [autoDetect, zones, onClose])

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      className="settings-overlay"
      onMouseDown={e => {
        // Close when clicking the dim backdrop; ignore clicks inside the modal
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Network Settings">
        {/* ── Header ──────────────────────────────────────────────────────────── */}
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="settings-modal-icon">⚙</span>
            <span>Network Settings</span>
          </div>
          <button className="settings-modal-close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────────── */}
        <div className="settings-modal-body">
          {/* ── Auto-detect toggle section ─────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-header">
              <div className="settings-section-label">
                <span className="settings-section-title">Auto-detect subnets</span>
                <span className="settings-section-description">
                  Scans your network interfaces at each simulation start and picks /24 subnets in
                  the 10.200&ndash;10.210.x range that don&apos;t conflict with any existing
                  interface. Recommended for most users, especially those with VPN clients.
                </span>
              </div>
              {/* Toggle pill — click to switch modes */}
              <button
                className={`settings-toggle ${autoDetect ? 'on' : 'off'}`}
                onClick={handleToggle}
                disabled={detecting}
                aria-pressed={autoDetect}
                aria-label={autoDetect ? 'Disable auto-detect' : 'Enable auto-detect'}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>
          </div>

          {/* ── Subnet grid ────────────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-subnet-grid-header">
              <div className="settings-subnet-grid-header-zone">Zone</div>
              <div className="settings-subnet-grid-header-subnet">Subnet (CIDR)</div>
              <div className="settings-subnet-grid-header-gateway">Gateway</div>
            </div>

            <div className="settings-subnet-grid">
              {ZONE_ROWS.map(row => {
                const zone = zones[row.key] ?? DEFAULT_ZONES[row.key]
                const isReadOnly = autoDetect || detecting
                return (
                  <div key={row.key} className="settings-subnet-row">
                    {/* Zone label with color dot matching the canvas legend */}
                    <div className="settings-subnet-zone">
                      <span
                        className="settings-zone-dot"
                        style={{ backgroundColor: row.color }}
                        title={row.description}
                      />
                      <span
                        className="settings-zone-label"
                        title={`${row.fullName} — ${row.description}`}
                      >
                        {row.label}
                      </span>
                    </div>

                    {/* Subnet CIDR input — read-only in auto-detect mode */}
                    <input
                      className="settings-subnet-input"
                      type="text"
                      value={detecting ? '…' : zone.subnet}
                      readOnly={isReadOnly}
                      placeholder="10.200.10.0/24"
                      aria-label={`${row.fullName} subnet`}
                      onChange={e => handleZoneChange(row.key, 'subnet', e.target.value)}
                    />

                    {/* Gateway input — read-only in auto-detect mode */}
                    <input
                      className="settings-subnet-input"
                      type="text"
                      value={detecting ? '…' : zone.gateway}
                      readOnly={isReadOnly}
                      placeholder="10.200.10.1"
                      aria-label={`${row.fullName} gateway`}
                      onChange={e => handleZoneChange(row.key, 'gateway', e.target.value)}
                    />
                  </div>
                )
              })}
            </div>

            {/* Status line: auto-detect hint or pinned-mode instruction */}
            <div className="settings-subnet-hint">
              {autoDetect ? (
                <>
                  <span className="settings-hint-text">
                    These subnets are auto-detected and may differ at each simulation start.
                  </span>
                  {/* Re-run detection to refresh the preview values */}
                  <button
                    className="btn btn-sm btn-ghost settings-detect-btn"
                    onClick={handleDetect}
                    disabled={detecting}
                    title="Re-scan network interfaces and update the preview"
                  >
                    {detecting ? 'Detecting…' : 'Detect now'}
                  </button>
                </>
              ) : (
                <span className="settings-hint-text">
                  These subnets will be used exactly as entered. Ensure they don&apos;t overlap with
                  your host network interfaces, VPN, or Docker&apos;s default bridge.
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────────── */}
        <div className="settings-modal-footer">
          {saveError && <span className="settings-save-error">{saveError}</span>}
          <div className="settings-modal-actions">
            <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={handleSave}
              disabled={saving || detecting}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
