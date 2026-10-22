/**
 * The reviewer's risk brief: an optional, advisory companion to the verdict that
 * tells a human what changed, what the change leans on, what no test exercises
 * and where to look first. It never feeds the approval gate (review-policy.ts).
 */
export const REVIEW_BRIEF_SCHEMA_VERSION = 1
/** At most this many risks reach the brief; the rest become acceptance findings. */
export const REVIEW_BRIEF_RISK_LIMIT = 5
const LIST_LIMIT = 20
const TEXT_LIMIT = 2000

export const REVIEW_RISK_SEVERITIES = ['high', 'medium', 'low'] as const
export const REVIEW_RISK_AREAS = ['data', 'security', 'api', 'ux', 'performance', 'ops', 'other'] as const
export const REVIEW_INVARIANT_STATUSES = ['kept', 'changed', 'at-risk'] as const

export interface ReviewBehaviourChange { what: string; where: string; userVisible: boolean }
export interface ReviewInvariant { invariant: string; evidence: string; status: typeof REVIEW_INVARIANT_STATUSES[number] }
export interface ReviewUntested { path: string; why: string }
export interface ReviewRisk { severity: typeof REVIEW_RISK_SEVERITIES[number]; area: typeof REVIEW_RISK_AREAS[number]; whatToLookAt: string; ref: string }
/** Reserved for spec-divergence reporting (Phase 3); may be empty. */
export interface ReviewDivergence { capability: string; requirement: string; observed: string }
export interface ReviewBrief {
  behaviourChanges?: ReviewBehaviourChange[]
  invariantsTouched?: ReviewInvariant[]
  untested?: ReviewUntested[]
  risks?: ReviewRisk[]
  humanChecks?: string[]
  divergences?: ReviewDivergence[]
}

const text = { type: 'string', minLength: 1 }
const items = (properties: Record<string, unknown>) => ({ type: 'array', items: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } })
/** The optional `brief` property of REVIEW_OUTPUT_SCHEMA. Every list is optional and may be empty. */
export const REVIEW_BRIEF_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  description: 'Optional risk brief for the human who merges the change. Advisory only: it never changes the verdict.',
  properties: {
    behaviourChanges: items({ what: text, where: { ...text, description: 'file:line' }, userVisible: { type: 'boolean' } }),
    invariantsTouched: items({ invariant: text, evidence: { ...text, description: 'file:line or file:start-end' }, status: { type: 'string', enum: [...REVIEW_INVARIANT_STATUSES] } }),
    untested: items({ path: text, why: text }),
    risks: items({ severity: { type: 'string', enum: [...REVIEW_RISK_SEVERITIES] }, area: { type: 'string', enum: [...REVIEW_RISK_AREAS] }, whatToLookAt: text, ref: { ...text, description: 'file:line' } }),
    humanChecks: { type: 'array', items: text },
    divergences: items({ capability: text, requirement: text, observed: text }),
  },
}

