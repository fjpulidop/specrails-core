import { useState, useEffect, useRef } from 'react'
import type { JobSummary } from '../hooks/usePipeline'

interface JobHistoryProps {
  initialJobs: JobSummary[]
}

const STATUS_COLORS: Record<string, string> = {
  running: '#ca8a04',
  completed: '#16a34a',
  failed: '#dc2626',
  canceled: '#6b7280',
  queued: '#6b7280',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 600,
        backgroundColor: STATUS_COLORS[status] ?? '#6b7280',
        color: '#fff',
      }}
    >
      {status}
    </span>
  )
}

export function JobHistory({ initialJobs }: JobHistoryProps) {
  const [jobs, setJobs] = useState<JobSummary[]>(initialJobs)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function fetchJobs() {
    fetch('/api/jobs?limit=20')
      .then((res) => res.json() as Promise<{ jobs: JobSummary[] }>)
      .then((data) => setJobs(data.jobs))
      .catch(() => { /* keep current state on error */ })
  }

  useEffect(() => {
    fetchJobs()
    intervalRef.current = setInterval(fetchJobs, 5000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  const containerStyle: React.CSSProperties = {
    overflow: 'auto',
    height: '100%',
    padding: '8px 0',
  }

  const tableStyle: React.CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
    color: '#cbd5e1',
  }

  const thStyle: React.CSSProperties = {
    padding: '4px 12px',
    textAlign: 'left',
    fontWeight: 600,
    color: '#64748b',
    borderBottom: '1px solid #1e293b',
    position: 'sticky',
    top: 0,
    backgroundColor: '#0f172a',
  }

  const tdStyle: React.CSSProperties = {
    padding: '4px 12px',
    borderBottom: '1px solid #1e293b',
    fontFamily: 'monospace',
  }

  if (jobs.length === 0) {
    return (
      <div style={{ ...containerStyle, color: '#475569', fontSize: 12, padding: '12px 16px' }}>
        No jobs yet.
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>ID</th>
            <th style={thStyle}>Command</th>
            <th style={thStyle}>Started</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td style={tdStyle}>{job.id.slice(0, 8)}</td>
              <td style={tdStyle}>
                {job.command.length > 40 ? `${job.command.slice(0, 40)}...` : job.command}
              </td>
              <td style={tdStyle}>{new Date(job.started_at).toLocaleTimeString()}</td>
              <td style={tdStyle}><StatusBadge status={job.status} /></td>
              <td style={tdStyle}>
                {job.total_cost_usd != null ? `$${job.total_cost_usd.toFixed(4)}` : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
