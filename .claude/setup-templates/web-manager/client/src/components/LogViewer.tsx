import { useEffect, useRef, useState, useCallback } from 'react'
import { Search, ChevronDown } from 'lucide-react'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import type { EventRow } from '../types'

interface FormattedLine {
  id: string
  content: string
  type: 'phase' | 'tool-use' | 'tool-result' | 'assistant' | 'stderr' | 'result' | 'log' | 'plain'
  timestamp?: string
}

function parseEvent(event: EventRow, idx: number): FormattedLine | null {
  const id = `${event.id ?? idx}`
  const timestamp = event.timestamp

  if (event.event_type === 'log') {
    try {
      const payload = JSON.parse(event.payload) as { line?: string }
      const line = payload.line ?? ''
      if (!line.trim()) return null

      // Phase header detection
      if (line.startsWith('▸') || line.match(/^(architect|developer|reviewer|ship)\s*:/i)) {
        return { id, content: line, type: 'phase', timestamp }
      }

      const type = event.source === 'stderr' ? 'stderr' : 'plain'
      return { id, content: line, type, timestamp }
    } catch {
      return null
    }
  }

  if (event.event_type === 'assistant') {
    try {
      const msg = JSON.parse(event.payload) as {
        message?: { content?: Array<{ type: string; text?: string }> }
      }
      const texts = (msg.message?.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')
      if (!texts.trim()) return null
      return { id, content: texts, type: 'assistant', timestamp }
    } catch {
      return { id, content: event.payload.slice(0, 200), type: 'assistant', timestamp }
    }
  }

  if (event.event_type === 'tool_use') {
    try {
      const tool = JSON.parse(event.payload) as { name?: string; input?: unknown }
      const inputStr = JSON.stringify(tool.input ?? {}).slice(0, 100)
      return { id, content: `[${tool.name ?? 'tool'}] ${inputStr}`, type: 'tool-use', timestamp }
    } catch {
      return null
    }
  }

  if (event.event_type === 'tool_result') {
    return null // Skip tool results — they're verbose
  }

  if (event.event_type === 'result') {
    try {
      const result = JSON.parse(event.payload) as {
        total_cost_usd?: number
        num_turns?: number
        duration_ms?: number
      }
      const parts: string[] = []
      if (result.duration_ms) parts.push(`${(result.duration_ms / 1000).toFixed(1)}s`)
      if (result.total_cost_usd) parts.push(`$${result.total_cost_usd.toFixed(4)}`)
      if (result.num_turns) parts.push(`${result.num_turns} turns`)
      return {
        id,
        content: `▸ Completed${parts.length ? ` — ${parts.join(' · ')}` : ''}`,
        type: 'result',
        timestamp,
      }
    } catch {
      return null
    }
  }

  return null
}

interface LogViewerProps {
  events: EventRow[]
  isLoading?: boolean
}

export function LogViewer({ events, isLoading }: LogViewerProps) {
  const [filter, setFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const lines = events
    .map((ev, idx) => parseEvent(ev, idx))
    .filter((l): l is FormattedLine => l !== null)

  const filtered = filter
    ? lines.filter((l) => l.content.toLowerCase().includes(filter.toLowerCase()))
    : lines

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    if (autoScroll) {
      scrollToBottom()
    }
  }, [events.length, autoScroll, scrollToBottom])

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    setAutoScroll(isAtBottom)
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">Loading logs...</p>
      </div>
    )
  }

  if (lines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">No log output yet</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="px-4 py-2 border-b border-border flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <Input
            placeholder="Filter logs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-7 h-7"
          />
        </div>
        <span className="text-[10px] text-muted-foreground ml-auto">
          {filtered.length} / {lines.length} lines
        </span>
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-0.5 relative"
        onScroll={handleScroll}
      >
        {filtered.map((line) => (
          <LogLine key={line.id} line={line} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Jump to bottom button */}
      {!autoScroll && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => { setAutoScroll(true); scrollToBottom() }}
          className="absolute bottom-16 right-6 h-7 gap-1 shadow-lg"
        >
          <ChevronDown className="w-3 h-3" />
          Jump to bottom
        </Button>
      )}
    </div>
  )
}

function LogLine({ line }: { line: FormattedLine }) {
  return (
    <div className="flex items-start gap-2 group">
      {line.timestamp && (
        <span className="text-[10px] text-muted-foreground/40 shrink-0 mt-px w-[65px]">
          {new Date(line.timestamp).toLocaleTimeString('en', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          })}
        </span>
      )}
      <span
        className={cn(
          'flex-1 break-all leading-relaxed whitespace-pre-wrap',
          line.type === 'phase' && 'text-foreground font-semibold',
          line.type === 'tool-use' && 'text-cyan-400',
          line.type === 'assistant' && 'text-foreground/80',
          line.type === 'stderr' && 'text-orange-400',
          line.type === 'result' && 'text-emerald-400 font-medium',
          line.type === 'log' && 'text-foreground/60',
          line.type === 'plain' && 'text-foreground/70',
          line.type === 'tool-result' && 'text-muted-foreground/50'
        )}
      >
        {line.content}
      </span>
    </div>
  )
}
