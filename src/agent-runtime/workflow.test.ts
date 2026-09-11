import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWorkflow, readWorkflowState, type RunWorkflowOptions, type StepResult, type WorkflowDefinition } from './workflow.js'
import { writeWorkflowState } from './durable-store.js'

const zero = { costUsd: 0, inputTokens: 0, outputTokens: 0 }
const success = (output?: StepResult['output']): StepResult => ({ status: 'succeeded', usage: zero, ...(output === undefined ? {} : { output }) })
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'specrails workflow with spaces ')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

function options(steps: WorkflowDefinition['steps'], overrides: Partial<RunWorkflowOptions> = {}): RunWorkflowOptions {
  return { directory, runId: 'run-1', input: { change: 'example' }, workflow: { id: 'implement', version: '1', steps }, ...overrides }
}

describe('durable LangGraph workflow', () => {
  it('executes explicit phases and a conditional correction loop with current outputs', async () => {
    const trace: string[] = []
    let valid = false
    const state = await runWorkflow(options([
      { id: 'architect', execute: async () => { trace.push('architect'); return success({ plan: true }) } },
      { id: 'developer', effect: 'write', execute: async context => {
        trace.push('developer')
        expect(context.previousOutputs.architect).toEqual({ plan: true })
        expect(context.attemptId).toMatch(/^run-1:attempt:/)
        return success({ revision: context.checkpoint.steps.developer!.visits })
      } },
      { id: 'verify', execute: async context => {
        trace.push('verify')
        expect(context.previousOutputs.developer).toEqual({ revision: valid ? 2 : 1 })
        const result: StepResult = { ...success({ valid }), next: valid ? 'reviewer' : 'developer' }
        valid = true
        return result
      } },
      { id: 'reviewer', execute: async () => { trace.push('reviewer'); return success() } },
    ]))
    expect(trace).toEqual(['architect', 'developer', 'verify', 'developer', 'verify', 'reviewer'])
    expect(state.status).toBe('succeeded')
    expect(state.transitions).toBe(6)
    expect(state.steps.developer?.visits).toBe(2)
    expect(await readWorkflowState(directory, 'run-1')).toEqual(state)
  })

  it('resumes at the committed phase and revalidates completed domain evidence', async () => {
    const architect = vi.fn(async () => success({ plan: true }))
    const developer = vi.fn(async () => success({ changed: true }))
    let finish = false
    const definition = options([
      { id: 'architect', execute: architect }, { id: 'developer', effect: 'write', execute: developer },
      { id: 'verify', execute: async () => finish ? success() : { status: 'failed', error: 'checks failed', usage: zero } },
    ])
    expect((await runWorkflow(definition)).status).toBe('failed')
    finish = true
    const resumed = await runWorkflow({ ...definition, resume: true })
    expect(resumed.status).toBe('succeeded')
    expect(architect).toHaveBeenCalledTimes(1)
    expect(developer).toHaveBeenCalledTimes(1)
    const validated = await runWorkflow({ ...definition, resume: true, validateCompleted: async step => step.id !== 'developer' })
    expect(validated.status).toBe('succeeded')
    expect(architect).toHaveBeenCalledTimes(1)
    expect(developer).toHaveBeenCalledTimes(2)
    expect(validated.events.some(event => event.type === 'workflow_invalidated')).toBe(true)
  })

  it('invalidates downstream outputs and never lets callbacks mutate checkpoint state', async () => {
    let rerun = false
    const definition = options([
      { id: 'architect', execute: async context => {
        if (rerun) expect(context.previousOutputs).toEqual({})
        context.checkpoint.workflowVersion = 'tampered'
        return success('plan')
      } },
      { id: 'developer', execute: async () => success('code') },
    ])
    await runWorkflow(definition)
    rerun = true
    const state = await runWorkflow({ ...definition, resume: true, invalidate: ['architect'] })
    expect(state.workflowVersion).toBe('1')
    expect(state.steps.architect?.visits).toBe(2)
  })

  it('persists pending approval, stays quiet while pending and consumes it explicitly', async () => {
    const delivered = vi.fn(async () => success())
    const definition = options([
      { id: 'approval', execute: async context => context.approved ? success() : { status: 'paused', error: 'Approve archive', usage: zero } },
      { id: 'archive', effect: 'write', execute: delivered },
    ])
    const paused = await runWorkflow(definition)
    expect(paused.status).toBe('paused')
    expect(paused.pendingApproval?.stepId).toBe('approval')
    expect(delivered).not.toHaveBeenCalled()
    expect(await runWorkflow({ ...definition, resume: true })).toEqual(paused)
    const completed = await runWorkflow({ ...definition, resume: true, approve: ['approval'] })
    expect(completed.status).toBe('succeeded')
    expect(completed.pendingApproval).toBeUndefined()
    expect(delivered).toHaveBeenCalledTimes(1)
  })

  it('does not replay completed effects or duplicate usage and events on repeated resumes', async () => {
    const execute = vi.fn(async () => ({ ...success(), usage: { costUsd: 0.5, inputTokens: 10, outputTokens: 5 } }))
    const definition = options([{ id: 'write', effect: 'write', execute }])
    const state = await runWorkflow({ ...definition, onEvent: () => { throw new Error('UI disconnected') } })
    const resumed = await runWorkflow({ ...definition, resume: true })
    expect(resumed).toEqual(state)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(state.usage.costUsd).toBe(0.5)
    expect(state.usage.knownTokens).toBe(15)
    expect(state.events.map(event => event.sequence)).toEqual([1, 2, 3, 4])
    expect(new Set(state.events.map(event => event.id)).size).toBe(4)
  })

  it('retains approval when a process stops between its receipt and workflow status event', async () => {
    const execute = vi.fn(async (): Promise<StepResult> => ({ status: 'paused', usage: zero }))
    const definition = options([{ id: 'approve', execute }])
    const saved = await runWorkflow(definition)
    saved.status = 'running'
    await writeWorkflowState(directory, saved)
    const resumed = await runWorkflow({ ...definition, resume: true })
    expect(resumed.status).toBe('paused')
    expect(resumed.pendingApproval?.stepId).toBe('approve')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('persists an already granted approval across interrupted-write recovery', async () => {
    const controller = new AbortController()
    let recovered = false
    const definition = options([{ id: 'archive', effect: 'write', execute: async context => {
      if (!context.approved) return { status: 'paused', usage: zero }
      if (!recovered) { controller.abort(new Error('stopped')); context.signal.throwIfAborted() }
      return success()
    } }])
    expect((await runWorkflow(definition)).status).toBe('paused')
    const interrupted = await runWorkflow({ ...definition, resume: true, approve: ['archive'], signal: controller.signal })
    expect(interrupted.status).toBe('blocked')
    expect(interrupted.pendingApproval?.grantedAt).toBeTruthy()
    recovered = true
    const state = await runWorkflow({ ...definition, resume: true, recoverInterrupted: ['archive'] })
    expect(state.status).toBe('succeeded')
    expect(state.pendingApproval).toBeUndefined()
  })

  it('commits invalidated runs as running before any callback restarts', async () => {
    const definition = options([{ id: 'read', execute: async () => success() }])
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
    const execute = vi.fn(async () => { entered(); await gate; return success() })
    const definition = options([{ id: 'write', effect: 'write', execute }])
    const first = runWorkflow(definition)
    await started
    await expect(runWorkflow({ ...definition, resume: true })).rejects.toMatchObject({ code: 'LOCKED' })
    unblock()
    expect((await first).status).toBe('succeeded')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('recovers a real dead-process lease, preserves prior output and requires write recovery', async () => {
    const moduleUrl = new URL('../../dist/agent-runtime/workflow.js', import.meta.url).href
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runWorkflow } from ${JSON.stringify(moduleUrl)};
      await runWorkflow({ directory: ${JSON.stringify(directory)}, runId: 'run-1', input: {change:'example'},
        workflow: {id:'implement',version:'1',steps:[
          {id:'read',execute:async()=>({status:'succeeded',output:'kept',usage:{costUsd:0,inputTokens:0,outputTokens:0}})},
          {id:'write',effect:'write',execute:async()=>({status:'succeeded'})}
        ]},onEvent:event=>{if(event.type==='step_started'&&event.stepId==='write')process.exit(71)}});
    `], { encoding: 'utf8' })
    expect(child.status, child.stderr).toBe(71)
    const read = vi.fn(async () => success('kept'))
    const write = vi.fn(async () => success('recovered'))
    const definition = options([{ id: 'read', execute: read }, { id: 'write', effect: 'write', execute: write }], { resume: true })
    const blocked = await runWorkflow(definition)
    expect(blocked.status).toBe('blocked')
    expect(blocked.error).toContain('explicit recovery')
    expect(blocked.steps.read?.output).toBe('kept')
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(await runWorkflow({ ...definition, invalidate: ['write'] })).toEqual(blocked)
    expect((await runWorkflow({ ...definition, recoverInterrupted: ['write'] })).status).toBe('succeeded')
    expect(read).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('resumes interrupted read steps without asking to recover a mutation', async () => {
    const execute = vi.fn(async () => success())
    const definition = options([{ id: 'read', execute }])
    const saved = await runWorkflow(definition)
    saved.status = 'running'
    saved.nextStep = 'read'
    saved.steps.read!.status = 'running'
    saved.history[0]!.status = 'running'
    await writeWorkflowState(directory, saved)
    expect((await runWorkflow({ ...definition, resume: true })).status).toBe('succeeded')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('recovers a committed final receipt without repeating the final mutation', async () => {
    const execute = vi.fn(async () => success())
    const definition = options([{ id: 'write', effect: 'write', execute }])
    const saved = await runWorkflow(definition)
    saved.status = 'running'
    await writeWorkflowState(directory, saved)
    expect((await runWorkflow({ ...definition, resume: true })).status).toBe('succeeded')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it.each(['input', 'version', 'shape'] as const)('rejects a changed %s before resume', async change => {
    const definition = options([{ id: 'read', execute: async () => success() }])
    await runWorkflow(definition)
    const changed = { ...definition, resume: true }
    if (change === 'input') changed.input = { different: true }
    if (change === 'version') changed.workflow = { ...definition.workflow, version: '2' }
    if (change === 'shape') changed.workflow = { ...definition.workflow, steps: [{ ...definition.workflow.steps[0]!, effect: 'write' }] }
    await expect(runWorkflow(changed)).rejects.toMatchObject({ code: 'INCOMPATIBLE_RESUME' })
  })

  it('uses canonical JSON fingerprints for equivalent input key order', async () => {
    const definition = options([{ id: 'read', execute: async () => success() }], { input: { b: 2, a: 1 } })
    await runWorkflow(definition)
    expect((await runWorkflow({ ...definition, input: { a: 1, b: 2 }, resume: true })).status).toBe('succeeded')
  })

  it('requires explicit resume and reports absent runs', async () => {
    const definition = options([{ id: 'read', execute: async () => success() }])
    expect(await readWorkflowState(directory, 'run-1')).toBeNull()
    await expect(runWorkflow({ ...definition, resume: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await runWorkflow(definition)
    await expect(runWorkflow(definition)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })
})

describe('execution bounds', () => {
  it('bounds read retries independently from graph visits', async () => {
    let attempts = 0
    const definition = options([{ id: 'read', maxAttempts: 3, execute: async () => ++attempts < 3 ? { status: 'failed', retryable: true, usage: zero } : success() }])
    definition.workflow.maxTransitions = 1
    const state = await runWorkflow(definition)
    expect(state.status).toBe('succeeded')
    expect(state.transitions).toBe(1)
    expect(state.executionCount).toBe(3)
    expect(state.history.map(record => record.attempt)).toEqual([1, 2, 3])
  })

  it('does not retry a write without an explicit retry-safe contract', async () => {
    const execute = vi.fn(async (): Promise<StepResult> => ({ status: 'failed', retryable: true, usage: zero }))
    const state = await runWorkflow(options([{ id: 'write', effect: 'write', maxAttempts: 3, execute }]))
    expect(state.status).toBe('failed')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('stops opted-in write retries at maxAttempts', async () => {
    const execute = vi.fn(async (): Promise<StepResult> => ({ status: 'failed', retryable: true, usage: zero }))
    const state = await runWorkflow(options([{ id: 'write', effect: 'write', retrySafe: true, maxAttempts: 2, execute }]))
    expect(state.status).toBe('failed')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('bounds conditional correction cycles', async () => {
    const execute = vi.fn(async (): Promise<StepResult> => ({ ...success(), next: 'loop' }))
    const definition = options([{ id: 'loop', execute }])
    definition.workflow.maxTransitions = 3
    const state = await runWorkflow(definition)
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('transition limit')
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it.each([{ maxCostUsd: 1 }, { maxTokens: 5 }])('stops at an observed budget and can resume with a higher budget: %j', async budget => {
    const later = vi.fn(async () => success())
    const definition = options([
      { id: 'first', execute: async () => ({ ...success(), usage: { costUsd: 1, inputTokens: 3, outputTokens: 2 } }) },
      { id: 'later', execute: later },
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
    const execute = vi.fn(async () => ({ ...success(), usage: { costUsd: 2, inputTokens: 1, outputTokens: 1 } }))
    const definition = options([{ id: 'write', effect: 'write', execute }], { budget: { maxCostUsd: 1 } })
    expect((await runWorkflow(definition)).status).toBe('blocked')
    expect((await runWorkflow({ ...definition, resume: true })).status).toBe('blocked')
    expect((await runWorkflow({ ...definition, resume: true, budget: { maxCostUsd: 3 } })).status).toBe('succeeded')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('allows an exactly exhausted final budget without inventing unknown provider usage', async () => {
    const state = await runWorkflow(options([{ id: 'agent', execute: async () => ({ status: 'succeeded', usage: { costUsd: 1, inputTokens: null } }) }], { budget: { maxCostUsd: 1 } }))
    expect(state.status).toBe('succeeded')
    expect(state.usage).toMatchObject({ costUsd: 1, inputTokens: null, outputTokens: null, knownCostUsd: 1, knownTokens: 0 })
    const unknown = await runWorkflow(options([{ id: 'agent', execute: async () => ({ status: 'succeeded' }) }], { runId: 'unknown' }))
    expect(unknown.usage.costUsd).toBeNull()
  })

  it('propagates a duration deadline and waits for the owned callback to stop', async () => {
    let stopped = false
    const state = await runWorkflow(options([{ id: 'read', execute: async context => {
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
    const execute = vi.fn(async () => success())
    const state = await runWorkflow(options([{ id: 'read', execute }], { signal: controller.signal }))
    expect(state.status).toBe('cancelled')
    expect(execute).not.toHaveBeenCalled()
  })

  it('requires explicit recovery after cancellation interrupts a write', async () => {
    const controller = new AbortController()
    let complete = false
    const execute = vi.fn(async context => {
      if (complete) return success()
      controller.abort(new Error('cancel requested'))
      context.signal.throwIfAborted()
      return success()
    })
    const definition = options([{ id: 'write', effect: 'write', execute }])
    const state = await runWorkflow({ ...definition, signal: controller.signal })
    expect(state.status).toBe('blocked')
    expect(state.steps.write?.status).toBe('interrupted')
    expect((await runWorkflow({ ...definition, resume: true })).status).toBe('blocked')
    complete = true
    expect((await runWorkflow({ ...definition, resume: true, recoverInterrupted: ['write'] })).status).toBe('succeeded')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('rejects non-JSON output, invalid usage and invalid branch destinations', async () => {
    for (const [index, result] of [
      { ...success(), output: Number.NaN },
      { ...success(), usage: { costUsd: -1 } },
      { ...success(), next: 'missing' },
    ].entries()) {
      const state = await runWorkflow(options([{ id: 'read', execute: async () => result }], { runId: `invalid-${index}` }))
      expect(state.status).toBe('failed')
      expect(state.steps.read?.error).toBeTruthy()
    }
  })

  it('rejects invalid definitions and options before execution', async () => {
    const execute = vi.fn(async () => success())
    const definition = options([{ id: 'read', execute }])
    await expect(runWorkflow({ ...definition, runId: '../escape' })).rejects.toMatchObject({ code: 'INVALID_ID' })
    await expect(runWorkflow({ ...definition, budget: { maxTokens: -1 } })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW' })
    await expect(runWorkflow({ ...definition, invalidate: ['absent'] })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW' })
    await expect(runWorkflow({ ...definition, workflow: { ...definition.workflow, steps: [...definition.workflow.steps, ...definition.workflow.steps] } })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW' })
    await expect(runWorkflow({ ...definition, input: { n: Number.NaN } })).rejects.toThrow('JSON')
    expect(execute).not.toHaveBeenCalled()
  })

  it('detects a corrupted checkpoint rather than restarting completed effects', async () => {
    await runWorkflow(options([{ id: 'read', execute: async () => success() }]))
    const path = join(directory, 'run-1', 'checkpoint.json')
    const checkpoint = JSON.parse(await readFile(path, 'utf8')) as { state: { workflowVersion: string } }
    checkpoint.state.workflowVersion = 'tampered'
    await writeFile(path, JSON.stringify(checkpoint))
    await expect(readWorkflowState(directory, 'run-1')).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
  })
})
