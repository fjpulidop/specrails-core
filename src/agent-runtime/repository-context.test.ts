import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it, expect } from 'vitest'
import { repositoryContext } from './repository-context.js'
import type { PipelineContext } from '../installer/runtime/pipeline-state.js'

it('supplies real per-repository tooling and instructions without following out-of-scope files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-context-'))
  const other = mkdtempSync(path.join(tmpdir(), 'repository-private-'))
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'ng test', lint: 'ng lint' }, engines: { node: '>=22' } }))
    writeFileSync(path.join(root, 'AGENTS.md'), 'Project rule: generate clients from the contract.\n<!-- specrails-managed:start -->old skills/sr-*<!-- specrails-managed:end -->')
    writeFileSync(path.join(other, 'private.md'), 'OUTSIDE CONTENT')
    symlinkSync(path.join(other, 'private.md'), path.join(root, 'CLAUDE.md'))
    const context = { repositories: [{ id: 'front', name: 'Front', path: root }, { id: 'back', name: 'Back', path: other }] } as PipelineContext
    const text = repositoryContext(context)
    expect(text).toContain('Front (front)')
    expect(text).toContain('Back (back)')
    expect(text).toContain('ng test')
    expect(text).toContain('generate clients from the contract')
    expect(text).toContain('No root-level agent instruction file')
    expect(text).not.toContain('old skills/sr-*')
    expect(text).not.toContain('OUTSIDE CONTENT')
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }) }
})
