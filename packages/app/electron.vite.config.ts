/**
 * electron.vite.config.ts — Build configuration for the Electron application.
 *
 * Three compilation targets:
 *   main     — Node.js process (CommonJS, all deps externalized via externalizeDeps)
 *   preload  — Sandboxed Node context (also externalized; no bundling needed)
 *   renderer — Browser/React context (Rolldown-bundled; deps inlined)
 *
 * electron-vite 5.x: externalizeDepsPlugin() was removed; use externalizeDeps: true
 * in the build options instead — it instructs Rolldown to leave Node.js and Electron
 * imports as runtime requires rather than inlining them.
 *
 * Vite 8.x / electron-vite 5.x: rollupOptions key is unchanged — the public config
 * API was kept stable even though Rolldown is now the internal bundler.
 */

import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      /**
       * externalizeDeps: true keeps electron, node:* builtins, and all node_modules
       * out of the main process bundle — they are loaded at runtime by Node.js, which
       * is the correct behavior for the Electron main process.
       */
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },

  preload: {
    build: {
      /**
       * The preload script runs in a privileged context with Node.js access.
       * Externalizing keeps electron's ipcRenderer/contextBridge as runtime imports.
       */
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
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
