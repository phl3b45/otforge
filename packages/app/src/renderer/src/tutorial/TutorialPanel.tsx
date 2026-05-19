/**
 * TutorialPanel.tsx — Floating guided tutorial overlay for step-by-step scenarios.
 *
 * Displayed automatically when the active scenario contains `meta.tutorialSteps`.
 * Designed for Tutorial 01 (Modbus Coil Write) and all future guided scenarios.
 *
 * Features:
 *   - Floating, draggable panel — does not block the canvas or terminal
 *   - Step counter + progress bar
 *   - Markdown body rendered as plain text (no markdown library dependency)
 *   - Command copy block — one-click copies shell command to clipboard
 *   - Previous / Next navigation with keyboard support (← →)
 *   - Minimise button — collapses to a header-only strip so the canvas is visible
 *   - Close button — hides the panel (scenario progress is NOT reset)
 *
 * Props:
 *   steps    — Array of TutorialStep objects from scenario.meta.tutorialSteps
 *   onClose  — Called when the user clicks ×; parent sets showTutorial=false
 *
 * State owned here (not persisted across sessions — intentional for student UX):
 *   currentIndex  — which step is showing (0-based)
 *   minimized     — whether the panel body is collapsed to header-only
 *   copied        — transient flag for copy-button feedback ("Copied!")
 *   dragging      — whether the user is currently dragging the panel
 *   position      — absolute {x, y} of the panel (default: bottom-right corner)
 *
 * Z-index: 150 — above the workspace (100) but below full-screen modals (200+).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { TutorialStep } from '@ics-sim/schema'

// ── Props ──────────────────────────────────────────────────────────────────────

interface TutorialPanelProps {
  /** All tutorial steps from the scenario. Must be non-empty. */
  steps: TutorialStep[]
  /** Called when the user clicks the × close button. */
  onClose: () => void
}

// ── Helper: simple Markdown → plain-text paragraph breaks ─────────────────────

/**
 * Converts a limited subset of Markdown to React elements without pulling in a
 * full markdown parser. Handles:
 *   - `**bold**`  → <strong>
 *   - `` `code` `` → <code> (inline)
 *   - `\n\n`      → paragraph break
 *   - `- item`    → bullet list item
 *
 * This is intentionally minimal — full Markdown support belongs in a later
 * iteration if the tutorial system grows beyond simple instructional text.
 */
function renderBody(body: string): React.ReactNode {
  // Split on double-newlines for paragraphs; single newlines preserved inside
  const paragraphs = body.trim().split(/\n\n+/)
  return paragraphs.map((para, pi) => {
    // Detect bullet list blocks
    if (para.startsWith('- ') || para.includes('\n- ')) {
      const items = para.split('\n').filter(l => l.startsWith('- '))
      return (
        <ul key={pi} className="tutorial-list">
          {items.map((item, ii) => (
            <li key={ii}>{inlineFormat(item.slice(2))}</li>
          ))}
        </ul>
      )
    }
    return (
      <p key={pi} className="tutorial-para">
        {inlineFormat(para)}
      </p>
    )
  })
}

/**
 * Processes inline Markdown tokens (**bold**, `code`) within a text string,
 * returning an array of React nodes (strings and elements) for rendering.
 *
 * Uses a simple split-on-delimiter approach rather than a regex engine to
 * keep the output predictable and avoid ReDoS risk on student-authored content.
 */
