import { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getApiBase } from '../lib/api'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { ChevronRight, Home } from 'lucide-react'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { PipelineProgress } from '../components/PipelineProgress'
import { LogViewer } from '../components/LogViewer'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import type { JobSummary, EventRow, PhaseDefinition } from '../types'
import type { PhaseMap, PhaseState } from '../hooks/usePipeline'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'running' | 'queued' | 'failed' | 'canceled'

const STATUS_BADGE: Record<string, { variant: BadgeVariant; label: string; tooltip: string }> = {
  running: { variant: 'running', label: 'running', tooltip: 'Job is actively executing' },
  completed: { variant: 'success', label: 'completed', tooltip: 'Job completed successfully' },
  failed: { variant: 'failed', label: 'failed', tooltip: 'Job exited with a non-zero code' },
  canceled: { variant: 'canceled', label: 'canceled', tooltip: 'Job was manually canceled' },
  queued: { variant: 'queued', label: 'queued', tooltip: 'Job is waiting in the queue' },
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [job, setJob] = useState<JobSummary | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [phaseDefinitions, setPhaseDefinitions] = useState<PhaseDefinition[]>([])
  const [phases, setPhases] = useState<PhaseMap>({})
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  // Fetch initial job data + historical events
  useEffect(() => {
    if (!id) return
    async function loadJob() {
      try {
        const res = await fetch(`${getApiBase()}/jobs/${id}`)
        if (res.status === 404) {
          setNotFound(true)
          return
        }
        if (!res.ok) throw new Error('Failed to fetch job')
        const data = await res.json() as { job: JobSummary; events: EventRow[] }
        setJob(data.job)
        setEvents(data.events)
      } catch {
        setNotFound(true)
      } finally {
        setIsLoading(false)
      }
    }
    loadJob()
  }, [id])

  // Subscribe to live WebSocket updates for this job
  const handleMessage = useCallback((data: unknown) => {
    const msg = data as { type: string } & Record<string, unknown>

    if (msg.type === 'init') {
      const defs = (msg.phaseDefinitions ?? []) as PhaseDefinition[]
      setPhaseDefinitions(defs)
      const initPhases: PhaseMap = {}
      for (const def of defs) {
        initPhases[def.key] = ((msg.phases as Record<string, string>)?.[def.key] as PhaseState) ?? 'idle'
      }
      setPhases(initPhases)
    } else if (msg.type === 'log' && msg.processId === id) {
      // Live log lines — the server also emits 'event' messages for the same
      // content but those are redundant during streaming (they're useful for
      // the initial DB load where 'log' messages aren't stored separately).
      const syntheticEvent: EventRow = {
        id: Date.now(),
        job_id: id ?? '',
        seq: 0,
        event_type: 'log',
        source: msg.source as string,
        payload: JSON.stringify({ line: msg.line }),
        timestamp: msg.timestamp as string,
      }
      setEvents((prev) => [...prev, syntheticEvent])
    } else if (msg.type === 'phase') {
      const phaseName = msg.phase as string
      const phaseState = msg.state as PhaseState
      setPhases((prev) => ({ ...prev, [phaseName]: phaseState }))
    } else if (msg.type === 'queue') {
      // Refresh job status from queue state
      const jobs = msg.jobs as Array<{ id: string; status: string }> | undefined
      const matchingJob = jobs?.find((j) => j.id === id)
      if (matchingJob) {
        setJob((prev) => prev ? { ...prev, status: matchingJob.status as JobSummary['status'] } : prev)
      }
    }
  }, [id])

  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  useEffect(() => {
    registerHandler(`job-detail-${id}`, handleMessage)
    return () => unregisterHandler(`job-detail-${id}`)
  }, [id, handleMessage, registerHandler, unregisterHandler])

  async function handleCancel() {
    if (!id) return
    try {
      const res = await fetch(`${getApiBase()}/jobs/${id}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success('Cancel signal sent', { description: 'Job will stop at the next safe point' })
      } else {
        const data = await res.json() as { error?: string }
        toast.error('Failed to cancel', { description: data.error })
      }
    } catch {
      toast.error('Network error')
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="space-y-3">
          <div className="h-4 w-48 bg-muted/30 rounded animate-pulse" />
          <div className="h-20 bg-muted/30 rounded-lg animate-pulse" />
          <div className="h-64 bg-muted/30 rounded-lg animate-pulse" />
        </div>
      </div>
    )
  }

  if (notFound || !job) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6 flex flex-col items-center gap-3 mt-12">
        <p className="text-lg font-semibold">Job not found</p>
        <p className="text-sm text-muted-foreground">The job ID "{id}" doesn't exist</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/">
            <Home className="w-3.5 h-3.5 mr-1.5" />
            Back to Dashboard
          </Link>
        </Button>
      </div>
    )
  }

  const statusInfo = STATUS_BADGE[job.status] ?? STATUS_BADGE.queued
  const isRunning = job.status === 'running'

  return (
    <div className="flex flex-col h-full max-w-5xl mx-auto w-full">
      {/* Header */}
      <div className="px-4 py-4 border-b border-border space-y-3">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground transition-colors flex items-center gap-1">
            <Home className="w-3 h-3" />
            Dashboard
          </Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-mono">Job #{id?.slice(0, 8)}</span>
        </div>

        {/* Job info */}
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
                  </div>
                </TooltipTrigger>
                <TooltipContent>{statusInfo.tooltip}</TooltipContent>
              </Tooltip>
              <code className="text-xs font-mono text-foreground/80 truncate">{job.command}</code>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span>Started {formatDistanceToNow(new Date(job.started_at), { addSuffix: true })}</span>
              {job.total_cost_usd && <span>${job.total_cost_usd.toFixed(4)}</span>}
              {job.duration_ms && <span>{(job.duration_ms / 1000).toFixed(1)}s</span>}
              {job.model && <span>{job.model}</span>}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {isRunning && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancel}
                    className="h-7 border-destructive/30 text-destructive hover:bg-destructive/10"
                  >
                    Cancel Job
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Send SIGTERM to the running process. The job will be marked as canceled.
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Pipeline progress */}
        <PipelineProgress phases={phases} phaseDefinitions={phaseDefinitions} />
      </div>

      {/* Log viewer */}
      <div className="flex-1 overflow-hidden relative">
        <LogViewer events={events} />
      </div>
    </div>
  )
}
