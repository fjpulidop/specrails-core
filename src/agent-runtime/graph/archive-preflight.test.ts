import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeArchivePreflight, previewOpenSpecArchive, requirementsWithoutKeyword } from './archive-preflight.js'
import { openSpecPieces } from '../engine/pieces/openspec.js'
import type { PieceExecutionContext } from '../engine/contracts.js'
import type { PieceDependencies } from '../engine/pieces/ports.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const scenario = '#### Scenario: Works\n- **WHEN** called\n- **THEN** it works\n'
// The second requirement wraps its SHALL onto the next line, as an existing main spec did in the field.
const mainSpec = `# api Specification\n\n## Purpose\nAPI rules.\n\n## Requirements\n### Requirement: Errors\n\nFailures SHALL use the error envelope.\n\n${scenario}\n### Requirement: Write boundary\n\nWhen writes are enabled, the gateway\nSHALL authorize every mutation.\n\n${scenario}`

function project(delta: string, main = mainSpec): string {
  const root = mkdtempSync(path.join(tmpdir(), 'archive preflight ')); roots.push(root)
  const change = path.join(root, 'openspec/changes/versions')
  mkdirSync(path.join(root, 'openspec/specs/api'), { recursive: true }); mkdirSync(path.join(change, 'specs/api'), { recursive: true })
  writeFileSync(path.join(root, 'openspec/specs/api/spec.md'), main)
  writeFileSync(path.join(change, 'proposal.md'), '## Why\nVersion lessons.\n## What Changes\nAdd error codes.\n## Capabilities\n### Modified Capabilities\n- api: new codes.\n## Impact\nAPI.\n')
  writeFileSync(path.join(change, 'tasks.md'), '- [ ] 1. Add the codes\n')
  writeFileSync(path.join(change, 'specs/api/spec.md'), delta)
  return root
}
const modifiedErrors = `## MODIFIED Requirements\n### Requirement: Errors\n\nFailures SHALL use the error envelope and stale_version.\n\n${scenario}`
const tree = (root: string) => readdirSync(path.join(root, 'openspec'), { recursive: true }).map(String).sort()

describe('OpenSpec archive preflight', () => {
  it('finds requirements whose first body line lacks SHALL or MUST', () => {
    expect(requirementsWithoutKeyword(mainSpec)).toEqual([{ line: 17, requirement: 'Write boundary' }])
    expect(requirementsWithoutKeyword('### Requirement: Id\n**ID**: R1\nThe API SHALL respond.\n')).toEqual([{ line: 2, requirement: 'Id' }])
    expect(requirementsWithoutKeyword('### Requirement: Header only\n#### Scenario: x\n')).toEqual([{ line: 1, requirement: 'Header only' }])
  })

  it('reports a change that validates but whose rebuilt main spec cannot be archived, without touching the project', async () => {
    const root = project(modifiedErrors), before = tree(root), spec = readFileSync(path.join(root, 'openspec/specs/api/spec.md'), 'utf8')
    const preflight = await previewOpenSpecArchive(root, 'versions')
    expect(preflight).toMatchObject({ valid: false, findings: [{ path: 'openspec/specs/api/spec.md', line: 17, requirement: 'Write boundary' }] })
    expect(preflight.valid === false && preflight.reason).toContain('Requirement must contain SHALL or MUST keyword')
    expect(tree(root)).toEqual(before)
    expect(readFileSync(path.join(root, 'openspec/specs/api/spec.md'), 'utf8')).toBe(spec)
    const text = describeArchivePreflight('versions', preflight as Extract<typeof preflight, { valid: false }>)
    expect(text).toContain('openspec/specs/api/spec.md:17 "Write boundary"')
    expect(text).toContain('## MODIFIED Requirements')
  })

  it('passes once the delta restates the broken requirement with SHALL on its first line', async () => {
    const fixed = `${modifiedErrors}\n### Requirement: Write boundary\n\nWhen writes are enabled, the gateway SHALL authorize every mutation.\n\n${scenario}`
    expect(await previewOpenSpecArchive(project(fixed), 'versions')).toEqual({ valid: true })
  })

  it('sends the planner back from validate with the archive reason in history', async () => {
    const root = project(modifiedErrors)
    const deps = { context: { artifactRepositoryId: 'repo', artifactRoot: root } } as unknown as PieceDependencies
    const validate = openSpecPieces(() => deps).find(piece => piece.descriptor.kind === 'openspec-validate')!
    const context = { signal: new AbortController().signal, frame: { attemptId: 'a1', transition: 3, attempt: 1, nodePath: 'validate' } } as unknown as PieceExecutionContext
    const result = await validate.execute({ change: 'versions' }, context)
    expect(result).toMatchObject({ outcome: 'fail', output: { archivePreflight: { valid: false } } })
    expect(result.history?.[0]).toMatchObject({ id: 'a1:archive-preflight', nodePath: 'validate', text: expect.stringContaining('"Write boundary"') })
  })
})
