import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getApiBase } from '../lib/api'
import { CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Separator } from '../components/ui/separator'
import type { ProjectConfig } from '../types'

export default function SettingsPage() {
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [labelFilter, setLabelFilter] = useState('')
  const [activeTracker, setActiveTracker] = useState<'github' | 'jira' | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await fetch(`${getApiBase()}/config`)
        if (!res.ok) return
        const data = await res.json() as ProjectConfig
        setConfig(data)
        setLabelFilter(data.issueTracker.labelFilter)
        setActiveTracker(data.issueTracker.active)
      } catch {
        // ignore
      } finally {
        setIsLoading(false)
      }
    }
    loadConfig()
  }, [])

  async function saveSettings() {
    setIsSaving(true)
    try {
      const res = await fetch(`${getApiBase()}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: activeTracker, labelFilter }),
      })
      if (!res.ok) throw new Error('Failed to save')
      toast.success('Settings saved')
    } catch (err) {
      toast.error('Failed to save settings', { description: (err as Error).message })
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-32 bg-muted/30 rounded-lg animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-base font-semibold">Settings</h1>
        {config && (
          <p className="text-xs text-muted-foreground mt-1">
            {config.project.name}
            {config.project.repo && ` · ${config.project.repo}`}
          </p>
        )}
      </div>

      {/* Issue Tracker Section */}
      <Card>
        <CardHeader>
          <CardTitle>Issue Tracker</CardTitle>
          <CardDescription>
            Configure which issue tracker to use for the "From Issues" wizard path
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Detection status */}
          <div className="space-y-2">
            <TrackerStatus
              name="GitHub"
              available={config?.issueTracker.github.available ?? false}
              authenticated={config?.issueTracker.github.authenticated ?? false}
              setupUrl="https://cli.github.com"
              isActive={activeTracker === 'github'}
              onSelect={() => setActiveTracker('github')}
              canSelect={config?.issueTracker.github.authenticated ?? false}
            />
            <TrackerStatus
              name="Jira"
              available={config?.issueTracker.jira.available ?? false}
              authenticated={config?.issueTracker.jira.authenticated ?? false}
              setupUrl="https://github.com/ankitpokhrel/jira-cli"
              isActive={activeTracker === 'jira'}
              onSelect={() => setActiveTracker('jira')}
              canSelect={config?.issueTracker.jira.authenticated ?? false}
            />
          </div>

          <Separator />

          {/* Label filter */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Label filter</label>
            <Input
              placeholder="e.g. backlog, feature, good-first-issue"
              value={labelFilter}
              onChange={(e) => setLabelFilter(e.target.value)}
              className="max-w-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Filter issues by label when browsing in the Implement wizard
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Queue Section */}
      <Card>
        <CardHeader>
          <CardTitle>Queue</CardTitle>
          <CardDescription>Queue configuration — coming soon</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-dashed border-border p-4 text-center">
            <p className="text-xs text-muted-foreground">
              Queue settings (inactivity timeout, auto-pause) will be available in a future update
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Display Section */}
      <Card>
        <CardHeader>
          <CardTitle>Display</CardTitle>
          <CardDescription>Display preferences — coming soon</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-dashed border-border p-4 text-center">
            <p className="text-xs text-muted-foreground">
              Display preferences (log line limit, theme) will be available in a future update
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button size="sm" onClick={saveSettings} disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>
    </div>
  )
}

interface TrackerStatusProps {
  name: string
  available: boolean
  authenticated: boolean
  setupUrl: string
  isActive: boolean
  onSelect: () => void
  canSelect: boolean
}

function TrackerStatus({
  name,
  available,
  authenticated,
  setupUrl,
  isActive,
  onSelect,
  canSelect,
}: TrackerStatusProps) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-md border border-border">
      <div className="flex items-center gap-2 flex-1">
        {authenticated ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
        ) : available ? (
          <AlertCircle className="w-4 h-4 text-amber-400" />
        ) : (
          <XCircle className="w-4 h-4 text-muted-foreground/40" />
        )}
        <div>
          <p className="text-xs font-medium">{name}</p>
          <p className="text-[10px] text-muted-foreground">
            {!available && (
              <>
                Not installed.{' '}
                <a href={setupUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                  Install CLI
                </a>
              </>
            )}
            {available && !authenticated && 'CLI found but not authenticated. Run the auth command.'}
            {authenticated && 'Connected and authenticated'}
          </p>
        </div>
      </div>

      {canSelect && (
        <button
          type="button"
          onClick={onSelect}
          className="flex items-center gap-1.5 text-[10px] font-medium"
        >
          <div
            className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
              isActive ? 'border-blue-500' : 'border-border'
            }`}
          >
            {isActive && <div className="w-1.5 h-1.5 bg-blue-500 rounded-full" />}
          </div>
          <span className={isActive ? 'text-blue-400' : 'text-muted-foreground'}>
            {isActive ? 'Active' : 'Use this'}
          </span>
        </button>
      )}
    </div>
  )
}
