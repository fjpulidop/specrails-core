import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { addDeveloperChecks, expandedPlanCommands, initializeVerificationPlan, readVerificationPlan, validateProposedChecks } from './verification-plan.js'
import { pipelineStateDirectory, type PipelineContext } from '../installer/runtime/pipeline-state.js'

let root: string, context: PipelineContext
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'verification-plan-'))
  const repo = path.join(root, 'repo'); mkdirSync(repo)
  context = { schemaVersion: 1, runId: 'fixture', backlogRoot: root, artifactRoot: repo, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repo }], specs: [{ id: 1, title: 'Fixture', description: 'Exercise verification', repositoryIds: ['repo'], acceptanceCriteria: ['Runs correctly'] }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' } }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const host = () => ({ repositoryId: 'repo', command: process.execPath, args: ['--version'] })
const proposal = () => ({ kind: 'harness' as const, key: 'acceptance', label: 'Acceptance', repositoryId: 'repo', command: process.execPath, args: [], entrypoint: 'test.cjs', files: [{ path: 'test.cjs', content: 'require("./helper.cjs")' }, { path: 'helper.cjs', content: 'console.log("ok")' }] })

it('retains baseline and omitted additions, revises one developer key and keeps immutable history', () => {
  const initial = initializeVerificationPlan(context, [host()], [])
  const first = addDeveloperChecks(context, [proposal()])
  const original = expandedPlanCommands(context, first)[1]!.args.at(-1)!
  expect(first.entries).toHaveLength(2)
  expect(addDeveloperChecks(context, []).planHash).toBe(first.planHash)
  const changed = proposal(); changed.files[1]!.content = 'console.log("updated")'
  const second = addDeveloperChecks(context, [changed])
  expect(second.entries).toHaveLength(2)
  expect(second.baseline).toEqual(initial.baseline)
  expect(second.planHash).not.toBe(first.planHash)
  expect(existsSync(original)).toBe(true)
  expect(readVerificationPlan(context)).toEqual(second)
})

it('coalesces exact duplicates while preserving baseline policy and all origins', () => {
  initializeVerificationPlan(context, [{ ...host(), policy: { reuse: 'snapshot-local', deterministic: true, readOnly: true, resources: [] } }], [])
  const plan = addDeveloperChecks(context, [{ ...host(), kind: 'command', key: 'same', label: 'Duplicate' }])
  expect(plan.entries).toHaveLength(1)
  expect(plan.entries[0]!.origins).toEqual(['host', 'developer'])
  expect(plan.entries[0]!.command.policy?.reuse).toBe('snapshot-local')
})

it.each(['../outside', '/absolute', 'C:/outside', 'CON.txt', 'a\\b', 'a/../b', 'test.'])('rejects unsafe harness path %s before writing anything', file => {
  const item = proposal(); item.files[1]!.path = file
  expect(() => validateProposedChecks(context, [item])).toThrow()
  expect(existsSync(pipelineStateDirectory(context))).toBe(false)
})

it('rejects conflicting file ancestors, limits and forbidden host authority', () => {
  const item = proposal(); item.files = [{ path: 'test.cjs', content: '' }, { path: 'test.cjs/child', content: '' }]
  expect(() => validateProposedChecks(context, [item])).toThrow()
  expect(() => validateProposedChecks(context, [{ ...proposal(), policy: { reuse: 'snapshot-local' } }])).toThrow()
  const large = proposal(); large.files[0]!.content = 'x'.repeat(65537)
  expect(() => validateProposedChecks(context, [large])).toThrow()
  expect(() => validateProposedChecks(context, null)).toThrow()
  expect(validateProposedChecks(context, undefined)).toEqual([])
})

it('detects tampered baseline and sources and refuses symlink destinations', () => {
  initializeVerificationPlan(context, [host()], [])
  const plan = addDeveloperChecks(context, [proposal()])
  const command = expandedPlanCommands(context, plan)[1]!
  writeFileSync(command.args.at(-1)!, 'tampered')
  expect(() => expandedPlanCommands(context, plan)).toThrow('source changed')
  const file = path.join(pipelineStateDirectory(context), 'verification/plan.json')
  const raw = JSON.parse(readFileSync(file, 'utf8')); raw.baseline = []
  writeFileSync(file, JSON.stringify(raw))
  expect(() => readVerificationPlan(context)).toThrow('integrity')
  rmSync(path.dirname(file), { recursive: true }); symlinkSync(root, path.dirname(file))
  expect(() => initializeVerificationPlan(context, [host()], [])).toThrow('symlink')
})


it('rejects oversized cumulative manifests before materializing harness sources', () => {
  const before = initializeVerificationPlan(context, [host()], [])
  const large = Array.from({ length: 3 }, (_, index) => ({ ...proposal(), key: `large-${index}`, args: Array.from({ length: 100 }, () => String(index).repeat(4096)) }))
  expect(() => addDeveloperChecks(context, large)).toThrow('2 MiB')
  expect(readVerificationPlan(context)).toEqual(before)
  expect(existsSync(path.join(pipelineStateDirectory(context), 'verification/harnesses'))).toBe(false)
})
