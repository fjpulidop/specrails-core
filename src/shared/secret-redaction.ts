/**
 * Deterministic secret redaction for text and structured values that Core
 * persists for display (the agent session journal).
 *
 * Every pattern is bounded: quantifiers have explicit upper limits and no
 * pattern nests unbounded repetition, so the work per input character is
 * constant and a 1 MB string redacts in linear time. PEM blocks are found with
 * `indexOf`, not a regex, for the same reason.
 *
 * The rules favour leaking less over keeping every byte: a value assigned to a
 * secret-like name is replaced even when it is not a credential (for example
 * `token = readToken()` in a file read). Words that merely contain a secret
 * word are not names: `author`, `authority`, `authenticate`, `max_tokens` and
 * `tokenizer` stay readable. Bare `session` / `sessionId` are protocol
 * identifiers and are not redacted; `session_token`, `session_secret`,
 * `session_key` and `session_cookie` are.
 *
 * Known limits (documented in docs/agent-sessions/journal.md):
 * - A secret split across two separately redacted strings (for example two
 *   streamed output deltas) can leak the part after the split.
 * - Short flags such as `mysql -pSECRET` and secrets with no recognisable name
 *   or format are not detected.
 *
 * `src/pipeline/pipeline-state.ts` keeps its own self-contained
 * `redactRuntimeText` because it is copied into projects and may only use Node
 * built-ins; it is not replaced by this module.
 */

export const REDACTED = '[REDACTED]'

const MAX_PEM_BODY = 16_384

/**
 * Secret words inside a normalized (lower-case, `_`-separated) name.
 * `auth` must end a word so `author`/`authority`/`authenticate` do not match.
 * `token` must not be followed by `s`/`iz` so token counts and tokenizers stay.
 */
const SECRET_NAME = /(?:passw(?:or)?d|passphrase|secret|token(?!s|iz)|api_?key|access_?key|private_?key|signing_?key|encryption_?key|credentials?|(?:^|_)auth(?:orization)?(?:_|$)|bearer|cookie|session_(?:token|secret|key|cookie))/

/** Lower-case and split camelCase / kebab-case / dotted names into `_` words. */
function normalizeName(name: string): string {
  return name
    .slice(0, 128)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
}

/** True when a key, variable or flag name looks like it holds a secret. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(normalizeName(name))
}

// ── Inline patterns ─────────────────────────────────────────────────────────

/** Well-known credential formats, replaced wherever they appear. */
const KNOWN_FORMATS: RegExp[] = [
  // OpenAI / Anthropic style keys: sk-..., sk-proj-..., sk-ant-...; must contain a digit.
  /\bsk-(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{20,512}/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  // GitLab and npm tokens.
  /\bglpat-[A-Za-z0-9_-]{20,255}\b/g,
  /\bnpm_[A-Za-z0-9]{36,255}\b/g,
  // Slack tokens.
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,255}/g,
  /\bxapp-[A-Za-z0-9-]{10,255}/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g,
]

/** `Authorization: Bearer x`, `"authorization": "Basic x"`, `Proxy-Authorization=...`; keeps the scheme. */
const AUTHORIZATION_HEADER = /\b((?:proxy-)?authorization["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)((?:bearer|basic|token|digest|negotiate)[ \t]{1,8})?([^\s"'`,;]{1,4096})/gi

/** A standalone `Bearer <token>` (the token must be long enough not to be prose). */
const BEARER = /\b(bearer[ \t]{1,8})([A-Za-z0-9._~+/-]{16,4096}=*)/gi

/** `scheme://user:password@host` → keeps the user and host. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,256}:)([^\s/@]{1,256})(@)/gi

/**
 * `--token v`, `--api-key=v`, `--password "v"`: the flag name must END with the
 * secret word, so `--password-stdin` or `--token-file` are left alone; a value
 * starting with `-` is the next flag, not a secret.
 */
const SECRET_FLAG = /(^|[\s"'=])(--?(?:[a-z0-9]{1,24}[-_]){0,4}(?:token|api[-_]?key|apikey|password|passwd|passphrase|secret|private[-_]?key|access[-_]?key|auth|credentials?))(=|[ \t]{1,8})("[^"\n]{0,4096}"|'[^'\n]{0,4096}'|[^\s"'-][^\s"']{0,4095})/gi

/**
 * `NAME=value`, `NAME: value`, `"name": "value"`, `export NAME='v'` where the
 * name contains a secret word. The name starts at a non-name character so
 * matching is attempted only at word starts; `isSecretName` then refines it.
 */
const ASSIGNMENT = /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,127})\1([ \t]{0,4}[:=][ \t]{0,4})("[^"\n]{0,4096}"|'[^'\n]{0,4096}'|\[REDACTED\][^\s"',;&|<>(){}[\]]{1,4096}|(?![ \t]|\/\/)[^\s"',;&|<>(){}[\]]{1,4096})/g

