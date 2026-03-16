import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getApiBase } from '../lib/api'
import { Search, AlertCircle } from 'lucide-react'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import type { IssueItem } from '../types'

interface IssuePickerStepProps {
  multiSelect?: boolean
  selectedIssues: number[]
  onSelectionChange: (selected: number[]) => void
}

export function IssuePickerStep({ multiSelect = false, selectedIssues, onSelectionChange }: IssuePickerStepProps) {
  const [issues, setIssues] = useState<IssueItem[]>([])
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isNoTracker, setIsNoTracker] = useState(false)

  useEffect(() => {
    async function loadIssues() {
      setIsLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (search) params.set('search', search)
        const res = await fetch(`${getApiBase()}/issues?${params.toString()}`)
        if (res.status === 503) {
          setIsNoTracker(true)
          return
        }
        if (!res.ok) throw new Error('Failed to fetch issues')
        const data = await res.json() as IssueItem[]
        setIssues(data)
        setIsNoTracker(false)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setIsLoading(false)
      }
    }

    const timeout = setTimeout(loadIssues, search ? 300 : 0)
    return () => clearTimeout(timeout)
  }, [search])

  function toggleIssue(num: number) {
    if (multiSelect) {
      if (selectedIssues.includes(num)) {
        onSelectionChange(selectedIssues.filter((n) => n !== num))
      } else {
        onSelectionChange([...selectedIssues, num])
      }
    } else {
      onSelectionChange(selectedIssues.includes(num) ? [] : [num])
    }
  }

  if (isNoTracker) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <AlertCircle className="w-8 h-8 text-amber-500" />
        <div>
          <p className="text-sm font-medium">No issue tracker configured</p>
          <p className="text-xs text-muted-foreground mt-1">
            Configure GitHub or Jira in{' '}
            <Link to="/settings" className="text-blue-400 hover:underline">
              Settings
            </Link>{' '}
            to browse issues.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder="Search issues..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8"
        />
      </div>

      {error && (
        <p className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {error}
        </p>
      )}

      <div className="max-h-[300px] overflow-y-auto space-y-1 pr-1">
        {isLoading ? (
          <div className="space-y-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-muted/30 rounded animate-pulse" />
            ))}
          </div>
        ) : issues.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No issues found{search ? ' matching your search' : ''}
          </div>
        ) : (
          issues.map((issue) => {
            const isSelected = selectedIssues.includes(issue.number)
            return (
              <button
                key={issue.number}
                type="button"
                onClick={() => toggleIssue(issue.number)}
                className={cn(
                  'w-full flex items-start gap-3 px-3 py-2 rounded-md text-left transition-colors',
                  isSelected
                    ? 'bg-blue-500/15 border border-blue-500/30'
                    : 'hover:bg-accent border border-transparent'
                )}
              >
                <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                  <div
                    className={cn(
                      'w-3.5 h-3.5 rounded border flex items-center justify-center',
                      multiSelect ? 'rounded' : 'rounded-full',
                      isSelected ? 'bg-blue-500 border-blue-500' : 'border-border'
                    )}
                  >
                    {isSelected && (
                      <div className={cn('bg-white', multiSelect ? 'w-2 h-2 rounded-sm' : 'w-1.5 h-1.5 rounded-full')} />
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground font-mono">#{issue.number}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{issue.title}</p>
                  {issue.labels.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {issue.labels.slice(0, 3).map((label) => (
                        <Badge key={label} variant="secondary" className="text-[9px] px-1 py-0">
                          {label}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            )
          })
        )}
      </div>

      {selectedIssues.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {selectedIssues.length} issue{selectedIssues.length > 1 ? 's' : ''} selected
          {': '}
          {selectedIssues.map((n) => `#${n}`).join(', ')}
        </p>
      )}
    </div>
  )
}

interface FreeFormStepProps {
  title: string
  description: string
  onTitleChange: (v: string) => void
  onDescriptionChange: (v: string) => void
}

export function FreeFormStep({ title, description, onTitleChange, onDescriptionChange }: FreeFormStepProps) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">
          Feature title <span className="text-destructive">*</span>
        </label>
        <Input
          placeholder="e.g. Add user authentication"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">
          Description <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <textarea
          placeholder="Describe what needs to be implemented, any constraints, expected behavior..."
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={4}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
        />
      </div>
    </div>
  )
}

interface BatchFreeFormItem {
  title: string
  description: string
}

interface BatchFreeFormStepProps {
  items: BatchFreeFormItem[]
  onItemsChange: (items: BatchFreeFormItem[]) => void
}

export function BatchFreeFormStep({ items, onItemsChange }: BatchFreeFormStepProps) {
  function updateItem(idx: number, field: keyof BatchFreeFormItem, value: string) {
    const updated = items.map((item, i) => i === idx ? { ...item, [field]: value } : item)
    onItemsChange(updated)
  }

  function addItem() {
    onItemsChange([...items, { title: '', description: '' }])
  }

  function removeItem(idx: number) {
    onItemsChange(items.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      {items.map((item, idx) => (
        <div key={idx} className="space-y-2 p-3 border border-border rounded-md bg-muted/20">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Feature {idx + 1}
            </span>
            {items.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeItem(idx)}
                className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
              >
                Remove
              </Button>
            )}
          </div>
          <Input
            placeholder="Feature title"
            value={item.title}
            onChange={(e) => updateItem(idx, 'title', e.target.value)}
          />
          <Input
            placeholder="Description (optional)"
            value={item.description}
            onChange={(e) => updateItem(idx, 'description', e.target.value)}
          />
        </div>
      ))}

      <Button
        variant="outline"
        size="sm"
        onClick={addItem}
        className="w-full border-dashed"
      >
        + Add another feature
      </Button>
    </div>
  )
}
