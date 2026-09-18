import { describe, expect, it } from 'vitest'
import { exitCodeContradiction, exitHonestyReason } from './exit-code-honesty.js'

describe('exit-code honesty', () => {
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
