import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Annotation } from '@langchain/langgraph'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWorkflow, readWorkflowState, type JsonValue, type NodeResult, type RunWorkflowOptions, type WorkflowNode, type WorkflowState } from './workflow.js'
import { readWorkflowEnvelope, writeWorkflowEnvelope } from './durable-store.js'

/** A generic host state: nodes leave notes for each other through a merging reducer. */
const TestState = Annotation.Root({
  notes: Annotation<Record<string, unknown>>({ reducer: (previous, next) => ({ ...previous, ...next }), default: () => ({}) }),
})
type S = typeof TestState.State
type Node = WorkflowNode<S>
type Result = NodeResult<S>
type Def = { id: string; ends?: string[] } & Partial<Omit<Node, 'ends'>> & Pick<Node, 'run'>

const zero = { costUsd: 0, inputTokens: 0, outputTokens: 0 }
const success = (notes?: Record<string, JsonValue>, extra: Partial<Result> = {}): Result => ({ ...(notes ? { update: { notes }, output: notes } : {}), ...extra, status: 'succeeded', usage: extra.usage ?? zero })
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'specrails workflow with spaces ')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

/** Declares nodes in order; a node without `ends` flows to the next declared node. */
function nodes(defs: Def[]): Record<string, Node> {
  return Object.fromEntries(defs.map((def, index) => {
    const { id, ends, ...rest } = def
    return [id, { ...rest, ends: ends ?? (defs[index + 1] ? [defs[index + 1]!.id] : []) }]
  }))
}
function options(defs: Def[], overrides: Partial<RunWorkflowOptions<S>> = {}): RunWorkflowOptions<S> {
  return { directory, runId: 'run-1', input: { change: 'example' }, workflow: { id: 'implement', version: '1', schema: TestState, entry: defs[0]!.id, nodes: nodes(defs) }, ...overrides }
}
/** Simulates a crash by editing the ledger while keeping the graph history, exactly what a dead process leaves behind. */
async function patchState(runId: string, mutate: (state: WorkflowState) => void): Promise<void> {
  const envelope = (await readWorkflowEnvelope(directory, runId))!
  mutate(envelope.state)
  await writeWorkflowEnvelope(directory, envelope)
}
/** Runs a two-node workflow in a child process that dies as soon as the named node starts. */
function crashAt(stepId: string, effect: 'read' | 'write'): void {
  const moduleUrl = new URL('../../dist/agent-runtime/workflow.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Annotation } from '@langchain/langgraph';
    import { runWorkflow } from ${JSON.stringify(moduleUrl)};
    const schema = Annotation.Root({ notes: Annotation({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }) });
    await runWorkflow({ directory: ${JSON.stringify(directory)}, runId: 'run-1', input: {change:'example'},
      workflow: {id:'implement',version:'1',schema,entry:'read',nodes:{
        read:{ends:['write'],run:async()=>({status:'succeeded',output:'kept',update:{notes:{read:'kept'}},usage:{costUsd:0,inputTokens:0,outputTokens:0}})},
        write:{effect:${JSON.stringify(effect)},ends:[],run:async()=>({status:'succeeded'})}
      }},onEvent:event=>{if(event.type==='step_started'&&event.stepId===${JSON.stringify(stepId)})process.exit(71)}});
  `], { encoding: 'utf8', cwd: process.cwd() })
  expect(child.status, child.stderr).toBe(71)
}

describe('durable LangGraph workflow', () => {
  it('executes explicit phases and a conditional correction loop over graph state', async () => {
    const trace: string[] = []
    let valid = false
    const state = await runWorkflow(options([
      { id: 'architect', run: async () => { trace.push('architect'); return success({ plan: true }) } },
      { id: 'developer', effect: 'write', run: async (graph, context) => {
        trace.push('developer')
        expect(graph.notes).toEqual(expect.objectContaining({ plan: true }))
        expect(context.attemptId).toMatch(/^[0-9a-f-]{36}$/)
        return success({ revision: context.checkpoint.steps.developer!.visits })
      } },
      { id: 'verify', ends: ['reviewer', 'developer'], run: async graph => {
        trace.push('verify')
        expect(graph.notes.revision).toBe(valid ? 2 : 1)
        const result = success({ valid }, { next: valid ? 'reviewer' : 'developer' })
        valid = true
        return result
      } },
      { id: 'reviewer', run: async () => { trace.push('reviewer'); return success() } },
    ]))
    expect(trace).toEqual(['architect', 'developer', 'verify', 'developer', 'verify', 'reviewer'])
    expect(state.status).toBe('succeeded')
    expect(state.transitions).toBe(6)
    expect(state.steps.developer?.visits).toBe(2)
    expect(state.steps.verify?.next).toBe('reviewer')
    expect(state.events.every(event => event.traceId === state.traceId)).toBe(true)
    expect(await readWorkflowState(directory, 'run-1')).toEqual(state)
  })

  it('emits one span per finished attempt after its receipt is durable', async () => {
    const spans: string[] = []
    const state = await runWorkflow(options([
      { id: 'read', maxAttempts: 2, run: async (_graph, context) => context.attempt === 1 ? { status: 'failed', retryable: true, error: 'flaky', usage: zero } : success() },
      { id: 'write', effect: 'write', run: async () => success() },
    ], { onSpan: async span => { spans.push(`${span.stepId}#${span.attempt}:${span.status}`); expect(span.traceId).toBeTruthy(); expect(span.endedAt >= span.startedAt).toBe(true) } }))
    expect(state.status).toBe('succeeded')
    expect(spans).toEqual(['read#1:failed', 'read#2:succeeded', 'write#1:succeeded'])
    expect(state.history.map(attempt => attempt.id)).toEqual(expect.arrayContaining(state.events.filter(event => event.spanId).map(event => event.spanId)))
  })

  it('resumes at the committed phase and revalidates completed domain evidence by time travel', async () => {
    const architect = vi.fn(async () => success({ plan: true }))
    const developer = vi.fn(async () => success({ changed: true }))
    let finish = false
    const definition = options([
      { id: 'architect', run: architect }, { id: 'developer', effect: 'write', run: developer },
      { id: 'verify', run: async () => finish ? success() : { status: 'failed', error: 'checks failed', usage: zero } },
    ])
    expect((await runWorkflow(definition)).status).toBe('failed')
    finish = true
    const resumed = await runWorkflow({ ...definition, resume: true })
    expect(resumed.status).toBe('succeeded')
    expect(architect).toHaveBeenCalledTimes(1)
    expect(developer).toHaveBeenCalledTimes(1)
    const validated = await runWorkflow({ ...definition, resume: true, validateCompleted: async stepId => stepId !== 'developer' })
    expect(validated.status).toBe('succeeded')
    expect(architect).toHaveBeenCalledTimes(1)
    expect(developer).toHaveBeenCalledTimes(2)
    expect(validated.events.some(event => event.type === 'workflow_invalidated')).toBe(true)
  })

  it('invalidates downstream state and never lets callbacks mutate checkpoint state', async () => {
    let rerun = false
    const definition = options([
      { id: 'architect', run: async (graph, context) => {
        // The forked branch starts from the state the node saw the first time.
        if (rerun) expect(graph.notes).toEqual({})
        context.checkpoint.workflowVersion = 'tampered'
        return success({ plan: 'plan' })
      } },
      { id: 'developer', run: async graph => success({ code: `code for ${String(graph.notes.plan)}` }) },
    ])
    await runWorkflow(definition)
    rerun = true
    const state = await runWorkflow({ ...definition, resume: true, invalidate: ['architect'] })
    expect(state.workflowVersion).toBe('1')
    expect(state.status).toBe('succeeded')
    expect(state.steps.architect?.visits).toBe(2)
    expect(state.steps.developer?.visits).toBe(2)
  })

  it('persists pending approval, stays quiet while pending and consumes it explicitly', async () => {
    const delivered = vi.fn(async () => success())
    const definition = options([
      { id: 'approval', run: async (_graph, context) => { context.interrupt({ kind: 'approval', reason: 'Approve archive' }); return success() } },
      { id: 'archive', effect: 'write', run: delivered },
    ])
    const paused = await runWorkflow(definition)
    expect(paused.status).toBe('paused')
    expect(paused.error).toBe('Approve archive')
    expect(paused.pendingApproval).toMatchObject({ stepId: 'approval', reason: 'Approve archive' })
    expect(delivered).not.toHaveBeenCalled()
    expect(await runWorkflow({ ...definition, resume: true })).toEqual(paused)
    const completed = await runWorkflow({ ...definition, resume: true, approve: ['approval'] })
    expect(completed.status).toBe('succeeded')
    expect(completed.pendingApproval).toBeUndefined()
    expect(completed.steps.approval?.visits).toBe(1)
    expect(delivered).toHaveBeenCalledTimes(1)
  })

  it('pauses on a question, resumes only with an answer, and hands the answer to the same node', async () => {
    const seen: string[] = []
    const definition = options([
      { id: 'architect', run: async (_graph, context) => {
        const reply = context.pending?.kind === 'question' ? context.interrupt<{ answer: string }>(context.pending) : undefined
        if (!reply) context.interrupt({ kind: 'question', question: 'Which storage?' })
        seen.push(reply!.answer)
        return success({ answer: reply!.answer })
      } },
      { id: 'developer', run: async graph => success({ built: graph.notes.answer as string }) },
    ])
    const paused = await runWorkflow(definition)
    expect(paused.status).toBe('paused')
    expect(paused.pendingQuestion).toMatchObject({ stepId: 'architect', question: 'Which storage?' })
    expect(paused.error).toBe('Which storage?')
    expect((await runWorkflow({ ...definition, resume: true })).status).toBe('paused')
    await expect(runWorkflow({ ...definition, resume: true, answer: '   ' })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW' })
    const answered = await runWorkflow({ ...definition, resume: true, answer: 'SQLite' })
    expect(answered.status).toBe('succeeded')
    expect(seen).toEqual(['SQLite'])
    expect(answered.pendingQuestion).toBeUndefined()
    expect(answered.steps.developer?.output).toEqual({ built: 'SQLite' })
  })

  it('does not replay completed effects or duplicate usage and events on repeated resumes', async () => {
    const run = vi.fn(async () => ({ ...success(), usage: { costUsd: 0.5, inputTokens: 10, outputTokens: 5 } }))
    const definition = options([{ id: 'write', effect: 'write', run }])
    const state = await runWorkflow({ ...definition, onEvent: () => { throw new Error('UI disconnected') } })
    const resumed = await runWorkflow({ ...definition, resume: true })
    expect(resumed).toEqual(state)
    expect(run).toHaveBeenCalledTimes(1)
    expect(state.usage.costUsd).toBe(0.5)
    expect(state.usage.knownTokens).toBe(15)
    expect(state.events.map(event => event.sequence)).toEqual([1, 2, 3, 4])
    expect(new Set(state.events.map(event => event.id)).size).toBe(4)
  })

  it('keeps usage a node reported before it paused', async () => {
    const definition = options([{ id: 'agent', run: async (_graph, context) => {
      context.reportUsage({ costUsd: 0.25, inputTokens: 4, outputTokens: 1 })
      expect(context.remainingBudget()).toEqual({ maxCostUsd: 0.75 })
      context.interrupt({ kind: 'approval', reason: 'Approve' })
      return success()
    } }], { budget: { maxCostUsd: 1 } })
    const paused = await runWorkflow(definition)
    expect(paused.status).toBe('paused')
    expect(paused.usage).toMatchObject({ costUsd: 0.25, knownTokens: 5 })
    expect(paused.history[0]?.usage).toEqual({ costUsd: 0.25, inputTokens: 4, outputTokens: 1 })
  })

  it('retains approval when a process stops between its receipt and workflow status event', async () => {
    const run = vi.fn(async (_graph: S, context: Parameters<Node['run']>[1]) => { context.interrupt({ kind: 'approval', reason: 'Approve' }); return success() })
    const definition = options([{ id: 'approve', run }])
    expect((await runWorkflow(definition)).status).toBe('paused')
    await patchState('run-1', state => { state.status = 'running' })
    const resumed = await runWorkflow({ ...definition, resume: true })
    expect(resumed.status).toBe('paused')
    expect(resumed.pendingApproval?.stepId).toBe('approve')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('persists an already granted approval across interrupted-write recovery', async () => {
    const controller = new AbortController()
    let recovered = false
    const definition = options([{ id: 'archive', effect: 'write', run: async (_graph, context) => {
      context.interrupt({ kind: 'approval', reason: 'Approve archive' })
      if (!recovered) { controller.abort(new Error('stopped')); context.signal.throwIfAborted() }
      return success()
    } }])
    expect((await runWorkflow(definition)).status).toBe('paused')
    const interrupted = await runWorkflow({ ...definition, resume: true, approve: ['archive'], signal: controller.signal })
    expect(interrupted.status).toBe('blocked')
    expect(interrupted.steps.archive?.status).toBe('interrupted')
    expect(interrupted.pendingApproval?.grantedAt).toBeTruthy()
    recovered = true
    const state = await runWorkflow({ ...definition, resume: true, recoverInterrupted: ['archive'] })
    expect(state.status).toBe('succeeded')
    expect(state.pendingApproval).toBeUndefined()
  })

  it('commits invalidated runs as running before any callback restarts', async () => {
    const definition = options([{ id: 'read', run: async () => success() }])
    await runWorkflow(definition)
    let invalidationStatus: string | undefined
    await runWorkflow({ ...definition, resume: true, invalidate: ['read'], onEvent: async event => {
      if (event.type === 'workflow_invalidated') invalidationStatus = (await readWorkflowState(directory, 'run-1'))?.status
    } })
    expect(invalidationStatus).toBe('running')
  })

  it('rejects concurrent ownership before the second callback can run', async () => {
    let unblock!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const run = vi.fn(async () => { entered(); await gate; return success() })
    const definition = options([{ id: 'write', effect: 'write', run }])
    const first = runWorkflow(definition)
    await started
    await expect(runWorkflow({ ...definition, resume: true })).rejects.toMatchObject({ code: 'LOCKED' })
    unblock()
    expect((await first).status).toBe('succeeded')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('recovers a real dead-process lease, preserves prior output and requires write recovery', async () => {
    crashAt('write', 'write')
    const read = vi.fn(async () => success({ read: 'kept' }))
    const write = vi.fn(async () => success({ write: 'recovered' }))
    const definition = options([{ id: 'read', run: read }, { id: 'write', effect: 'write', run: write }], { resume: true })
    const blocked = await runWorkflow(definition)
    expect(blocked.status).toBe('blocked')
    expect(blocked.error).toContain('explicit recovery')
    expect(blocked.steps.read?.output).toBe('kept')
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(await runWorkflow({ ...definition, invalidate: ['write'] })).toEqual(blocked)
    const recovered = await runWorkflow({ ...definition, recoverInterrupted: ['write'] })
    expect(recovered.status).toBe('succeeded')
    expect(read).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('resumes interrupted read steps without asking to recover a mutation', async () => {
    crashAt('read', 'read')
    const read = vi.fn(async () => success({ read: 'again' }))
    const write = vi.fn(async () => success())
    const state = await runWorkflow(options([{ id: 'read', run: read }, { id: 'write', run: write }], { resume: true }))
    expect(state.status).toBe('succeeded')
    expect(state.steps.read?.status).toBe('succeeded')
    expect(read).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(state.history.map(attempt => `${attempt.stepId}:${attempt.status}`)).toEqual(['read:interrupted', 'read:succeeded', 'write:succeeded'])
  })

  it('recovers a committed final receipt without repeating the final mutation', async () => {
    const run = vi.fn(async () => success())
    const definition = options([{ id: 'write', effect: 'write', run }])
    await runWorkflow(definition)
    await patchState('run-1', state => { state.status = 'running' })
    expect((await runWorkflow({ ...definition, resume: true })).status).toBe('succeeded')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('follows the ledger when a receipt was committed before the graph checkpoint', async () => {
    const first = vi.fn(async () => success({ first: true }))
    const second = vi.fn(async () => success({ second: true }))
    const definition = options([{ id: 'first', effect: 'write', run: first }, { id: 'second', effect: 'write', run: second }])
    await runWorkflow(definition)
    // Simulate a crash after the ledger receipt of `first` but before LangGraph
    // saved the checkpoint that moves to `second`: the ledger already names `second`.
    await patchState('run-1', state => {
      state.status = 'running'
      state.nextStep = 'second'
      state.steps.second = { id: 'second', status: 'pending', effect: 'write', visits: 0, attempt: 0 }
      state.history = state.history.filter(attempt => attempt.stepId !== 'second')
    })
    const resumed = await runWorkflow({ ...definition, resume: true })
    expect(resumed.status).toBe('succeeded')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    expect(resumed.steps.second?.visits).toBe(1)
  })

  it.each(['input', 'version', 'shape'] as const)('rejects a changed %s before resume', async change => {
    const definition = options([{ id: 'read', run: async () => success() }])
    await runWorkflow(definition)
    const changed = { ...definition, resume: true }
    if (change === 'input') changed.input = { different: true }
    if (change === 'version') changed.workflow = { ...definition.workflow, version: '2' }
    if (change === 'shape') changed.workflow = { ...definition.workflow, nodes: { read: { ...definition.workflow.nodes.read!, effect: 'write' } } }
    await expect(runWorkflow(changed)).rejects.toMatchObject({ code: 'INCOMPATIBLE_RESUME' })
  })

  it('uses canonical JSON fingerprints for equivalent input key order', async () => {
    const definition = options([{ id: 'read', run: async () => success() }], { input: { b: 2, a: 1 } })
    await runWorkflow(definition)
    expect((await runWorkflow({ ...definition, input: { a: 1, b: 2 }, resume: true })).status).toBe('succeeded')
  })

  it('requires explicit resume and reports absent runs', async () => {
    const definition = options([{ id: 'read', run: async () => success() }])
    expect(await readWorkflowState(directory, 'run-1')).toBeNull()
    await expect(runWorkflow({ ...definition, resume: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await runWorkflow(definition)
    await expect(runWorkflow(definition)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })
})

describe('execution bounds', () => {
  it('bounds read retries independently from graph visits', async () => {
    let attempts = 0
    const definition = options([{ id: 'read', maxAttempts: 3, run: async () => ++attempts < 3 ? { status: 'failed', retryable: true, usage: zero } : success() }])
    definition.workflow.maxTransitions = 1
    const state = await runWorkflow(definition)
    expect(state.status).toBe('succeeded')
    expect(state.transitions).toBe(1)
    expect(state.executionCount).toBe(3)
    expect(state.history.map(record => record.attempt)).toEqual([1, 2, 3])
  })

  it('does not retry a write without an explicit retry-safe contract', async () => {
    const run = vi.fn(async (): Promise<Result> => ({ status: 'failed', retryable: true, usage: zero }))
    const state = await runWorkflow(options([{ id: 'write', effect: 'write', maxAttempts: 3, run }]))
    expect(state.status).toBe('failed')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('stops opted-in write retries at maxAttempts', async () => {
    const run = vi.fn(async (): Promise<Result> => ({ status: 'failed', retryable: true, usage: zero }))
    const state = await runWorkflow(options([{ id: 'write', effect: 'write', retrySafe: true, maxAttempts: 2, run }]))
    expect(state.status).toBe('failed')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('bounds conditional correction cycles', async () => {
    const run = vi.fn(async (): Promise<Result> => ({ ...success(), next: 'loop' }))
    const definition = options([{ id: 'loop', ends: ['loop'], run }])
    definition.workflow.maxTransitions = 3
    const state = await runWorkflow(definition)
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('transition limit')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it.each([{ maxCostUsd: 1 }, { maxTokens: 5 }])('stops at an observed budget and can resume with a higher budget: %j', async budget => {
    const later = vi.fn(async () => success())
    const definition = options([
      { id: 'first', run: async () => ({ ...success(), usage: { costUsd: 1, inputTokens: 3, outputTokens: 2 } }) },
      { id: 'later', run: later },
    ], { budget })
    const state = await runWorkflow(definition)
    expect(state.status).toBe('blocked')
    expect(state.nextStep).toBe('later')
    expect(later).not.toHaveBeenCalled()
    const resumed = await runWorkflow({ ...definition, resume: true, budget: { maxCostUsd: 2, maxTokens: 10 } })
    expect(resumed.status).toBe('succeeded')
    expect(resumed.usage.costUsd).toBe(1)
  })

  it('records final-step overspend and does not certify success until the budget is revised', async () => {
    const run = vi.fn(async () => ({ ...success(), usage: { costUsd: 2, inputTokens: 1, outputTokens: 1 } }))
    const definition = options([{ id: 'write', effect: 'write', run }], { budget: { maxCostUsd: 1 } })
    expect((await runWorkflow(definition)).status).toBe('blocked')
    expect((await runWorkflow({ ...definition, resume: true })).status).toBe('blocked')
    expect((await runWorkflow({ ...definition, resume: true, budget: { maxCostUsd: 3 } })).status).toBe('succeeded')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('allows an exactly exhausted final budget without inventing unknown provider usage', async () => {
    const state = await runWorkflow(options([{ id: 'agent', run: async () => ({ status: 'succeeded', usage: { costUsd: 1, inputTokens: null } }) }], { budget: { maxCostUsd: 1 } }))
    expect(state.status).toBe('succeeded')
    expect(state.usage).toMatchObject({ costUsd: 1, inputTokens: null, outputTokens: null, knownCostUsd: 1, knownTokens: 0 })
    const unknown = await runWorkflow(options([{ id: 'agent', run: async () => ({ status: 'succeeded' }) }], { runId: 'unknown' }))
    expect(unknown.usage.costUsd).toBeNull()
    expect(unknown.history[0]?.usage).toBeUndefined()
  })

  it('propagates a duration deadline and waits for the owned callback to stop', async () => {
    let stopped = false
    const state = await runWorkflow(options([{ id: 'read', run: async (_graph, context) => {
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      stopped = true
      throw new Error('deadline')
    } }], { budget: { maxDurationMs: 100 } }))
    expect(stopped).toBe(true)
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('duration')
  })

  it('honors cancellation before executing any phase', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = vi.fn(async () => success())
    const state = await runWorkflow(options([{ id: 'read', run }], { signal: controller.signal }))
    expect(state.status).toBe('cancelled')
    expect(run).not.toHaveBeenCalled()
  })

  it('requires explicit recovery after cancellation interrupts a write', async () => {
    const controller = new AbortController()
    let complete = false
    const run = vi.fn(async (_graph: S, context: Parameters<Node['run']>[1]) => {
      if (complete) return success()
      controller.abort(new Error('cancel requested'))
      context.signal.throwIfAborted()
      return success()
    })
    const definition = options([{ id: 'write', effect: 'write', run }])
    const state = await runWorkflow({ ...definition, signal: controller.signal })
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('Interrupted write step write')
    expect(state.steps.write?.status).toBe('interrupted')
    expect((await runWorkflow({ ...definition, resume: true })).status).toBe('blocked')
    complete = true
    expect((await runWorkflow({ ...definition, resume: true, recoverInterrupted: ['write'] })).status).toBe('succeeded')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('rejects non-JSON output, invalid usage and invalid branch destinations', async () => {
    for (const [index, result] of ([
      { ...success(), output: Number.NaN },
      { ...success(), update: { notes: { when: new Date() } } },
      { ...success(), usage: { costUsd: -1 } },
      { ...success(), next: 'missing' },
    ] as Result[]).entries()) {
      const state = await runWorkflow(options([{ id: 'read', run: async () => result }], { runId: `invalid-${index}` }))
      expect(state.status).toBe('failed')
      expect(state.steps.read?.error).toBeTruthy()
    }
  })

  it('rejects invalid definitions and options before execution', async () => {
    const run = vi.fn(async () => success())
    const definition = options([{ id: 'read', run }])
    await expect(runWorkflow({ ...definition, runId: '../escape' })).rejects.toMatchObject({ code: 'INVALID_ID' })
    await expect(runWorkflow({ ...definition, budget: { maxTokens: -1 } })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW' })
    await expect(runWorkflow({ ...definition, invalidate: ['absent'] })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW' })
    await expect(runWorkflow({ ...definition, workflow: { ...definition.workflow, nodes: { read: { run, ends: ['missing'] } } } })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW' })
    await expect(runWorkflow({ ...definition, workflow: { ...definition.workflow, entry: 'absent' } })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW' })
    await expect(runWorkflow({ ...definition, workflow: { ...definition.workflow, entry: 'notes', nodes: { notes: { run, ends: [] } } } })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW', message: expect.stringContaining('state channel') })
    await expect(runWorkflow({ ...definition, input: { n: Number.NaN } })).rejects.toThrow('JSON')
    expect(run).not.toHaveBeenCalled()
  })

  it('detects a corrupted checkpoint rather than restarting completed effects', async () => {
    await runWorkflow(options([{ id: 'read', run: async () => success() }]))
    const path = join(directory, 'run-1', 'checkpoint.json')
    const checkpoint = JSON.parse(await readFile(path, 'utf8')) as { format: number; state: { workflowVersion: string }; graph: { checkpoints: unknown[] } }
    expect(checkpoint.format).toBe(2)
    expect(checkpoint.graph.checkpoints.length).toBeGreaterThan(0)
    checkpoint.state.workflowVersion = 'tampered'
    await writeFile(path, JSON.stringify(checkpoint))
    await expect(readWorkflowState(directory, 'run-1')).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
  })
})
