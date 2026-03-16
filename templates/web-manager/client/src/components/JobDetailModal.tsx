import { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { getApiBase } from '../lib/api'
import { toast } from 'sonner'
import { X, ExternalLink } from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { PipelineProgress } from './PipelineProgress'
import { LogViewer } from './LogViewer'
import { useWebSocket } from '../hooks/useWebSocket'
import { WS_URL } from '../lib/ws-url'
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

interface JobDetailModalProps {
  jobId: string
  onClose: () => void
}

export function JobDetailModal({ jobId, onClose }: JobDetailModalProps) {
  const [job, setJob] = useState<JobSummary | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [phaseDefinitions, setPhaseDefinitions] = useState<PhaseDefinition[]>([])
  const [phases, setPhases] = useState<PhaseMap>({})
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  // Fetch initial job data + historical events
  useEffect(() => {
    async function loadJob() {
      try {
        const res = await fetch(`${getApiBase()}/jobs/${jobId}`)
        if (res.status === 404) {
          setNotFound(true)
          return
        }
        if (!res.ok) throw new Error('Failed to fetch job')
        const data = await res.json() as { job: JobSummary; events: EventRow[]; phaseDefinitions?: PhaseDefinition[] }
        setJob(data.job)
        setEvents(data.events)
        if (data.phaseDefinitions) {
          setPhaseDefinitions(data.phaseDefinitions)
          const initPhases: PhaseMap = {}
          for (const def of data.phaseDefinitions) {
            initPhases[def.key] = 'idle'
          }
          setPhases(initPhases)
        }
      } catch {
        setNotFound(true)
      } finally {
        setIsLoading(false)
      }
    }
    loadJob()
  }, [jobId])

  // Subscribe to live WebSocket updates
  const handleMessage = useCallback((data: unknown) => {
    const msg = data as { type: string } & Record<string, unknown>

    if (msg.type === 'event' && msg.jobId === jobId) {
      // Use structured events only — ignore 'log' messages to avoid duplicates
      // (the server broadcasts both 'event' and 'log' for each stdout JSON line)
      const eventRow: EventRow = {
        id: Date.now(),
        job_id: jobId,
        seq: 0,
        event_type: msg.event_type as string,
        source: msg.source as string,
        payload: msg.payload as string,
        timestamp: msg.timestamp as string,
      }
      setEvents((prev) => [...prev, eventRow])
    } else if (msg.type === 'log' && msg.processId === jobId && msg.source === 'stderr') {
      // Only handle stderr log messages (stdout is covered by 'event' type above)
      const syntheticEvent: EventRow = {
        id: Date.now(),
        job_id: jobId,
        seq: 0,
        event_type: 'log',
        source: 'stderr',
        payload: JSON.stringify({ line: msg.line }),
        timestamp: msg.timestamp as string,
      }
      setEvents((prev) => [...prev, syntheticEvent])
    } else if (msg.type === 'phase') {
      const phaseName = msg.phase as string
      const phaseState = msg.state as PhaseState
      setPhases((prev) => ({ ...prev, [phaseName]: phaseState }))
    } else if (msg.type === 'queue') {
      const jobs = msg.jobs as Array<{ id: string; status: string }> | undefined
      const matchingJob = jobs?.find((j) => j.id === jobId)
      if (matchingJob && job) {
        setJob((prev) => prev ? { ...prev, status: matchingJob.status as JobSummary['status'] } : prev)
      }
    }
  }, [jobId, job])

  useWebSocket(WS_URL, handleMessage)

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  async function handleCancel() {
    try {
      const res = await fetch(`${getApiBase()}/jobs/${jobId}`, { method: 'DELETE' })
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

  const statusInfo = job ? (STATUS_BADGE[job.status] ?? STATUS_BADGE.queued) : STATUS_BADGE.queued
  const isRunning = job?.status === 'running'

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full m-3 rounded-xl glass-card border border-border/30 flex flex-col animate-in fade-in zoom-in-95 duration-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <div className="flex items-center gap-3 min-w-0">
            {job && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>{statusInfo.tooltip}</TooltipContent>
                </Tooltip>
                <code className="text-xs font-mono text-foreground/80 truncate">{job.command}</code>
                <span className="text-[10px] text-muted-foreground">
                  {formatDistanceToNow(new Date(job.started_at), { addSuffix: true })}
                </span>
                {job.total_cost_usd != null && job.total_cost_usd > 0 && (
                  <span className="text-[10px] text-muted-foreground">${job.total_cost_usd.toFixed(4)}</span>
                )}
                {job.duration_ms != null && (
                  <span className="text-[10px] text-muted-foreground">{(job.duration_ms / 1000).toFixed(1)}s</span>
                )}
              </>
            )}
            {isLoading && <span className="text-xs text-muted-foreground">Loading...</span>}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {/* Pipeline progress inline */}
            {phaseDefinitions.length > 0 && (
              <div className="mr-3">
                <PipelineProgress phases={phases} phaseDefinitions={phaseDefinitions} />
              </div>
            )}

            {isRunning && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                className="h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                Cancel
              </Button>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={`/jobs/${jobId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-dracula-current/50 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </TooltipTrigger>
              <TooltipContent>Open in new tab</TooltipContent>
            </Tooltip>

            <button
              onClick={onClose}
              className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-dracula-current/50 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden relative">
          {notFound ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-muted-foreground">Job not found</p>
            </div>
          ) : (
            <LogViewer events={events} isLoading={isLoading} />
          )}
        </div>
      </div>
    </div>
  )
}
