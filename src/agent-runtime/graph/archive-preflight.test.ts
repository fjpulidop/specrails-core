import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeArchivePreflight, legacyMainSpecs, previewOpenSpecArchive } from './archive-preflight.js'
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

  it('tells the planner to move ADDED requirements off a legacy main spec it cannot repair', async () => {
    const legacy = '# Architecture\n\nHigh-level components.\n\n## Goals\n\n- CLI first.\n'
    const added = `## ADDED Requirements\n### Requirement: Docker startup\n\nThe backend SHALL start in Docker.\n\n${scenario}`
    const preflight = await previewOpenSpecArchive(project(added, legacy), 'versions')
    expect(preflight).toMatchObject({ valid: false })
    const reason = (preflight as Extract<typeof preflight, { valid: false }>).reason
    expect(legacyMainSpecs(reason)).toEqual(['api'])
    const text = describeArchivePreflight('versions', preflight as Extract<typeof preflight, { valid: false }>)
    expect(text).toContain('openspec/specs/api/spec.md predates OpenSpec')
    expect(text).toContain('openspec/changes/versions/specs/<new-capability>/spec.md')
    expect(text).not.toContain('MODIFIED and RENAMED headers')
  })

  describe('legacy main specs, against the pinned OpenSpec CLI output', () => {
    const added = `## ADDED Requirements\n### Requirement: Docker startup\n\nThe backend SHALL start in Docker.\n\n${scenario}`
    const failed = async (root: string) => {
      const preflight = await previewOpenSpecArchive(root, 'versions')
      expect(preflight).toMatchObject({ valid: false })
      return (preflight as Extract<typeof preflight, { valid: false }>).reason
    }
    function twoTargets(mainA: string, mainB: string): string {
      const root = project(added, mainA)
      mkdirSync(path.join(root, 'openspec/specs/web'), { recursive: true }); mkdirSync(path.join(root, 'openspec/changes/versions/specs/web'), { recursive: true })
      writeFileSync(path.join(root, 'openspec/specs/web/spec.md'), mainB)
      writeFileSync(path.join(root, 'openspec/changes/versions/specs/web/spec.md'), added.replace('Docker startup', 'Web startup'))
      return root
    }

    it('names a spec missing both sections', async () => {
      expect(legacyMainSpecs(await failed(project(added, '# Architecture\n\nFree form.\n\n## Goals\n\n- CLI first.\n')))).toEqual(['api'])
    })

    it('names a spec with ## Requirements but no ## Purpose', async () => {
      expect(legacyMainSpecs(await failed(project(added, `# api\n\n## Requirements\n### Requirement: Old\n\nIt SHALL be old.\n\n${scenario}`)))).toEqual(['api'])
    })

    it('archives a spec with ## Purpose but no ## Requirements, so nothing is classified', async () => {
      expect(await previewOpenSpecArchive(project(added, '# api\n\n## Purpose\nAPI rules for every client of the service.\n'), 'versions')).toEqual({ valid: true })
    })

    it('names a free-form spec whose requirement headers sit outside ## Requirements', async () => {
      const reason = await failed(project(added, `# api\n\nFree form.\n\n### Requirement: Old\n\nIt is old.\n\n${scenario}`))
      expect(reason).toContain('target spec is structurally invalid')
      expect(legacyMainSpecs(reason)).toEqual(['api'])
    })

    it('does not classify a well-formed spec whose requirement has no SHALL body', async () => {
      const reason = await failed(project(added, `# api\n\n## Purpose\nAPI rules.\n\n## Requirements\n### Requirement: Old\n\n${scenario}`))
      expect(reason).toContain('must contain SHALL or MUST')
      expect(legacyMainSpecs(reason)).toEqual([])
      expect(describeArchivePreflight('versions', { valid: false, reason })).toContain('MODIFIED and RENAMED headers')
    })

    it('names the first of two legacy targets (OpenSpec stops there) and asks the planner to check the rest', async () => {
      const reason = await failed(twoTargets('# Architecture\n\nFree.\n', '# Web\n\nFree too.\n'))
      expect(legacyMainSpecs(reason)).toEqual(['api'])
      expect(describeArchivePreflight('versions', { valid: false, reason })).toContain('check every other main spec you target')
      // Both blocks in one output (a future OpenSpec reporting every spec) are both named.
      const second = reason.replace(/\bapi\b/g, 'web')
      expect(legacyMainSpecs(`${reason}\n${second}`)).toEqual(['api', 'web'])
    })

    it('still names the spec when the archive output exceeds the 2000 characters kept in reason', async () => {
      const reason = await failed(project(added, '# Architecture\n\nFree form.\n'))
      const long = `${'Proposal warning: lorem ipsum dolor sit amet\n'.repeat(80)}${reason}`.slice(-2000)
      expect(long).toHaveLength(2000)
      expect(legacyMainSpecs(long)).toEqual(['api'])
      // The reason repeats the CLI output (stdout, then the error that quotes it), so the
      // last copy survives the cut. Cut through its header, nothing is named and the
      // generic advice applies.
      expect(legacyMainSpecs(reason.slice(reason.lastIndexOf('rebuilt spec for') + 5))).toEqual([])
    })
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
