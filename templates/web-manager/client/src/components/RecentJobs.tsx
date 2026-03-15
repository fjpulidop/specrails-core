import { useNavigate } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { Badge } from './ui/badge'
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

function formatCost(cost: number | null | undefined): string | null {
  if (cost == null || cost === 0) return null
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(3)}`
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
}

export function RecentJobs({ jobs, isLoading }: RecentJobsProps) {
  const navigate = useNavigate()
  if (isLoading) {
    return (
      <div className="space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 bg-muted/30 rounded-md animate-pulse" />
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center">
        <p className="text-sm text-muted-foreground">No jobs yet</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Jobs will appear here after you run a command
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {jobs.map((job) => {
        const statusInfo = STATUS_BADGE[job.status] ?? STATUS_BADGE.queued
        const cost = formatCost(job.total_cost_usd)

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
              {cost && <span>{cost}</span>}
              <span>{formatRelTime(job.started_at)}</span>
            </div>

          </div>
        )
      })}
    </div>
  )
}
