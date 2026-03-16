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
import { IssuePickerStep, FreeFormStep } from './IssuePickerStep'
import { cn } from '../lib/utils'

type WizardPath = 'from-issues' | 'free-form' | null

interface WizardState {
  path: WizardPath
  selectedIssues: number[]
  freeFormTitle: string
  freeFormDescription: string
}

type WizardAction =
  | { type: 'SELECT_PATH'; path: WizardPath }
  | { type: 'SET_ISSUES'; issues: number[] }
  | { type: 'SET_TITLE'; title: string }
  | { type: 'SET_DESCRIPTION'; desc: string }
  | { type: 'RESET' }

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'SELECT_PATH':
      return { ...state, path: action.path }
    case 'SET_ISSUES':
      return { ...state, selectedIssues: action.issues }
    case 'SET_TITLE':
      return { ...state, freeFormTitle: action.title }
    case 'SET_DESCRIPTION':
      return { ...state, freeFormDescription: action.desc }
    case 'RESET':
      return { path: null, selectedIssues: [], freeFormTitle: '', freeFormDescription: '' }
    default:
      return state
  }
}

interface ImplementWizardProps {
  open: boolean
  onClose: () => void
}

export function ImplementWizard({ open, onClose }: ImplementWizardProps) {
  const [state, dispatch] = useReducer(wizardReducer, {
    path: null,
    selectedIssues: [],
    freeFormTitle: '',
    freeFormDescription: '',
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
      const issueArgs = state.selectedIssues.map((n) => `#${n}`).join(' ')
      command = `/sr:implement ${issueArgs}`
    } else {
      if (!state.freeFormTitle.trim()) {
        toast.error('Please enter a feature title')
        return
      }
      const desc = state.freeFormDescription.trim()
      command = `/sr:implement ${state.freeFormTitle.trim()}${desc ? `\n\n${desc}` : ''}`
    }

    try {
      const res = await fetch(`${getApiBase()}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      })
      const data = await res.json() as { jobId?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to queue job')
      toast.success('Job queued', { description: command })
      handleClose()
    } catch (err) {
      toast.error('Failed to queue job', { description: (err as Error).message })
    }
  }

  const canSubmit = state.path === 'from-issues'
    ? state.selectedIssues.length > 0
    : state.freeFormTitle.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-2xl glass-card">
        <DialogHeader>
          <DialogTitle>Implement Feature</DialogTitle>
        </DialogHeader>

        {/* Path selection */}
        {!state.path && (
          <div className="grid grid-cols-2 gap-3 py-2">
            <PathCard
              icon="🎯"
              title="From Issues"
              description="Pick from your issue tracker"
              onClick={() => dispatch({ type: 'SELECT_PATH', path: 'from-issues' })}
            />
            <PathCard
              icon="✏️"
              title="Free Form"
              description="Describe the feature directly"
              onClick={() => dispatch({ type: 'SELECT_PATH', path: 'free-form' })}
            />
          </div>
        )}

        {/* Issue picker */}
        {state.path === 'from-issues' && (
          <IssuePickerStep
            multiSelect={true}
            selectedIssues={state.selectedIssues}
            onSelectionChange={(issues) => dispatch({ type: 'SET_ISSUES', issues })}
          />
        )}

        {/* Free form */}
        {state.path === 'free-form' && (
          <FreeFormStep
            title={state.freeFormTitle}
            description={state.freeFormDescription}
            onTitleChange={(title) => dispatch({ type: 'SET_TITLE', title })}
            onDescriptionChange={(desc) => dispatch({ type: 'SET_DESCRIPTION', desc })}
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
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {state.path === 'from-issues' && state.selectedIssues.length > 1
                ? `Queue ${state.selectedIssues.length} Jobs`
                : 'Queue Job'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface PathCardProps {
  icon: string
  title: string
  description: string
  onClick: () => void
}

function PathCard({ icon, title, description, onClick }: PathCardProps) {
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
