import { OpenSpecTools } from './openspec.js'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { implementationWorkflowDefinition, runCoreWorkflow } from './core-host.js'
import { ExecutorRegistry } from './executors.js'
import { type AgentRequest } from './executor-types.js'
import { inspectPipeline, pipelineStateDirectory } from '../pipeline/pipeline-state.js'
import { compactState } from './cli.js'
import { runtimeEfficiency } from './efficiency.js'
import { runRecovery } from './recovery.js'
import { definitionFingerprint } from './workflow.js'
import { coreNodes, type CoreNodeDeps } from './graph/nodes.js'
import { CORE_NODE_ORDER } from './graph/state.js'
import { resolveReviewPolicy } from './graph/review-policy.js'
import { active, architecture, change, config, context, develop, fake, git, journalFile, legacyFingerprints, opts, result, review, write } from './__tests__/core-host-fixture.js'

describe('programmatic Core host with real evidence gates', () => {
  it.each(legacyFingerprints)('preserves the legacy definition fingerprint (compactDeveloper: $compactDeveloper)', fixture => {
    const invoke = vi.fn(async () => { throw new Error('Fingerprint inspection must not invoke a provider') })
    const note = vi.fn<CoreNodeDeps['note']>()
    // Inspect the real descriptors without executing providers or OpenSpec tools.
    const nodes = coreNodes({ context, config, change, attempts: fixture.attempts,
      openspec: {} as CoreNodeDeps['openspec'], policy: resolveReviewPolicy(config), invoke, note })
    const definition = implementationWorkflowDefinition(nodes, fixture)
    expect(definitionFingerprint(definition)).toBe(fixture.fingerprint)
    expect(Object.keys(definition.nodes)).toEqual(CORE_NODE_ORDER)
    for (const id of CORE_NODE_ORDER) {
      expect(definition.nodes[id]).toBe(nodes[id])
      const changed = { ...definition, nodes: { ...definition.nodes, [id]: { ...nodes[id], ends: [...nodes[id].ends, 'architect'] } } }
      expect(definitionFingerprint(changed)).not.toBe(fixture.fingerprint)
    }
    expect(definitionFingerprint({ ...definition, version: 'changed' })).not.toBe(fixture.fingerprint)
    expect(definitionFingerprint({ ...definition, maxTransitions: definition.maxTransitions! + 1 })).not.toBe(fixture.fingerprint)
    expect(definitionFingerprint({ ...definition, nodes: Object.fromEntries(Object.entries(definition.nodes).reverse()) })).not.toBe(fixture.fingerprint)
    expect(invoke).not.toHaveBeenCalled()
    expect(note).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves archive diagnostics and revalidates only changed candidate evidence (code changed: %s)', async (codeChanged) => {
    const mainSpec = path.join(context.artifactRoot, 'openspec/specs/feature/spec.md')
    write(mainSpec, '# Feature\n\nExisting behavior.\n\n## Requirements\n### Requirement: Existing behavior\nThe system SHALL preserve existing behavior.\n#### Scenario: Existing use\n- **WHEN** called\n- **THEN** existing behavior remains\n')
    const { registry, calls } = fake()
    const failed = await runCoreWorkflow(opts(registry))
    expect(failed.status).toBe('failed')
    expect(failed.nextStep).toBe('archive')
    // OpenSpec 1.14 exits non-zero here (1.4.1 exited 0 without archiving); either way its output survives.
    expect(failed.error).toContain('OpenSpec archive failed')
    expect(failed.error).toContain('Purpose')
    expect(failed.error).not.toContain('ambiguous')
    expect(existsSync(active('tasks.md'))).toBe(true)
    const receipt = inspectPipeline(context).verification.receipt?.id
    const count = calls.length
    const retried = await runCoreWorkflow(opts(registry, { resume: true }))
    expect(retried.status).toBe('failed')
    expect(retried.error).toContain('Purpose')
    expect(calls).toHaveLength(count)
    expect(inspectPipeline(context).verification.receipt?.id).toBe(receipt)
    expect(compactState(retried)?.recentFailures).toEqual([
      expect.objectContaining({ stepId: 'archive', status: 'failed', error: expect.stringContaining('Purpose') }),
      expect.objectContaining({ stepId: 'archive', status: 'failed', error: expect.stringContaining('Purpose') }),
    ])
    const inspected = await runRecovery(context, { action: 'read_file', repositoryId: context.repositories[0]!.id, path: 'openspec/specs/feature/spec.md' }) as { hash: string }
    expect(await runRecovery(context, { action: 'patch', repositoryId: context.repositories[0]!.id, path: 'openspec/specs/feature/spec.md',
      operationId: '7ec505b8-a03d-4b1b-91cb-8ca9c8604fa7', expectedHash: inspected.hash, oldText: '# Feature\n', newText: '# Feature\n\n## Purpose\n', reason: 'Restore the section required by OpenSpec validation',
    })).toMatchObject({ status: 'applied' })
    if (codeChanged) write(path.join(context.repositories[0]!.path, 'code.cjs'), 'module.exports = 2\n// changed candidate\n')
    const repaired = await runCoreWorkflow(opts(registry, { resume: true }))
    expect(repaired.status, repaired.error).toBe('succeeded')
    expect(calls.slice(count).map(call => call.role)).toEqual(codeChanged ? ['reviewer'] : [])
    if (codeChanged) expect(inspectPipeline(context).verification.receipt?.id).not.toBe(receipt)
    else expect(inspectPipeline(context).verification.receipt?.id).toBe(receipt)
    expect(existsSync(active())).toBe(false)
  })

  it('accepts real node:test TAP output whose passing test names describe failures', async () => {
    config.verification = context.repositories.map(repository => ({
      repositoryId: repository.id, command: process.execPath,
      args: ['-e', 'const test = require("node:test"); const assert = require("node:assert/strict"); test("getResourceTranslationJobs rethrows non-404 failures", () => assert.equal(require("./code.cjs"), 2))'],
    }))
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(state.history.map(attempt => attempt.stepId)).toEqual(['architect', 'developer', 'verify', 'reviewer', 'archive'])
    expect(calls.filter(call => call.role === 'developer')).toHaveLength(1)
  })

  it('stops a persistent exit-zero failure as soon as a correction round leaves the candidate unchanged', async () => {
    config.verification = context.repositories.map(repository => ({
      repositoryId: repository.id, command: process.execPath,
      args: ['-e', 'process.stdout.write("not ok 1 - broken\\n# fail 1\\n")'],
    }))
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('left the change exactly as it was')
    expect(calls.filter(call => call.stance === 'fixer')).toHaveLength(1)
    expect(state.history.filter(attempt => attempt.stepId === 'verify')).toHaveLength(2)
    expect(calls.some(call => call.role === 'reviewer')).toBe(false)
    expect(inspectPipeline(context).phases.archive.status).toBe('pending')
  })

  it('blocks a persistent exit-zero failure after the configured fixer budget', async () => {
    // Each round changes the candidate and the reported failure, so only the budget can stop it.
    const words = ['alpha', 'beta', 'gamma', 'delta']
    config.verification = context.repositories.map(repository => ({
      repositoryId: repository.id, command: process.execPath,
      args: ['-e', 'process.stdout.write("not ok 1 - broken " + require("fs").readFileSync("round.txt", "utf8") + "\\n# fail 1\\n")'],
    }))
    let round = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'reviewer') return result(review)
      develop()
      for (const repository of context.repositories) write(path.join(repository.path, 'round.txt'), words[round]!)
      round++
      return result('Implemented and marked completed tasks')
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('correction limit')
    expect(calls.filter(call => call.stance === 'fixer')).toHaveLength(config.limits!.maxAttempts!)
    expect(state.history.filter(attempt => attempt.stepId === 'verify')).toHaveLength(3)
    expect(calls.some(call => call.role === 'reviewer')).toBe(false)
    expect(inspectPipeline(context).phases.archive.status).toBe('pending')
  })

  it.each([2, 3])('uses the existing %i candidate budget and escalates only the third candidate', async maxAttempts => {
    config.limits = { maxAttempts }
    config.agents.developer = { provider: 'fixture', model: 'base', escalation: { model: 'rescue' } }
    let candidates = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'reviewer') return result(review)
      candidates++
      if (candidates === 3) develop()
      return result('Candidate implemented; Core checks the behavior')
    })
    const state = await runCoreWorkflow(opts(registry))
    const developers = calls.filter(call => call.role === 'developer')
    expect(developers).toHaveLength(maxAttempts)
    expect(developers.map(call => call.model)).toEqual(maxAttempts === 2 ? ['base', 'base'] : ['base', 'base', 'rescue'])
    expect(state.status).toBe(maxAttempts === 3 ? 'succeeded' : 'blocked')
    expect(calls.filter(call => call.role === 'reviewer')).toHaveLength(maxAttempts === 3 ? 1 : 0)
  }, 120000)

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
    expect(runtimeEfficiency(state).total).toMatchObject({ providerCalls: 3, inputTokens: 60, outputTokens: 30, cacheReadInputTokens: null })
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

  it('passes frozen custom definitions to every role while retaining output contracts', async () => {
    config.rolePrompts = { architect: 'Custom architecture', developer: 'Custom implementation', reviewer: 'Custom review' }
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    for (const call of calls) {
      expect(call.prompt).toContain(config.rolePrompts[call.role])
      expect(call.prompt).toContain('## Output contract')
      expect(call.prompt).toContain('## Frozen scope')
    }
  })

  it('requires the architect to execute the real planning workflow instead of returning artifact JSON', async () => {
    const original = fake()
    const registry = new ExecutorRegistry().register('fixture', { execute: async request => {
      if (request.role !== 'architect') return original.registry.execute('fixture', request)
      return result(architecture)
    } })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Required OpenSpec role workflow was not executed')
    expect(journalFile().phases.reviewer.status).not.toBe('done')
  })

  it('loads official apply context before a developer that omits the workflow tool', async () => {
    const original = fake(), calls: AgentRequest[] = []
    const registry = new ExecutorRegistry().register('fixture', { execute: async request => {
      calls.push(request)
      if (request.role !== 'developer') return original.registry.execute('fixture', request)
      expect(request.prompt).toContain('Host-loaded official apply workflow')
      expect(request.prompt).toContain('contextFiles')
      expect(request.prompt).toContain('openspec-apply-change')
      develop()
      return result('Implemented using the supplied official context')
    } })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer'])
    const trace = readFileSync(path.join(pipelineStateDirectory(context), 'agent-workflow', 'openspec-developer.jsonl'), 'utf8')
    expect(trace).toContain('"origin":"host"')
    expect(trace).toContain('"artifact":"apply"')
  }, 60000)

  it.each([true, false])('supplies official verify context to an omitted reviewer workflow without a repair (session: %s)', async session => {
    const original = fake(), calls: AgentRequest[] = []
    const registry = new ExecutorRegistry().register('fixture', { capabilities: async () => ({ transport: 'fixture', continuation: 'supported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }), execute: async request => {
      calls.push(request)
      if (request.role !== 'reviewer') return original.registry.execute('fixture', request)
      expect(request.prompt).toContain('Host-loaded official verify workflow')
      expect(request.prompt).toContain('openspec-verify-change')
      expect(request.prompt).toContain('contextFiles')
      expect(request.prompt).toContain('Acceptance criteria to certify')
      expect(request).toMatchObject({ access: 'read', artifacts: 'none' })
      return { ...result(review), ...(session ? { sessionId: 'review-session' } : {}) }
    } })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer'])
    expect(state.usage.costUsd).toBeCloseTo(0.3)
    expect(state.history.filter(item => item.stepId === 'verify')).toHaveLength(1)
    expect(state.events.some(event => event.type === 'step_failed')).toBe(false)
  })

  it('accepts the reported reviewer tool sequence without a redundant repair', async () => {
    const original = fake(), calls: AgentRequest[] = []
    const registry = new ExecutorRegistry().register('fixture', { execute: async request => {
      calls.push(request)
      if (request.role !== 'reviewer') return original.registry.execute('fixture', request)
      const tools = new OpenSpecTools(request.openspec!)
      await tools.execute({ action: 'load_skill' })
      await tools.execute({ action: 'status' })
      await tools.execute({ action: 'instructions', artifact: 'specs' })
      await tools.execute({ action: 'validate' })
      return result(review)
    } })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer'])
    expect(state.history.filter(item => item.stepId === 'verify')).toHaveLength(1)
    expect(state.usage.costUsd).toBeCloseTo(0.3)
  })

  it('bounds malformed reviewer reports and resumes the failed review without replaying valid phases', async () => {
    const original = fake(), calls: AgentRequest[] = []
    let comply = false
    const registry = new ExecutorRegistry().register('fixture', { execute: async request => {
      calls.push(request)
      if (request.role === 'reviewer' && !comply) return { ...result('not a JSON object'), sessionId: 'review-session' }
      return original.registry.execute('fixture', request)
    } })
    const failed = await runCoreWorkflow(opts(registry))
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('Invalid structured role response')
    expect(calls.filter(call => call.role === 'reviewer')).toHaveLength(2)
    expect(existsSync(active())).toBe(true)
    comply = true
    const resumed = await runCoreWorkflow(opts(registry, { resume: true }))
    expect(resumed.status, resumed.error).toBe('succeeded')
    expect(calls.filter(call => call.role === 'architect')).toHaveLength(1)
    expect(calls.filter(call => call.role === 'developer')).toHaveLength(1)
    expect(resumed.history.filter(item => item.stepId === 'verify')).toHaveLength(2)
  })
})
