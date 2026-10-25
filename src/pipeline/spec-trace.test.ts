import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activeChanges, literalReaches, readChangeDelta, readSpecRequirements, renderTraceReport, requirementSlug, runSpecTraceCli, scanTags, touchedRequirements, traceSpecs, traceSummary,
  type TraceCommand,
} from './spec-trace.js'

let root: string
function write(relative: string, text: string): void {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const requirement = (name: string, body = 'The system SHALL behave.') => `### Requirement: ${name}\n${body}\n\n#### Scenario: Works\n- **WHEN** used\n- **THEN** it works\n\n`
const passing = (args: string[] = ['test']): TraceCommand => ({ repositoryId: 'app', command: 'npm', args, exitCode: 0 })
const repositories = () => [{ id: 'app', root }]

beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'spec trace ')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('requirement ids', () => {
  it.each([
    ['Single undecided delivery', 'single-undecided-delivery'],
    ['Pausa con pregunta: ¿qué ocurre?', 'pausa-con-pregunta-que-ocurre'],
    ['  Ünïcödé —  & symbols / OK!! ', 'unicode-symbols-ok'],
    ['API v2 (beta) -- limits', 'api-v2-beta-limits'],
    ['Ça marche', 'ca-marche'],
  ])('slugs %j as %s', (name, slug) => {
    expect(requirementSlug(name)).toBe(slug)
  })

  it('reads requirements from every capability spec with stable ids', () => {
    write('openspec/specs/rail-delivery/spec.md', '# rail-delivery\n## Requirements\n' + requirement('Single undecided delivery') + requirement('Café opening'))
    write('openspec/specs/search/spec.md', requirement('Exclude archived projects'))
    expect(readSpecRequirements(root).map(item => [item.id, item.line])).toEqual([
      ['rail-delivery/single-undecided-delivery', 3], ['rail-delivery/cafe-opening', 10], ['search/exclude-archived-projects', 1],
    ])
  })
})

describe('test tags', () => {
  it('reads title tags and previous-line comments in any language', () => {
    expect(scanTags([
      "it('[spec:search/exclude-archived] hides archived projects', () => {",
      '  // spec: search/page-size',
      'def test_page_size():',
      '# spec: Search/Python-Tag',
      'test("two [spec:a/b] and [spec:c/d]")',
      '-- spec: sql/query',
    ].join('\n'))).toEqual([
      { tag: 'search/exclude-archived', line: 1, form: 'title' },
      { tag: 'search/page-size', line: 2, form: 'comment' },
      { tag: 'search/python-tag', line: 4, form: 'comment' },
      { tag: 'a/b', line: 5, form: 'title' }, { tag: 'c/d', line: 5, form: 'title' },
      { tag: 'sql/query', line: 6, form: 'comment' },
    ])
  })
})

