/**
 * attack-terminal.ts — Standalone xterm.js terminal for the Kali attack machine.
 *
 * Loaded by terminal.html in a separate Electron BrowserWindow opened by
 * attack:openTerminalWindow. Connects to the Kali container via docker exec
 * (python3 pty.spawn inside the container) for full interactive bash with echo,
 * readline, colors, and Ctrl+C support.
 *
 * The nodeId is passed as a URL query parameter (?nodeId=attack-1) so this
 * page knows which container to connect to.
 *
 * Clipboard paste:
 *   Ctrl+V / Cmd+V → reads host clipboard via Electron IPC → writes raw bytes
 *   to docker exec PTY stdin. Uses terminal.write() NOT term.paste() to avoid
 *   xterm's bracketed-paste mode markers (\x1b[200~) that bash echoes as ^[[200~.
 *
 * Data flow:
 *   Keystrokes → term.onData → electronAPI.terminal.write → main → PTY stdin
 *   PTY stdout  → main → 'terminal:data' IPC event → term.write → xterm display
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// ── Read nodeId from URL ───────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search)
const nodeId = params.get('nodeId') ?? ''

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

// ── Terminal setup ────────────────────────────────────────────────────────────
const term = new Terminal({
  theme: XTERM_THEME,
  fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
  fontSize: 13,
  lineHeight: 1.4,
  cursorBlink: true,
  cursorStyle: 'block',
  scrollback: 5000,
  convertEol: true
})

const fitAddon = new FitAddon()
term.loadAddon(fitAddon)

const container = document.getElementById('terminal-root')!
term.open(container)
fitAddon.fit()

// ── Clipboard paste — Ctrl+V / Cmd+V ─────────────────────────────────────────
// Writes raw text to PTY stdin via terminal.write() (not term.paste()) to avoid
// xterm's bracketed paste mode wrapping (\x1b[200~) which bash echoes as ^[[200~.
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
      .catch(() => {})
    return false
  }
  return true
})

// ── Connect to docker exec PTY ────────────────────────────────────────────────
term.writeln('\x1b[32m[OTForge]\x1b[0m Connecting to attack machine...')
term.writeln('\x1b[90mKali Linux · External network segment · Ctrl+V to paste\x1b[0m')
term.writeln('')

window.electronAPI.terminal.open(nodeId).then(result => {
  if (!result.ok) {
    term.writeln(`\x1b[31mError: ${result.error ?? 'Failed to connect'}\x1b[0m`)
    term.writeln(
      '\x1b[90mEnsure the simulation is running and the attack container is healthy.\x1b[0m'
    )
  }
})

// ── Pipe keystrokes to PTY stdin ──────────────────────────────────────────────
term.onData(data => {
  window.electronAPI.terminal.write(data)
})

// ── Receive PTY stdout/stderr ─────────────────────────────────────────────────
window.electronAPI.on.terminalData(data => {
  term.write(data)
})

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => fitAddon.fit())

// ── Cleanup on window close ───────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  window.electronAPI.terminal.close()
})
