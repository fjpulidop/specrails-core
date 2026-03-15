import { useEffect, useState } from 'react'
import { usePipeline } from '../hooks/usePipeline'
import { ActiveJobCard } from '../components/ActiveJobCard'
import { CommandGrid } from '../components/CommandGrid'
import { RecentJobs } from '../components/RecentJobs'
import { ImplementWizard } from '../components/ImplementWizard'
import { BatchImplementWizard } from '../components/BatchImplementWizard'
import type { CommandInfo, JobSummary } from '../types'

export default function DashboardPage() {
  const { phases, phaseDefinitions, queueState, recentJobs } = usePipeline()
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [isLoadingJobs, setIsLoadingJobs] = useState(true)
  const [wizardOpen, setWizardOpen] = useState<string | null>(null)

  // Load commands from config
  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await fetch('/api/config')
        if (!res.ok) return
        const data = await res.json() as { commands: CommandInfo[] }
        setCommands(data.commands)
      } catch {
        // ignore
      }
    }
    loadConfig()
  }, [])

  // Use recentJobs from WebSocket init, refresh from REST when needed
  useEffect(() => {
    setJobs(recentJobs)
    setIsLoadingJobs(false)
  }, [recentJobs])

  // Refresh job list from REST API periodically
  useEffect(() => {
    async function refreshJobs() {
      try {
        const res = await fetch('/api/jobs?limit=10')
        if (!res.ok) return
        const data = await res.json() as { jobs: JobSummary[] }
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

  // Find active job from queue state
  const activeJob = queueState.jobs.find((j) => j.id === queueState.activeJobId) ?? null

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      {/* Active Job */}
      <section>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Active Job
        </h2>
        <ActiveJobCard activeJob={activeJob} phases={phases} phaseDefinitions={phaseDefinitions} />
      </section>

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
        <RecentJobs jobs={jobs} isLoading={isLoadingJobs} />
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
