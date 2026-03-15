import { useRef, useState, type KeyboardEvent } from 'react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-5', label: 'Opus 4.5' },
  { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]

interface ChatInputProps {
  conversationId: string
  model: string
  hasMessages: boolean
  isStreaming: boolean
  onSend: (conversationId: string, text: string) => void
  onAbort: (conversationId: string) => void
}

export function ChatInput({
  conversationId,
  model,
  hasMessages,
  isStreaming,
  onSend,
  onAbort,
}: ChatInputProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleSend() {
    const trimmed = text.trim()
    if (!trimmed || isStreaming) return
    onSend(conversationId, trimmed)
    setText('')
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  function handleInput() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // Clamp to ~4 lines (line-height ~20px)
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`
  }

  return (
    <div className="border-t border-border/30 p-2">
      {/* Model selector */}
      <div className="mb-1.5 flex items-center justify-between">
        <select
          value={model}
          disabled={hasMessages}
          className={cn(
            'rounded bg-transparent text-[10px] text-muted-foreground outline-none',
            'border border-border/20 px-1.5 py-0.5',
            hasMessages && 'opacity-50 cursor-not-allowed'
          )}
          onChange={() => { /* model is per-conversation and locked after first message */ }}
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-background">
              {opt.label}
            </option>
          ))}
        </select>
        {isStreaming && (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px] text-dracula-red hover:text-dracula-red"
            onClick={() => onAbort(conversationId)}
          >
            Stop
          </Button>
        )}
      </div>

      {/* Text input row */}
      <div className="flex items-end gap-1.5">
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={isStreaming}
          placeholder="Message..."
          className={cn(
            'flex-1 resize-none rounded-md border border-border/30 bg-background/60',
            'px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground',
            'focus:outline-none focus:ring-1 focus:ring-dracula-purple/50',
            'disabled:opacity-50',
            'max-h-[80px] overflow-y-auto'
          )}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
        />
        <Button
          size="sm"
          variant="default"
          disabled={!text.trim() || isStreaming}
          className="h-7 shrink-0 px-2.5 text-xs"
          onClick={handleSend}
        >
          Send
        </Button>
      </div>
    </div>
  )
}
