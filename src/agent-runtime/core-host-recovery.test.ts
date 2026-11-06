import { Annotation } from '@langchain/langgraph'
import { createRoleInvoker } from './graph/roles.js'
import { resolveRoleDescriptor, roleIds } from './config.js'
import { roleInstructions } from './prompts.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCoreWorkflow, parseAgentObject } from './core-host.js'
import { createExecutorRegistry, ExecutorRegistry } from './executors.js'
import { type AgentRequest } from './executor-types.js'
import { inspectPipeline, pipelineStateDirectory, type PipelineState } from '../pipeline/pipeline-state.js'
import { runRuntimeCommand } from './cli.js'
import { DEVELOPER_OUTPUT_SCHEMA } from './prompts.js'
import { runtimeEfficiency } from './efficiency.js'
import { runWorkflow } from './workflow.js'
import { architecture, archivedChangeFile, change, config, context, develop, fake, interruptAfterArchiveRename, journalFile, opts, patchLedger, result, review, root, write } from './__tests__/core-host-fixture.js'

describe('programmatic Core host with real evidence gates', () => {
  describe('reviewer risk brief', () => {
    const risk = (severity: string, n: number) => ({ severity, area: 'data', whatToLookAt: `risk ${n}`, ref: `code.cjs:${n}` })
    const brief = {
      behaviourChanges: [{ what: 'Returns 2', where: 'code.cjs:1', userVisible: true }],
      invariantsTouched: [{ invariant: 'Module exports a number', evidence: 'code.cjs:1', status: 'kept' }],
      untested: [{ path: 'code.cjs', why: 'Only the exit code is checked' }],
      risks: [risk('low', 1), risk('high', 2)],
      humanChecks: ['Run the CLI by hand'], divergences: [],
    }
    const archived = (file: string) => archivedChangeFile(file)
    const briefFile = () => JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'review-brief.json'), 'utf8'))
    function reviewing(replies: unknown[]) {
      let reviews = 0
      return fake(async request => {
        if (request.role === 'architect') return result(architecture)
        if (request.role === 'developer') { develop(); return result('Done') }
        return result(replies[Math.min(reviews++, replies.length - 1)])
      })
    }

    it('records a full brief, severity-ordered, in the state, the run record and the confidence score', async () => {
      const { registry, calls } = reviewing([{ ...review, brief }])
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(calls.find(call => call.role === 'reviewer')!.prompt).toContain('## Risk brief (after the verdict)')
      const expected = { ...brief, risks: [risk('high', 2), risk('low', 1)] }
      expect((state.steps.reviewer!.output as { brief: unknown }).brief).toEqual(expected)
      expect(briefFile()).toMatchObject({ schemaVersion: 1, change, approved: true, score: 90, brief: expected })
      expect(briefFile()).not.toHaveProperty('diagnostic')
      expect(JSON.parse(readFileSync(archived('confidence-score.json'), 'utf8'))).toMatchObject({ overall: 90, brief: expected })
    })

    it('accepts an older reviewer reply without a brief', async () => {
      const { registry, calls } = reviewing([review])
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(calls.filter(call => call.role === 'reviewer')).toHaveLength(1)
      expect(state.steps.reviewer!.output).not.toHaveProperty('brief')
      expect(briefFile()).toMatchObject({ approved: true, brief: null })
      expect(JSON.parse(readFileSync(archived('confidence-score.json'), 'utf8'))).not.toHaveProperty('brief')
    })

    it('repairs a malformed brief through the single structured-output repair turn', async () => {
      const { registry, calls } = reviewing([{ ...review, brief: { risks: [{ severity: 'catastrophic', area: 'data', whatToLookAt: 'x', ref: 'code.cjs:1' }] } }, { ...review, brief }])
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      const reviewer = calls.filter(call => call.role === 'reviewer')
      expect(reviewer).toHaveLength(2)
      expect(reviewer[1]!.prompt).toContain('Invalid review brief: risks[0].severity')
      expect(briefFile().brief.risks[0]).toEqual(risk('high', 2))
    })

    it('drops a brief that is still malformed after the repair turn and keeps the verdict', async () => {
      const malformed = { ...review, brief: { humanChecks: 'not a list' } }
      const { registry, calls } = reviewing([malformed, malformed])
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(calls.filter(call => call.role === 'reviewer')).toHaveLength(2)
      const output = state.steps.reviewer!.output as Record<string, unknown>
      expect(output).not.toHaveProperty('brief')
      expect(output.briefDiagnostic).toBe('Review brief dropped after the repair turn: Invalid review brief: humanChecks must be an array')
      expect(briefFile()).toMatchObject({ brief: null, diagnostic: output.briefDiagnostic })
    })

    it('never changes the gate: high risks do not block an approval, and overflow risks become findings', async () => {
      const risks = [risk('low', 1), risk('high', 2), risk('medium', 3), risk('high', 4), risk('low', 5), risk('medium', 6), risk('high', 7)]
      const { registry } = reviewing([{ ...review, brief: { risks } }])
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(briefFile().brief.risks.map((item: { ref: string }) => item.ref)).toEqual(['code.cjs:2', 'code.cjs:4', 'code.cjs:7', 'code.cjs:3', 'code.cjs:6'])
      // The advisory spec-trace finding (requirement traceability) is asserted by its own tests.
      expect(journalFile().acceptance!.findings.filter((finding: string) => !finding.startsWith('Spec trace (advisory'))).toEqual([
        "Additional low data risk (beyond the brief's top 5): risk 1 (code.cjs:1)",
        "Additional low data risk (beyond the brief's top 5): risk 5 (code.cjs:5)",
      ])
    })

    it('records the brief of a rejected verdict for the host', async () => {
      config.limits = { maxAttempts: 1 }
      const { registry } = reviewing([{ ...review, approved: false, issues: ['code.cjs: must change'], brief: { risks: [risk('medium', 1)] } }])
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status).not.toBe('succeeded')
      expect(briefFile()).toMatchObject({ approved: false, brief: { risks: [risk('medium', 1)] } })
    })
  })

  it('records the developer\'s structured summary and shows it to the reviewer', async () => {
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') { develop(); return result({ summary: 'Both modules now return 2', files: ['code.cjs'], tests: [], verification: 'ran the configured checks', incomplete: [] }) }
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls[1]!.outputSchema).toBe(DEVELOPER_OUTPUT_SCHEMA)
    expect(state.steps.developer?.output).toMatchObject({ structured: true, summary: 'Both modules now return 2', files: ['code.cjs'] })
    expect(calls[2]!.prompt).toContain('## Developer summary')
    expect(calls[2]!.prompt).toContain('code.cjs')
    expect(calls[2]!.prompt).toContain('ran the configured checks')
  })

  it('emits trace-correlated spans for every finished role attempt', async () => {
    const spans: string[] = []
    const { registry } = fake()
    const state = await runCoreWorkflow(opts(registry, { onSpan: span => { spans.push(`${span.stepId}:${span.status}`); expect(span.traceId).toBe(state.traceId) } }))
    expect(state.status, state.error).toBe('succeeded')
    expect(spans).toEqual(['architect:succeeded', 'developer:succeeded', 'verify:succeeded', 'reviewer:succeeded', 'archive:succeeded'])
    expect(state.events.every(event => event.traceId === state.traceId)).toBe(true)
  })

  it('rejects artifact paths outside the admitted change', async () => {
    const { registry } = fake(async () => result({ ...architecture, specs: [{ name: '../escape', content: 'malicious' }] }))
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Not a spec-driven artifact')
    expect(existsSync(path.join(root, 'escape'))).toBe(false)
  })

  it('freezes runtime configuration and never snapshots inherited secrets', async () => {
    config.approvalBeforeArchive = true
    vi.stubEnv('SPECRAILS_FIXTURE_API_KEY', 'private-fixture-value')
    const { registry } = fake()
    await runCoreWorkflow(opts(registry))
    const checkpoint = readFileSync(path.join(pipelineStateDirectory(context), 'agent-workflow', context.runId, 'checkpoint.json'), 'utf8')
    expect(checkpoint).not.toContain('private-fixture-value')
    await expect(runCoreWorkflow(opts(registry, { resume: true, config: { ...config, limits: { maxAttempts: 3 } } }))).rejects.toMatchObject({ code: 'INCOMPATIBLE_RESUME' })
  })

  it('requires explicit recovery when a provider reports an interrupted write as failed', async () => {
    const controller = new AbortController()
    const { registry } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      controller.abort(new Error('cancelled'))
      throw new Error('Executor cancelled after partial edits')
    })
    const state = await runCoreWorkflow(opts(registry, { signal: controller.signal }))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('Interrupted write step developer')
    expect(state.steps.developer?.status).toBe('interrupted')
  })

  it('cancels a live verification subprocess before review or archive', async () => {
    const controller = new AbortController()
    config.verification = context.repositories.map(repository => ({ repositoryId: repository.id, command: process.execPath, args: ['-e', 'process.stdout.write("waiting-for-cancellation");setInterval(()=>{},1000)'], timeoutMs: 10_000 }))
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry, { signal: controller.signal, onVerificationOutput: text => {
      if (text.includes('waiting-for-cancellation')) controller.abort(new Error('stop verification'))
    } }))
    expect(['cancelled', 'blocked']).toContain(state.status)
    expect(calls.map(call => call.role)).toEqual(['architect', 'developer'])
    expect(inspectPipeline(context).verification.valid).toBe(false)
  })

  it('rejects changed evidence for an already archived run', async () => {
    const { registry } = fake()
    await runCoreWorkflow(opts(registry))
    write(path.join(context.artifactRoot, 'code.cjs'), 'module.exports = 3\n')
    await expect(runCoreWorkflow(opts(registry, { resume: true }))).rejects.toThrow('Archived run evidence changed')
  })

  it('validates scope and full repository verification before invoking providers', async () => {
    const { registry, calls } = fake()
    await expect(runCoreWorkflow(opts(registry, { context: { ...context, ownership: { ...context.ownership, git: 'core' } } }))).rejects.toThrow('host-owned delivery')
    await expect(runCoreWorkflow(opts(registry, { change: '../escape' }))).rejects.toThrow('change name')
    await expect(runCoreWorkflow(opts(registry, { config: { ...config, verification: [...config.verification, { repositoryId: 'outside', command: process.execPath, args: [] }] } }))).rejects.toThrow('Invalid verification command')
    await expect(runCoreWorkflow(opts(registry, { config: { ...config, verification: config.verification.map(command => ({ ...command, cwd: root })) } }))).rejects.toThrow('cwd escapes')
    await expect(runCoreWorkflow(opts(registry, { config: { ...config, verification: config.verification.map(command => ({ ...command, timeoutMs: 2 * 60 * 60_000 + 1 })) } }))).rejects.toThrow('verification timeout')
    expect(calls).toHaveLength(0)
    expect(existsSync(path.join(pipelineStateDirectory(context), 'state.json'))).toBe(false)
  })

  it.each([
    [{ id: 'limited', kind: 'cli', cli: 'codex' }, { maxCostUsd: 1 }, 'strict USD cap'],
    [{ id: 'limited', kind: 'cli', cli: 'gemini' }, { maxCostUsd: 1 }, 'strict USD cap'],
    [{ id: 'limited', kind: 'cli', cli: 'kimi' }, { maxCostUsd: 1 }, 'strict USD cap'],
    [{ id: 'limited', kind: 'cli', cli: 'kimi' }, { maxTokens: 100 }, 'authoritative token usage'],
    [{ id: 'limited', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }, { maxCostUsd: 1 }, 'strict USD cap'],
  ] as const)('preflights later built-in role capabilities before any earlier agent work: %j %j', async (provider, limits, message) => {
    const fixture = fake()
    config.providers = [provider]
    config.agents.developer = { provider: 'limited', model: 'fixture-model' }
    config.limits = { ...limits }
    const runProcess = vi.fn(async () => { throw new Error('No provider process should run') })
    const fetch = vi.fn(async () => { throw new Error('No provider request should run') })
    const registry = createExecutorRegistry(config, { executors: { fixture: fixture.registry.get('fixture') }, cli: { runProcess }, openai: { fetch } })
    await expect(runCoreWorkflow(opts(registry))).rejects.toThrow(message)
    expect(fixture.calls).toHaveLength(0)
    expect(runProcess).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(existsSync(path.join(pipelineStateDirectory(context), 'state.json'))).toBe(false)
  })

  it('respects custom executor limit capabilities instead of inferring them from a replaced provider', async () => {
    const fixture = fake()
    const validateLimits = vi.fn()
    config.providers = [{ id: 'fixture', kind: 'cli', cli: 'codex' }]
    config.limits = { maxCostUsd: 1 }
    const registry = createExecutorRegistry(config, { executors: { fixture: { ...fixture.registry.get('fixture'), validateLimits } } })
    expect((await runCoreWorkflow(opts(registry))).status).toBe('succeeded')
    expect(fixture.calls).toHaveLength(3)
    expect(validateLimits).toHaveBeenCalledWith({ maxCostUsd: 1 })
  })

  it('accepts fenced, prefixed or bare JSON objects and rejects arrays or oversized text', () => {
    expect(parseAgentObject('```json\n{"approved":true}\n```')).toEqual({ approved: true })
    expect(parseAgentObject('Here is the result:\n\n{"approved":true,"note":"a } b"}\n\nDone.')).toEqual({ approved: true, note: 'a } b' })
    expect(() => parseAgentObject('[]')).toThrow('structured JSON object')
    expect(() => parseAgentObject('x'.repeat(2_000_001))).toThrow('too large')
  })

  it('leaves Core ownership records consistent with the exact archived candidate', async () => {
    const { registry } = fake()
    await runCoreWorkflow(opts(registry))
    const journal = JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'state.json'), 'utf8')) as PipelineState
    expect(journal.archiveApproval?.candidateHash).toBe(journal.phases.archive.candidateHash)
    expect(journal.archiveApproval?.artifactHash).toBe(journal.phases.archive.artifactHash)
    expect(journal.archivePath).toContain(change)
  })

  it('recovers an interrupted archive after its directory was moved without rerunning agents', async () => {
    const { registry, calls } = fake()
    const completed = await runCoreWorkflow(opts(registry))
    expect(completed.status, completed.error).toBe('succeeded')
    const journalPath = path.join(pipelineStateDirectory(context), 'state.json')
    await interruptAfterArchiveRename()
    expect((await runCoreWorkflow(opts(registry, { resume: true }))).status).toBe('blocked')
    expect((JSON.parse(readFileSync(journalPath, 'utf8')) as PipelineState).phases.archive.status).toBe('running')
    const resumed = await runCoreWorkflow(opts(registry, { resume: true, recoverInterrupted: ['archive'] }))
    expect(resumed.status, resumed.error).toBe('succeeded')
    expect(calls).toHaveLength(3)
    expect(inspectPipeline(context).verification.valid).toBe(true)
  })

  it.each(['candidate', 'artifacts'])('refuses changed %s during interrupted archive recovery', async changed => {
    const { registry, calls } = fake()
    expect((await runCoreWorkflow(opts(registry))).status).toBe('succeeded')
    const archived = await interruptAfterArchiveRename()
    if (changed === 'candidate') write(path.join(context.artifactRoot, 'code.cjs'), 'module.exports = 3\n')
    else write(path.join(archived, 'design.md'), '# Changed after original archive approval\n')
    await expect(runCoreWorkflow(opts(registry, { resume: true, recoverInterrupted: ['archive'] }))).rejects.toThrow('not authorized for this exact reviewed candidate')
    expect(calls).toHaveLength(3)
  })

  it('reconciles host delivery markers after an archive receipt was already committed', async () => {
    const { registry, calls } = fake()
    expect((await runCoreWorkflow(opts(registry))).status).toBe('succeeded')
    const journalPath = path.join(pipelineStateDirectory(context), 'state.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as PipelineState
    journal.phases.ship = { status: 'pending' }
    journal.phases.ci = { status: 'pending' }
    writeFileSync(journalPath, JSON.stringify(journal))
    await patchLedger(state => {
      state.status = 'running'
      state.nextStep = 'archive'
      state.steps.archive!.status = 'running'
      state.history.at(-1)!.status = 'running'
    })
    const recovered = await runCoreWorkflow(opts(registry, { resume: true, recoverInterrupted: ['archive'] }))
    expect(recovered.status, recovered.error).toBe('succeeded')
    expect(calls).toHaveLength(3)
    expect(inspectPipeline(context).phases).toMatchObject({ archive: { status: 'done' }, ship: { status: 'skipped' }, ci: { status: 'skipped' } })
    expect(inspectPipeline(context).resumePhase).toBeNull()
  })

  it('provides compact status independent of accumulated phase output size', async () => {
    const { registry } = fake()
    expect((await runCoreWorkflow(opts(registry))).status).toBe('succeeded')
    const largeOutput = { summary: 'x'.repeat(3 * 1024 * 1024) }
    await patchLedger(state => {
      state.steps.developer!.output = largeOutput
      state.history.find(attempt => attempt.stepId === 'developer')!.output = largeOutput
    })
    const file = path.join(root, 'context.json')
    writeFileSync(file, JSON.stringify(context))
    let full: unknown
    let compact: unknown
    await runRuntimeCommand({ context: file }, ['status'], event => { full = event })
    await runRuntimeCommand({ context: file, compact: true }, ['status'], event => { compact = event })
    expect(JSON.stringify(full).length).toBeGreaterThan(4 * 1024 * 1024)
    expect(JSON.stringify(compact).length).toBeLessThan(50_000)
    expect(compact).toMatchObject({ type: 'runtime-status', state: { runId: context.runId, status: 'succeeded', steps: { developer: { status: 'succeeded' } }, usage: { inputTokens: 60 } }, pipeline: { verification: { valid: true } } })
    const projected = compact as { state: Record<string, unknown>; pipeline: { context?: unknown; verification: { receipt: { commands: Record<string, unknown>[] } } } }
    expect(projected.state.history).toBeUndefined()
    expect(projected.state.events).toBeUndefined()
    expect(projected.pipeline.context).toBeUndefined()
    expect(projected.pipeline.verification.receipt.commands.every(command => command.output === undefined && command.exitCode === 0 && command.repositoryId)).toBe(true)
  })
})


