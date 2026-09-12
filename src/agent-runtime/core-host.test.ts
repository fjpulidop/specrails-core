import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCoreWorkflow, parseAgentObject, type CoreWorkflowOptions } from './core-host.js'
import { createExecutorRegistry, ExecutorRegistry } from './executors.js'
import { AgentExecutionError, type AgentRequest, type AgentResult, type RuntimeConfig } from './executor-types.js'
import { inspectPipeline, pipelineStateDirectory, type PipelineContext, type PipelineState } from '../installer/runtime/pipeline-state.js'
import { readWorkflowEnvelope, writeWorkflowEnvelope } from './durable-store.js'
import type { WorkflowState } from './workflow-types.js'
import { runRuntimeCommand } from './cli.js'
import { DEVELOPER_OUTPUT_SCHEMA } from './prompts.js'

let root: string
let context: PipelineContext
let config: RuntimeConfig
const change = 'programmatic-feature'
const usage = { costUsd: 0.1, inputTokens: 20, outputTokens: 10 }
const architecture = {
  proposal: '# Feature\nImplement the frozen feature.', design: '# Design\nUpdate both selected repositories.',
  tasks: [{ title: 'Implement the feature and validate both repositories' }],
  specs: [{ name: 'feature', content: '# Feature\n## Requirement: Implement shared behavior\n### Scenario: Requested behavior\n- Both repositories return 2.\n' }], confidence: 'high',
}
const acceptance = { criteria: [{ specId: '7', criterionIndex: 0, status: 'met', evidence: ['code.cjs returns 2 in both repositories'] }], checks: [], findings: [] }
const review = {
  approved: true, summary: 'Inspected both repositories and real verification evidence', issues: [], score: 90,
  aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 },
  acceptance,
}
function write(file: string, text: string): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
function git(repository: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
function active(file = ''): string { return path.join(context.artifactRoot, 'openspec', 'changes', change, file) }
function develop(): void {
  for (const repository of context.repositories) write(path.join(repository.path, 'code.cjs'), 'module.exports = 2\n')
  write(active('tasks.md'), readFileSync(active('tasks.md'), 'utf8').replaceAll('- [ ]', '- [x]'))
}
function result(value: unknown): AgentResult { return { text: typeof value === 'string' ? value : JSON.stringify(value), usage } }
function fake(execute?: (request: AgentRequest) => Promise<AgentResult>): { registry: ExecutorRegistry; calls: AgentRequest[] } {
  const calls: AgentRequest[] = []
  return { calls, registry: new ExecutorRegistry().register('fixture', { execute: async request => {
    calls.push(request)
    if (execute) return execute(request)
    if (request.role === 'architect') return result(architecture)
    if (request.role === 'developer') { develop(); return result('Implemented and marked completed tasks') }
    return result(review)
  } }) }
}
function opts(registry: ExecutorRegistry, overrides: Partial<CoreWorkflowOptions> = {}): CoreWorkflowOptions {
  return { context, config, change, registry, ...overrides }
}
/** Edits the durable ledger the way a dead process leaves it: the LangGraph history stays intact. */
async function patchLedger(mutate: (state: WorkflowState) => void): Promise<void> {
  const directory = path.join(pipelineStateDirectory(context), 'agent-workflow')
  const envelope = (await readWorkflowEnvelope(directory, context.runId))!
  mutate(envelope.state)
  await writeWorkflowEnvelope(directory, envelope)
}
function journalFile(): PipelineState { return JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'state.json'), 'utf8')) as PipelineState }
async function interruptAfterArchiveRename(): Promise<string> {
  const journalPath = path.join(pipelineStateDirectory(context), 'state.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as PipelineState
  // Reconstruct durable state after rename but before Core saved its archive receipt.
  const archived = journal.archivePath!
  const archivedRelative = path.relative(context.artifactRoot, archived).split(path.sep).join('/')
  journal.artifactExclusions = journal.artifactExclusions.filter(item => item !== archivedRelative)
  delete journal.archivePath
  journal.phases.archive = { status: 'running' }
  journal.phases.ship = { status: 'pending' }
  journal.phases.ci = { status: 'pending' }
  writeFileSync(journalPath, JSON.stringify(journal))
  await patchLedger(state => {
    state.status = 'running'
    state.nextStep = 'archive'
    state.steps.archive!.status = 'running'
    state.history.at(-1)!.status = 'running'
  })
  return archived
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'core host with spaces '))
  const repositories = ['front', 'back'].map(id => {
    const repository = path.join(root, id)
    mkdirSync(repository)
    git(repository, ['init', '-q'])
    write(path.join(repository, 'code.cjs'), 'module.exports = 1\n')
    git(repository, ['add', '.'])
    git(repository, ['-c', 'user.name=Runtime Fixture', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'baseline'])
    return { id, name: id, path: repository }
  })
  const backlogRoot = path.join(root, 'workspace')
  mkdirSync(backlogRoot)
  context = {
    schemaVersion: 1, runId: 'runtime-fixture', backlogRoot, artifactRoot: repositories[0]!.path, artifactRepositoryId: 'front', repositories,
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [{ id: 7, title: 'Shared feature', description: 'Return 2 in both repositories', repositoryIds: ['front', 'back'], acceptanceCriteria: ['Both repositories return 2'] }],
  }
  config = {
    schemaVersion: 1, enabled: true, providers: [],
    agents: { architect: { provider: 'fixture' }, developer: { provider: 'fixture' }, reviewer: { provider: 'fixture' } },
    verification: repositories.map(repository => ({ repositoryId: repository.id, command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9);process.stdout.write("real verification passed")'] })),
    limits: { maxAttempts: 2 },
  }
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('programmatic Core host with real evidence gates', () => {
  it('runs isolated roles, real checks and deterministic archive without committing host worktrees', async () => {
    const { registry, calls } = fake()
    const heads = context.repositories.map(repository => git(repository.path, ['rev-parse', 'HEAD']))
    let output = ''
    const state = await runCoreWorkflow(opts(registry, { onVerificationOutput: text => { output += text } }))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer'])
    expect(calls.every(call => call.allowedRoots.length === 2)).toBe(true)
    expect(calls[2]!.prompt).toContain('real verification passed')
    expect(calls.every(call => call.prompt.includes('Do not invoke /implement'))).toBe(true)
    expect(output).toContain('real verification passed')
    expect(state.usage.costUsd).toBeCloseTo(0.3)
    expect(state.usage.inputTokens).toBe(60)
    const inspection = inspectPipeline(context)
    expect(inspection.verification.valid).toBe(true)
    expect(inspection.resumePhase).toBeNull()
    expect(inspection.phases).toMatchObject({ architect: { status: 'done' }, developer: { status: 'done' }, reviewer: { status: 'done' }, archive: { status: 'done' }, ship: { status: 'skipped' }, ci: { status: 'skipped' } })
    expect(existsSync(active())).toBe(false)
    expect(readdirSync(path.join(context.artifactRoot, 'openspec', 'changes', 'archive'))).toHaveLength(1)
    expect(readFileSync(path.join(context.artifactRoot, 'openspec', 'specs', 'feature', 'spec.md'), 'utf8')).toContain('Both repositories return 2')
    expect(context.repositories.map(repository => git(repository.path, ['rev-parse', 'HEAD']))).toEqual(heads)
    expect((await runCoreWorkflow(opts(registry, { resume: true }))).status).toBe('succeeded')
    expect(calls).toHaveLength(3)
  })

  it('persists archive approval and resumes without rerunning valid agents', async () => {
    config.approvalBeforeArchive = true
    const { registry, calls } = fake()
    const paused = await runCoreWorkflow(opts(registry))
    expect(paused.status, paused.error).toBe('paused')
    expect(paused.pendingApproval?.stepId).toBe('archive')
    expect(existsSync(active())).toBe(true)
    expect((await runCoreWorkflow(opts(registry, { resume: true }))).status).toBe('paused')
    expect(calls).toHaveLength(3)
    const resumed = await runCoreWorkflow(opts(registry, { resume: true, approve: ['archive'] }))
    expect(resumed.status, resumed.error).toBe('succeeded')
    expect(calls).toHaveLength(3)
  })

  it('rechecks a changed candidate before consuming an archive approval', async () => {
    config.approvalBeforeArchive = true
    const { registry, calls } = fake()
    expect((await runCoreWorkflow(opts(registry))).status).toBe('paused')
    write(path.join(context.repositories[1]!.path, 'code.cjs'), 'module.exports = 2 // externally changed candidate\n')
    const rechecked = await runCoreWorkflow(opts(registry, { resume: true, approve: ['archive'] }))
    expect(rechecked.status, rechecked.error).toBe('paused')
    expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer', 'reviewer'])
    expect(rechecked.steps.verify?.visits).toBe(2)
    expect(rechecked.steps.archive?.visits).toBe(2)
    expect((await runCoreWorkflow(opts(registry, { resume: true, approve: ['archive'] }))).status).toBe('succeeded')
  })

  it('uses deterministic verification failures as bounded developer feedback', async () => {
    let development = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') {
        development++
        // First pass: tasks ticked but the code still returns 1, so the real check fails.
        if (development === 1) write(active('tasks.md'), readFileSync(active('tasks.md'), 'utf8').replaceAll('- [ ]', '- [x]'))
        if (development === 2) { expect(request.prompt).toContain('exited with code 9'); expect(request.prompt).toContain('Continue the same developer role'); expect(request.resumeSessionId).toBe('dev-session'); develop() }
        return { ...result('Implementation attempt'), sessionId: 'dev-session' }
      }
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'developer', 'reviewer'])
    expect(state.steps.verify?.visits).toBe(2)
    expect(calls[1]!.resumeSessionId).toBeUndefined()
    expect(calls[1]!.prompt).toContain('real verification passed'.length ? 'Core will run these verification commands' : '')
  })

  it('starts a fresh developer turn when the previous session cannot be continued', async () => {
    let development = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') {
        development++
        if (request.resumeSessionId) throw new AgentExecutionError('session gone', 'provider_execution_error')
        if (development >= 2) develop()
        return { ...result('Implementation attempt'), sessionId: 'dev-session' }
      }
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.filter(call => call.role === 'developer').map(call => Boolean(call.resumeSessionId))).toEqual([false, true, false])
    expect(calls.at(-2)!.prompt).toContain('## Your task: implementation')
  })

  it('uses a rejected review as a bounded correction loop and verifies the new candidate', async () => {
    let reviews = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') {
        if (reviews) expect(request.prompt).toContain('Add regression coverage')
        develop()
        return result('Implementation with corrections')
      }
      return result(++reviews === 1 ? { ...review, approved: false, issues: ['Add regression coverage'] } : review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer', 'developer', 'reviewer'])
    expect(state.steps.verify?.visits).toBe(2)
  })

  it('stops repeated false completion at the configured correction limit', async () => {
    const { registry, calls } = fake(async request => result(request.role === 'architect' ? architecture : 'Done, all tests pass'))
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('correction limit')
    expect(calls.filter(call => call.role === 'developer')).toHaveLength(2)
    expect(calls.some(call => call.role === 'reviewer')).toBe(false)
    expect(existsSync(path.join(context.artifactRoot, 'openspec', 'changes', 'archive'))).toBe(false)
  })

  it('returns unchecked tasks to the developer as feedback instead of failing, then blocks at the limit', async () => {
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      for (const repository of context.repositories) write(path.join(repository.path, 'code.cjs'), 'module.exports = 2\n')
      return result('Done, every requirement is complete')
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('correction limit')
    const developers = calls.filter(call => call.role === 'developer')
    expect(developers).toHaveLength(2)
    expect(developers[1]!.prompt).toContain('Tasks still unchecked')
    expect(developers[1]!.prompt).toContain('Implement the feature and validate both repositories')
    expect(calls.some(call => call.role === 'reviewer')).toBe(false)
    expect(inspectPipeline(context).phases.archive.status).toBe('pending')
    // An explicit resume is a human decision: it grants a fresh attempt budget.
    let fixed = 0
    const again = fake(async request => {
      if (request.role === 'developer') { if (++fixed === 2) develop(); return result('Trying again') }
      return result(review)
    })
    const resumed = await runCoreWorkflow(opts(again.registry, { resume: true }))
    expect(resumed.status, resumed.error).toBe('succeeded')
    expect(again.calls.filter(call => call.role === 'developer')).toHaveLength(2)
  })

  it('asks a structured role to resend a malformed reply once inside its session', async () => {
    let architectCalls = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') {
        architectCalls++
        if (architectCalls === 1) return { ...result('Here is my plan:\n' + JSON.stringify({ ...architecture, tasks: [] })), sessionId: 'arch-session' }
        expect(request.resumeSessionId).toBe('arch-session')
        expect(request.prompt).toContain('could not be used')
        return result(architecture)
      }
      if (request.role === 'developer') { develop(); return result('Done') }
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.filter(call => call.role === 'architect')).toHaveLength(2)
    expect(state.steps.architect?.visits).toBe(1)
    expect(state.usage.costUsd).toBeCloseTo(0.4)
  })

  it('completes coverage with architect-proposed commands and admits repositories without any check', async () => {
    config.verification = config.verification.slice(0, 1)
    const proposed = { repositoryId: 'back', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9);process.stdout.write("proposed check passed")'] }
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') { expect(request.prompt).toContain('already configured by the host'); return result({ ...architecture, verification: [proposed, { ...proposed, repositoryId: 'front' }] }) }
      if (request.role === 'developer') { expect(request.prompt).toContain('proposed check passed'.length ? 'repository `back`' : ''); develop(); return result('Done') }
      return result(review)
    })
    let output = ''
    const state = await runCoreWorkflow(opts(registry, { onVerificationOutput: text => { output += text } }))
    expect(state.status, state.error).toBe('succeeded')
    expect(output).toContain('proposed check passed')
    expect(output).toContain('real verification passed')
    expect(calls[2]!.prompt).toContain('All verification commands passed')
    // A proposal for an already-configured repository is ignored, never duplicated.
    expect(inspectPipeline(context).verification.receipt?.commands.map(command => command.repositoryId)).toEqual(['front', 'back'])
    rmSync(root, { recursive: true, force: true })
  })

  it('runs without any verification command and tells the reviewer which repositories were unverified', async () => {
    config.verification = []
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls[2]!.prompt).toContain('No automated verification command was available')
    expect(calls[2]!.prompt).toContain('`front`, `back`')
    const receipt = inspectPipeline(context).verification.receipt!
    expect(receipt.commands).toEqual([])
    expect(receipt.unverifiedRepositories).toEqual(['front', 'back'])
    expect(inspectPipeline(context).verification.valid).toBe(true)
  })

  it('rejects architecture changes made by a developer despite passing tests', async () => {
    const { registry } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      develop()
      write(active('design.md'), '# Weakened design introduced during implementation')
      return result('Done')
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Architecture artifacts changed')
  })

  it('refuses reviewer approval for a candidate modified after verification', async () => {
    const { registry } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') { develop(); return result('Done') }
      write(path.join(context.repositories[1]!.path, 'code.cjs'), 'module.exports = 3\n')
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Fresh full verification required')
    expect(inspectPipeline(context).verification.valid).toBe(false)
  })

  it('does not let an archive observer change the exact reviewed candidate', async () => {
    const { registry } = fake()
    const state = await runCoreWorkflow(opts(registry, { onEvent: event => {
      if (event.type === 'step_started' && event.stepId === 'archive') write(path.join(context.artifactRoot, 'code.cjs'), 'module.exports = 3\n')
    } }))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Archive blocked')
    expect(existsSync(active())).toBe(true)
  })

  it('pauses a low-confidence design on its question and resumes the architect with the answer', async () => {
    const question = 'Should both repositories share one module?'
    const answered: string[] = []
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') {
        if (request.prompt.includes('## Answers from the requester')) { answered.push(request.prompt); return result(architecture) }
        return result({ ...architecture, confidence: 'low', question })
      }
      if (request.role === 'developer') { develop(); return result('Done') }
      return result(review)
    })
    const paused = await runCoreWorkflow(opts(registry))
    expect(paused.status).toBe('paused')
    expect(paused.error).toBe(question)
    expect(paused.pendingQuestion).toMatchObject({ stepId: 'architect', question })
    // Without a session the investigation pass is impossible, so the question is asked at once.
    expect(calls).toHaveLength(1)
    expect(readFileSync(active('proposal.md'), 'utf8')).toContain('# Feature')
    expect(JSON.parse(readFileSync(active('design-confidence.json'), 'utf8'))).toEqual({ confidence: 'low', question })
    expect(inspectPipeline(context).phases.architect.status).toBe('blocked')
    expect((await runCoreWorkflow(opts(registry, { resume: true }))).status).toBe('paused')
    expect(calls).toHaveLength(1)
    const state = await runCoreWorkflow(opts(registry, { resume: true, answer: 'Yes, one shared module.' }))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'architect', 'developer', 'reviewer'])
    expect(answered[0]).toContain('1. Yes, one shared module.')
    expect(state.steps.architect?.visits).toBe(1)
    expect(state.pendingQuestion).toBeUndefined()
    expect(JSON.parse(readFileSync(path.join(context.artifactRoot, 'openspec', 'changes', 'archive', `${journalFile().createdAt.slice(0, 10)}-${change}`, 'design-confidence.json'), 'utf8'))).toEqual({ confidence: 'high' })
  })

  it('lets the architect investigate once in its own session before anyone is asked', async () => {
    let architectCalls = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') {
        architectCalls++
        if (architectCalls === 1) return { ...result({ ...architecture, confidence: 'low', question: 'Which module owns the value?' }), sessionId: 'arch-session' }
        expect(request.resumeSessionId).toBe('arch-session')
        expect(request.prompt).toContain('confidence was low')
        expect(request.prompt).toContain('Which module owns the value?')
        return { ...result(architecture), sessionId: 'arch-session' }
      }
      if (request.role === 'developer') { develop(); return result('Done') }
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'architect', 'developer', 'reviewer'])
    expect(state.steps.architect?.output).toMatchObject({ confidence: 'high', assumed: false, deepenPasses: 1 })
    expect(state.pendingQuestion).toBeUndefined()
  })

  it('proceeds on stated assumptions after the investigation when the project prefers autonomy', async () => {
    config.architect = { onLowConfidence: 'proceed' }
    const low = { ...architecture, confidence: 'low', question: 'Which module owns the value?' }
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return { ...result(low), sessionId: 'arch-session' }
      if (request.role === 'developer') { develop(); return result('Done') }
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'architect', 'developer', 'reviewer'])
    expect(state.steps.architect?.output).toMatchObject({ confidence: 'low', assumed: true, deepenPasses: 1 })
  })

  it('records acceptance evidence from the reviewer and from Core\'s own verification receipts', async () => {
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls[2]!.prompt).toContain('spec `7`, criterion 0: Both repositories return 2')
    const journal = journalFile()
    expect(journal.acceptance?.criteria).toEqual([{ specId: '7', criterionIndex: 0, requirement: 'Both repositories return 2', status: 'met', evidence: ['code.cjs returns 2 in both repositories'] }])
    expect(journal.acceptance?.checks.map(check => [check.name.split(':')[0], check.status, check.required])).toEqual([['front', 'passed', true], ['back', 'passed', true]])
    expect(inspectPipeline(context).completion).toMatchObject({ implementation: 'complete', validation: 'verified', archive: 'done', delivery: 'pending-host' })
  })

  it('asks the reviewer to resend acceptance evidence that does not certify every frozen requirement', async () => {
    let reviews = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') { develop(); return result('Done') }
      reviews++
      if (reviews === 1) return { ...result({ ...review, acceptance: { criteria: [], checks: [], findings: [] } }), sessionId: 'review-session' }
      expect(request.resumeSessionId).toBe('review-session')
      expect(request.prompt).toContain('Invalid acceptance report')
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.filter(call => call.role === 'reviewer')).toHaveLength(2)
  })

  it('refuses reviewer approval while a frozen requirement is unresolved', async () => {
    const { registry } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') { develop(); return result('Done') }
      return result({ ...review, acceptance: { ...acceptance, criteria: [{ ...acceptance.criteria[0], status: 'pending' }] } })
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Unresolved requirement')
    expect(inspectPipeline(context).acceptance).toMatchObject({ valid: false, status: 'blocked', reasons: ['Unresolved requirement: Both repositories return 2'] })
    expect(inspectPipeline(context).phases.reviewer.status).toBe('running')
  })

  it('applies project review thresholds and reports them to the reviewer', async () => {
    config.review = { minScore: 95, aspects: { security: 91 } }
    let reviews = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') { develop(); return result('Done') }
      return result(++reviews === 1 ? review : { ...review, score: 96, aspects: { ...review.aspects, security: 92 } })
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer', 'developer', 'reviewer'])
    expect(calls[2]!.prompt).toContain('`score` is at least 95')
    expect(calls[2]!.prompt).toContain('`security` ≥ 91')
    expect(JSON.parse(readFileSync(path.join(context.artifactRoot, 'openspec', 'changes', 'archive', `${journalFile().createdAt.slice(0, 10)}-${change}`, 'confidence-score.json'), 'utf8'))).toMatchObject({ overall: 96 })
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

  it('rejects malformed structured artifacts before writing partial architecture', async () => {
    const { registry } = fake(async () => result({ ...architecture, specs: [{ name: '../escape', content: 'malicious' }] }))
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Invalid specification name')
    expect(existsSync(active('proposal.md'))).toBe(false)
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
    await expect(runCoreWorkflow(opts(registry, { config: { ...config, enabled: false } }))).rejects.toThrow('disabled')
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
