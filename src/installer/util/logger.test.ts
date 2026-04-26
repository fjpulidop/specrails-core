import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import {
  fail,
  fatal,
  info,
  ok,
  rawErr,
  rawOut,
  resetLoggerStreams,
  setLoggerStreams,
  step,
  warn,
} from './logger.js'

function captureStreams(): { out: PassThrough; err: PassThrough; collect: () => { out: string; err: string } } {
  const out = new PassThrough()
  const err = new PassThrough()
  let outBuf = ''
  let errBuf = ''
  out.on('data', (chunk: Buffer) => {
    outBuf += chunk.toString('utf8')
  })
  err.on('data', (chunk: Buffer) => {
    errBuf += chunk.toString('utf8')
  })
  setLoggerStreams({ out, err })
  return {
    out,
    err,
    collect: () => ({ out: outBuf, err: errBuf }),
  }
}

describe('logger', () => {
  afterEach(() => {
    resetLoggerStreams()
  })

  it('ok writes a ✓ prefixed line to stdout', () => {
    const cap = captureStreams()
    ok('done')
    const { out, err } = cap.collect()
    expect(out).toContain('✓')
    expect(out).toContain('done')
    expect(err).toBe('')
  })

  it('warn writes a ⚠ prefixed line to stdout', () => {
    const cap = captureStreams()
    warn('careful')
    expect(cap.collect().out).toContain('⚠')
    expect(cap.collect().out).toContain('careful')
  })

  it('fail writes a ✗ prefixed line to stderr', () => {
    const cap = captureStreams()
    fail('broken')
    const { out, err } = cap.collect()
    expect(err).toContain('✗')
    expect(err).toContain('broken')
    expect(out).toBe('')
  })

  it('info writes a → prefixed line to stdout', () => {
    const cap = captureStreams()
    info('fyi')
    expect(cap.collect().out).toContain('→')
    expect(cap.collect().out).toContain('fyi')
  })

  it('step writes a bold title prefixed by a blank line', () => {
    const cap = captureStreams()
    step('Phase 1')
    const { out } = cap.collect()
    expect(out.startsWith('\n')).toBe(true)
    expect(out).toContain('Phase 1')
  })

  it('fatal writes to stderr with an optional hint', () => {
    const cap = captureStreams()
    fatal('exploded', 'try running again')
    const { err } = cap.collect()
    expect(err).toContain('exploded')
    expect(err).toContain('try running again')
  })

  it('rawOut and rawErr write verbatim bytes without a trailing newline', () => {
    const cap = captureStreams()
    rawOut('abc')
    rawErr('def')
    const { out, err } = cap.collect()
    expect(out).toBe('abc')
    expect(err).toBe('def')
  })
})
