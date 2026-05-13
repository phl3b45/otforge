import { ClassicLevel } from 'classic-level'
import { join } from 'path'
import type { ICSLabScenario } from '@ics-sim/schema'

let _db: ClassicLevel<string, string> | null = null

export function initDb(userDataPath: string): ClassicLevel<string, string> {
  if (_db) return _db
  _db = new ClassicLevel<string, string>(join(userDataPath, 'db'), {
    keyEncoding: 'utf8',
    valueEncoding: 'utf8'
  })
  return _db
}

export function getDb(): ClassicLevel<string, string> {
  if (!_db) throw new Error('Database not initialized — call initDb first')
  return _db
}

// ── Typed helpers ──────────────────────────────────────────────────────────────

export async function saveActiveScenario(scenario: ICSLabScenario): Promise<void> {
  await getDb().put('active-scenario', JSON.stringify(scenario))
}

export async function loadActiveScenario(): Promise<ICSLabScenario | null> {
  try {
    const raw = await getDb().get('active-scenario')
    return JSON.parse(raw) as ICSLabScenario
  } catch {
    return null
  }
}

export async function clearActiveScenario(): Promise<void> {
  try {
    await getDb().del('active-scenario')
  } catch {
    // key may not exist — that's fine
  }
}

export async function saveSetting(key: string, value: unknown): Promise<void> {
  await getDb().put(`setting:${key}`, JSON.stringify(value))
}

export async function loadSetting<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const raw = await getDb().get(`setting:${key}`)
    return JSON.parse(raw) as T
  } catch {
    return defaultValue
  }
}
