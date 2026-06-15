/**
 * docker-client.ts — Thin wrapper around the Docker Compose CLI.
 *
 * The OTForge runs each scenario as a set of Docker containers defined by
 * a generated docker-compose.yml. This module encapsulates every `docker compose`
 * command so the rest of the codebase never constructs raw shell strings.
 *
 * Design decisions:
 *   - All commands run through `execAsync` with a custom PATH that includes the
 *     Docker Desktop binary directories. Electron inherits a stripped launcher PATH,
 *     so Docker is not on PATH by default on Windows.
 *   - Compose files are written to `<userData>/scenarios/<projectName>/docker-compose.yml`
 *     so each scenario has its own isolated directory. This allows multiple distinct
 *     scenario compose files to coexist without collision.
 *   - `docker compose ps --format json` outputs one JSON object per stdout line
 *     (newline-delimited JSON), not a JSON array. Parsing is done line-by-line.
 *
 * Usage:
 *   const client = new DockerClient(app.getPath('userData'))
 *   await client.startScenario(projectName, composeYaml)
 *   const statuses = await client.getStatus(projectName)
 *   await client.stopScenario(projectName)
 */

import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import type { ContainerStatus } from '@otforge/schema'

const execAsync = promisify(exec)

/**
 * Platform-specific directories where the Docker CLI binary may be installed.
 *
 * Electron apps launched from the desktop icon inherit a minimal PATH that
 * typically excludes Docker Desktop's binary directory on Windows. These paths
 * are prepended to every `docker` invocation to guarantee the binary is found.
 */
const DOCKER_PATHS: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Docker\\Docker\\resources\\bin',
    'C:\\ProgramData\\DockerDesktop\\version-bin'
  ],
  darwin: [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/Applications/Docker.app/Contents/Resources/bin'
  ],
  linux: ['/usr/bin', '/usr/local/bin']
}

/**
 * Constructs a process environment with Docker binary directories prepended to PATH.
 *
 * @returns A copy of process.env with Docker paths at the front so `docker compose`
 *   resolves correctly on all platforms regardless of how the app was launched.
 */
function buildEnv(): NodeJS.ProcessEnv {
  const extra = (DOCKER_PATHS[process.platform] ?? []).join(
    process.platform === 'win32' ? ';' : ':'
  )
  const sep = process.platform === 'win32' ? ';' : ':'
  return { ...process.env, PATH: `${extra}${sep}${process.env.PATH ?? ''}` }
}

/**
 * Runs a shell command with the augmented Docker PATH environment.
 *
 * maxBuffer is set to 50 MB (vs the Node.js default of 1 MB) because
 * `docker compose up` writes layer-download progress to stderr during the
 * first image pull of a scenario. Each image can produce hundreds of lines
 * of "Pulling layer … / Pull complete" output; across 10+ images the combined
 * stderr easily exceeds the default limit and throws "maxBuffer length exceeded".
 *
 * @param cmd - The shell command string to execute.
 * @returns stdout and stderr strings from the command.
 * @throws If the command exits with a non-zero status.
 */
async function run(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { env: buildEnv(), maxBuffer: 50 * 1024 * 1024 })
}

/**
 * DockerClient wraps Docker Compose CLI operations for a single scenario.
 *
 * Each scenario gets its own subdirectory under `<userData>/scenarios/` containing
 * the generated docker-compose.yml. The Docker Compose project name scopes all
 * container, network, and volume names to that scenario, allowing multiple compose
 * environments to coexist on the same machine without name collisions.
 */
export class DockerClient {
  /** Absolute path to the directory where per-scenario subdirectories are created. */
  private readonly workDir: string

  /**
   * @param userDataPath - Electron's app.getPath('userData') directory.
   *   On Windows: %APPDATA%\otforge
   *   On macOS:   ~/Library/Application Support/otforge
   */
  constructor(userDataPath: string) {
    this.workDir = join(userDataPath, 'scenarios')
  }

