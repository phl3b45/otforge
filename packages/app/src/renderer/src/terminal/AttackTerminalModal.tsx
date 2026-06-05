/**
 * AttackTerminalModal.tsx — Kali Linux terminal modal for the attack machine.
 *
 * Terminal data flow:
 *   Keystrokes → xterm onData → window.electronAPI.terminal.write(data)
 *                             → main process stdin of docker exec -i
 *   docker exec stdout/stderr → main process → 'terminal:data' IPC event
 *                             → on.terminalData listener → term.write(data)
 *
 * Clipboard paste (Ctrl+V only):
 *   Uses window.electronAPI.terminal.write(text) NOT term.paste(text).
 *   term.paste() wraps text in \x1b[200~...\x1b[201~ (xterm bracketed-paste mode)
 *   which bash in the container echoes as literal "^[[200~" unless readline is
 *   configured. terminal.write() sends raw bytes to PTY stdin with no markers.
 *
 * Dismiss: × button, backdrop click, or Escape key.
 *   Closing calls terminal:close to kill the docker exec process.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import type { DeviceConfig } from '@otforge/schema'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

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
 * @param device  - The attack-machine DeviceConfig (node ID + display name).
 * @param onClose - Callback to unmount this modal and return to the canvas.
 */
export function AttackTerminalModal({
  device,
  onClose
}: {
  device: DeviceConfig
  onClose: () => void
}) {
  const [termError, setTermError] = useState<string | null>(null)
  /** True while the noVNC desktop window is being opened (prevents double-click). */
  const [desktopLaunching, setDesktopLaunching] = useState<boolean>(false)

  /** Ref to the div that xterm.js mounts into. */
  const termDivRef = useRef<HTMLDivElement>(null)
  /** xterm.js Terminal instance — created once, torn down on modal close. */
  const termRef = useRef<Terminal | null>(null)
  /** FitAddon resizes the terminal to fill its container div. */
  const fitAddonRef = useRef<FitAddon | null>(null)
  /** True once docker exec has successfully attached. */
  const termConnectedRef = useRef<boolean>(false)

  // ── Terminal initialization ──────────────────────────────────────────────────
  useEffect(() => {
    if (!termDivRef.current) return

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

    // Clipboard paste handler — Ctrl+V / Ctrl+Shift+V / Cmd+V.
    //
    // Writes text directly to the docker exec PTY stdin via terminal.write() rather
    // than term.paste(), which would prepend \x1b[200~ (bracketed paste mode start)
    // and cause bash to echo "^[[200~" as literal characters.
    //
    // ev.preventDefault() must be called explicitly — xterm's
    // attachCustomKeyEventHandler does NOT call it when returning false, so without
    // it the browser still receives the event and may generate a system beep.
    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      const isPaste =
        ev.type === 'keydown' && ev.key.toLowerCase() === 'v' && (ev.ctrlKey || ev.metaKey)
      if (isPaste) {
        ev.preventDefault()
        window.electronAPI.clipboard
          .readText()
          .then(text => {
            if (text) window.electronAPI.terminal.write(text)
          })
          .catch(() => {
            // IPC failure — container may not be ready; ignore silently
          })
        return false
      }
      return true
    })

    // Welcome banner — the actual bash prompt follows from the container
    term.writeln('\x1b[32m[OTForge]\x1b[0m Connecting to attack machine...')
    term.writeln('\x1b[90mKali Linux · External network segment\x1b[0m')
    term.writeln('')

    // Open the docker exec session in the main process.
    window.electronAPI.terminal.open(device.nodeId).then(result => {
      if (!result.ok) {
        term.writeln(`\x1b[31mError: ${result.error ?? 'Failed to open terminal'}\x1b[0m`)
        setTermError(result.error ?? 'Failed to open terminal')
      } else {
        termConnectedRef.current = true
      }
    })

    // Pipe all keystrokes to the container's stdin
    const dataDispose = term.onData(data => {
      window.electronAPI.terminal.write(data)
    })

    // Subscribe to stdout/stderr pushed from the main process
    const unsubTermData = window.electronAPI.on.terminalData(data => {
      term.write(data)
    })

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
      termConnectedRef.current = false
    }
  }, [device.nodeId])

  // ── Open Kali Xfce4 desktop in a separate OS window ──────────────────────
  //
  // The noVNC BrowserWindow is also launched automatically by App.tsx when the
  // toolbar button is first clicked (attack:launchWindow IPC). This button is a
  // fallback for reopening it if it was closed, or for launching it manually.
  const handleOpenDesktop = useCallback(async () => {
    setDesktopLaunching(true)
    try {
      await window.electronAPI.attack.launchWindow(device.nodeId)
    } finally {
      setDesktopLaunching(false)
    }
  }, [device.nodeId])

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
      onMouseDown={e => {
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
          {/* Open Desktop button — launches the noVNC Xfce4 window (fallback/reopen) */}
          <button
            className="btn btn-sm btn-ghost attack-modal-desktop-btn"
            onClick={handleOpenDesktop}
            disabled={desktopLaunching}
            title="Open the Kali Linux Xfce4 desktop in a separate window (Wireshark · Armitage · Firefox)"
          >
            {desktopLaunching ? 'Opening…' : '🖥 Desktop'}
          </button>
          <button className="attack-modal-close" onClick={onClose} aria-label="Close terminal">
            ×
          </button>
        </div>

        {/* ── Terminal body ────────────────────────────────────────────────── */}
        <div className="attack-modal-body">
          <div className="attack-terminal-container">
            {termError && (
              <div className="attack-terminal-error">
                {termError}
                <p>Ensure the simulation is running and the attack machine container is healthy.</p>
              </div>
            )}
            <div ref={termDivRef} className="attack-terminal-xterm" />
          </div>
        </div>
      </div>
    </div>
  )
}
