// Exit-code honesty: a test command that PRINTS failures but exits 0.
//
// Observed: a hand-rolled `tests/ui.test.js` harness logged three `FAIL:`
// lines and "UI tests: 39 passed, 3 failed", then let the process end with
// code 0; verify reported "1 command exited 0" and the reviewer received a
// candidate with three red tests dressed as green. Verify must trust the exit
// code as the contract — but when the output itself says the contract was
// broken, the honest verdict is FAILED, with the harness named as the defect.
export interface ExitHonestyFinding { command: string; failures: number | null; sample: string }

/** Lines that only a test runner prints when something failed. Kept narrow: a green run mentions "0 failed", never `FAIL:` / `✗` / `AssertionError` / `Error:` stack heads. */
const FAILURE_LINE = /^\s*(?:FAIL(?:ED)?\b[:\s]|✗|✖|×\s|not ok\b|AssertionError\b|(?:Type|Reference|Syntax|Range)Error:)/m
const FAILED_COUNT = /\b(\d+)\s+(?:failed|failures?|failing)\b/gi
const PASS_ONLY = /\b0\s+(?:failed|failures?|failing)\b/i

/** A failure count > 0 in a summary line, or a failure-marker line, in the output of a command that exited 0. */
export function exitCodeContradiction(exitCode: number | null, output: string): ExitHonestyFinding | null {
  if (exitCode !== 0) return null
  const tail = output.slice(-16_000)
  let failures: number | null = null
  for (const match of tail.matchAll(FAILED_COUNT)) { const n = Number(match[1]); if (Number.isFinite(n) && n > 0) failures = Math.max(failures ?? 0, n) }
  const marker = FAILURE_LINE.exec(tail)
  if (failures === null && !marker) return null
  if (failures === null && marker && PASS_ONLY.test(tail) && !/^\s*FAIL(?:ED)?\b[:\s]/m.test(tail)) return null
  const sample = (marker ? tail.slice(marker.index, marker.index + 160).split('\n')[0] : tail.match(/^.*\b\d+\s+(?:failed|failures?|failing)\b.*$/im)?.[0]) ?? ''
  return { command: '', failures, sample: sample.trim() }
}

export function exitHonestyReason(findings: ReadonlyArray<ExitHonestyFinding>): string {
  const parts = findings.map(item => `\`${item.command}\` exited 0 but its output reports ${item.failures !== null ? `${item.failures} failing test${item.failures === 1 ? '' : 's'}` : 'a failure'} (${JSON.stringify(item.sample)})`)
  return `The verification command passed by exit code while reporting failures: ${parts.join('; ')}. A test runner that does not exit non-zero on failure hides broken tests: make the harness set \`process.exitCode = 1\` (or throw) when any test fails, then fix the failing tests.`
}
