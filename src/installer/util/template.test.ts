import { describe, expect, it } from 'vitest'

import { render } from './template.js'

describe('template.render', () => {
  it('interpolates ${VAR} tokens', () => {
    expect(render('hello ${NAME}', { NAME: 'world' })).toBe('hello world')
  })

  it('renders multiple variables in one template', () => {
    expect(render('${A}-${B}-${A}', { A: 'x', B: 'y' })).toBe('x-y-x')
  })

  it('renders missing variables as empty string', () => {
    expect(render('a=${MISSING}-b', {})).toBe('a=-b')
  })

  it('coerces numbers and booleans to strings', () => {
    expect(render('${N}/${B}', { N: 42, B: true })).toBe('42/true')
  })

  it('skips false, null, undefined values (renders as empty)', () => {
    expect(render('<${A}>', { A: false })).toBe('<>')
    expect(render('<${A}>', { A: null })).toBe('<>')
    expect(render('<${A}>', { A: undefined })).toBe('<>')
  })

  describe('{{#if}}', () => {
    it('renders the block when the flag is truthy', () => {
      expect(render('pre{{#if FLAG}}YES{{/if}}post', { FLAG: true })).toBe('preYESpost')
      expect(render('{{#if FLAG}}Y{{/if}}', { FLAG: 'x' })).toBe('Y')
      expect(render('{{#if FLAG}}Y{{/if}}', { FLAG: 1 })).toBe('Y')
    })

    it('omits the block when the flag is falsy', () => {
      expect(render('pre{{#if FLAG}}YES{{/if}}post', { FLAG: false })).toBe('prepost')
      expect(render('{{#if FLAG}}Y{{/if}}', {})).toBe('')
      expect(render('{{#if FLAG}}Y{{/if}}', { FLAG: '' })).toBe('')
      expect(render('{{#if FLAG}}Y{{/if}}', { FLAG: 0 })).toBe('')
    })
  })

  describe('{{#ifnot}}', () => {
    it('renders the block when the flag is falsy', () => {
      expect(render('{{#ifnot FLAG}}NO{{/ifnot}}', {})).toBe('NO')
      expect(render('{{#ifnot FLAG}}NO{{/ifnot}}', { FLAG: false })).toBe('NO')
    })

    it('omits the block when the flag is truthy', () => {
      expect(render('{{#ifnot FLAG}}NO{{/ifnot}}', { FLAG: true })).toBe('')
    })
  })

  it('does not interpolate variables inside skipped conditional blocks', () => {
    // The only side we observe is: if interpolation ran in the skipped branch,
    // the output would differ from empty. This covers the order-of-operations
    // invariant in render().
    expect(
      render('{{#if FLAG}}hello ${NAME}{{/if}}', { FLAG: false, NAME: 'x' }),
    ).toBe('')
  })

  it('supports multi-line blocks across newlines', () => {
    const template = [
      'header',
      '{{#if PROV_CLAUDE}}',
      'claude-specific line',
      '{{/if}}',
      'footer',
    ].join('\n')
    const result = render(template, { PROV_CLAUDE: true })
    expect(result).toContain('claude-specific line')
    expect(result).toContain('header')
    expect(result).toContain('footer')
  })
})
