import { useEffect, useState } from 'react'
import type { AppInfo, DockerStatus } from '@ics-sim/schema'
import './index.css'

export default function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [docker, setDocker] = useState<DockerStatus | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    async function init() {
      const [info, dockerStatus] = await Promise.all([
        window.electronAPI.app.info(),
        window.electronAPI.docker.check()
      ])
      setAppInfo(info)
      setDocker(dockerStatus)
      setChecking(false)
    }
    init()
  }, [])

  return (
    <div className="app">
      <div className="app-header">
        <div className="logo-mark">
          <span className="logo-bracket">[</span>
          <span className="logo-text">ICS</span>
          <span className="logo-bracket">]</span>
        </div>
        <h1>ICS Simulator</h1>
        <p className="tagline">ICS/SCADA Security Research &amp; Education Platform</p>
      </div>

      <div className="status-panel">
        {checking ? (
          <div className="status-row">
            <span className="status-dot checking" />
            <span>Checking system requirements…</span>
          </div>
        ) : (
          <>
            <div className="status-row">
              <span className={`status-dot ${docker?.available ? 'ok' : 'error'}`} />
              <span>
                Docker:{' '}
                {docker?.available
                  ? `Ready (v${docker.version})`
                  : (docker?.message ?? 'Not available')}
              </span>
            </div>
            <div className="status-row">
              <span className="status-dot ok" />
              <span>
                App: v{appInfo?.version} · Electron {appInfo?.electronVersion} · Node{' '}
                {appInfo?.nodeVersion}
              </span>
            </div>
            <div className="status-row">
              <span className="status-dot ok" />
              <span>Platform: {appInfo?.platform}</span>
            </div>
          </>
        )}
      </div>

      <div className="phase-notice">
        <strong>Phase 0 — Scaffold Complete</strong>
        <p>
          Canvas editor, protocol simulation, security stack, and HMI panels are built in Phases
          1–11. Import a <code>.icslab</code> scenario file to begin.
        </p>
        <div className="action-row">
          <button
            className="btn btn-primary"
            onClick={() => window.electronAPI.scenario.import()}
            disabled={!docker?.available}
          >
            Import Scenario
          </button>
          <button
            className="btn btn-secondary"
            onClick={() =>
              window.electronAPI.app.openExternal('https://github.com/iburres/ics-simulator')
            }
          >
            Documentation
          </button>
        </div>
        {!docker?.available && (
          <p className="warning">Docker Desktop must be running to launch simulations.</p>
        )}
      </div>
    </div>
  )
}
