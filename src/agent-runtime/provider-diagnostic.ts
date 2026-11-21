import { redactRuntimeText } from '../pipeline/pipeline-state.js'
import { stripVTControlCharacters } from 'node:util'
/** Keep provider errors visible without dumping full output, prompts or credentials. */
export function providerDiagnostic(stdout: string, stderr: string, env: NodeJS.ProcessEnv = process.env): string {
  let message = ''
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'turn.failed' || event.type === 'error') message = typeof event.error?.message === 'string' ? event.error.message : typeof event.message === 'string' ? event.message : message
      // Claude reports its own failures (a session or usage limit, an expired
      // login, an API error) as the final `result` frame with `is_error` and
      // the provider's sentence in `result`.
      else if (event.type === 'result' && event.is_error === true && typeof event.result === 'string' && event.result.trim()) message = event.result
    } catch { /* Non-protocol output is not a diagnostic. */ }
  }
  if (!message) message = stderr.trim().slice(-3000)
  try { const parsed = JSON.parse(message); if (typeof parsed.error?.message === 'string') message = `${parsed.error.code ?? parsed.error.type ?? 'provider_error'}: ${parsed.error.message}` } catch { /* Plain error message. */ }
  message = stripVTControlCharacters(message)
  return redactRuntimeText(message, env).replace(/\s+/g, ' ').slice(0, 1200).trim()
}