class BriefError extends Error {
  constructor(detail: string) { super('Invalid review brief: ' + detail) }
}
function field(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BriefError(`${where} must be a non-empty string`)
  return value.trim().slice(0, TEXT_LIMIT)
}
function member<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new BriefError(`${where} must be one of ${allowed.join(', ')}`)
  return value as T
}
function list<T>(value: unknown, name: string, parse: (item: Record<string, unknown>, where: string) => T): T[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new BriefError(`${name} must be an array`)
  return value.map((item, index) => {
    const where = `${name}[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new BriefError(`${where} must be an object`)
    return parse(item as Record<string, unknown>, where)
  })
}

const SEVERITY_RANK: Record<ReviewRisk['severity'], number> = { high: 0, medium: 1, low: 2 }

/**
 * Validates and normalizes a reviewer brief. Absent (`undefined`/`null`) means
 * no brief; an empty object is a valid, empty brief. Risks are ordered by
 * severity (stable within a severity) and capped at REVIEW_BRIEF_RISK_LIMIT;
 * the rest are returned as `overflow`. Throws `Invalid review brief: …` when
 * malformed, which the role invoker treats as repairable.
 */
export function parseReviewBrief(value: unknown): { brief?: ReviewBrief; overflow: ReviewRisk[] } {
  if (value === undefined || value === null) return { overflow: [] }
  if (typeof value !== 'object' || Array.isArray(value)) throw new BriefError('brief must be an object')
  const raw = value as Record<string, unknown>
  const brief: ReviewBrief = {}
  const behaviourChanges = list(raw.behaviourChanges, 'behaviourChanges', (item, where) => {
    if (typeof item.userVisible !== 'boolean') throw new BriefError(`${where}.userVisible must be a boolean`)
    return { what: field(item.what, where + '.what'), where: field(item.where, where + '.where'), userVisible: item.userVisible }
  })
  const invariantsTouched = list(raw.invariantsTouched, 'invariantsTouched', (item, where) => ({
    invariant: field(item.invariant, where + '.invariant'), evidence: field(item.evidence, where + '.evidence'), status: member(item.status, REVIEW_INVARIANT_STATUSES, where + '.status'),
  }))
  const untested = list(raw.untested, 'untested', (item, where) => ({ path: field(item.path, where + '.path'), why: field(item.why, where + '.why') }))
  const risks = list(raw.risks, 'risks', (item, where) => ({
    severity: member(item.severity, REVIEW_RISK_SEVERITIES, where + '.severity'), area: member(item.area, REVIEW_RISK_AREAS, where + '.area'),
    whatToLookAt: field(item.whatToLookAt, where + '.whatToLookAt'), ref: field(item.ref, where + '.ref'),
  }))
  let humanChecks: string[] | undefined
  if (raw.humanChecks !== undefined && raw.humanChecks !== null) {
    if (!Array.isArray(raw.humanChecks)) throw new BriefError('humanChecks must be an array')
    humanChecks = raw.humanChecks.map((item, index) => field(item, `humanChecks[${index}]`))
  }
  const divergences = list(raw.divergences, 'divergences', (item, where) => ({
    capability: field(item.capability, where + '.capability'), requirement: field(item.requirement, where + '.requirement'), observed: field(item.observed, where + '.observed'),
  }))
  let overflow: ReviewRisk[] = []
  if (behaviourChanges) brief.behaviourChanges = behaviourChanges.slice(0, LIST_LIMIT)
  if (invariantsTouched) brief.invariantsTouched = invariantsTouched.slice(0, LIST_LIMIT)
  if (untested) brief.untested = untested.slice(0, LIST_LIMIT)
  if (risks) {
    const ordered = risks.map((risk, index) => ({ risk, index })).sort((a, b) => SEVERITY_RANK[a.risk.severity] - SEVERITY_RANK[b.risk.severity] || a.index - b.index).map(entry => entry.risk)
    brief.risks = ordered.slice(0, REVIEW_BRIEF_RISK_LIMIT)
    overflow = ordered.slice(REVIEW_BRIEF_RISK_LIMIT)
  }
  if (humanChecks) brief.humanChecks = humanChecks.slice(0, LIST_LIMIT)
  if (divergences) brief.divergences = divergences.slice(0, LIST_LIMIT)
  return { brief, overflow }
}

/** One acceptance finding line for a risk that did not fit in the brief. */
export function riskFinding(risk: ReviewRisk): string {
  return `Additional ${risk.severity} ${risk.area} risk (beyond the brief's top ${REVIEW_BRIEF_RISK_LIMIT}): ${risk.whatToLookAt} (${risk.ref})`
}

export interface SettledReviewBrief { brief?: ReviewBrief; overflow: ReviewRisk[]; diagnostic?: string }
/**
 * Applies the repair policy: on the first reply a malformed brief throws so the
 * role invoker spends its single repair turn; on the repaired reply it is
 * dropped with a diagnostic instead of failing the review.
 */
export function settleReviewBrief(value: unknown, options: { repairable: boolean }): SettledReviewBrief {
  try { return parseReviewBrief(value) }
  catch (error) {
    if (options.repairable) throw error
    return { overflow: [], diagnostic: `Review brief dropped after the repair turn: ${error instanceof Error ? error.message : String(error)}` }
  }
}
