import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { validatePipelineContext } from '../../../pipeline/pipeline-state.js'
import { archiveOpenSpecChange } from '../../graph/artifacts.js'
import { resolveOpenSpecCli, runOpenSpec } from '../../openspec.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it.each(['identical', 'authored-purpose', 'changed-requirement'] as const)('preserves fork archive provenance and rejects conflicting %s bytes', async variant => {
  const root = mkdtempSync(path.join(tmpdir(), 'fork archive ')); roots.push(root)
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'fork', backlogRoot: root, artifactRoot: root, artifactRepositoryId: 'repo',
    repositories: [{ id: 'repo', name: 'Repo', path: root }], specs: [{ id: 1, title: 'Value', description: 'Return two' }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' } })
  const sourceChange = 'source-change', forkChange = 'fork-change'
  for (const change of [sourceChange, forkChange]) {
    await runOpenSpec(resolveOpenSpecCli(), root, ['new', 'change', change, '--json'])
    const active = path.join(root, 'openspec/changes', change)
    mkdirSync(path.join(active, 'specs/value'), { recursive: true })
    for (const [file, content] of Object.entries({
      'proposal.md': '## Why\nReturn the required value.\n## What Changes\nUpdate the function.\n## Capabilities\n### New Capabilities\n- value: Return two.\n## Impact\nOne function.\n',
      'design.md': '## Design\nReturn two and verify the function.\n',
      'tasks.md': '- [x] 1. Implement and check the return value\n',
      'specs/value/spec.md': '## ADDED Requirements\n### Requirement: Return two\nThe function SHALL return two.\n#### Scenario: Load the function\n- **WHEN** the function is loaded\n- **THEN** its value is two\n',
    })) writeFileSync(path.join(active, file), content)
  }
  await archiveOpenSpecChange(context, sourceChange, { directory: path.join(root, 'source-journal'), beforePublish() {} })
  const spec = path.join(root, 'openspec/specs/value/spec.md')
  const original = readFileSync(spec, 'utf8')
  expect(original).toContain(`TBD - created by archiving change ${sourceChange}. Update Purpose after archive.`)
  const expected = variant === 'authored-purpose' ? original.replace(/TBD - created[^\n]+/, 'This authored purpose belongs to the original completed change.')
    : variant === 'changed-requirement' ? original.replace('SHALL return two', 'SHALL return three') : original
  if (expected !== original) writeFileSync(spec, expected)
  const before = statSync(spec)
  const directory = path.join(root, 'fork-journal')
  mkdirSync(path.join(directory, 'agent-workflow/openspec-base-specs'), { recursive: true })
  writeFileSync(path.join(directory, 'openspec-archive-base.json'), JSON.stringify({ schemaVersion: 1, snapshot: 'a'.repeat(64), directory: 'agent-workflow/openspec-base-specs', sourceChange }))
  const archive = archiveOpenSpecChange(context, forkChange, { directory, beforePublish() {} })
  if (variant === 'identical') {
    try { await archive } catch (error) { throw new Error(JSON.stringify({ original, plan: JSON.parse(readFileSync(path.join(directory, 'openspec-archive.json'), 'utf8')) }), { cause: error }) }
  }
  else await expect(archive).rejects.toThrow('Main specification changed during archive')
  expect(readFileSync(spec, 'utf8')).toBe(expected)
  expect(statSync(spec).ino).toBe(before.ino)
  expect(statSync(spec).mtimeMs).toBe(before.mtimeMs)
  expect(existsSync(path.join(root, 'openspec/changes', forkChange))).toBe(variant !== 'identical')
}, 20_000)
