/**
 * PackManagerModal.tsx — Community scenario pack installer and manager.
 *
 * Opened by the "Packs" toolbar button (Author mode only). Displays all installed
 * .otfpack community packs and provides controls to install new ones or uninstall
 * existing ones.
 *
 * Each pack card shows:
 *   - Pack name, version, author, and description
 *   - A list of bundled scenarios with an "Open" button per scenario
 *   - A list of contributed device types (label + category badge)
 *   - Suricata rule files and Zeek scripts included
 *   - Uninstall button (removes the pack directory from disk)
 *
 * Installing a new pack:
 *   Clicking "Install Pack" opens a native file picker filtered to .otfpack files.
 *   The main process extracts the ZIP, validates pack.json, and returns the resolved
 *   InstalledPack. The modal's pack list is refreshed after any install/uninstall.
 *
 * @param installedPacks    - Current list of installed packs from App state.
 * @param onPacksChange     - Called after install/uninstall to refresh App's pack list.
 * @param onOpenScenario    - Opens a bundled scenario on the canvas and closes the modal.
 * @param onClose           - Closes the modal.
 */

import { useState } from 'react'
import type { InstalledPack } from '@otforge/schema'

interface PackManagerModalProps {
  /** All currently installed packs — supplied by App. */
  installedPacks: InstalledPack[]
  /**
   * Callback fired after any install or uninstall operation.
   * App re-fetches pack:list and passes the refreshed array on the next render.
   */
  onPacksChange: (packs: InstalledPack[]) => void
  /**
   * Opens a bundled .otflab scenario from a pack directly on the SCADA canvas.
   * Closes this modal as a side-effect — the scenario replaces whatever is open.
   *
   * @param packId       - Pack whose scenario to open.
   * @param relativePath - Scenario path relative to the pack root.
   */
  onOpenScenario: (packId: string, relativePath: string) => void
  /** Dismissed when the user clicks the × button or the backdrop. */
  onClose: () => void
}

/**
 * Pack Manager overlay modal.
 *
 * Shows a scrollable list of installed packs. The top action bar has an
 * "Install Pack" button that triggers the native file picker via IPC.
 * Each pack card has an Uninstall button that removes it from disk.
 */
