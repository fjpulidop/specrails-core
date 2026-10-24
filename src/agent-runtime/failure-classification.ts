/**
 * Structured failure classification (contract 5.8, capability `failureClassification`).
 *
 * A terminal `failed` or `blocked` run reports WHY it stopped in one typed record so a host
 * can offer a remedy without parsing prose. The classifier is a pure function of signals the
 * run already produced (status, the failing step, error codes and messages); it never invents
 * a cause. Anything it cannot tie to a documented signal is `unknown` with `confidence: 'low'`.
 */
export const FAILURE_KINDS = ['tests_failed', 'provider_limit', 'environment', 'blocked', 'timeout', 'tool_inactivity', 'crash', 'unknown'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]
export const FAILURE_CONFIDENCE = ['high', 'low'] as const

export interface FailureClassification {
  kind: FailureKind
  /** The step (engine 1) or node path (engine 2) that stopped the run. */
  phase?: string
  /** Correction rounds the run spent before it stopped (visits of the correction step). */
  rounds?: number
  /** `provider_limit` only: the provider's own wording of when it resets ("3am (Europe/Madrid)"), never reformatted. */
  resetAt?: string
  /** One short plain sentence taken from the run's own error; bounded, redacted upstream. */
  detail?: string
  /** The step a `runtime resume` continues from, when resuming can help. */
  resumablePhase?: string
  confidence: (typeof FAILURE_CONFIDENCE)[number]
}

export interface FailureSignals {
  status: string
  /** Run-level error: engine 1 sends a string, engine 2 `{code, message}`. */
  error?: unknown
  /** Engine 1 step records or engine 2 compact step map, keyed by step id / node path. */
  steps?: Record<string, { status?: unknown; visits?: unknown; error?: unknown; kind?: unknown } | undefined>
  /** Engine 2 `recentFailures`, newest first. */
  recentFailures?: Array<{ nodePath?: unknown; status?: unknown; visit?: unknown; error?: unknown } | undefined>
  nextStep?: unknown
}

const DETAIL_LIMIT = 280
const text = (value: unknown): string => typeof value === 'string' ? value : ''

function messageOf(error: unknown): { code: string; message: string } {
  if (typeof error === 'string') return { code: '', message: error }
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown }
    return { code: text(record.code), message: text(record.message) }
  }
  return { code: '', message: '' }
}

