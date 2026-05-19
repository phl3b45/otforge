/**
 * ExportModal.tsx — Scenario export dialog with Author / Student mode selection.
 *
 * Opened by the "Export" toolbar button (Author mode, idle only). Presents two
 * export paths:
 *
 *   Author Copy  — Full unlocked .otflab. Visual layer, security layer, and all
 *                  metadata are included. For sharing with other instructors or
 *                  backing up your own work.
 *
 *   Student Copy — Locked .otflab. The visual layer (node positions, topology
 *                  diagram) and the security layer (firewall rules, IDS config)
 *                  are stripped. Students receive the device list and network
 *                  config so Docker can spin up the environment, but they cannot
 *                  reverse-engineer the full topology or security posture.
 *                  meta.locked is set to true so the app opens in Student mode.
 *
 * The actual stripping is handled by the existing scenario:export IPC handler in
 * main/index.ts — this modal only presents the choice and calls the right options.
 *
 * @param scenario - Current scenario to export.
 * @param onClose  - Closes the modal regardless of outcome.
 */

import { useState } from 'react'
import type { OTForgeScenario } from '@otforge/schema'

/** Which export mode the user has selected in the modal. */
type ExportMode = 'author' | 'student'

interface ExportModalProps {
  /** The scenario to export. */
  scenario: OTForgeScenario
  /** Called when the modal is dismissed (after export or via Cancel). */
  onClose: () => void
  /**
   * Called after a successful export with the absolute path of the saved file.
   * App.tsx uses this to update currentFilePath so the Delete Scenario action
   * can remove the file from disk.
   */
  onExportSuccess?: (filePath: string) => void
}

/**
 * Export mode selector modal.
 *
 * Shows two large option cards (Author Copy, Student Copy) with clear descriptions
 * of what each includes. After the user selects a mode and clicks Export, calls
 * window.electronAPI.scenario.export which triggers the native save dialog.
 *
 * Shows a success path (file path + green confirmation) or an error message
 * if the export fails. The user can dismiss either state with Close.
 */
export function ExportModal({ scenario, onClose, onExportSuccess }: ExportModalProps) {
  const [mode, setMode] = useState<ExportMode>('author')
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; filePath?: string; error?: string } | null>(
    null
  )

  async function handleExport() {
    setExporting(true)
    try {
      const res = await window.electronAPI.scenario.export(scenario, {
        locked: mode === 'student'
      })
      setResult(res)
      // Notify App.tsx of the saved path so Delete Scenario can remove it from disk.
      if (res.ok && res.filePath) {
        onExportSuccess?.(res.filePath)
      }
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-panel export-modal">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title">
            <span className="modal-title-icon">⬇</span>
            Export Scenario
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {/* Result state — shown after export attempt */}
        {result ? (
          <div className="modal-body">
            {result.ok ? (
              <div className="export-result export-result-ok">
                <div className="export-result-icon">✓</div>
                <div className="export-result-text">
                  <strong>Exported successfully</strong>
                  <code className="export-result-path">{result.filePath}</code>
                </div>
              </div>
            ) : (
              <div className="export-result export-result-error">
                <div className="export-result-icon">⚠</div>
                <div className="export-result-text">
                  <strong>Export failed</strong>
                  <span>{result.error ?? 'Unknown error'}</span>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Mode selection */
          <div className="modal-body">
            <p className="export-intro">
              Choose the export format for <strong>&ldquo;{scenario.meta.name}&rdquo;</strong>:
            </p>

            <div className="export-options">
              {/* Author Copy card */}
              <button
                className={`export-option-card ${mode === 'author' ? 'selected' : ''}`}
                onClick={() => setMode('author')}
              >
                <div className="export-option-icon export-option-icon-author">✎</div>
                <div className="export-option-content">
                  <div className="export-option-title">Author Copy</div>
                  <div className="export-option-desc">
                    Full unlocked scenario — includes topology diagram, security rules, all
                    metadata. Share with other instructors or use as a backup.
                  </div>
                  <div className="export-option-includes">
                    <span className="export-tag export-tag-include">✓ Visual layer</span>
                    <span className="export-tag export-tag-include">✓ Security rules</span>
                    <span className="export-tag export-tag-include">✓ Device config</span>
                    <span className="export-tag export-tag-include">✓ Metadata</span>
                  </div>
                </div>
              </button>

              {/* Student Copy card */}
              <button
                className={`export-option-card ${mode === 'student' ? 'selected' : ''}`}
                onClick={() => setMode('student')}
              >
                <div className="export-option-icon export-option-icon-student">🔒</div>
                <div className="export-option-content">
                  <div className="export-option-title">Student Copy</div>
                  <div className="export-option-desc">
                    Locked scenario distributed to students. Topology diagram and security rules are
                    stripped so students cannot reverse-engineer the network design. Opens in
                    Student mode with the Mission Brief panel.
                  </div>
                  <div className="export-option-includes">
                    <span className="export-tag export-tag-exclude">✗ Visual layer</span>
                    <span className="export-tag export-tag-exclude">✗ Security rules</span>
                    <span className="export-tag export-tag-include">✓ Device config</span>
                    <span className="export-tag export-tag-include">✓ Mission brief</span>
                  </div>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button className="btn btn-primary" onClick={handleExport} disabled={exporting}>
              {exporting
                ? 'Exporting…'
                : `Export as ${mode === 'author' ? 'Author Copy' : 'Student Copy'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
