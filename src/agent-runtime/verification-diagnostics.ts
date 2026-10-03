import { stripVTControlCharacters } from 'node:util'
import type { CommandReceipt } from '../pipeline/pipeline-state.js'

/** Exact subprocess facts, not an AI diagnosis or a waiver of the failed check.
 * Separate them from source dumps, reserving space for each kind of fact. */
export function verificationFailureSummary(command: Pick<CommandReceipt, 'stdout' | 'stderr' | 'output'>): string[] {
  const source = stripVTControlCharacters([command.stdout ?? '', command.stderr ?? '', command.output].join('\n'))
  const lines = source.split('\n').map(line => line.trim())
  const groups = [
    /^(?:not ok\b|[✖✗]\s|FAIL\b)/,
    /^(?:AssertionError\b|\w*Error:|error:|code:)/,
    /^expected:/,
    /^(?:test at\b|location:|at .+:\d+(?::\d+)?\)?$)/,
  ]
  const selected = new Set<string>()
  const facts: string[] = []
  for (const pattern of groups) {
    let remaining = 750
    let count = 0
    for (const line of lines) {
      if (remaining <= 0 || count >= 3) break
      if (!pattern.test(line) || /node:internal\//.test(line) || /^[✖✗]\s+failing tests:/.test(line) || selected.has(line)) continue
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
