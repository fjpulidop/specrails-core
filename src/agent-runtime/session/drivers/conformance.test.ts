import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { AgentExecutor, AgentRequest } from '../../executor-types.js'
import { validateDescriptor } from '../domain/descriptor.js'
import { DRIVER_CONFORMANCE, type ConformanceHarness } from '../testing/driver-conformance.js'
import { FixtureReplayer } from '../testing/fixture-replayer.js'
import { descriptor } from '../testing/scripted-driver.js'
import { ClaudeDriverFactory } from './claude/driver.js'
import { CodexDriverFactory } from './codex/driver.js'
import { ExecutorDriverFactory, executorDescriptor } from './executor/driver.js'
import { DriverRegistry, createDriverRegistry } from './registry.js'

const fixture = (name: string) => fileURLToPath(new URL(`../testing/fixtures/${name}.jsonl`, import.meta.url))
const tick = () => new Promise((resolve) => setImmediate(resolve))

function replayHarness(name: string, make: (replayer: FixtureReplayer) => ConformanceHarness['factory'] extends () => infer F ? F : never, model: string, subagents: 'enabled' | 'disabled'): ConformanceHarness {
  const replayers = new WeakMap<object, FixtureReplayer>()
  return {
    model,
    subagents,
    factory() {
      const replayer = FixtureReplayer.fromFile(fixture(name))
      const factory = make(replayer)
      replayers.set(factory, replayer)
      return factory
    },
    async settle(factory) {
      const replayer = replayers.get(factory)!
      for (let index = 0; index < 5; index++) {
        if (replayer.sessions.length) await replayer.last.idle()
        await tick()
      }
    },
  }
}

/** A deterministic executor standing in for Gemini/Kimi/OpenAI-compatible CLIs. */
class EchoExecutor implements AgentExecutor {
  readonly requests: AgentRequest[] = []
  async execute(request: AgentRequest) {
    this.requests.push(request)
    request.onEvent?.({ kind: 'session', sessionId: 'echo-session' })
    request.onEvent?.({ kind: 'tool-start', tool: 'read_file', detail: 'README.md' })
    request.onEvent?.({ kind: 'tool-end', tool: 'read_file' })
    request.onEvent?.({ kind: 'text', text: 'ok' })
    return { text: 'ok', usage: { inputTokens: 10, outputTokens: 2, costUsd: null }, sessionId: 'echo-session' }
  }
}

const harnesses: Array<[string, ConformanceHarness]> = [
  ['claude', replayHarness('claude-disallowed', (replayer) => new ClaudeDriverFactory({ spawner: replayer.spawner, terminateGraceMs: 10 }), 'haiku', 'disabled')],
  ['codex', replayHarness('codex-disabled', (replayer) => new CodexDriverFactory({ spawner: replayer.spawner, terminateGraceMs: 10, declaredMcpServers: [] }), 'gpt-5.6-luna', 'disabled')],
  ['executor', {
    model: 'gemini-2.5-flash',
    subagents: 'disabled',
    factory: () => new ExecutorDriverFactory(executorDescriptor('gemini', 'Gemini CLI'), new EchoExecutor()),
    settle: async () => { for (let index = 0; index < 5; index++) await tick() },
  }],
]

describe.each(harnesses)('driver conformance: %s', (_name, harness) => {
  it.each(DRIVER_CONFORMANCE.map((check) => [check.name, check] as const))('%s', async (_check, check) => {
    await check.run(harness)
  })
})

describe('driver registry', () => {
  it('wires Claude, Codex and executor-backed drivers with valid descriptors', () => {
    const registry = createDriverRegistry({ executors: [{ id: 'gemini', displayName: 'Gemini CLI', executor: new EchoExecutor() }] })
    expect(registry.descriptors().map((item) => item.id)).toEqual(['claude', 'codex', 'gemini'])
    expect(registry.get('gemini')?.descriptor.capabilities).toMatchObject({ resident: false, subagents: 'unsupported' })
    expect(createDriverRegistry({ claude: false, codex: false }).descriptors()).toEqual([])
    expect(Object.isFrozen(registry)).toBe(true)
  })

  it('rejects duplicate ids and incoherent descriptors', () => {
    const fake = (id: string, caps = {}) => ({ descriptor: descriptor(id, caps), open: async () => { throw new Error('unused') } })
    expect(() => new DriverRegistry([fake('a'), fake('a')])).toThrow(/Duplicate/)
    expect(() => new DriverRegistry([fake('Bad Id')])).toThrow(/id must match/)
    expect(() => validateDescriptor(descriptor('x', { subagents: 'unsupported', subagentDisable: true }))).toThrow(/sub-agent capabilities/)
    expect(() => validateDescriptor(descriptor('x', { resident: false }))).toThrow(/native input queue requires/)
    expect(() => validateDescriptor(descriptor('x', { resident: false, nativeInputQueue: false }))).toThrow(/autonomous continuation requires/)
  })
})

