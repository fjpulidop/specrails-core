import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ForkAllocation } from './fork-allocation.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'fork allocation ')); roots.push(root)
  const target = path.join(root, 'pipeline', 'child'), artifacts = path.join(root, 'artifacts')
  mkdirSync(artifacts)
  return { root, target, artifacts, open: (request = 'request', digest = 'digest') => ForkAllocation.open(target, artifacts, request, digest) }
}
it('serializes live construction and recovers only matching unpublished allocations', async () => {
  const f = fixture(), first = await f.open()
  first.recover(); first.reserve(f.target)
  writeFileSync(path.join(f.target, 'partial'), 'unfinished')
  await expect(f.open()).rejects.toMatchObject({ code: 'lease_held' })
  first.close()
  const other = await f.open('different')
  try { expect(() => other.recover()).toThrow('another request') } finally { other.close() }
  expect(readFileSync(path.join(f.target, 'partial'), 'utf8')).toBe('unfinished')
  const retry = await f.open()
  try { retry.recover(); expect(existsSync(f.target)).toBe(false); retry.reserve(f.target) } finally { retry.close() }
})
it('preserves a replaced directory and refuses to remove any sibling allocation', async () => {
  const f = fixture(), first = await f.open(), change = path.join(f.artifacts, 'openspec', 'changes', 'child')
  first.recover(); first.reserve(f.target); first.reserve(change); first.close()
  renameSync(f.target, f.target + '-retained')
  mkdirSync(f.target); writeFileSync(path.join(f.target, 'user.txt'), 'foreign')
  const retry = await f.open()
  try { expect(() => retry.recover()).toThrow('ownership changed') } finally { retry.close() }
  expect(readFileSync(path.join(f.target, 'user.txt'), 'utf8')).toBe('foreign')
  expect(existsSync(change)).toBe(true)
})
