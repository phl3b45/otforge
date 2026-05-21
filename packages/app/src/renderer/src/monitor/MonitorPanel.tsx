/**
 * MonitorPanel.tsx — Live monitoring panel for running ICS simulations.
 *
 * Rendered as a fixed-height drawer below the SCADA canvas when the simulation
 * is running and the user has toggled "Monitor" in the toolbar.
 *
 * Layout:
 *   Header — "Open Grafana ↗" button (opens a separate OS window at 1400×900)
 *             + Live Logs label + close button.
 *   Body   — Live Logs viewer: polls the Loki HTTP API (proxied through the
 *             Electron main process to avoid CORS). Displays Suricata IPS alerts
 *             and Zeek network analysis entries with per-source color coding.
 *             Filterable by source; auto-scrolls to latest entries.
 *
 * Grafana is no longer embedded as a <webview>. Opening it in a separate window
 * gives students the full viewport, lets them undock it to a second monitor, and
 * avoids the height constraint imposed by the drawer layout.
 *
 * Loki response format:
 *   { data: { result: [{ stream: { job: "suricata" }, values: [["ns", "line"], ...] }] } }
 *   values[n][0] is a nanosecond timestamp string; values[n][1] is the raw log line.
 *
 * Performance:
 *   Entries are deduplicated by their nanosecond timestamp string. The displayed
 *   buffer is capped at MAX_LOG_LINES to prevent unbounded memory growth during
 *   long simulations.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

/** Maximum number of log entries kept in memory at any time. */
const MAX_LOG_LINES = 500

/** Poll interval for the Loki query (milliseconds). */
const POLL_INTERVAL_MS = 3000

/** How far back to look on each Loki poll (milliseconds). */
const LOOK_BACK_MS = 15_000

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
   * Polled every 2 s to enable/disable the "Open Grafana" button so students
   * don't open a blank window during the 15–30 s Grafana startup window.
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
  }, [logFilter])

  // ── Grafana readiness poll ──────────────────────────────────────────────────
  // Polls monitor:grafanaReady every 2 s until Grafana's /api/health returns 200.
  // Once ready the button becomes enabled; the interval clears on the next render.
  useEffect(() => {
    if (grafanaReady) return
    const check = async (): Promise<void> => {
      const ready = await window.electronAPI.monitor.grafanaReady()
      if (ready) setGrafanaReady(true)
    }
    check()
    const timer = setInterval(check, 2000)
    return () => clearInterval(timer)
  }, [grafanaReady])

  // ── Auto-scroll to bottom when new log entries arrive ──────────────────────
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // ── Clear log buffer when the filter changes ────────────────────────────────
  const handleFilterChange = useCallback((f: LogFilter) => {
    setLogFilter(f)
    setLogs([])
    seenNsRef.current.clear()
  }, [])

  // ── Open Grafana in a separate OS window ────────────────────────────────────
  const handleOpenGrafana = useCallback(async () => {
    const result = await window.electronAPI.monitor.openGrafana()
    if (!result.ok && result.error) {
      console.error('[MonitorPanel] openGrafana failed:', result.error)
    }
  }, [])

  // ── Filtered view ────────────────────────────────────────────────────────────
  const visibleLogs = logFilter === 'all' ? logs : logs.filter(l => l.job === logFilter)

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="monitor-panel">
      {/* Panel header: Grafana launch button on the left, title, close button on the right */}
      <div className="monitor-header">
        <div className="monitor-header-left">
          {/* Opens a dedicated 1400×900 BrowserWindow — can be moved to a second monitor */}
          <button
            className={`monitor-grafana-btn ${grafanaReady ? '' : 'loading'}`}
            onClick={handleOpenGrafana}
            disabled={!grafanaReady}
            title={
              grafanaReady
                ? 'Open Grafana ICS Lab Overview in a separate window'
                : 'Waiting for Grafana to start… (15–30 s on first launch)'
            }
          >
            {grafanaReady ? 'Open Grafana ↗' : 'Grafana starting…'}
          </button>
          <span className="monitor-panel-label">Live Logs</span>
        </div>
        <button className="monitor-close" onClick={onClose} title="Close monitor panel">
          ×
        </button>
      </div>

      {/* Native log viewer — polls Loki API via IPC proxy */}
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
              No {logFilter === 'all' ? '' : logFilter + ' '}log entries yet. Traffic will appear as
              devices communicate.
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
    </div>
  )
}
