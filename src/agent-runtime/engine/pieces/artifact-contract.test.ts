import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, expect, it } from 'vitest'
import type { JsonValue, PieceExecutionContext } from '../contracts.js'
import { artifactContractPiece } from './artifact-contract.js'
import type { PieceDependencies } from './ports.js'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'artifact-contract-')); roots.push(root)
  const directory = path.join(root, 'openspec/changes/feature')
  mkdirSync(path.join(directory, 'specs/example'), { recursive: true })
  for (const [name, content] of Object.entries({ 'proposal.md': 'Requirements', 'design.md': 'Approved design', 'tasks.md': '- [ ] 1. Implement requirement\n', 'specs/example/spec.md': 'Frozen acceptance criteria' })) writeFileSync(path.join(directory, name), content)
  const scopes = new Map<string, Map<string, JsonValue>>()
  const deps = { context: { artifactRoot: root }, artifactContracts: (context: PieceExecutionContext) => {
    const scope = context.frame.scope.id
    if (!scopes.has(scope)) scopes.set(scope, new Map())
    return { get: (key: string) => scopes.get(scope)!.get(key), set: (key: string, value: JsonValue) => { scopes.get(scope)!.set(key, value) } }
  } } as unknown as PieceDependencies
  const piece = artifactContractPiece(() => deps)
  const run = (action: 'freeze' | 'check', completed = false, scope = 'root') => piece.execute({ change: 'feature', contractId: 'plan', action, requireCompletedTasks: completed }, { frame: { scope: { id: scope } } } as PieceExecutionContext)
  return { run, directory }
}
it('freezes real artifacts and permits only task checkbox completion', async () => {
  const f = fixture()
  expect(await f.run('freeze')).toMatchObject({ outcome: 'pass' })
  expect(await f.run('check', true)).toMatchObject({ outcome: 'fail', output: { incomplete: 1 } })
  writeFileSync(path.join(f.directory, 'tasks.md'), '- [x] 1. Implement requirement\n')
  expect(await f.run('check', true)).toMatchObject({ outcome: 'pass', output: { incomplete: 0 } })
  writeFileSync(path.join(f.directory, 'tasks.md'), '- [x] 1. Weaken requirement\n')
  expect(await f.run('check', true)).toMatchObject({ outcome: 'fail', output: { reason: 'artifacts_changed' } })
})
it('rejects modified design, removed artifacts and cross-scope contracts', async () => {
  const f = fixture()
  await f.run('freeze')
  expect(await f.run('check', false, 'other')).toMatchObject({ outcome: 'fail', output: { reason: 'contract_missing' } })
  writeFileSync(path.join(f.directory, 'design.md'), 'Changed design')
  expect(await f.run('check')).toMatchObject({ outcome: 'fail', output: { reason: 'artifacts_changed' } })
  rmSync(path.join(f.directory, 'proposal.md'))
  expect(await f.run('check')).toMatchObject({ outcome: 'fail', output: { reason: 'required_artifacts_missing' } })
})
it('rejects empty tasks and symlinked specs without reading outside the artifact root', async () => {
  const f = fixture()
  writeFileSync(path.join(f.directory, 'tasks.md'), 'No actionable tasks')
  expect(await f.run('freeze')).toMatchObject({ outcome: 'fail', output: { reason: 'tasks_missing' } })
  writeFileSync(path.join(f.directory, 'tasks.md'), '- [ ] Work\n')
  symlinkSync(path.join(f.directory, 'design.md'), path.join(f.directory, 'specs/leak.md'))
  await expect(f.run('freeze')).rejects.toThrow('symlinks')
  expect(readFileSync(path.join(f.directory, 'design.md'), 'utf8')).toBe('Approved design')
})
