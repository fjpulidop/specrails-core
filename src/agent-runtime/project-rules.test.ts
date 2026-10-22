import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PipelineContext } from '../pipeline/pipeline-state.js'
import { unknownUsage, type AgentExecutor, type AgentRequest } from './executor-types.js'
import { roleInstructions } from './prompts.js'
import {
  RULES_FILE, applyClassification, classificationPrompt, collectRuleStatements, discoverGates, parseJsonc, parseRuleStatements,
  projectRulesContext, readRulesInventory, ruleId, runRulesCommand, runRulesInventory, workflowRunCommands, type ProjectRule,
} from './project-rules.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rules-'))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
  return root
}
const CONFIG = JSON.stringify({ schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }], agents: { architect: { provider: 'claude', model: 'opus' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } }, verification: [] })
const AGENTS = [
  '# Working here',
  '',
  'Intro paragraph that only describes the project.',
  '',
  '## Behavior that must remain intact',
  '',
  '- Frontend API calls use getApiBase() for every request',
  '- Desktop /api routes mount before /api/projects routes and',
  '  keep their response shapes.',
  '- App settings are a modal; project settings are a route.',
  '',
  '| Concern | Entry |',
  '| --- | --- |',
  '| You must ignore tables | x |',
  '',
  '```sh',
  '- never parse code fences as rules',
  '```',
  '',
  '<!-- specrails-managed:start -->',
  '- Do not start another implement workflow inside a role.',
  '<!-- specrails-managed:end -->',
  '',
  '## Links',
  '',
  '- [Architecture](docs/architecture.md)',
  '',
  'Commits are conventional. Never lower coverage thresholds to pass a change.',
  '',
].join('\n')

function fakeExecutor(reply: (request: AgentRequest) => Record<string, unknown> | string, calls: AgentRequest[] = []): AgentExecutor {
  return {
    async execute(request) {
      calls.push(request)
      const value = reply(request)
      return typeof value === 'string'
        ? { text: value, usage: unknownUsage() }
        : { text: JSON.stringify(value), structured: value, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 } }
    },
  }
}
const idsIn = (request: AgentRequest): string[] => [...request.prompt.matchAll(/^- (r-[0-9a-f]{12}):/gm)].map(match => match[1]!)

