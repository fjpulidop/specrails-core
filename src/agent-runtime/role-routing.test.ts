import { expect, it } from 'vitest'
import { failedCandidateCount, selectRoleRoute } from './role-routing.js'
import { parseArchitecture } from './graph/artifacts.js'
import type { StepAttemptRecord } from './workflow-types.js'

const selection = { provider: 'fixture', model: 'base', effort: 'medium', escalation: { model: 'higher', effort: 'high' } }
function attempt(id: string, stepId: string, output?: StepAttemptRecord['output']): StepAttemptRecord { return { id, stepId, output, status: 'succeeded', attempt: 1, visit: 1, startedAt: '2026-01-01T00:00:00Z' } }
it('counts failed candidates once, including the initial implementation', () => {
  const history = [attempt('d1', 'developer'), attempt('v1', 'verify', { valid: false }), attempt('r1', 'reviewer', { approved: false }), attempt('d2', 'developer'), attempt('v2', 'verify', { valid: false })]
  expect(failedCandidateCount({ history })).toBe(2)
  expect(selectRoleRoute('developer', selection, 'correction', { history })).toMatchObject({ tier: 'escalation', selection: { model: 'higher', effort: 'high' } })
  expect(selectRoleRoute('developer', selection, 'session-fallback', { history }).tier).toBe('base')
  expect(selectRoleRoute('reviewer', selection, 'correction', { history }).tier).toBe('base')
})
it('uses only the configured existing deepen/repair slot and preserves a selected tier across resume', () => {
  const checkpoint = { history: [] }
  expect(selectRoleRoute('architect', selection, 'deepen', checkpoint).tier).toBe('escalation')
  expect(selectRoleRoute('architect', selection, 'repair', checkpoint).tier).toBe('base')
  expect(selectRoleRoute('reviewer', selection, 'repair', checkpoint).tier).toBe('escalation')
  expect(selectRoleRoute('developer', selection, 'initial', checkpoint, { tier: 'escalation', reason: 'previous failures', attemptId: 'old' })).toMatchObject({ tier: 'escalation', reason: 'previous failures' })
  expect(selectRoleRoute('developer', { provider: 'fixture', model: 'base' }, 'initial', checkpoint).tier).toBe('base')
})
it('defaults planning metadata to full and requires references without risks for focused planning', () => {
  expect(parseArchitecture({ confidence: 'high' }).planningDepth).toBe('full')
  expect(parseArchitecture({ confidence: 'high', planningDepth: 'focused' }).planningDepth).toBe('full')
  expect(parseArchitecture({ confidence: 'high', planningDepth: 'focused', referencePatterns: ['src/example.ts'], riskFlags: [] }).planningDepth).toBe('focused')
  expect(parseArchitecture({ confidence: 'high', planningDepth: 'focused', referencePatterns: ['src/example.ts'], riskFlags: ['migration'] }).planningDepth).toBe('full')
  expect(() => parseArchitecture({ confidence: 'high', referencePatterns: [null] })).toThrow('Invalid')
})
