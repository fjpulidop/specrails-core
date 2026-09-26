import { mkdtemp, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { DEFINITION_EVALUATION_CORPUS } from '../evaluation-corpus.js'
import { runEvaluation } from '../evaluation.js'
import { validationPieceRegistry } from './pieces/index.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { definitionVersion } from './canonical-json.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function output() { const directory = await mkdtemp(path.join(tmpdir(), 'definition evaluation ')); directories.push(directory); return directory }

it('keeps published reference definitions in the offline corpus with actual catalog validation', () => {
  const roles = { architect: { access: 'read' as const }, developer: { access: 'write' as const }, reviewer: { access: 'read' as const } }
  for (const definition of DEFINITION_EVALUATION_CORPUS) {
    const validated = validateWorkflowDefinition(definition, validationPieceRegistry(), roles, { published: true })
    expect(validated, JSON.stringify(validated)).toMatchObject({ ok: true, version: definition.version })
  }
})

it('executes the native implementation through frozen independent behavioral oracles without paid AI', async () => {
  const directory = await output()
  const report = await runEvaluation({ output: directory, definition: DEFINITION_EVALUATION_CORPUS[0], caseIds: ['local-tested-feature'] })
  expect(report.stopReason, JSON.stringify(report.observations)).toBeNull()
  expect(report).toMatchObject({ mode: 'offline', isDefinitionEvaluation: true, allCasesAccepted: true, acceptedCases: 2, reportedSpendUsd: 0, monetaryConclusion: 'inconclusive' })
  expect(report.observations).toHaveLength(2)
  expect(report.observations.every(row => row.status === 'succeeded' && row.independentAccepted)).toBe(true)
  expect(JSON.parse(await readFile(path.join(directory, 'evaluation.json'), 'utf8')).allCasesAccepted).toBe(true)
}, 120_000)

it('does not count a successful no-op graph as an independently accepted implementation', async () => {
  const draft = { schemaVersion: 1, id: 'no-op', title: 'No operation', journal: 'ledger-only', change: 'none', entry: 'done', maxTransitions: 2, roles: [],
    nodes: { done: { kind: 'end', params: { outcome: 'success' }, ends: {} } } }
  const report = await runEvaluation({ output: await output(), definition: { ...draft, version: definitionVersion(draft) }, caseIds: ['local-tested-feature'] })
  expect(report.stopReason, JSON.stringify(report.observations)).toBeNull()
  expect(report).toMatchObject({ allCasesAccepted: false, acceptedCases: 0, monetaryConclusion: 'inconclusive' })
}, 30_000)
