import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SessionService } from '../../application/session-service.js'
import type { SessionEventBody } from '../../domain/events.js'
import { DEFAULT_LIMITS, resolvePolicy } from '../../domain/policy.js'
import { FakeClock, SequentialIds } from '../../testing/fake-clock.js'
import { FixtureReplayer } from '../../testing/fixture-replayer.js'
import { MemoryJournal } from '../../testing/memory-journal.js'
import { catalogOf } from '../../testing/scripted-driver.js'
import type { ProcessSpawner } from '../common/process.js'
import { claudeArgs, claudeEnv } from './argv.js'
import { CLAUDE_DESCRIPTOR, ClaudeDriverFactory } from './driver.js'
import { ClaudeTranslator } from './translator.js'

const fixture = (name: string) => fileURLToPath(new URL(`../../testing/fixtures/${name}.jsonl`, import.meta.url))
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** Spawns each replayer in order (one per provider process). */
function sequence(...replayers: FixtureReplayer[]): ProcessSpawner {
  let index = 0
  return (spec, handlers) => {
    const replayer = replayers[index++]
    if (!replayer) throw new Error('no more fixture processes')
    return replayer.spawner(spec, handlers)
  }
}

function setup(...replayers: FixtureReplayer[]) {
  const journal = new MemoryJournal()
  const clock = new FakeClock()
  const factory = new ClaudeDriverFactory({ spawner: sequence(...replayers), terminateGraceMs: 10 })
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

describe('Claude driver against recorded transcripts', () => {
  it('runs a background sub-agent across turns: continuation turns, re-entrant status, nested shell, cost deltas', async () => {
    const replayer = FixtureReplayer.fromFile(fixture('claude-bg-complete'))
    const ctx = setup(replayer)
    const { sessionId } = await ctx.service.open({ driver: 'claude', model: 'haiku', cwd: '/repo', policy: { subagents: 'enabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Launch ONE background sub-agent', delivery: 'queue' })
    await drain(replayer)
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)

    const snapshot = ctx.service.snapshot(sessionId)
    expect(snapshot.providerSessionRef).toBe('3b6a1e18-0565-49af-a8d0-27d150fcc71d')
    expect(snapshot.turns.map((turn) => [turn.origin, turn.status])).toEqual([['user', 'completed'], ['subagent', 'completed'], ['subagent', 'completed']])
    expect(snapshot.inputs['in-1']?.state).toBe('completed')

    const agent = snapshot.subagents.ad79e3d096afc7b61!
    expect(agent).toMatchObject({ parentId: null, kind: 'background', agentType: 'general-purpose', phase: 'idle', restarts: 1 })
    expect(agent.resultSummary).toContain('SUBDONE')
    const shell = snapshot.subagents.brlqb25fs!
    expect(shell).toMatchObject({ parentId: 'ad79e3d096afc7b61', agentType: 'shell', phase: 'idle' })

    const costs = of(ctx.events(sessionId), 'turn.completed').map((turn) => turn.usage.costUsd!)
    expect(costs[0]).toBeCloseTo(0.0272757, 7)
    expect(costs[1]).toBeCloseTo(0.0680647 - 0.0272757, 7)
    expect(costs[2]).toBeCloseTo(0.0798575 - 0.0680647, 7)
    expect(of(ctx.events(sessionId), 'subagent.output').some((event) => event.subagentId === 'ad79e3d096afc7b61' && event.tool?.name === 'Bash')).toBe(true)
    expect(snapshot.phase).toBe('idle')
    expect(snapshot.settled).toEqual({ settled: true, live: 0 })
    expect(replayer.last.terminated).toBe(false)
  })

  it('attributes a foreground sub-agent and its tools without leaking them into the parent turn', async () => {
    const replayer = FixtureReplayer.fromFile(fixture('claude-fg'))
    const ctx = setup(replayer)
    const { sessionId } = await ctx.service.open({ driver: 'claude', model: 'haiku', cwd: '/repo', policy: { subagents: 'enabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Use a foreground agent', delivery: 'queue' })
    await drain(replayer)

    const snapshot = ctx.service.snapshot(sessionId)
    const [node] = Object.values(snapshot.subagents)
    expect(node).toMatchObject({ kind: 'foreground', phase: 'idle' })
    const parentTools = of(ctx.events(sessionId), 'turn.tool').map((event) => event.name)
    expect(parentTools).toEqual(['Agent', 'Agent'])
    const childTools = of(ctx.events(sessionId), 'subagent.output').filter((event) => event.tool).map((event) => `${event.tool!.name}:${event.tool!.phase}`)
    expect(childTools).toEqual(['Bash:started', 'Bash:completed'])
    expect(of(ctx.events(sessionId), 'turn.completed')[0]?.text).toContain('FGDONE')
  })

  it('delivers a user message written while sub-agents run as its own turn, in provider order', async () => {
    const replayer = FixtureReplayer.fromFile(fixture('claude-parallel-and-user-turn'))
    const ctx = setup(replayer)
    const { sessionId } = await ctx.service.open({ driver: 'claude', model: 'haiku', cwd: '/repo', policy: { subagents: 'enabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Launch two agents', delivery: 'queue' })
    await drain(replayer)
    await ctx.service.send(sessionId, { inputId: 'in-2', text: 'What is 2+2?', delivery: 'queue' })
    await drain(replayer)
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)

    const snapshot = ctx.service.snapshot(sessionId)
    expect(snapshot.turns.map((turn) => turn.origin)).toEqual(['user', 'subagent', 'user', 'subagent', 'subagent'])
    expect(of(ctx.events(sessionId), 'input.state').filter((event) => event.inputId === 'in-2').map((event) => event.state)).toEqual(['queued', 'started', 'completed'])
    expect(of(ctx.events(sessionId), 'turn.completed')[2]?.text).toBe('Four.')
    const agents = Object.values(snapshot.subagents).filter((node) => node.agentType !== 'shell')
    expect(agents).toHaveLength(2)
    expect(agents.every((node) => node.phase === 'idle')).toBe(true)
  })

  it('enforces sub-agents disabled through the CLI flags', async () => {
    const replayer = FixtureReplayer.fromFile(fixture('claude-disallowed'))
    const ctx = setup(replayer)
    const { sessionId } = await ctx.service.open({ driver: 'claude', model: 'haiku', cwd: '/repo', policy: { subagents: 'disabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Try to use the Agent tool', delivery: 'queue' })
    await drain(replayer)
    const args = replayer.last.spec.args
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Agent,Task')
    expect(of(ctx.events(sessionId), 'turn.completed')[0]?.text).toMatch(/^NO_AGENT_TOOL/)
    expect(ctx.service.snapshot(sessionId).subagents).toEqual({})
  })

  it('stops background work by ending the process, records the provider stop notices, and resumes with a one-time notice', async () => {
    const killed = FixtureReplayer.fromFile(fixture('claude-kill-bg'))
    const resumed = FixtureReplayer.fromFile(fixture('claude-resume-after-kill'))
    const ctx = setup(killed, resumed)
    const { sessionId } = await ctx.service.open({ driver: 'claude', model: 'haiku', cwd: '/repo', policy: { subagents: 'enabled' } })
    await ctx.service.send(sessionId, { inputId: 'in-1', text: 'Launch a long background agent', delivery: 'queue' })
    await drain(killed)
    expect(ctx.service.snapshot(sessionId).phase).toBe('background')

    expect((await ctx.service.stopSubagents(sessionId)).stopped).toContain('b0p3rmiw9')
    expect(killed.last.terminated).toBe(true)
    const stopped = ctx.service.snapshot(sessionId)
    expect(stopped.subagents.b0p3rmiw9?.phase).toBe('killed')
    expect(stopped).toMatchObject({ phase: 'idle', process: { alive: false } })

    await ctx.service.send(sessionId, { inputId: 'in-2', text: 'What is the status of the subagent you launched? One line.', delivery: 'queue' })
    await drain(resumed)
    const args = resumed.last.spec.args
    expect(args[args.indexOf('--resume') + 1]).toBe('3fdd2f4f-4ac9-4906-9c1c-ba9ac04ddc63')
    const sent = resumed.last.written[0] as { message: { content: string } }
    expect(sent.message.content).toMatch(/\[Specrails session notice\][\s\S]*Do not relaunch or resume them[\s\S]*What is the status/)
    const costs = of(ctx.events(sessionId), 'turn.completed').map((turn) => turn.usage.costUsd)
    // Session-cumulative USD continues across --resume: the resumed turn records only its own delta.
    expect(costs.at(-1)).toBeCloseTo(0.0698117 - 0.0636739, 7)
  })
})

describe('Claude argv', () => {
  const spec = (policy: Parameters<typeof resolvePolicy>[0], extra: Partial<Parameters<typeof claudeArgs>[0]> = {}) =>
    claudeArgs({ sessionId: 's', generation: 1, cwd: '/r', model: 'sonnet', effort: null, systemPrompt: null, providerSessionRef: null, policy: resolvePolicy(policy, CLAUDE_DESCRIPTOR), ...extra })

  it('maps policy to flags', () => {
    const args = spec({ subagents: 'enabled', permissions: 'bypass', mcp: { servers: [{ name: 'specrails', url: 'http://127.0.0.1:9/mcp' }], inheritUserScope: false } })
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toContain('--strict-mcp-config')
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: { specrails: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } })
    expect(args).not.toContain('--disallowedTools')
  })

  it('combines denied tools with the sub-agent switch and maps read-only modes', () => {
    const args = spec({ subagents: 'disabled', permissions: 'read-only', tools: { mode: 'read-only', deny: ['WebFetch', 'Agent'] }, mcp: { inheritUserScope: true } })
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('WebFetch,Agent,Task')
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(args).not.toContain('--strict-mcp-config')
  })

  it('resumes, sets effort and prefers a prompt file when given', () => {
    const args = spec({ subagents: 'enabled' }, { providerSessionRef: 'abc', effort: 'high', systemPrompt: 'be brief' })
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'abc'])
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'high'])
    expect(args).toContain('--system-prompt')
    expect(claudeArgs({ sessionId: 's', generation: 1, cwd: '/r', model: 'm', effort: null, systemPrompt: 'x', providerSessionRef: null, policy: resolvePolicy({ subagents: 'enabled' }, CLAUDE_DESCRIPTOR) }, { systemPromptFile: '/tmp/p.md' })).toContain('--system-prompt-file')
  })

  it('runs native sub-agents on another model through the environment, never inheriting a stale one', () => {
    const native = resolvePolicy({ subagents: 'enabled', subagentRuntime: { mode: 'native', model: 'sonnet' } }, CLAUDE_DESCRIPTOR)
    expect(claudeEnv(native, { PATH: '/bin', CLAUDE_CODE_SUBAGENT_MODEL: 'opus' })).toEqual({ PATH: '/bin', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' })
    expect(claudeEnv(resolvePolicy({ subagents: 'enabled' }, CLAUDE_DESCRIPTOR), { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' })).toEqual({})
  })

  it('switches its own sub-agent tools off when Core launches sub-agents', () => {
    const args = spec({ subagents: 'enabled', subagentRuntime: { mode: 'delegated', driver: 'codex' } })
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Agent,Task')
    expect(claudeEnv(resolvePolicy({ subagents: 'enabled', subagentRuntime: { mode: 'delegated', driver: 'codex', model: 'x' } }, CLAUDE_DESCRIPTOR), {})).toEqual({})
  })

  it('cannot give Claude sub-agents their own effort', () => {
    expect(() => resolvePolicy({ subagents: 'enabled', subagentRuntime: { mode: 'native', effort: 'low' } }, CLAUDE_DESCRIPTOR)).toThrow(/effort/)
  })
})

describe('Claude translator edge cases', () => {
  it('reports each unknown frame kind once and never fails', () => {
    const translator = new ClaudeTranslator()
    expect(translator.translate({ type: 'mystery' })).toHaveLength(1)
    expect(translator.translate({ type: 'mystery' })).toHaveLength(0)
    expect(translator.translate({ type: 'system', subtype: 'brand_new' })[0]).toMatchObject({ kind: 'diagnostic', code: 'provider.unknown' })
    expect(translator.translate({ type: 'rate_limit_event' })).toEqual([])
  })

  it('ignores an orphan notification result and receipts for inputs it did not write', () => {
    const translator = new ClaudeTranslator()
    expect(translator.translate({ type: 'result', origin: { kind: 'task-notification' }, num_turns: 0, result: '' })).toEqual([])
    expect(translator.translate({ type: 'command_lifecycle', command_uuid: 'foreign', state: 'started' })).toEqual([])
  })

  it('marks an interrupted turn as stopped and an error result as failed', () => {
    const translator = new ClaudeTranslator()
    translator.noteInput('i1')
    translator.translate({ type: 'command_lifecycle', command_uuid: 'i1', state: 'started' })
    translator.translate({ type: 'system', subtype: 'init', session_id: 's' })
    translator.noteInterrupt()
    expect(translator.translate({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' })[0]).toMatchObject({ status: 'stopped' })
    translator.translate({ type: 'system', subtype: 'init', session_id: 's' })
    expect(translator.translate({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'limit' })[0]).toMatchObject({ status: 'failed', error: 'limit' })
  })
})
