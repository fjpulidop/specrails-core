import { useState } from 'react'
import { toast } from 'sonner'
import { getApiBase } from '../lib/api'
import {
  Rocket,
  Layers,
  ClipboardList,
  ChevronRight,
  Sparkles,
  Wrench,
  HeartPulse,
  Shield,
  HelpCircle,
  Play,
  ArrowRight,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { cn } from '../lib/utils'
import type { CommandInfo } from '../types'

const COMMAND_META: Record<string, { icon: LucideIcon; color: string; glow: string }> = {
  implement: {
    icon: Rocket,
    color: 'text-dracula-purple',
    glow: 'hover:glow-purple hover:border-dracula-purple/40',
  },
  'batch-implement': {
    icon: Layers,
    color: 'text-dracula-pink',
    glow: 'hover:glow-pink hover:border-dracula-pink/40',
  },
  'product-backlog': {
    icon: ClipboardList,
    color: 'text-dracula-cyan',
    glow: 'hover:glow-cyan hover:border-dracula-cyan/40',
  },
  'update-product-driven-backlog': {
    icon: Sparkles,
    color: 'text-dracula-green',
    glow: 'hover:glow-green hover:border-dracula-green/40',
  },
  'refactor-recommender': {
    icon: Wrench,
    color: 'text-dracula-orange',
    glow: 'hover:glow-orange hover:border-dracula-orange/40',
  },
  'health-check': {
    icon: HeartPulse,
    color: 'text-dracula-green',
    glow: 'hover:glow-green hover:border-dracula-green/40',
  },
  'compat-check': {
    icon: Shield,
    color: 'text-dracula-yellow',
    glow: 'hover:glow-yellow hover:border-dracula-yellow/40',
  },
  why: {
    icon: HelpCircle,
    color: 'text-muted-foreground',
    glow: 'hover:glow-purple hover:border-dracula-purple/40',
  },
}

const FALLBACK_META = {
  icon: Play,
  color: 'text-dracula-purple',
  glow: 'hover:glow-purple hover:border-dracula-purple/40',
}

const WIZARD_COMMANDS = new Set(['implement', 'batch-implement'])

interface CommandGridProps {
  commands: CommandInfo[]
  onOpenWizard: (commandSlug: string) => void
}

async function spawnCommand(command: string): Promise<void> {
  const res = await fetch(`${getApiBase()}/spawn`, {
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
      <div className="rounded-lg border border-dashed border-border/30 p-8 text-center">
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

  const DISCOVERY_SLUGS = new Set(['product-backlog', 'update-product-driven-backlog'])
  const DELIVERY_SLUGS = new Set(['implement', 'batch-implement'])

  const discovery = commands.filter((c) => DISCOVERY_SLUGS.has(c.slug))
  const delivery = commands.filter((c) => DELIVERY_SLUGS.has(c.slug))
  const others = commands
    .filter((c) => !DISCOVERY_SLUGS.has(c.slug) && !DELIVERY_SLUGS.has(c.slug))
    .sort((a, b) => a.name.localeCompare(b.name))

  const [othersOpen, setOthersOpen] = useState(false)

  const sections: { label: string; commands: CommandInfo[]; collapsible?: boolean }[] = [
    { label: 'Discovery', commands: discovery },
    { label: 'Delivery', commands: delivery },
    { label: 'Others', commands: others, collapsible: true },
  ].filter((s) => s.commands.length > 0)

  return (
    <div className="space-y-4">
      {sections.map((section) => {
        const isCollapsed = section.collapsible && !othersOpen
        return (
        <div key={section.label}>
          {section.collapsible ? (
            <button
              type="button"
              onClick={() => setOthersOpen(!othersOpen)}
              className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2 hover:text-foreground transition-colors cursor-pointer"
            >
              <ChevronRight className={cn('w-3 h-3 transition-transform', othersOpen && 'rotate-90')} />
              {section.label} ({section.commands.length})
            </button>
          ) : (
            <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
              {section.label}
            </h3>
          )}
          {!isCollapsed && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {section.commands.map((cmd) => {
              const isWizard = WIZARD_COMMANDS.has(cmd.slug)
              const meta = COMMAND_META[cmd.slug] ?? FALLBACK_META
              const Icon = meta.icon

              return (
                <Tooltip key={cmd.id}>
                  <TooltipTrigger asChild>
                    <button
                      className={[
                        'glass-card cursor-pointer transition-all active:scale-[0.98] group',
                        'flex items-center gap-3 px-4 py-3 text-left w-full',
                        meta.glow,
                      ].join(' ')}
                      onClick={() => handleCommandClick(cmd)}
                    >
                      {/* Icon */}
                      <div className={[
                        'flex items-center justify-center w-9 h-9 rounded-lg shrink-0 transition-colors',
                        'bg-dracula-current/40 group-hover:bg-dracula-current/60',
                      ].join(' ')}>
                        <Icon className={`w-4.5 h-4.5 ${meta.color}`} />
                      </div>

                      {/* Text */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium leading-tight truncate">{cmd.name}</p>
                        {cmd.description && (
                          <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight line-clamp-1">
                            {cmd.description}
                          </p>
                        )}
                      </div>

                      {/* Action hint */}
                      {isWizard ? (
                        <ArrowRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-dracula-purple transition-colors shrink-0" />
                      ) : (
                        <Play className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-dracula-cyan transition-colors shrink-0 opacity-0 group-hover:opacity-100" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[240px]">
                    <p className="font-medium font-mono text-[11px]">/sr:{cmd.slug}</p>
                    {cmd.description && (
                      <p className="text-muted-foreground mt-0.5">{cmd.description}</p>
                    )}
                    {isWizard && (
                      <p className="text-dracula-purple mt-1 text-[10px]">Opens guided wizard</p>
                    )}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
          )}
        </div>
        )
      })}
    </div>
  )
}
