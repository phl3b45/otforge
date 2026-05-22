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
 *   - IP template resolution — {{nodeId.ip}} is replaced with the device's
 *     actual configured IP address from the scenario's device map, making tutorial
 *     commands work regardless of which IP scheme the instructor assigned.
 *
 * Props:
 *   steps    — Array of TutorialStep objects from scenario.meta.tutorialSteps
 *   devices  — Optional map of nodeId → { ipAddress } from scenario.devices.devices;
 *              used to resolve {{nodeId.ip}} and {{nodeId.subnet}} template vars
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
import type { TutorialStep } from '@otforge/schema'

// ── Props ──────────────────────────────────────────────────────────────────────

/**
 * Minimal device shape needed for IP template resolution.
 * Using a structural subset avoids importing the full DeviceConfig schema here.
 */
interface DeviceIpEntry {
  ipAddress: string
}

interface TutorialPanelProps {
  /** All tutorial steps from the scenario. Must be non-empty. */
  steps: TutorialStep[]
  /**
   * Map of nodeId → device config, used to resolve {{nodeId.ip}} and
   * {{nodeId.subnet}} template variables in step commands and body text.
   * If omitted, template variables are left unreplaced (shown as-is).
   */
  devices?: Record<string, DeviceIpEntry>
  /** Called when the user clicks the × close button. */
  onClose: () => void
}

// ── IP template resolver ───────────────────────────────────────────────────────

/**
 * Replaces {{nodeId.ip}} and {{nodeId.subnet}} template variables in a text string
 * with the corresponding device IP address or /24 subnet from the devices map.
 *
 * Template variable reference:
 *   {{plc-1.ip}}      → e.g. "10.200.10.10"  (device's configured IP address)
 *   {{plc-1.subnet}}  → e.g. "10.200.10.0/24" (host portion zeroed, /24 appended)
 *
 * Unresolved variables (device not in map, or no devices prop) are left unchanged
 * so students see the template literal as a hint rather than an empty string.
 *
 * @param text    - Raw text possibly containing {{nodeId.ip}} or {{nodeId.subnet}}
 * @param devices - nodeId → device map from scenario.devices.devices
 * @returns Text with template variables substituted by real IP values
 */
function resolveTemplates(text: string, devices?: Record<string, DeviceIpEntry>): string {
  if (!devices) return text
  return text.replace(/\{\{([^}.]+)\.(ip|subnet)\}\}/g, (match, nodeId, field) => {
    const device = devices[nodeId]
    if (!device?.ipAddress) return match // leave unresolved so students see the var name
    if (field === 'ip') return device.ipAddress
    if (field === 'subnet') {
      // Derive /24 subnet by zeroing the last octet of the IP address.
      // e.g. "10.200.10.10" → "10.200.10.0/24"
      const parts = device.ipAddress.split('.')
      if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
      }
    }
    return match
  })
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
export function TutorialPanel({ steps, devices, onClose }: TutorialPanelProps): React.JSX.Element {
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
  // The panel is 440 px wide (matching .tutorial-panel CSS); place it bottom-right.
  useEffect(() => {
    const panelW = 440
    const panelH = 640 // updated to match tutorial-body max-height increase
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

  // Resolve {{nodeId.ip}} and {{nodeId.subnet}} variables in the current step's
  // command and body text using the live device IP map from the scenario.
  const resolvedCommand = step.command ? resolveTemplates(step.command, devices) : undefined
  const resolvedBody = resolveTemplates(step.body, devices)
  const resolvedSuccessCheck = step.successCheck
    ? resolveTemplates(step.successCheck, devices)
    : undefined

  const handleCopy = useCallback(async () => {
    if (!resolvedCommand) return
    // Use the Electron native clipboard IPC rather than navigator.clipboard.writeText().
    // navigator.clipboard requires 'clipboard-write' permission which fails silently in
    // Electron renderers (non-HTTPS origin). The native path guarantees the OS clipboard
    // receives the text so Ctrl+V in the attack terminal always finds the copied command.
    await window.electronAPI.clipboard.writeText(resolvedCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [resolvedCommand])

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
          {/* Instructional text — Markdown subset rendered as React nodes.
              IP template variables ({{nodeId.ip}}) are resolved before rendering. */}
          <div className="tutorial-content">{renderBody(resolvedBody)}</div>

          {/* Command block — only shown when the step has a shell command.
              The command is displayed with {{nodeId.ip}} already resolved so students
              can copy and paste it without needing to look up the device IP first. */}
          {resolvedCommand && (
            <div className="tutorial-command-block">
              <div className="tutorial-command-label">Command</div>
              <div className="tutorial-command-row">
                <pre className="tutorial-command-pre">{resolvedCommand}</pre>
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

          {/* Success check hint — shown when provided. Template vars resolved. */}
          {resolvedSuccessCheck && (
            <div className="tutorial-success-check">
              <span className="tutorial-success-icon" aria-hidden="true">
                ✓
              </span>
              <span>{resolvedSuccessCheck}</span>
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
