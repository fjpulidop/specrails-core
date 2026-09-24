import { stripVTControlCharacters } from 'node:util'

// Exit-code honesty: a test command that PRINTS failures but exits 0.
//
// Observed: a hand-rolled `tests/ui.test.js` harness logged three `FAIL:`
// lines and "UI tests: 39 passed, 3 failed", then let the process end with
// code 0; verify reported "1 command exited 0" and the reviewer received a
// candidate with three red tests dressed as green. Verify must trust the exit
// code as the contract — but when the output itself says the contract was
// broken, the honest verdict is FAILED, with the harness named as the defect.
interface ExitHonestyFinding { command: string; failures: number | null; sample: string }

// Counts belong to runner summaries, never arbitrary prose or test names.
// In particular, TAP's "# Subtest: ... non-404 failures" is not a count.
const FAILURE_LINE = /^\s*(?:FAIL(?:ED)?\b(?:[:\s]|$)|✗|✖|×\s|not ok\b)/
const ERROR_LINE = /^\s*(?:AssertionError\b|(?:Type|Reference|Syntax|Range)Error:)/
const FAILED_COUNT = /^(\d+)\s+(?:failed|failures?|failing)$/i
const SUMMARY_LABEL = /^(?:(?:[\w -]*tests?|test files|test suites|suites)\s*:\s*|(?:tests?|test files|test suites|suites)\s+)(?=\d)/i
const SUMMARY_ITEM = /\d+\s+(?:passed|passing|failed|failures?|failing|skipped|pending|todo|cancelled|total|tests?)/gi
const TAP_FAIL = /^# fail (\d+)\s*$/
const TAP_EXPECTED_FAILURE = /^not ok\b.*\s#\s*(?:TODO|SKIP)\b/i

/** Parse the entire summary grammar before interpreting any number as a count. */
function failureCounts(line: string): number[] {
  const tap = TAP_FAIL.exec(line)
  if (tap) return [Number(tap[1])]
  // Common runner suffixes: Vitest's "(5)" and Mocha's "(12ms)".
  const body = line.replace(SUMMARY_LABEL, '').replace(/\s+\(\d+(?:\.\d+)?(?:ms|s)?\)$/, '')
  const items = [...body.matchAll(SUMMARY_ITEM)]
  if (!items.length || items[0]!.index !== 0) return []
  let end = 0
  const counts: number[] = []
  for (const item of items) {
    if (end && !/^(?:\s*[,|]\s*|\s+)$/.test(body.slice(end, item.index))) return []
    const failed = FAILED_COUNT.exec(item[0])
    if (failed) counts.push(Number(failed[1]))
    end = item.index + item[0].length
  }
  return end === body.length ? counts : []
}

function completeTail(output: string): string {
  const start = Math.max(0, output.length - 16_000)
  if (start === 0 || output[start - 1] === '\n') return output.slice(start)
  const newline = output.indexOf('\n', start)
  return newline === -1 ? '' : output.slice(newline + 1)
}

/** A failure count in a runner summary, or a failure-marker line, despite exit 0. */
export function exitCodeContradiction(exitCode: number | null, output: string): ExitHonestyFinding | null {
  if (exitCode !== 0) return null
  const clean = stripVTControlCharacters(output)
  // Do not turn the middle of a truncated test name into a summary or marker.
  const tail = completeTail(clean)
  let failures: number | null = null
  let countSample = ''
  let marker = ''
  let error = ''
  let zeroSummary = false
  for (const raw of tail.split('\n')) {
    const line = raw.trim()
    if (!marker && FAILURE_LINE.test(line) && !TAP_EXPECTED_FAILURE.test(line)) marker = line
    if (!error && ERROR_LINE.test(line)) error = line
    for (const n of failureCounts(line)) {
      if (n === 0) zeroSummary = true
      if (Number.isFinite(n) && n > 0 && n > (failures ?? 0)) { failures = n; countSample = line }
    }
  }
  // A green summary may accompany expected exception diagnostics, but cannot
  // erase an explicit failed test or another suite's positive failure count.
  const sample = marker || countSample || (!zeroSummary ? error : '')
  if (!sample) return null
  return { command: '', failures, sample: sample.slice(0, 160) }
}

export function exitHonestyReason(findings: ReadonlyArray<ExitHonestyFinding>): string {
  const parts = findings.map(item => `\`${item.command}\` exited 0 but its output reports ${item.failures !== null ? `${item.failures} failing test${item.failures === 1 ? '' : 's'}` : 'a failure'} (${JSON.stringify(item.sample)})`)
  return `The verification command passed by exit code while reporting failures: ${parts.join('; ')}. A test runner that does not exit non-zero on failure hides broken tests: make the harness set \`process.exitCode = 1\` (or throw) when any test fails, then fix the failing tests.`
}
