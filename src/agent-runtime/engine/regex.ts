import { Script } from 'node:vm'
import { EngineError } from './contracts.js'

const matchScript = new Script('new RegExp(pattern).exec(text)', { filename: 'core-bounded-pattern' })
export const PATTERN_TIMEOUT_MS = 50
/**
 * Attempts per match. The VM timeout is wall-clock: a garbage-collection pause or
 * a descheduled thread on a loaded machine can exceed it while a simple pattern
 * runs. A catastrophic pattern times out on every attempt, so one retry keeps the
 * bound (at most 2 × 50 ms) without failing a cheap match on scheduler noise.
 */
export const PATTERN_ATTEMPTS = 2

type Run = (pattern: string, text: string) => RegExpExecArray | null
const runInVm: Run = (pattern, text) => matchScript.runInNewContext({ pattern, text }, {
  timeout: PATTERN_TIMEOUT_MS, contextCodeGeneration: { strings: false, wasm: false },
}) as RegExpExecArray | null
const timedOut = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'

/** Regex is data in a constant script. V8 interrupts even catastrophic matching. `run` is a test seam. */
export function capturePattern(pattern: string, text: string, run: Run = runInVm): Array<string | undefined> | null {
  if (pattern.length > 200) throw new EngineError('invalid_expression', 'Pattern exceeds 200 characters')
  const input = text.slice(0, 32_000)
  for (let attempt = 1; ; attempt++) {
    try {
      const match = run(pattern, input)
      return match ? Array.from(match) : null
    } catch (error) {
      if (timedOut(error) && attempt < PATTERN_ATTEMPTS) continue
      throw new EngineError('invalid_expression', timedOut(error) ? `Regular expression exceeded ${PATTERN_TIMEOUT_MS} ms` : 'Invalid regular expression')
    }
  }
}

export function matchesPattern(pattern: string, text: string): boolean { return capturePattern(pattern, text) !== null }
