import { stripVTControlCharacters } from 'node:util'
import type { CommandReceipt } from '../pipeline/pipeline-state.js'

/** Shared ordering for summary facts and contextual excerpts. Input is an
 * ANSI-normalized output line; ordinary warnings and quoted source are not
 * failure anchors. Lower ranks reserve space for the actual error first. */
export function verificationDiagnosticPriority(raw: string): number | undefined {
  const line = raw.trim()
  if (/node:internal\//.test(line) || /^[✖✗]\s+failing tests:/.test(line)
    || /^(?:[✖✗]\s+)?(?:\d+\s+problems?\s+\(\s*)?0 errors?(?:,\s*\d+ warnings?)?\)?$/.test(line)) return undefined
  const compiler = /^(?!['"`]|(?:actual|expected|source):).+(?:\(\d+,\d+\)|:\d+(?::\d+)?)(?::|\s+-)?\s+(?:fatal\s+)?error\b/.test(line)
    || /^(?:fatal\s+)?error(?:\s+[A-Z][A-Z0-9]*\d+)?\s*:/.test(line)
  if (compiler || /^(?:AssertionError\b|\w*Error(?:\s+\[[^\]]+\])?:|code:)/.test(line)) return 0
  if (/^(?:not ok\b|[✖✗]\s|FAIL\b)/.test(line)) return 1
  if (/^expected:/.test(line)) return 2
  if (/^(?:test at\b|location:|at .+:\d+(?::\d+)?\)?$)/.test(line)) return 3
  return undefined
}

/** Exact subprocess facts, not an AI diagnosis or a waiver of the failed check.
 * Separate them from source dumps, reserving space for each kind of fact. */
export function verificationFailureSummary(command: Pick<CommandReceipt, 'stdout' | 'stderr' | 'output'>): string[] {
  const source = stripVTControlCharacters([command.stdout ?? '', command.stderr ?? '', command.output].join('\n'))
  const lines = source.split('\n').map(line => line.trim())
  const selected = new Set<string>()
  const facts: string[] = []
  for (const priority of [0, 1, 2, 3]) {
    let remaining = 750
    let count = 0
    for (const line of lines) {
      if (remaining <= 0 || count >= 3) break
      if (verificationDiagnosticPriority(line) !== priority || selected.has(line)) continue
      const bounded = line.slice(0, Math.min(512, remaining - 1))
      if (!bounded) break
      selected.add(line)
      facts.push(bounded)
      remaining -= bounded.length + 1
      count++
    }
  }
  return facts
}
