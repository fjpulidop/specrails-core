import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCoreWorkflow } from './core-host.js'
import { AgentExecutionError } from './executor-types.js'
import { inspectPipeline, pipelineStateDirectory } from '../pipeline/pipeline-state.js'
import { runtimeEfficiency } from './efficiency.js'
import { active, architecture, config, context, develop, fake, git, interruptAfterArchiveRename, opts, result, review, root, write } from './__tests__/core-host-fixture.js'

describe('programmatic Core host with real evidence gates', () => {
  it('archives deltas with the real framework and preserves unrelated main requirements', async () => {
    const main = path.join(context.artifactRoot, 'openspec/specs/feature/spec.md')
    write(main, '# Feature\n\n## Purpose\nExisting behavior for the shared feature.\n\n## Requirements\n### Requirement: Existing behavior\nThe system SHALL preserve the existing behavior.\n#### Scenario: Existing call\n- **WHEN** calling the existing feature\n- **THEN** preserve its behavior.\n')
    const { registry } = fake()
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    const merged = readFileSync(main, 'utf8')
    expect(merged).toContain('Requirement: Existing behavior')
    expect(merged).toContain('Requirement: Implement shared behavior')
    expect(merged).not.toContain('ADDED Requirements')
  })

  it('recovers partially published main specs without applying the delta twice', async () => {
    const { registry, calls } = fake()
    expect((await runCoreWorkflow(opts(registry))).status).toBe('succeeded')
    const archived = await interruptAfterArchiveRename()
    renameSync(archived, active())
    const receipt = JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'openspec-archive.json'), 'utf8')) as { writes: { path: string; before: string | null }[] }
    const first = receipt.writes[0]!
    const file = path.join(context.artifactRoot, first.path)
    if (first.before === null) rmSync(file)
    else writeFileSync(file, first.before)
    const resumed = await runCoreWorkflow(opts(registry, { resume: true, recoverInterrupted: ['archive'] }))
    expect(resumed.status, resumed.error).toBe('succeeded')
    expect(calls).toHaveLength(4)
    expect(readFileSync(file, 'utf8')).toContain('Requirement: Implement shared behavior')
  })

  it('rechecks verification and review once before consuming unchanged archive consent', async () => {
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
    expect(calls).toHaveLength(4)
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

  it('adopts output the verification regenerates itself and tells the reviewer and fixer not to revert it', async () => {
    // A lint pre-step that rewrites a committed mapping file, identically on every run.
    config.verification = context.repositories.map(repository => ({ repositoryId: repository.id, command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync("mappings.js","regenerated");if(require("./code.cjs")!==2)process.exit(9)'] }))
    for (const repository of context.repositories) { write(path.join(repository.path, 'mappings.js'), 'committed'); git(repository.path, ['add', '.']); git(repository.path, ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'mapping']) }
    let reviews = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') { develop(); return result('Implemented') }
      return result(++reviews === 1 ? { ...review, approved: false, issues: ['Add regression coverage'] } : review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    const reviewers = calls.filter(call => call.role === 'reviewer'), fixer = calls.find(call => call.stance === 'fixer')!
    for (const prompt of [reviewers[0]!.prompt, fixer.prompt, reviewers[1]!.prompt]) {
      expect(prompt).toContain('## Host-adopted verification output')
      expect(prompt).toContain('`front`: `mappings.js`')
    }
    expect(reviewers[0]!.prompt).toContain('other than the host-adopted verification output listed below')
    expect(readFileSync(path.join(context.repositories[0]!.path, 'mappings.js'), 'utf8')).toBe('regenerated')
    expect(state.history.filter(attempt => attempt.stepId === 'verify')).toHaveLength(2)
  })

  it('blocks with the typed cause instead of a correction round when verification output never converges', async () => {
    config.verification = context.repositories.map(repository => ({ repositoryId: repository.id, command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync("build-info.js",String(Date.now()+Math.random()))'] }))
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('verification_nondeterministic_output')
    expect(state.error).toContain('build-info.js')
    expect(state.error).toContain('make the generator idempotent')
    expect(calls.some(call => call.stance === 'fixer')).toBe(false)
    expect(calls.some(call => call.role === 'reviewer')).toBe(false)
  })

  it('blocks without a re-run when the verification-output-adoption guardrail is off', async () => {
    config.guardrails = { 'verification-output-adoption': false }
    config.verification = context.repositories.map(repository => ({ repositoryId: repository.id, command: process.execPath, args: ['-e', 'require("fs").writeFileSync("stable.js","same")'] }))
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('verification-output-adoption guardrail')
    expect(calls.some(call => call.stance === 'fixer')).toBe(false)
  })

  it('reinstalls a drifted dependency at verification instead of handing the failure to the fixer', async () => {
    // node_modules/exp holds 1.0.0 against ^2.0.0; the lockfile resolves 2.1.0 from a local tarball, so npm runs offline.
    const front = context.repositories[0]!.path
    write(path.join(root, 'pack', 'package', 'package.json'), JSON.stringify({ name: 'exp', version: '2.1.0' }))
    mkdirSync(path.join(front, 'vendor'), { recursive: true })
    spawnSync('tar', ['-czf', path.join(front, 'vendor', 'exp-2.1.0.tgz'), '-C', path.join(root, 'pack'), 'package'])
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(path.join(front, 'vendor', 'exp-2.1.0.tgz'))).digest('base64')
    write(path.join(front, 'package.json'), JSON.stringify({ name: 'front', version: '1.0.0', dependencies: { exp: '^2.0.0' } }))
    write(path.join(front, 'package-lock.json'), JSON.stringify({ name: 'front', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
      '': { name: 'front', version: '1.0.0', dependencies: { exp: '^2.0.0' } }, 'node_modules/exp': { version: '2.1.0', resolved: 'file:vendor/exp-2.1.0.tgz', integrity } } }))
    write(path.join(front, '.gitignore'), 'node_modules/\n')
    git(front, ['add', '.']); git(front, ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'manifest'])
    write(path.join(front, 'node_modules', 'exp', 'package.json'), JSON.stringify({ name: 'exp', version: '1.0.0' }))
    config.verification[0] = { repositoryId: 'front', command: process.execPath, args: ['-e', 'if(require("./node_modules/exp/package.json").version!=="2.1.0"){console.error("src/untouched.ts 3:7 error Unsafe call no-unsafe-call");process.exit(1)}if(require("./code.cjs")!==2)process.exit(9)'] }
    vi.stubEnv('npm_config_offline', 'true')
    const notes: string[] = []
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry, { onAgentEvent: (_role, event) => { if (event.text) notes.push(event.text) } }))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.some(call => call.stance === 'fixer')).toBe(false)
    expect(JSON.parse(readFileSync(path.join(front, 'node_modules', 'exp', 'package.json'), 'utf8')).version).toBe('2.1.0')
    expect(notes.join('\n')).toContain('exp 1.0.0 does not satisfy ^2.0.0')
  }, 120_000)

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
    expect(calls[1]!.prompt).toContain('Core owns these complete verification commands')
    expect(calls[1]!.prompt).toContain('do not duplicate that full run')
  })

  it('starts a fresh developer turn when the previous session cannot be continued', async () => {
    let development = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') {
        development++
        if (request.resumeSessionId) throw new AgentExecutionError('session gone', 'session_expired')
        if (development >= 2) develop()
        return { ...result('Implementation attempt'), sessionId: 'dev-session' }
      }
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.filter(call => call.role === 'developer').map(call => Boolean(call.resumeSessionId))).toEqual([false, true, false])
    const metrics = runtimeEfficiency(state)
    expect(metrics.total).toMatchObject({ providerCalls: 5, costUsd: null })
    expect(metrics.phases.find(phase => phase.stepId === 'developer')).toMatchObject({ attempts: 2, measuredAttempts: 2, providerCalls: 3, costUsd: null })
    expect(state.history.filter(attempt => attempt.stepId === 'developer').flatMap(attempt => attempt.invocations ?? []).map(call => call.status)).toEqual(['succeeded', 'failed', 'succeeded'])
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

  it('surfaces a no-progress blocker once and can continue after it is resolved', async () => {
    const notes: string[] = []
    const { registry, calls } = fake(async request => result(request.role === 'architect' ? architecture : {
      summary: 'Cannot edit Back', files: [], tests: [], verification: 'none',
      incomplete: [{ task: 'Implement Back', reason: 'Back is read-only in this session' }],
    }))
    const state = await runCoreWorkflow(opts(registry, { onAgentEvent: (_role, event) => { if (event.text) notes.push(event.text) } }))
    expect(state.status).toBe('blocked')
    expect(state.nextStep).toBe('developer')
    expect(state.error).toContain('Back is read-only')
    expect(notes.join('\n')).toContain('Pending task: Implement Back')
    expect(calls.filter(call => call.role === 'developer')).toHaveLength(1)
    expect(calls[0]!.prompt).toContain('Repository reference')
    const resumed = await runCoreWorkflow(opts(fake().registry, { resume: true }))
    expect(resumed.status, resumed.error).toBe('succeeded')
  })

  it('stops repeated false completion at the configured correction limit', async () => {
    const { registry, calls } = fake(async request => result(request.role === 'architect' ? architecture : 'Done, all tests pass'))
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('continuation limit')
    expect(calls.filter(call => call.role === 'developer')).toHaveLength(2)
    expect(calls.some(call => call.role === 'reviewer')).toBe(false)
    // `new change` scaffolds an empty changes/archive/ since OpenSpec 1.14.
    const archived = path.join(context.artifactRoot, 'openspec', 'changes', 'archive')
    expect(existsSync(archived) ? readdirSync(archived) : []).toEqual([])
  })

  it('returns unchecked tasks to the developer as feedback instead of failing, then blocks at the limit', async () => {
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      for (const repository of context.repositories) write(path.join(repository.path, 'code.cjs'), 'module.exports = 2\n')
      return result('Done, every requirement is complete')
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('continuation limit')
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
        if (architectCalls === 1) return { ...result('Here is my plan:\n' + JSON.stringify({ ...architecture, confidence: 'invalid' })), sessionId: 'arch-session' }
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
})
