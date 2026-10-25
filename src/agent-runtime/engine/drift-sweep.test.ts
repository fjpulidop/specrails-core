import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { validatePipelineContext } from '../../pipeline/pipeline-state.js'
import type { AgentRequest, RuntimeConfig } from '../executor-types.js'
import { ExecutorRegistry } from '../executors.js'
import { definitionVersion } from './canonical-json.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { validationPieceRegistry } from './pieces/index.js'
import { configuredRoles } from './preflight.js'
import { createRun, definitionRunDirectory } from './runs.js'
import { statusRun } from './run-status.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const definition = () => JSON.parse(readFileSync(new URL('./__fixtures__/drift-sweep.json', import.meta.url), 'utf8'))

it('publishes the read-only drift sweep reference definition with its canonical version', () => {
  const draft = definition()
  expect(draft.version).toBe(definitionVersion(draft))
  const role = { provider: 'fixture' }
  const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [], roles: { 'drift-auditor': { provider: 'fixture', access: 'read', artifacts: 'none' } } }
  const published = validateWorkflowDefinition(draft, validationPieceRegistry(), configuredRoles(config))
  expect(published.ok, JSON.stringify(published)).toBe(true)
})

it('sweeps every capability read-only and returns the divergences as structured output', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift sweep ')); directories.push(root)
  const repository = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
  mkdirSync(path.join(repository, 'openspec', 'specs', 'search'), { recursive: true }); mkdirSync(backlog)
  execFileSync('git', ['init', '-q', repository])
  writeFileSync(path.join(repository, 'openspec', 'specs', 'search', 'spec.md'), '### Requirement: Page size\nThe system SHALL page by 25.\n')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'drift', backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo',
    repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 'sweep', title: 'Drift sweep', description: 'Compare specs with code' }] })
  const role = { provider: 'fixture' }
  const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [], roles: { 'drift-auditor': { provider: 'fixture', access: 'read', artifacts: 'none' } } }
  const requests: AgentRequest[] = []
  const divergence = { capability: 'search', requirement: 'search/page-size', observed: 'src/search.ts:12 pages by 50' }
  const registry = new ExecutorRegistry().register('fixture', { async execute(request) {
    requests.push(request)
    return { text: JSON.stringify({ divergences: [divergence], unchecked: [] }), usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 } }
  } })
  const published = validateWorkflowDefinition(definition(), validationPieceRegistry(), configuredRoles(config))
  if (!published.ok) throw new Error(JSON.stringify(published.errors))
  const result = await createRun({ context, config, definition: published.definition, registry })
  expect(result.state.status).toBe('succeeded')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ role: 'drift-auditor', access: 'read', artifacts: 'none' })
  expect(requests[0]!.prompt).toContain('Drift sweep, read-only: edit nothing.')
  const full = await statusRun(definitionRunDirectory(context), false)
  expect(JSON.stringify(full)).toContain('src/search.ts:12 pages by 50')
})
