import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pipelineStateDirectory, validatePipelineContext, type PipelineContext } from '../../../pipeline/pipeline-state.js'
import { resolveRoleDescriptor, validateRuntimeConfig } from '../../config.js'
import type { AgentRequest, AgentResult, RuntimeConfig } from '../../executor-types.js'
import { ExecutorRegistry } from '../../executors.js'
import { OpenSpecTools } from '../../openspec.js'
import { roleInstructions } from '../../prompts.js'
import { RunDatabase } from '../checkpoint/database.js'
import { validateWorkflowDefinition } from '../definition-validator.js'
import { configuredRoles } from '../preflight.js'
import { createRun, definitionRunDirectory } from '../runs.js'
import { DERIVATION_FILE, DERIVE_SUMMARY_LIMIT, readDeriveSummary } from './derive-change.js'
import { validationPieceRegistry } from './index.js'

// The reference definition starts the real pinned OpenSpec CLI several times.
const integrationTimeout = process.platform === 'win32' ? 180_000 : 60_000
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const change = 'flow-change'
const usage = { inputTokens: 10, outputTokens: 5, costUsd: null }
const CHANGED = ['src/value.cjs', 'src/value.test.cjs', 'docs/flow guide.md', 'src/añadido.cjs', 'README.md']
const VALID_SPEC = '## ADDED Requirements\n### Requirement: Return two\nThe module SHALL export two.\n#### Scenario: Load the module\n- **WHEN** src/value.cjs is loaded\n- **THEN** its value is two\n'

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}
function write(file: string, content: string): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content) }

/** A worktree reserved at `base`, with Flow's work committed on top (five changed files) unless `empty`. */
function workspace(options: { empty?: boolean; summary?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'derive change ')); roots.push(root)
  const repository = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlog)
  git(repository, 'init', '-q')
  write(path.join(repository, 'src/value.cjs'), 'module.exports = 1\n')
  write(path.join(repository, 'README.md'), '# Value\n')
  git(repository, 'add', '-A'); git(repository, 'commit', '-qm', 'base')
  const base = git(repository, 'rev-parse', 'HEAD')
  if (!options.empty) {
    write(path.join(repository, 'src/value.cjs'), 'module.exports = 2\n')
    write(path.join(repository, 'src/value.test.cjs'), 'if (require("./value.cjs") !== 2) process.exit(1)\n')
    write(path.join(repository, 'docs/flow guide.md'), '# Flow\n')
    write(path.join(repository, 'src/añadido.cjs'), 'module.exports = "nuevo"\n')
    write(path.join(repository, 'README.md'), '# Value\nNow two.\n')
    git(repository, 'add', '-A'); git(repository, 'commit', '-qm', 'flow work')
  }
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'flow-run', backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo',
    repositories: [{ id: 'repo', name: 'Repo', path: repository, baseSha: base }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [{ id: 7, title: 'Return two', description: 'value.cjs exports two (Flow placeholder spec)' }] })
  if (options.summary !== undefined) write(path.join(pipelineStateDirectory(context), 'flow-summary.md'), options.summary)
  return { repository, context, base, head: git(repository, 'rev-parse', 'HEAD') }
}

const role = { provider: 'fixture' }
const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [] }
const proposal = { repositoryId: 'repo', command: process.execPath, args: ['src/value.test.cjs'] }

