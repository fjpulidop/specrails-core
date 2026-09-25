// End-to-end behaviour of a surgical run: a package registered inside a larger
// checkout is verified in its own directory, edits outside it are undone,
// reviews see only the change, environment failures stop for the host, and
// correction rounds that stop converging end instead of looping.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenSpecTools } from './openspec.js'
import { runCoreWorkflow, parseAgentObject, type CoreWorkflowOptions } from './core-host.js'
import { ExecutorRegistry } from './executors.js'
import type { AgentRequest, AgentResult, RuntimeConfig } from './executor-types.js'
import { inspectPipeline, type PipelineContext } from '../pipeline/pipeline-state.js'

let root: string, checkout: string, counter: string
let context: PipelineContext
let config: RuntimeConfig
const change = 'surgical-feature'
const usage = { costUsd: 0.1, inputTokens: 20, outputTokens: 10 }
const architecture = {
  proposal: '# Navigation\nFix the app navigation.', design: '# Design\nChange apps/app/code.cjs only.',
  tasks: [{ title: 'Return 2 from apps/app/code.cjs' }],
  specs: [{ name: 'navigation', content: '## ADDED Requirements\n### Requirement: App returns 2\nThe app SHALL return 2.\n#### Scenario: Requested behavior\n- **WHEN** the app is called\n- **THEN** it returns 2.\n' }], confidence: 'high',
}
const approve = {
  approved: true, summary: 'Inspected the change and real verification evidence', issues: [], score: 90,
  aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 },
  acceptance: { criteria: [{ specId: '1', criterionIndex: 0, status: 'met', evidence: ['apps/app/code.cjs returns 2'] }], checks: [], findings: [] },
}
const reject = { ...approve, approved: false, issues: ['apps/app/code.cjs: add an explanatory comment'], score: 60 }
function write(file: string, text: string): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
function git(args: string[]): string {
  const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
const app = (file = 'code.cjs'): string => path.join(checkout, 'apps', 'app', file)
function tick(): void {
  const tasks = path.join(checkout, 'openspec', 'changes', change, 'tasks.md')
  write(tasks, readFileSync(tasks, 'utf8').replaceAll('- [ ]', '- [x]'))
}
function result(value: unknown): AgentResult { return { text: typeof value === 'string' ? value : JSON.stringify(value), usage } }
function summary(files: string[] = ['apps/app/code.cjs'], incomplete: Array<{ task: string; reason: string }> = []) {
  return result({ summary: 'Worked on the change', files, tests: [], verification: 'none', incomplete })
}
/** A fixture engine: real OpenSpec participation, scripted role replies. */
function fake(roles: { developer?: (request: AgentRequest, visit: number) => AgentResult; reviewer?: (visit: number) => unknown } = {}): { registry: ExecutorRegistry; calls: AgentRequest[] } {
  const calls: AgentRequest[] = []
  let developers = 0, reviewers = 0
  return { calls, registry: new ExecutorRegistry().register('fixture', { capabilities: () => ({ transport: 'fixture', continuation: 'unsupported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }), execute: async request => {
    calls.push(request)
    const tools = new OpenSpecTools(request.openspec!)
    await tools.execute({ action: 'load_skill' })
    if (request.role !== 'architect') await tools.execute({ action: 'instructions', artifact: 'apply' })
    if (request.role === 'architect') {
      const output = parseAgentObject(JSON.stringify(architecture))
      await tools.execute({ action: 'new' })
      const files: [string, string, string][] = [['proposal', 'proposal.md', output.proposal as string], ['design', 'design.md', output.design as string], ...architecture.specs.map(item => ['specs', 'specs/' + item.name + '/spec.md', item.content] as [string, string, string]), ['tasks', 'tasks.md', architecture.tasks.map((task, i) => '- [ ] ' + (i + 1) + '. ' + task.title).join('\n') + '\n']]
      for (const [artifact, file, content] of files) {
        await tools.execute({ action: 'instructions', artifact })
        await tools.execute({ action: 'write_artifact', path: file, content })
      }
      return result(architecture)
    }
    if (request.role === 'reviewer') return result(roles.reviewer ? roles.reviewer(++reviewers) : approve)
    developers++
    if (roles.developer) return roles.developer(request, developers)
    write(app(), 'module.exports = 2\n'); tick()
    return summary()
  } }) }
}
function opts(registry: ExecutorRegistry, overrides: Partial<CoreWorkflowOptions> = {}): CoreWorkflowOptions {
  return { context, config, change, registry, ...overrides }
}
/** Host check: runs where Core starts it, records each run, and passes only when the app returns 2 from its own directory. */
function hostCheck(extra = ''): RuntimeConfig['verification'][number] {
  return {
    repositoryId: 'app', command: process.execPath,
    args: ['-e', `require("fs").appendFileSync(${JSON.stringify(counter)}, process.cwd() + "\\n");${extra}const got = require("./code.cjs"); if (got !== 2) { console.error("FAIL navigation: expected 2, got " + got); process.exit(9) } console.log("app checks passed")`],
  }
}
const runs = (): string[] => existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n') : []

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'surgical runtime '))
  checkout = path.join(root, 'monorepo')
  counter = path.join(root, 'verification-runs.log')
  // The checkout root fails its own checks: a run that verifies there is not surgical.
  write(path.join(checkout, 'code.cjs'), 'process.exit(7)\n')
  write(path.join(checkout, '.yarnrc.yml'), 'npmAuthToken: "${NODE_AUTH_TOKEN}"\n')
  write(app(), 'module.exports = 1\n')
  write(path.join(checkout, 'apps', 'other', 'mappings.cjs'), 'module.exports = {}\n')
  spawnSync('git', ['init', '-q', checkout])
  git(['add', '.'])
  git(['-c', 'user.name=Runtime Fixture', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'baseline'])
  const backlogRoot = path.join(root, 'workspace')
  mkdirSync(backlogRoot)
  context = {
    schemaVersion: 1, runId: 'surgical-fixture', backlogRoot, artifactRoot: checkout, artifactRepositoryId: 'app',
    repositories: [{ id: 'app', name: 'app', path: checkout, baseSha: git(['rev-parse', 'HEAD']), scope: ['apps/app'] }],
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [{ id: 1, title: 'App navigation', description: 'Return 2 from the app', repositoryIds: ['app'], acceptanceCriteria: ['The app returns 2'] }],
  }
  config = {
    schemaVersion: 1, enabled: true, providers: [],
    agents: { architect: { provider: 'fixture' }, developer: { provider: 'fixture' }, reviewer: { provider: 'fixture' } },
    verification: [hostCheck()],
    limits: { maxAttempts: 5 },
  }
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('surgical implementation runs', () => {
  it('verifies in the package, undoes edits outside it and reviews only the change', async () => {
    const notes: string[] = []
    const { registry, calls } = fake({ developer: () => {
      write(app(), 'module.exports = 2\n')
      // Unrequested "repairs" outside the package: they must never reach verification, review or delivery.
      write(path.join(checkout, '.yarnrc.yml'), 'npmAuthToken: "${NODE_AUTH_TOKEN:-}"\n')
      write(path.join(checkout, 'apps', 'other', 'mappings.cjs'), 'module.exports = { rewritten: true }\n')
      write(path.join(checkout, 'apps', 'other', 'extra.cjs'), 'module.exports = 3\n')
      tick()
      return summary(['apps/app/code.cjs', '.yarnrc.yml', 'apps/other/mappings.cjs', 'apps/other/extra.cjs'])
    } })
    const state = await runCoreWorkflow(opts(registry, { onAgentEvent: (_role, event) => { if (event.text) notes.push(event.text) } }))
    expect(state.status, state.error).toBe('succeeded')
    expect(runs()).toEqual([realpathSync(path.join(checkout, 'apps', 'app'))])
    expect(readFileSync(path.join(checkout, '.yarnrc.yml'), 'utf8')).toBe('npmAuthToken: "${NODE_AUTH_TOKEN}"\n')
    expect(readFileSync(path.join(checkout, 'apps', 'other', 'mappings.cjs'), 'utf8')).toBe('module.exports = {}\n')
    expect(existsSync(path.join(checkout, 'apps', 'other', 'extra.cjs'))).toBe(false)
    expect(notes.join('\n')).toContain('Undid 3 edits outside the repository scope (apps/app): .yarnrc.yml, apps/other/extra.cjs, apps/other/mappings.cjs')
    const review = calls.find(call => call.role === 'reviewer')!.prompt
    const underReview = review.slice(review.indexOf('## Change under review'), review.indexOf('## Verification result'))
    expect(underReview).toContain('- `apps/app/code.cjs` (modified)')
    expect(underReview).not.toMatch(/yarnrc|apps\/other/)
    expect(review).toContain('Edits outside the repository scope that Core undid (they are not part of the change):\n- `.yarnrc.yml`')
    expect(review).toContain('Files reported as changed:\n- `apps/app/code.cjs`\n\n')
    expect(calls.find(call => call.role === 'developer')!.prompt).toContain('Repository scope: `apps/app/`')
    expect(git(['status', '--porcelain', '--untracked-files=all', '--', '.yarnrc.yml', 'apps/other'])).toBe('')
  })

  it('stops for the host when verification lacks a credential, without a correction round, and continues once it is available', async () => {
    config.verification = [hostCheck('if (!process.env.FIXTURE_AUTH_TOKEN) { console.error("Usage Error: Environment variable not found (FIXTURE_AUTH_TOKEN) in " + process.cwd() + "/.yarnrc.yml"); process.exit(1) }')]
    const { registry, calls } = fake()
    const blocked = await runCoreWorkflow(opts(registry))
    expect(blocked.status).toBe('blocked')
    expect(blocked.nextStep).toBe('verify')
    expect(blocked.error).toContain('FIXTURE_AUTH_TOKEN')
    expect(blocked.error).toContain('no correction round was started')
    expect(calls.filter(call => call.stance === 'fixer')).toHaveLength(0)
    expect(runs()).toHaveLength(1)
    vi.stubEnv('FIXTURE_AUTH_TOKEN', 'granted-by-host')
    const resumed = await runCoreWorkflow(opts(registry, { resume: true }))
    expect(resumed.status, resumed.error).toBe('succeeded')
    expect(calls.filter(call => call.stance === 'fixer')).toHaveLength(0)
  })

  it('stops instead of re-running the same checks when a correction round leaves the failed change as it was', async () => {
    const { registry, calls } = fake({ developer: (_request, visit) => {
      if (visit === 1) { write(app(), 'module.exports = 3\n'); tick(); return summary() }
      return summary([])
    } })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.nextStep).toBe('verify')
    expect(state.error).toContain('left the change exactly as it was')
    expect(state.error).toContain('expected 2, got 3')
    expect(runs()).toHaveLength(1)
    expect(calls.filter(call => call.stance === 'fixer')).toHaveLength(1)
  })

  it('stops when the same failure survives two correction rounds', async () => {
    const { registry, calls } = fake({ developer: (_request, visit) => {
      write(app(), `module.exports = 3 // attempt ${'x'.repeat(visit)}\n`)
      if (visit === 1) tick()
      return summary()
    } })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('survived 2 correction rounds')
    expect(runs()).toHaveLength(3)
    expect(calls.filter(call => call.stance === 'fixer')).toHaveLength(2)
    expect(calls.filter(call => call.stance === 'fixer')[0]!.prompt).toContain('## Change set so far')
  })

  it('stops when a review correction brings back a failure an earlier correction fixed', async () => {
    const { registry, calls } = fake({
      developer: (_request, visit) => {
        if (visit === 1) { write(app(), 'module.exports = 3\n'); tick() }
        if (visit === 2) write(app(), 'module.exports = 2\n')
        if (visit === 3) write(app(), '// explanatory comment\nmodule.exports = 3\n')
        return summary()
      },
      reviewer: () => reject,
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('review correction brought back a verification failure')
    expect(calls.map(call => call.stance === 'fixer' ? 'fixer' : call.role)).toEqual(['architect', 'developer', 'fixer', 'reviewer', 'fixer'])
    expect(inspectPipeline(context).phases.archive.status).toBe('pending')
  })

  it('returns a disputed review to the reviewer without re-running checks, and stops at a second rejection of the same change', async () => {
    const { registry, calls } = fake({
      developer: (_request, visit) => {
        if (visit === 1) { write(app(), 'module.exports = 2\n'); tick() }
        return summary(visit === 1 ? undefined : [])
      },
      reviewer: () => reject,
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('blocked')
    expect(state.error).toContain('the reviewer rejected the same change twice')
    expect(state.error).toContain('add an explanatory comment')
    expect(runs()).toHaveLength(1)
    expect(calls.map(call => call.stance === 'fixer' ? 'fixer' : call.role)).toEqual(['architect', 'developer', 'reviewer', 'fixer', 'reviewer', 'fixer'])
  })

  it('lets the reviewer accept a disputed request on the unchanged, already verified change', async () => {
    const { registry, calls } = fake({
      developer: (_request, visit) => {
        if (visit === 1) { write(app(), 'module.exports = 2\n'); tick() }
        return summary(visit === 1 ? undefined : [])
      },
      reviewer: visit => visit === 1 ? reject : approve,
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(runs()).toHaveLength(1)
    expect(calls.map(call => call.stance === 'fixer' ? 'fixer' : call.role)).toEqual(['architect', 'developer', 'reviewer', 'fixer', 'reviewer'])
    expect(inspectPipeline(context).verification.valid).toBe(true)
  })

  it('grants a fresh convergence window on an explicit resume', async () => {
    const { registry } = fake({ developer: (_request, visit) => {
      if (visit === 1) { write(app(), 'module.exports = 3\n'); tick() }
      if (visit >= 3) write(app(), 'module.exports = 2\n')
      return summary()
    } })
    const blocked = await runCoreWorkflow(opts(registry))
    expect(blocked.error).toContain('left the change exactly as it was')
    const resumed = await runCoreWorkflow(opts(registry, { resume: true }))
    // The resumed verify re-runs the unchanged checks once, then the next correction fixes the change.
    expect(resumed.status, resumed.error).toBe('succeeded')
  })
})
