import { useEffect, useState } from 'react'
import { usePipeline } from '../hooks/usePipeline'
import { CommandGrid } from '../components/CommandGrid'
import { RecentJobs } from '../components/RecentJobs'
import { ImplementWizard } from '../components/ImplementWizard'
import { BatchImplementWizard } from '../components/BatchImplementWizard'
import type { CommandInfo, JobSummary } from '../types'
import { getApiBase } from '../lib/api'

// Module-level cache — survives route changes, no flicker on re-mount
let cachedCommands: CommandInfo[] | null = null
let cachedJobs: JobSummary[] | null = null

export default function DashboardPage() {
  const { recentJobs } = usePipeline()
  const [commands, setCommands] = useState<CommandInfo[]>(cachedCommands ?? [])
  const [jobs, setJobs] = useState<JobSummary[]>(cachedJobs ?? [])
  const [isLoadingJobs, setIsLoadingJobs] = useState(cachedJobs === null)
  const [wizardOpen, setWizardOpen] = useState<string | null>(null)

  // Load commands from config (use cache, refresh silently)
  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await fetch(`${getApiBase()}/config`)
        if (!res.ok) return
        const data = await res.json() as { commands: CommandInfo[] }
        cachedCommands = data.commands
        setCommands(data.commands)
      } catch {
        // ignore
      }
    }
    loadConfig()
  }, [])

  // Use recentJobs from WebSocket init
  useEffect(() => {
    cachedJobs = recentJobs
    setJobs(recentJobs)
    setIsLoadingJobs(false)
  }, [recentJobs])

  // Refresh job list from REST API periodically (silent update, no loading state)
  useEffect(() => {
    async function refreshJobs() {
      try {
        const res = await fetch(`${getApiBase()}/jobs?limit=10`)
        if (!res.ok) return
        const data = await res.json() as { jobs: JobSummary[] }
        cachedJobs = data.jobs
        setJobs(data.jobs)
        setIsLoadingJobs(false)
      } catch {
        // ignore
      }
    }
    refreshJobs()
    const interval = setInterval(refreshJobs, 10_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      {/* Commands */}
      <section>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Commands
        </h2>
        <CommandGrid
          commands={commands}
          onOpenWizard={(slug) => setWizardOpen(slug)}
        />
      </section>

      {/* Recent Jobs */}
      <section>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Recent Jobs
        </h2>
        <RecentJobs
          jobs={jobs}
          isLoading={isLoadingJobs}
          onJobsCleared={async () => {
            try {
              const res = await fetch(`${getApiBase()}/jobs?limit=10`)
              if (!res.ok) return
              const data = await res.json() as { jobs: JobSummary[] }
              cachedJobs = data.jobs
              setJobs(data.jobs)
            } catch { /* ignore */ }
          }}
        />
      </section>

      {/* Wizards */}
      <ImplementWizard
        open={wizardOpen === 'implement'}
        onClose={() => setWizardOpen(null)}
      />
      <BatchImplementWizard
        open={wizardOpen === 'batch-implement'}
        onClose={() => setWizardOpen(null)}
      />
    </div>
  )
}
