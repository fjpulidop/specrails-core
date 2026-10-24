import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PipelineContext } from '../../pipeline/pipeline-state.js'
import { blastRadiusFiles, detectBaseline, nonTestEdits, readBaselineRecord, validateBaselinePlan, writeBaselineRecord } from './baseline.js'
import { CAPABILITY_MAP_PATH, changeCapabilities, qualifiedPath, readCapabilityMap } from './capability-map.js'

let root: string
let context: PipelineContext
const change = 'touch-search'
function write(relative: string, text: string): void {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const design = (radius: string[]) => `# Design\n## Blast radius\n${radius.join('\n')}\n## Non-Goals\n- None.\n`
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'baseline '))
  context = { artifactRoot: path.join(root, 'app'), backlogRoot: path.join(root, 'backlog'), runId: 'run-1', artifactRepositoryId: 'app',
    repositories: [{ id: 'app', name: 'App', path: path.join(root, 'app') }, { id: 'api', name: 'API', path: path.join(root, 'api') }] } as PipelineContext
  for (const file of ['app/src/search/rank.ts', 'app/src/search/index.ts', 'app/src/billing/invoice.ts', 'app/src/legacy.ts', 'api/server/routes.ts', 'app/src/search/rank.test.ts', 'app/README.md']) write(file, '// code\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('blast radius', () => {
  it('reads backticked paths, bare bullet paths and repository-qualified paths', () => {
    expect(blastRadiusFiles(context, design([
      '- `src/search/rank.ts`: ranking changes', '- src/billing/invoice.ts — totals', '- `api:server/routes.ts` and `src/search/index.ts`', '- the whole thing', '- `unknown:x.ts`',
    ]))).toEqual([
      { repositoryId: 'app', path: 'src/search/rank.ts' }, { repositoryId: 'app', path: 'src/billing/invoice.ts' },
      { repositoryId: 'api', path: 'server/routes.ts' }, { repositoryId: 'app', path: 'src/search/index.ts' }, { repositoryId: 'app', path: 'unknown:x.ts' },
    ])
    expect(blastRadiusFiles(context, '# Design\n## Decisions\n- `src/a.ts`\n')).toEqual([])
  })
})

describe('detectBaseline', () => {
  const plan = (radius: string[]) => write(`app/openspec/changes/${change}/design.md`, design(radius))
  const radius = ['- `src/search/rank.ts`', '- `src/billing/invoice.ts`', '- `src/legacy.ts`', '- `api:server/routes.ts`', '- `src/search/rank.test.ts`', '- `README.md`', '- `src/search/new-file.ts`']

  it('marks every existing code file uncovered without a map or specs, skipping tests, docs and new files', () => {
    plan(radius)
    expect(detectBaseline(context, change)).toEqual({
      blastRadius: ['src/search/rank.ts', 'src/billing/invoice.ts', 'src/legacy.ts', 'api:server/routes.ts', 'src/search/rank.test.ts', 'README.md', 'src/search/new-file.ts'],
      covered: [], uncovered: ['src/search/rank.ts', 'src/billing/invoice.ts', 'src/legacy.ts', 'api:server/routes.ts'], skipped: ['src/search/rank.test.ts', 'README.md', 'src/search/new-file.ts'],
    })
  })

  it('treats files of the capability map and paths or specific directories named in specs as covered', () => {
    plan(radius)
    write('app/' + CAPABILITY_MAP_PATH, JSON.stringify({ schemaVersion: 1, capabilities: { api: { files: ['api:server/routes.ts'], changes: ['old'] } } }))
    write('app/openspec/specs/search/spec.md', '### Requirement: Rank\nRanking lives in `src/search/`.\n')
    write('app/openspec/specs/billing/spec.md', '### Requirement: Invoices\nImplemented in src/billing/invoice.ts and other src/ files.\n')
    expect(detectBaseline(context, change)).toMatchObject({ covered: ['src/search/rank.ts', 'src/billing/invoice.ts', 'api:server/routes.ts'], uncovered: ['src/legacy.ts'] })
  })

  it('ignores a malformed capability map', () => {
    write('app/' + CAPABILITY_MAP_PATH, '{"schemaVersion":7}')
    expect(readCapabilityMap(context)).toEqual({ schemaVersion: 1, capabilities: {} })
    expect(qualifiedPath(context, 'app', 'a.ts')).toBe('a.ts')
    expect(qualifiedPath(context, 'api', 'a.ts')).toBe('api:a.ts')
  })
})

describe('baseline plan and stage', () => {
  it('requires a Baseline task group and an ADDED as-built requirement', () => {
    write(`app/openspec/changes/${change}/tasks.md`, '## 1. Change\n- [ ] 1.1 Rank by date\n')
    expect(() => validateBaselinePlan(context, change)).toThrow(/^Invalid baseline plan: .*Baseline.*ADDED/)
    write(`app/openspec/changes/${change}/tasks.md`, '## 0. Baseline\n- [ ] 0.1 Characterize src/legacy.ts\n## 1. Change\n- [ ] 1.1 Rank by date\n')
    write(`app/openspec/changes/${change}/specs/legacy/spec.md`, '## ADDED Requirements\n### Requirement: Legacy totals\nThe system SHALL sum.\n')
    expect(() => validateBaselinePlan(context, change)).not.toThrow()
    expect(changeCapabilities(path.join(root, 'app/openspec/changes', change))).toEqual(['legacy'])
  })

  it('allows only test files in the baseline stage', () => {
    expect(nonTestEdits(['src/legacy.test.ts', 'tests/helpers/fixture.ts', 'test_legacy.py', 'src/legacy.ts', 'package.json'])).toEqual(['src/legacy.ts', 'package.json'])
  })

  it('round-trips the host record', () => {
    expect(readBaselineRecord(context)).toBeNull()
    const record = writeBaselineRecord(context, { change, status: 'failed', detection: { blastRadius: [], covered: [], uncovered: ['src/legacy.ts'], skipped: [] }, tests: ['src/legacy.test.ts'], receiptId: 'r1', reason: 'fails' })
    expect(readBaselineRecord(context)).toEqual(record)
  })
})
