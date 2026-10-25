import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Ajv } from 'ajv'
import { describe, expect, it } from 'vitest'
import { codexOutputSchema, restoreOptionalFields } from '../codex-schema.js'
import { REVIEW_OUTPUT_SCHEMA } from '../prompts.js'
import { evaluateReview, DEFAULT_REVIEW_POLICY } from './review-policy.js'
import { parseReviewBrief, riskFinding, settleReviewBrief, REVIEW_BRIEF_RISK_LIMIT } from './review-brief.js'
import { readReviewBriefRecord, reviewBriefPath, writeReviewBriefRecord } from './review-brief-record.js'
import type { PipelineContext } from '../../pipeline/pipeline-state.js'

const risk = (severity: 'high' | 'medium' | 'low', n: number) => ({ severity, area: 'api' as const, whatToLookAt: `look ${n}`, ref: `src/x.ts:${n}` })
const verdict = {
  approved: true, summary: 'ok', issues: [], score: 90,
  aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 },
  acceptance: { criteria: [], checks: [], findings: [] },
}

describe('parseReviewBrief', () => {
  it('treats an absent brief as no brief and an empty object as an empty brief', () => {
    expect(parseReviewBrief(undefined)).toEqual({ overflow: [] })
    expect(parseReviewBrief(null)).toEqual({ overflow: [] })
    expect(parseReviewBrief({})).toEqual({ brief: {}, overflow: [] })
    expect(parseReviewBrief({ risks: [], humanChecks: [], divergences: null })).toEqual({ brief: { risks: [], humanChecks: [] }, overflow: [] })
  })

  it('normalizes every section and trims text', () => {
    const { brief } = parseReviewBrief({
      behaviourChanges: [{ what: ' Adds X ', where: 'src/x.ts:41', userVisible: false }],
      invariantsTouched: [{ invariant: 'Idempotent', evidence: 'src/q.ts:120-138', status: 'at-risk' }],
      untested: [{ path: 'src/x.ts', why: 'No test calls the error branch' }],
      humanChecks: ['Open the settings page'],
      divergences: [{ capability: 'auth', requirement: 'SHALL log in', observed: 'Logs in' }],
      unknown: 'ignored',
    })
    expect(brief).toEqual({
      behaviourChanges: [{ what: 'Adds X', where: 'src/x.ts:41', userVisible: false }],
      invariantsTouched: [{ invariant: 'Idempotent', evidence: 'src/q.ts:120-138', status: 'at-risk' }],
      untested: [{ path: 'src/x.ts', why: 'No test calls the error branch' }],
      humanChecks: ['Open the settings page'],
      divergences: [{ capability: 'auth', requirement: 'SHALL log in', observed: 'Logs in' }],
    })
  })

  it('orders risks by severity, stable within a severity, and caps them', () => {
    const risks = [risk('low', 1), risk('medium', 2), risk('high', 3), risk('low', 4), risk('high', 5), risk('medium', 6), risk('high', 7)]
    const { brief, overflow } = parseReviewBrief({ risks })
    expect(REVIEW_BRIEF_RISK_LIMIT).toBe(5)
    expect(brief!.risks!.map(item => item.ref)).toEqual(['src/x.ts:3', 'src/x.ts:5', 'src/x.ts:7', 'src/x.ts:2', 'src/x.ts:6'])
    expect(overflow.map(item => item.ref)).toEqual(['src/x.ts:1', 'src/x.ts:4'])
    expect(riskFinding(overflow[0]!)).toBe("Additional low api risk (beyond the brief's top 5): look 1 (src/x.ts:1)")
  })

  it.each([
    ['a non-object brief', [], 'brief must be an object'],
    ['a non-array section', { risks: {} }, 'risks must be an array'],
    ['a non-object item', { untested: ['src/x.ts'] }, 'untested[0] must be an object'],
    ['an unknown severity', { risks: [{ ...risk('high', 1), severity: 'critical' }] }, 'risks[0].severity must be one of high, medium, low'],
    ['an unknown area', { risks: [{ ...risk('high', 1), area: 'legal' }] }, 'risks[0].area must be one of'],
    ['a missing ref', { risks: [{ ...risk('high', 1), ref: ' ' }] }, 'risks[0].ref must be a non-empty string'],
    ['a non-boolean userVisible', { behaviourChanges: [{ what: 'a', where: 'b:1', userVisible: 'yes' }] }, 'behaviourChanges[0].userVisible must be a boolean'],
    ['an unknown invariant status', { invariantsTouched: [{ invariant: 'a', evidence: 'b:1', status: 'broken' }] }, 'invariantsTouched[0].status must be one of'],
    ['a blank human check', { humanChecks: [''] }, 'humanChecks[0] must be a non-empty string'],
    ['a non-array human checks', { humanChecks: 'x' }, 'humanChecks must be an array'],
  ])('rejects %s as repairable', (_name, value, message) => {
    expect(() => parseReviewBrief(value)).toThrow('Invalid review brief: ' + message)
  })

  it('bounds lists and text', () => {
    const { brief } = parseReviewBrief({ humanChecks: Array.from({ length: 30 }, (_, i) => 'check ' + i + ' ' + 'x'.repeat(3000)) })
    expect(brief!.humanChecks).toHaveLength(20)
    expect(brief!.humanChecks![0]!.length).toBe(2000)
  })
})

