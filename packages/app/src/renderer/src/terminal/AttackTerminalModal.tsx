/**
 * AttackTerminalModal.tsx — Full-screen modal for the Kali attack machine.
 *
 * Layout:
 *   Fixed backdrop dims the canvas beneath (same pattern as PlcIdeModal).
 *   Centered panel:
 *     Header  — device node ID · "Kali Linux Attack Machine" label · × close
 *     Tab bar — "Terminal" | "Desktop"
 *     Body    — Terminal tab: xterm.js connected to docker exec via IPC
 *               Desktop tab: noVNC webview (Wireshark, Armitage, full Xfce4)
 *
 * Terminal data flow:
 *   Keystrokes → xterm onData → window.electronAPI.terminal.write(data)
 *                             → main process stdin of docker exec -i
 *   docker exec stdout/stderr → main process → 'terminal:data' IPC event
 *                             → on.terminalData listener → terminal.write(data)
 *
 * Dismiss with:
 *   × button, backdrop click, or Escape key.
 *   Closing calls terminal:close to kill the docker exec process.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import type { DeviceConfig } from '@ics-sim/schema'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/** Which panel is currently active in the tab bar. */
type ActiveTab = 'terminal' | 'desktop'

// ── xterm.js theme — matches the app's dark palette ──────────────────────────
const XTERM_THEME = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc'
}

/**
 * AttackTerminalModal
 *
 * @param device    - The attack-machine DeviceConfig (used for node ID and display name).
 * @param onClose   - Callback to close this modal and return to the canvas.
 */
export function AttackTerminalModal({
  device,
  onClose
}: {
  device: DeviceConfig
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('terminal')
  const [vncUrl, setVncUrl] = useState<string | null>(null)
  const [vncError, setVncError] = useState<string | null>(null)
  const [termError, setTermError] = useState<string | null>(null)

  /** Ref to the div that xterm.js mounts into. */
  const termDivRef = useRef<HTMLDivElement>(null)
  /** xterm.js Terminal instance — created once, torn down on modal close. */
  const termRef = useRef<Terminal | null>(null)
  /** FitAddon resizes the terminal to fill its container div. */
  const fitAddonRef = useRef<FitAddon | null>(null)

  // ── Terminal initialization ──────────────────────────────────────────────────
  useEffect(() => {
    if (!termDivRef.current) return

    // Create terminal with the app's dark theme
    const term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      convertEol: true // CRLF → LF so bash output renders cleanly
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(termDivRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Welcome banner printed locally — the actual bash prompt follows from the container
    term.writeln('\x1b[32m[ICS Simulator]\x1b[0m Connecting to attack machine...')
    term.writeln('\x1b[90mKali Linux · External network segment\x1b[0m')
    term.writeln('')

    // Open the docker exec session in the main process
    window.electronAPI.terminal.open(device.nodeId).then(result => {
      if (!result.ok) {
        term.writeln(`\x1b[31mError: ${result.error ?? 'Failed to open terminal'}\x1b[0m`)
        setTermError(result.error ?? 'Failed to open terminal')
      }
    })

    // Pipe all keystrokes and paste events to the container's stdin
    const dataDispose = term.onData(data => {
      window.electronAPI.terminal.write(data)
    })

    // Subscribe to stdout/stderr pushed from the main process
    const unsubTermData = window.electronAPI.on.terminalData(data => {
      term.write(data)
    })

    // Resize handler — refit when the window is resized
    const handleResize = () => fitAddonRef.current?.fit()
    window.addEventListener('resize', handleResize)

    return () => {
      dataDispose.dispose()
      unsubTermData()
      window.removeEventListener('resize', handleResize)
      window.electronAPI.terminal.close()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [device.nodeId])

  // ── noVNC URL fetch — triggered when user switches to Desktop tab ─────────
  const handleDesktopTab = useCallback(async () => {
    setActiveTab('desktop')
    if (vncUrl) return // already fetched

    const result = await window.electronAPI.terminal.getVncUrl(device.nodeId)
    if (result.url) {
      setVncUrl(result.url)
    } else {
      setVncError(result.error ?? 'Could not determine noVNC URL')
    }
  }, [device.nodeId, vncUrl])

  // ── Refit terminal when switching back to Terminal tab ───────────────────
  const handleTerminalTab = useCallback(() => {
    setActiveTab('terminal')
    // Defer one frame so the div is visible before fitting
    requestAnimationFrame(() => fitAddonRef.current?.fit())
  }, [])

  // ── Escape key dismiss ────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="attack-modal-overlay"
      onClick={e => {
        // Close only when clicking the dim backdrop, not the panel itself
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="attack-modal">
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="attack-modal-header">
          <div className="attack-modal-title">
            <span className="attack-modal-device-name">{device.nodeId}</span>
            <span className="attack-modal-subtitle">Kali Linux · Attack Machine</span>
          </div>
          <button className="attack-modal-close" onClick={onClose} aria-label="Close terminal">
            ×
          </button>
        </div>

        {/* ── Tab bar ─────────────────────────────────────────────────────── */}
        <div className="attack-modal-tabs">
          <button
            className={`attack-tab-btn ${activeTab === 'terminal' ? 'active' : ''}`}
            onClick={handleTerminalTab}
          >
            Terminal
          </button>
          <button
            className={`attack-tab-btn ${activeTab === 'desktop' ? 'active' : ''}`}
            onClick={handleDesktopTab}
          >
            Desktop
            <span className="attack-tab-hint">Wireshark · Armitage · Firefox</span>
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="attack-modal-body">
          {/* Terminal panel — always mounted so xterm.js state is preserved */}
          <div
            className="attack-terminal-container"
            style={{ display: activeTab === 'terminal' ? 'flex' : 'none' }}
          >
            {termError && (
              <div className="attack-terminal-error">
                {termError}
                <p>Ensure the simulation is running and the attack machine container is healthy.</p>
              </div>
            )}
            {/* xterm.js mounts here */}
            <div ref={termDivRef} className="attack-terminal-xterm" />
          </div>

          {/* Desktop panel — noVNC webview */}
          {activeTab === 'desktop' && (
            <div className="attack-desktop-container">
              {vncError ? (
                <div className="attack-terminal-error">
                  {vncError}
                  <p>
                    Ensure the simulation is running. The noVNC service starts ~5 s after the
                    container boots.
                  </p>
                </div>
              ) : vncUrl ? (
                <webview src={vncUrl} className="attack-novnc-webview" allowpopups="true" />
              ) : (
                <div className="attack-desktop-loading">
                  <span className="status-dot checking" />
                  Connecting to Xfce4 desktop…
                  <p className="attack-desktop-hint">
                    VNC password: <code>kali</code>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
