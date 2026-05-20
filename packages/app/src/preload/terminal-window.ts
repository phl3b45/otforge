/**
 * terminal-window.ts — Minimal contextBridge preload for the attack terminal window.
 *
 * Exposes only the three IPC namespaces the standalone xterm terminal page needs:
 *   terminal  — open/write/close the docker exec PTY session
 *   clipboard — read the host clipboard for Ctrl+V paste
 *   on        — subscribe to terminal:data push events from the main process
 *
 * Security: contextIsolation: true, nodeIntegration: false, sandbox: false.
 * The renderer cannot access Node.js or Electron directly; all IPC goes through
 * this gatekeeper.
 */

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  terminal: {
    /**
     * Opens an interactive bash session (via python3 pty.spawn) in the named
     * attack-machine container. Stdout/stderr are pushed back as 'terminal:data' events.
     */
    open: (nodeId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('terminal:open', { nodeId }),

    /**
     * Sends a keystroke or paste payload to the running PTY's stdin.
     * Called by xterm.js onData handler and the Ctrl+V paste handler.
     */
    write: (data: string): Promise<void> => ipcRenderer.invoke('terminal:write', { data }),

    /**
     * Kills the active terminal session. Called on window beforeunload.
     */
    close: (): Promise<void> => ipcRenderer.invoke('terminal:close')
  },

  clipboard: {
    /**
     * Reads the system clipboard as plain text via Electron's native clipboard module.
     * Bypasses navigator.clipboard.readText() which requires HTTPS in renderer.
     */
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText')
  },

  on: {
    /**
     * Subscribes to stdout/stderr chunks from the active terminal session.
     * Each chunk is a raw string (may contain ANSI escape codes).
     * @returns Unsubscribe function — call on cleanup.
     */
    terminalData: (cb: (data: string) => void): (() => void) => {
      ipcRenderer.on('terminal:data', (_event, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('terminal:data')
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)

/** TypeScript type for window.electronAPI in the terminal window renderer. */
export type TerminalWindowAPI = typeof api
