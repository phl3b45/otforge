/**
 * sessions.ts — On-disk store for saved student "sessions".
 *
 * A session lets a student stop a lab and resume it later without redoing their
 * work. Each session is a directory under `<userData>/sessions/<projectName>/`
 * containing `session.json` — the scenario (which carries their edited Suricata/
 * firewall rules) plus the tutorial step they were on. A later increment also
 * drops the student's `Lab_NN_Student_Saved_Work` folder tarball into this same
 * directory, which is why a session is a directory rather than a single file.
 *
 * Keyed by the sanitized scenario name (the same value used as the Docker Compose
 * project name), so saving the same lab again overwrites its one session —
 * "resume my Lab 03" rather than an ever-growing pile of timestamped saves.
 */

import { mkdir, writeFile, readFile, readdir } from 'fs/promises'
import { join } from 'path'
import type { OTForgeScenario, SessionSummary } from '@otforge/schema'

/** Full on-disk session payload. Extends the summary with the scenario itself. */
export interface StoredSession extends SessionSummary {
  scenario: OTForgeScenario
}

/** Absolute path to the sessions root directory. */
function sessionsRoot(userDataPath: string): string {
  return join(userDataPath, 'sessions')
}

/** Absolute path to a single session's directory. */
export function sessionDir(userDataPath: string, projectName: string): string {
  return join(sessionsRoot(userDataPath), projectName)
}

/**
 * Writes (or overwrites) a session for a scenario.
 *
 * @param userDataPath - Electron userData directory.
 * @param session - The full session payload to persist.
 */
export async function saveSession(userDataPath: string, session: StoredSession): Promise<void> {
  const dir = sessionDir(userDataPath, session.projectName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.json'), JSON.stringify(session), 'utf-8')
}

/**
 * Reads a single session by project name.
 *
 * @returns The stored session, or null if none is saved for that project.
 */
export async function loadSession(
  userDataPath: string,
  projectName: string
): Promise<StoredSession | null> {
  try {
    const raw = await readFile(join(sessionDir(userDataPath, projectName), 'session.json'), 'utf-8')
    return JSON.parse(raw) as StoredSession
  } catch {
    // Missing file/dir (never saved) is expected — not an error.
    return null
  }
}

/**
 * Lists all saved sessions as lightweight summaries (no scenario payload),
 * newest first. Malformed or partial session directories are skipped.
 */
export async function listSessions(userDataPath: string): Promise<SessionSummary[]> {
  let entries: string[]
  try {
    entries = await readdir(sessionsRoot(userDataPath))
  } catch {
    // Sessions root doesn't exist yet — no sessions saved.
    return []
  }

  const summaries: SessionSummary[] = []
  for (const name of entries) {
    const session = await loadSession(userDataPath, name)
    if (!session) continue
    summaries.push({
      projectName: session.projectName,
      scenarioName: session.scenarioName,
      savedAt: session.savedAt,
      tutorialStep: session.tutorialStep
    })
  }

  // Newest first so the picker surfaces the most recent work at the top.
  summaries.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  return summaries
}