/** The provider's own "resets 3am (Europe/Madrid)" hint, when the message carries one. */
const RESETS = /\bresets?\s+(?:at\s+|in\s+)?([^\n·(]*?\d[^\n·(]*?)(\s*\([^)]*\))?(?=\s*(?:\(error|[.,;]\s|\n|$))/i
export function providerLimitReset(message: string): string | undefined {
  const match = RESETS.exec(message)
  if (!match) return undefined
  const value = `${match[1].trim()}${match[2] ? ` ${match[2].trim()}` : ''}`.trim().replace(/[.,;:]+$/, '')
  return value && value.length <= 80 ? value : undefined
}

const PROVIDER_LIMIT = /\byou(?:'|’)?ve (?:hit|reached) your (?:session|usage|weekly|daily|monthly|plan)?\s*limit\b|\berror type rate_limit\b|\bHTTP 429\b|\b429 Too Many Requests\b|\brate[ _-]?limit(?:ed|s)? (?:exceeded|reached|hit)\b|\brate_limit_error\b|\binsufficient_quota\b|\busage limit (?:reached|exceeded)\b|\bRESOURCE_EXHAUSTED\b|\bquota (?:exceeded|exhausted)\b/i
const ENVIRONMENT_CODES = new Set(['verification_host_precondition', 'verification_nondeterministic_output', 'verification_execution_error'])
const ENVIRONMENT_TEXT = /Verification cannot run in this environment|Verification output is not deterministic|\(verification_nondeterministic_output\)|setup command .* failed|could not undo them|outside the repository scope/i
const IDLE_CODES = new Set(['idle_timeout'])
const IDLE_TEXT = /\bidle timeout\b|no tool call, reply or usage for|no output for \d/i
const TIMEOUT_CODES = new Set(['timeout'])
const TIMEOUT_TEXT = /total execution limit|active-duration budget exhausted|execution timed out|reached its time budget/i
const CRASH_CODES = new Set(['lease_lost', 'storage_corrupt', 'provider_request_error', 'incomplete_response', 'terminal_conflict'])
const CRASH_TEXT = /execution failed \(exit \d+\)|exited without a successful final result|lost its endpoint|process exited|\bcrashed\b|\bSIGKILL\b|\bSIGSEGV\b/i
const TESTS_TEXT = /Correction loop stopped: .*(?:verif|check|test|fail)|verification (?:failed|did not pass)|failing (?:tests|checks)|(?:tests?|checks?) (?:are |is )?failing|(?:tests?|checks?) failed/i
const BLOCKED_CODES = new Set(['baseline_characterization_failed', 'budget_exhausted', 'retry_exhausted', 'recover_required', 'recovery_ambiguous'])
const BLOCKED_TEXT = /correction limit reached|continuation limit reached|reviewer rejected the same change|could not make progress|Run budget is exhausted|\(baseline_characterization_failed\)/i
const CORRECTION_STEP = /(?:^|[/.:])(?:fixer|fix|correct)/i

function detailOf(message: string): string | undefined {
  const flat = message.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT - 1)}…` : flat
}

function failingPhase(signals: FailureSignals): { phase?: string; message: string; code: string } {
  const recent = (signals.recentFailures ?? []).find(item => item && typeof item.nodePath === 'string' && ['failed', 'blocked', 'interrupted'].includes(text(item.status)))
  if (recent) {
    const { code, message } = messageOf(recent.error)
    return { phase: recent.nodePath as string, message, code }
  }
  const entries = Object.entries(signals.steps ?? {}).filter(([, step]) => step && ['failed', 'blocked', 'interrupted'].includes(text(step.status)))
  const [id, step] = entries[0] ?? []
  if (id && step) return { phase: id, ...(() => { const { code, message } = messageOf(step.error); return { code, message } })() }
  return { message: '', code: '' }
}

function correctionRounds(steps: FailureSignals['steps']): number | undefined {
  let visits = 0
  for (const [id, step] of Object.entries(steps ?? {})) {
    if (!step || !CORRECTION_STEP.test(id)) continue
    const count = typeof step.visits === 'number' && Number.isFinite(step.visits) ? step.visits : 0
    visits += count
  }
  return visits > 0 ? visits : undefined
}

/**
 * Classify a terminal result. Returns `undefined` for any status other than `failed` or
 * `blocked`: a succeeded, paused or cancelled run has nothing to diagnose.
 */
export function classifyFailure(signals: FailureSignals): FailureClassification | undefined {
  if (signals.status !== 'failed' && signals.status !== 'blocked') return undefined
  const top = messageOf(signals.error)
  const step = failingPhase(signals)
  // The run-level error names the cause; the failing attempt's own error is the fallback.
  const code = top.code || step.code
  const message = top.message || step.message
  const haystack = `${top.message}\n${step.message}`
  const phase = step.phase ?? (typeof signals.nextStep === 'string' && signals.nextStep ? signals.nextStep : undefined)
  const rounds = correctionRounds(signals.steps)
  const base = { ...(phase ? { phase } : {}), ...(rounds ? { rounds } : {}) }
  const detail = detailOf(message)
  const resumable = phase ? { resumablePhase: typeof signals.nextStep === 'string' && signals.nextStep ? signals.nextStep : phase } : {}
  const done = (kind: FailureKind, extra: Partial<FailureClassification> = {}, resume = false): FailureClassification =>
    ({ kind, ...base, ...(detail ? { detail } : {}), ...(resume ? resumable : {}), ...extra, confidence: kind === 'unknown' ? 'low' : 'high' })

  if (PROVIDER_LIMIT.test(haystack)) {
    const resetAt = providerLimitReset(haystack)
    return done('provider_limit', resetAt ? { resetAt } : {}, true)
  }
  if (IDLE_CODES.has(code) || IDLE_TEXT.test(haystack)) return done('tool_inactivity', {}, true)
  if (TIMEOUT_CODES.has(code) || TIMEOUT_TEXT.test(haystack)) return done('timeout', {}, true)
  if (code === 'baseline_characterization_failed' || /\(baseline_characterization_failed\)/.test(haystack)) return done('blocked')
  if (ENVIRONMENT_CODES.has(code) || ENVIRONMENT_TEXT.test(haystack)) return done('environment', {}, true)
  if (BLOCKED_CODES.has(code) || BLOCKED_TEXT.test(haystack)) return done('blocked', {}, true)
  if (TESTS_TEXT.test(haystack) || (code === 'verification_failed')) return done('tests_failed', {}, signals.status === 'blocked')
  if (CRASH_CODES.has(code) || CRASH_TEXT.test(haystack)) return done('crash', {}, true)
  return done('unknown', {}, false)
}
