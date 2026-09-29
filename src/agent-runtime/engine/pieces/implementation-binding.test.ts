import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { bindImplementationExclusions, fingerprintCandidate, initializePipeline, pipelineStateDirectory, readCandidateScope, validatePipelineContext } from '../../../pipeline/pipeline-state.js'
import type { PieceExecutionContext } from '../contracts.js'
import { initialDefinitionState } from '../state.js'
import { deriveImplementationBinding } from './implementation-binding.js'
import { captureImplementationJournal, forkImplementationJournal } from './implementation-journal.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'implementation binding ')); roots.push(root)
  execFileSync('git', ['init', '-q', root])
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'parent', backlogRoot: root, artifactRoot: root, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: root }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'First', description: 'First obligation', repositoryIds: ['repo'] }, { id: 2, title: 'Second', description: 'Second obligation', repositoryIds: ['repo'] }] })
  const state = initialDefinitionState()
  const execution: PieceExecutionContext = { state, frame: { runId: 'parent', nodePath: 'implementation', scope: state.$scope, task: { checkpointThreadId: 'parent', checkpointId: 'checkpoint', taskCheckpointNs: '', taskId: 'task' }, visitId: 'visit', visit: 1, transition: 1, attemptId: 'attempt', attempt: 1, leaseEpoch: 1 }, signal: new AbortController().signal, progress() {}, interrupt() { throw new Error('Unexpected interrupt') } }
  return { root, context, execution }
}
it('keeps the root journal and derives stable distinct branch and fork journals', () => {
  const f = fixture()
  const root = deriveImplementationBinding(f.context, f.execution, 'feature')
  expect(root.context).toEqual(f.context)
  expect(root.change).toBe('feature')
  f.execution.frame.scope = { id: 'root/batch/0', nodePathPrefix: 'batch', branchId: '0' }
  f.execution.frame.nodePath = 'batch/implementation'
  f.execution.state.$item = { value: { id: 1, title: 'First' }, index: 0 }
  const first = deriveImplementationBinding(f.context, f.execution, 'feature')
  expect(first.context.specs.map(spec => spec.id)).toEqual([1])
  expect(first.context.backlogRoot).toBe(f.context.backlogRoot)
  expect(first.context.ownership).toEqual(f.context.ownership)
  expect(deriveImplementationBinding(f.context, f.execution, 'feature')).toEqual(first)
  const fork = deriveImplementationBinding({ ...f.context, runId: 'fork' }, f.execution, 'feature')
  expect(fork.context.runId).not.toBe(first.context.runId)
  f.execution.frame.scope.id = 'root/batch/1'
  expect(deriveImplementationBinding(f.context, f.execution, 'feature').context.runId).not.toBe(first.context.runId)
  f.execution.state.$item = { value: { id: 77, title: 'Unknown' }, index: 0 }
  expect(() => deriveImplementationBinding(f.context, f.execution, 'feature')).toThrow('outside the frozen')
})
it('excludes only explicitly declared sibling metadata and keeps source changes measurable', () => {
  const f = fixture(), binding = deriveImplementationBinding(f.context, f.execution, 'feature')
  initializePipeline(f.context, 'feature')
  const sibling = path.join(f.context.backlogRoot, '.specrails/pipeline/sibling')
  bindImplementationExclusions(f.context, { runtimeExclusions: [binding.directory, sibling], repositoryExclusions: { repo: ['openspec/changes/scoped-feature'] } })
  const before = fingerprintCandidate(readCandidateScope(f.context))
  mkdirSync(sibling, { recursive: true }); writeFileSync(path.join(sibling, 'state.json'), 'metadata')
  mkdirSync(path.join(f.root, 'openspec/changes/scoped-feature'), { recursive: true }); writeFileSync(path.join(f.root, 'openspec/changes/scoped-feature/tasks.md'), 'owned artifact')
  expect(fingerprintCandidate(readCandidateScope(f.context))).toBe(before)
  writeFileSync(path.join(f.root, 'source.ts'), 'real change')
  expect(fingerprintCandidate(readCandidateScope(f.context))).not.toBe(before)
  expect(() => bindImplementationExclusions(f.context, { runtimeExclusions: [f.root], repositoryExclusions: {} })).toThrow('pipeline journal')
  expect(() => bindImplementationExclusions(f.context, { runtimeExclusions: [], repositoryExclusions: { repo: ['source.ts'] } })).toThrow('OpenSpec artifacts')
})
it('restores immutable checkpoint bytes and rejects modified objects before target effects', () => {
  const f = fixture(), source = deriveImplementationBinding(f.context, f.execution, 'feature')
  initializePipeline(f.context, 'feature')
  const active = path.join(f.root, 'openspec/changes/feature')
  mkdirSync(active, { recursive: true }); writeFileSync(path.join(active, 'tasks.md'), '- [ ] Original cut')
  const snapshot = captureImplementationJournal(source)
  writeFileSync(path.join(active, 'tasks.md'), '- [x] Later source state')
  const target = deriveImplementationBinding({ ...f.context, runId: 'fork' }, f.execution, 'fork-feature')
  forkImplementationJournal(snapshot, source, target)
  expect(readFileSync(path.join(f.root, 'openspec/changes/fork-feature/tasks.md'), 'utf8')).toBe('- [ ] Original cut')
  expect(readFileSync(path.join(active, 'tasks.md'), 'utf8')).toBe('- [x] Later source state')
  const next = deriveImplementationBinding({ ...f.context, runId: 'next-fork' }, f.execution, 'next-feature')
  forkImplementationJournal(captureImplementationJournal(target), target, next)
  expect(JSON.parse(readFileSync(path.join(next.directory, 'openspec-archive-base.json'), 'utf8'))).toMatchObject({ sourceChange: 'feature' })
  const corrupt = snapshot.files[0]!
  writeFileSync(path.join(source.directory, 'agent-workflow/implementation-snapshots/objects', corrupt.hash), 'tampered')
  const other = deriveImplementationBinding({ ...f.context, runId: 'other' }, f.execution, 'other-feature')
  expect(() => forkImplementationJournal(snapshot, source, other)).toThrow('corrupt')
  expect(existsSync(path.join(pipelineStateDirectory(other.context), 'state.json'))).toBe(false)
})
it('rejects symlink traversal while capturing checkpoint artifacts', () => {
  const f = fixture(), binding = deriveImplementationBinding(f.context, f.execution, 'feature')
  initializePipeline(f.context, 'feature')
  const active = path.join(f.root, 'openspec/changes/feature')
  mkdirSync(active, { recursive: true }); symlinkSync(path.join(f.root, '.git'), path.join(active, 'escape'), 'dir')
  expect(() => captureImplementationJournal(binding)).toThrow('symlink')
})
