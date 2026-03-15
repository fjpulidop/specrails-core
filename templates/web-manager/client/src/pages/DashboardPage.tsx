import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePipeline } from '../hooks/usePipeline'
import { CommandGrid } from '../components/CommandGrid'
import { RecentJobs } from '../components/RecentJobs'
import { JobDetailModal } from '../components/JobDetailModal'
import { ImplementWizard } from '../components/ImplementWizard'
import { BatchImplementWizard } from '../components/BatchImplementWizard'
import type { CommandInfo, JobSummary } from '../types'

export default function DashboardPage() {
  const { recentJobs } = usePipeline()
  const { id: routeJobId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [isLoadingJobs, setIsLoadingJobs] = useState(true)
  const [wizardOpen, setWizardOpen] = useState<string | null>(null)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(routeJobId ?? null)

  // Sync route param to modal state
  useEffect(() => {
    setSelectedJobId(routeJobId ?? null)
  }, [routeJobId])

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
        const res = await fetch('/api/jobs?limit=50')
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

  async function handleJobsCleared() {
    try {
      const res = await fetch('/api/jobs?limit=50')
      if (!res.ok) return
      const data = await res.json() as { jobs: JobSummary[] }
      setJobs(data.jobs)
    } catch {
      // ignore
    }
  }

  function handleOpenJob(jobId: string) {
    setSelectedJobId(jobId)
    navigate(`/jobs/${jobId}`, { replace: true })
  }

  function handleCloseJob() {
    setSelectedJobId(null)
    navigate('/', { replace: true })
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Commands */}
      <section>
        <h2 className="text-xs font-semibold gradient-text uppercase tracking-wider mb-3">
          Commands
        </h2>
        <CommandGrid
          commands={commands}
          onOpenWizard={(slug) => setWizardOpen(slug)}
        />
      </section>

      {/* Jobs */}
      <section>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Jobs
        </h2>
        <RecentJobs
          jobs={jobs}
          isLoading={isLoadingJobs}
          onJobsCleared={handleJobsCleared}
          onOpenJob={handleOpenJob}
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

      {/* Job detail modal */}
      {selectedJobId && (
        <JobDetailModal jobId={selectedJobId} onClose={handleCloseJob} />
      )}
    </div>
  )
}