  /**
   * Checks whether the Docker daemon is running by running `docker version`.
   *
   * @returns true if the daemon responds, false if Docker is not installed or not running.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await run('docker version --format "{{.Server.Version}}"')
      return true
    } catch {
      return false
    }
  }

  /**
   * Writes a docker-compose.yml for the scenario and starts all containers.
   *
   * Steps:
   *   1. Create `<workDir>/<projectName>/` if it does not exist.
   *   2. Write the YAML string as `docker-compose.yml` in that directory.
   *   3. Fire `onPullNeeded()` so the renderer shows an "Importing Containers" overlay
   *      before the compose up begins (always — we always pull latest images).
   *   4. Run `docker compose up --pull always -d --remove-orphans` to launch all services.
   *      `--pull always` checks GHCR on every start and downloads any updated layers,
   *      ensuring students always run the newest container images without a manual pull.
   *      `--remove-orphans` removes containers from a previous run of the same
   *      project that are no longer defined in the new compose file.
   *
   * @param projectName  - Sanitized scenario name used as the Compose project name.
   *   Must match the Docker Compose project name constraint: lowercase alphanumeric + hyphen.
   * @param composeYaml  - Complete docker-compose.yml content as a YAML string.
   * @param onPullNeeded - Optional callback fired before compose up begins. Use to show
   *   a progress overlay in the UI during the image pull / digest check.
   * @returns { ok: true } on success, { ok: false, error } on failure.
   */
  async startScenario(
    projectName: string,
    composeYaml: string,
    onPullNeeded?: () => void,
    onProgress?: (line: string) => void
  ): Promise<{ ok: boolean; error?: string }> {
    const scenarioDir = join(this.workDir, projectName)
    const composeFile = join(scenarioDir, 'docker-compose.yml')

    try {
      // recursive: true makes mkdir a no-op if the directory already exists
      await mkdir(scenarioDir, { recursive: true })
      await writeFile(composeFile, composeYaml, 'utf-8')

      // Start containers, streaming output so we can detect whether Docker is
      // actually pulling any images. onPullNeeded fires only when a "Pulling"
      // line appears — so the overlay is shown only when a download is in progress,
      // not on every start when all images are already cached locally.
      await this._composeUp(projectName, composeFile, onPullNeeded, onProgress)

      // Prune <none>:<none> dangling images left whenever Docker replaces an old
      // image digest with a newer pull. Best-effort — prune failure must not abort
      // a successful simulation start.
      try {
        await run('docker image prune -f')
      } catch {
        /* best-effort */
      }
      return { ok: true }
    } catch (err) {
      // Tear down any partial state left by the failed `up` — containers, volumes,
      // and especially networks. Without this cleanup the subnet addresses remain
      // allocated and the next attempt fails with "Address already in use".
      try {
        // codeql[js/shell-command-constructed-from-input] -- projectName is sanitized to [a-z0-9-] by toProjectName()
        await run(`docker compose -p ${projectName} -f "${composeFile}" down --volumes`)
      } catch {
        /* best-effort */
      }

      // _composeUp attaches collected output to the error as _composeOutput so we
      // can write it to a log without relying on execAsync's stderr field.
      const composeErr = err as Error & { _composeOutput?: string }
      const rawOutput = composeErr._composeOutput ?? composeErr.message

      const logPath = join(scenarioDir, 'compose-error.log')
      try {
        await writeFile(logPath, rawOutput, 'utf-8')
      } catch {
        /* log write failure is non-fatal */
      }

      const errorLines = rawOutput
        .split('\n')
        .map(l => l.trim())
        .filter(l => /error|failed|cannot|invalid|denied|unauthorized|no such/i.test(l))
        .filter(Boolean)
        .filter((l, i, arr) => arr.indexOf(l) === i)
        .slice(0, 8)

      const shortError =
        errorLines.length > 0
          ? errorLines.join('\n')
          : `docker compose exited with an error. Full log: ${logPath}`

      return { ok: false, error: shortError }
    }
  }

