/**
 * MonitorPanel.tsx — Live monitoring panel for running ICS simulations.
 *
 * Rendered as a fixed-height drawer below the SCADA canvas when the simulation
 * is running and the user has toggled "Monitor" in the toolbar.
 *
 * Two tabs:
 *
 *   Dashboards — Embeds the Grafana ICS Lab Overview dashboard (uid: ics-overview)
 *     in an Electron <webview> tag. The webview bypasses X-Frame-Options and CSP
 *     headers that would block a standard <iframe>. Grafana runs on localhost:3000
 *     (published by the compose generator) with anonymous read access enabled.
 *
 *   Live Logs — Native log viewer that polls the Loki HTTP API (proxied through
 *     the Electron main process to avoid CORS). Displays Suricata IPS alerts and
 *     Zeek network analysis entries with per-source color coding. The view is
 *     filterable and auto-scrolls to keep the latest entries visible.
 *
 * Loki response format:
 *   { data: { result: [{ stream: { job: "suricata" }, values: [["ns", "line"], ...] }] } }
 *   values[n][0] is a nanosecond timestamp string; values[n][1] is the raw log line.
 *
 * Performance:
 *   Log polling runs only when the Logs tab is active. Entries are deduplicated by
 *   their nanosecond timestamp string. The displayed buffer is capped at MAX_LOG_LINES
 *   to prevent unbounded memory growth during long simulations.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

/** Maximum number of log entries kept in memory at any time. */
const MAX_LOG_LINES = 500

/** Poll interval for the Loki query (milliseconds). */
const POLL_INTERVAL_MS = 3000

/** How far back to look on each Loki poll (milliseconds). */
const LOOK_BACK_MS = 15_000

/** Grafana dashboard webview URL — kiosk mode, dark theme, 5 s auto-refresh. */
const GRAFANA_URL = 'http://localhost:3000/d/ics-overview?orgId=1&kiosk&theme=dark&refresh=5s'

/** LogQL queries for each job source. */
const LOKI_QUERIES: Record<string, string> = {
  suricata: '{job="suricata"}',
  zeek: '{job="zeek"}',
  all: '{job=~"suricata|zeek"}'
}

/** Filter tabs shown above the log list. */
type LogFilter = 'all' | 'suricata' | 'zeek'

/** A parsed log entry extracted from the Loki streams response. */
interface LogEntry {
  /** Nanosecond timestamp string from Loki — used as dedup key. */
  tsNs: string
  /** Millisecond Unix timestamp for display. */
  tsMs: number
  /** Raw log line string. */
  line: string
  /** Source job label: "suricata" or "zeek". */
  job: string
}

/** Loki API response shape — only the fields MonitorPanel uses. */
interface LokiResponse {
  data: {
    result: Array<{
      stream: Record<string, string>
      values: Array<[string, string]>
    }>
  }
}

/** Props for MonitorPanel. */
interface MonitorPanelProps {
  /** Called when the user clicks the × close button on the panel. */
  onClose: () => void
}

// ── Log entry rendering helpers ────────────────────────────────────────────────

/**
 * Returns a short human-readable timestamp (HH:MM:SS.mmm) from a millisecond
 * Unix timestamp. Used in the log row to keep the timestamp column compact.
 */
function formatTs(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(11, 23) // "HH:MM:SS.mmm"
}

/**
 * Parses the raw Loki query_range JSON response into a flat array of LogEntry
 * objects sorted by timestamp (oldest first, matching the "forward" read order).
 *
 * Loki returns one stream per unique label set; each stream has an ordered
 * values array of [nanosecond-timestamp, log-line] pairs.
 *
 * @param raw  - The `data` field of the Loki query_range response.
 * @returns    - Flat array of LogEntry objects, sorted ascending by tsNs.
 */
function parseLokiResponse(raw: LokiResponse): LogEntry[] {
  const entries: LogEntry[] = []
  for (const stream of raw.data.result) {
    const job = stream.stream.job ?? 'unknown'
    for (const [tsNs, line] of stream.values) {
      entries.push({
        tsNs,
        tsMs: Math.floor(Number(tsNs) / 1_000_000),
        line,
        job
      })
    }
  }
  // Sort by nanosecond timestamp so entries from different streams are interleaved correctly
  return entries.sort((a, b) => (a.tsNs < b.tsNs ? -1 : a.tsNs > b.tsNs ? 1 : 0))
}

