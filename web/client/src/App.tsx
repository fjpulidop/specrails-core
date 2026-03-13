import { usePipeline } from './hooks/usePipeline'
import { PipelineSidebar } from './components/PipelineSidebar'
import { AgentActivity } from './components/AgentActivity'
import { CommandInput } from './components/CommandInput'

const GRID_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateAreas: '"header header" "sidebar activity"',
  gridTemplateColumns: '240px 1fr',
  gridTemplateRows: '48px 1fr',
  height: '100vh',
  backgroundColor: '#0f172a',
  color: '#e2e8f0',
  fontFamily: 'system-ui, sans-serif',
  margin: 0,
  overflow: 'hidden',
}

export default function App() {
  const { phases, projectName, logLines, connectionStatus } = usePipeline()

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

        {/* Left sidebar */}
        <aside
          style={{
            gridArea: 'sidebar',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderRight: '1px solid #1e293b',
            overflow: 'hidden',
          }}
        >
          <PipelineSidebar phases={phases} />
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
      </div>
    </>
  )
}
