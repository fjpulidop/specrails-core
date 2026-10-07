import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SessionService } from '../../application/session-service.js'
import type { SessionEventBody } from '../../domain/events.js'
import { DEFAULT_LIMITS, resolvePolicy } from '../../domain/policy.js'
import { FakeClock, SequentialIds } from '../../testing/fake-clock.js'
import { FixtureReplayer } from '../../testing/fixture-replayer.js'
import { MemoryJournal } from '../../testing/memory-journal.js'
import { catalogOf } from '../../testing/scripted-driver.js'
import { codexArgs, codexSandbox, declaredCodexMcpServers } from './argv.js'
import { CODEX_DESCRIPTOR, CodexDriverFactory } from './driver.js'
import { JsonRpcPeer, RpcError } from './rpc.js'

const fixture = (name: string) => fileURLToPath(new URL(`../../testing/fixtures/${name}.jsonl`, import.meta.url))
const tick = () => new Promise((resolve) => setImmediate(resolve))

function setup(replayer: FixtureReplayer) {
  const journal = new MemoryJournal()
  const clock = new FakeClock()
  const factory = new CodexDriverFactory({ spawner: replayer.spawner, terminateGraceMs: 10, declaredMcpServers: ['blender', 'premiere-pro'] })
  const service = new SessionService({ journal, drivers: catalogOf(factory), clock, ids: new SequentialIds() })
  const events = (sessionId: string) => journal.events(sessionId).map((envelope) => envelope.event as SessionEventBody)
  return { journal, clock, service, events }
}

function of<T extends SessionEventBody['type']>(list: SessionEventBody[], type: T): Array<Extract<SessionEventBody, { type: T }>> {
  return list.filter((event): event is Extract<SessionEventBody, { type: T }> => event.type === type)
}

async function drain(replayer: FixtureReplayer) {
  for (let index = 0; index < 5; index++) { await replayer.last.idle(); await tick() }
}