describe('traceSpecs', () => {
  beforeEach(() => {
    write('openspec/specs/search/spec.md', requirement('Exclude archived projects') + requirement('Page size') + requirement('Sort order'))
    write('src/search.test.ts', "// spec: search/exclude-archived-projects\nit('hides archived', () => {})\nit('[spec:search/page-size] pages by 25', () => {})\n")
    write('tests/test_search.py', '# spec: search/sort-order\ndef test_sort():\n    pass\n')
    write('node_modules/pkg/index.test.js', '// spec: search/sort-order\n')
  })

  it('reports two of three demonstrated across two languages when one file is not run', () => {
    const report = traceSpecs({ specsRoot: root, repositories: repositories(), receipt: { id: 'r1', commands: [passing(['run', 'vitest', 'src/search.test.ts'])] }, reaches: literalReaches })
    expect(traceSummary(report)).toBe('Requirements demonstrated 2/3')
    expect(report.demonstrated.map(item => item.id)).toEqual(['search/exclude-archived-projects', 'search/page-size'])
    expect(report.undemonstrated).toEqual([{ id: 'search/sort-order', name: 'Sort order', reason: 'not-executed', tests: [{ repositoryId: 'app', file: 'tests/test_search.py', line: 1 }] }])
    expect(report).toMatchObject({ evidence: 'receipt', receiptId: 'r1', requirements: 3, scannedFiles: 2 })
  })

  it('counts both languages once every test file runs', () => {
    const report = traceSpecs({ specsRoot: root, repositories: repositories(), receipt: { commands: [passing(['test']), { repositoryId: 'app', command: 'pytest', args: ['tests'], exitCode: 0 }] } })
    expect(traceSummary(report)).toBe('Requirements demonstrated 3/3')
  })

  it('treats a missing receipt as no evidence, and a failing command as failed', () => {
    expect(traceSpecs({ specsRoot: root, repositories: repositories() })).toMatchObject({ evidence: 'none', demonstrated: [] })
    expect(traceSpecs({ specsRoot: root, repositories: repositories(), testsPassed: true }).demonstrated).toHaveLength(3)
    const failed = traceSpecs({ specsRoot: root, repositories: repositories(), receipt: { commands: [{ ...passing(), exitCode: 1 }] } })
    expect(failed.undemonstrated.map(item => item.reason)).toEqual(['failed', 'failed', 'failed'])
  })

  it('reports untested requirements and tags that match no requirement', () => {
    write('openspec/specs/search/spec.md', requirement('Exclude archived projects') + requirement('Page size') + requirement('Sort order') + requirement('Highlight matches'))
    write('src/typo.spec.ts', "it('[spec:search/hightlight-matches] highlights', () => {})\n")
    const report = traceSpecs({ specsRoot: root, repositories: repositories(), testsPassed: true })
    expect(report.undemonstrated).toEqual([{ id: 'search/highlight-matches', name: 'Highlight matches', reason: 'no-test', tests: [] }])
    expect(report.untagged).toEqual([{ tag: 'search/hightlight-matches', line: 1, form: 'title', repositoryId: 'app', file: 'src/typo.spec.ts' }])
  })

  it('restricts discovery to configured globs and adds explicit plan files', () => {
    write('qa/checks.ts', '// spec: search/sort-order\n')
    const report = traceSpecs({ specsRoot: root, repositories: repositories(), testGlobs: ['src/**/*.test.ts'], testFiles: [{ repositoryId: 'app', file: 'qa/checks.ts' }], testsPassed: true })
    expect(report.scannedFiles).toBe(2)
    expect(report.demonstrated.map(item => item.id)).toEqual(['search/exclude-archived-projects', 'search/page-size', 'search/sort-order'])
  })
})

describe('change deltas', () => {
  beforeEach(() => {
    write('openspec/specs/search/spec.md', requirement('Exclude archived projects') + requirement('Page size') + requirement('Legacy ranking'))
    write('openspec/changes/search-v2/specs/search/spec.md', [
      '## ADDED Requirements', requirement('Highlight matches'),
      '## MODIFIED Requirements', requirement('Page size', 'The system SHALL page by 50.'),
      '## REMOVED Requirements', '### Requirement: Legacy ranking', '**Reason**: replaced', '',
      '## RENAMED Requirements', '- FROM: `### Requirement: Exclude archived projects`', '- TO: `### Requirement: Hide archived projects`', '',
    ].join('\n'))
    write('src/search.test.ts', "it('[spec:search/highlight-matches] highlights', () => {})\nit('[spec:search/exclude-archived-projects] old tag', () => {})\n")
  })

  it('reads added, modified, removed and renamed requirements', () => {
    const delta = readChangeDelta(root, 'search-v2')
    expect(delta.added.map(item => item.id)).toEqual(['search/highlight-matches'])
    expect(delta.modified.map(item => item.id)).toEqual(['search/page-size'])
    expect(delta.removed).toEqual(['search/legacy-ranking'])
    expect(delta.renamed.map(item => [item.from, item.to.id])).toEqual([['search/exclude-archived-projects', 'search/hide-archived-projects']])
    expect(touchedRequirements(root, 'search-v2')).toEqual(['search/hide-archived-projects', 'search/highlight-matches', 'search/page-size'])
    expect(activeChanges(root)).toEqual(['search-v2'])
  })

  it('treats a tag of a renamed requirement as untagged and the new name as undemonstrated', () => {
    const report = traceSpecs({ specsRoot: root, changes: ['search-v2'], repositories: repositories(), testsPassed: true })
    expect(report.requirements).toBe(3)
    expect(report.untagged.map(tag => tag.tag)).toEqual(['search/exclude-archived-projects'])
    expect(report.touched).toEqual(['search/hide-archived-projects', 'search/highlight-matches', 'search/page-size'])
    expect(report.touchedUndemonstrated).toEqual(['search/hide-archived-projects', 'search/page-size'])
    expect(renderTraceReport(report)).toContain('Touched by search-v2: 1/3 demonstrated')
  })

  it('finds an archived change by name', () => {
    write('openspec/changes/archive/2026-10-01-old-change/specs/search/spec.md', '## ADDED Requirements\n' + requirement('Page size'))
    expect(touchedRequirements(root, 'old-change')).toEqual(['search/page-size'])
  })
})