/** Values that are not secrets even after a secret-like name (types, flags, empty literals). */
const KEPT_VALUES = new Set(['', 'true', 'false', 'null', 'undefined', 'none', 'string', 'number', 'boolean', 'unknown', 'any', 'required', 'optional'])

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g

function replaceValue(quoted: string): string {
  if (quoted.startsWith('"') && quoted.endsWith('"') && quoted.length >= 2) return `"${REDACTED}"`
  if (quoted.startsWith("'") && quoted.endsWith("'") && quoted.length >= 2) return `'${REDACTED}'`
  return REDACTED
}

/** PEM private key blocks: BEGIN..END, or BEGIN plus its base64 body when END is missing (truncated output). */
function redactPem(text: string): string {
  if (!text.includes('PRIVATE KEY-----')) return text
  let out = ''
  let cursor = 0
  // The next END marker is searched once and reused, so a text full of BEGIN
  // markers without END stays linear.
  let nextEnd = -2
  PEM_BEGIN.lastIndex = 0
  for (let match = PEM_BEGIN.exec(text); match; match = PEM_BEGIN.exec(text)) {
    const begin = match.index
    if (begin < cursor) continue
    const bodyStart = begin + match[0].length
    if (nextEnd !== -1 && nextEnd < bodyStart) nextEnd = text.indexOf('-----END ', bodyStart)
    const endMarker = nextEnd
    let stop: number
    if (endMarker >= 0 && endMarker - bodyStart <= MAX_PEM_BODY) {
      const close = text.indexOf('-----', endMarker + 9)
      stop = close >= 0 && close - endMarker <= 60 ? close + 5 : endMarker + 9
    } else {
      stop = bodyStart
      const limit = Math.min(text.length, bodyStart + MAX_PEM_BODY)
      while (stop < limit && /[A-Za-z0-9+/=\s]/.test(text[stop]!)) stop++
    }
    out += text.slice(cursor, begin) + REDACTED
    cursor = stop
    PEM_BEGIN.lastIndex = Math.max(stop, bodyStart)
  }
  return out + text.slice(cursor)
}

/**
 * Replace secrets inside free text. Idempotent: redacting a redacted string
 * returns it unchanged. Non-secret text is returned byte for byte.
 */
export function redactSecrets(text: string): string {
  if (text.length === 0) return text
  let result = redactPem(text)
  for (const pattern of KNOWN_FORMATS) result = result.replace(pattern, REDACTED)
  result = result.replace(AUTHORIZATION_HEADER, (_match, prefix: string, scheme: string | undefined) => `${prefix}${scheme ?? ''}${REDACTED}`)
  result = result.replace(BEARER, (_match, prefix: string) => `${prefix}${REDACTED}`)
  result = result.replace(URL_CREDENTIALS, (_match, prefix: string, _password: string, at: string) => `${prefix}${REDACTED}${at}`)
  result = result.replace(SECRET_FLAG, (_match, lead: string, flag: string, separator: string, value: string) => `${lead}${flag}${separator}${replaceValue(value)}`)
  result = result.replace(ASSIGNMENT, (match, quote: string, name: string, separator: string, value: string, offset: number, whole: string) => {
    if (!isSecretName(name)) return match
    const bare = value.replace(/^["']|["']$/g, '')
    if (bare === REDACTED || KEPT_VALUES.has(bare.toLowerCase()) || bare.startsWith('$')) return match
    // `Authorization: Bearer [REDACTED]` was already handled: do not take the scheme for the value.
    if (whole.slice(offset + match.length, offset + match.length + 24).trimStart().startsWith(REDACTED)) return match
    return `${quote}${name}${quote}${separator}${replaceValue(value)}`
  })
  return result
}

/**
 * Redact a JSON-like value: object entries whose key is secret-like have their
 * string leaves replaced; every other string goes through `redactSecrets`.
 * Numbers, booleans and null are kept (a numeric `max_tokens` stays readable).
 * Returns a new value; the input is not mutated. Depth is bounded.
 */
export function redactSecretsDeep<T>(value: T): T {
  return redactValue(value, false, 0) as T
}

const MAX_DEPTH = 32

function redactValue(value: unknown, secret: boolean, depth: number): unknown {
  if (typeof value === 'string') return secret ? (value.length === 0 ? value : REDACTED) : redactSecrets(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return secret ? REDACTED : value
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactValue(item, secret || isSecretName(key), depth + 1)
  }
  return out
}
