/**
 * electron.vite.config.ts — Build configuration for the Electron application.
 *
 * Three compilation targets:
 *   main     — Node.js process (externalized deps; no bundling of node_modules)
 *   preload  — Sandboxed Node context (also externalized; no bundling needed)
 *   renderer — Browser/React context (Rolldown-bundled; deps inlined)
 *
 * electron-vite 5.x: externalizeDeps: true handles Node.js built-ins correctly.
 *
 * Vite 8.x / Rolldown regression: externalizeDeps: true does NOT externalize
 * node_modules packages (electron, @electron-toolkit/*, classic-level, etc.).
 * Rolldown resolves them to absolute file paths before the external check and
 * then inlines them, breaking __dirname-dependent native module loading.
 *
 * Fix: the `external` function in rollupOptions returns true for any import that
 * is a bare specifier (not a relative path, not a virtual module, not an absolute
 * path). This covers all node_modules regardless of how rolldown resolves them.
 *
 * Output extension: Rolldown produces .mjs for ESM bundles. package.json "main"
 * and preload path references in src/main/index.ts both use .mjs to match.
 */

import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react-oxc'

/**
 * Returns true for any module ID that should be kept as a runtime external —
 * i.e., anything that is NOT a relative import, a virtual rolldown module, or
 * an absolute file-system path. This covers the full node_modules tree and
 * works around the rolldown regression where externalizeDeps: true is ignored.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const externalAll = (id: string): any =>
  !id.startsWith('.') &&
  !id.startsWith('\0') &&
  !id.startsWith('/') &&
  !/^[A-Za-z]:/.test(id) // Windows absolute path e.g. C:\...

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        external: externalAll,
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },

  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        external: externalAll,
        input: {
          /** Main app preload — exposes full electronAPI to the React renderer. */
          index: resolve(__dirname, 'src/preload/index.ts'),
          /**
           * Standalone terminal window preload — exposes a minimal subset of
           * electronAPI (terminal, clipboard, on.terminalData) to the xterm.js
           * terminal page. Kept separate to enforce least-privilege: the terminal
           * window cannot call simulation, scenario, or attack IPC channels.
           */
          terminalWindow: resolve(__dirname, 'src/preload/terminal-window.ts')
        }
      }
    }
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          /** Main React app entry point. */
          index: resolve(__dirname, 'src/renderer/index.html'),
          /**
           * Standalone xterm.js terminal page loaded by the attack:openTerminalWindow
           * BrowserWindow. Plain TypeScript — no React framework overhead.
           */
          terminal: resolve(__dirname, 'src/renderer/terminal.html')
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@schema': resolve(__dirname, '../schema/src')
      }
    }
  }
})
