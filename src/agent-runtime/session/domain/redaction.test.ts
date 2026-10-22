import { describe, expect, it } from 'vitest'

import type { SessionEvent } from './events.js'
import { fingerprint } from './fingerprint.js'
import { DEFAULT_LIMITS } from './policy.js'
import { redactSessionEvent, redactSessionSnapshot } from './redaction.js'
import { emptySnapshot, foldEvents } from './snapshot.js'
import type { SessionPolicy, Usage } from './types.js'

const at = '2026-10-21T10:00:00.000Z'
const SECRET = 'ghp_' + 'Z9y8X7w6V5'.repeat(4)
const usage: Usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: null, costUsd: 0.25, costEstimated: false, model: 'm' }
const policy: SessionPolicy = { subagents: 'enabled', subagentRuntime: { mode: 'native' as const }, onSubagentsSettled: 'provider-native', tools: { mode: 'default' }, permissions: 'bypass', mcp: { servers: [], inheritUserScope: false }, limits: DEFAULT_LIMITS }

describe('redactSessionEvent', () => {
  it.each<[string, SessionEvent]>([
    ['input text', { type: 'input.accepted', inputId: 'i1', delivery: 'queue', text: `use ${SECRET}`, at }],
    ['turn output', { type: 'turn.output', turnId: 't1', channel: 'text', delta: `export TOKEN=${SECRET}`, at }],
    ['tool input and output', { type: 'turn.tool', turnId: 't1', toolUseId: 'u1', name: 'Bash', phase: 'completed', input: { command: `GH_TOKEN=${SECRET} gh pr list`, env: { API_KEY: 'k' } }, output: `TOKEN=${SECRET}`, at }],
    ['turn completion', { type: 'turn.completed', turnId: 't1', status: 'failed', text: `key ${SECRET}`, error: `Authorization: Bearer ${SECRET}`, usage, at }],
    ['sub-agent start', { type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', description: `check ${SECRET}`, prompt: `password=${SECRET}`, at }],
    ['sub-agent text', { type: 'subagent.output', subagentId: 'a1', channel: 'text', delta: SECRET, at }],
    ['sub-agent tool', { type: 'subagent.output', subagentId: 'a1', channel: 'tool', tool: { toolUseId: 'u2', name: 'Read', phase: 'completed', input: { file_path: '.env' }, output: `SECRET_KEY=${SECRET}` }, at }],
    ['sub-agent result', { type: 'subagent.result', subagentId: 'a1', summary: `found ${SECRET}`, at }],
    ['sub-agent reason', { type: 'subagent.phase', subagentId: 'a1', phase: 'failed', reason: `token=${SECRET}`, at }],
    ['diagnostic', { type: 'provider.diagnostic', level: 'warning', code: 'x', message: `--api-key ${SECRET}`, at }],
    ['close reason', { type: 'session.closed', reason: `secret=${SECRET}`, at }],
  ])('redacts %s without changing the event shape', (_name, event) => {
    const redacted = redactSessionEvent(event)
    expect(JSON.stringify(redacted)).not.toContain(SECRET)
    expect(JSON.stringify(redacted)).toContain('[REDACTED]')
    expect(Object.keys(redacted).sort()).toEqual(Object.keys(event).sort())
    expect(redacted.type).toBe(event.type)
    expect(redacted.at).toBe(event.at)
  })

  it('keeps usage numbers, identifiers and host configuration untouched', () => {
    const completed: SessionEvent = { type: 'turn.completed', turnId: 't1', status: 'completed', text: 'done', usage, at }
    expect(redactSessionEvent(completed)).toEqual(completed)
    const opened: SessionEvent = { type: 'session.opened', driver: 'claude', model: 'm', systemPrompt: 'API_KEY=configured', policy, resumed: false, providerSessionRef: 'ref', at }
    expect(redactSessionEvent(opened)).toBe(opened)
    const usageEvent: SessionEvent = { type: 'subagent.usage', subagentId: 'a1', usage, toolUses: 3, at }
    expect(redactSessionEvent(usageEvent)).toBe(usageEvent)
  })

  it('does not add absent optional fields', () => {
    const tool: SessionEvent = { type: 'turn.tool', turnId: 't1', toolUseId: 'u1', name: 'Bash', phase: 'started', at }
    expect(redactSessionEvent(tool)).toEqual(tool)
    const phase: SessionEvent = { type: 'subagent.phase', subagentId: 'a1', phase: 'running', at }
    expect(redactSessionEvent(phase)).toEqual(phase)
  })
})

describe('redactSessionSnapshot', () => {
  it('redacts free text and keeps input fingerprints and configuration', () => {
    const raw = `deploy with TOKEN=${SECRET}`
    const snapshot = foldEvents(emptySnapshot('s1'), [
      { sessionId: 's1', seq: 1, event: { type: 'session.opened', driver: 'claude', model: 'm', systemPrompt: 'prompt', policy, resumed: false, providerSessionRef: null, at } },
      { sessionId: 's1', seq: 2, event: { type: 'input.accepted', inputId: 'i1', delivery: 'queue', text: raw, at } },
      { sessionId: 's1', seq: 3, event: { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: ['i1'], at } },
      { sessionId: 's1', seq: 4, event: { type: 'turn.output', turnId: 't1', channel: 'text', delta: `echo ${SECRET}`, at } },
      { sessionId: 's1', seq: 5, event: { type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', description: `use ${SECRET}`, at } },
    ])
    const redacted = redactSessionSnapshot(snapshot)
    expect(JSON.stringify(redacted)).not.toContain(SECRET)
    expect(redacted.inputs.i1!.fingerprint).toBe(fingerprint(raw))
    expect(redacted.inputs.i1!.textLength).toBe(raw.length)
    expect(redacted.systemPrompt).toBe('prompt')
    expect(redacted.policy).toEqual(policy)
    expect(redacted.lastSeq).toBe(snapshot.lastSeq)
    expect(redactSessionSnapshot(redacted)).toEqual(redacted)
  })
})