export function PackManagerModal({
  installedPacks,
  onPacksChange,
  onOpenScenario,
  onClose
}: PackManagerModalProps) {
  /** Whether an install operation is in progress — disables the Install button. */
  const [installing, setInstalling] = useState<boolean>(false)
  /**
   * Per-pack uninstall loading state.
   * Maps pack id → true while the uninstall IPC call is in flight.
   */
  const [uninstallingIds, setUninstallingIds] = useState<Set<string>>(new Set())
  /** Error from the most recent install or uninstall operation. Cleared on next action. */
  const [actionError, setActionError] = useState<string | null>(null)

  /**
   * Installs a new pack via the native file picker.
   * On success, refreshes the pack list in App state.
   */
  async function handleInstall(): Promise<void> {
    setInstalling(true)
    setActionError(null)
    try {
      const result = await window.electronAPI.packs.install()
      if (result.ok && result.pack) {
        // Merge the new pack into the current list; replace if same id (upgrade)
        const updated = [
          ...installedPacks.filter(p => p.manifest.id !== result.pack!.manifest.id),
          result.pack
        ]
        onPacksChange(updated)
      } else {
        // Cancelled or error — only show an error message when not a plain cancellation
        if (result.error && result.error !== 'Install cancelled') {
          setActionError(result.error)
        }
      }
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  /**
   * Uninstalls a pack by id and removes it from the app's pack list.
   * @param packId - The manifest id of the pack to remove.
   */
  async function handleUninstall(packId: string): Promise<void> {
    const confirmed = window.confirm(
      `Uninstall pack "${installedPacks.find(p => p.manifest.id === packId)?.manifest.name ?? packId}"?\n\n` +
        'Scenarios opened from this pack will remain on the canvas, but you will no longer be ' +
        'able to open additional scenarios from it until it is reinstalled.'
    )
    if (!confirmed) return

    setUninstallingIds(prev => new Set([...prev, packId]))
    setActionError(null)
    try {
      const result = await window.electronAPI.packs.uninstall(packId)
      if (result.ok) {
        onPacksChange(installedPacks.filter(p => p.manifest.id !== packId))
      } else {
        setActionError(result.error ?? 'Uninstall failed')
      }
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setUninstallingIds(prev => {
        const next = new Set(prev)
        next.delete(packId)
        return next
      })
    }
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-panel pack-manager-modal">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title">
            <span className="modal-title-icon">📦</span>
            Pack Manager
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {/* Action bar */}
        <div className="pack-manager-actions">
          <div className="pack-manager-actions-left">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleInstall}
              disabled={installing}
              title="Browse for a .otfpack community scenario pack file"
            >
              {installing ? 'Installing…' : '+ Install Pack'}
            </button>
            <span className="pack-count">
              {installedPacks.length} pack{installedPacks.length !== 1 ? 's' : ''} installed
            </span>
          </div>
          {actionError && (
            <div className="pack-action-error">
              <span className="pack-action-error-icon">⚠</span>
              {actionError}
              <button className="pack-action-error-dismiss" onClick={() => setActionError(null)}>
                ×
              </button>
            </div>
          )}
        </div>

        {/* Pack list */}
        <div className="modal-body pack-manager-body">
          {installedPacks.length === 0 ? (
            /* Empty state — guide the user toward installing their first pack */
            <div className="pack-empty-state">
              <div className="pack-empty-icon">📦</div>
              <div className="pack-empty-title">No packs installed</div>
              <div className="pack-empty-desc">
                Community scenario packs add pre-built scenarios, custom device types, and
                sector-specific Suricata / Zeek rules to your simulator. Click{' '}
                <strong>+ Install Pack</strong> to install a .otfpack file.
              </div>
              <div className="pack-empty-hint">
                Share your own packs — see the README for the .otfpack format specification.
              </div>
            </div>
          ) : (
            <div className="pack-list">
              {installedPacks.map(pack => (
                <PackCard
                  key={pack.manifest.id}
                  pack={pack}
                  uninstalling={uninstallingIds.has(pack.manifest.id)}
                  onOpenScenario={onOpenScenario}
                  onUninstall={() => handleUninstall(pack.manifest.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Pack card ──────────────────────────────────────────────────────────────────

/**
 * Expandable card for a single installed pack.
 *
 * Shows the pack summary (name, version, author, sector badge, description) and
 * three collapsible sections: Scenarios, Device Types, and Rules/Scripts.
 * The Scenarios section has an "Open" button per scenario — clicking it opens
 * the scenario on the canvas and closes the Pack Manager.
 *
 * @param pack          - The installed pack to display.
 * @param uninstalling  - True while the uninstall IPC call is in flight.
 * @param onOpenScenario - Called when the user clicks Open for a scenario.
 * @param onUninstall   - Called when the user confirms uninstall.
 */
function PackCard({
  pack,
  uninstalling,
  onOpenScenario,
  onUninstall
}: {
  pack: InstalledPack
  uninstalling: boolean
  onOpenScenario: (packId: string, relativePath: string) => void
  onUninstall: () => void
}) {
  const { manifest, deviceTypes, scenarioMetas, installedAt } = pack

  /**
   * Formats an ISO 8601 timestamp into a short human-readable string.
   * e.g., "2026-05-17T14:22:00.000Z" → "May 17, 2026"
   */
  function fmtDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      })
    } catch {
      return iso
    }
  }

  return (
    <div className={`pack-card ${uninstalling ? 'pack-card-uninstalling' : ''}`}>
      {/* Pack header row */}
      <div className="pack-card-header">
        <div className="pack-card-identity">
          <span className="pack-card-name">{manifest.name}</span>
          <span className="pack-card-version">v{manifest.version}</span>
          {manifest.sector && <span className="pack-card-sector-badge">{manifest.sector}</span>}
        </div>
        <button
          className="btn btn-sm btn-danger-ghost"
          onClick={onUninstall}
          disabled={uninstalling}
          title="Remove this pack from disk"
        >
          {uninstalling ? 'Removing…' : 'Uninstall'}
        </button>
      </div>

      {/* Author + install date */}
      <div className="pack-card-meta">
        <span className="pack-meta-author">by {manifest.author}</span>
        <span className="pack-meta-sep">·</span>
        <span className="pack-meta-date">Installed {fmtDate(installedAt)}</span>
      </div>

      {/* Description */}
      {manifest.description && <div className="pack-card-desc">{manifest.description}</div>}

      {/* Scenarios section */}
      {scenarioMetas.length > 0 && (
        <div className="pack-section">
          <div className="pack-section-label">Scenarios ({scenarioMetas.length})</div>
          <div className="pack-scenario-list">
            {scenarioMetas.map(sm => (
              <div key={sm.relativePath} className="pack-scenario-row">
                <div className="pack-scenario-info">
                  <span className="pack-scenario-name">{sm.name}</span>
                  {sm.locked && <span className="pack-scenario-locked-badge">🔒 Student</span>}
                  {sm.description && <span className="pack-scenario-desc">{sm.description}</span>}
                </div>
                <button
                  className="btn btn-xs btn-secondary"
                  onClick={() => onOpenScenario(manifest.id, sm.relativePath)}
                  title={`Open "${sm.name}" on the SCADA canvas`}
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Device types section */}
      {deviceTypes.length > 0 && (
        <div className="pack-section">
          <div className="pack-section-label">Device Types ({deviceTypes.length})</div>
          <div className="pack-device-type-list">
            {deviceTypes.map(dt => (
              <div key={dt.id} className="pack-device-type-chip">
                {/* Pack icons are pre-loaded as data URLs — show them inline if present */}
                {dt.iconDataUrl ? (
                  <img className="pack-device-type-icon" src={dt.iconDataUrl} alt={dt.label} />
                ) : (
                  <span className="pack-device-type-icon-placeholder">□</span>
                )}
                <span className="pack-device-type-label">{dt.label}</span>
                <span className="pack-device-type-category">{dt.category}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rules / scripts section — shown when the pack contributes IDS/Zeek content */}
      {(manifest.suricataRules.length > 0 || manifest.zeekScripts.length > 0) && (
        <div className="pack-section">
          <div className="pack-section-label">Rules &amp; Scripts</div>
          <div className="pack-rules-list">
            {manifest.suricataRules.map(r => (
              <span key={r} className="pack-rule-chip pack-rule-chip-suricata">
                🛡 {r.split('/').pop()}
              </span>
            ))}
            {manifest.zeekScripts.map(z => (
              <span key={z} className="pack-rule-chip pack-rule-chip-zeek">
                🔬 {z.split('/').pop()}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
