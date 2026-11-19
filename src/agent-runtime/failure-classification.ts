/**
 * Structured failure classification (contract 5.8, capability `failureClassification`).
 *
 * A terminal `failed` or `blocked` run reports WHY it stopped in one typed record so a host
 * can offer a remedy without parsing prose. The classifier is a pure function of signals the
 * run already produced (status, the failing step, error codes and messages); it never invents
 * a cause. Anything it cannot tie to a documented signal is `unknown` with `confidence: 'low'`.
 */
export const FAILURE_KINDS = ['tests_failed', 'provider_limit', 'environment', 'blocked', 'timeout', 'tool_inactivity', 'crash', 'incomplete_tasks', 'spec_invalid', 'workflow_protocol', 'unknown'] as const
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
  /** `provider_limit` only: ISO-8601 reset time reported by the provider's typed usage-limit event (contract 5.14). */
  resetsAt?: string
  /** One short plain sentence taken from the run's own error; bounded, redacted upstream. */
  detail?: string
  /** The step a `runtime resume` continues from, when resuming can help. */
  resumablePhase?: string
  /** `incomplete_tasks` only (contract 5.15): the approved tasks still unticked, as the run named them. */
  incompleteTasks?: string[]
  /** `workflow_protocol` only (contract 5.16): the role whose turn skipped the required OpenSpec steps. */
  role?: string
  /** `workflow_protocol` only (contract 5.16): the provider and, when configured, the model that skipped them. */
  provider?: string
  model?: string
  /** `workflow_protocol` only (contract 5.16): the skipped steps (`load_skill`, `instructions tasks|apply`). */
  missingSteps?: string[]
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
  /** Engine 2 completion of a run that ended at a failure `end` node (contract 5.15): its reasons and host blocker. */
  completion?: { reasons?: unknown; blocker?: unknown } | null
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
const RESETS = /\b(?:resets?|try again)\s+(?:at\s+)?((?:in\s+)?[^\n·(]*?\d[^\n·(]*?)(\s*\([^)]*\))?(?=\s*(?:\(error|[.,;]\s|\n|$))/i
export function providerLimitReset(message: string): string | undefined {
  const match = RESETS.exec(message)
  if (!match) return undefined
  const value = `${match[1].trim()}${match[2] ? ` ${match[2].trim()}` : ''}`.trim().replace(/[.,;:]+$/, '')
  return value && value.length <= 80 ? value : undefined
}

const PROVIDER_LIMIT = /\byou(?:'|’)?ve (?:hit|reached) your (?:session|usage|weekly|daily|monthly|plan)?\s*limit\b|\berror type rate_limit\b|\bHTTP 429\b|\b429 Too Many Requests\b|\brate[ _-]?limit(?:ed|s)? (?:exceeded|reached|hit)\b|\brate_limit_error\b|\binsufficient_quota\b|\busage limit (?:reached|exceeded)\b|\bRESOURCE_EXHAUSTED\b|\bquota (?:exceeded|exhausted)\b/i
/**
 * A provider refused the turn on its usage limit (typed `provider_limit`, or
 * the provider's own sentence on an execution failure). Nothing about the
 * work is wrong: the step must be retried after the reset, never routed to
 * the workflow's failure end.
 */
export function isProviderLimitError(code: string, message: string): boolean {
  return code === 'provider_limit' || (code === 'provider_execution_error' && PROVIDER_LIMIT.test(message))
}
/** `… usage limit reached (five_hour window, resets 2026-11-18T03:00:00.000Z)` written by the CLI executor. */
const TYPED_RESET = /usage limit reached \([^)]*?\bresets (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\)/
/** The provider CLI is signed out or its credentials expired: the person must sign in again; retrying cannot help. */
const PROVIDER_AUTH_TEXT = /Failed to authenticate|Run `?claude auth login|Please run \/login|Invalid API key|authentication_error|OAuth token (?:has )?expired|Not logged in|codex login/i
const ENVIRONMENT_CODES = new Set(['verification_host_precondition', 'verification_nondeterministic_output', 'verification_execution_error'])
const ENVIRONMENT_TEXT = /Verification cannot run in this environment|Verification output is not deterministic|\(verification_nondeterministic_output\)|setup command .* failed|could not undo them|outside the repository scope/i
// A verification command stopped by its own limits is not the agent going quiet, whatever words the stop reason uses.
const VERIFICATION_TIMEOUT_TEXT = /Verification command (?:timed out|produced no output)|verification deadline exhausted/i
const IDLE_CODES = new Set(['idle_timeout'])
const IDLE_TEXT = /\bidle timeout\b|no tool call, reply or usage for|no output for \d/i
const TIMEOUT_CODES = new Set(['timeout', 'verification_timeout'])
const TIMEOUT_TEXT = /total execution limit|active-duration budget exhausted|execution timed out|reached its time budget/i
const CRASH_CODES = new Set(['lease_lost', 'storage_corrupt', 'provider_request_error', 'incomplete_response', 'terminal_conflict'])
const CRASH_TEXT = /execution failed \(exit \d+\)|exited without a successful final result|lost its endpoint|process exited|\bcrashed\b|\bSIGKILL\b|\bSIGSEGV\b/i
const TESTS_TEXT = /Correction loop stopped: .*(?:verif|check|test|fail)|verification (?:failed|did not pass)|failing (?:tests|checks)|(?:tests?|checks?) (?:are |is )?failing|(?:tests?|checks?) failed/i
const BLOCKED_CODES = new Set(['baseline_characterization_failed', 'budget_exhausted', 'retry_exhausted', 'recover_required', 'recovery_ambiguous'])
const BLOCKED_TEXT = /correction limit reached|continuation limit reached|reviewer rejected the same change|could not make progress|Run budget is exhausted|\(baseline_characterization_failed\)/i
const CORRECTION_STEP = /(?:^|[/.:])(?:fixer|fix|correct)/i
// End-node reasons of a definition's failure exits (contract 5.15). The sentences are the
// documented end reasons of the implementation recipes, not guesses at free prose.
const INCOMPLETE_TEXT = /approved tasks (?:are )?still incomplete|tasks? (?:are |is )?still (?:incomplete|unchecked)|incomplete_tasks/i
const SPEC_INVALID_TEXT = /still fails OpenSpec validation|fails? the plan contract|OpenSpec could not archive change/i
const HOST_BLOCKER_TEXT = /\b(?:Developer|Fixer|Unblock) reported a host blocker\b|^Host blocker \(/im
const STALLED_TEXT = /Implementation attempt limit reached|Automatic correction made no candidate changes/i
const TASK_LIMIT = 20, TASK_TEXT_LIMIT = 300
// A role ended its turn (and its corrective turn) without the required OpenSpec workflow
// steps (contract 5.16). Core writes this sentence; the trailing model clause is 5.16+.
const WORKFLOW_PROTOCOL_CODE = 'openspec_workflow_omitted'
const WORKFLOW_PROTOCOL_TEXT = /Required OpenSpec role workflow was not executed: (\S+) must execute \S+ \(missing ([^)]*)\)(?:; the \S+ model \(([^)/\s]+)(?:\/([^)\s]+))?\))?/

/** The role, skipped steps and model a workflow-protocol failure names, with a plain detail sentence. */
function workflowProtocol(haystack: string): Partial<FailureClassification> {
  const match = WORKFLOW_PROTOCOL_TEXT.exec(haystack)
  if (!match) return { detail: 'The model skipped the required OpenSpec steps even after a corrective reminder.' }
  const [, role, missing, provider, model] = match
  const missingSteps = missing!.split(',').map(item => item.trim()).filter(Boolean).slice(0, 4)
  const who = provider ? ` (${provider}${model ? '/' + model : ''})` : ''
  return { role, ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(missingSteps.length ? { missingSteps } : {}),
    detail: detailOf(`The ${role} model${who} skipped the required OpenSpec steps${missingSteps.length ? ` (${missingSteps.join(', ')})` : ''} even after a corrective reminder.`) }
}

/** The `Incomplete: [...]` list an end reason carries (a JSON array of task texts), bounded. */
function incompleteTasksOf(message: string): string[] | undefined {
  const start = message.indexOf('Incomplete: [')
  if (start < 0) return undefined
  const from = start + 'Incomplete: '.length
  // A task text may itself contain "]": try each closing bracket until the array parses.
  for (let end = message.indexOf(']', from); end >= 0; end = message.indexOf(']', end + 1)) {
    let value: unknown
    try { value = JSON.parse(message.slice(from, end + 1)) } catch { continue }
    if (!Array.isArray(value)) return undefined
    const tasks = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, TASK_LIMIT).map(item => item.trim().slice(0, TASK_TEXT_LIMIT))
    return tasks.length ? tasks : undefined
  }
  return undefined
}

/** The failure `end` node a definition stopped at, from the compact step map (`kind: 'end'`). */
function endNodeOf(steps: FailureSignals['steps']): string | undefined {
  for (const [id, step] of Object.entries(steps ?? {})) if (step && step.kind === 'end' && text(step.status) === 'succeeded') return id
  return undefined
}

function detailOf(message: string): string | undefined {
  const flat = message.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT - 1)}…` : flat
}

/** An attempt a restart cut off (`owner_lost`): the run resumed past it, so it is history, not a cause. */
const OWNER_LOST = 'owner_lost'
const isCause = (error: unknown, skipOwnerLost: boolean): boolean => !skipOwnerLost || messageOf(error).code !== OWNER_LOST

function failingPhase(signals: FailureSignals, skipOwnerLost = false): { phase?: string; message: string; code: string } {
  const recent = (signals.recentFailures ?? []).find(item => item && typeof item.nodePath === 'string' && ['failed', 'blocked', 'interrupted'].includes(text(item.status)) && isCause(item.error, skipOwnerLost))
  if (recent) {
    const { code, message } = messageOf(recent.error)
    return { phase: recent.nodePath as string, message, code }
  }
  const entries = Object.entries(signals.steps ?? {}).filter(([, step]) => step && ['failed', 'blocked', 'interrupted'].includes(text(step.status)) && isCause(step.error, skipOwnerLost))
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
  // A run that reached a failure `end` node has no error: its completion reasons say why.
  const reasons = Array.isArray(signals.completion?.reasons) ? signals.completion!.reasons.filter((item): item is string => typeof item === 'string' && item !== 'unverified') : []
  const ended = reasons.join('\n')
  // An attempt a restart interrupted is never the cause when the run itself errored
  // or ended later for its own reason; only with no other signal does it explain the failure.
  const step = failingPhase(signals, top.message !== '' || ended !== '' || failingPhase(signals, true).message !== '')
  // The run-level error names the cause; the failing attempt's own error is the fallback.
  const code = top.code || step.code
  const message = top.message || step.message || ended
  const haystack = `${top.message}\n${step.message}\n${ended}`
  const phase = step.phase ?? endNodeOf(signals.steps) ?? (typeof signals.nextStep === 'string' && signals.nextStep ? signals.nextStep : undefined)
  const rounds = correctionRounds(signals.steps)
  const base = { ...(phase ? { phase } : {}), ...(rounds ? { rounds } : {}) }
  const detail = detailOf(message)
  const resumable = phase ? { resumablePhase: typeof signals.nextStep === 'string' && signals.nextStep ? signals.nextStep : phase } : {}
  const done = (kind: FailureKind, extra: Partial<FailureClassification> = {}, resume = false): FailureClassification =>
    ({ kind, ...base, ...(detail ? { detail } : {}), ...(resume ? resumable : {}), ...extra, confidence: kind === 'unknown' ? 'low' : 'high' })

  // A failure `end` node's own reason is authoritative over words quoted inside it (a
  // developer summary may mention "tests failed" or a "rate limit" it read in the code).
  if (!top.message && (ended || signals.completion?.blocker)) {
    if (signals.completion?.blocker || HOST_BLOCKER_TEXT.test(ended)) return done('environment', {}, true)
    if (INCOMPLETE_TEXT.test(ended)) {
      const incompleteTasks = incompleteTasksOf(ended)
      return done('incomplete_tasks', incompleteTasks ? { incompleteTasks } : {})
    }
    if (SPEC_INVALID_TEXT.test(ended)) return done('spec_invalid')
    if (STALLED_TEXT.test(ended)) return done('blocked')
  }
  if (code === 'provider_limit' || PROVIDER_LIMIT.test(haystack)) {
    // The executor's typed refusal names the window's reset as an ISO time; the
    // provider's own wording (`resetAt`) is read from the rest of the message.
    const resetsAt = TYPED_RESET.exec(haystack)?.[1]
    const resetAt = providerLimitReset(haystack.replace(TYPED_RESET, 'usage limit reached'))
    return done('provider_limit', { ...(resetAt ? { resetAt } : {}), ...(resetsAt && Number.isFinite(Date.parse(resetsAt)) ? { resetsAt: new Date(resetsAt).toISOString() } : {}) }, true)
  }
  if (code === WORKFLOW_PROTOCOL_CODE || WORKFLOW_PROTOCOL_TEXT.test(haystack)) return done('workflow_protocol', workflowProtocol(haystack), true)
  if (code === 'verification_timeout' || VERIFICATION_TIMEOUT_TEXT.test(haystack)) return done('timeout', {}, true)
  if (IDLE_CODES.has(code) || IDLE_TEXT.test(haystack)) return done('tool_inactivity', {}, true)
  if (TIMEOUT_CODES.has(code) || TIMEOUT_TEXT.test(haystack)) return done('timeout', {}, true)
  if (code === 'baseline_characterization_failed' || /\(baseline_characterization_failed\)/.test(haystack)) return done('blocked')
  if (PROVIDER_AUTH_TEXT.test(haystack)) return done('environment', {}, true)
  if (ENVIRONMENT_CODES.has(code) || ENVIRONMENT_TEXT.test(haystack)) return done('environment', {}, true)
  if (BLOCKED_CODES.has(code) || BLOCKED_TEXT.test(haystack)) return done('blocked', {}, true)
  if (TESTS_TEXT.test(haystack) || (code === 'verification_failed')) return done('tests_failed', {}, signals.status === 'blocked')
  if (CRASH_CODES.has(code) || CRASH_TEXT.test(haystack)) return done('crash', {}, true)
  return done('unknown', {}, false)
}
