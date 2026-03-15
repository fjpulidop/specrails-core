import { useState, useMemo } from 'react'
import { format } from 'date-fns'
import { Search, Filter, X, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
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

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  if (mins < 60) return `${mins}m ${rem}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function formatTokens(tokIn: number | null | undefined, tokOut: number | null | undefined): string {
  if (tokIn == null && tokOut == null) return '—'
  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  const parts: string[] = []
  if (tokIn != null) parts.push(`${fmt(tokIn)} in`)
  if (tokOut != null) parts.push(`${fmt(tokOut)} out`)
  return parts.join(' / ')
}

function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  try {
    return format(new Date(dateStr), 'MMM d, HH:mm:ss')
  } catch {
    return '—'
  }
}

interface RecentJobsProps {
  jobs: JobSummary[]
  isLoading?: boolean
  onJobsCleared?: () => void
  onOpenJob?: (jobId: string) => void
}

export function RecentJobs({ jobs, isLoading, onJobsCleared, onOpenJob }: RecentJobsProps) {
  const [searchText, setSearchText] = useState('')
  const [statusFilter, setStatusFilter] = useState<JobStatus | null>(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const [clearMode, setClearMode] = useState<'all' | 'range'>('all')
  const [clearFrom, setClearFrom] = useState('')
  const [clearTo, setClearTo] = useState('')
  const [clearing, setClearing] = useState(false)

  async function handleClear() {
    setClearing(true)
    try {
      const body: Record<string, string> = {}
      if (clearMode === 'range') {
        if (clearFrom) body.from = new Date(clearFrom).toISOString()
        if (clearTo) body.to = new Date(clearTo).toISOString()
      }
      const res = await fetch('/api/jobs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data = await res.json() as { deleted: number }
        toast.success(`Cleared ${data.deleted} job${data.deleted !== 1 ? 's' : ''}`)
        setClearOpen(false)
        setClearFrom('')
        setClearTo('')
        onJobsCleared?.()
      } else {
        const data = await res.json() as { error?: string }
        toast.error('Failed to clear', { description: data.error })
      }
    } catch {
      toast.error('Network error')
    } finally {
      setClearing(false)
    }
  }

  const filtered = useMemo(() => {
    let result = jobs

    if (searchText) {
      const lower = searchText.toLowerCase()
      result = result.filter((j) => j.command.toLowerCase().includes(lower))
    }

    if (statusFilter) {
      result = result.filter((j) => j.status === statusFilter)
    }

    if (dateFrom) {
      const fromDate = new Date(dateFrom)
      result = result.filter((j) => new Date(j.started_at) >= fromDate)
    }

    if (dateTo) {
      const toDate = new Date(dateTo + 'T23:59:59')
      result = result.filter((j) => new Date(j.started_at) <= toDate)
    }

    return result
  }, [jobs, searchText, statusFilter, dateFrom, dateTo])

  const hasFilters = searchText || statusFilter || dateFrom || dateTo

  function clearFilters() {
    setSearchText('')
    setStatusFilter(null)
    setDateFrom('')
    setDateTo('')
  }

  if (isLoading) {
    return (
      <div className="space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 bg-dracula-current/30 rounded-md animate-pulse" />
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/30 p-6 text-center">
        <p className="text-sm text-muted-foreground">No jobs yet</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Jobs will appear here after you run a command
        </p>
      </div>
    )
  }

  return (
    <div className="glass-card rounded-lg overflow-hidden">
      {/* Filters */}
      <div className="px-3 py-2 border-b border-border/30 flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <Input
            placeholder="Filter by command..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="pl-7 h-7 text-xs"
          />
        </div>

        {/* Status filter pills */}
        <div className="flex items-center gap-1">
          <Filter className="w-3 h-3 text-muted-foreground mr-1" />
          {ALL_STATUSES.map((s) => {
            const info = STATUS_BADGE[s]
            const active = statusFilter === s
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(active ? null : s)}
                className={[
                  'px-2 py-0.5 rounded-full text-[10px] font-medium transition-all cursor-pointer',
                  active
                    ? 'bg-primary/20 text-primary ring-1 ring-primary/40'
                    : 'bg-dracula-current/20 text-muted-foreground hover:bg-dracula-current/40',
                ].join(' ')}
              >
                {info.label}
              </button>
            )
          })}
        </div>

        {/* Date range */}
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>From</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-6 px-1.5 rounded bg-dracula-current/30 border border-border/30 text-foreground text-[10px] outline-none focus:ring-1 focus:ring-primary/40"
          />
          <span>To</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-6 px-1.5 rounded bg-dracula-current/30 border border-border/30 text-foreground text-[10px] outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>

        {/* Clear filters + count + purge */}
        <div className="flex items-center gap-2 ml-auto">
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <X className="w-3 h-3" />
              Clear
            </button>
          )}
          <span className="text-[10px] text-muted-foreground">
            {filtered.length} / {jobs.length}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setClearOpen(true)}
                className="h-6 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear job history</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[80px_1fr_130px_130px_70px_70px_90px_50px] gap-2 px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/30 bg-dracula-current/10">
        <span>Status</span>
        <span>Command</span>
        <span>Started</span>
        <span>Finished</span>
        <span>Duration</span>
        <span>Cost</span>
        <span>Tokens</span>
        <span></span>
      </div>

      {/* Rows */}
      {filtered.length === 0 ? (
        <div className="px-3 py-6 text-center">
          <p className="text-xs text-muted-foreground">No jobs match the current filters</p>
        </div>
      ) : (
        filtered.map((job, rowIdx) => {
          const statusInfo = STATUS_BADGE[job.status] ?? STATUS_BADGE.queued
          const cost = formatCost(job.total_cost_usd)

          return (
            <div
              key={job.id}
              onClick={() => onOpenJob?.(job.id)}
              className={[
                'grid grid-cols-[80px_1fr_130px_130px_70px_70px_90px_50px] gap-2 px-3 py-2 items-center hover:bg-accent/50 transition-colors group cursor-pointer',
                rowIdx % 2 === 0 ? 'bg-dracula-current/10' : 'bg-transparent',
              ].join(' ')}
            >
              {/* Status */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
                  </div>
                </TooltipTrigger>
                <TooltipContent>{statusInfo.tooltip}</TooltipContent>
              </Tooltip>

              {/* Command */}
              <code className="text-xs text-foreground/80 truncate font-mono">
                {job.command}
              </code>

              {/* Started */}
              <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
                {formatDateTime(job.started_at)}
              </span>

              {/* Finished */}
              <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
                {formatDateTime(job.finished_at)}
              </span>

              {/* Duration */}
              <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
                {formatDuration(job.duration_ms)}
              </span>

              {/* Cost */}
              <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
                {cost ?? '—'}
              </span>

              {/* Tokens */}
              <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
                {formatTokens(job.tokens_in, job.tokens_out)}
              </span>

              {/* View */}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                tabIndex={-1}
              >
                View
              </Button>
            </div>
          )
        })
      )}

      {/* Clear logs dialog */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="glass-card border-border/30 max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear Job History</DialogTitle>
            <DialogDescription>
              This will permanently delete completed, failed, and canceled jobs. Running and queued jobs are never deleted.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 pt-2">
            {/* Mode selection */}
            <div className="flex gap-2">
              <button
                onClick={() => setClearMode('all')}
                className={[
                  'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer',
                  clearMode === 'all'
                    ? 'bg-destructive/15 text-destructive ring-1 ring-destructive/40'
                    : 'bg-dracula-current/20 text-muted-foreground hover:bg-dracula-current/40',
                ].join(' ')}
              >
                All jobs
              </button>
              <button
                onClick={() => setClearMode('range')}
                className={[
                  'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer',
                  clearMode === 'range'
                    ? 'bg-primary/15 text-primary ring-1 ring-primary/40'
                    : 'bg-dracula-current/20 text-muted-foreground hover:bg-dracula-current/40',
                ].join(' ')}
              >
                Date range
              </button>
            </div>

            {/* Date range inputs */}
            {clearMode === 'range' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground w-10">From</label>
                  <input
                    type="datetime-local"
                    value={clearFrom}
                    onChange={(e) => setClearFrom(e.target.value)}
                    className="flex-1 h-8 px-2 rounded-md bg-dracula-current/30 border border-border/30 text-foreground text-xs outline-none focus:ring-1 focus:ring-primary/40"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground w-10">To</label>
                  <input
                    type="datetime-local"
                    value={clearTo}
                    onChange={(e) => setClearTo(e.target.value)}
                    className="flex-1 h-8 px-2 rounded-md bg-dracula-current/30 border border-border/30 text-foreground text-xs outline-none focus:ring-1 focus:ring-primary/40"
                  />
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setClearOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleClear}
                disabled={clearing || (clearMode === 'range' && !clearFrom && !clearTo)}
              >
                {clearing ? 'Clearing...' : clearMode === 'all' ? 'Clear All' : 'Clear Range'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