describe('Codex driver against recorded transcripts', () => {
  it('maps child threads to sub-agents with results and per-thread usage, without a redundant collect turn', async () => {
    const replayer = FixtureReplayer.fromFile(fixture('codex-multi-wait'))
    const ctx = setup(replayer)
    const { sessionId } = await ctx.service.open({ driver: 'codex', model: 'gpt-5.6-luna', cwd: '/repo', policy: { subagents: 'enabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Spawn two sub-agents and wait', delivery: 'queue' })
    await drain(replayer)
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
    await drain(replayer)

    const snapshot = ctx.service.snapshot(sessionId)
    expect(snapshot.providerSessionRef).toBe('01a115dc-0139-7ef3-bb8d-a59303bfb5db')
    expect(snapshot.turns.map((turn) => [turn.origin, turn.status])).toEqual([['user', 'completed']])
    const a = snapshot.subagents['01a115dc-2eb0-7521-8f9b-fc82f33cbfe9']!
    const b = snapshot.subagents['01a115dc-2f2e-7201-bc09-90d485217f31']!
    expect(a).toMatchObject({ parentId: null, kind: 'background', phase: 'idle', resultSummary: 'A_DONE' })
    expect(b).toMatchObject({ parentId: null, phase: 'idle', resultSummary: 'B_DONE' })
    expect(a.description).toContain('sleep 15')
    expect(a.usage?.totalTokens).toBe(29_200)
    const turn = of(ctx.events(sessionId), 'turn.completed')[0]!
    expect(turn.text).toBe('A_DONE; B_DONE')
    expect(turn.usage).toMatchObject({ costUsd: null, inputTokens: expect.any(Number) })
    expect(snapshot).toMatchObject({ phase: 'idle', settled: { settled: true, live: 0 } })
    // Children finished while the parent was in its turn (it waited): no system handoff.
    expect(replayer.last.written.filter((line) => line.method === 'turn/start')).toHaveLength(1)
    const childTools = of(ctx.events(sessionId), 'subagent.output').filter((event) => event.tool).map((event) => event.tool!.name)
    expect(childTools).toContain('commandExecution')
  })

  it('keeps a child running after the parent turn completes and collects it on the next turn', async () => {
    const replayer = FixtureReplayer.fromFile(fixture('codex-spawn-nowait'))
    const ctx = setup(replayer)
    const { sessionId } = await ctx.service.open({ driver: 'codex', model: 'gpt-5.6-luna', cwd: '/repo', policy: { subagents: 'enabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Spawn one sub-agent, do not wait', delivery: 'queue' })
    await drain(replayer)
    const background = ctx.service.snapshot(sessionId)
    expect(background.phase).toBe('background')
    const [child] = Object.values(background.subagents)
    expect(child?.phase).toBe('running')

    await ctx.service.send(sessionId, { inputId: 'in-2', text: 'Now wait for it', delivery: 'queue' })
    await drain(replayer)
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
    const done = ctx.service.snapshot(sessionId)
    expect(done.turns.map((turn) => turn.origin)).toEqual(['user', 'user'])
    expect(done.subagents[child!.subagentId]).toMatchObject({ phase: 'idle', resultSummary: expect.stringContaining('LATE_DONE') })
    expect(done.phase).toBe('idle')
    const costs = of(ctx.events(sessionId), 'turn.completed').map((turn) => turn.usage.inputTokens)
    expect(costs.every((value) => value !== null && value > 0)).toBe(true)
  })

  it('enforces sub-agents disabled and isolates user MCP servers through config overrides', async () => {
    const replayer = FixtureReplayer.fromFile(fixture('codex-disabled'))
    const ctx = setup(replayer)
    const { sessionId } = await ctx.service.open({ driver: 'codex', model: 'gpt-5.6-luna', cwd: '/repo', policy: { subagents: 'disabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Try to spawn a sub-agent', delivery: 'queue' })
    await drain(replayer)
    const args = replayer.last.spec.args
    expect(args).toEqual(['-c', 'features.multi_agent=false', '-c', 'mcp_servers.blender.enabled=false', '-c', 'mcp_servers.premiere-pro.enabled=false', 'app-server', '--listen', 'stdio://'])
    expect(of(ctx.events(sessionId), 'turn.completed')[0]?.text).toMatch(/^NO_AGENT_TOOL/)
    const threadStart = replayer.last.written.find((line) => line.method === 'thread/start') as { params: Record<string, unknown> }
    expect(threadStart.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'workspace-write', model: 'gpt-5.6-luna' })
  })
})

describe('Codex 0.160 transcripts (subAgentActivity)', () => {
  it('maps named child threads to sub-agents with results', async () => {
    const replayer = FixtureReplayer.fromFile(fixture('codex-0160-multi-wait'))
    const ctx = setup(replayer)
    const { sessionId } = await ctx.service.open({ driver: 'codex', model: 'gpt-6.1-sol', cwd: '/repo', policy: { subagents: 'enabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Spawn two sub-agents and wait', delivery: 'queue' })
    await drain(replayer)
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
    await drain(replayer)

    const snapshot = ctx.service.snapshot(sessionId)
    const nodes = Object.values(snapshot.subagents)
    expect(nodes.map((node) => [node.description, node.phase, node.resultSummary])).toEqual([['agent a', 'idle', 'A_DONE'], ['agent b', 'idle', 'B_DONE']])
    expect(nodes.every((node) => node.parentId === null && node.kind === 'background')).toBe(true)
    expect(of(ctx.events(sessionId), 'turn.completed')[0]?.text).toBe('A_DONE B_DONE')
    expect(snapshot).toMatchObject({ phase: 'idle', settled: { settled: true, live: 0 } })
  })

  it('keeps an announced child running past the parent turn', async () => {
    const replayer = FixtureReplayer.fromFile(fixture('codex-0160-spawn-nowait'))
    const ctx = setup(replayer)
    const { sessionId } = await ctx.service.open({ driver: 'codex', model: 'gpt-6.1-sol', cwd: '/repo', policy: { subagents: 'enabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Spawn one sub-agent, do not wait', delivery: 'queue' })
    await drain(replayer)
    const background = ctx.service.snapshot(sessionId)
    expect(background.phase).toBe('background')
    const [child] = Object.values(background.subagents)
    expect(child).toMatchObject({ phase: 'running', description: 'late command' })

    await ctx.service.send(sessionId, { inputId: 'in-2', text: 'Now wait for it', delivery: 'queue' })
    await drain(replayer)
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
    expect(ctx.service.snapshot(sessionId).subagents[child!.subagentId]).toMatchObject({ phase: 'idle', resultSummary: expect.stringContaining('LATE_DONE') })
  })

  it('stops a sub-agent the provider starts although the policy disables them', async () => {
    const replayer = FixtureReplayer.fromFile(fixture('codex-0160-disabled'))
    const ctx = setup(replayer)
    const { sessionId } = await ctx.service.open({ driver: 'codex', model: 'gpt-6.1-sol', cwd: '/repo', policy: { subagents: 'disabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Try to spawn a sub-agent', delivery: 'queue' })
    await drain(replayer)

    expect(replayer.last.spec.args.slice(0, 2)).toEqual(['-c', 'features.multi_agent=false'])
    const events = ctx.events(sessionId)
    expect(of(events, 'provider.diagnostic').map((event) => event.code)).toContain('policy.subagent_blocked')
    const [child] = of(events, 'subagent.started')
    expect(of(events, 'subagent.phase').find((event) => event.subagentId === child!.subagentId)).toMatchObject({ phase: 'stopped', reason: 'policy' })
    // The child is interrupted on its own thread as soon as its turn starts.
    expect(replayer.last.written.some((line) => line.method === 'turn/interrupt' && (line.params as Record<string, unknown>).threadId === child!.subagentId)).toBe(true)
    expect(ctx.service.snapshot(sessionId).subagents[child!.subagentId]?.phase).toBe('stopped')
  })
})

describe('Codex argv and config discovery', () => {
  it('disables declared user servers, enables requested ones and maps sandbox modes', () => {
    const policy = resolvePolicy({ subagents: 'enabled', mcp: { servers: [{ name: 'specrails', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer x' } }, { name: 'local', command: 'node', args: ['s.js'], env: { A: '1' } }] } }, CODEX_DESCRIPTOR)
    const values = codexArgs(policy, ['specrails', 'blender', 'my.server']).filter((_, index, all) => all[index - 1] === '-c')
    expect(values).toEqual([
      'mcp_servers.blender.enabled=false',
      'mcp_servers."my.server".enabled=false',
      'mcp_servers.specrails.enabled=true',
      'mcp_servers.specrails.url="http://127.0.0.1:9/mcp"',
      'mcp_servers.specrails.http_headers.Authorization="Bearer x"',
      'mcp_servers.local.enabled=true',
      'mcp_servers.local.command="node"',
      'mcp_servers.local.args=["s.js"]',
      'mcp_servers.local.env.A="1"',
    ])
    expect(codexArgs(resolvePolicy({ subagents: 'enabled', mcp: { inheritUserScope: true } }, CODEX_DESCRIPTOR), ['blender'])).toEqual(['app-server', '--listen', 'stdio://'])
    expect([codexSandbox('bypass'), codexSandbox('workspace-write'), codexSandbox('read-only')]).toEqual(['danger-full-access', 'workspace-write', 'read-only'])
  })

  it('reads declared servers from CODEX_HOME/config.toml', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codex home '))
    try {
      writeFileSync(path.join(home, 'config.toml'), ['model = "x"', '[mcp_servers.node_repl]', '[mcp_servers.node_repl.env]', '[mcp_servers."dotted.name"] # comment', '[profiles.a]', '[mcp_servers.blender]'].join('\n'))
      expect(declaredCodexMcpServers({ CODEX_HOME: home })).toEqual(['node_repl', 'dotted.name', 'blender'])
      expect(declaredCodexMcpServers({ CODEX_HOME: path.join(home, 'missing') })).toEqual([])
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('refuses tool filtering, which Codex cannot enforce', () => {
    expect(() => resolvePolicy({ subagents: 'enabled', tools: { mode: 'read-only' } }, CODEX_DESCRIPTOR)).toThrow(expect.objectContaining({ code: 'policy_unenforceable' }))
  })
})

describe('JSON-RPC peer', () => {
  it('correlates responses, answers server requests and rejects in-flight calls on close', async () => {
    const written: Array<Record<string, unknown>> = []
    const notifications: string[] = []
    const peer = new JsonRpcPeer((line) => { written.push(JSON.parse(line)); return true }, {
      onNotification: (method) => notifications.push(method),
      onRequest: (method) => { if (method === 'ok') return { fine: true }; throw new RpcError('nope', -32601) },
    })
    const first = peer.request('a', {})
    const second = peer.request('b', {})
    peer.receive({ id: 2, error: { code: 7, message: 'bad b' } })
    peer.receive({ id: 1, result: { value: 1 } })
    await expect(first).resolves.toEqual({ value: 1 })
    await expect(second).rejects.toMatchObject({ message: 'bad b', code: 7 })
    peer.receive({ id: 'srv-1', method: 'ok', params: {} })
    peer.receive({ id: 'srv-2', method: 'other', params: {} })
    peer.receive({ method: 'note', params: {} })
    expect(written.slice(-2)).toEqual([{ id: 'srv-1', result: { fine: true } }, { id: 'srv-2', error: { code: -32601, message: 'nope' } }])
    expect(notifications).toEqual(['note'])
    const pending = peer.request('c', {})
    peer.close('gone')
    await expect(pending).rejects.toMatchObject({ message: 'gone' })
    await expect(peer.request('d', {})).rejects.toMatchObject({ message: 'gone' })
  })

  it('times out unanswered requests and fails fast when input is closed', async () => {
    const peer = new JsonRpcPeer(() => true, { onNotification: () => {}, onRequest: () => ({}) }, 20)
    await expect(peer.request('slow', {})).rejects.toThrow(/did not answer slow/)
    const closed = new JsonRpcPeer(() => false, { onNotification: () => {}, onRequest: () => ({}) })
    await expect(closed.request('x', {})).rejects.toThrow(/input is closed/)
  })
})
