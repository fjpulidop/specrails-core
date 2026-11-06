import { OpenSpecTools } from '../openspec.js'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { parseAgentObject, type CoreWorkflowOptions } from '../core-host.js'
import { ExecutorRegistry } from '../executors.js'
import { type AgentRequest, type AgentResult, type RuntimeConfig } from '../executor-types.js'
import { pipelineStateDirectory, type PipelineContext, type PipelineState } from '../../pipeline/pipeline-state.js'
import { readWorkflowEnvelope, writeWorkflowEnvelope } from '../durable-store.js'
import type { WorkflowState } from '../workflow-types.js'

/**
 * Shared fixture of the core-host-*.test.ts suites. Vitest runs one file's tests serially, so the
 * suite is split across files to keep `npm test` inside the 15 min verification limit. Importing
 * this module registers the per-test hooks on the importing file.
 */
/**
 * OpenSpec names the archive folder with its own local date, which differs from
 * the journal's UTC date around midnight; locate the change's folder instead.
 */
export function archivedChangeFile(file: string): string {
  const archive = path.join(context.artifactRoot, 'openspec', 'changes', 'archive')
  const folders = readdirSync(archive).filter(name => /^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === change)
  if (folders.length !== 1) throw new Error(`Expected one archived ${change}, found ${folders.join(', ') || 'none'}`)
  return path.join(archive, folders[0]!, file)
}

// Most cases drive one to four real workflows (git, OpenSpec, spawned
// verification). Healthy macos-latest runs take up to ~27 s per case (run
// 39913609133); loaded ones exceeded the 60 s default on cases that pass in
// 15-20 s (runs 39675761584, 39738608562, 39743878063). Windows keeps the
// global 180 s ceiling; explicit per-case budgets below still apply.
vi.setConfig({ testTimeout: process.platform === 'win32' ? 180_000 : 120_000 })

export const legacyFingerprints = JSON.parse(readFileSync(new URL('../__fixtures__/implementation-workflow-fingerprint.json', import.meta.url), 'utf8')) as Array<{ fingerprint: string; attempts: number; compactDeveloper: boolean }>

export let root: string
export let context: PipelineContext
export let config: RuntimeConfig
export const change = 'programmatic-feature'
export const usage = { costUsd: 0.1, inputTokens: 20, outputTokens: 10 }
export const architecture = {
  proposal: '# Feature\nImplement the frozen feature.', design: '# Design\nUpdate both selected repositories.\n## Non-Goals\n- No change outside the two repositories.\n',
  tasks: [{ title: 'Implement the feature and validate both repositories' }],
  specs: [{ name: 'feature', content: '## ADDED Requirements\n### Requirement: Implement shared behavior\nBoth repositories SHALL return 2.\n#### Scenario: Requested behavior\n- **WHEN** the feature is called\n- **THEN** Both repositories return 2.\n' }], confidence: 'high',
}
export const acceptance = { criteria: [{ specId: '7', criterionIndex: 0, status: 'met', evidence: ['code.cjs returns 2 in both repositories'] }], checks: [], findings: [] }
export const review = {
  approved: true, summary: 'Inspected both repositories and real verification evidence', issues: [], score: 90,
  aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 },
  acceptance,
}
export function write(file: string, text: string): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
export function git(repository: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
export function active(file = ''): string { return path.join(context.artifactRoot, 'openspec', 'changes', change, file) }
export function develop(): void {
  for (const repository of context.repositories) write(path.join(repository.path, 'code.cjs'), 'module.exports = 2\n')
  write(active('tasks.md'), readFileSync(active('tasks.md'), 'utf8').replaceAll('- [ ]', '- [x]'))
}
export function result(value: unknown): AgentResult { return { text: typeof value === 'string' ? value : JSON.stringify(value), usage } }
export function fake(execute?: (request: AgentRequest) => Promise<AgentResult>): { registry: ExecutorRegistry; calls: AgentRequest[] } {
  const calls: AgentRequest[] = []
  return { calls, registry: new ExecutorRegistry().register('fixture', { capabilities: () => ({ transport: 'fixture', continuation: 'supported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }), execute: async request => {
    calls.push(request)
    const tools = new OpenSpecTools(request.openspec!)
    await tools.execute({ action: 'load_skill' })
    if (request.role !== 'architect') await tools.execute({ action: 'instructions', artifact: 'apply' })
    const response = execute ? await execute(request) : request.role === 'architect' ? result(architecture) : request.role === 'developer' ? (develop(), result('Implemented and marked completed tasks')) : result(review)
    if (request.role === 'architect') {
      let output: Record<string, unknown>
      try { output = parseAgentObject(response.text) } catch { return response }
      if (typeof output.proposal === 'string' && typeof output.design === 'string') {
        await tools.execute({ action: 'new' })
        const items = output.specs as typeof architecture.specs
        const files: [string, string, string][] = [['proposal', 'proposal.md', output.proposal], ['design', 'design.md', output.design], ...items.map(item => ['specs', 'specs/' + item.name + '/spec.md', item.content] as [string, string, string]), ['tasks', 'tasks.md', (output.tasks as typeof architecture.tasks).map((task, i) => '- [ ] ' + (i + 1) + '. ' + task.title).join('\n') + '\n']]
        for (const [artifact, file, content] of files) {
          await tools.execute({ action: 'instructions', artifact })
          await tools.execute({ action: 'write_artifact', path: file, content })
        }
      }
    }
    return response
  } }) }
}
export function opts(registry: ExecutorRegistry, overrides: Partial<CoreWorkflowOptions> = {}): CoreWorkflowOptions {
  return { context, config, change, registry, ...overrides }
}
/** Edits the durable ledger the way a dead process leaves it: the LangGraph history stays intact. */
export async function patchLedger(mutate: (state: WorkflowState) => void): Promise<void> {
  const directory = path.join(pipelineStateDirectory(context), 'agent-workflow')
  const envelope = (await readWorkflowEnvelope(directory, context.runId))!
  mutate(envelope.state)
  await writeWorkflowEnvelope(directory, envelope)
}
export function journalFile(): PipelineState { return JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'state.json'), 'utf8')) as PipelineState }
export async function interruptAfterArchiveRename(): Promise<string> {
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

