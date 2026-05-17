/**
 * MissionPanel.tsx — Student mode mission brief side panel.
 *
 * Rendered in the workspace when scenario.meta.locked === true (Student mode).
 * Replaces the DevicePalette with a collapsible panel that shows:
 *   - A "Student Mode" header with a lock icon
 *   - The scenario name and author
 *   - The mission brief text (instructor-written mission objectives)
 *
 * The brief text is rendered as pre-formatted text using CSS whitespace-pre-wrap
 * so instructors can use simple line breaks and indentation. Students cannot
 * interact with the canvas in a way that modifies the scenario — the canvas and
 * properties panel are read-only when locked is true.
 *
 * @param name   - Scenario name displayed in the panel header.
 * @param author - Instructor name; hidden when blank.
 * @param brief  - Mission brief text. If empty, a placeholder is shown.
 */

import { useState } from 'react'

interface MissionPanelProps {
  /** Scenario name shown at the top of the panel. */
  name: string
  /** Instructor name. Shown beneath the title when non-empty. */
  author: string
  /** Mission brief text (plain text or Markdown-like). Shown in the scrollable body. */
  brief: string
}

/**
 * Collapsible left-side panel shown in Student mode.
 *
 * Collapsed state: shows only the "Mission" header tab so the canvas
 * has more horizontal space.
 * Expanded state: full width panel with mission brief content.
 */
export function MissionPanel({ name, author, brief }: MissionPanelProps) {
  const [collapsed, setCollapsed] = useState(false)

  if (collapsed) {
    return (
      <aside className="mission-panel mission-panel-collapsed">
        <button
          className="mission-panel-expand"
          onClick={() => setCollapsed(false)}
          title="Show mission brief"
        >
          <span className="mission-panel-expand-icon">🔒</span>
          <span className="mission-panel-expand-label">Mission</span>
        </button>
      </aside>
    )
  }

  return (
    <aside className="mission-panel">
      {/* Header — lock icon + "Student Mode" label + collapse button */}
      <div className="mission-header">
        <div className="mission-header-left">
          <span className="mission-lock-icon">🔒</span>
          <div>
            <div className="mission-mode-label">Student Mode</div>
          </div>
        </div>
        <button
          className="mission-collapse-btn"
          onClick={() => setCollapsed(true)}
          title="Collapse mission panel"
          aria-label="Collapse"
        >
          ‹
        </button>
      </div>

      {/* Scenario identity */}
      <div className="mission-identity">
        <div className="mission-scenario-name">{name}</div>
        {author && <div className="mission-author">by {author}</div>}
      </div>

      <div className="mission-divider" />

      {/* Mission brief body */}
      <div className="mission-brief-label">Mission Brief</div>
      <div className="mission-brief-body">
        {brief ? (
          <pre className="mission-brief-text">{brief}</pre>
        ) : (
          <p className="mission-brief-empty">No mission brief provided for this scenario.</p>
        )}
      </div>
    </aside>
  )
}
