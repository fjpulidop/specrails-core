import { CheckCircle2, Loader2, XCircle, Circle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { PhaseMap, PhaseState } from '../hooks/usePipeline'

interface PhaseSpec {
  key: keyof PhaseMap
  label: string
  description: string
}

const PHASES: PhaseSpec[] = [
  {
    key: 'architect',
    label: 'Architect',
    description: 'Analyzes the issue, researches the codebase, and designs the implementation plan',
  },
  {
    key: 'developer',
    label: 'Developer',
    description: 'Implements the changes: writes code, edits files, runs tests',
  },
  {
    key: 'reviewer',
    label: 'Reviewer',
    description: 'Reviews the implementation for correctness, edge cases, and code quality',
  },
  {
    key: 'ship',
    label: 'Ship',
    description: 'Creates the PR, writes the description, and finalizes the changes for merge',
  },
]

interface PipelineProgressProps {
  phases: PhaseMap
}

export function PipelineProgress({ phases }: PipelineProgressProps) {
  return (
    <div className="flex items-center">
      {PHASES.map((phase, idx) => {
        const state: PhaseState = phases[phase.key]
        return (
          <div key={phase.key} className="flex items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex flex-col items-center gap-1 cursor-default px-3">
                  <PhaseIcon state={state} />
                  <span
                    className="text-[10px] font-medium"
                    style={{
                      color:
                        state === 'running' ? 'hsl(213 72% 59%)'
                          : state === 'done' ? 'hsl(142 71% 45%)'
                          : state === 'error' ? 'hsl(0 72% 51%)'
                          : 'hsl(215 20% 55%)',
                    }}
                  >
                    {phase.label}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[200px]">
                <p className="font-medium">{phase.label}</p>
                <p className="text-muted-foreground mt-0.5">{phase.description}</p>
              </TooltipContent>
            </Tooltip>

            {idx < PHASES.length - 1 && (
              <div
                className="h-px w-8 -mt-4 shrink-0"
                style={{
                  background: phases[PHASES[idx + 1].key] !== 'idle' || state === 'done'
                    ? 'hsl(142 71% 45% / 0.4)'
                    : 'hsl(217 33% 17%)',
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function PhaseIcon({ state }: { state: PhaseState }) {
  if (state === 'running') return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
  if (state === 'done') return <CheckCircle2 className="w-4 h-4 text-emerald-400" />
  if (state === 'error') return <XCircle className="w-4 h-4 text-red-400" />
  return <Circle className="w-4 h-4 text-muted-foreground/30" />
}
