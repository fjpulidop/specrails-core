import { useEffect, useRef, useState } from 'react'
import { usePipeline } from './hooks/usePipeline'
import { useQueue } from './hooks/useQueue'
import { PipelineSidebar } from './components/PipelineSidebar'
import { JobQueueSidebar } from './components/JobQueueSidebar'
import { AgentActivity } from './components/AgentActivity'
import { CommandInput } from './components/CommandInput'
import { StatsBar } from './components/StatsBar'
import { JobHistory } from './components/JobHistory'

const GRID_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateAreas: '"header header" "sidebar activity" "sidebar history"',
  gridTemplateColumns: '240px 1fr',
  gridTemplateRows: '48px 1fr 200px',
  height: '100vh',
  backgroundColor: '#0f172a',
  color: '#e2e8f0',
  fontFamily: 'system-ui, sans-serif',
  margin: 0,
  overflow: 'hidden',
}

export default function App() {
  const { phases, projectName, logLines, connectionStatus, recentJobs, queueState } = usePipeline()
  const { jobs, activeJobId, paused, kill, cancel, pause, resume } = useQueue(queueState)

  // Increment refreshSignal whenever connection transitions to 'connected'
  const prevStatusRef = useRef(connectionStatus)
  const [refreshSignal, setRefreshSignal] = useState(0)

  useEffect(() => {
    if (prevStatusRef.current !== 'connected' && connectionStatus === 'connected') {
      setRefreshSignal((s) => s + 1)
    }
    prevStatusRef.current = connectionStatus
  }, [connectionStatus])

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0f172a; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0f172a; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
      `}</style>
      <div style={GRID_STYLE}>
        {/* Header */}
        <header
          style={{
            gridArea: 'header',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            borderBottom: '1px solid #1e293b',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          <span>specrails manager</span>
          <span style={{ color: '#64748b', fontSize: 12 }}>{projectName}</span>
        </header>

        {/* Left sidebar: PipelineSidebar (top) + JobQueueSidebar (middle, scrollable) + CommandInput (bottom) */}
        <aside
          style={{
            gridArea: 'sidebar',
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid #1e293b',
            overflow: 'hidden',
          }}
        >
          <PipelineSidebar phases={phases} />
          <JobQueueSidebar
            jobs={jobs}
            activeJobId={activeJobId}
            paused={paused}
            onKill={kill}
            onCancel={cancel}
            onPause={pause}
            onResume={resume}
          />
          <CommandInput />
        </aside>

        {/* Main activity panel */}
        <main style={{ gridArea: 'activity', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {connectionStatus === 'disconnected' && (
            <div
              style={{
                background: '#7f1d1d',
                color: '#fca5a5',
                padding: '8px 16px',
                fontSize: 13,
              }}
            >
              Disconnected from server. Check that the web manager is running.
            </div>
          )}
          <AgentActivity logLines={logLines} />
        </main>

        {/* History + stats panel */}
        <section
          style={{
            gridArea: 'history',
            display: 'flex',
            flexDirection: 'column',
            borderTop: '1px solid #1e293b',
            overflow: 'hidden',
          }}
        >
          <StatsBar refreshSignal={refreshSignal} />
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <JobHistory initialJobs={recentJobs} />
          </div>
        </section>
      </div>
    </>
  )
}
