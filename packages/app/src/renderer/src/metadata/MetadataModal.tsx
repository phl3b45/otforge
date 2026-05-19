/**
 * MetadataModal.tsx — Scenario metadata editor modal.
 *
 * Opened by the "Metadata" toolbar button (Author mode, idle only). Allows the
 * instructor to set the scenario name, description, author, sector, and mission
 * brief (the markdown text shown to students in Student mode).
 *
 * State:
 *   - All fields are local controlled inputs initialized from the scenario meta.
 *   - Save calls onSave with the updated ICSLabMeta; the modal does not write to
 *     the scenario directly (App.tsx owns that state).
 *   - Cancel / Escape discards local edits and closes without saving.
 *
 * @param meta    - Current ICSLabMeta to populate the form fields.
 * @param onSave  - Called with the updated meta when the user clicks Save.
 * @param onClose - Called when the modal is dismissed without saving.
 */

import { useEffect, useState } from 'react'
import type { ICSLabMeta, Sector } from '@ics-sim/schema'

/** Human-readable labels for the sector select. */
const SECTOR_OPTIONS: { value: Sector; label: string }[] = [
  { value: 'generic', label: 'Generic (no specific sector)' },
  { value: 'oil-gas', label: 'Oil & Gas' },
  { value: 'power-electric', label: 'Power & Electric' },
  { value: 'water-treatment', label: 'Water Treatment' },
  { value: 'automotive', label: 'Automotive Manufacturing' }
]

interface MetadataModalProps {
  /** Current scenario metadata to pre-populate the form. */
  meta: ICSLabMeta
  /** Called with the updated meta object when the user clicks Save. */
  onSave: (updated: ICSLabMeta) => void
  /** Called when the modal is dismissed without saving. */
  onClose: () => void
}

/**
 * Full-screen overlay modal for editing scenario metadata.
 *
 * Fields:
 *   - Scenario Name  — required; shown in the toolbar and .icslab filename.
 *   - Description    — optional; one-line summary shown in the scenario list.
 *   - Author         — optional; instructor name shown on the mission brief.
 *   - Sector         — select; determines which sector-specific tools/icons apply.
 *   - Mission Brief  — multiline markdown; displayed in Student mode side panel.
 */
export function MetadataModal({ meta, onSave, onClose }: MetadataModalProps) {
  const [name, setName] = useState(meta.name)
  const [description, setDescription] = useState(meta.description)
  const [author, setAuthor] = useState(meta.author)
  const [sector, setSector] = useState<Sector>(meta.sector)
  const [brief, setBrief] = useState(meta.brief)

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  function handleSave() {
    const trimmedName = name.trim()
    if (!trimmedName) return
    onSave({
      ...meta,
      name: trimmedName,
      description: description.trim(),
      author: author.trim(),
      sector,
      brief: brief.trim(),
      updatedAt: new Date().toISOString()
    })
  }

  return (
    <div
      className="modal-overlay"
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-panel metadata-modal">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title">
            <span className="modal-title-icon">✎</span>
            Scenario Builder
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {/* Form body */}
        <div className="modal-body">
          {/* Scenario Name */}
          <div className="meta-field">
            <label className="meta-label" htmlFor="meta-name">
              Scenario Name <span className="meta-required">*</span>
            </label>
            <input
              id="meta-name"
              className="meta-input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Water Treatment Plant Attack"
              maxLength={80}
            />
          </div>

          {/* Description */}
          <div className="meta-field">
            <label className="meta-label" htmlFor="meta-description">
              Description
            </label>
            <input
              id="meta-description"
              className="meta-input"
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Short one-line summary (shown in scenario list)"
              maxLength={160}
            />
          </div>

          {/* Author + Sector row */}
          <div className="meta-row-2col">
            <div className="meta-field">
              <label className="meta-label" htmlFor="meta-author">
                Author
              </label>
              <input
                id="meta-author"
                className="meta-input"
                type="text"
                value={author}
                onChange={e => setAuthor(e.target.value)}
                placeholder="Instructor name"
                maxLength={80}
              />
            </div>

            <div className="meta-field">
              <label className="meta-label" htmlFor="meta-sector">
                Sector
              </label>
              <select
                id="meta-sector"
                className="meta-input meta-select"
                value={sector}
                onChange={e => setSector(e.target.value as Sector)}
              >
                {SECTOR_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Mission Brief */}
          <div className="meta-field">
            <label className="meta-label" htmlFor="meta-brief">
              Mission Brief
            </label>
            <p className="meta-hint">
              Shown to students in Student mode. Describe the mission objectives, background
              context, and any flags or deliverables. Plain text or Markdown.
            </p>
            <textarea
              id="meta-brief"
              className="meta-input meta-textarea"
              value={brief}
              onChange={e => setBrief(e.target.value)}
              placeholder={
                '## Mission Objectives\n\n' +
                '1. Identify the vulnerable PLC on the OT network.\n' +
                '2. Capture Modbus register values from the water pump.\n' +
                '3. Document the attack vector used.\n\n' +
                '**Flag:** Retrieve the value from holding register 40001.'
              }
              rows={12}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!name.trim()}
            title={!name.trim() ? 'Scenario name is required' : ''}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
