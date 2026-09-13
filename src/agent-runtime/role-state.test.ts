import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createRoleInvoker } from './graph/roles.js'
import { ExecutorRegistry } from './executors.js'
import { AgentExecutionError, type AgentRequest, type RuntimeConfig } from './executor-types.js'
import type { WorkflowStepContext } from './workflow-types.js'
import type { PipelineContext } from '../installer/runtime/pipeline-state.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(continuation: 'supported' | 'unsupported' | 'unknown', run?: (request: AgentRequest, call: number) => string) {
  const root = mkdtempSync(path.join(tmpdir(), 'role-packets-')); roots.push(root)
  writeFileSync(path.join(root, 'AGENTS.md'), 'Important project instructions. '.repeat(80))
  const context: PipelineContext = { schemaVersion: 1, runId: 'run', backlogRoot: root, artifactRoot: root, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: root }], specs: [{ id: 1, title: 'Feature', description: 'Preserve behavior', acceptanceCriteria: ['Required behavior'] }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' } }
  const role = { provider: 'fixture', model: 'base' }
  const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [] }
  const calls: AgentRequest[] = []
  const registry = new ExecutorRegistry().register('fixture', {
    capabilities: () => ({ transport: 'fixture', continuation, effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }),
    execute: async request => { calls.push(request); return { text: run?.(request, calls.length) ?? '{"ok":true}', sessionId: 'session-1', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } } },
  })
  const step = { attemptId: 'attempt-1', checkpoint: { history: [] }, signal: new AbortController().signal, remainingBudget: () => ({}), reportUsage: () => {}, reportInvocation: async () => {} } as unknown as WorkflowStepContext
  return { root, config, context, registry, calls, step, invoke: createRoleInvoker({ context, config, registry }) }
}
it.each(['unsupported', 'unknown'] as const)('sends full context when returned session IDs do not prove continuation (%s)', async capability => {
  const f = fixture(capability)
  await f.invoke('developer', f.step, { prompt: 'FULL ROLE' }, (_out, text) => text)
  await f.invoke('developer', f.step, { prompt: 'SHORT CORRECTION', fallbackPrompt: 'FULL ROLE AND FEEDBACK', resumeSessionId: 'session-1' }, (_out, text) => text)
  expect(f.calls[1].resumeSessionId).toBeUndefined()
  expect(f.calls[1].prompt).toContain('FULL ROLE AND FEEDBACK')
  expect(f.calls[1].prompt).toContain('Important project instructions')
})
it('persists compatible context across invoker instances, removes duplication and restores full context on a model change', async () => {
  const f = fixture('supported')
  await f.invoke('developer', f.step, { prompt: 'FULL ROLE' }, (_out, text) => text)
  const next = createRoleInvoker({ context: f.context, config: f.config, registry: f.registry })
  await next('developer', f.step, { prompt: 'CORRECTION', fallbackPrompt: 'FULL ROLE', resumeSessionId: 'session-1' }, (_out, text) => text)
  expect(f.calls[1].resumeSessionId).toBe('session-1')
  expect(f.calls[1].prompt).toContain('Required behavior')
  expect(f.calls[1].prompt).not.toContain('Important project instructions')
  expect(Buffer.byteLength(f.calls[1].prompt)).toBeLessThan(Buffer.byteLength(f.calls[0].prompt) * 0.6)
  f.config.agents.developer = { provider: 'fixture', model: 'different' }
  await next('developer', f.step, { prompt: 'CORRECTION', fallbackPrompt: 'FULL ROLE', resumeSessionId: 'session-1' }, (_out, text) => text)
  expect(f.calls[2].resumeSessionId).toBeUndefined()
  expect(f.calls[2].prompt).toContain('Important project instructions')
})
it('repairs a sessionless malformed result once with its original prompt and failed response', async () => {
  const f = fixture('unsupported', (_request, call) => call === 1 ? 'malformed prior response' : '{"ok":true}')
  const result = await f.invoke('reviewer', f.step, { prompt: 'FULL REVIEW', structured: true }, output => output)
  expect(result.ok).toBe(true)
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1].prompt).toContain('FULL REVIEW')
  expect(f.calls[1].prompt).toContain('malformed prior response')
  expect(f.calls[1].resumeSessionId).toBeUndefined()
})
it.each(['provider_execution_error', 'session_expired'])('classifies session fallback without retrying ordinary work failure (%s)', async code => {
  const f = fixture('supported', (_request, call) => { if (call === 2) throw new AgentExecutionError('failed', code); return '{"ok":true}' })
  await f.invoke('developer', f.step, { prompt: 'FULL' }, (_out, text) => text)
  const outcome = await f.invoke('developer', f.step, { prompt: 'CORRECTION', fallbackPrompt: 'FULL', resumeSessionId: 'session-1' }, (_out, text) => text)
  expect(f.calls).toHaveLength(code === 'session_expired' ? 3 : 2)
  expect(outcome.ok).toBe(code === 'session_expired')
})
it('rejects a corrupted saved context before invoking a provider', async () => {
  const f = fixture('supported')
  await f.invoke('developer', f.step, { prompt: 'FULL' }, (_out, text) => text)
  const file = path.join(f.root, '.specrails/pipeline/run/agent-workflow/role-execution.json')
  writeFileSync(file, readFileSync(file, 'utf8').replace('Important project instructions', 'Changed project instructions'))
  const result = await f.invoke('developer', f.step, { prompt: 'CORRECTION', fallbackPrompt: 'FULL', resumeSessionId: 'session-1' }, (_out, text) => text)
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('integrity') })
  expect(f.calls).toHaveLength(1)
})
