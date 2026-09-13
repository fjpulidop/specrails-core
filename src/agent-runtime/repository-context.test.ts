import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it, expect } from 'vitest'
import { repositoryContext, repositoryContextSnapshot, renderRepositoryContext } from './repository-context.js'
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

it('shares the facts budget across every repository and revokes removed instruction sources', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-budget-'))
  try {
    const repositories = Array.from({ length: 20 }, (_, i) => {
      const directory = path.join(root, String(i)); mkdirSync(directory)
      writeFileSync(path.join(directory, 'AGENTS.md'), 'Important rule '.repeat(300))
      return { id: 'repo-' + i, name: 'Backend ' + i, path: directory }
    })
    const context = { repositories } as PipelineContext
    const before = repositoryContextSnapshot(context)
    expect(before.repositories.reduce((sum, repo) => sum + repo.body.length, 0)).toBeLessThanOrEqual(20_000)
    const rendered = renderRepositoryContext(before)
    for (const repo of repositories) expect(rendered).toContain(`${repo.name} (${repo.id})`)
    expect(rendered).toContain('Context truncated')
    expect(renderRepositoryContext(before, before)).toContain('unchanged')
    rmSync(path.join(repositories[19].path, 'AGENTS.md'))
    const delta = renderRepositoryContext(repositoryContextSnapshot(context), before)
    expect(delta).toContain('Backend 19')
    expect(delta).not.toContain('Backend 18')
    expect(delta).toContain('Removed sources (revoke prior facts): AGENTS.md')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
