import { Command, MemorySaver } from '@langchain/langgraph'
import { describe, expect, it } from 'vitest'
import { contentDigest } from './canonical-json.js'
import { compileWorkflowDefinition } from './compiler.js'
import { EngineError, type AttemptFrame, type NodeExecutionPort, type Piece, type TerminalCommit } from './contracts.js'
import type { WorkflowDefinitionDraft } from './definition-types.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { PieceRegistry } from './piece-registry.js'
import { initialDefinitionState } from './state.js'

class ObservedSaver extends MemorySaver {
  readonly commits: TerminalCommit[] = []
  override async putWrites(...args: Parameters<MemorySaver['putWrites']>): Promise<void> {
    const marker = args[1].find(([channel]) => channel === '$commit')?.[1] as TerminalCommit | undefined
    if (marker) {
      expect(marker.frame.task.taskId).toBe(args[2])
      expect(marker.frame.task.checkpointId).toBe(args[0].configurable?.checkpoint_id)
      this.commits.push(marker)
    }
    await super.putWrites(...args)
  }
}

function execution(maxTransitions = 20): { port: NodeExecutionPort; frames: AttemptFrame[] } {
  const tasks = new Map<string, AttemptFrame>()
  const paused = new Set<string>()
  const frames: AttemptFrame[] = []
  const port: NodeExecutionPort = {
    async enter(input) {
      const key = contentDigest(input.task)
      const prior = tasks.get(key)
      if (!prior && tasks.size >= maxTransitions) throw new EngineError('recursion_limit', 'Global visit budget exhausted')
      const attempt = prior ? prior.attempt + (paused.delete(key) ? 0 : 1) : 1
      const frame: AttemptFrame = { runId: 'test', nodePath: input.nodePath, scope: input.scope, task: input.task,
        visitId: key, visit: prior?.visit ?? [...tasks.values()].filter(row => row.nodePath === input.nodePath && row.scope.id === input.scope.id).length + 1,
        transition: prior?.transition ?? tasks.size + 1, attemptId: key + ':' + attempt, attempt, leaseEpoch: 1 }
      tasks.set(key, frame); frames.push(frame); return frame
    },
    async execute(_frame, _effect, operation) { return operation(new AbortController().signal) },
    terminal(frame, result) { return { schemaVersion: 1, frame, result, digest: contentDigest({ frame, result }) } },
    async interrupted(frame) { paused.add(contentDigest(frame.task)) },
    async failed(_frame, _error, options) { return { retryable: options.retry } },
    progress() {},
  }
  return { port, frames }
}

function definition(nodes: WorkflowDefinitionDraft['nodes'], registry: PieceRegistry, entry = Object.keys(nodes)[0], components?: WorkflowDefinitionDraft['components']) {
  const result = validateWorkflowDefinition({ schemaVersion: 1, id: 'test', title: 'Test graph', journal: 'ledger-only', change: 'none', entry, maxTransitions: 20, roles: [], nodes, ...(components ? { components } : {}) }, registry)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.definition
}

const fixture = (kind: string, outcomes: string[], execute: Piece['execute']): Piece => ({ descriptor: { kind, outcomes, effect: 'read', requiresAI: false, paramsSchema: { type: 'object' } }, execute })

