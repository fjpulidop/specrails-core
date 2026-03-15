import { toast } from 'sonner'
import { Play, ArrowRight } from 'lucide-react'
import { Card, CardContent } from './ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { CommandInfo } from '../types'

const COMMAND_ICONS: Record<string, string> = {
  implement: '⚡',
  'batch-implement': '⚡⚡',
  why: '❓',
  'product-backlog': '📋',
  'update-product-driven-backlog': '🔄',
  'refactor-recommender': '🔧',
  'health-check': '🩺',
  'compat-check': '🔍',
}

const WIZARD_COMMANDS = new Set(['implement', 'batch-implement'])

interface CommandGridProps {
  commands: CommandInfo[]
  onOpenWizard: (commandSlug: string) => void
}

async function spawnCommand(command: string): Promise<void> {
  const res = await fetch('/api/spawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: `/sr:${command}` }),
  })
  const data = await res.json() as { jobId?: string; error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Failed to spawn command')
  return
}

export function CommandGrid({ commands, onOpenWizard }: CommandGridProps) {
  if (commands.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted-foreground">No commands found</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Run /setup in Claude Code to install specrails commands
        </p>
      </div>
    )
  }

  async function handleCommandClick(cmd: CommandInfo) {
    if (WIZARD_COMMANDS.has(cmd.slug)) {
      onOpenWizard(cmd.slug)
      return
    }

    try {
      toast.promise(spawnCommand(cmd.slug), {
        loading: `Queuing ${cmd.name}...`,
        success: `${cmd.name} queued`,
        error: (err: Error) => err.message,
      })
    } catch {
      // handled by toast.promise
    }
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {commands.map((cmd) => {
        const isWizard = WIZARD_COMMANDS.has(cmd.slug)
        const icon = COMMAND_ICONS[cmd.slug] ?? '▸'

        return (
          <Tooltip key={cmd.id}>
            <TooltipTrigger asChild>
              <Card
                className="cursor-pointer transition-all hover:border-blue-500/40 hover:bg-blue-500/5 active:scale-[0.98] group"
                onClick={() => handleCommandClick(cmd)}
              >
                <CardContent className="p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-base leading-none">{icon}</span>
                    {isWizard ? (
                      <ArrowRight className="w-3 h-3 text-muted-foreground group-hover:text-blue-400 transition-colors" />
                    ) : (
                      <Play className="w-3 h-3 text-muted-foreground group-hover:text-blue-400 transition-colors opacity-0 group-hover:opacity-100" />
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-medium leading-tight">{cmd.name}</p>
                    {cmd.description && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight line-clamp-2">
                        {cmd.description}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[220px]">
              <p className="font-medium">/sr:{cmd.slug}</p>
              {cmd.description && (
                <p className="text-muted-foreground mt-0.5">{cmd.description}</p>
              )}
              {isWizard && (
                <p className="text-blue-400 mt-1">Opens guided wizard</p>
              )}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
