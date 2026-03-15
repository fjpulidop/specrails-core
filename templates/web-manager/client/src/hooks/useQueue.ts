import type { Job } from '../components/JobQueueSidebar'

interface QueueState {
  jobs: Job[]
  activeJobId: string | null
  paused: boolean
}

export function useQueue(queueState: QueueState) {
  async function kill(jobId: string): Promise<void> {
    await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' })
  }

  async function cancel(jobId: string): Promise<void> {
    await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' })
  }

  async function pause(): Promise<void> {
    await fetch('/api/queue/pause', { method: 'POST' })
  }

  async function resume(): Promise<void> {
    await fetch('/api/queue/resume', { method: 'POST' })
  }

  return {
    jobs: queueState.jobs,
    activeJobId: queueState.activeJobId,
    paused: queueState.paused,
    kill,
    cancel,
    pause,
    resume,
  }
}
