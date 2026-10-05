import { describe, expect, it } from 'vitest'
import { verificationFailureSummary } from './verification-diagnostics.js'

describe('verificationFailureSummary', () => {
  it.each([
    "src/service.ts(137,36): error TS2551: Property 'NEW_ENDPOINT' does not exist",
    "src/service.ts:137:36 - error TS2551: Property 'NEW_ENDPOINT' does not exist",
    "C:\\Project Files\\service.ts:137:36: error TS2551: Property 'NEW_ENDPOINT' does not exist",
    "src/author's-view.ts(1,2): error TS2339: Property is missing",
    'src/program.c:10:3: fatal error: header.h: No such file or directory',
    "error TS18003: No inputs were found in config file 'tsconfig.json'.",
  ])('retains a compiler diagnostic: %s', line => {
    expect(verificationFailureSummary({ output: line })).toEqual([line])
  })

  it('prioritizes compiler errors over warning summaries and deduplicates ANSI-colored streams', () => {
    const error = 'src/service.ts(137,36): error TS2551: Property is missing'
    const warning = '✖ 74 problems (0 errors, 74 warnings)'
    expect(verificationFailureSummary({ stdout: warning + '\n\u001b[31m' + error + '\u001b[0m', stderr: error, output: warning + '\n' + error })).toEqual([error])
  })

  it('ignores warning diagnostics and source snippets while retaining real test failures mentioning zero errors', () => {
    const failure = 'not ok 1 - reports 0 errors for valid input'
    expect(verificationFailureSummary({ output: [
      'src/service.ts(1,2): warning TS1234: error recovery is unavailable',
      'src/service.ts:1:2: warning: fix this eventually',
      '✖ 0 errors, 3 warnings',
      'Found 0 errors. Watching for file changes.',
      'actual: "error TS2551: quoted source"',
      'actual: "src/service.ts(1,2): error TS2551: quoted source"',
      '"src/service.ts(1,2): error TS2551: quoted source"',
      failure,
    ].join('\n') })).toEqual([failure])
  })

  it('reserves bounded space for expected values and application locations after verbose compiler errors', () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts(${i + 1},1): error TS2551: ` + 'detail '.repeat(100)),
      'not ok 1 - preserves a required guard', 'AssertionError [ERR_ASSERTION]: missing guard',
      'expected: /requiredGuard/', 'at TestContext.<anonymous> (/repo/guard.test.ts:52:10)',
      'at Test.run (node:internal/test_runner/test:1:2)',
    ]
    const summary = verificationFailureSummary({ output: lines.join('\n') })
    expect(summary[0]).toContain('src/file-0.ts')
    expect(summary.join('\n')).toContain('not ok 1 - preserves a required guard')
    expect(summary.join('\n')).toContain('expected: /requiredGuard/')
    expect(summary.join('\n')).toContain('/repo/guard.test.ts:52:10')
    expect(summary.join('\n')).not.toContain('node:internal/')
    expect(summary.every(line => line.length <= 512)).toBe(true)
    expect(summary.join('\n').length).toBeLessThanOrEqual(3_000)
  })
})