describe('pipeline trace CLI', () => {
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = []
    const code = await runSpecTraceCli(args, { stdout: text => out.push(text), stderr: text => err.push(text) })
    return { code, out: out.join(''), err: err.join('') }
  }
  beforeEach(() => {
    write('openspec/specs/search/spec.md', requirement('Page size'))
    write('openspec/changes/add-highlight/specs/search/spec.md', '## ADDED Requirements\n' + requirement('Highlight matches'))
    write('src/search.test.ts', "it('[spec:search/page-size] pages', () => {})\n")
  })

  it('reports and never fails in normal mode', async () => {
    const result = await run(['--root', root, '--tests-passed'])
    expect(result).toMatchObject({ code: 0 })
    expect(result.out).toContain('Requirements demonstrated 1/2')
    expect((await run(['--root', root, '--context', path.join(root, 'missing.json')])).code).toBe(0)
  })

  it('fails --check when a touched requirement is not demonstrated and passes once it is tagged', async () => {
    const failing = await run(['--root', root, '--check', '--tests-passed'])
    expect(failing.code).toBe(1)
    expect(failing.err).toContain('search/highlight-matches')
    write('src/highlight.test.ts', "// spec: search/highlight-matches\nit('highlights', () => {})\n")
    const json = await run(['--root', root, '--check', '--tests-passed', '--json', '--out', path.join(root, 'report.json')])
    expect(json.code).toBe(0)
    expect(JSON.parse(json.out)).toMatchObject({ touched: ['search/highlight-matches'], touchedUndemonstrated: [] })
    expect(JSON.parse(readFileSync(path.join(root, 'report.json'), 'utf8')).demonstrated).toHaveLength(2)
  })

  it('reads the receipt of a run through its pipeline context', async () => {
    const backlog = path.join(root, 'backlog')
    write('backlog/.specrails/pipeline/run-7/state.json', JSON.stringify({ change: 'add-highlight', verification: { id: 'receipt-7', commands: [{ repositoryId: 'app', command: 'npx', args: ['vitest', 'run', 'src/search.test.ts'], cwd: root, exitCode: 0 }] } }))
    write('context.json', JSON.stringify({ artifactRoot: root, backlogRoot: backlog, runId: 'run-7', repositories: [{ id: 'app', path: root }] }))
    const result = await run(['--context', path.join(root, 'context.json'), '--json'])
    expect(JSON.parse(result.out)).toMatchObject({ evidence: 'receipt', receiptId: 'receipt-7', changes: ['add-highlight'], touchedUndemonstrated: ['search/highlight-matches'] })
    expect((await run(['--context', path.join(root, 'context.json'), '--check'])).code).toBe(1)
  })

  it('rejects unknown options only as a warning outside --check', async () => {
    expect((await run(['--root', root, '--bogus'])).code).toBe(0)
    expect((await run(['--root', root, '--bogus', '--check'])).code).toBe(1)
  })
})
