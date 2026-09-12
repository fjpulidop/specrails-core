import type { RuntimeConfig } from '../executor-types.js'
import { object } from './artifacts.js'
import type { ReviewRecord } from './state.js'

export const REVIEW_ASPECTS = ['type_correctness', 'pattern_adherence', 'test_coverage', 'security', 'architectural_alignment'] as const
export type ReviewAspect = typeof REVIEW_ASPECTS[number]
export interface ReviewPolicy {
  /** Minimum overall score for approval, 0–100. */
  minScore: number
  /** Minimum per-aspect score for approval, 0–100. */
  aspects: Record<ReviewAspect, number>
}
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  minScore: 70,
  aspects: { type_correctness: 60, pattern_adherence: 60, test_coverage: 60, security: 75, architectural_alignment: 60 },
}

/** Project thresholds override the defaults per field; unset fields keep the default gate. */
export function resolveReviewPolicy(config: Pick<RuntimeConfig, 'review'>): ReviewPolicy {
  return {
    minScore: config.review?.minScore ?? DEFAULT_REVIEW_POLICY.minScore,
    aspects: { ...DEFAULT_REVIEW_POLICY.aspects, ...(config.review?.aspects ?? {}) },
  }
}

/** Validates the reviewer's structured reply and applies the gate. Throws `Invalid …` for a malformed reply. */
export function evaluateReview(raw: Record<string, unknown>, policy: ReviewPolicy): { record: ReviewRecord; approved: boolean } {
  if (typeof raw.approved !== 'boolean' || typeof raw.summary !== 'string'
    || !Array.isArray(raw.issues) || !raw.issues.every(item => typeof item === 'string')
    || typeof raw.score !== 'number' || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 100) throw new Error('Invalid structured review')
  const aspects = object(raw.aspects)
  const scored: Record<string, number> = {}
  for (const name of REVIEW_ASPECTS) {
    const value = aspects[name]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('Invalid review aspect: ' + name)
    scored[name] = value
  }
  const approved = raw.approved && raw.issues.length === 0 && raw.score >= policy.minScore
    && REVIEW_ASPECTS.every(name => scored[name]! >= policy.aspects[name])
  return { record: { approved: raw.approved, summary: raw.summary, issues: raw.issues as string[], score: raw.score, aspects: scored }, approved }
}
