import { useState, useEffect } from 'react'

interface StatsData {
  totalJobs: number
  jobsToday: number
  totalCostUsd: number
  costToday: number
  avgDurationMs: number | null
}

interface StatsBarProps {
  refreshSignal: number
}

export function StatsBar({ refreshSignal }: StatsBarProps) {
  const [stats, setStats] = useState<StatsData | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(false)

    fetch('/api/stats')
      .then((res) => {
        if (!res.ok) throw new Error('fetch failed')
        return res.json() as Promise<StatsData>
      })
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })

    return () => { cancelled = true }
  }, [refreshSignal])

  const style: React.CSSProperties = {
    padding: '6px 16px',
    fontSize: 12,
    color: '#94a3b8',
    borderTop: '1px solid #1e293b',
    backgroundColor: '#0f172a',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }

  if (error) {
    return <div style={style}>Stats unavailable</div>
  }

  if (!stats) {
    return <div style={style}>Today: — jobs | $— | All time: — jobs | $—</div>
  }

  return (
    <div style={style}>
      Today: {stats.jobsToday} jobs | ${stats.costToday.toFixed(2)} | All time: {stats.totalJobs} jobs | ${stats.totalCostUsd.toFixed(2)}
    </div>
  )
}
