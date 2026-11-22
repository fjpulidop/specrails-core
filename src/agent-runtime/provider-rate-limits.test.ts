import { describe, expect, it } from 'vitest'

import { claudeRateLimit, codexRateLimit, describeRateLimit, isRejected } from './provider-rate-limits.js'

// Shape recorded from Claude Code 2.1.285 (`rate_limit_event.rate_limit_info`).
const claudeInfo = (overrides: Record<string, unknown> = {}) => ({
  status: 'allowed', resetsAt: 1791368400, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.56, resetsAt: 1791368400 }, seven_day: { utilization: 0.49, resetsAt: 1791550800 } },
  ...overrides,
})

describe('claudeRateLimit', () => {
  it('normalizes the recorded report: ISO resets, per-window utilization, overage flags', () => {
    expect(claudeRateLimit(claudeInfo())).toEqual({
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: new Date(1791368400_000).toISOString(),
      utilization: 0.56,
      windows: {
        five_hour: { utilization: 0.56, resetsAt: new Date(1791368400_000).toISOString(), windowMinutes: 300 },
        seven_day: { utilization: 0.49, resetsAt: new Date(1791550800_000).toISOString(), windowMinutes: 10_080 },
      },
      overage: { status: 'rejected', inUse: false, disabledReason: 'org_level_disabled', resetsAt: null },
    })
  })

  it('keeps allowed_warning and rejected and drops unknown statuses or malformed windows', () => {
    expect(claudeRateLimit(claudeInfo({ status: 'allowed_warning' }))?.status).toBe('allowed_warning')
    expect(claudeRateLimit(claudeInfo({ status: 'rejected' }))?.status).toBe('rejected')
    expect(claudeRateLimit(claudeInfo({ status: 'paused' }))).toBeNull()
    expect(claudeRateLimit(null)).toBeNull()
    const odd = claudeRateLimit({ status: 'allowed', unifiedWindows: { 'bad id!': { utilization: 1 }, seven_day_opus: { utilization: 'x' } } })
    expect(odd).toMatchObject({ rateLimitType: null, resetsAt: null, utilization: null, overage: null, windows: { seven_day_opus: { utilization: null, resetsAt: null } } })
  })

  it('treats a refusal covered by overage as not rejected', () => {
    expect(isRejected(claudeRateLimit(claudeInfo({ status: 'rejected' })))).toBe(true)
    expect(isRejected(claudeRateLimit(claudeInfo({ status: 'rejected', overageStatus: 'allowed' })))).toBe(false)
    expect(isRejected(claudeRateLimit(claudeInfo({ status: 'rejected', isUsingOverage: true })))).toBe(false)
    expect(isRejected(claudeRateLimit(claudeInfo()))).toBe(false)
  })

  it('describes the refusing window with its ISO reset', () => {
    expect(describeRateLimit(claudeRateLimit(claudeInfo({ status: 'rejected' }))!)).toBe(`five_hour window, resets ${new Date(1791368400_000).toISOString()}`)
  })
})

describe('codexRateLimit', () => {
  // Shape recorded from codex-cli 0.160.1 (`account/rateLimits/updated`).
  const limits = (overrides: Record<string, unknown> = {}) => ({
    limitId: 'codex', limitName: null,
    primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1791386108 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1791972908 },
    credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'plus', rateLimitReachedType: null,
    ...overrides,
  })

  it('maps primary/secondary windows to fractions and picks the fullest as binding', () => {
    expect(codexRateLimit(limits())).toEqual({
      status: 'allowed', rateLimitType: 'codex:secondary', resetsAt: new Date(1791972908_000).toISOString(), utilization: 0.4,
      windows: {
        'codex:primary': { utilization: 0.03, resetsAt: new Date(1791386108_000).toISOString(), windowMinutes: 300 },
        'codex:secondary': { utilization: 0.4, resetsAt: new Date(1791972908_000).toISOString(), windowMinutes: 10080 },
      },
      overage: null,
    })
  })

  it('reports rejected on the window the provider names', () => {
    const info = codexRateLimit(limits({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1791386108 }, rateLimitReachedType: 'primary' }))
    expect(info).toMatchObject({ status: 'rejected', rateLimitType: 'codex:primary', utilization: 1 })
    expect(isRejected(info)).toBe(true)
  })

  it('returns null without any window', () => {
    expect(codexRateLimit({ limitId: 'codex' })).toBeNull()
    expect(codexRateLimit('nope')).toBeNull()
  })
})