describe('gate discovery', () => {
  it('finds scripts, configs, strict TypeScript, architecture tests, hooks, CI steps and OpenSpec', () => {
    const root = tree({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run', build: 'tsc', 'format:check': 'prettier --check .' }, devDependencies: { vitest: '1' } }),
      'pnpm-lock.yaml': '',
      'eslint.config.js': 'export default []',
      '.prettierrc': '{}',
      'tsconfig.json': '{\n  // strict on\n  "compilerOptions": { "strict": true, },\n}',
      'server/modules/architecture.test.ts': '',
      'node_modules/pkg/architecture.test.ts': '',
      '.husky/pre-commit': '#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\nnpx lint-staged\n',
      '.github/workflows/release.yml': 'on: workflow_dispatch\njobs:\n  r:\n    steps:\n      - run: npm run release:check\n',
      '.github/workflows/ci.yml': 'on:\n  pull_request:\njobs:\n  test:\n    steps:\n      - run: pnpm install\n      - run: |\n          pnpm run lint\n          pnpm test -- --coverage\n      - name: Deploy\n        run: echo ${{ secrets.X }} check\n      - run: >-\n          npx vitest run\n          src/a.test.ts\n\n          npm run typecheck\n      - run: ./x || { echo failed check; exit 1; }\n',
      'openspec/project.md': '',
    })
    const gates = discoverGates(root)
    const byId = Object.fromEntries(gates.map(gate => [gate.id, gate]))
    expect(byId.lint).toEqual({ id: 'lint', kind: 'lint', command: 'pnpm run lint', source: 'package.json' })
    expect(byId.test).toMatchObject({ kind: 'test', command: 'pnpm run test' })
    expect(byId['format-check']).toMatchObject({ kind: 'format', command: 'pnpm run format:check' })
    expect(byId.eslint).toBeUndefined() // the lint script already runs it
    expect(byId.prettier).toBeUndefined()
    expect(byId['tsc-strict']).toMatchObject({ kind: 'typecheck', command: 'npx tsc --noEmit', source: 'tsconfig.json' })
    expect(byId['architecture-tests']).toMatchObject({ kind: 'architecture', command: 'npx vitest run server/modules/architecture.test.ts' })
    expect(gates.filter(gate => gate.kind === 'architecture')).toHaveLength(1)
    expect(byId['hook-pre-commit']).toMatchObject({ kind: 'hook', command: 'npx lint-staged', source: '.husky/pre-commit' })
    expect(gates.filter(gate => gate.kind === 'ci').map(gate => gate.command)).toEqual(['pnpm test -- --coverage', 'npx vitest run src/a.test.ts', 'npm run typecheck'])
    expect(byId['openspec-validate']).toMatchObject({ kind: 'spec', source: 'openspec/' })
    expect(new Set(gates.map(gate => gate.id)).size).toBe(gates.length)
  })

  it('falls back to tool configs and ignores a non-strict tsconfig', () => {
    const root = tree({
      'eslint.config.mjs': '', 'biome.json': '{}', '.prettierrc.json': '{}', 'tsconfig.json': '{"compilerOptions":{"strict":false}}',
      'pyproject.toml': '[tool.ruff]\n[tool.black]\n[tool.mypy]\n', '.golangci.yml': '', 'Cargo.toml': '', 'rustfmt.toml': '', 'clippy.toml': '',
      '.rubocop.yml': '', '.pre-commit-config.yaml': '', 'lefthook.yml': '', '.dependency-cruiser.js': '', 'tests/test_architecture.py': '',
      '.githooks/pre-push': 'cargo test\n', '.githooks/commit-msg': 'MSG=$1\nif ! grep -q x \"$MSG\"; then\n  exit 1\nfi\n', 'yarn.lock': '', 'package.json': '{"scripts":{"typecheck":"tsc"}}',
    })
    const ids = discoverGates(root).map(gate => `${gate.id}=${gate.command}`)
    expect(ids).toEqual(expect.arrayContaining([
      'typecheck=yarn run typecheck', 'eslint=npx eslint .', 'biome=npx biome check .', 'prettier=npx prettier --check .', 'ruff=ruff check .',
      'black=black --check .', 'mypy=mypy .', 'golangci-lint=golangci-lint run', 'rustfmt=cargo fmt --check', 'clippy=cargo clippy -- -D warnings',
      'rubocop=bundle exec rubocop', 'architecture-tests=pytest tests/test_architecture.py', 'dependency-cruiser=npx depcruise --config .dependency-cruiser.js .',
      'hook-pre-push=cargo test', 'hook-commit-msg=sh .githooks/commit-msg', 'pre-commit=pre-commit run --all-files', 'lefthook=npx lefthook run pre-commit',
    ]))
    expect(ids.some(id => id.startsWith('tsc-strict'))).toBe(false)
    expect(discoverGates(tree({ 'package.json': '{broken' }))).toEqual([])
  })

  it('parses JSONC and workflow run steps', () => {
    expect(parseJsonc('{"a": "x // not a comment", /* c */ "b": [1,],}')).toEqual({ a: 'x // not a comment', b: [1] })
    expect(workflowRunCommands('steps:\n  - run: "npm test"\n  - run: >-\n      npm run\n  - uses: x\n    with:\n      run: no')).toEqual(['npm test', 'npm run', 'no'])
  })
})

