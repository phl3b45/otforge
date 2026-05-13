import os from 'os'
import type { ICSLabScenario, ResourceEstimate } from '@ics-sim/schema'

// Per-container RAM budgets in MB
const RAM_DEVICE = 80 // each simulated device (PLC, RTU, sensor, etc.)
const RAM_OPENPLC = 128 // PLC devices run OpenPLC Runtime — slightly heavier
const RAM_SURICATA = 150
const RAM_ZEEK = 150
const RAM_INFLUXDB = 200
const RAM_GRAFANA = 150
const RAM_LOKI = 80
const RAM_FUXA = 100
const RAM_FIREWALL = 20
const RAM_ATTACK = 512 // Kali base image

const FIXED_INFRA_RAM =
  RAM_SURICATA + RAM_ZEEK + RAM_INFLUXDB + RAM_GRAFANA + RAM_LOKI + RAM_FUXA + RAM_FIREWALL

export function estimateResources(scenario: ICSLabScenario): ResourceEstimate {
  const devices = Object.values(scenario.devices.devices)
  const containerCount = devices.length

  const deviceRam = devices.reduce((total, device) => {
    return total + (device.category === 'plc' ? RAM_OPENPLC : RAM_DEVICE)
  }, 0)

  const hasAttackMachine = devices.some(d => d.category === 'attack-machine')
  const attackRam = hasAttackMachine ? RAM_ATTACK : 0

  const estimatedRamMb = deviceRam + FIXED_INFRA_RAM + attackRam
  const estimatedCpuCores = Math.max(1, Math.ceil(containerCount / 5))

  // Fixed infra containers: Suricata, Zeek, InfluxDB, Grafana, Loki, FUXA, firewall
  const totalContainers = containerCount + 7 + (hasAttackMachine ? 0 : 0)

  return { estimatedRamMb, estimatedCpuCores, containerCount: totalContainers }
}

export interface SystemMemory {
  totalMb: number
  freeMb: number
  sufficientForScenario: boolean
  warningThreshold: boolean // true if estimated > 60% of free RAM
  criticalThreshold: boolean // true if estimated > 85% of free RAM
}

export function checkSystemMemory(estimate: ResourceEstimate): SystemMemory {
  const totalMb = Math.round(os.totalmem() / 1024 / 1024)
  const freeMb = Math.round(os.freemem() / 1024 / 1024)
  const ratio = estimate.estimatedRamMb / freeMb

  return {
    totalMb,
    freeMb,
    sufficientForScenario: ratio < 0.85,
    warningThreshold: ratio >= 0.6,
    criticalThreshold: ratio >= 0.85
  }
}
