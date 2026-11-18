/**
 * Provider usage-limit reports → the provider-neutral `RateLimitInfo`.
 * Pure and tolerant: a malformed report yields null, never a guess. Shared by
 * the session drivers and the CLI executors so a run and a session describe
 * the same account state with the same words.
 */
import type { RateLimitInfo, RateLimitStatus, RateLimitWindow } from './session/domain/types.js'

type Frame = Record<string, unknown>

const STATUSES: ReadonlySet<string> = new Set(['allowed', 'allowed_warning', 'rejected'])
const WINDOW_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
const MAX_WINDOWS = 16
/** Window lengths Claude names but does not state. */
const CLAUDE_WINDOW_MINUTES: Readonly<Record<string, number>> = Object.freeze({ five_hour: 300, seven_day: 10_080 })

function record(value: unknown): Frame | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Frame : undefined
}
function text(value: unknown, max = 64): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}
function fraction(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}
/** Epoch seconds (or an ISO string) → ISO-8601; null for anything else. */
function iso(value: unknown): string | null {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null
}
function status(value: unknown): RateLimitStatus | null {
  return typeof value === 'string' && STATUSES.has(value) ? value as RateLimitStatus : null
}

/**
 * Claude Code `rate_limit_event.rate_limit_info` (also carried by an API error's
 * `rate_limit_info`). `resetsAt` is epoch seconds, `utilization` a 0..1 fraction.
 */
export function claudeRateLimit(raw: unknown): RateLimitInfo | null {
  const info = record(raw)
  const state = status(info?.status)
  if (!info || !state) return null
  const windows: Record<string, RateLimitWindow> = {}
  for (const [id, value] of Object.entries(record(info.unifiedWindows) ?? {}).slice(0, MAX_WINDOWS)) {
    const window = record(value)
    if (!window || !WINDOW_ID.test(id)) continue
    windows[id] = { utilization: fraction(window.utilization), resetsAt: iso(window.resetsAt), ...(CLAUDE_WINDOW_MINUTES[id] ? { windowMinutes: CLAUDE_WINDOW_MINUTES[id] } : {}) }
  }
  const type = text(info.rateLimitType)
  const rateLimitType = type && WINDOW_ID.test(type) ? type : null
  const overageStatus = status(info.overageStatus)
  const inUse = info.isUsingOverage === true || info.overageInUse === true
  const hasOverage = overageStatus !== null || inUse || info.overageDisabledReason !== undefined
  return {
    status: state,
    rateLimitType,
    resetsAt: iso(info.resetsAt) ?? (rateLimitType ? windows[rateLimitType]?.resetsAt ?? null : null),
    utilization: fraction(info.utilization) ?? (rateLimitType ? windows[rateLimitType]?.utilization ?? null : null),
    windows,
    overage: hasOverage ? { status: overageStatus, inUse, disabledReason: text(info.overageDisabledReason), resetsAt: iso(info.overageResetsAt) } : null,
  }
}

/**
 * Codex app-server `account/rateLimits/updated` (and `account/rateLimits/read`)
 * `rateLimits`: `primary`/`secondary` windows with `usedPercent` (0..100),
 * `windowDurationMins` and `resetsAt` (epoch seconds). `rateLimitReachedType`
 * is set while the account is refused.
 */
export function codexRateLimit(raw: unknown): RateLimitInfo | null {
  const limits = record(raw)
  if (!limits) return null
  const group = text(limits.limitId) ?? 'codex'
  const windows: Record<string, RateLimitWindow> = {}
  for (const slot of ['primary', 'secondary']) {
    const window = record(limits[slot])
    const id = `${group}:${slot}`
    if (!window || !WINDOW_ID.test(id)) continue
    const used = fraction(window.usedPercent)
    const minutes = typeof window.windowDurationMins === 'number' && Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : undefined
    windows[id] = { utilization: used === null ? null : used / 100, resetsAt: iso(window.resetsAt), ...(minutes ? { windowMinutes: minutes } : {}) }
  }
  const ids = Object.keys(windows)
  if (ids.length === 0) return null
  const reached = text(limits.rateLimitReachedType)
  // The binding window: the one the provider names, else the fullest.
  const named = reached ? ids.find((id) => id.endsWith(`:${reached}`)) : undefined
  const fullest = [...ids].sort((a, b) => (windows[b]!.utilization ?? -1) - (windows[a]!.utilization ?? -1))[0]!
  const binding = named ?? fullest
  return {
    status: reached ? 'rejected' : 'allowed',
    rateLimitType: binding,
    resetsAt: windows[binding]!.resetsAt,
    utilization: windows[binding]!.utilization,
    windows,
    overage: null,
  }
}

/** The account is refused right now. */
export function isRejected(info: RateLimitInfo | null | undefined): boolean {
  return info?.status === 'rejected' && info.overage?.status !== 'allowed' && info.overage?.status !== 'allowed_warning' && info.overage?.inUse !== true
}

/** "five_hour window, resets 2026-11-18T03:00:00.000Z" for an error message. */
export function describeRateLimit(info: RateLimitInfo): string {
  const window = info.rateLimitType ? `${info.rateLimitType} window` : 'usage window'
  return info.resetsAt ? `${window}, resets ${info.resetsAt}` : window
}