// ── Component ──────────────────────────────────────────────────────────────────

/**
 * MonitorPanel — bottom-drawer monitoring pane for an active ICS simulation.
 *
 * Mounts below the SCADA workspace. The parent (App.tsx) is responsible for
 * showing/hiding this panel based on simulation state and user toggle.
 *
 * @param onClose - Callback to collapse the monitor panel.
 */
export function MonitorPanel({ onClose }: MonitorPanelProps) {
  /** Which top-level tab is active: Grafana embed or native log viewer. */
  const [tab, setTab] = useState<'grafana' | 'logs'>('grafana')

  /** Filter for the log viewer (all sources, Suricata only, Zeek only). */
  const [logFilter, setLogFilter] = useState<LogFilter>('all')

  /**
   * Flat array of log entries, capped at MAX_LOG_LINES.
   * Entries accumulate across polls; deduplication is by tsNs string.
   */
  const [logs, setLogs] = useState<LogEntry[]>([])

  /**
   * Whether Loki has responded at least once successfully.
   * Used to show a "waiting for Loki" message rather than an empty list.
   */
  const [lokiReady, setLokiReady] = useState(false)

  /**
   * Whether Grafana's /api/health endpoint has returned HTTP 200.
   * Polled every 2 s when the Grafana tab is active so the <webview> is not
   * mounted until the container is actually serving requests (avoids the
   * ERR_CONNECTION_REFUSED that appears during the 15–30 s startup window).
   */
  const [grafanaReady, setGrafanaReady] = useState(false)

  /**
   * Set of nanosecond timestamp keys already in the log buffer.
   * Checked on each poll to avoid inserting duplicate entries when the
   * Loki look-back window overlaps with previously fetched entries.
   */
  const seenNsRef = useRef(new Set<string>())

  /** Ref to the bottom of the log list, scrolled to when new entries arrive. */
  const logsEndRef = useRef<HTMLDivElement>(null)

  // ── Loki poll loop ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (tab !== 'logs') return

    /**
     * Queries Loki for log entries in the look-back window.
     * Merges new entries into the buffer, deduplicating by tsNs.
     */
    const poll = async (): Promise<void> => {
      const toNs = String(Date.now() * 1_000_000)
      const fromNs = String((Date.now() - LOOK_BACK_MS) * 1_000_000)

      const result = await window.electronAPI.monitor.getLogs(
        LOKI_QUERIES[logFilter],
        fromNs,
        toNs,
        200
      )

      if (!result.ok || !result.data) return

      setLokiReady(true)
      const parsed = parseLokiResponse(result.data as LokiResponse)

      // Merge only entries we haven't seen before
      const newEntries = parsed.filter(e => {
        if (seenNsRef.current.has(e.tsNs)) return false
        seenNsRef.current.add(e.tsNs)
        return true
      })

      if (newEntries.length === 0) return

      setLogs(prev => {
        const combined = [...prev, ...newEntries]
        // Cap to MAX_LOG_LINES, keeping the newest (tail) entries
        if (combined.length > MAX_LOG_LINES) {
          const trimmed = combined.slice(combined.length - MAX_LOG_LINES)
          // Remove evicted tsNs keys from the seen set to prevent it growing unbounded
          for (const e of combined.slice(0, combined.length - MAX_LOG_LINES)) {
            seenNsRef.current.delete(e.tsNs)
          }
          return trimmed
        }
        return combined
      })
    }

    poll()
    const timer = setInterval(poll, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [tab, logFilter])

  // ── Grafana readiness poll ──────────────────────────────────────────────────
  // Polls monitor:grafanaReady every 2 s until Grafana's /api/health returns 200.
  // Stops polling once grafanaReady is true (clears interval on next re-render).
  useEffect(() => {
    if (tab !== 'grafana' || grafanaReady) return
    const check = async (): Promise<void> => {
      const ready = await window.electronAPI.monitor.grafanaReady()
      if (ready) setGrafanaReady(true)
    }
    check() // immediate check on tab switch
    const timer = setInterval(check, 2000)
    return () => clearInterval(timer)
  }, [tab, grafanaReady])

  // ── Auto-scroll to bottom when new log entries arrive ──────────────────────
  useEffect(() => {
    if (tab === 'logs') {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, tab])

  // ── Clear log buffer when the filter changes ────────────────────────────────
  const handleFilterChange = useCallback((f: LogFilter) => {
    setLogFilter(f)
    setLogs([])
    seenNsRef.current.clear()
  }, [])

  // ── Filtered view ────────────────────────────────────────────────────────────
  const visibleLogs = logFilter === 'all' ? logs : logs.filter(l => l.job === logFilter)

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="monitor-panel">
      {/* Panel header: tab bar on the left, close button on the right */}
      <div className="monitor-header">
        <div className="monitor-tabs">
          <button
            className={`monitor-tab ${tab === 'grafana' ? 'active' : ''}`}
            onClick={() => setTab('grafana')}
          >
            Grafana Dashboards
          </button>
          <button
            className={`monitor-tab ${tab === 'logs' ? 'active' : ''}`}
            onClick={() => setTab('logs')}
          >
            Live Logs
          </button>
        </div>
        <button className="monitor-close" onClick={onClose} title="Close monitor panel">
          ×
        </button>
      </div>

      {/* Grafana webview — uses Electron webview tag to bypass X-Frame-Options */}
      {tab === 'grafana' && (
        <div className="monitor-grafana">
          {grafanaReady ? (
            <>
              {/* webview bypasses X-Frame-Options/CSP headers, unlike a standard iframe */}
              <webview src={GRAFANA_URL} className="monitor-grafana-webview" />
              <p className="monitor-grafana-hint">
                Use <strong>Explore</strong> in Grafana to write custom LogQL or InfluxQL queries.
              </p>
            </>
          ) : (
            /* Loading spinner shown while Grafana container is still starting up */
            <div className="monitor-grafana-loading">
              <span className="status-dot checking" />
              <span>Waiting for Grafana to start… (15–30 s on first launch)</span>
            </div>
          )}
        </div>
      )}

      {/* Native log viewer — polls Loki API via IPC proxy */}
      {tab === 'logs' && (
        <div className="monitor-logs">
          {/* Source filter chips */}
          <div className="monitor-logs-toolbar">
            <div className="monitor-filter-group">
              {(['all', 'suricata', 'zeek'] as LogFilter[]).map(f => (
                <button
                  key={f}
                  className={`monitor-filter-btn monitor-filter-${f} ${logFilter === f ? 'active' : ''}`}
                  onClick={() => handleFilterChange(f)}
                >
                  {f === 'all' ? 'All Sources' : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <span className="monitor-logs-count">{visibleLogs.length} entries</span>
          </div>

          {/* Log entries — scrollable list */}
          <div className="monitor-logs-body">
            {!lokiReady && (
              <div className="monitor-logs-waiting">
                <span className="status-dot checking" />
                Waiting for Loki to start… (may take 15–30 s after simulation launch)
              </div>
            )}
            {lokiReady && visibleLogs.length === 0 && (
              <div className="monitor-logs-waiting">
                No {logFilter === 'all' ? '' : logFilter + ' '}log entries yet. Traffic will appear
                as devices communicate.
              </div>
            )}
            {visibleLogs.map(entry => (
              <div key={entry.tsNs} className={`monitor-log-row monitor-log-${entry.job}`}>
                {/* Timestamp */}
                <span className="monitor-log-ts">{formatTs(entry.tsMs)}</span>
                {/* Source badge (Suricata = red, Zeek = blue) */}
                <span className={`monitor-log-badge monitor-badge-${entry.job}`}>{entry.job}</span>
                {/* Raw log line — truncated visually via CSS overflow: hidden */}
                <span className="monitor-log-line">{entry.line}</span>
              </div>
            ))}
            {/* Scroll anchor */}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
    </div>
  )
}
