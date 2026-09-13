import ts from 'typescript'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'

it('continues a real v4 request/checkpoint with its original executable without rewriting frozen input', async () => {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
  const fixture = fileURLToPath(new URL('./fixtures/runtime-v4/core.tgz', import.meta.url))
  expect(createHash('sha256').update(readFileSync(fixture)).digest('hex')).toBe('4d0c6496a260c1635cbdccfb991069869dea85475ff9a711e4fb51c352413aa6')
  // Extract beneath the installed dependency tree so Node resolves the pinned
  // original package's dependencies without symlinks or an npm download.
  const extracted = mkdtempSync(path.join(packageRoot, 'node_modules/.legacy-v4-'))
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'legacy workflow ')))
  try {
    execFileSync('tar', ['-xzf', fixture, '-C', extracted])
    const repo = path.join(root, 'repo'), backlog = path.join(root, 'backlog')
    mkdirSync(repo); mkdirSync(backlog)
    for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) execFileSync('git', args, { cwd: repo })
    writeFileSync(path.join(repo, 'README.md'), 'Legacy fixture\n')
    execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: repo })
    const context = { schemaVersion: 1, runId: 'legacy-run', backlogRoot: backlog, artifactRoot: repo, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repo }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: '1', title: 'Clarify behavior', description: 'Show informative alerts', acceptanceCriteria: ['Alerts are informative'] }] }
    const role = { provider: 'fixture', model: 'local' }
    const config = { schemaVersion: 1, enabled: true, providers: [{ id: 'fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }], agents: { architect: role, developer: role, reviewer: role }, verification: [], approvalBeforeArchive: true }
    const contextFile = path.join(backlog, '.specrails/pipeline/legacy-run/desktop-context.json'), configFile = path.join(root, 'config.json')
    mkdirSync(path.dirname(contextFile), { recursive: true })
    writeFileSync(contextFile, JSON.stringify(context)); writeFileSync(configFile, JSON.stringify(config))
    let cli = path.join(extracted, 'package/dist/agent-runtime/cli.js')
    let retainer: { retainAgentRuntime(cli: string, context: string): string; resolveRetainedAgentRuntime(context: string): string } | undefined
    if (process.env.SPECRAILS_EFFICIENCY_DESKTOP_ROOT) {
      const source = readFileSync(path.join(process.env.SPECRAILS_EFFICIENCY_DESKTOP_ROOT, 'server/agent-runtime-package.ts'), 'utf8')
      const helper = path.join(root, 'desktop-retainer.mjs')
      writeFileSync(helper, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText)
      retainer = await import(pathToFileURL(helper).href)
      cli = retainer!.retainAgentRuntime(cli, contextFile)
    }
    const legacy = await import(pathToFileURL(cli).href)
    const openspec = await import(pathToFileURL(path.join(path.dirname(cli), 'openspec.js')).href)
    let call = 0
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      call++
      let reply: unknown = { confidence: 'low', question: 'Are alerts informative?', verification: [] }
      if (call > 1) {
        const body = JSON.parse(String(init?.body))
        const role = /one (architect|developer|reviewer) task/.exec(body.messages[0].content)![1]
        const directory = path.join(backlog, '.specrails/pipeline/legacy-run/agent-workflow')
        const prepared = openspec.prepareOpenSpec(repo, 'legacy-change', directory)
        const tools = new openspec.OpenSpecTools(openspec.roleOpenSpecContext(prepared, repo, 'legacy-change', directory, role, 'claude'))
        await tools.execute({ action: 'load_skill' })
        if (role === 'architect') {
          await tools.execute({ action: 'new' })
          const artifacts = [
            ['proposal', 'proposal.md', '## Why\nInformative alerts.\n## What Changes\nDocument behavior.\n## Capabilities\n### New Capabilities\n- `alerts`: Informative alerts.\n## Impact\nREADME.\n'],
            ['design', 'design.md', '## Context\nAlerts are informative.\n## Decisions\nDocument their behavior.\n'],
            ['specs', 'specs/alerts/spec.md', '## ADDED Requirements\n### Requirement: Informative alerts\nAlerts SHALL be informative.\n#### Scenario: Viewing an alert\n- **WHEN** an alert is visible\n- **THEN** saving remains available\n'],
            ['tasks', 'tasks.md', '## 1. Documentation\n- [ ] 1.1 Document informative alerts\n'],
          ]
          for (const [artifact, file, content] of artifacts) {
            await tools.execute({ action: 'instructions', artifact })
            await tools.execute({ action: 'write_artifact', path: file, content })
          }
          reply = { confidence: 'high', verification: [] }
        } else if (role === 'developer') {
          writeFileSync(path.join(repo, 'README.md'), 'Alerts are informative and never block saving.\n')
          const tasks = path.join(repo, 'openspec/changes/legacy-change/tasks.md')
          writeFileSync(tasks, readFileSync(tasks, 'utf8').replace('- [ ]', '- [x]'))
          reply = { summary: 'Documented informative alerts', files: ['README.md'], tests: [], incomplete: [] }
        } else {
          reply = { approved: true, summary: 'README satisfies the documented requirement', issues: [], score: 90, aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 }, acceptance: { criteria: [{ specId: '1', criterionIndex: 0, status: 'met', evidence: ['README.md: alerts never block saving'] }], checks: [], findings: [] } }
        }
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const messages: Array<Record<string, unknown>> = []
    const emit = (value: Record<string, unknown>) => messages.push(value)
    const started = await legacy.runRuntimeCommand({ context: contextFile, config: configFile, change: 'legacy-change' }, ['run'], emit)
    expect(started, JSON.stringify(messages.at(-1))).toBe(2)
    const stateRoot = path.join(backlog, '.specrails/pipeline/legacy-run')
    const request = path.join(stateRoot, 'agent-runtime-request.json')
    const frozen = readFileSync(request, 'utf8')
    expect(JSON.parse(frozen)).not.toHaveProperty('runtimeIdentity')
    const before = JSON.parse(readFileSync(path.join(stateRoot, 'agent-workflow/legacy-run/checkpoint.json'), 'utf8'))
    expect(before.state.workflowVersion).toBe('4')
    if (retainer) {
      rmSync(path.join(extracted, 'package'), { recursive: true })
      expect(retainer.resolveRetainedAgentRuntime(contextFile)).toBe(cli)
    }
    const resumed = await legacy.runRuntimeCommand({ context: contextFile, answer: 'Informative only' }, ['resume'], emit)
    expect(resumed, JSON.stringify(messages.at(-1))).toBe(2)
    expect(readFileSync(request, 'utf8')).toBe(frozen)
    const after = JSON.parse(readFileSync(path.join(stateRoot, 'agent-workflow/legacy-run/checkpoint.json'), 'utf8'))
    expect(after.state.inputFingerprint).toBe(before.state.inputFingerprint)
    expect(after.state.workflowFingerprint).toBe(before.state.workflowFingerprint)
    expect(after.state.history.length).toBeGreaterThan(before.state.history.length)
    expect(messages.at(-1)).toMatchObject({ pendingApproval: { stepId: 'archive' } })
    expect(fetch).toHaveBeenCalledTimes(4)
  } finally {
    vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); rmSync(extracted, { recursive: true, force: true })
  }
}, 120_000)
