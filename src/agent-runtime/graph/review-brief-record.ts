import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pipelineStateDirectory, type PipelineContext } from '../../pipeline/pipeline-state.js'
import { write } from './artifacts.js'
import { REVIEW_BRIEF_SCHEMA_VERSION, type ReviewBrief } from './review-brief.js'

/** Host-readable record of the latest reviewer verdict's brief, rewritten at every verdict. */
export interface ReviewBriefRecord {
  schemaVersion: typeof REVIEW_BRIEF_SCHEMA_VERSION
  change: string
  approved: boolean
  score: number
  recordedAt: string
  /** Null when the reviewer sent no brief or it was dropped. */
  brief: ReviewBrief | null
  /** Present when a malformed brief was dropped after the repair turn. */
  diagnostic?: string
}
export const REVIEW_BRIEF_FILE = 'review-brief.json'
export function reviewBriefPath(context: Pick<PipelineContext, 'backlogRoot' | 'runId'>): string {
  return path.join(pipelineStateDirectory(context as PipelineContext), REVIEW_BRIEF_FILE)
}
export function writeReviewBriefRecord(context: PipelineContext, verdict: { change: string; approved: boolean; score: number; brief?: ReviewBrief; diagnostic?: string }): void {
  const record: ReviewBriefRecord = { schemaVersion: REVIEW_BRIEF_SCHEMA_VERSION, change: verdict.change, approved: verdict.approved, score: verdict.score, recordedAt: new Date().toISOString(), brief: verdict.brief ?? null, ...(verdict.diagnostic ? { diagnostic: verdict.diagnostic } : {}) }
  write(reviewBriefPath(context), JSON.stringify(record, null, 2) + '\n')
}
/** The latest recorded brief for a run, or null when no reviewer verdict was recorded (or the file is unreadable). */
export function readReviewBriefRecord(context: Pick<PipelineContext, 'backlogRoot' | 'runId'>): ReviewBriefRecord | null {
  try {
    const file = reviewBriefPath(context)
    if (!existsSync(file)) return null
    const value = JSON.parse(readFileSync(file, 'utf8')) as ReviewBriefRecord
    return value && typeof value === 'object' && value.schemaVersion === REVIEW_BRIEF_SCHEMA_VERSION ? value : null
  } catch { return null }
}
