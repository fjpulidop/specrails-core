import { describe, expect, it } from 'vitest'

import { SessionError } from './errors.js'
import { DEFAULT_LIMITS, DEFAULT_MAX_DELEGATED, delegatedSubagents, nativeSubagentsAllowed, resolvePolicy, subagentsActive } from './policy.js'
import type { DriverCapabilities, DriverDescriptor } from './types.js'

function driver(id: string, caps: Partial<DriverCapabilities> = {}): DriverDescriptor {
  return {
    id,
    displayName: id,
    capabilities: {
      resident: true,
      nativeInputQueue: true,
      subagents: 'supported',
      subagentDisable: true,
      subagentModel: true,
      subagentEffort: true,
      autonomousContinuation: true,
      steer: true,
      toolFiltering: true,
      usage: { costUsd: 'session-cumulative', tokens: 'per-turn' },
      ...caps,
    },
  }
}

const native = driver('native')
const threaded = driver('threaded', { autonomousContinuation: false, nativeInputQueue: false })
const noDisable = driver('stubborn', { subagentDisable: false })
const oneShot = driver('one-shot', { resident: false, subagents: 'unsupported', subagentDisable: false, autonomousContinuation: false, steer: false })

function code(fn: () => unknown): string | undefined {
  try { fn() } catch (error) { return (error as SessionError).code }
  return undefined
}

describe('session policy', () => {
  it('fills defaults from the driver declaration', () => {
    expect(resolvePolicy({ subagents: 'enabled' }, native)).toEqual({
      subagents: 'enabled',
      subagentRuntime: { mode: 'native' },
      onSubagentsSettled: 'provider-native',
      tools: { mode: 'default' },
      permissions: 'workspace-write',
      mcp: { servers: [], inheritUserScope: false },
      limits: DEFAULT_LIMITS,
    })
    expect(resolvePolicy({ subagents: 'enabled' }, threaded).onSubagentsSettled).toBe('resume-agent')
  })

  it('refuses to disable sub-agents on a driver that cannot enforce it', () => {
    expect(code(() => resolvePolicy({ subagents: 'disabled' }, noDisable))).toBe('policy_unenforceable')
    expect(resolvePolicy({ subagents: 'disabled' }, native).subagents).toBe('disabled')
  })

  it('accepts either value on drivers without sub-agents', () => {
    expect(resolvePolicy({ subagents: 'disabled' }, oneShot).subagents).toBe('disabled')
    expect(subagentsActive(resolvePolicy({ subagents: 'enabled' }, oneShot), oneShot)).toBe(false)
    expect(subagentsActive(resolvePolicy({ subagents: 'enabled' }, native), native)).toBe(true)
  })

  it('refuses provider-native continuation on drivers that never continue by themselves', () => {
    expect(code(() => resolvePolicy({ subagents: 'enabled', onSubagentsSettled: 'provider-native' }, threaded))).toBe('policy_unenforceable')
    expect(resolvePolicy({ subagents: 'disabled', onSubagentsSettled: 'provider-native' }, threaded).onSubagentsSettled).toBe('provider-native')
  })

  it('refuses tool restrictions on drivers that cannot filter tools', () => {
    const noFilter = driver('no-filter', { toolFiltering: false })
    expect(code(() => resolvePolicy({ subagents: 'enabled', tools: { mode: 'read-only' } }, noFilter))).toBe('policy_unenforceable')
    expect(code(() => resolvePolicy({ subagents: 'enabled', tools: { mode: 'default', deny: ['x'] } }, noFilter))).toBe('policy_unenforceable')
    expect(resolvePolicy({ subagents: 'enabled', tools: { mode: 'default' } }, noFilter).tools).toEqual({ mode: 'default' })
  })

  it('refuses sub-agents without tools', () => {
    expect(code(() => resolvePolicy({ subagents: 'enabled', tools: { mode: 'none' } }, native))).toBe('policy_unenforceable')
  })

  it('validates limits and keeps other defaults', () => {
    expect(resolvePolicy({ subagents: 'enabled', limits: { idleMs: 60_000 } }, native).limits).toEqual({ ...DEFAULT_LIMITS, idleMs: 60_000 })
    expect(code(() => resolvePolicy({ subagents: 'enabled', limits: { idleMs: 5 } }, native))).toBe('invalid_params')
    expect(code(() => resolvePolicy({ subagents: 'enabled', limits: { maxSettleHandoffs: 1.5 } }, native))).toBe('invalid_params')
    expect(code(() => resolvePolicy({ subagents: 'enabled', limits: { bogus: 1 } as never }, native))).toBe('invalid_params')
  })

  it('copies host-provided collections instead of aliasing them', () => {
    const servers = [{ name: 'specrails', url: 'http://127.0.0.1:1/mcp' }]
    const allow = ['Read']
    const policy = resolvePolicy({ subagents: 'enabled', mcp: { servers }, tools: { mode: 'default', allow } }, native)
    servers.push({ name: 'x', url: 'http://x' })
    allow.push('Write')
    expect(policy.mcp.servers).toHaveLength(1)
    expect(policy.tools.allow).toEqual(['Read'])
  })

  describe('sub-agent runtime', () => {
    const modelOnly = driver('model-only', { subagentEffort: false })

    it('keeps native sub-agents by default and applies supported overrides', () => {
      const policy = resolvePolicy({ subagents: 'enabled', subagentRuntime: { mode: 'native', model: 'sonnet', effort: 'low' } }, native)
      expect(policy.subagentRuntime).toEqual({ mode: 'native', model: 'sonnet', effort: 'low' })
      expect(nativeSubagentsAllowed(policy)).toBe(true)
      expect(delegatedSubagents(policy)).toBe(false)
    })

    it('refuses an override the driver cannot apply', () => {
      expect(code(() => resolvePolicy({ subagents: 'enabled', subagentRuntime: { mode: 'native', effort: 'high' } }, modelOnly))).toBe('policy_unenforceable')
      expect(resolvePolicy({ subagents: 'enabled', subagentRuntime: { mode: 'native', model: 'sonnet' } }, modelOnly).subagentRuntime).toEqual({ mode: 'native', model: 'sonnet' })
    })

    it('delegates with a bounded concurrency and turns the native tool off', () => {
      const policy = resolvePolicy({ subagents: 'enabled', subagentRuntime: { mode: 'delegated', driver: 'claude', model: 'sonnet' } }, native)
      expect(policy.subagentRuntime).toEqual({ mode: 'delegated', driver: 'claude', model: 'sonnet', maxConcurrent: DEFAULT_MAX_DELEGATED })
      expect(delegatedSubagents(policy)).toBe(true)
      expect(nativeSubagentsAllowed(policy)).toBe(false)
      expect(subagentsActive(policy, native)).toBe(false)
      expect(code(() => resolvePolicy({ subagents: 'enabled', subagentRuntime: { mode: 'delegated', driver: 'claude', maxConcurrent: 99 } }, native))).toBe('invalid_params')
    })

    it('cannot delegate when the parent cannot switch its own sub-agents off', () => {
      expect(code(() => resolvePolicy({ subagents: 'enabled', subagentRuntime: { mode: 'delegated', driver: 'claude' } }, noDisable))).toBe('policy_unenforceable')
    })

    it('treats disabled sub-agents as neither native nor delegated', () => {
      const policy = resolvePolicy({ subagents: 'disabled', subagentRuntime: { mode: 'delegated', driver: 'claude' } }, native)
      expect(nativeSubagentsAllowed(policy)).toBe(false)
      expect(delegatedSubagents(policy)).toBe(false)
    })
  })
})

