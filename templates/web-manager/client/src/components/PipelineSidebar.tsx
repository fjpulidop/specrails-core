import type { PhaseMap } from '../hooks/usePipeline'

type PhaseName = 'architect' | 'developer' | 'reviewer' | 'ship'
type PhaseState = 'idle' | 'running' | 'done' | 'error'

const PHASES: { name: PhaseName; label: string }[] = [
  { name: 'architect', label: 'Architect' },
  { name: 'developer', label: 'Developer' },
  { name: 'reviewer', label: 'Reviewer' },
  { name: 'ship', label: 'Ship' },
]

const STATE_COLORS: Record<PhaseState, string> = {
  idle: '#6b7280',
  running: '#eab308',
  done: '#22c55e',
  error: '#ef4444',
}

interface PipelineSidebarProps {
  phases: PhaseMap
}

export function PipelineSidebar({ phases }: PipelineSidebarProps) {
  return (
    <div style={{ padding: '16px 12px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Pipeline
      </div>
      {PHASES.map((phase, idx) => {
        const state = phases[phase.name]
        const color = STATE_COLORS[state]
        const isRunning = state === 'running'
        return (
          <div key={phase.name}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  backgroundColor: color,
                  flexShrink: 0,
                  animation: isRunning ? 'pulse 1.5s ease-in-out infinite' : 'none',
                }}
              />
              <span style={{ fontSize: 13, color: state === 'idle' ? '#64748b' : '#e2e8f0' }}>
                {phase.label}
              </span>
            </div>
            {idx < PHASES.length - 1 && (
              <div style={{ color: '#334155', fontSize: 12, paddingLeft: 3, lineHeight: 1 }}>↓</div>
            )}
          </div>
        )
      })}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}
