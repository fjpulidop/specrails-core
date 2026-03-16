import { useReducer } from 'react'
import { toast } from 'sonner'
import { getApiBase } from '../lib/api'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/dialog'
import { Button } from './ui/button'
import { IssuePickerStep, BatchFreeFormStep } from './IssuePickerStep'
import { cn } from '../lib/utils'

type WizardPath = 'from-issues' | 'free-form' | null

interface BatchWizardState {
  path: WizardPath
  selectedIssues: number[]
  freeFormItems: Array<{ title: string; description: string }>
}

type BatchWizardAction =
  | { type: 'SELECT_PATH'; path: WizardPath }
  | { type: 'SET_ISSUES'; issues: number[] }
  | { type: 'SET_ITEMS'; items: Array<{ title: string; description: string }> }
  | { type: 'RESET' }

function batchWizardReducer(state: BatchWizardState, action: BatchWizardAction): BatchWizardState {
  switch (action.type) {
    case 'SELECT_PATH':
      return { ...state, path: action.path }
    case 'SET_ISSUES':
      return { ...state, selectedIssues: action.issues }
    case 'SET_ITEMS':
      return { ...state, freeFormItems: action.items }
    case 'RESET':
      return { path: null, selectedIssues: [], freeFormItems: [{ title: '', description: '' }] }
    default:
      return state
  }
}

interface BatchImplementWizardProps {
  open: boolean
  onClose: () => void
}

export function BatchImplementWizard({ open, onClose }: BatchImplementWizardProps) {
  const [state, dispatch] = useReducer(batchWizardReducer, {
    path: null,
    selectedIssues: [],
    freeFormItems: [{ title: '', description: '' }],
  })

  function handleClose() {
    dispatch({ type: 'RESET' })
    onClose()
  }

  async function handleSubmit() {
    let command: string

    if (state.path === 'from-issues') {
      if (state.selectedIssues.length === 0) {
        toast.error('Please select at least one issue')
        return
      }
      command = `/sr:batch-implement ${state.selectedIssues.map((n) => `#${n}`).join(' ')}`
    } else {
      const validItems = state.freeFormItems.filter((item) => item.title.trim())
      if (validItems.length === 0) {
        toast.error('Please enter at least one feature title')
        return
      }
      const featureList = validItems
        .map((item) => `- ${item.title.trim()}${item.description.trim() ? `: ${item.description.trim()}` : ''}`)
        .join('\n')
      command = `/sr:batch-implement\n${featureList}`
    }

    try {
      const res = await fetch(`${getApiBase()}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      })
      const data = await res.json() as { jobId?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to queue job')
      toast.success('Batch job queued', {
        description: `${state.path === 'from-issues' ? state.selectedIssues.length : state.freeFormItems.filter((i) => i.title.trim()).length} features`,
      })
      handleClose()
    } catch (err) {
      toast.error('Failed to queue job', { description: (err as Error).message })
    }
  }

  const canSubmit = state.path === 'from-issues'
    ? state.selectedIssues.length > 0
    : state.freeFormItems.some((item) => item.title.trim())

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-2xl glass-card">
        <DialogHeader>
          <DialogTitle>Batch Implement</DialogTitle>
        </DialogHeader>

        {/* Path selection */}
        {!state.path && (
          <div className="grid grid-cols-2 gap-3 py-2">
            <BatchPathCard
              icon="🎯"
              title="From Issues"
              description="Select multiple issues from your tracker"
              onClick={() => dispatch({ type: 'SELECT_PATH', path: 'from-issues' })}
            />
            <BatchPathCard
              icon="📝"
              title="Free Form"
              description="Describe multiple features"
              onClick={() => dispatch({ type: 'SELECT_PATH', path: 'free-form' })}
            />
          </div>
        )}

        {/* Issue picker (multi-select) */}
        {state.path === 'from-issues' && (
          <IssuePickerStep
            multiSelect={true}
            selectedIssues={state.selectedIssues}
            onSelectionChange={(issues) => dispatch({ type: 'SET_ISSUES', issues })}
          />
        )}

        {/* Batch free form */}
        {state.path === 'free-form' && (
          <BatchFreeFormStep
            items={state.freeFormItems}
            onItemsChange={(items) => dispatch({ type: 'SET_ITEMS', items })}
          />
        )}

        {state.path && (
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dispatch({ type: 'SELECT_PATH', path: null })}
            >
              Back
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
              Queue Batch Job
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BatchPathCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: string
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col gap-2 p-4 rounded-lg border border-border/30 text-left glass-card',
        'hover:border-dracula-purple/40 hover:bg-dracula-current/30 transition-all active:scale-[0.98]'
      )}
    >
      <span className="text-xl">{icon}</span>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </button>
  )
}
