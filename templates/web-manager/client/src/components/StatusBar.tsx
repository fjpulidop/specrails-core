import { useEffect, useState } from 'react'
import { cn } from '../lib/utils'

interface Stats {
  totalJobs: number
  jobsToday: number
  costToday: number
  totalCostUsd: number
}

interface StatusBarProps {
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
}

export function StatusBar({ connectionStatus }: StatusBarProps) {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch('/api/stats')
        if (res.ok) {
          const data = await res.json() as Stats
          setStats(data)
        }
      } catch {
        // ignore
      }
    }

    fetchStats()
    // Refresh stats every 30 seconds
    const interval = setInterval(fetchStats, 30_000)
    return () => clearInterval(interval)
  }, [connectionStatus])

  return (
    <footer className="h-7 flex items-center justify-between px-4 border-t border-border bg-card/30 text-[10px] text-muted-foreground">
      {/* Connection status */}
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full',
            connectionStatus === 'connected' && 'bg-emerald-500',
            connectionStatus === 'connecting' && 'bg-amber-500 animate-pulse',
            connectionStatus === 'disconnected' && 'bg-red-500'
          )}
        />
        <span>
          {connectionStatus === 'connected' && 'connected'}
          {connectionStatus === 'connecting' && 'connecting...'}
          {connectionStatus === 'disconnected' && 'disconnected'}
        </span>
      </div>

      {/* Stats */}
      {stats && (
        <div className="flex items-center gap-4">
          <span>today: {stats.jobsToday} jobs</span>
          {stats.costToday > 0 && <span>${stats.costToday.toFixed(3)}</span>}
          <span>total: {stats.totalJobs} jobs</span>
          {stats.totalCostUsd > 0 && <span>${stats.totalCostUsd.toFixed(2)}</span>}
        </div>
      )}
    </footer>
  )
}
