import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getApiBase } from '../lib/api'
import { formatDistanceToNow } from 'date-fns'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { JobSummary, JobStatus } from '../types'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'running' | 'queued' | 'failed' | 'canceled'

const STATUS_BADGE: Record<JobStatus, { variant: BadgeVariant; label: string; tooltip: string }> = {
  running: { variant: 'running', label: 'running', tooltip: 'Job is actively executing' },
  completed: { variant: 'success', label: 'done', tooltip: 'Job completed successfully' },
  failed: { variant: 'failed', label: 'failed', tooltip: 'Job exited with an error code' },
  canceled: { variant: 'canceled', label: 'canceled', tooltip: 'Job was manually canceled' },
  queued: { variant: 'queued', label: 'queued', tooltip: 'Job is waiting to run' },
}

const ALL_STATUSES: JobStatus[] = ['running', 'completed', 'failed', 'canceled', 'queued']

function formatCost(cost: number | null | undefined): string | null {
  if (cost == null || cost === 0) return null
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(3)}`
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null) return null
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const s = secs % 60
  return `${mins}m ${s}s`
}

function formatTokens(n: number | null | undefined): string | null {
  if (n == null || n === 0) return null
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatRelTime(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true })
  } catch {
    return dateStr
  }
}

interface RecentJobsProps {
  jobs: JobSummary[]
  isLoading?: boolean
  onJobsCleared?: () => void
}

export function RecentJobs({ jobs, isLoading, onJobsCleared }: RecentJobsProps) {
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState<JobStatus | null>(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showClearModal, setShowClearModal] = useState(false)
  const [clearFrom, setClearFrom] = useState('')
  const [clearTo, setClearTo] = useState('')
  const [isClearing, setIsClearing] = useState(false)

  const filteredJobs = jobs.filter((j) => {
    if (statusFilter && j.status !== statusFilter) return false
    if (dateFrom && j.started_at < dateFrom) return false
    if (dateTo && j.started_at > `${dateTo}T23:59:59`) return false
    return true
  })

  async function handleClear(mode: 'all' | 'range') {
    setIsClearing(true)
    try {
      const body: Record<string, string> = {}
      if (mode === 'range') {
        if (clearFrom) body.from = clearFrom
        if (clearTo) body.to = clearTo
      }
      const res = await fetch(`${getApiBase()}/jobs`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data = await res.json() as { deleted: number }
        toast.success(`Cleared ${data.deleted} job(s)`)
        setShowClearModal(false)
        setClearFrom('')
        setClearTo('')
        onJobsCleared?.()
      } else {
        toast.error('Failed to clear jobs')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setIsClearing(false)
    }
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 bg-muted/30 rounded-md animate-pulse" />
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 bg-card/50 p-6 text-center">
        <p className="text-sm text-muted-foreground">No jobs yet</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Jobs will appear here after you run a command
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-2">
      {/* Filter bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setStatusFilter(null)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              statusFilter === null
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            }`}
          >
            All ({jobs.length})
          </button>
          {ALL_STATUSES.map((s) => {
            const count = jobs.filter((j) => j.status === s).length
            if (count === 0) return null
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(statusFilter === s ? null : s)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium capitalize transition-colors ${
                  statusFilter === s
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                {s} ({count})
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-6 rounded border border-border bg-input px-1.5 text-[10px] text-foreground"
            title="From date"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-6 rounded border border-border bg-input px-1.5 text-[10px] text-foreground"
            title="To date"
          />
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => { setDateFrom(''); setDateTo('') }}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => setShowClearModal(true)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear jobs</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 px-3 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        <span className="w-14">Status</span>
        <span className="flex-1 min-w-0">Command</span>
        <div className="flex items-center gap-3 shrink-0">
          <span className="w-14 text-right">Duration</span>
          <span className="w-12 text-right">Tokens</span>
          <span className="w-12 text-right">Cost</span>
          <span className="w-20 text-right">Started</span>
        </div>
      </div>

      {/* Job rows */}
      <div className="space-y-0.5">
        {filteredJobs.map((job) => {
          const statusInfo = STATUS_BADGE[job.status] ?? STATUS_BADGE.queued
          const cost = formatCost(job.total_cost_usd)
          const duration = formatDuration(job.duration_ms)
          const tokens = formatTokens(job.tokens_out)

          return (
            <div
              key={job.id}
              className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent/50 transition-colors cursor-pointer group"
              onClick={() => navigate(`/jobs/${job.id}`)}
            >
              {/* Status badge */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
                  </div>
                </TooltipTrigger>
                <TooltipContent>{statusInfo.tooltip}</TooltipContent>
              </Tooltip>

              {/* Command */}
              <code className="text-xs text-foreground/80 truncate flex-1 min-w-0">
                {job.command}
              </code>

              {/* Meta */}
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground shrink-0">
                <span className="w-14 text-right">{duration ?? '—'}</span>
                <span className="w-12 text-right">{tokens ? `${tokens}` : '—'}</span>
                <span className="w-12 text-right">{cost ?? '—'}</span>
                <span className="w-20 text-right">{formatRelTime(job.started_at)}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Clear jobs modal */}
      {showClearModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowClearModal(false)}>
          <div className="w-80 rounded-xl border border-border/30 bg-popover p-4 shadow-lg space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">Clear Jobs</h3>

            <Button
              variant="destructive"
              size="sm"
              className="w-full"
              disabled={isClearing}
              onClick={() => handleClear('all')}
            >
              Clear all jobs
            </Button>

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Or clear by date range:</p>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={clearFrom}
                  onChange={(e) => setClearFrom(e.target.value)}
                  className="flex-1 h-7 rounded-md border border-border bg-input px-2 text-xs text-foreground"
                  placeholder="From"
                />
                <input
                  type="date"
                  value={clearTo}
                  onChange={(e) => setClearTo(e.target.value)}
                  className="flex-1 h-7 rounded-md border border-border bg-input px-2 text-xs text-foreground"
                  placeholder="To"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={isClearing || (!clearFrom && !clearTo)}
                onClick={() => handleClear('range')}
              >
                Clear range
              </Button>
            </div>

            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => setShowClearModal(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
