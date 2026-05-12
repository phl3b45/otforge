import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  DockerStatus,
  ScenarioImportResult,
  ScenarioExportResult,
  ScenarioExportOptions,
  SimulationStartResult,
  SimulationStopResult,
  ContainerStatus,
  LicenseValidationResult,
  ICSLabScenario
} from '@ics-sim/schema'

// Expose strongly-typed IPC API to renderer via contextBridge.
// Renderer accesses this via window.electronAPI — never via ipcRenderer directly.
const api = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', { url })
  },

  docker: {
    check: (): Promise<DockerStatus> => ipcRenderer.invoke('docker:check'),
    version: (): Promise<string> => ipcRenderer.invoke('docker:version')
  },

  scenario: {
    import: (): Promise<ScenarioImportResult> => ipcRenderer.invoke('scenario:import'),
    export: (scenario: ICSLabScenario, options: ScenarioExportOptions): Promise<ScenarioExportResult> =>
      ipcRenderer.invoke('scenario:export', { scenario, options }),
    validate: (scenario: ICSLabScenario): Promise<{ valid: boolean; errors: string[] }> =>
      ipcRenderer.invoke('scenario:validate', scenario)
  },

  simulation: {
    start: (scenario: ICSLabScenario): Promise<SimulationStartResult> =>
      ipcRenderer.invoke('simulation:start', scenario),
    stop: (): Promise<SimulationStopResult> => ipcRenderer.invoke('simulation:stop'),
    status: (): Promise<ContainerStatus[]> => ipcRenderer.invoke('simulation:status')
  },

  license: {
    validate: (key: string): Promise<LicenseValidationResult> =>
      ipcRenderer.invoke('license:validate', { key }),
    info: (): Promise<LicenseValidationResult> => ipcRenderer.invoke('license:info')
  },

  // One-way events from main process to renderer
  on: {
    containerStatusUpdate: (cb: (status: ContainerStatus) => void) => {
      ipcRenderer.on('container:statusUpdate', (_event, status) => cb(status))
      return () => ipcRenderer.removeAllListeners('container:statusUpdate')
    },
    simulationLog: (cb: (log: { nodeId: string; level: string; message: string }) => void) => {
      ipcRenderer.on('simulation:log', (_event, log) => cb(log))
      return () => ipcRenderer.removeAllListeners('simulation:log')
    },
    dockerError: (cb: (err: { message: string }) => void) => {
      ipcRenderer.on('docker:error', (_event, err) => cb(err))
      return () => ipcRenderer.removeAllListeners('docker:error')
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