  /**
   * Runs `docker compose up --pull always` via spawn so output can be streamed
   * line-by-line. This avoids the maxBuffer limit of execAsync and lets the caller
   * detect when Docker actually starts pulling images (rather than just checking
   * digests), so the "Updating Images" overlay is shown only when a download is
   * in progress.
   *
   * onPullNeeded fires at most once, when the first line containing "Pulling"
   * appears. If all images are already current Docker only prints container-start
   * lines and onPullNeeded never fires — no overlay is shown.
   */
  private _composeUp(
    projectName: string,
    composeFile: string,
    onPullNeeded?: () => void,
    onProgress?: (line: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let pullNotified = false
      const allLines: string[] = []

      const child = spawn(
        'docker',
        [
          'compose',
          '-p',
          projectName,
          '-f',
          composeFile,
          'up',
          '--pull',
          'always',
          '-d',
          '--remove-orphans'
        ],
        { env: buildEnv() }
      )

      const processChunk = (buf: Buffer): void => {
        // Docker uses \r to overwrite progress lines in-place on a TTY.
        // Replace \r with \n so we split on both.
        buf
          .toString()
          .replace(/\r/g, '\n')
          .split('\n')
          .forEach(raw => {
            // Strip ANSI escape sequences before forwarding to the renderer.
            // eslint-disable-next-line no-control-regex
            const line = raw.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').trim()
            if (!line) return

            allLines.push(line)
            onProgress?.(line)

            // Fire onPullNeeded only once — when Docker first reports it is
            // actually downloading an image layer, not just checking the digest.
            if (!pullNotified && /pulling/i.test(line)) {
              pullNotified = true
              onPullNeeded?.()
            }
          })
      }

      child.stdout?.on('data', processChunk)
      child.stderr?.on('data', processChunk)

      child.on('close', code => {
        if (code === 0) {
          resolve()
        } else {
          const e = new Error(`docker compose up exited with code ${code}`) as Error & {
            _composeOutput: string
          }
          e._composeOutput = allLines.join('\n')
          reject(e)
        }
      })

      child.on('error', reject)
    })
  }

  /**
   * Stops and removes all containers, networks, and volumes for a scenario.
   *
   * Runs `docker compose down --volumes` which:
   *   - Stops all running services
   *   - Removes containers
   *   - Removes the Docker networks created by the compose file
   *   - Removes named and anonymous volumes (clears historian data, log files, etc.)
   *
   * @param projectName - The Compose project name used when the scenario was started.
   * @returns { ok: true } on success, { ok: false, error } on failure.
   */
  async stopScenario(projectName: string): Promise<{ ok: boolean; error?: string }> {
    const composeFile = join(this.workDir, projectName, 'docker-compose.yml')
    try {
      // codeql[js/shell-command-constructed-from-input] -- projectName is sanitized to [a-z0-9-] by toProjectName()
      await run(`docker compose -p ${projectName} -f "${composeFile}" down --volumes`)
      // Remove dangling images (<none>:<none>) left by --pull always on each start.
      // When Docker pulls a newer digest for a tagged image it untags the old one,
      // producing a dangling layer that consumes real disk space but is unreachable
      // by name. Best-effort — if prune fails (e.g. another compose is running) the
      // simulation stop itself still succeeds.
      try {
        await run('docker image prune -f')
      } catch {
        /* best-effort */
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * Deletes the scenario directory and its compose file from disk.
   *
   * Called after a successful stop when the project data is no longer needed.
   * Force-deletes so it succeeds even if the directory is partially empty.
   *
   * @param projectName - The Compose project name (directory name under workDir).
   */
  async cleanScenario(projectName: string): Promise<void> {
    const scenarioDir = join(this.workDir, projectName)
    await rm(scenarioDir, { recursive: true, force: true })
  }

  /**
   * Polls the current state and health of all containers in a running scenario.
   *
   * Parses the newline-delimited JSON output of `docker compose ps --format json`.
   * Each line is a separate JSON object with Name, State, and Health fields.
   *
   * Docker health states: healthy | unhealthy | starting | "" (no health check configured)
   * Docker container states: running | exited | dead | created | starting
   *
   * @param projectName - The Compose project name to query.
   * @returns Array of ContainerStatus objects, empty if the project is not running.
   */
  async getStatus(projectName: string): Promise<ContainerStatus[]> {
    try {
      // codeql[js/shell-command-constructed-from-input] -- projectName is sanitized to [a-z0-9-] by toProjectName()
      const { stdout } = await run(`docker compose -p ${projectName} ps --format json`)
      if (!stdout.trim()) return []

      // Docker Compose ps --format json outputs one JSON object per line (not a JSON array)
      const statuses: ContainerStatus[] = stdout
        .trim()
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const obj = JSON.parse(line) as { Name: string; State: string; Health: string }
          const health = mapDockerHealth(obj.Health)
          // Strip the project name prefix Docker adds to container names (e.g., "otforge-demo-plc-1" → "plc-1")
          const entry: ContainerStatus = {
            nodeId: obj.Name.replace(`${projectName}-`, ''),
            containerId: obj.Name,
            status: mapDockerState(obj.State)
          }
          // healthCheck is an optional field — only set it when Docker reports a health state
          if (health !== undefined) entry.healthCheck = health
          return entry
        })
      return statuses
    } catch {
      // Compose project not found or docker not running — return empty rather than throwing
      return []
    }
  }

  /**
   * Pulls the latest images for all services defined in a scenario's compose file.
   *
   * Used before starting a simulation to ensure GHCR images are up to date.
   * Not called automatically on start — the UI can offer a "Pull latest" action.
   *
   * @param projectName - The Compose project name whose compose file to read.
   * @returns { ok: true } on success, { ok: false, error } on failure.
   */
  async pullImages(projectName: string): Promise<{ ok: boolean; error?: string }> {
    const composeFile = join(this.workDir, projectName, 'docker-compose.yml')
    try {
      // codeql[js/shell-command-constructed-from-input] -- projectName is sanitized to [a-z0-9-] by toProjectName()
      await run(`docker compose -p ${projectName} -f "${composeFile}" pull`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * Returns the absolute path to a scenario's docker-compose.yml file.
   *
   * @param projectName - The Compose project name.
   * @returns Absolute file path (may not exist if the scenario hasn't been started).
   */
  composeFilePath(projectName: string): string {
    return join(this.workDir, projectName, 'docker-compose.yml')
  }
}

/**
 * Maps Docker container state strings to the ContainerStatus.status union type.
 *
 * Docker reports lowercase state names. "exited" and "dead" both indicate an
 * error condition (the container stopped unexpectedly). "created" and "starting"
 * indicate the container has been scheduled but hasn't entered the running state.
 *
 * @param state - Raw state string from `docker compose ps`.
 * @returns Mapped ContainerStatus status value.
 */
function mapDockerState(state: string): ContainerStatus['status'] {
  switch (state.toLowerCase()) {
    case 'running':
      return 'running'
    case 'exited':
    case 'dead':
      return 'error'
    case 'created':
    case 'starting':
      return 'starting'
    default:
      return 'stopped'
  }
}

/**
 * Maps Docker health check strings to the ContainerStatus.healthCheck union type.
 *
 * Returns undefined (not null) when no health check is configured — the schema
 * uses `healthCheck?: string` so undefined means "field absent", which is the
 * correct representation for containers without a HEALTHCHECK directive.
 *
 * @param health - Raw health string from `docker compose ps` ("healthy", "unhealthy",
 *   "starting", or "" when no health check is defined).
 * @returns Mapped health string or undefined.
 */
function mapDockerHealth(health: string): ContainerStatus['healthCheck'] {
  switch (health.toLowerCase()) {
    case 'healthy':
      return 'healthy'
    case 'unhealthy':
      return 'unhealthy'
    case 'starting':
      return 'starting'
    default:
      // Empty string means the container has no HEALTHCHECK instruction
      return undefined
  }
}
