import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { pipelineStateDirectory, validatePipelineContext } from '../../../pipeline/pipeline-state.js'
import type { AgentRequest, RuntimeConfig } from '../../executor-types.js'
import { ExecutorRegistry } from '../../executors.js'
import { resolveOpenSpecCli, runOpenSpec } from '../../openspec.js'
import { createRun, definitionRunDirectory, resumeRun } from '../runs.js'
import { RunDatabase } from '../checkpoint/database.js'
import { validateWorkflowDefinition } from '../definition-validator.js'
import { validationPieceRegistry } from './index.js'

// These integrations start the real pinned OpenSpec CLI several times.
// Windows runner process startup uses the same budget as workflow fork tests.
const integrationTimeout = process.platform === 'win32' ? 180_000 : 45_000
const roots: string[] = []
function publish(value: unknown) {
  const result = validateWorkflowDefinition(value, validationPieceRegistry())
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.definition
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it.each([undefined, 'opsx:ff', 'opsx:apply'])('runs Quick SDD with a human block at %s through pinned validation/archive and host verification', async blockedCommand => {
  const root = mkdtempSync(path.join(tmpdir(), 'quick sdd ')); roots.push(root)
  const repository = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlog); execFileSync('git', ['init', '-q', repository])
  writeFileSync(path.join(repository, 'value.cjs'), 'module.exports = 1\n')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'quick', backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Return two', description: 'value.cjs returns two' }] })
  const role = { provider: 'fixture' }, config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./value.cjs")!==2)process.exit(1);console.log("verified actual value")'] }] }
  const change = 'quick-change', active = path.join(repository, 'openspec/changes', change), requests: AgentRequest[] = []
  let blocked = false
  const registry = new ExecutorRegistry().register('fixture', { async execute(request) {
    requests.push(request)
    expect(request.nativeCommand?.args).toContain(change)
    expect(request).toMatchObject({ access: 'write', instructions: 'none', artifacts: 'none' })
    expect(request.openspec).toBeUndefined()
    if (!blocked && request.nativeCommand?.id === blockedCommand) {
      blocked = true
      return { text: 'LOOP_BLOCKED: Confirm the requested value?', usage: { inputTokens: 2, outputTokens: 1, costUsd: null } }
    }
    if (blocked && request.nativeCommand?.id === blockedCommand) expect(request.nativeCommand?.args).toContain('Return two')
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
  let result = await createRun({ context, config, definition, registry, change })
  if (blockedCommand) {
    expect(result.state.status).toBe('paused')
    expect(readFileSync(path.join(repository, 'value.cjs'), 'utf8')).toBe('module.exports = 1\n')
    result = await resumeRun(definitionRunDirectory(context), { registry,
      answers: { [result.state.pendingInterrupts[0].id]: { answer: 'Return two' } } })
  }
  expect(result, JSON.stringify(result)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(requests.map(request => request.nativeCommand?.id)).toEqual(blockedCommand === 'opsx:ff'
    ? ['opsx:ff', 'opsx:ff', 'opsx:apply'] : blockedCommand === 'opsx:apply'
      ? ['opsx:ff', 'opsx:apply', 'opsx:apply'] : ['opsx:ff', 'opsx:apply'])
  expect(existsSync(active)).toBe(false)
  expect(readdirSync(path.join(repository, 'openspec/changes/archive')).filter(name => name.endsWith('-' + change))).toHaveLength(1)
  expect(existsSync(path.join(pipelineStateDirectory(context), 'state.json'))).toBe(false)
  const database = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite'))
  try {
    expect(database.sqlite.prepare('SELECT count(*) count FROM invocations').get()?.count).toBe(blockedCommand ? 3 : 2)
    expect(database.sqlite.prepare("SELECT count(*) count FROM attempts WHERE node_path IN ('check','verify') AND status='succeeded'").get()?.count).toBe(2)
    expect(database.sqlite.prepare("SELECT count(*) count FROM attempts WHERE node_path='archive' AND status='succeeded'").get()?.count).toBe(1)
  } finally { database.close() }
  if (blockedCommand === undefined) {
    const replay = await createRun({ context: { ...context, runId: 'quick-archived' }, config, registry, change,
      definition: publish({ schemaVersion: 1, id: 'archived-check', title: 'Archived target', journal: 'ledger-only', change: 'none', roles: [], entry: 'validate', maxTransitions: 8,
        nodes: {
          validate: { kind: 'openspec-validate', params: { change, allowArchived: true }, ends: { pass: 'archive', fail: null, failed: null } },
          archive: { kind: 'openspec-archive', params: { change, allowArchived: true }, ends: { next: 'verify', failed: null } },
          verify: { kind: 'verify', params: { commands: 'configured' }, ends: { pass: 'done', fail: null, failed: null } },
          done: { kind: 'end', params: { outcome: 'success', requiresVerified: true }, ends: {} },
        },
      }),
    })
    expect(replay).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
    expect(requests).toHaveLength(2)
    expect(readdirSync(path.join(repository, 'openspec/changes/archive')).filter(name => name.endsWith('-' + change))).toHaveLength(1)
    const strict = await createRun({ context: { ...context, runId: 'quick-strict' }, config, registry, change,
      definition: publish({ schemaVersion: 1, id: 'strict-archived', title: 'Strict target', journal: 'ledger-only', change: 'none', roles: [], entry: 'validate', maxTransitions: 2,
        nodes: {
          validate: { kind: 'openspec-validate', params: { change }, ends: { pass: 'done', fail: null, failed: null } },
          done: { kind: 'end', params: { outcome: 'success' }, ends: {} },
        },
      }),
    })
    expect(strict.state.status).toBe('failed')
  }
}, integrationTimeout)

it.each([true, false])('repairs invalid artifacts once through the bounded preparation retry (repairable: %s)', async repairable => {
  const root = mkdtempSync(path.join(tmpdir(), 'quick sdd repair ')); roots.push(root)
  const repository = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlog); execFileSync('git', ['init', '-q', repository])
  writeFileSync(path.join(repository, 'value.cjs'), 'module.exports = 1\n')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'repair', backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Return two', description: 'value.cjs returns two' }] })
  const role = { provider: 'fixture' }, config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./value.cjs")!==2)process.exit(1)'] }] }
  const change = 'repair-change', active = path.join(repository, 'openspec/changes', change), commands: Array<string | undefined> = []
  const valid = '## ADDED Requirements\n### Requirement: Return two\nThe function SHALL return two.\n#### Scenario: Load the function\n- **WHEN** value.cjs is loaded\n- **THEN** its value is two\n'
  const registry = new ExecutorRegistry().register('fixture', { async execute(request) {
    commands.push(request.nativeCommand?.id)
    if (request.nativeCommand?.id === 'opsx:ff') {
      const preparations = commands.filter(command => command === 'opsx:ff').length
      if (!existsSync(active)) await runOpenSpec(resolveOpenSpecCli(), repository, ['new', 'change', change, '--json'])
      mkdirSync(path.join(active, 'specs/value'), { recursive: true })
      writeFileSync(path.join(active, 'proposal.md'), '## Why\nReturn the required value.\n## What Changes\nUpdate value.cjs.\n## Capabilities\n### New Capabilities\n- value: Return two.\n## Impact\nOne function.\n')
      writeFileSync(path.join(active, 'tasks.md'), '- [ ] 1. Update and verify the function\n')
      // The first preparation is invalid; the repair is valid only when repairable.
      writeFileSync(path.join(active, 'specs/value/spec.md'), preparations > 1 && repairable ? valid : 'Not a delta specification')
    } else {
      writeFileSync(path.join(repository, 'value.cjs'), 'module.exports = 2\n')
      writeFileSync(path.join(active, 'tasks.md'), '- [x] 1. Update and verify the function\n')
    }
    return { text: 'Completed native skill', usage: { inputTokens: 10, outputTokens: 5, costUsd: null } }
  } })
  const definition = JSON.parse(readFileSync(new URL('../__fixtures__/quick-sdd.json', import.meta.url), 'utf8'))
  const result = await createRun({ context, config, definition, registry, change })
  if (repairable) {
    expect(result, JSON.stringify(result)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
    expect(commands).toEqual(['opsx:ff', 'opsx:ff', 'opsx:apply'])
  } else {
    // One repair only: a second invalid preparation fails without another call.
    expect(result.state.status).toBe('failed')
    expect(commands).toEqual(['opsx:ff', 'opsx:ff'])
    expect(readFileSync(path.join(repository, 'value.cjs'), 'utf8')).toBe('module.exports = 1\n')
  }
}, integrationTimeout)
