import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { pipelineStateDirectory, validatePipelineContext } from '../../../pipeline/pipeline-state.js'
import type { AgentRequest, RuntimeConfig } from '../../executor-types.js'
import { ExecutorRegistry } from '../../executors.js'
import { resolveOpenSpecCli, runOpenSpec } from '../../openspec.js'
import { createRun, definitionRunDirectory } from '../runs.js'
import { RunDatabase } from '../checkpoint/database.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('runs Quick SDD through native prompts, real pinned validation/archive and final host verification without a legacy journal', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'quick sdd ')); roots.push(root)
  const repository = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlog); execFileSync('git', ['init', '-q', repository])
  writeFileSync(path.join(repository, 'value.cjs'), 'module.exports = 1\n')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'quick', backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Return two', description: 'value.cjs returns two' }] })
  const role = { provider: 'fixture' }, config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./value.cjs")!==2)process.exit(1);console.log("verified actual value")'] }] }
  const change = 'quick-change', active = path.join(repository, 'openspec/changes', change), requests: AgentRequest[] = []
  const registry = new ExecutorRegistry().register('fixture', { async execute(request) {
    requests.push(request)
    expect(request.nativeCommand?.args).toContain(change)
    expect(request).toMatchObject({ access: 'write', instructions: 'none', artifacts: 'none' })
    expect(request.openspec).toBeUndefined()
    if (request.nativeCommand?.id === 'opsx:ff') {
      await runOpenSpec(resolveOpenSpecCli(), repository, ['new', 'change', change, '--json'])
      mkdirSync(path.join(active, 'specs/value'), { recursive: true })
      for (const [file, content] of Object.entries({
        'proposal.md': '## Why\nReturn the required value.\n## What Changes\nUpdate value.cjs.\n## Capabilities\n### New Capabilities\n- value: Return two.\n## Impact\nOne function.\n',
        'design.md': '## Design\nSet the value and verify it with Node.\n',
        'specs/value/spec.md': '## ADDED Requirements\n### Requirement: Return two\nThe function SHALL return two.\n#### Scenario: Load the function\n- **WHEN** value.cjs is loaded\n- **THEN** its value is two\n',
        'tasks.md': '- [ ] 1. Update and verify the function\n',
      })) writeFileSync(path.join(active, file), content)
    } else {
      expect(request.nativeCommand?.id).toBe('opsx:apply')
      writeFileSync(path.join(repository, 'value.cjs'), 'module.exports = 2\n')
      writeFileSync(path.join(active, 'tasks.md'), '- [x] 1. Update and verify the function\n')
    }
    return { text: 'Completed native skill', usage: { inputTokens: 10, outputTokens: 5, costUsd: null } }
  } })
  const definition = JSON.parse(readFileSync(new URL('../__fixtures__/quick-sdd.json', import.meta.url), 'utf8'))
  const result = await createRun({ context, config, definition, registry, change })
  expect(result, JSON.stringify(result)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(requests).toHaveLength(2)
  expect(existsSync(active)).toBe(false)
  expect(readdirSync(path.join(repository, 'openspec/changes/archive')).filter(name => name.endsWith('-' + change))).toHaveLength(1)
  expect(existsSync(path.join(pipelineStateDirectory(context), 'state.json'))).toBe(false)
  const database = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite'))
  try {
    expect(database.sqlite.prepare('SELECT count(*) count FROM invocations').get()?.count).toBe(2)
    expect(database.sqlite.prepare("SELECT count(*) count FROM attempts WHERE node_path IN ('check','verify') AND status='succeeded'").get()?.count).toBe(2)
    expect(database.sqlite.prepare("SELECT count(*) count FROM attempts WHERE node_path='archive' AND status='succeeded'").get()?.count).toBe(1)
  } finally { database.close() }
}, 45_000)
