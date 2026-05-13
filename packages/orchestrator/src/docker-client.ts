import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import type { ContainerStatus } from '@ics-sim/schema'

const execAsync = promisify(exec)

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

function buildEnv(): NodeJS.ProcessEnv {
  const extra = (DOCKER_PATHS[process.platform] ?? []).join(
    process.platform === 'win32' ? ';' : ':'
  )
  const sep = process.platform === 'win32' ? ';' : ':'
  return { ...process.env, PATH: `${extra}${sep}${process.env.PATH ?? ''}` }
}

async function run(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { env: buildEnv() })
}

export class DockerClient {
  private readonly workDir: string

  constructor(userDataPath: string) {
    this.workDir = join(userDataPath, 'scenarios')
  }

  async isAvailable(): Promise<boolean> {
    try {
      await run('docker version --format "{{.Server.Version}}"')
      return true
    } catch {
      return false
    }
  }

  // Write compose file and start all containers
  async startScenario(
    projectName: string,
    composeYaml: string
  ): Promise<{ ok: boolean; error?: string }> {
    const scenarioDir = join(this.workDir, projectName)
    const composeFile = join(scenarioDir, 'docker-compose.yml')

    try {
      await mkdir(scenarioDir, { recursive: true })
      await writeFile(composeFile, composeYaml, 'utf-8')
      await run(`docker compose -p ${projectName} -f "${composeFile}" up -d --remove-orphans`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  // Stop and remove all containers for a scenario
  async stopScenario(projectName: string): Promise<{ ok: boolean; error?: string }> {
    const composeFile = join(this.workDir, projectName, 'docker-compose.yml')
    try {
      await run(`docker compose -p ${projectName} -f "${composeFile}" down --volumes`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  // Remove compose files for a scenario (called after stop when cleaning up)
  async cleanScenario(projectName: string): Promise<void> {
    const scenarioDir = join(this.workDir, projectName)
    await rm(scenarioDir, { recursive: true, force: true })
  }

  // Return current container statuses for a running scenario
  async getStatus(projectName: string): Promise<ContainerStatus[]> {
    try {
      const { stdout } = await run(`docker compose -p ${projectName} ps --format json`)
      if (!stdout.trim()) return []

      // Docker Compose ps --format json outputs one JSON object per line
      const statuses: ContainerStatus[] = stdout
        .trim()
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const obj = JSON.parse(line) as { Name: string; State: string; Health: string }
          const health = mapDockerHealth(obj.Health)
          const entry: ContainerStatus = {
            nodeId: obj.Name.replace(`${projectName}-`, ''),
            containerId: obj.Name,
            status: mapDockerState(obj.State)
          }
          if (health !== undefined) entry.healthCheck = health
          return entry
        })
      return statuses
    } catch {
      return []
    }
  }

  // Pull latest images for a scenario's compose file
  async pullImages(projectName: string): Promise<{ ok: boolean; error?: string }> {
    const composeFile = join(this.workDir, projectName, 'docker-compose.yml')
    try {
      await run(`docker compose -p ${projectName} -f "${composeFile}" pull`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  composeFilePath(projectName: string): string {
    return join(this.workDir, projectName, 'docker-compose.yml')
  }
}

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

function mapDockerHealth(health: string): ContainerStatus['healthCheck'] {
  switch (health.toLowerCase()) {
    case 'healthy':
      return 'healthy'
    case 'unhealthy':
      return 'unhealthy'
    case 'starting':
      return 'starting'
    default:
      return undefined
  }
}