describe('executor-backed driver', () => {
  it('runs each input as one resumable executor invocation with the system prompt only once', async () => {
    const executor = new EchoExecutor()
    const events: unknown[] = []
    const factory = new ExecutorDriverFactory(executorDescriptor('kimi', 'Kimi'), executor)
    const session = await factory.open({ sessionId: 's', generation: 1, cwd: '/repo', model: 'k2', effort: 'high', systemPrompt: 'SYSTEM', providerSessionRef: null, policy: { subagents: 'disabled', onSubagentsSettled: 'notify-only', tools: { mode: 'default' }, permissions: 'read-only', mcp: { servers: [], inheritUserScope: false }, limits: { idleMs: 1000, stallMs: 1000, backgroundMaxMs: 1000, turnInactivityMs: 1000, maxSettleHandoffs: 0, settleDebounceMs: 0 } } }, (event) => events.push(event))
    await session.send({ inputId: 'a', text: 'first', delivery: 'queue' })
    await tick()
    await session.send({ inputId: 'b', text: 'second', delivery: 'queue', attachments: [{ kind: 'file', path: '/repo/x.md' }] })
    await tick()
    expect(executor.requests.map((request) => [request.prompt, request.resumeSessionId, request.access, request.effort])).toEqual([
      ['SYSTEM\n\nfirst', undefined, 'read', 'high'],
      ['second\n\nAttached files:\n- /repo/x.md', 'echo-session', 'read', 'high'],
    ])
    expect(events).toContainEqual({ kind: 'turn.tool', toolUseId: 'tool-1', name: 'read_file', phase: 'started', input: 'README.md' })
  })

  it('maps an aborted invocation to a stopped turn and failures to failed turns', async () => {
    const { AgentExecutionError } = await import('../../executor-types.js')
    const events: Array<{ kind: string; status?: string; error?: string }> = []
    const executor: AgentExecutor = {
      async execute(request) {
        if (request.prompt === 'boom') throw new Error('provider crashed')
        await new Promise((_, reject) => request.signal?.addEventListener('abort', () => reject(new AgentExecutionError('Agent cancelled', 'aborted'))))
        throw new Error('unreachable')
      },
    }
    const session = await new ExecutorDriverFactory(executorDescriptor('gemini', 'Gemini'), executor).open({ sessionId: 's', generation: 1, cwd: '/r', model: 'm', effort: null, systemPrompt: null, providerSessionRef: 'prev', policy: { subagents: 'disabled', onSubagentsSettled: 'notify-only', tools: { mode: 'default' }, permissions: 'workspace-write', mcp: { servers: [], inheritUserScope: false }, limits: { idleMs: 1000, stallMs: 1000, backgroundMaxMs: 1000, turnInactivityMs: 1000, maxSettleHandoffs: 0, settleDebounceMs: 0 } } }, (event) => events.push(event as never))
    await session.send({ inputId: 'a', text: 'long', delivery: 'queue' })
    await expect(session.send({ inputId: 'x', text: 'parallel', delivery: 'queue' })).rejects.toThrow(/one turn at a time/)
    await session.interrupt()
    await tick()
    await session.send({ inputId: 'b', text: 'boom', delivery: 'queue' })
    await tick()
    const done = events.filter((event) => event.kind === 'turn.completed')
    expect(done.map((event) => event.status)).toEqual(['stopped', 'failed'])
    expect(done[1]?.error).toBe('provider crashed')
    await session.close('host_request')
    await expect(session.send({ inputId: 'c', text: 'late', delivery: 'queue' })).rejects.toThrow(/closed/)
  })
})