describe('rule statements', () => {
  it('reads list items with continuations and strong sentences, never fences, tables, managed blocks or links', () => {
    const rules = parseRuleStatements(AGENTS, 'AGENTS.md')
    expect(rules).toEqual([
      { text: 'Frontend API calls use getApiBase() for every request', source: 'AGENTS.md:7' },
      { text: 'Desktop /api routes mount before /api/projects routes and keep their response shapes.', source: 'AGENTS.md:8' },
      { text: 'App settings are a modal; project settings are a route.', source: 'AGENTS.md:10' },
      { text: 'Never lower coverage thresholds to pass a change.', source: 'AGENTS.md:28' },
    ])
  })

  it('collects every instruction file with stable ids and no duplicates', () => {
    const root = tree({ 'AGENTS.md': AGENTS, 'CLAUDE.md': '## Conventions\n\n- Keep tests next to their subject file.\n- Keep tests next to their subject file.\n', '.github/CONTRIBUTING.md': 'You must sign off every commit with DCO.\n' })
    const rules = collectRuleStatements(root)
    expect(rules.map(rule => rule.source)).toEqual(['CLAUDE.md:3', 'AGENTS.md:7', 'AGENTS.md:8', 'AGENTS.md:10', 'AGENTS.md:28', '.github/CONTRIBUTING.md:1'])
    expect(rules.every(rule => rule.status === 'unclassified' && rule.id === ruleId(rule.source.split(':')[0]!, rule.text))).toBe(true)
  })
})

describe('classification', () => {
  const rules: ProjectRule[] = [
    { id: 'r-000000000001', text: 'a', source: 'A:1', status: 'unclassified' },
    { id: 'r-000000000002', text: 'b', source: 'A:2', status: 'unclassified' },
    { id: 'r-000000000003', text: 'c', source: 'A:3', status: 'unclassified' },
    { id: 'r-000000000004', text: 'd', source: 'A:4', status: 'unclassified' },
  ]
  it('keeps text and sources, accepts only known statuses and drops unknown ids', () => {
    const { rules: out, classified } = applyClassification(rules, { rules: [
      { id: 'r-000000000001', status: 'enforcedBy', enforcedBy: ' lint ' },
      { id: 'r-000000000002', status: 'automatable', proposedCheck: 'An ESLint rule', text: 'rewritten' },
      { id: 'r-000000000003', status: 'invented' },
      { id: 'r-000000000004', status: 'enforcedBy' },
      { id: 'r-999999999999', status: 'humanOnly' },
      null,
    ] })
    expect(classified).toBe(2)
    expect(out).toEqual([
      { id: 'r-000000000001', text: 'a', source: 'A:1', status: 'enforcedBy', enforcedBy: 'lint' },
      { id: 'r-000000000002', text: 'b', source: 'A:2', status: 'automatable', proposedCheck: 'An ESLint rule' },
      { id: 'r-000000000003', text: 'c', source: 'A:3', status: 'unclassified' },
      { id: 'r-000000000004', text: 'd', source: 'A:4', status: 'unclassified' },
    ])
    expect(applyClassification(rules, { rules: 'nope' }).classified).toBe(0)
    expect(classificationPrompt([], rules)).toContain('- none')
  })
})