describe('real LangGraph definition compilation', () => {
  it('routes conditional loops and correlates every commit to real task metadata', async () => {
    const registry = new PieceRegistry([fixture('condition', ['true', 'false'], async (_params, ctx) => {
      const count = Number(ctx.state.$vars.count ?? 0) + 1
      return { outcome: count < 3 ? 'true' : 'false', output: { count }, vars: { count } }
    })])
    const def = definition({ loop: { kind: 'condition', params: {}, ends: { true: 'loop', false: null } } }, registry)
    const { port, frames } = execution()
    const saver = new ObservedSaver()
    const graph = compileWorkflowDefinition(def, registry, port, { checkpointer: saver })
    const result = await graph.invoke(initialDefinitionState(), { configurable: { thread_id: 'loop' }, durability: 'sync' })
    expect(result.$vars.count).toBe(3)
    expect(frames.map(frame => [frame.visit, frame.attempt, frame.transition])).toEqual([[1, 1, 1], [2, 1, 2], [3, 1, 3]])
    expect(saver.commits).toHaveLength(3)
    expect(new Set(frames.map(frame => frame.task.taskId)).size).toBe(3)
  })
  it('retries a classified transport failure in the same durable visit', async () => {
    let calls = 0
    const registry = new PieceRegistry([fixture('prompt', ['next', 'failed'], async () => {
      if (++calls === 1) throw new EngineError('provider_request_error', 'fixture transient failure')
      return { outcome: 'next', output: 'done' }
    })])
    const def = definition({ turn: { kind: 'prompt', params: {}, ends: { next: null, failed: null }, retry: { maxAttempts: 2, backoffMs: 0 } } }, registry)
    const { port, frames } = execution()
    const saver = new ObservedSaver()
    const graph = compileWorkflowDefinition(def, registry, port, { checkpointer: saver })
    await graph.invoke(initialDefinitionState(), { configurable: { thread_id: 'retry' }, durability: 'sync' })
    expect(frames.map(frame => [frame.visit, frame.attempt, frame.transition])).toEqual([[1, 1, 1], [1, 2, 1]])
    expect(saver.commits).toHaveLength(1)
    expect(saver.commits[0].frame.attempt).toBe(2)
  })
  it('resumes a human interruption without replaying its completed predecessor', async () => {
    let preparations = 0
    const registry = new PieceRegistry([
      fixture('condition', ['true', 'false'], async () => { preparations += 1; return { outcome: 'true' } }),
      fixture('question', ['next'], async (_params, ctx) => {
        const answer = ctx.interrupt({ kind: 'question', prompt: 'Continue?', nodePath: ctx.frame.nodePath, scopeId: ctx.frame.scope.id, attemptId: ctx.frame.attemptId })
        return { outcome: 'next', output: answer }
      }),
    ])
    const def = definition({ prepare: { kind: 'condition', params: {}, ends: { true: 'ask', false: null } }, ask: { kind: 'question', params: {}, ends: { next: null } } }, registry)
    const { port, frames } = execution()
    const saver = new ObservedSaver()
    const graph = compileWorkflowDefinition(def, registry, port, { checkpointer: saver })
    const config = { configurable: { thread_id: 'interrupt' }, durability: 'sync' as const }
    await graph.invoke(initialDefinitionState(), config)
    const paused = await graph.getState(config)
    expect(paused.tasks[0].interrupts).toHaveLength(1)
    const result = await graph.invoke(new Command({ resume: { [paused.tasks[0].interrupts[0].id!]: 'yes' } }), config)
    expect(result.$outputs.ask).toBe('yes')
    expect(preparations).toBe(1)
    expect(frames.filter(frame => frame.nodePath === 'ask').map(frame => [frame.visit, frame.attempt])).toEqual([[1, 1], [1, 1]])
    expect(saver.commits).toHaveLength(2)
  })
  it('does not execute a piece when interpolation is missing and commits its failure', async () => {
    let calls = 0
    const registry = new PieceRegistry([fixture('prompt', ['next', 'failed'], async () => { calls += 1; return { outcome: 'next' } })])
    const def = definition({ turn: { kind: 'prompt', params: { text: '{{run.missing}}' }, ends: { next: null, failed: null } } }, registry)
    const { port } = execution()
    const saver = new ObservedSaver()
    const graph = compileWorkflowDefinition(def, registry, port, { checkpointer: saver })
    await graph.invoke(initialDefinitionState(), { configurable: { thread_id: 'missing' }, durability: 'sync' })
    expect(calls).toBe(0)
    expect(saver.commits[0].result.error?.code).toBe('run_var_missing')
    expect(saver.commits[0].result.status).toBe('failed')
  })
  it('enforces the shared admission transition limit before another node executes', async () => {
    let calls = 0
    const registry = new PieceRegistry([fixture('condition', ['true', 'false'], async () => { calls += 1; return { outcome: 'true' } })])
    const def = definition({ loop: { kind: 'condition', params: {}, ends: { true: 'loop', false: null } } }, registry)
    const { port } = execution(2)
    const graph = compileWorkflowDefinition(def, registry, port, { checkpointer: new MemorySaver() })
    await expect(graph.invoke(initialDefinitionState(), { configurable: { thread_id: 'bound' } })).rejects.toThrow('Global visit budget')
    expect(calls).toBe(2)
  })
  it('inspects and resumes nested component state without repeating completed work or ending the parent early', async () => {
    let preparations = 0, parentAfter = 0
    const registry = new PieceRegistry([
      fixture('component', ['next', 'failed'], async () => { throw new Error('Compiler must handle composition') }),
      fixture('condition', ['true', 'false'], async (_params, ctx) => {
        if (ctx.frame.nodePath === 'after') parentAfter += 1
        else preparations += 1
        return { outcome: 'true', vars: { captured: 'retained' } }
      }),
      fixture('question', ['next'], async (_params, ctx) => {
        expect(ctx.state.$vars.captured).toBe('retained')
        const answer = ctx.interrupt({ kind: 'question', prompt: 'Continue nested?', nodePath: ctx.frame.nodePath, scopeId: ctx.frame.scope.id, attemptId: ctx.frame.attemptId })
        return { outcome: 'next', output: answer }
      }),
    ])
    const def = definition({ nested: { kind: 'component', params: { ref: 'body', inputs: { captured: 'initial' } }, ends: { next: 'after', failed: null } },
      after: { kind: 'condition', params: {}, ends: { true: null, false: null } } }, registry, 'nested', {
      body: { entry: 'prepare', nodes: { prepare: { kind: 'condition', params: {}, ends: { true: 'ask', false: null } }, ask: { kind: 'question', params: {}, ends: { next: null } } } },
    })
    const { port, frames } = execution()
    const saver = new ObservedSaver()
    const graph = compileWorkflowDefinition(def, registry, port, { checkpointer: saver })
    const config = { configurable: { thread_id: 'nested' }, durability: 'sync' as const }
    await graph.invoke(initialDefinitionState(), config)
    const paused = await graph.getState(config, { subgraphs: true })
    expect(paused.tasks[0].state).toHaveProperty('values')
    expect(parentAfter).toBe(0)
    await graph.invoke(new Command({ resume: { [paused.tasks[0].interrupts[0].id!]: 'yes' } }), config)
    expect(preparations).toBe(1)
    expect(parentAfter).toBe(1)
    expect(frames.some(frame => frame.nodePath === 'nested/ask')).toBe(true)
    expect(saver.commits.filter(marker => marker.result.completesRun).map(marker => marker.frame.nodePath)).toEqual(['after'])
  })
  it('keeps completed map siblings and deferred join stable across a branch interruption', async () => {
    const calls = new Map<number, number>()
    const registry = new PieceRegistry([
      fixture('map', ['next'], async () => { throw new Error('Compiler owns map') }),
      fixture('join', ['next', 'fail'], async () => { throw new Error('Compiler owns join') }),
      fixture('condition', ['true', 'false'], async (_params, ctx) => {
        const index = ctx.state.$item!.index
        calls.set(index, (calls.get(index) ?? 0) + 1)
        return { outcome: 'true', vars: { saved: 'branch-' + index }, output: ctx.state.$item!.value }
      }),
      fixture('question', ['next'], async (_params, ctx) => {
        const index = ctx.state.$item!.index
        expect(ctx.state.$vars.saved).toBe('branch-' + index)
        const answer = index === 1 ? ctx.interrupt({ kind: 'question', prompt: 'Continue branch?', nodePath: ctx.frame.nodePath, scopeId: ctx.frame.scope.id, attemptId: ctx.frame.attemptId }) : 'automatic'
        return { outcome: 'next', output: answer }
      }),
    ])
    const def = definition({ each: { kind: 'map', params: { over: 'tickets', body: 'body', concurrency: 2 }, ends: { next: 'gather' } },
      gather: { kind: 'join', params: { reduce: 'all-ok' }, ends: { next: null, fail: null } } }, registry, 'each', {
      body: { entry: 'prepare', nodes: { prepare: { kind: 'condition', params: {}, ends: { true: 'ask', false: null } }, ask: { kind: 'question', params: {}, ends: { next: null } } } },
    })
    const { port, frames } = execution()
    const saver = new ObservedSaver()
    const graph = compileWorkflowDefinition(def, registry, port, { checkpointer: saver, collections: { tickets: ['a', 'b', 'c'] } })
    const config = { configurable: { thread_id: 'mapped' }, durability: 'sync' as const }
    await graph.invoke(initialDefinitionState(), config)
    expect(frames.some(frame => frame.nodePath === 'gather')).toBe(false)
    expect([...calls.values()]).toEqual([1, 1, 1])
    const paused = await graph.getState(config, { subgraphs: true })
    const pending = paused.tasks.flatMap(task => task.interrupts)
    expect(pending).toHaveLength(1)
    const result = await graph.invoke(new Command({ resume: { [pending[0].id!]: 'yes' } }), config)
    expect([...calls.values()]).toEqual([1, 1, 1])
    expect(frames.filter(frame => frame.nodePath === 'gather')).toHaveLength(1)
    expect(result.$outputs.gather).toMatchObject({ total: 3, ok: 3, failed: 0 })
    expect(result.$branches.each.results.map(row => row.index)).toEqual([0, 1, 2])
    const branchFrames = frames.filter(frame => frame.nodePath === 'each/prepare')
    expect(new Set(branchFrames.map(frame => frame.scope.id)).size).toBe(3)
    expect(branchFrames.every(frame => frame.visit === 1 && frame.scope.limits?.[0].concurrency === 2)).toBe(true)
    expect(saver.commits.filter(marker => marker.result.completesRun).map(marker => marker.frame.nodePath)).toEqual(['gather'])
  })
  it.each([['collect', 'next'], ['all-ok', 'fail'], ['any-ok', 'next']] as const)('applies %s after mixed branch results', async (reduce, expected) => {
    const registry = new PieceRegistry([
      fixture('map', ['next'], async () => { throw new Error('Compiler owns map') }),
      fixture('join', ['next', 'fail'], async () => { throw new Error('Compiler owns join') }),
      fixture('condition', ['true', 'false'], async (_params, ctx) => ({ outcome: ctx.state.$item?.index === 0 ? 'true' : 'false' })),
    ])
    const def = definition({ each: { kind: 'map', params: { over: 'tickets', body: 'body' }, ends: { next: 'gather' } }, gather: { kind: 'join', params: { reduce }, ends: { next: null, fail: null } } }, registry, 'each', {
      body: { entry: 'result', nodes: { result: { kind: 'condition', params: {}, ends: { true: null, false: null } } } },
    })
    const { port } = execution()
    const graph = compileWorkflowDefinition(def, registry, port, { checkpointer: new MemorySaver(), collections: { tickets: ['yes', 'no'] } })
    const result = await graph.invoke(initialDefinitionState(), { configurable: { thread_id: reduce }, durability: 'sync' })
    expect(result.$lastOutcome.gather).toBe(expected)
    expect(result.$outputs.gather).toMatchObject({ total: 2, ok: 1, failed: 1 })
  })
})