interface DeriverScript { radius?: string[]; spec?: string; tasks?: string; confidence?: string }
/** A provider that performs the deriver's OpenSpec workflow through the scoped tools, and a reviewer that rejects unexplained files. */
function fixture(scripts: DeriverScript[]) {
  const requests: AgentRequest[] = []
  let derivations = 0
  const registry = new ExecutorRegistry().register('fixture', { async execute(request): Promise<AgentResult> {
    requests.push(request)
    const tools = new OpenSpecTools(request.openspec!)
    if (request.role === 'reviewer') {
      const unexplained = /## Derivation coverage[\s\S]*?Rule: every unexplained file/.test(request.prompt)
      return { text: JSON.stringify({ approved: !unexplained, issues: unexplained ? ['Explain or revert the unexplained file'] : [] }), usage }
    }
    expect(request).toMatchObject({ role: 'deriver', access: 'read', artifacts: 'all' })
    const script = scripts[Math.min(derivations++, scripts.length - 1)]!
    await tools.execute({ action: 'load_skill' })
    await tools.execute({ action: 'new' })
    const artifacts: Array<[string, string, string]> = [
      ['proposal', 'proposal.md', '## Why\nFlow produced this code.\n## What Changes\nThe module exports two.\n## Capabilities\n### New Capabilities\n- value: Return two.\n## Impact\nOne module.\n'],
      ['design', 'design.md', '## Context\nDerived from the diff.\n## Blast radius\n' + (script.radius ?? CHANGED).map(file => `- \`${file}\`: changed by Flow`).join('\n') + '\n## Rejected alternatives\nNone recorded.\n## Non-Goals\n- None.\n## Assumptions\n- None.\n'],
      ['specs', 'specs/value/spec.md', script.spec ?? VALID_SPEC],
      ['tasks', 'tasks.md', script.tasks ?? '- [x] 1. Export two\n  - Evidence: src/value.cjs, src/value.test.cjs\n- [x] 2. Document the flow\n  - Evidence: docs/flow guide.md, README.md (no test)\n'],
    ]
    for (const [artifact, file, content] of artifacts) {
      await tools.execute({ action: 'instructions', artifact })
      await tools.execute({ action: 'write_artifact', path: file, content })
    }
    return { text: JSON.stringify({ confidence: script.confidence ?? 'high', verification: [proposal] }), usage }
  } })
  return { registry, requests }
}

function definition() { return JSON.parse(readFileSync(new URL('../__fixtures__/flow-spec.json', import.meta.url), 'utf8')) }
async function attempts(context: PipelineContext): Promise<Array<{ node: string; status: string; output: unknown }>> {
  const database = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite'))
  try {
    return database.sqlite.prepare('SELECT node_path, status, output_json FROM attempts ORDER BY started_at, rowid').all()
      .map(row => ({ node: String(row.node_path), status: String(row.status), output: row.output_json ? (JSON.parse(String(row.output_json)) as { output?: unknown }).output : undefined }))
  } finally { database.close() }
}
function derivationOf(output: unknown) { return (output as { derivation: Record<string, unknown>; derivationPath: string }) }

