import { useState, useEffect } from 'react'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface Job {
  id: string
  command: string
  status: JobStatus
  queuePosition: number | null
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
}

interface JobQueueSidebarProps {
  jobs: Job[]
  activeJobId: string | null
  paused: boolean
  onKill: (jobId: string) => void
  onCancel: (jobId: string) => void
  onPause: () => void
  onResume: () => void
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

function elapsedText(finishedAt: string | null): string {
  if (!finishedAt) return ''
  const ms = Date.now() - new Date(finishedAt).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

const DOT_SIZE = 10

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    flex: 1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px 6px',
    borderBottom: '1px solid #1e293b',
  },
  headerLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  pauseBtn: {
    background: 'none',
    border: '1px solid #334155',
    borderRadius: 3,
    color: '#94a3b8',
    fontSize: 11,
    padding: '2px 8px',
    cursor: 'pointer',
  },
  list: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '4px 0',
  },
  jobRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    fontSize: 12,
    borderBottom: '1px solid #0f172a',
  },
  dot: (color: string, pulse: boolean): React.CSSProperties => ({
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: '50%',
    flexShrink: 0,
    backgroundColor: color,
    animation: pulse ? 'pulse 1.5s ease-in-out infinite' : 'none',
  }),
  badge: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: 600,
    minWidth: 20,
    flexShrink: 0,
  },
  command: {
    flex: 1,
    color: '#cbd5e1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  meta: {
    fontSize: 11,
    color: '#64748b',
    flexShrink: 0,
  },
  actionBtn: (color: string): React.CSSProperties => ({
    background: 'none',
    border: `1px solid ${color}`,
    borderRadius: 3,
    color,
    fontSize: 10,
    padding: '1px 6px',
    cursor: 'pointer',
    flexShrink: 0,
  }),
  emptyMsg: {
    padding: '16px 12px',
    fontSize: 12,
    color: '#475569',
    fontStyle: 'italic',
  },
}

function sortJobs(jobs: Job[]): Job[] {
  const order: Record<JobStatus, number> = { running: 0, queued: 1, completed: 2, failed: 3, canceled: 4 }
  return [...jobs].sort((a, b) => {
    const orderDiff = order[a.status] - order[b.status]
    if (orderDiff !== 0) return orderDiff
    if (a.status === 'queued') {
      return (a.queuePosition ?? 999) - (b.queuePosition ?? 999)
    }
    // Most recent terminal jobs first
    if (a.finishedAt && b.finishedAt) {
      return new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime()
    }
    return 0
  })
}

export function JobQueueSidebar({
  jobs,
  paused,
  onKill,
  onCancel,
  onPause,
  onResume,
}: JobQueueSidebarProps) {
  // Force re-render every 10s to update elapsed times
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10000)
    return () => clearInterval(id)
  }, [])

  const sorted = sortJobs(jobs)
  // Show running + queued + up to 5 most-recent terminal jobs
  const terminalJobs = sorted.filter((j) => ['completed', 'failed', 'canceled'].includes(j.status)).slice(0, 5)
  const activeJobs = sorted.filter((j) => !['completed', 'failed', 'canceled'].includes(j.status))
  const displayed = [...activeJobs, ...terminalJobs]

  return (
    <div style={styles.container}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
      <div style={styles.header}>
        <span style={styles.headerLabel}>Queue</span>
        <button
          style={styles.pauseBtn}
          onClick={paused ? onResume : onPause}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      <div style={styles.list}>
        {displayed.length === 0 && (
          <div style={styles.emptyMsg}>No jobs</div>
        )}
        {displayed.map((job) => (
          <div key={job.id} style={styles.jobRow}>
            {job.status === 'running' && (
              <>
                <span style={styles.dot('#eab308', true)} />
                <span style={styles.command} title={job.command}>{truncate(job.command, 30)}</span>
                <button style={styles.actionBtn('#ef4444')} onClick={() => onKill(job.id)}>Kill</button>
              </>
            )}
            {job.status === 'queued' && (
              <>
                <span style={styles.dot('#64748b', false)} />
                <span style={styles.badge}>#{job.queuePosition}</span>
                <span style={styles.command} title={job.command}>{truncate(job.command, 30)}</span>
                <button style={styles.actionBtn('#64748b')} onClick={() => onCancel(job.id)}>×</button>
              </>
            )}
            {job.status === 'completed' && (
              <>
                <span style={{ ...styles.dot('#22c55e', false), backgroundColor: 'transparent', color: '#22c55e', fontSize: 12, fontWeight: 700 }}>✓</span>
                <span style={styles.command} title={job.command}>{truncate(job.command, 30)}</span>
                <span style={styles.meta}>{elapsedText(job.finishedAt)}</span>
              </>
            )}
            {job.status === 'failed' && (
              <>
                <span style={styles.dot('#ef4444', false)} />
                <span style={styles.command} title={job.command}>{truncate(job.command, 30)}</span>
                <span style={styles.meta}>exit {job.exitCode ?? '?'}</span>
              </>
            )}
            {job.status === 'canceled' && (
              <>
                <span style={{ ...styles.dot('#475569', false), opacity: 0.5 }} />
                <span style={{ ...styles.command, color: '#475569' }} title={job.command}>{truncate(job.command, 30)}</span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
