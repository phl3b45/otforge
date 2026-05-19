/**
 * grafana-provisioning.ts — Writes Grafana and Promtail provisioning files to
 * the scenario directory before Docker Compose starts the simulation.
 *
 * Grafana supports file-based provisioning (datasources, dashboard providers,
 * and pre-built dashboard JSON) via the /etc/grafana/provisioning directory.
 * Compose mounts the files written here as read-only volumes into the Grafana
 * container so students see a fully-wired dashboard the moment the simulation
 * starts — no manual datasource configuration required.
 *
 * Promtail is the log-shipping sidecar that reads Suricata EVE JSON and Zeek
 * logs from their named volumes and pushes them to the Loki container. Without
 * Promtail, Loki would receive no data even though both Suricata and Zeek are
 * writing logs to disk.
 *
 * Directory structure written under <scenarioDir>:
 *
 *   grafana/
 *     provisioning/
 *       datasources/otflab.yaml   ← InfluxDB + Loki datasources (explicit UIDs)
 *       dashboards/otflab.yaml    ← File-based dashboard provider config
 *     dashboards/
 *       ics-overview.json         ← ICS Lab Overview dashboard (Suricata + Zeek)
 *   promtail/
 *     config.yaml                 ← Reads suricata-logs + zeek-logs, pushes to Loki
 *
 * IP addresses match the fixed system-service assignments in compose-generator.ts.
 * System services occupy .240–.249 so user devices (.10+) never collide with them:
 *   InfluxDB  → 10.200.20.240 : 8086  (Control zone, Level 3)
 *   Loki      → 10.200.20.241 : 3100  (Control zone, Level 3)
 *   Grafana   → 10.200.20.242 : 3000  (Control zone, Level 3)
 *   FUXA      → 10.200.20.243
 *   Promtail  → 10.200.20.244
 */

import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import yaml from 'js-yaml'
import { zoneIpPrefix } from './network-config'

/**
 * Default Control-zone prefix derived from ZONE_DEFAULTS.
 * Used when writeGrafanaProvisioning() is called without an explicit prefix override,
 * e.g., in unit tests that don't run subnet auto-detection.
 * The Control zone (Level 3) hosts InfluxDB, Loki, Grafana, FUXA, and Promtail.
 */
const DEFAULT_CONTROL_PREFIX = zoneIpPrefix('control')

/**
 * Writes all Grafana and Promtail provisioning files to the scenario directory.
 *
 * Safe to call multiple times — existing files are overwritten. The scenario
 * directory must exist before this function is called (created by DockerClient
 * before writing docker-compose.yml).
 *
 * @param scenarioDir    - Absolute path to <userData>/scenarios/<projectName>/.
 * @param projectName    - Docker Compose project name (used for Promtail volume refs).
 * @param controlSubnetPrefix - Optional override for the Control-zone (Level 3) subnet prefix
 *   (e.g., "10.201.20" when subnet auto-detection picked 10.201.20.0/24 instead
 *   of the default 10.200.20.0/24). InfluxDB is always .240 and Loki always .241
 *   within this prefix. Defaults to DEFAULT_CONTROL_PREFIX when omitted.
 */
