/**
 * vitest.config.ts — Vitest configuration for the orchestrator package.
 *
 * The orchestrator is a CommonJS Node.js package (no browser APIs). All tests
 * run in a real Node environment so that os.freemem(), path resolution, and
 * js-yaml behave identically to how they do inside the Electron main process.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /** Pure Node.js environment — no jsdom, no browser globals. */
    environment: 'node',

    /**
     * Keep vitest globals off; tests import describe/it/expect/vi explicitly.
     * Explicit imports make it clear which test utilities are in scope and
     * prevent collisions with identically-named symbols in tested modules.
     */
    globals: false,

    /**
     * Isolate each test file in its own module context so that vi.spyOn mocks
     * in one file cannot bleed into another — especially important for the
     * os.freemem / os.totalmem spies in resource-estimator tests.
     */
    isolate: true
  }
})
