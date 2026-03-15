import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, CheckCircle2, XCircle, Clock, DollarSign } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { PhaseMap, QueueJob } from '../hooks/usePipeline'

const PHASES: Array<{ key: keyof PhaseMap; label: string; description: string }> = [
  { key: 'architect', label: 'Architect', description: 'Analyzes requirements and designs the solution approach' },
  { key: 'developer', label: 'Developer', description: 'Implements the changes across all relevant files' },
  { key: 'reviewer', label: 'Reviewer', description: 'Reviews the implementation for quality and correctness' },
  { key: 'ship', label: 'Ship', description: 'Creates the PR and finalizes the changes' },
]

interface ActiveJobCardProps {
  activeJob: QueueJob | null
  phases: PhaseMap
}

function formatDuration(startedAt: string): string {
  const elapsed = Date.now() - new Date(startedAt).getTime()
  const secs = Math.floor(elapsed / 1000)
  const mins = Math.floor(secs / 60)
  const remaining = secs % 60
  return mins > 0 ? `${mins}m ${remaining}s` : `${secs}s`
}

export function ActiveJobCard({ activeJob, phases }: ActiveJobCardProps) {
  const [elapsed, setElapsed] = useState<string>('')

  useEffect(() => {
    if (!activeJob?.startedAt) return
    const update = () => setElapsed(formatDuration(activeJob.startedAt!))
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [activeJob?.startedAt])

  async function handleCancel() {
    if (!activeJob) return
    try {
      const res = await fetch(`/api/jobs/${activeJob.id}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success('Job cancellation requested', {
          description: 'Sending SIGTERM to the process',
        })
      } else {
        const data = await res.json() as { error?: string }
        toast.error('Failed to cancel job', { description: data.error })
      }
    } catch {
      toast.error('Network error canceling job')
    }
  }

  if (!activeJob) {
    return (
      <Card className="glass-card border-dashed">
        <CardContent className="py-8 flex flex-col items-center justify-center gap-2">
          <div className="w-8 h-8 rounded-full bg-dracula-current/30 flex items-center justify-center">
            <Clock className="w-4 h-4 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">No active job</p>
          <p className="text-xs text-muted-foreground/60">
            Select a command below to start a job
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="glass-card border-dracula-purple/30 hover:glow-purple transition-all">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Loader2 className="w-4 h-4 text-dracula-purple animate-spin shrink-0" />
            <code className="text-xs font-mono text-foreground truncate">{activeJob.command}</code>
          </div>
          <Badge variant="running" className="shrink-0">running</Badge>
        </div>

        {/* Pipeline phases */}
        <div className="flex items-center gap-1">
          {PHASES.map((phase, idx) => {
            const state = phases[phase.key]
            return (
              <div key={phase.key} className="flex items-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className={[
                        'flex items-center gap-1 px-2 py-1 rounded text-[10px] cursor-default',
                        state === 'running' && 'bg-dracula-purple/15 text-dracula-purple',
                        state === 'done' && 'bg-dracula-green/10 text-dracula-green',
                        state === 'error' && 'bg-dracula-red/10 text-dracula-red',
                        state === 'idle' && 'text-dracula-comment/60',
                      ].filter(Boolean).join(' ')}
                    >
                      {state === 'running' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                      {state === 'done' && <CheckCircle2 className="w-2.5 h-2.5" />}
                      {state === 'error' && <XCircle className="w-2.5 h-2.5" />}
                      {state === 'idle' && <div className="w-2.5 h-2.5 rounded-full border border-current opacity-30" />}
                      <span>{phase.label}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">{phase.label}</p>
                    <p className="text-muted-foreground max-w-[200px]">{phase.description}</p>
                  </TooltipContent>
                </Tooltip>
                {idx < PHASES.length - 1 && (
                  <div className="w-4 h-px bg-border/30 mx-0.5" />
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <span>{elapsed}</span>
            </div>
            {activeJob.exitCode !== null && (
              <div className="flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                <span>exit {activeJob.exitCode}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancel}
                  className="h-6 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  Cancel
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Send SIGTERM to the running claude process
              </TooltipContent>
            </Tooltip>

            <Button variant="outline" size="sm" asChild className="h-6 px-2">
              <Link to={`/jobs/${activeJob.id}`}>View Logs</Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