function inlineFormat(text: string): React.ReactNode[] {
  // Process `code` spans first (backtick delimiters)
  const codeTokens = text.split('`')
  const nodes: React.ReactNode[] = []
  codeTokens.forEach((segment, i) => {
    if (i % 2 === 1) {
      // Odd indices are inside backticks — render as <code>
      nodes.push(
        <code key={`c${i}`} className="tutorial-inline-code">
          {segment}
        </code>
      )
    } else {
      // Even indices — process **bold** spans
      const boldTokens = segment.split('**')
      boldTokens.forEach((boldSeg, j) => {
        if (j % 2 === 1) {
          nodes.push(<strong key={`b${i}-${j}`}>{boldSeg}</strong>)
        } else if (boldSeg) {
          nodes.push(boldSeg)
        }
      })
    }
  })
  return nodes
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Floating step-by-step tutorial panel.
 *
 * Rendered as a fixed-position overlay that the student can drag to any corner
 * of the screen without covering the canvas or the attack terminal.
 */
export function TutorialPanel({ steps, onClose }: TutorialPanelProps): React.JSX.Element {
  // Which step is currently displayed (0-based index)
  const [currentIndex, setCurrentIndex] = useState<number>(0)
  // Whether the panel body is collapsed to header-only strip
  const [minimized, setMinimized] = useState<boolean>(false)
  // Transient copy feedback — "Copy" → "Copied!" for 1.5 s
  const [copied, setCopied] = useState<boolean>(false)
  // Panel position (px from top-left of viewport)
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: -1, y: -1 })
  // Whether the user is currently dragging the header
  const dragging = useRef<boolean>(false)
  // Offset from panel top-left to the mouse click point during drag
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  // Ref to the panel element for size calculations
  const panelRef = useRef<HTMLDivElement>(null)

  const step = steps[currentIndex]
  const total = steps.length

  // ── Default position: bottom-right corner, 24 px inset ──────────────────────
  // Calculated on first render using window dimensions to avoid hardcoding.
  // The panel is 360 px wide and ~500 px tall (variable); place it bottom-right.
  useEffect(() => {
    const panelW = 360
    const panelH = 480
    setPosition({
      x: Math.max(0, window.innerWidth - panelW - 24),
      y: Math.max(0, window.innerHeight - panelH - 48)
    })
  }, [])

  // ── Keyboard navigation: ← Previous, → Next ─────────────────────────────────
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      // Only intercept arrow keys when no text input is focused
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowRight' && currentIndex < total - 1) {
        setCurrentIndex(i => i + 1)
        setCopied(false)
      } else if (e.key === 'ArrowLeft' && currentIndex > 0) {
        setCurrentIndex(i => i - 1)
        setCopied(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [currentIndex, total])

  // ── Drag handlers ────────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only drag from the header; ignore clicks on buttons inside the header
    if ((e.target as HTMLElement).closest('button')) return
    dragging.current = true
    dragOffset.current = {
      x: e.clientX - (panelRef.current?.getBoundingClientRect().left ?? 0),
      y: e.clientY - (panelRef.current?.getBoundingClientRect().top ?? 0)
    }
    e.preventDefault()
  }, [])

  useEffect(() => {
    function handleMouseMove(e: MouseEvent): void {
      if (!dragging.current) return
      const x = e.clientX - dragOffset.current.x
      const y = e.clientY - dragOffset.current.y
      // Clamp within viewport so the panel cannot be dragged off screen
      const maxX = window.innerWidth - (panelRef.current?.offsetWidth ?? 360)
      const maxY = window.innerHeight - (panelRef.current?.offsetHeight ?? 48)
      setPosition({ x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(y, maxY)) })
    }
    function handleMouseUp(): void {
      dragging.current = false
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // ── Copy command to clipboard ────────────────────────────────────────────────

  const handleCopy = useCallback(async () => {
    if (!step.command) return
    try {
      await navigator.clipboard.writeText(step.command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access denied (e.g. non-https Electron context) — silently ignore
    }
  }, [step.command])

  // Navigation helpers
  const goNext = useCallback(() => {
    if (currentIndex < total - 1) {
      setCurrentIndex(i => i + 1)
      setCopied(false)
    }
  }, [currentIndex, total])

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(i => i - 1)
      setCopied(false)
    }
  }, [currentIndex])

  // Do not render until position is initialised (avoids flash at 0,0)
  if (position.x < 0) return <></>

  return (
    <div
      ref={panelRef}
      className={`tutorial-panel${minimized ? ' tutorial-panel--minimized' : ''}`}
      style={{ left: position.x, top: position.y }}
      role="complementary"
      aria-label="Tutorial guidance panel"
    >
      {/* ── Header ── */}
      <div className="tutorial-header" onMouseDown={handleMouseDown}>
        <span className="tutorial-header-icon" aria-hidden="true">
          🎓
        </span>
        <span className="tutorial-header-title">{step.title}</span>
        <span className="tutorial-header-counter">
          {currentIndex + 1}/{total}
        </span>
        <button
          className="tutorial-btn-icon"
          title={minimized ? 'Expand' : 'Minimise'}
          onClick={() => setMinimized(m => !m)}
          aria-expanded={!minimized}
        >
          {minimized ? '▲' : '▼'}
        </button>
        <button
          className="tutorial-btn-icon"
          title="Close tutorial"
          onClick={onClose}
          aria-label="Close tutorial panel"
        >
          ×
        </button>
      </div>

      {/* ── Progress bar ── */}
      {!minimized && (
        <div
          className="tutorial-progress-bar"
          role="progressbar"
          aria-valuenow={currentIndex + 1}
          aria-valuemin={1}
          aria-valuemax={total}
        >
          <div
            className="tutorial-progress-fill"
            style={{ width: `${((currentIndex + 1) / total) * 100}%` }}
          />
        </div>
      )}

      {/* ── Body ── */}
      {!minimized && (
        <div className="tutorial-body">
          {/* Instructional text — Markdown subset rendered as React nodes */}
          <div className="tutorial-content">{renderBody(step.body)}</div>

          {/* Command block — only shown when the step has a shell command */}
          {step.command && (
            <div className="tutorial-command-block">
              <div className="tutorial-command-label">Command</div>
              <div className="tutorial-command-row">
                <pre className="tutorial-command-pre">{step.command}</pre>
                <button
                  className={`tutorial-copy-btn${copied ? ' tutorial-copy-btn--copied' : ''}`}
                  onClick={handleCopy}
                  title="Copy to clipboard"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Success check hint — shown when provided */}
          {step.successCheck && (
            <div className="tutorial-success-check">
              <span className="tutorial-success-icon" aria-hidden="true">
                ✓
              </span>
              <span>{step.successCheck}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Navigation footer ── */}
      {!minimized && (
        <div className="tutorial-footer">
          <button
            className="tutorial-nav-btn"
            onClick={goPrev}
            disabled={currentIndex === 0}
            title="Previous step (←)"
          >
            ← Previous
          </button>
          <div className="tutorial-dots" aria-hidden="true">
            {steps.map((_, i) => (
              <span
                key={i}
                className={`tutorial-dot${i === currentIndex ? ' tutorial-dot--active' : i < currentIndex ? ' tutorial-dot--done' : ''}`}
                onClick={() => {
                  setCurrentIndex(i)
                  setCopied(false)
                }}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    setCurrentIndex(i)
                    setCopied(false)
                  }
                }}
                aria-label={`Go to step ${i + 1}`}
              />
            ))}
          </div>
          <button
            className="tutorial-nav-btn tutorial-nav-btn--primary"
            onClick={goNext}
            disabled={currentIndex === total - 1}
            title="Next step (→)"
          >
            {currentIndex === total - 1 ? 'Done' : 'Next →'}
          </button>
        </div>
      )}
    </div>
  )
}
