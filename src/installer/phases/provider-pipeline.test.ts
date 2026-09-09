import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as yaml } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { scaffoldInstallation, geminiAgentLimitMetadata } from './scaffold.js'

const scriptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function write(file: string, value: string | object): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}

describe('installed provider pipeline fixtures', () => {
  it.each(['codex', 'gemini', 'kimi'] as const)('%s artifacts execute one aggregate journal and preserve scope through review retry', (provider) => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'specrails-provider-contract-')); temporary.push(home)
    const repo = path.join(home, 'code'), second = path.join(home, 'api'), workspace = path.join(home, 'workspace')
    for (const root of [repo, second]) {
      mkdirSync(root, { recursive: true })
      execFileSync('git', ['init', '-q', root])
      write(path.join(root, 'index.txt'), 'baseline')
      execFileSync('git', ['-C', root, 'add', '.'])
      execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'])
    }
    const providerDir = provider === 'kimi' ? '.kimi-code' : '.' + provider
    scaffoldInstallation({ scriptDir, codeRoot: repo, artifactRoot: workspace, provider, providerDir, seedProjectDirs: false })
    const workflow = provider === 'gemini'
      ? path.join(workspace, providerDir, 'commands', 'specrails', 'batch-implement.toml')
      : path.join(workspace, providerDir, 'skills', provider === 'kimi' ? 'specrails-batch-implement' : 'batch-implement', 'SKILL.md')
    const emitted = readFileSync(workflow, 'utf8')
    expect(emitted).toContain('Executable pipeline contract')
    expect(emitted).toContain('archive-check')
    if (provider === 'gemini') {
      const role = readFileSync(path.join(workspace, providerDir, 'agents', 'sr-developer.md'), 'utf8')
      const metadata = yaml(role.split('---')[1]!) as { tools: string[] }
      expect(metadata.tools).toContain('activate_skill')
      expect(readFileSync(path.join(workspace, providerDir, 'commands', 'specrails', 'retry.toml'), 'utf8')).toContain('invoke_agent(agent_name, prompt)')
    }
    const backlog = { tickets: { '1': { status: 'todo' }, '2': { status: 'todo' } } }
    write(path.join(workspace, '.specrails', 'local-tickets.json'), backlog)
    const context = { schemaVersion: 1, runId: provider + '-aggregate', backlogRoot: workspace,
      artifactRoot: repo, artifactRepositoryId: 'web',
      repositories: [{ id: 'web', name: 'Web', path: repo }, { id: 'api', name: 'API', path: second }],
      specs: [{ id: 1, title: 'Web', description: 'Frozen web criteria', repositoryIds: ['web'] }, { id: 2, title: 'API', description: 'Frozen API criteria', repositoryIds: ['api'] }],
      ownership: { git: 'host', backlog: 'host', worktrees: 'host' } }
    const contextFile = path.join(workspace, 'context.json'); write(contextFile, context)
    const runtime = path.join(workspace, '.specrails', 'runtime', 'pipeline.mjs')
    const call = (...args: string[]) => spawnSync(process.execPath, [runtime, ...args, '--context', contextFile], { cwd: workspace, encoding: 'utf8' })
    expect(call('init', '--change', 'aggregate-change').status).toBe(0)
    expect(call('phase', '--phase', 'architect', '--status', 'done').status).toBe(1)
    const change = path.join(repo, 'openspec', 'changes', 'aggregate-change')
    write(path.join(change, 'proposal.md'), 'Both frozen specs')
    write(path.join(change, 'design.md'), 'Both repositories')
    write(path.join(change, 'specs', 'aggregate', 'spec.md'), '## ADDED Requirements\n### Requirement: Complete both frozen specs\nThe system SHALL implement both repositories.\n#### Scenario: Aggregate candidate\n- **WHEN** the batch completes\n- **THEN** web and API satisfy their frozen criteria\n')
    write(path.join(change, 'tasks.md'), '- [ ] Web\n- [ ] API\n')
    write(path.join(change, 'design-confidence.json'), { confidence: 'high' })
    expect(call('phase', '--phase', 'architect', '--status', 'done').status).toBe(0)
    for (const root of [repo, second]) write(path.join(root, 'index.txt'), 'implemented')
    write(path.join(change, 'tasks.md'), '- [x] Web\n- [x] API\n')
    const request = path.join(workspace, 'verify.json')
    write(request, { kind: 'full', commands: ['web', 'api'].map(repositoryId => ({ repositoryId, command: process.execPath, args: ['-e', "if(require('fs').readFileSync('index.txt','utf8')!=='implemented')process.exit(1)"] })) })
    const verification = call('verify', '--request', request)
    expect(verification.status, verification.stderr).toBe(0)
    const developer = call('phase', '--phase', 'developer', '--status', 'done')
    expect(developer.status, developer.stderr).toBe(0)
    expect(call('phase', '--phase', 'reviewer', '--status', 'failed', '--reason', 'Need semantic review').status).toBe(0)
    const resumed = JSON.parse(call('status').stdout)
    expect(resumed.resumePhase).toBe('reviewer')
    expect(resumed.context.specs).toEqual(context.specs)
    expect(resumed.phases.developer.status).toBe('done')
    expect(call('archive-check').status).toBe(1)
    write(path.join(change, 'confidence-score.json'), { change: 'aggregate-change', overall: 90, aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 } })
    const acceptanceFile = path.join(workspace, 'acceptance.json')
    write(acceptanceFile, { criteria: context.specs.map(spec => ({ specId: String(spec.id), criterionIndex: 0, requirement: spec.description, status: 'met', evidence: ['index.txt and executed verification command'] })), checks: [], findings: [] })
    expect(call('acceptance', '--request', acceptanceFile).status).toBe(0)
    expect(call('phase', '--phase', 'reviewer', '--status', 'done').status).toBe(0)
    expect(call('archive-check').status).toBe(0)
    const archive = path.join(repo, 'openspec', 'changes', 'archive', '2026-09-06-aggregate-change')
    mkdirSync(path.dirname(archive), { recursive: true }); renameSync(change, archive)
    const closed = call('phase', '--phase', 'archive', '--status', 'done')
    expect(closed.status, closed.stderr).toBe(0)
    expect(JSON.parse(readFileSync(path.join(workspace, '.specrails', 'local-tickets.json'), 'utf8'))).toEqual(backlog)
  })
  it('fails before artifact mutations when a declared runtime is missing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'specrails-missing-runtime-')); temporary.push(dir)
    const source = path.join(dir, 'package'), workspace = path.join(dir, 'workspace')
    write(path.join(source, 'integration-contract.json'), { execution: { runtime: '.specrails/runtime/pipeline.mjs' } })
    expect(() => scaffoldInstallation({ scriptDir: source, codeRoot: dir, artifactRoot: workspace, provider: 'codex', providerDir: '.codex' })).toThrow('compiled module is missing')
    expect(() => readFileSync(path.join(workspace, '.codex', 'skills', 'implement', 'SKILL.md'))).toThrow()
  })
  it('opts into turn metadata only for a verified loader capability', () => {
    expect(geminiAgentLimitMetadata({})).toEqual([])
    expect(geminiAgentLimitMetadata({ SPECRAILS_GEMINI_MAX_TURNS: '80' })).toEqual([])
    expect(geminiAgentLimitMetadata({ SPECRAILS_GEMINI_AGENT_LIMITS: 'supported', SPECRAILS_GEMINI_MAX_TURNS: '80' })).toEqual(['max_turns: 80'])
    expect(() => geminiAgentLimitMetadata({ SPECRAILS_GEMINI_AGENT_LIMITS: 'supported', SPECRAILS_GEMINI_MAX_TURNS: '0' })).toThrow('1 to 200')
  })
})
