import { describe, expect, it } from 'vitest'
import { GUARDRAIL_CATALOG, GUARDRAIL_IDS, guardrailEnabled, validateGuardrailSettings } from './guardrails.js'
import { validateRuntimeConfig } from './config.js'

describe('guardrails', () => {
  it('catalog covers every id exactly once, in pipeline phase order', () => {
    expect(GUARDRAIL_CATALOG.map(item => item.id)).toEqual([...GUARDRAIL_IDS])
    const phases = GUARDRAIL_CATALOG.map(item => item.phase)
    expect(phases).toEqual([...phases].sort((a, b) => ['architect', 'developer', 'host'].indexOf(a) - ['architect', 'developer', 'host'].indexOf(b)))
  })
  it('is on unless explicitly false', () => {
    expect(guardrailEnabled(undefined, 'empty-write')).toBe(true)
    expect(guardrailEnabled({}, 'empty-write')).toBe(true)
    expect(guardrailEnabled({ 'empty-write': true }, 'empty-write')).toBe(true)
    expect(guardrailEnabled({ 'empty-write': false }, 'empty-write')).toBe(false)
  })
  it('validates settings: known ids, booleans only', () => {
    expect(validateGuardrailSettings({ 'plan-validation': false })).toEqual({ 'plan-validation': false })
    expect(() => validateGuardrailSettings({ nope: false })).toThrow(/unknown guardrail/)
    expect(() => validateGuardrailSettings({ 'plan-validation': 'off' })).toThrow(/boolean/)
    expect(() => validateGuardrailSettings([])).toThrow(/object/)
  })
  it('rides the runtime config and is rejected when malformed', () => {
    const base = { schemaVersion: 1, enabled: true, providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' }], agents: { architect: { provider: 'local', model: 'm' }, developer: { provider: 'local', model: 'm' }, reviewer: { provider: 'local', model: 'm' } }, verification: [] }
    expect(validateRuntimeConfig({ ...base, guardrails: { 'verify-idle-timeout': false } }).guardrails).toEqual({ 'verify-idle-timeout': false })
    expect(validateRuntimeConfig(base).guardrails).toBeUndefined()
    expect(() => validateRuntimeConfig({ ...base, guardrails: { bogus: false } })).toThrow(/guardrails/)
  })
})
