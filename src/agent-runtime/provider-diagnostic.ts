import { stripVTControlCharacters } from 'node:util'
/** Keep provider errors visible without dumping full output, prompts or credentials. */
export function providerDiagnostic(stdout: string, stderr: string, env: NodeJS.ProcessEnv = process.env): string {
  let message = ''
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'turn.failed' || event.type === 'error') message = typeof event.error?.message === 'string' ? event.error.message : typeof event.message === 'string' ? event.message : message
    } catch { /* Non-protocol output is not a diagnostic. */ }
  }
  if (!message) message = stderr.trim().slice(-3000)
  try { const parsed = JSON.parse(message); if (typeof parsed.error?.message === 'string') message = `${parsed.error.code ?? parsed.error.type ?? 'provider_error'}: ${parsed.error.message}` } catch { /* Plain error message. */ }
  message = stripVTControlCharacters(message)
  for (const [key, value] of Object.entries(env)) if (/(token|secret|password|api_?key|credential)/i.test(key) && value && value.length >= 4) message = message.split(value).join('[redacted]')
  return message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|(?:access[_-]?)?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, text => { try { const url = new URL(text); return url.origin + url.pathname } catch { return '[url]' } })
    .replace(/\s+/g, ' ').slice(0, 1200).trim()
}