describe('declared role execution through the existing graph boundary', () => {
  it('executes an optional-skill custom role and records all nullable usage and invocation metadata', async () => {
    config.roles = { 'security-reviewer': { provider: 'fixture', access: 'read', artifacts: 'none', prompt: 'Inspect permission enforcement before approving.' } }
    const calls: AgentRequest[] = []
    const registry = new ExecutorRegistry().register('fixture', { execute: async request => {
      calls.push(request)
      expect(request).toMatchObject({ role: 'security-reviewer', access: 'read', artifacts: 'none', instructions: 'role' })
      expect(request.openspec).toBeUndefined()
      expect(request.prompt).toContain('Inspect permission enforcement')
      expect(request.prompt).not.toContain('## Your task: reviewer')
      return { text: '{"approved":true}', usage: { inputTokens: 12, outputTokens: 4, costUsd: null } }
    } })
    const invoke = createRoleInvoker({ context, config, registry, openspec: {} })
    const schema = Annotation.Root({ result: Annotation<string>({ reducer: (_previous, next) => next, default: () => '' }) })
    const state = await runWorkflow({ directory: path.join(root, 'custom-role-workflow'), runId: context.runId, input: {}, workflow: {
      id: 'custom-role-fixture', version: '1', schema, entry: 'security-reviewer', nodes: { 'security-reviewer': { effect: 'read', ends: [], run: async (_state, step) => {
        const output = await invoke('security-reviewer', step, { prompt: roleInstructions(resolveRoleDescriptor(config, 'security-reviewer'), context, change), structured: true }, value => value?.approved)
        if (!output.ok) throw new Error(output.error)
        return { status: 'succeeded', output: output.value as boolean }
      } } },
    } })
    expect(state.status).toBe('succeeded')
    expect(calls).toHaveLength(1)
    expect(state.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, costUsd: null })
    const metrics = runtimeEfficiency(state, roleIds(config))
    expect(metrics.total).toMatchObject({ providerCalls: 1, costUsd: null })
    expect(metrics.phases[0]).toMatchObject({ stepId: 'security-reviewer', providerCalls: 1 })
  })
})


