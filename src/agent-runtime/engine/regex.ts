import { Script } from 'node:vm'
import { EngineError } from './contracts.js'

const matchScript = new Script('new RegExp(pattern).exec(text)', { filename: 'core-bounded-pattern' })

/** Regex is data in a constant script. V8 interrupts even catastrophic matching. */
export function capturePattern(pattern: string, text: string): Array<string | undefined> | null {
  if (pattern.length > 200) throw new EngineError('invalid_expression', 'Pattern exceeds 200 characters')
  try {
    const match = matchScript.runInNewContext({ pattern, text: text.slice(0, 32_000) }, {
      timeout: 50, contextCodeGeneration: { strings: false, wasm: false },
    }) as RegExpExecArray | null
    return match ? Array.from(match) : null
  } catch (error) {
    throw new EngineError('invalid_expression', error !== null && typeof error === 'object' && 'code' in error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      ? 'Regular expression exceeded 50 ms' : 'Invalid regular expression')
  }
}

export function matchesPattern(pattern: string, text: string): boolean { return capturePattern(pattern, text) !== null }