describe('runRulesInventory', () => {
  it('writes gates and unclassified rules offline, and reports why', async () => {
    const root = tree({ 'AGENTS.md': AGENTS, 'package.json': '{"scripts":{"test":"node --test"}}' })
    const { file, inventory } = await runRulesInventory({ root, classify: false, now: () => new Date('2026-10-22T00:00:00Z') })
    expect(file).toBe(path.join(root, RULES_FILE))
    expect(readRulesInventory(file)).toEqual(inventory)
    expect(inventory).toMatchObject({ schemaVersion: 1, generatedAt: '2026-10-22T00:00:00.000Z', gates: [{ id: 'test', command: 'npm test' }], classification: { status: 'offline' } })
    expect(inventory.rules.every(rule => rule.status === 'unclassified')).toBe(true)
    expect((await runRulesInventory({ root: tree({}) })).inventory.classification.status).toBe('empty')
  })

  it('classifies once through the architect provider, caches by rule id and re-classifies only changed rules', async () => {
    const root = tree({ 'AGENTS.md': AGENTS, '.specrails/agent-runtime.json': CONFIG })
    const calls: AgentRequest[] = []
    const status = ['enforcedBy', 'automatable', 'humanOnly', 'humanOnly']
    const executor = fakeExecutor(request => ({ rules: idsIn(request).map((id, index) => ({ id, status: status[index % 4], enforcedBy: 'route-order test', proposedCheck: 'lint rule' })) }), calls)
    const first = await runRulesInventory({ root, executors: { claude: executor } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ role: 'prompt', instructions: 'none', access: 'read', artifacts: 'none', model: 'opus', cwd: root, allowedRoots: [root] })
    expect(first.inventory.classification).toMatchObject({ status: 'classified', provider: 'claude', model: 'opus', usage: { costUsd: 0.01 } })
    expect(first.inventory.rules.map(rule => rule.status)).toEqual(['enforcedBy', 'automatable', 'humanOnly', 'humanOnly'])
    expect(first.inventory.rules[0]).toMatchObject({ enforcedBy: 'route-order test' })
    expect(first.inventory.rules[1]).toMatchObject({ proposedCheck: 'lint rule' })

    const again = await runRulesInventory({ root, executors: { claude: executor } })
    expect(calls).toHaveLength(1)
    expect(again.inventory.classification.status).toBe('cached')
    expect(again.inventory.rules).toEqual(first.inventory.rules)

    writeFileSync(path.join(root, 'AGENTS.md'), '\n\n' + AGENTS.replace('getApiBase()', 'apiBase()'))
    const changed = await runRulesInventory({ root, executors: { claude: executor } })
    expect(calls).toHaveLength(2)
    expect(idsIn(calls[1]!)).toHaveLength(1)
    expect(changed.inventory.rules[2]).toMatchObject({ source: 'AGENTS.md:12', status: 'humanOnly' })

    await runRulesInventory({ root, executors: { claude: executor }, reclassify: true })
    expect(idsIn(calls[2]!)).toHaveLength(4)
    const offline = await runRulesInventory({ root, classify: false })
    expect(offline.inventory.rules.filter(rule => rule.status !== 'unclassified')).toHaveLength(4)
  })

  it('keeps rules unclassified without configuration, with an invalid one, on a failed call or a non-JSON reply', async () => {
    const root = tree({ 'AGENTS.md': AGENTS })
    expect((await runRulesInventory({ root })).inventory.classification).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('.specrails/agent-runtime.json') })
    writeFileSync(path.join(root, 'bad.json'), '')
    mkdirSync(path.join(root, '.specrails'), { recursive: true })
    writeFileSync(path.join(root, '.specrails/agent-runtime.json'), '{"schemaVersion": 9}')
    expect((await runRulesInventory({ root })).inventory.classification.status).toBe('unavailable')
    writeFileSync(path.join(root, '.specrails/agent-runtime.json'), CONFIG)
    const failing: AgentExecutor = { async execute() { throw new Error('provider down') } }
    const failed = await runRulesInventory({ root, executors: { claude: failing } })
    expect(failed.inventory.classification).toMatchObject({ status: 'failed', reason: 'provider down' })
    expect(failed.inventory.rules.every(rule => rule.status === 'unclassified')).toBe(true)
    const prose = await runRulesInventory({ root, executors: { claude: fakeExecutor(() => 'no json here') } })
    expect(prose.inventory.classification).toMatchObject({ status: 'failed', reason: expect.stringContaining('JSON') })
    const fenced = await runRulesInventory({ root, executors: { claude: fakeExecutor(request => '```json\n' + JSON.stringify({ rules: [{ id: idsIn(request)[0], status: 'humanOnly' }] }) + '\n```') } })
    expect(fenced.inventory.classification).toMatchObject({ status: 'classified', reason: expect.stringContaining('3 rule(s)') })
  })
})

