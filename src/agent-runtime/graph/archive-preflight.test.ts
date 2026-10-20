import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeArchivePreflight, previewOpenSpecArchive } from './archive-preflight.js'
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
// Delta validation accepts this; archive cannot find the main-spec requirement it modifies.
const modifiedMissing = `## MODIFIED Requirements\n### Requirement: Error codes\n\nFailures SHALL use the error envelope and stale_version.\n\n${scenario}`
const modifiedErrors = `## MODIFIED Requirements\n### Requirement: Errors\n\nFailures SHALL use the error envelope and stale_version.\n\n${scenario}`
const tree = (root: string) => readdirSync(path.join(root, 'openspec'), { recursive: true }).map(String).sort()

describe('OpenSpec archive preflight', () => {
  it('reports a change that validates but cannot be archived, without touching the project', async () => {
    const root = project(modifiedMissing), before = tree(root), spec = readFileSync(path.join(root, 'openspec/specs/api/spec.md'), 'utf8')
    const preflight = await previewOpenSpecArchive(root, 'versions')
    expect(preflight).toMatchObject({ valid: false })
    expect(preflight.valid === false && preflight.reason).toContain('MODIFIED failed for header "### Requirement: Error codes" - not found')
    expect(tree(root)).toEqual(before)
    expect(readFileSync(path.join(root, 'openspec/specs/api/spec.md'), 'utf8')).toBe(spec)
    const text = describeArchivePreflight('versions', preflight as Extract<typeof preflight, { valid: false }>)
    expect(text).toContain('archiving it would fail')
    expect(text).toContain('MODIFIED and RENAMED headers must name an existing requirement exactly')
  })

  it('passes once the delta modifies an existing requirement, including one whose SHALL wraps', async () => {
    expect(await previewOpenSpecArchive(project(modifiedErrors), 'versions')).toEqual({ valid: true })
  })

  it('sends the planner back from validate with the archive reason in history', async () => {
    const root = project(modifiedMissing)
    const deps = { context: { artifactRepositoryId: 'repo', artifactRoot: root } } as unknown as PieceDependencies
    const validate = openSpecPieces(() => deps).find(piece => piece.descriptor.kind === 'openspec-validate')!
    const context = { signal: new AbortController().signal, frame: { attemptId: 'a1', transition: 3, attempt: 1, nodePath: 'validate' } } as unknown as PieceExecutionContext
    const result = await validate.execute({ change: 'versions' }, context)
    expect(result).toMatchObject({ outcome: 'fail', output: { archivePreflight: { valid: false } } })
    expect(result.history?.[0]).toMatchObject({ id: 'a1:archive-preflight', nodePath: 'validate', text: expect.stringContaining('"### Requirement: Error codes" - not found') })
  })
})
