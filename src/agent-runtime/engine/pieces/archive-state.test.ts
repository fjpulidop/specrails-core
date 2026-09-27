import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { archivedOpenSpecChange } from '../../graph/artifacts.js'
import type { PipelineContext } from '../../../pipeline/pipeline-state.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'archive lookup ')); roots.push(root)
  return { root, context: { artifactRoot: root } as PipelineContext }
}
it('looks up only an exact archived directory and gives an active target precedence', () => {
  const { root, context } = fixture()
  expect(archivedOpenSpecChange(context, 'target')).toBeUndefined()
  mkdirSync(path.join(root, 'openspec/changes/archive/2026-09-27-other-target'), { recursive: true })
  expect(archivedOpenSpecChange(context, 'target')).toBeUndefined()
  mkdirSync(path.join(root, 'openspec/changes/archive/2026-09-27-target'))
  expect(archivedOpenSpecChange(context, 'target')).toBe('openspec/changes/archive/2026-09-27-target')
  mkdirSync(path.join(root, 'openspec/changes/target'))
  expect(archivedOpenSpecChange(context, 'target')).toBeUndefined()
})
it('does not follow a symlinked archive directory or archived target', () => {
  const { root, context } = fixture(), outside = path.join(root, 'outside')
  mkdirSync(outside); mkdirSync(path.join(root, 'openspec/changes'), { recursive: true })
  symlinkSync(outside, path.join(root, 'openspec/changes/archive'), 'junction')
  expect(() => archivedOpenSpecChange(context, 'target')).toThrow('symlinks')
  rmSync(path.join(root, 'openspec/changes/archive'))
  mkdirSync(path.join(root, 'openspec/changes/archive'))
  symlinkSync(outside, path.join(root, 'openspec/changes/archive/2026-09-27-target'), 'junction')
  expect(archivedOpenSpecChange(context, 'target')).toBeUndefined()
})
it('rejects traversal and prototype-like path syntax before filesystem lookup', () => {
  const { context } = fixture()
  for (const value of ['../target', '/target', 'a/b', '', 'a'.repeat(65)]) expect(() => archivedOpenSpecChange(context, value)).toThrow('Invalid OpenSpec change identifier')
})
