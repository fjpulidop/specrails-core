import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '../lib/utils'
import { CommandProposal } from './CommandProposal'
import type { ChatMessage } from '../types'

interface MessageBubbleProps {
  message: ChatMessage
  onConfirmCommand: (command: string) => void
  onDismissCommand: (command: string) => void
}

// Split content into alternating text/command segments
function splitCommandBlocks(text: string): Array<{ type: 'text' | 'command'; content: string }> {
  const segments: Array<{ type: 'text' | 'command'; content: string }> = []
  const regex = /:::command\s*\n([\s\S]*?):::/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'command', content: match[1].trim() })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) })
  }

  return segments
}

export function MessageBubble({ message, onConfirmCommand, onDismissCommand }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  if (isUser) {
    return (
      <div className="flex justify-end px-3 py-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-dracula-purple/20 px-3 py-2 text-xs text-foreground">
          {message.content}
        </div>
      </div>
    )
  }

  // Assistant message: split out command blocks, render rest as markdown
  const segments = splitCommandBlocks(message.content)

  return (
    <div className="flex justify-start px-3 py-1">
      <div className={cn(
        'max-w-[95%] rounded-2xl rounded-bl-sm bg-dracula-current/30 px-3 py-2 text-xs',
        'prose prose-invert prose-xs max-w-none',
        '[&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-dracula-cyan',
        '[&_pre]:rounded [&_pre]:bg-background/60 [&_pre]:p-2',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_a]:text-dracula-cyan',
        '[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5',
      )}>
        {segments.map((seg, i) => {
          if (seg.type === 'command') {
            return (
              <CommandProposal
                key={i}
                command={seg.content}
                onRun={onConfirmCommand}
                onDismiss={onDismissCommand}
              />
            )
          }
          const trimmed = seg.content.trim()
          if (!trimmed) return null
          return (
            <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
              {trimmed}
            </ReactMarkdown>
          )
        })}
      </div>
    </div>
  )
}