describe('settleReviewBrief', () => {
  it('throws on the first reply and drops with a diagnostic after the repair turn', () => {
    expect(() => settleReviewBrief({ risks: 'x' }, { repairable: true })).toThrow('Invalid review brief')
    expect(settleReviewBrief({ risks: 'x' }, { repairable: false })).toEqual({ overflow: [], diagnostic: 'Review brief dropped after the repair turn: Invalid review brief: risks must be an array' })
    expect(settleReviewBrief({ risks: [] }, { repairable: false })).toEqual({ brief: { risks: [] }, overflow: [] })
  })
})

describe('reviewer output schema', () => {
  it('accepts replies with and without a brief, and rejects a malformed one', () => {
    const validate = new Ajv().compile(REVIEW_OUTPUT_SCHEMA)
    expect(validate(verdict)).toBe(true)
    expect(validate({ ...verdict, brief: {} })).toBe(true)
    expect(validate({ ...verdict, brief: { risks: [risk('high', 1)], humanChecks: ['x'], divergences: [] } })).toBe(true)
    expect(validate({ ...verdict, brief: { risks: [{ ...risk('high', 1), severity: 'critical' }] } })).toBe(false)
  })

  it('round-trips a Codex strict reply with null optional brief fields', () => {
    // Strict structured output requires every optional field to be present as null.
    const raw = { ...verdict, acceptance: { ...verdict.acceptance, findingLocations: null }, brief: { behaviourChanges: null, invariantsTouched: null, untested: null, risks: [risk('low', 1)], humanChecks: null, divergences: null } }
    expect(new Ajv().compile(codexOutputSchema(REVIEW_OUTPUT_SCHEMA))(raw)).toBe(true)
    const restored = restoreOptionalFields(raw, REVIEW_OUTPUT_SCHEMA) as Record<string, unknown>
    expect(restored.brief).toEqual({ risks: [risk('low', 1)] })
    expect((restored.acceptance as Record<string, unknown>).findingLocations).toBeUndefined()
    expect(new Ajv().compile(codexOutputSchema(REVIEW_OUTPUT_SCHEMA))({ ...verdict, acceptance: { ...verdict.acceptance, findingLocations: null }, brief: null })).toBe(true)
  })

  it('leaves the approval gate untouched by the brief', () => {
    const high = { risks: [risk('high', 1), risk('high', 2)] }
    expect(evaluateReview({ ...verdict, brief: high }, DEFAULT_REVIEW_POLICY)).toEqual(evaluateReview(verdict, DEFAULT_REVIEW_POLICY))
    expect(evaluateReview({ ...verdict, brief: high }, DEFAULT_REVIEW_POLICY).approved).toBe(true)
  })
})

describe('review brief record', () => {
  it('writes and reads the latest verdict brief, tolerating absent or foreign files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'review brief '))
    try {
      const context = { backlogRoot: root, runId: 'run-1' } as PipelineContext
      expect(readReviewBriefRecord(context)).toBeNull()
      writeReviewBriefRecord(context, { change: 'c', approved: false, score: 40, brief: { risks: [risk('high', 1)] }, diagnostic: 'd' })
      expect(readReviewBriefRecord(context)).toMatchObject({ schemaVersion: 1, change: 'c', approved: false, score: 40, brief: { risks: [risk('high', 1)] }, diagnostic: 'd' })
      writeReviewBriefRecord(context, { change: 'c', approved: true, score: 90 })
      expect(readReviewBriefRecord(context)).toMatchObject({ approved: true, brief: null })
      expect(readReviewBriefRecord(context)).not.toHaveProperty('diagnostic')
      mkdirSync(path.dirname(reviewBriefPath(context)), { recursive: true })
      writeFileSync(reviewBriefPath(context), '{"schemaVersion":99}')
      expect(readReviewBriefRecord(context)).toBeNull()
      writeFileSync(reviewBriefPath(context), 'not json')
      expect(readReviewBriefRecord(context)).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
