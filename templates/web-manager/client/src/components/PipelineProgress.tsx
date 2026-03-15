import { CheckCircle2, Loader2, XCircle, Circle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { PhaseDefinition } from '../types'
import type { PhaseMap, PhaseState } from '../hooks/usePipeline'

interface PipelineProgressProps {
  phases: PhaseMap
  phaseDefinitions: PhaseDefinition[]
}

export function PipelineProgress({ phases, phaseDefinitions }: PipelineProgressProps) {
  if (phaseDefinitions.length === 0) return null

  return (
    <div className="flex items-center">
      {phaseDefinitions.map((phaseDef, idx) => {
        const state: PhaseState = phases[phaseDef.key] ?? 'idle'
        return (
          <div key={phaseDef.key} className="flex items-center">
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
                    {phaseDef.label}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[200px]">
                <p className="font-medium">{phaseDef.label}</p>
                <p className="text-muted-foreground mt-0.5">{phaseDef.description}</p>
              </TooltipContent>
            </Tooltip>

            {idx < phaseDefinitions.length - 1 && (
              <div
                className="h-px w-8 -mt-4 shrink-0"
                style={{
                  background: phases[phaseDefinitions[idx + 1].key] !== 'idle' || state === 'done'
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