it('reuses a custom role session only while its effective policy matches', async () => {
  config.roles = { auditor: { provider: 'fixture', access: 'read', artifacts: 'none', prompt: 'Audit the files.' } }
  const calls: AgentRequest[] = []
  const registry = new ExecutorRegistry().register('fixture', {
    capabilities: () => ({ transport: 'fixture', continuation: 'supported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }),
    execute: async request => { calls.push(request); return { text: 'Reviewed', sessionId: 'auditor-session', usage: { inputTokens: 1, outputTokens: 1, costUsd: null } } },
  })
  const invoke = createRoleInvoker({ context, config, registry })
  const changed = createRoleInvoker({ context, config: { ...config, roles: { auditor: { ...config.roles.auditor!, artifacts: 'all' } } }, registry })
  const schema = Annotation.Root({ note: Annotation<string>({ reducer: (_old, next) => next, default: () => '' }) })
  const prompt = roleInstructions(resolveRoleDescriptor(config, 'auditor'), context, change)
  const state = await runWorkflow({ directory: path.join(root, 'role-session-workflow'), runId: context.runId, input: {}, workflow: {
    id: 'role-session', version: '1', schema, entry: 'first', nodes: Object.fromEntries(['first', 'same', 'changed'].map((id, i, ids) => [id, {
      effect: 'read' as const, ends: ids[i + 1] ? [ids[i + 1]!] : [], run: async (_state: Record<string, unknown>, step: import('./workflow-types.js').WorkflowStepContext) => {
        const result = await (id === 'changed' ? changed : invoke)('auditor', step, { prompt: i ? 'Continue the audit.' : prompt, ...(i ? { resumeSessionId: 'auditor-session', fallbackPrompt: prompt } : {}) }, (_object, text) => text)
        if (!result.ok) throw new Error(result.error)
        return { status: 'succeeded' as const, output: result.value }
      },
    }])) },
  })
  expect(state.status).toBe('succeeded')
  expect(calls.map(call => call.resumeSessionId)).toEqual([undefined, 'auditor-session', undefined])
  expect(calls[2]!.prompt).toContain('Audit the files.')
})