export async function writeGrafanaProvisioning(
  scenarioDir: string,
  projectName: string,
  controlSubnetPrefix?: string
): Promise<void> {
  // Resolve the effective Control-zone prefix — use the caller-supplied resolved value when
  // subnet auto-detection chose a non-default range, otherwise use the static default.
  const controlPrefix = controlSubnetPrefix ?? DEFAULT_CONTROL_PREFIX
  // .240–.249 are reserved for system services; user devices start at .10
  const INFLUXDB_IP = `${controlPrefix}.240`
  const LOKI_IP = `${controlPrefix}.241`
  // ── Create directory tree ───────────────────────────────────────────────────
  const grafanaDatasourcesDir = join(scenarioDir, 'grafana', 'provisioning', 'datasources')
  const grafanaDashboardsProvDir = join(scenarioDir, 'grafana', 'provisioning', 'dashboards')
  const grafanaDashboardsDir = join(scenarioDir, 'grafana', 'dashboards')
  const promtailDir = join(scenarioDir, 'promtail')

  await Promise.all([
    mkdir(grafanaDatasourcesDir, { recursive: true }),
    mkdir(grafanaDashboardsProvDir, { recursive: true }),
    mkdir(grafanaDashboardsDir, { recursive: true }),
    mkdir(promtailDir, { recursive: true })
  ])

  // ── Grafana datasource provisioning ────────────────────────────────────────
  // Explicit UIDs are required so the dashboard JSON can reference them by a
  // known value. Without explicit UIDs, Grafana auto-generates them and the
  // dashboard JSON would have non-matching references.
  const datasources = {
    apiVersion: 1,
    datasources: [
      {
        name: 'InfluxDB',
        uid: 'otflab-influxdb',
        type: 'influxdb',
        url: `http://${INFLUXDB_IP}:8086`,
        database: 'otflab',
        isDefault: true,
        editable: true,
        jsonData: { httpMode: 'GET' }
      },
      {
        name: 'Loki',
        uid: 'otflab-loki',
        type: 'loki',
        url: `http://${LOKI_IP}:3100`,
        isDefault: false,
        editable: true
      }
    ]
  }
  await writeFile(join(grafanaDatasourcesDir, 'otflab.yaml'), yaml.dump(datasources), 'utf-8')

  // ── Grafana dashboard provider provisioning ─────────────────────────────────
  // Tells Grafana to watch /var/lib/grafana/dashboards (the volume-mounted dir)
  // for JSON dashboard files and refresh every 30 seconds.
  const dashboardProvider = {
    apiVersion: 1,
    providers: [
      {
        name: 'ICS Lab',
        orgId: 1,
        type: 'file',
        disableDeletion: false,
        updateIntervalSeconds: 30,
        allowUiUpdates: true,
        options: {
          path: '/var/lib/grafana/dashboards',
          foldersFromFilesStructure: false
        }
      }
    ]
  }
  await writeFile(
    join(grafanaDashboardsProvDir, 'otflab.yaml'),
    yaml.dump(dashboardProvider),
    'utf-8'
  )

  // ── ICS Lab Overview dashboard JSON ────────────────────────────────────────
  // Two log panels: Suricata IPS alerts and Zeek network analysis.
  // Both panels target the provisioned Loki datasource (uid: otflab-loki).
  // LogQL expressions filter by the `job` label set by Promtail's scrape config.
  await writeFile(
    join(grafanaDashboardsDir, 'ics-overview.json'),
    JSON.stringify(buildIcsDashboard(), null, 2),
    'utf-8'
  )

  // ── Promtail configuration ─────────────────────────────────────────────────
  // Promtail reads Suricata EVE JSON and Zeek logs from named Docker volumes
  // (shared via compose volume mounts) and ships them to the Loki HTTP endpoint.
  //
  // Pipeline stages parse Suricata's EVE JSON to extract the event_type label
  // (e.g., "alert", "dns", "http") so students can filter in Grafana.
  //
  // The positions file tracks how far into each log file Promtail has read so
  // restarts don't re-ship old entries.
  const promtailConfig = {
    server: { http_listen_port: 9080, grpc_listen_port: 0 },
    positions: { filename: '/tmp/positions.yaml' },
    clients: [{ url: `http://${LOKI_IP}:3100/loki/api/v1/push` }],
    scrape_configs: [
      {
        job_name: 'suricata',
        static_configs: [
          {
            targets: ['localhost'],
            labels: {
              job: 'suricata',
              scenario: projectName,
              // Promtail __path__ selects files to tail
              __path__: '/var/log/suricata/eve.json'
            }
          }
        ],
        pipeline_stages: [
          // Parse the EVE JSON record to extract indexed fields
          {
            json: {
              expressions: {
                event_type: 'event_type',
                src_ip: 'src_ip',
                dest_ip: 'dest_ip',
                proto: 'proto'
              }
            }
          },
          // Promote parsed fields to Loki stream labels so they're queryable
          { labels: { event_type: '', proto: '' } }
        ]
      },
      {
        job_name: 'zeek',
        static_configs: [
          {
            targets: ['localhost'],
            labels: {
              job: 'zeek',
              scenario: projectName,
              __path__: '/var/log/zeek/current/*.log'
            }
          }
        ]
      }
    ]
  }
  await writeFile(join(promtailDir, 'config.yaml'), yaml.dump(promtailConfig), 'utf-8')
}

