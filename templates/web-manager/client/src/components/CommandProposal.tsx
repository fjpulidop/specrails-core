import { useState } from 'react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

interface CommandProposalProps {
  command: string
  onRun: (command: string) => void
  onDismiss: (command: string) => void
}

export function CommandProposal({ command, onRun, onDismiss }: CommandProposalProps) {
  const [ran, setRan] = useState(false)

  function handleRun() {
    setRan(true)
    onRun(command)
  }

  return (
    <div className="my-2 rounded-md border border-dracula-purple/30 bg-dracula-purple/10 p-2.5 text-xs">
      <div className="mb-2 font-medium text-dracula-purple">Suggested command</div>
      <pre className="mb-2 overflow-x-auto rounded bg-background/60 px-2 py-1 font-mono text-dracula-cyan">
        {command}
      </pre>
      <div className="flex items-center gap-2">
        {ran ? (
          <span className="rounded bg-dracula-green/20 px-2 py-0.5 text-dracula-green">Queued</span>
        ) : (
          <>
            <Button
              size="sm"
              variant="default"
              className={cn('h-6 px-2 text-xs')}
              onClick={handleRun}
            >
              Run
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => onDismiss(command)}
            >
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
