import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

// Mock child_process before importing spawner
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

// Mock uuid to return predictable IDs
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}))

import { spawn as mockSpawn, execSync as mockExecSync } from 'child_process'
import type { WsMessage, LogMessage } from './types'
import { ClaudeNotFoundError, SpawnBusyError } from './types'

// We need to re-import spawner fresh for each describe block because it has module-level state.
// We'll use dynamic imports and vi.resetModules() for isolation.

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  return child
}

describe('spawner', () => {
  let spawnClaude: typeof import('./spawner').spawnClaude
  let isSpawnActive: typeof import('./spawner').isSpawnActive
  let getLogBuffer: typeof import('./spawner').getLogBuffer

  beforeEach(async () => {
    vi.resetModules()

    // Re-mock after resetModules
    vi.doMock('child_process', () => ({
      spawn: vi.fn(),
      execSync: vi.fn(),
    }))
    vi.doMock('uuid', () => ({
      v4: vi.fn(() => 'test-uuid-1234'),
    }))

    const spawnerModule = await import('./spawner')
    spawnClaude = spawnerModule.spawnClaude
    isSpawnActive = spawnerModule.isSpawnActive
    getLogBuffer = spawnerModule.getLogBuffer
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('isSpawnActive', () => {
    it('returns false when no process is running', () => {
      expect(isSpawnActive()).toBe(false)
    })

    it('returns true after spawning a process', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/test', broadcast, onReset)

      expect(isSpawnActive()).toBe(true)
    })

    it('returns false after process closes', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/test', broadcast, onReset)
      expect(isSpawnActive()).toBe(true)

      child.emit('close', 0)
      expect(isSpawnActive()).toBe(false)
    })
  })

  describe('spawnClaude', () => {
    it('throws ClaudeNotFoundError when claude is not on PATH', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('not found')
      })

      const broadcast = vi.fn()
      const onReset = vi.fn()
      expect(() => spawnClaude('/test', broadcast, onReset)).toThrow('claude binary not found')
    })

    it('throws SpawnBusyError when a process is already running', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/test', broadcast, onReset)

      expect(() => spawnClaude('/test2', broadcast, onReset)).toThrow('A process is already running')
    })

    it('allows spawning again after process exits', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child1 = createMockChildProcess()
      const child2 = createMockChildProcess()
      vi.mocked(spawn).mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/test', broadcast, onReset)
      child1.emit('close', 0)

      // Should not throw
      expect(() => spawnClaude('/test2', broadcast, onReset)).not.toThrow()
    })

    it('calls onResetPhases before spawning', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/test', broadcast, onReset)

      expect(onReset).toHaveBeenCalledOnce()
    })

    it('returns a SpawnHandle with processId, command, and startedAt', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      const handle = spawnClaude('/implement #42', broadcast, onReset)

      expect(handle.processId).toBe('test-uuid-1234')
      expect(handle.command).toBe('/implement #42')
      expect(handle.startedAt).toBeDefined()
    })

    it('spawns claude with --dangerously-skip-permissions and split args', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/implement #42', broadcast, onReset)

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['--dangerously-skip-permissions', '/implement', '#42'],
        { env: process.env, shell: false }
      )
    })

    it('broadcasts stdout lines as log messages', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/test', broadcast, onReset)

      // Push data to stdout to trigger readline
      child.stdout.push('hello world\n')
      child.stdout.push(null)

      // readline is async, give it a tick
      await new Promise((r) => setTimeout(r, 50))

      const logCalls = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'log' && ((args[0] as LogMessage).line === 'hello world')
      )
      expect(logCalls.length).toBe(1)
      expect(logCalls[0][0]).toMatchObject({
        type: 'log',
        source: 'stdout',
        line: 'hello world',
        processId: 'test-uuid-1234',
      })
    })

    it('broadcasts stderr lines as log messages', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/test', broadcast, onReset)

      child.stderr.push('error output\n')
      child.stderr.push(null)

      await new Promise((r) => setTimeout(r, 50))

      const logCalls = broadcast.mock.calls.filter(
        (args: unknown[]) => (args[0] as WsMessage).type === 'log' && ((args[0] as LogMessage).line === 'error output')
      )
      expect(logCalls.length).toBe(1)
      expect(logCalls[0][0]).toMatchObject({
        type: 'log',
        source: 'stderr',
        line: 'error output',
      })
    })

    it('broadcasts exit message on close', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/test', broadcast, onReset)

      child.emit('close', 0)

      await new Promise((r) => setTimeout(r, 50))

      const exitCalls = broadcast.mock.calls.filter(
        (args: unknown[]) =>
          (args[0] as WsMessage).type === 'log' && ((args[0] as LogMessage).line.includes('[process exited with code 0]'))
      )
      expect(exitCalls.length).toBe(1)
    })
  })

  describe('getLogBuffer', () => {
    it('returns empty array initially', () => {
      expect(getLogBuffer()).toEqual([])
    })

    it('returns a copy, not a reference', () => {
      const buf = getLogBuffer()
      buf.push({} as any)
      expect(getLogBuffer()).toEqual([])
    })

    it('contains log messages after spawn emits lines', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/test', broadcast, onReset)

      child.stdout.push('line1\nline2\n')
      child.stdout.push(null)

      await new Promise((r) => setTimeout(r, 50))

      const buf = getLogBuffer()
      expect(buf.length).toBe(2)
      expect(buf[0].line).toBe('line1')
      expect(buf[1].line).toBe('line2')
    })
  })

  describe('circular buffer', () => {
    it('drops oldest entries when exceeding max size', async () => {
      const { execSync, spawn } = await import('child_process')
      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = createMockChildProcess()
      vi.mocked(spawn).mockReturnValue(child as any)

      const broadcast = vi.fn()
      const onReset = vi.fn()
      spawnClaude('/test', broadcast, onReset)

      // Push 5001 lines to exceed LOG_BUFFER_MAX (5000)
      const lines: string[] = []
      for (let i = 0; i < 5001; i++) {
        lines.push(`line-${i}`)
      }
      child.stdout.push(lines.join('\n') + '\n')
      child.stdout.push(null)

      await new Promise((r) => setTimeout(r, 200))

      const buf = getLogBuffer()
      // After 5001 entries, buffer should have dropped first 1000
      // So we should have 5001 - 1000 = 4001 entries
      expect(buf.length).toBe(4001)
      // First entry should be line-1000 (0-999 were dropped)
      expect(buf[0].line).toBe('line-1000')
      // Last entry should be line-5000
      expect(buf[buf.length - 1].line).toBe('line-5000')
    })
  })
})