/**
 * Builds the ICS Lab Overview Grafana dashboard object.
 *
 * Returns a plain JavaScript object that can be JSON.stringify'd into a Grafana
 * dashboard JSON file. The dashboard uses Grafana v10 schema (schemaVersion: 38)
 * and references the provisioned Loki datasource by its explicit UID.
 *
 * Panels:
 *   1. Suricata Alerts — logs panel, LogQL `{job="suricata"} | json | event_type="alert"`
 *   2. Zeek Network Logs — logs panel, LogQL `{job="zeek"}`
 *
 * Both panels auto-refresh every 5 seconds and show the last 1 hour by default.
 */
function buildIcsDashboard(): object {
  /** Common datasource reference for all Loki panels. */
  const lokiDs = { type: 'loki', uid: 'otflab-loki' }

  /** Shared options for all log panels. */
  const logsOptions = {
    dedupStrategy: 'none',
    enableLogDetails: true,
    prettifyLogMessage: false,
    showLabels: true,
    showTime: true,
    sortOrder: 'Descending',
    wrapLogMessage: true
  }

  return {
    id: null,
    uid: 'ics-overview',
    title: 'ICS Lab Overview',
    description: 'Live Suricata IPS alerts and Zeek network analysis for the running scenario.',
    tags: ['ics', 'scada', 'security', 'suricata', 'zeek'],
    timezone: 'browser',
    schemaVersion: 38,
    version: 1,
    refresh: '5s',
    time: { from: 'now-1h', to: 'now' },
    fiscalYearStartMonth: 0,
    graphTooltip: 0,
    links: [],
    panels: [
      // ── Suricata alerts log panel ─────────────────────────────────────────
      {
        id: 1,
        type: 'logs',
        title: 'Suricata IPS — Alerts',
        description: 'Real-time Suricata EVE JSON alerts filtered by event_type="alert".',
        gridPos: { h: 14, w: 12, x: 0, y: 0 },
        datasource: lokiDs,
        options: logsOptions,
        targets: [
          {
            datasource: lokiDs,
            editorMode: 'code',
            // Filter for alert events; students can edit this in Grafana Explore
            expr: '{job="suricata"} | json | event_type=`alert`',
            queryType: 'range',
            refId: 'A'
          }
        ]
      },
      // ── Zeek network log panel ────────────────────────────────────────────
      {
        id: 2,
        type: 'logs',
        title: 'Zeek — Network Analysis',
        description: 'Zeek protocol analyzer logs (conn.log, dns.log, modbus.log, dnp3.log).',
        gridPos: { h: 14, w: 12, x: 12, y: 0 },
        datasource: lokiDs,
        options: logsOptions,
        targets: [
          {
            datasource: lokiDs,
            editorMode: 'code',
            expr: '{job="zeek"}',
            queryType: 'range',
            refId: 'A'
          }
        ]
      },
      // ── All Suricata events (not just alerts) ─────────────────────────────
      {
        id: 3,
        type: 'logs',
        title: 'Suricata — All Events',
        description: 'Full Suricata EVE stream: dns, http, tls, flow, stats and alerts.',
        gridPos: { h: 10, w: 24, x: 0, y: 14 },
        datasource: lokiDs,
        options: { ...logsOptions, showLabels: false },
        targets: [
          {
            datasource: lokiDs,
            editorMode: 'code',
            expr: '{job="suricata"}',
            queryType: 'range',
            refId: 'A'
          }
        ]
      }
    ]
  }
}
