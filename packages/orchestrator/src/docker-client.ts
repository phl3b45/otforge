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

import { exec } from 'child_process'
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
   *   3. Check if any required container images are missing from the local cache.
   *   4. If images are missing, call `onPullNeeded()` so the renderer can show an
   *      "Importing Containers" overlay before the long docker pull begins.
   *   5. Run `docker compose up -d --remove-orphans` to launch all services.
   *      `--remove-orphans` removes containers from a previous run of the same
   *      project that are no longer defined in the new compose file.
   *
   * @param projectName  - Sanitized scenario name used as the Compose project name.
   *   Must match the Docker Compose project name constraint: lowercase alphanumeric + hyphen.
   * @param composeYaml  - Complete docker-compose.yml content as a YAML string.
   * @param onPullNeeded - Optional callback fired before a docker pull if at least one
   *   image is not already cached locally. Use to show a progress overlay in the UI.
   * @returns { ok: true } on success, { ok: false, error } on failure.
   */
  async startScenario(
    projectName: string,
    composeYaml: string,
    onPullNeeded?: () => void
  ): Promise<{ ok: boolean; error?: string }> {
    const scenarioDir = join(this.workDir, projectName)
    const composeFile = join(scenarioDir, 'docker-compose.yml')

    try {
      // recursive: true makes mkdir a no-op if the directory already exists
      await mkdir(scenarioDir, { recursive: true })
      await writeFile(composeFile, composeYaml, 'utf-8')

      // Pre-flight image check: if any images are not in the local Docker cache, the
      // `docker compose up` below will pull them before starting containers. Notify the
      // caller so the UI can show an "Importing Containers" overlay during the pull.
      if (onPullNeeded) {
        const missing = await this.anyImagesMissing(composeYaml)
        if (missing) onPullNeeded()
      }

      // --quiet-pull suppresses per-layer download progress lines from stderr.
      // Without it, pulling 10+ images on first launch generates 10–50 MB of
      // progress output that overflows maxBuffer even at 50 MB on slow connections.
      await run(
        `docker compose -p ${projectName} -f "${composeFile}" up -d --remove-orphans --quiet-pull`
      )
      return { ok: true }
    } catch (err) {
      // Tear down any partial state left by the failed `up` — containers, volumes,
      // and especially networks. Without this cleanup the subnet addresses remain
      // allocated and the next attempt fails with "Address already in use".
      // This runs best-effort: if the compose file was never written (e.g., mkdir
      // failed) the down command will also fail, which is fine — we just swallow it.
      try {
        await run(`docker compose -p ${projectName} -f "${composeFile}" down --volumes`)
      } catch {
        /* best-effort — ignore cleanup failures */
      }

      // Node.js exec errors include the raw command string + full stderr in .message,
      // but the useful failure reason is buried among docker compose lifecycle lines
      // ("Creating...", "Started...", "Stopping...", etc.). Extract it here.
      const execErr = err as Error & { stderr?: string; stdout?: string }

      // Prefer the raw stderr field (just daemon output) over .message (includes
      // the full command string and all lifecycle noise).
      const rawStderr = execErr.stderr ?? execErr.message

      // Write the complete output to a log file for advanced diagnostics.
      // Path is shown in the error message so users know where to look.
      const logPath = join(scenarioDir, 'compose-error.log')
      try {
        const logContent =
          `=== docker compose up stderr ===\n${rawStderr}\n\n` +
          `=== docker compose up stdout ===\n${execErr.stdout ?? '(none)'}\n`
        await writeFile(logPath, logContent, 'utf-8')
      } catch {
        /* log write failure is non-fatal */
      }

      // Extract the lines that contain the actual failure reason.
      // Docker daemon error messages always start with "Error" or contain
      // "failed", "invalid", "cannot", "denied", "unauthorized", "no such".
      const errorLines = rawStderr
        .split('\n')
        .map(l => l.trim())
        .filter(l => /error|failed|cannot|invalid|denied|unauthorized|no such/i.test(l))
        .filter(Boolean)
        // Deduplicate — docker compose sometimes repeats the same error per service
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
   * Checks whether any Docker images referenced by a compose YAML are missing from
   * the local image cache. Used as a pre-flight check before `docker compose up` so
   * the UI can show a "Pulling images" notification before the long network operation.
   *
   * Image names are extracted from the YAML using a regex that matches `image:` lines
   * at the service level (indented 4+ spaces). This is intentionally simple — it
   * handles the standard indentation produced by compose-generator.ts. Templated
   * image names (with `${VAR}`) are skipped since they cannot be inspected directly.
   *
   * @param composeYaml - Complete docker-compose.yml content as a YAML string.
   * @returns true if at least one referenced image is not in the local cache.
   */
  private async anyImagesMissing(composeYaml: string): Promise<boolean> {
    // Match lines like "    image: ghcr.io/foo/bar:latest" (4+ spaces of indentation)
    const imageRegex = /^\s{4,}image:\s+(.+?)(?:\s*#.*)?$/gm
    const images: string[] = []
    let match: RegExpExecArray | null
    while ((match = imageRegex.exec(composeYaml)) !== null) {
      const imageName = match[1].trim()
      // Skip template-style names; they can't be inspected without variable expansion
      if (!imageName.includes('${') && imageName.length > 0) {
        images.push(imageName)
      }
    }

    for (const image of images) {
      try {
        // `docker image inspect` exits with 1 if the image is not local; exits 0 if present.
        await run(`docker image inspect --format "{{.Id}}" "${image}"`)
      } catch {
        return true // found at least one missing image
      }
    }
    return false
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
      await run(`docker compose -p ${projectName} -f "${composeFile}" down --volumes`)
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
