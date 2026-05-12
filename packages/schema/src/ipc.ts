// Typed IPC channel definitions — the contract between Electron main process and renderer.
// All channels use ipcMain.handle / ipcRenderer.invoke (request-response pattern).
// Event channels (one-way push from main) use the 'on:' prefix.

import type { ICSLabScenario, ResourceEstimate } from './icslab'

// ── Request / Response types ───────────────────────────────────────────────────

export interface DockerStatus {
  available: boolean
  version?: string
  message?: string
}

export interface ScenarioImportResult {
  ok: boolean
  scenario?: ICSLabScenario
  error?: string
  resourceEstimate?: ResourceEstimate
}

export interface ScenarioExportOptions {
  locked: boolean
  filePath?: string   // if omitted, opens save dialog
}

export interface ScenarioExportResult {
  ok: boolean
  filePath?: string
  error?: string
}

export interface SimulationStartResult {
  ok: boolean
  error?: string
  containersStarted?: string[]
}

export interface SimulationStopResult {
  ok: boolean
  error?: string
}

export interface ContainerStatus {
  nodeId: string
  containerId?: string
  status: 'running' | 'stopped' | 'error' | 'starting'
  healthCheck?: 'healthy' | 'unhealthy' | 'starting'
}

export interface LicenseValidationResult {
  valid: boolean
  userId?: string
  packScopes?: string[]
  expiresAt?: string
  error?: string
}

export interface AppInfo {
  version: string
  nodeVersion: string
  electronVersion: string
  platform: 'win32' | 'darwin' | 'linux'
}

// ── IPC Channel map ────────────────────────────────────────────────────────────
// Keyed by channel name. Value is [RequestArgs, ResponseType].
// Used to type contextBridge exposure and ipcMain.handle registration.

export interface IPCChannels {
  // Docker
  'docker:check': [void, DockerStatus]
  'docker:version': [void, string]

  // Scenario management
  'scenario:import': [void, ScenarioImportResult]
  'scenario:export': [{ scenario: ICSLabScenario; options: ScenarioExportOptions }, ScenarioExportResult]
  'scenario:validate': [ICSLabScenario, { valid: boolean; errors: string[] }]

  // Simulation lifecycle
  'simulation:start': [ICSLabScenario, SimulationStartResult]
  'simulation:stop': [void, SimulationStopResult]
  'simulation:status': [void, ContainerStatus[]]

  // License
  'license:validate': [{ key: string }, LicenseValidationResult]
  'license:info': [void, LicenseValidationResult]

  // App
  'app:info': [void, AppInfo]
  'app:openExternal': [{ url: string }, void]
}

// ── One-way event channels (main → renderer) ───────────────────────────────────

export interface IPCEvents {
  'container:statusUpdate': ContainerStatus
  'simulation:log': { nodeId: string; level: 'info' | 'warn' | 'error'; message: string }
  'docker:error': { message: string }
}

// Helper types for consumers
export type IPCChannelName = keyof IPCChannels
export type IPCEventName = keyof IPCEvents
export type IPCRequest<K extends IPCChannelName> = IPCChannels[K][0]
export type IPCResponse<K extends IPCChannelName> = IPCChannels[K][1]
