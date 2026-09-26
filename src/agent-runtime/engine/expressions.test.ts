import { describe, expect, it } from 'vitest'
import { boundedPattern, interpolateParams, parseExpression } from './expressions.js'
import { initialDefinitionState } from './state.js'

describe('closed condition expressions', () => {
  const state = initialDefinitionState({ count: 2, text: 'PASS', changeId: 'example' })
  state.$outputs.check = { valid: true }
  it.each([
    ['$vars.count >= 2 && $outputs.check.valid == true', true],
    ['!exists($vars.missing) && matches($vars.text, /^PA.*$/)', true],
    ['$vars.count == "2"', false],
    ['($vars.count < 1 || $vars.count > 3) && true', false],
    ['$verified == null', true],
  ] as const)('evaluates %s', (expr, expected) => { expect(Boolean(parseExpression(expr).evaluate(state))).toBe(expected) })
  it.each(['process.exit()', '$vars.constructor', '$usage.costUsd > 0', 'matches($vars.text, /(a+)+/)', 'exists($vars.x); true', 'true = false', 'matches($vars.text, /x/i)'])('rejects %s', expression => {
    expect(() => parseExpression(expression)).toThrow()
  })
  it('rejects pathological regex constructs and excessive expressions', () => {
    expect(() => boundedPattern('(a|aa)+')).toThrow()
    expect(() => boundedPattern('(?=a)')).toThrow()
    expect(() => boundedPattern('a'.repeat(201))).toThrow()
    expect(() => parseExpression('('.repeat(40) + 'true' + ')'.repeat(40))).toThrow('nesting')
  })
  it('interpolates runtime values while preserving literal escapes and other tokens', () => {
    expect(interpolateParams({ text: '{{run.changeId}} {{{{run.changeId}} {{spec.title}}', nested: ['{{run.count}}'] }, state.$vars)).toEqual({ text: 'example {{run.changeId}} {{spec.title}}', nested: ['2'] })
    expect(() => interpolateParams({ text: '{{run.missing}}' }, state.$vars)).toThrow('missing')
  })
})
