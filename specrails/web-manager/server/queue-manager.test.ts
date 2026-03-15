import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

// Mock child_process and uuid before importing queue-manager
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1111'),
}))

vi.mock('tree-kill', () => ({
  default: vi.fn(),
}))

// Mock hooks to avoid side effects in tests
vi.mock('./hooks', () => ({
  resetPhases: vi.fn(),
}))

import { spawn as mockSpawn, execSync as mockExecSync } from 'child_process'
import treeKill from 'tree-kill'
import { v4 as mockUuidV4 } from 'uuid'
import { QueueManager, ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError } from './queue-manager'
import type { WsMessage } from './types'

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  return child
}

describe('QueueManager', () => {
  let qm: QueueManager
  let broadcast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetAllMocks()
    broadcast = vi.fn()
    qm = new QueueManager(broadcast)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── enqueue ──────────────────────────────────────────────────────────────

  describe('enqueue', () => {
    it('returns a job with status queued when a process is already running', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-1' as any)
        .mockReturnValueOnce('job-2' as any)

      qm.enqueue('/implement #1')
      const secondJob = qm.enqueue('/implement #2')

      expect(secondJob.status).toBe('queued')
      expect(secondJob.queuePosition).toBe(1)
    })

    it('returns a job with status running when queue is empty (auto-drains)', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const job = qm.enqueue('/implement #1')

      expect(job.status).toBe('running')
    })

    it('throws ClaudeNotFoundError when claude is not on PATH', () => {
      vi.mocked(mockExecSync).mockImplementation(() => {
        throw new Error('not found')
      })

      expect(() => qm.enqueue('/implement #1')).toThrow(ClaudeNotFoundError)
    })

    it('broadcasts queue state after enqueue', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      qm.enqueue('/implement #1')

      const queueBroadcasts = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'queue'
      )
      expect(queueBroadcasts.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ─── cancel ───────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('on a queued job: removes from queue and broadcasts queue state', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-queued' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')

      broadcast.mockClear()

      const result = qm.cancel('job-queued')

      expect(result).toBe('canceled')
      const jobs = qm.getJobs()
      const canceledJob = jobs.find((j) => j.id === 'job-queued')
      expect(canceledJob?.status).toBe('canceled')

      const queueBroadcast = broadcast.mock.calls.find(
        (args: unknown[]) => (args[0] as WsMessage).type === 'queue'
      )
      expect(queueBroadcast).toBeDefined()
    })

    it('on a running job: calls treeKill with SIGTERM and returns canceling', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-running' as any)

      qm.enqueue('/implement #1')

      const result = qm.cancel('job-running')

      expect(result).toBe('canceling')
      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(12345, 'SIGTERM')
    })

    it('on a non-existent ID: throws JobNotFoundError', () => {
      expect(() => qm.cancel('no-such-id')).toThrow(JobNotFoundError)
    })

    it('on a completed job: throws JobAlreadyTerminalError', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')
      child.emit('close', 0)

      // Let close handler run
      await new Promise((r) => setTimeout(r, 10))

      expect(() => qm.cancel('job-1')).toThrow(JobAlreadyTerminalError)
    })
  })

  // ─── pause / resume ───────────────────────────────────────────────────────

  describe('pause', () => {
    it('prevents _drainQueue from starting the next job', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-1' as any)
        .mockReturnValueOnce('job-2' as any)

      qm.pause()
      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')

      // spawn should not have been called because queue is paused
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
    })
  })

  describe('resume', () => {
    it('calls _drainQueue and starts the next job if one is queued', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.pause()
      qm.enqueue('/implement #1')
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()

      qm.resume()
      expect(vi.mocked(mockSpawn)).toHaveBeenCalledOnce()

      const jobs = qm.getJobs()
      expect(jobs[0].status).toBe('running')
    })
  })

  // ─── reorder ──────────────────────────────────────────────────────────────

  describe('reorder', () => {
    it('reorders the queue array', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-a' as any)
        .mockReturnValueOnce('job-b' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')
      qm.enqueue('/implement #3')

      qm.reorder(['job-b', 'job-a'])

      const jobs = qm.getJobs()
      const jobB = jobs.find((j) => j.id === 'job-b')
      const jobA = jobs.find((j) => j.id === 'job-a')
      expect(jobB?.queuePosition).toBe(1)
      expect(jobA?.queuePosition).toBe(2)
    })

    it('throws when jobIds do not match the queued set', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-running' as any)
        .mockReturnValueOnce('job-a' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')

      // Provide wrong ID
      expect(() => qm.reorder(['job-a', 'wrong-id'])).toThrow()
    })
  })

  // ─── job transitions ──────────────────────────────────────────────────────

  describe('job status transitions', () => {
    it('job transitions to completed when process exits with code 0', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')
      child.emit('close', 0)

      await new Promise((r) => setTimeout(r, 10))

      const jobs = qm.getJobs()
      expect(jobs[0].status).toBe('completed')
      expect(jobs[0].exitCode).toBe(0)
    })

    it('job transitions to failed when process exits with non-zero code', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')
      child.emit('close', 1)

      await new Promise((r) => setTimeout(r, 10))

      const jobs = qm.getJobs()
      expect(jobs[0].status).toBe('failed')
      expect(jobs[0].exitCode).toBe(1)
    })
  })

  // ─── getLogBuffer ─────────────────────────────────────────────────────────

  describe('getLogBuffer', () => {
    it('returns log lines accumulated during job execution', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      qm.enqueue('/implement #1')

      child.stdout.push('hello from stdout\n')
      child.stdout.push(null)

      await new Promise((r) => setTimeout(r, 50))

      const buf = qm.getLogBuffer()
      const line = buf.find((l) => l.line === 'hello from stdout')
      expect(line).toBeDefined()
      expect(line?.source).toBe('stdout')
    })

    it('returns a copy, not a reference', () => {
      const buf = qm.getLogBuffer()
      buf.push({} as any)
      expect(qm.getLogBuffer()).toEqual([])
    })
  })

  // ─── sequential queue drain ───────────────────────────────────────────────

  describe('sequential queue drain', () => {
    it('second job starts when first jobs process emits close', async () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn)
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any)
      vi.mocked(mockUuidV4)
        .mockReturnValueOnce('job-1' as any)
        .mockReturnValueOnce('job-2' as any)

      qm.enqueue('/implement #1')
      qm.enqueue('/implement #2')

      expect(qm.getActiveJobId()).toBe('job-1')

      child1.emit('close', 0)

      await new Promise((r) => setTimeout(r, 10))

      expect(qm.getActiveJobId()).toBe('job-2')

      const jobs = qm.getJobs()
      expect(jobs.find((j) => j.id === 'job-2')?.status).toBe('running')
    })
  })

  // ─── kill timer ───────────────────────────────────────────────────────────

  describe('kill timer', () => {
    it('fires SIGKILL after 5s if process does not exit', async () => {
      vi.useFakeTimers()
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')
      qm.cancel('job-1')

      // Advance past 5s timeout
      vi.advanceTimersByTime(5100)

      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(12345, 'SIGTERM')
      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(12345, 'SIGKILL')

      vi.useRealTimers()
    })
  })

  // ─── getActiveJobId / isPaused ────────────────────────────────────────────

  describe('getActiveJobId', () => {
    it('returns null when no job is running', () => {
      expect(qm.getActiveJobId()).toBeNull()
    })

    it('returns the running job id after enqueue', () => {
      vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(mockUuidV4).mockReturnValue('job-1' as any)

      qm.enqueue('/implement #1')

      expect(qm.getActiveJobId()).toBe('job-1')
    })
  })

  describe('isPaused', () => {
    it('returns false by default', () => {
      expect(qm.isPaused()).toBe(false)
    })

    it('returns true after pause()', () => {
      qm.pause()
      expect(qm.isPaused()).toBe(true)
    })

    it('returns false after resume()', () => {
      qm.pause()
      qm.resume()
      expect(qm.isPaused()).toBe(false)
    })
  })
})
