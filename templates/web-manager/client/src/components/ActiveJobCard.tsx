import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getApiBase } from '../lib/api'
import { Loader2, CheckCircle2, XCircle, Clock, DollarSign } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { PhaseMap, PhaseState, QueueJob } from '../hooks/usePipeline'
import type { PhaseDefinition } from '../types'

interface ActiveJobCardProps {
  activeJob: QueueJob | null
  phases: PhaseMap
  phaseDefinitions: PhaseDefinition[]
}

function formatDuration(startedAt: string): string {
  const elapsed = Date.now() - new Date(startedAt).getTime()
  const secs = Math.floor(elapsed / 1000)
  const mins = Math.floor(secs / 60)
  const remaining = secs % 60
  return mins > 0 ? `${mins}m ${remaining}s` : `${secs}s`
}

export function ActiveJobCard({ activeJob, phases, phaseDefinitions }: ActiveJobCardProps) {
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
      const res = await fetch(`${getApiBase()}/jobs/${activeJob.id}`, { method: 'DELETE' })
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
      <Card className="border-dashed">
        <CardContent className="py-8 flex flex-col items-center justify-center gap-2">
          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
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
    <Card className="border-blue-500/30 bg-blue-500/5">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
            <code className="text-xs font-mono text-foreground truncate">{activeJob.command}</code>
          </div>
          <Badge variant="running" className="shrink-0">running</Badge>
        </div>

        {/* Pipeline phases */}
        {phaseDefinitions.length > 0 && (
          <div className="flex items-center gap-1">
            {phaseDefinitions.map((phaseDef, idx) => {
              const state: PhaseState = phases[phaseDef.key] ?? 'idle'
              return (
                <div key={phaseDef.key} className="flex items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] cursor-default"
                        style={{
                          background: state === 'running' ? 'hsl(213 72% 59% / 0.15)'
                            : state === 'done' ? 'hsl(142 71% 45% / 0.1)'
                            : state === 'error' ? 'hsl(0 72% 51% / 0.1)'
                            : 'transparent',
                          color: state === 'running' ? 'hsl(213 72% 59%)'
                            : state === 'done' ? 'hsl(142 71% 45%)'
                            : state === 'error' ? 'hsl(0 72% 51%)'
                            : 'hsl(215 20% 55%)',
                        }}
                      >
                        {state === 'running' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                        {state === 'done' && <CheckCircle2 className="w-2.5 h-2.5" />}
                        {state === 'error' && <XCircle className="w-2.5 h-2.5" />}
                        {state === 'idle' && <div className="w-2.5 h-2.5 rounded-full border border-current opacity-40" />}
                        <span>{phaseDef.label}</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-medium">{phaseDef.label}</p>
                      <p className="text-muted-foreground max-w-[200px]">{phaseDef.description}</p>
                    </TooltipContent>
                  </Tooltip>
                  {idx < phaseDefinitions.length - 1 && (
                    <div className="w-4 h-px bg-border mx-0.5" />
                  )}
                </div>
              )
            })}
          </div>
        )}

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