describe('rules CLI and runtime context', () => {
  it('validates arguments and prints a summary or JSON', async () => {
    const root = tree({ 'AGENTS.md': AGENTS, 'package.json': '{"scripts":{"lint":"eslint ."}}' })
    const out: string[] = []
    const err: string[] = []
    const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) }
    expect(await runRulesCommand({}, [], io)).toBe(1)
    expect(await runRulesCommand({ root: true }, ['inventory'], io)).toBe(1)
    expect(await runRulesCommand({ root: path.join(root, 'missing') }, ['inventory'], io)).toBe(1)
    expect(err.join('')).toContain('Usage: specrails-core rules inventory')
    expect(await runRulesCommand({ root, offline: true }, ['inventory'], io)).toBe(0)
    expect(out.join('')).toContain('gates: 1 (lint)')
    expect(await runRulesCommand({ root, offline: true, json: true }, ['inventory'], io)).toBe(0)
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ type: 'rules-inventory', file: path.join(root, RULES_FILE), classification: { status: 'offline' } })
  })

  it('hands the reviewer the human-only rules and the architect the gates when nothing is configured', async () => {
    const backlog = tree({})
    const repo = tree({ 'AGENTS.md': AGENTS, 'package.json': '{"scripts":{"test":"node --test"}}', '.specrails/agent-runtime.json': CONFIG })
    const context = { backlogRoot: backlog, artifactRoot: repo, artifactRepositoryId: 'app', repositories: [{ id: 'app', name: 'App', path: repo }], specs: [] } as unknown as PipelineContext
    expect(projectRulesContext(context)).toBeUndefined()
    await runRulesInventory({ root: repo, executors: { claude: fakeExecutor(request => ({ rules: idsIn(request).map(id => ({ id, status: 'humanOnly' })) })) } })
    const rules = projectRulesContext(context)!
    expect(rules.gates).toEqual([{ id: 'test', kind: 'test', command: 'npm test' }])
    expect(rules.humanOnly[0]).toEqual({ text: 'Frontend API calls use getApiBase() for every request', source: 'AGENTS.md:7' })
    // The backlog's own inventory wins over the repository's.
    mkdirSync(path.join(backlog, '.specrails'))
    writeFileSync(path.join(backlog, RULES_FILE), JSON.stringify({ schemaVersion: 1, generatedAt: 'x', gates: [], rules: [{ id: 'r-1', text: 'Backlog rule', source: 'X:1', status: 'humanOnly' }], classification: { status: 'classified' } }))
    expect(projectRulesContext(context)!.humanOnly).toEqual([{ text: 'Backlog rule', source: 'X:1' }])
    writeFileSync(path.join(backlog, RULES_FILE), '{not json')
    expect(projectRulesContext(context)!.gates).toHaveLength(1)

    const reviewer = roleInstructions('reviewer', context, 'demo', { projectRules: rules })
    expect(reviewer).toContain('## Project rules that need a human')
    expect(reviewer).toContain('- Frontend API calls use getApiBase() for every request (AGENTS.md:7)')
    const architect = roleInstructions('architect', context, 'demo', { projectRules: rules, verification: [] })
    expect(architect).toContain('## Project gates (default verification)')
    expect(architect).toContain('- `test` (test): `npm test`')
    expect(roleInstructions('architect', context, 'demo', { projectRules: rules, verification: [{ repositoryId: 'app', command: 'npm', args: ['test'] }] })).not.toContain('## Project gates')
    expect(roleInstructions('reviewer', context, 'demo', {})).not.toContain('## Project rules that need a human')
    expect(readFileSync(path.join(repo, RULES_FILE), 'utf8')).toContain('"humanOnly"')
  })
})
