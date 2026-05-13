/**
 * db.ts — LevelDB persistence layer for the Electron main process.
 *
 * Uses `classic-level` (the CommonJS-compatible fork of LevelDB) to store
 * scenario state and user settings across app restarts. The database lives
 * inside Electron's userData directory so it survives application updates
 * without needing user migration steps.
 *
 * All values are JSON-serialized to string before writing, so the key/value
 * types are always <string, string> at the LevelDB level — deserialization
 * happens in the typed helpers below.
 *
 * Access pattern:
 *   1. Call initDb(userData) once in app.whenReady().
 *   2. Use the typed helpers (saveActiveScenario, loadSetting, etc.) everywhere else.
 *   3. Never call getDb() from the renderer — it runs in the main process only.
 */

import { ClassicLevel } from 'classic-level'
import { join } from 'path'
import type { ICSLabScenario } from '@ics-sim/schema'

/** Singleton LevelDB instance — initialized once on app startup. */
let _db: ClassicLevel<string, string> | null = null

/**
 * Opens (or re-uses) the LevelDB database stored in `userDataPath/db/`.
 *
 * @param userDataPath - Electron's app.getPath('userData') directory.
 *   On Windows this is typically %APPDATA%\ics-simulator.
 * @returns The open ClassicLevel instance (also stored as a module singleton).
 */
export function initDb(userDataPath: string): ClassicLevel<string, string> {
  if (_db) return _db
  _db = new ClassicLevel<string, string>(join(userDataPath, 'db'), {
    keyEncoding: 'utf8',
    valueEncoding: 'utf8'
  })
  return _db
}

/**
 * Returns the open database instance.
 *
 * @throws If initDb() has not been called first.
 */
export function getDb(): ClassicLevel<string, string> {
  if (!_db) throw new Error('Database not initialized — call initDb first')
  return _db
}

// ── Scenario persistence ───────────────────────────────────────────────────────
// The "active scenario" is the last scenario the user imported or built.
// It is restored when the app reopens so work-in-progress is not lost.

/**
 * Persists the current scenario to LevelDB.
 * Called after import, after adding/removing devices, and before simulation start.
 *
 * @param scenario - The full ICSLabScenario object to persist.
 */
export async function saveActiveScenario(scenario: ICSLabScenario): Promise<void> {
  await getDb().put('active-scenario', JSON.stringify(scenario))
}

/**
 * Reads the last saved scenario from LevelDB.
 *
 * @returns The scenario if one was saved, or null if the key is absent
 *   (fresh install, or user deleted data).
 */
export async function loadActiveScenario(): Promise<ICSLabScenario | null> {
  try {
    const raw = await getDb().get('active-scenario')
    return JSON.parse(raw) as ICSLabScenario
  } catch {
    // LevelDB throws a NotFound error if the key does not exist — that is expected.
    return null
  }
}

/**
 * Removes the active scenario entry from LevelDB.
 * Called when simulation stops so the next launch starts clean.
 */
export async function clearActiveScenario(): Promise<void> {
  try {
    await getDb().del('active-scenario')
  } catch {
    // Deleting a non-existent key is fine — nothing to do.
  }
}

// ── Generic settings store ─────────────────────────────────────────────────────
// Key-value store for user preferences (e.g. last-used directory, UI state).
// Keys are namespaced under "setting:" to avoid collision with scenario data.

/**
 * Persists a typed setting value.
 *
 * @param key   - Setting name (e.g. "lastExportDir").
 * @param value - Any JSON-serializable value.
 */
export async function saveSetting(key: string, value: unknown): Promise<void> {
  await getDb().put(`setting:${key}`, JSON.stringify(value))
}

/**
 * Reads a typed setting value, returning a default if the key is absent.
 *
 * @param key          - Setting name.
 * @param defaultValue - Returned when the key has never been written.
 * @returns The stored value (deserialized), or defaultValue.
 */
export async function loadSetting<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const raw = await getDb().get(`setting:${key}`)
    return JSON.parse(raw) as T
  } catch {
    return defaultValue
  }
}