describe('derive-change through the flow-spec reference definition', () => {
  it('derives a fully explained diff (5 of 5), binds the deriver plan, reviews and archives with receipts', async () => {
    const { repository, context, base, head } = workspace({ summary: '---\ntranscriptTurns: 7\n---\nThe user asked for the module to export two.\n' })
    const { registry, requests } = fixture([{}])
    const result = await createRun({ context, config, definition: definition(), registry, change })
    expect(result, JSON.stringify(result)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
    expect(requests.map(request => request.role)).toEqual(['deriver', 'reviewer'])

    const deriver = requests[0]!.prompt
    expect(deriver).toContain('## Your task: deriver')
    expect(deriver).toContain('describe what EXISTS in the diff')
    expect(deriver).toContain('The user asked for the module to export two.')
    expect(deriver).toContain('`docs/flow guide.md` (added)')
    expect(deriver).toContain('Return two')
    expect(deriver).toContain(base)

    const rows = await attempts(context)
    const derived = derivationOf(rows.find(row => row.node === 'derive')!.output)
    expect(derived.derivation).toEqual({ schemaVersion: 1, change, base, head, files: 5, explained: 5, unexplainedFiles: [], tasks: 2, requirementsAdded: 1, requirementsModified: 0,
      confidence: 'high', transcriptTurnsUsed: 7, repositories: [{ repositoryId: 'repo', base, head, files: 5 }] })
    expect(JSON.parse(readFileSync(derived.derivationPath, 'utf8'))).toEqual(derived.derivation)
    expect(path.basename(derived.derivationPath)).toBe(DERIVATION_FILE)
    expect(derived.derivationPath.startsWith(pipelineStateDirectory(context))).toBe(true)
    // The deriver's verification proposal is the bound host plan of both verify nodes.
    for (const node of ['check', 'verify']) {
      const output = rows.find(row => row.node === node && row.status === 'succeeded')!.output as { commands?: Array<{ args: string[] }> }
      expect(JSON.stringify(output)).toContain('src/value.test.cjs')
    }
    expect(requests[1]!.prompt).toContain('## Derivation coverage')
    expect(requests[1]!.prompt).toContain('5 of 5 changed files are explained')
    expect(rows.filter(row => ['check', 'verify'].includes(row.node) && row.status === 'succeeded')).toHaveLength(2)
    expect(existsSync(path.join(repository, 'openspec/changes', change))).toBe(false)
    expect(readdirSync(path.join(repository, 'openspec/changes/archive')).filter(name => name.endsWith('-' + change))).toHaveLength(1)
    expect(existsSync(path.join(pipelineStateDirectory(context), 'state.json'))).toBe(false)
    const database = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite'))
    try {
      expect(database.sqlite.prepare('SELECT count(*) count FROM receipts WHERE valid=1').get()?.count).toBeGreaterThanOrEqual(2)
      expect(database.sqlite.prepare("SELECT role FROM invocations ORDER BY started_at").all().map(row => row.role)).toEqual(['deriver', 'reviewer'])
    } finally { database.close() }
  }, integrationTimeout)

  it('reports an unexplained file to the reviewer, who blocks the archive', async () => {
    const { repository, context } = workspace()
    const { registry, requests } = fixture([{ radius: CHANGED.filter(file => file !== 'src/añadido.cjs'), confidence: 'medium' }])
    const result = await createRun({ context, config, definition: definition(), registry, change })
    expect(result.state.status).toBe('failed')
    const derived = derivationOf((await attempts(context)).find(row => row.node === 'derive')!.output)
    expect(derived.derivation).toMatchObject({ files: 5, explained: 4, unexplainedFiles: ['src/añadido.cjs'], confidence: 'medium', transcriptTurnsUsed: 0 })
    const review = requests.find(request => request.role === 'reviewer')!.prompt
    expect(review).toContain('Rule: every unexplained file below is an issue')
    expect(review).toContain('- `src/añadido.cjs`')
    expect(existsSync(path.join(repository, 'openspec/changes', change))).toBe(true)
  }, integrationTimeout)

  it('derives from the diff alone when the summary file is absent or empty', async () => {
    for (const summary of [undefined, '']) {
      const { context } = workspace({ ...(summary === undefined ? {} : { summary }) })
      const { registry, requests } = fixture([{}])
      const result = await createRun({ context, config, definition: definition(), registry, change })
      expect(result.state.status).toBe('succeeded')
      expect(requests[0]!.prompt).toContain('No conversation summary was provided')
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    }
  }, integrationTimeout * 2)

  it('fails before any provider call when nothing differs from the base', async () => {
    const { context } = workspace({ empty: true })
    const { registry, requests } = fixture([{}])
    const result = await createRun({ context, config, definition: definition(), registry, change })
    expect(result.state.status).toBe('failed')
    expect(JSON.stringify(result)).toContain('empty_change_set')
    expect(requests).toHaveLength(0)
  }, integrationTimeout)

  it('returns fail with a repair note, then accepts the repaired derivation in the same session', async () => {
    const { context } = workspace()
    const { registry, requests } = fixture([{ spec: '## ADDED Requirements\n### Requirement: Return two\nThe module SHALL export two.\n', tasks: '- [x] 1. Export two\n- [ ] 2. Document the flow\n' }, {}])
    const result = await createRun({ context, config, definition: definition(), registry, change })
    expect(result, JSON.stringify(result)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
    expect(requests.map(request => request.role)).toEqual(['deriver', 'deriver', 'reviewer'])
    const rows = (await attempts(context)).filter(row => row.node === 'derive')
    const rejected = rows[0]!.output as { reason: string; problems: string[]; repair: string }
    expect(rejected.reason).toBe('derivation_invalid')
    expect(rejected.problems.join('\n')).toMatch(/Unchecked: "2\. Document the flow"/)
    expect(rejected.problems.join('\n')).toMatch(/OpenSpec validation failed/)
    expect(requests[1]!.prompt).toContain('## Previous derivation was rejected')
    expect(requests[1]!.prompt).toContain('Document the flow')
  }, integrationTimeout)

  it('stops after the single repair when the derivation stays invalid', async () => {
    const { context } = workspace()
    const { registry, requests } = fixture([{ tasks: '- [ ] 1. Export two\n' }])
    const result = await createRun({ context, config, definition: definition(), registry, change })
    expect(result.state.status).toBe('failed')
    expect(requests.map(request => request.role)).toEqual(['deriver', 'deriver'])
  }, integrationTimeout)
})

describe('derive-change admission', () => {
  it('rejects summary paths outside the run directory, symlinks and oversized files', () => {
    const { context } = workspace({ summary: 'ok' })
    const directory = pipelineStateDirectory(context)
    expect(readDeriveSummary(context, 'flow-summary.md')).toBe('ok')
    expect(readDeriveSummary(context, undefined)).toBe('')
    expect(readDeriveSummary(context, 'missing.md')).toBe('')
    for (const escape of ['../flow-summary.md', '../../secrets.txt', path.join(directory, 'flow-summary.md'), 'nested/../flow-summary.md']) expect(() => readDeriveSummary(context, escape)).toThrow(/summaryPath/)
    writeFileSync(path.join(context.backlogRoot, 'outside.md'), 'secret')
    symlinkSync(path.join(context.backlogRoot, 'outside.md'), path.join(directory, 'linked.md'))
    expect(() => readDeriveSummary(context, 'linked.md')).toThrow(/summaryPath/)
    writeFileSync(path.join(directory, 'large.md'), 'x'.repeat(DERIVE_SUMMARY_LIMIT + 1))
    expect(() => readDeriveSummary(context, 'large.md')).toThrow(/exceeds/)
    mkdirSync(path.join(directory, 'folder.md'))
    expect(() => readDeriveSummary(context, 'folder.md')).toThrow(/regular file/)
  })

  it('validates params and requires the deriver role in the definition', () => {
    const registry = validationPieceRegistry(), roles = { deriver: { access: 'read' }, reviewer: { access: 'read' } } as const
    const base = definition()
    delete base.version
    for (const summaryPath of ['../escape.md', '/abs/summary.md', 'a/./b.md', 'C:\\summary.md']) {
      const draft = structuredClone(base); draft.nodes.derive.params.summaryPath = summaryPath
      expect(validateWorkflowDefinition(draft, registry, roles), summaryPath).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'invalid_piece_params', path: '/nodes/derive/params/summaryPath' })] })
    }
    const extra = structuredClone(base); extra.nodes.derive.params.headRef = 'HEAD'
    expect(validateWorkflowDefinition(extra, registry, roles).ok).toBe(false)
    const undeclared = structuredClone(base); undeclared.roles = ['reviewer']
    expect(validateWorkflowDefinition(undeclared, registry, roles)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'role_undeclared', path: '/nodes/derive' })]) })
    expect(validateWorkflowDefinition(base, registry, roles).ok).toBe(true)
  })

  it('resolves deriver as a Core engine role on the architect assignment, reserved for configuration', () => {
    const configured = validateRuntimeConfig({ ...config, agents: { ...config.agents, architect: { provider: 'fixture', model: 'm1' } } }, { registeredProviderIds: ['fixture'] })
    expect(resolveRoleDescriptor(configured, 'deriver')).toEqual({ provider: 'fixture', model: 'm1', access: 'read', artifacts: 'all', openspecSkill: 'openspec-ff-change', id: 'deriver' })
    expect(configuredRoles(configured)).toMatchObject({ deriver: { access: 'read' } })
    expect(() => validateRuntimeConfig({ ...config, roles: { deriver: { provider: 'fixture', access: 'read', artifacts: 'all' } } }, { registeredProviderIds: ['fixture'] })).toThrow(/reserved/)
    const { context } = workspace()
    const instructions = roleInstructions(resolveRoleDescriptor(configured, 'deriver'), context, change)
    expect(instructions).toContain('## Blast radius')
    expect(instructions).toContain('Rejected alternatives')
    expect(instructions).toContain('"confidence":"high|medium|low"')
    const review = roleInstructions('reviewer', context, change, { derivation: { files: 3, explained: 2, unexplainedFiles: ['src/x.ts'], confidence: 'low' } })
    expect(review).toContain('2 of 3 changed files are explained; deriver confidence low')
    expect(review).toContain('- `src/x.ts`')
    expect(roleInstructions('reviewer', context, change)).not.toContain('## Derivation coverage')
  })
})
