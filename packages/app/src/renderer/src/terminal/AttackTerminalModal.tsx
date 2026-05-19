/**
 * AttackTerminalModal.tsx — Full-screen modal for the Kali attack machine.
 *
 * Layout:
 *   Fixed backdrop dims the canvas beneath (same pattern as PlcIdeModal).
 *   Centered panel:
 *     Header  — device node ID · "Kali Linux Attack Machine" label · × close
 *     Tab bar — "Terminal" | "Desktop"
 *     Body    — Terminal tab: xterm.js connected to docker exec via IPC
 *               Desktop tab: launcher button that opens the noVNC desktop in a
 *                            separate OS-level BrowserWindow via attack:launchWindow IPC
 *
 * Why the Desktop tab uses a separate window instead of an embedded webview:
 *   Electron's <webview> tag has WebSocket security restrictions that intermittently
 *   block the noVNC WebSocket connection to localhost, causing "cannot connect to server"
 *   errors even when websockify is running. The attack:launchWindow IPC handler opens a
 *   full BrowserWindow (sandbox: true, nodeIntegration: false) which handles localhost
 *   WebSocket connections correctly. An external window also lets students/instructors
 *   place the Kali desktop on a second monitor independently of the main simulator.
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
import type { DeviceConfig } from '@otforge/schema'
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
  const [termError, setTermError] = useState<string | null>(null)
  /** Whether the desktop was successfully opened in an external BrowserWindow. */
  const [desktopLaunched, setDesktopLaunched] = useState<boolean>(false)
  /** Error message from the last attempt to open the desktop window. */
  const [desktopError, setDesktopError] = useState<string | null>(null)
  /** Whether a desktop launch is in progress (prevents double-clicks). */
  const [desktopLaunching, setDesktopLaunching] = useState<boolean>(false)

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
    term.writeln('\x1b[32m[OTForge]\x1b[0m Connecting to attack machine...')
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

  // ── Desktop tab switch ───────────────────────────────────────────────────
  const handleDesktopTab = useCallback(() => {
    setActiveTab('desktop')
  }, [])

  /**
   * Opens the Kali Linux Xfce4 desktop in a separate native OS window via the
   * attack:launchWindow IPC handler. That handler opens a sandboxed BrowserWindow
   * loading the noVNC page over localhost; the window is fully independent of the
   * main simulator so it can be moved to a second monitor.
   *
   * Using a separate BrowserWindow instead of an embedded <webview> avoids Electron
   * WebSocket restrictions that cause "cannot connect to server" errors in webviews.
   * The main process also runs isPortOpen() before creating the window — if the
   * container's websockify is not ready yet, the user sees a clear retry message.
   */
  const handleLaunchDesktop = useCallback(async () => {
    setDesktopLaunching(true)
    setDesktopError(null)
    try {
      const result = await window.electronAPI.attack.launchWindow(device.nodeId)
      if (result.ok) {
        setDesktopLaunched(true)
      } else {
        setDesktopError(result.error ?? 'Failed to open desktop window')
      }
    } finally {
      setDesktopLaunching(false)
    }
  }, [device.nodeId])

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

          {/*
           * Desktop panel — launches the Kali Linux Xfce4 desktop in a separate OS window.
           *
           * Three states:
           *   Idle       — shows a "Launch Desktop" button with usage instructions
           *   Launched   — confirms the window is open; offers "Open Again" in case it was closed
           *   Error      — shows the error message from the main process + a Retry button
           *
           * The desktop opens via attack:launchWindow which creates a sandboxed BrowserWindow
           * pointing at the container's noVNC page (localhost:<hostPort>/vnc.html).
           * This is more reliable than embedding a <webview> because BrowserWindow handles
           * localhost WebSocket connections without the security restrictions of webviews.
           */}
          {activeTab === 'desktop' && (
            <div className="attack-desktop-container">
              {desktopError ? (
                /* Error state — show the message from the main process */
                <div className="attack-terminal-error">
                  <strong>Could not open desktop</strong>
                  <p style={{ marginTop: 6 }}>{desktopError}</p>
                  <p style={{ marginTop: 4 }}>
                    The Xfce4 desktop starts ~10 seconds after the container boots. Wait a moment
                    and try again.
                  </p>
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ marginTop: 12 }}
                    onClick={handleLaunchDesktop}
                    disabled={desktopLaunching}
                  >
                    {desktopLaunching ? 'Opening…' : 'Retry'}
                  </button>
                </div>
              ) : desktopLaunched ? (
                /* Success state — desktop window is open */
                <div className="attack-desktop-launched">
                  <span className="attack-desktop-launched-icon" aria-hidden="true">
                    🖥
                  </span>
                  <p>
                    <strong>Kali Linux desktop is open in a separate window.</strong>
                  </p>
                  <p>Move the window to a second monitor for the best experience.</p>
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ marginTop: 12 }}
                    onClick={handleLaunchDesktop}
                    disabled={desktopLaunching}
                    title="Open another desktop window (or reopen if closed)"
                  >
                    {desktopLaunching ? 'Opening…' : 'Open Again'}
                  </button>
                </div>
              ) : (
                /* Idle state — show launcher with instructions */
                <div className="attack-desktop-launcher">
                  <span className="attack-desktop-launcher-icon" aria-hidden="true">
                    🖥
                  </span>
                  <p className="attack-desktop-launcher-title">
                    <strong>Kali Linux Xfce4 Desktop</strong>
                  </p>
                  <p className="attack-desktop-launcher-desc">
                    Opens in a separate OS window via noVNC WebSocket bridge.
                    <br />
                    Move it to a second monitor for the best experience.
                  </p>
                  <button
                    className="btn btn-sm btn-attack-launch"
                    style={{ marginTop: 12 }}
                    onClick={handleLaunchDesktop}
                    disabled={desktopLaunching}
                    title="Open the Kali Linux Xfce4 desktop in a separate window"
                  >
                    {desktopLaunching ? 'Opening…' : '⚔ Launch Desktop'}
                  </button>
                  <p className="attack-desktop-launcher-note">
                    The desktop starts ~10 s after the container boots. If launch fails, wait a
                    moment and retry.
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
