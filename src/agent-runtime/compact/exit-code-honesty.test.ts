import { describe, expect, it } from 'vitest'
import { exitCodeContradiction, exitHonestyReason } from './exit-code-honesty.js'

describe('exit-code honesty', () => {
  it.each(['non-404 failures', 'handles 3 failed requests', 'retries after 2 failures'])('ignores passing TAP test names: %s', name => {
    const output = `TAP version 13\n# Subtest: ${name}\nok 522 - ${name}\n# tests 598\n# pass 598\n# fail 0\n`
    expect(exitCodeContradiction(0, output)).toBeNull()
  })
  it.each([
    'Received 404 failures from upstream',
    'ok 1 - 3 failed',
    '✓ handles 500 failures',
    '# Subtest: 3 failed',
    'Tests: handles 404 failures',
    'this test 404 failures',
    '0 failed (handles 404 failures)',
    '3 failed requests',
    '-404 failures',
    '0.404 failures',
    'not ok 1 - pending feature # TODO implement later',
    'not ok 2 - optional dependency # SKIP unavailable',
  ])('does not treat prose or test descriptions as a summary: %s', output => {
    expect(exitCodeContradiction(0, output)).toBeNull()
  })
  it.each([
    '# fail 3',
    'Tests: 3 failed, 12 passed, 15 total',
    'Test Files  3 failed | 2 passed (5)',
    '3 failing',
    '15 tests, 3 failures',
    '\u001b[31m3 failed\u001b[0m',
    '3 failing (12ms)',
    'Tests: 2 passing, 3 failing',
    '3 failed, 2 passed (0.5s)',
  ])('recognizes runner failure summaries: %s', output => {
    expect(exitCodeContradiction(0, output)).toMatchObject({ failures: 3 })
  })
  it('does not allow a green suite to erase an explicit failed test or another failing suite', () => {
    expect(exitCodeContradiction(0, 'not ok 2 - broken\n0 failed\n')).not.toBeNull()
    expect(exitCodeContradiction(0, '# fail 3\n# fail 0\n')).toMatchObject({ failures: 3 })
  })
  it('does not interpret a partial line at the tail boundary', () => {
    const output = '# Subtest: ' + 'x'.repeat(16_000) + '3 failed\n'
    expect(exitCodeContradiction(0, output)).toBeNull()
  })
  it('keeps a complete failure summary at the tail boundary', () => {
    const tail = '3 failed\n' + 'x'.repeat(15_991)
    expect(exitCodeContradiction(0, 'discarded\n' + tail)).toMatchObject({ failures: 3 })
    expect(exitCodeContradiction(0, 'test name ' + tail)).toBeNull()
    expect(exitCodeContradiction(0, 'x'.repeat(16_001))).toBeNull()
  })
  it('handles Windows lines and colors without inventing failure counts', () => {
    expect(exitCodeContradiction(0, '\u001b[32m# Subtest: non-404 failures\u001b[0m\r\nok 1 - non-404 failures\r\n# fail 0\r\n')).toBeNull()
    expect(exitCodeContradiction(0, '\u001b[31mTests: 3 failed\u001b[0m\r\n')).toMatchObject({ failures: 3 })
  })
  it('keeps real failures even when their names contain unrelated numbers', () => {
    expect(exitCodeContradiction(0, 'not ok 1 - handles 404 failures\n# fail 1\n')).toMatchObject({ failures: 1 })
  })
  it.each(['FAIL', 'FAILED', 'FAIL: broken', 'not ok 1 - broken', '✗ broken'])('preserves explicit failure markers despite a green suite: %s', marker => {
    expect(exitCodeContradiction(0, marker + '\n0 failed\n')).not.toBeNull()
  })
  it('suppresses expected exception diagnostics only with a zero-failure summary', () => {
    expect(exitCodeContradiction(0, 'AssertionError: expected diagnostic\n# fail 0\n')).toBeNull()
    expect(exitCodeContradiction(0, 'AssertionError: broken\nok 1 - 0 failed\n')).not.toBeNull()
  })
  it.each([1, -1, null])('leaves exit status %s to the normal verification gate', status => {
    expect(exitCodeContradiction(status, 'FAIL: broken\n3 failed')).toBeNull()
  })
  it('flags the observed shape: FAIL lines and "3 failed" with exit 0', () => {
    const out = 'Browser UI tests: 58 passed, 0 failed\nFAIL: 1.2: initial button icon is 🔊\nFAIL: 1.2: button icon changes to 🔇\nUI tests: 39 passed, 3 failed\n'
    const found = exitCodeContradiction(0, out)
    expect(found).toMatchObject({ failures: 3 })
    expect(found!.sample).toContain('FAIL: 1.2: initial button icon')
    expect(exitHonestyReason([{ ...found!, command: 'npm test' }])).toMatch(/`npm test` exited 0 but its output reports 3 failing tests/)
  })
  it('stays silent on a real pass, a non-zero exit, and green summaries that mention "0 failed"', () => {
    expect(exitCodeContradiction(0, 'Browser UI tests: 58 passed, 0 failed\nAll suites green\n')).toBeNull()
    expect(exitCodeContradiction(1, 'FAIL: x\n1 failed\n')).toBeNull()
    expect(exitCodeContradiction(0, 'Tests: 12 passed, 12 total\n')).toBeNull()
    expect(exitCodeContradiction(0, '')).toBeNull()
  })
  it('flags a bare AssertionError or ✗ line without a count', () => {
    expect(exitCodeContradiction(0, 'running\nAssertionError: expected 1 to be 2\n')).toMatchObject({ failures: null })
    expect(exitCodeContradiction(0, '  ✗ renders the board\n')).toMatchObject({ failures: null })
  })
  it('does not mistake prose that contains the word FAILED mid-sentence', () => {
    expect(exitCodeContradiction(0, 'Note: retries are enabled so a flaky step is never marked failed twice.\n2 passed, 0 failed\n')).toBeNull()
  })
})
