import { describe, expect, it } from 'vitest'
import { canonicalJson, definitionVersion, parseDefinitionJson } from './canonical-json.js'

describe('canonical definition JSON', () => {
  it('uses RFC 8785 scalar formatting and UTF-16 key order, including integer keys', () => {
    expect(canonicalJson({ '2': 2, '10': 10, z: -0, a: [1e30, 4.50, 2e-3, 1e-27] })).toBe('{"10":10,"2":2,"a":[1e+30,4.5,0.002,1e-27],"z":0}')
    expect(canonicalJson({ '\uE000': 1, '😀': 2, '\r': 3, '€': 4 })).toBe('{"\\r":3,"€":4,"😀":2,"":1}')
  })
  it('hashes every field except the top-level version without inserting defaults', () => {
    const first = { id: 'one', nested: { version: 'included', b: 2, a: 1 } }
    expect(definitionVersion(first)).toBe(definitionVersion({ nested: { a: 1, b: 2, version: 'included' }, id: 'one', version: 'ignored' }))
    expect(definitionVersion(first)).not.toBe(definitionVersion({ ...first, policies: { concurrency: 1 } }))
    expect(definitionVersion({ text: 'é' })).not.toBe(definitionVersion({ text: 'é' }))
  })
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}', '{"x":1,}', '[1,]', '01', 'true false', '1e400', '"\\ud800"', '"\\udc00"', '"\n"'])('rejects invalid or ambiguous input %s', input => {
    expect(() => parseDefinitionJson(input)).toThrow()
  })
  it('accepts escaped strings, nested arrays and literal prototype-like keys as data', () => {
    const value = parseDefinitionJson('{"__proto__":{"safe":true},"items":[null,false,"a\\\"b",{"x":2}]}')
    expect(canonicalJson(value)).toBe('{"__proto__":{"safe":true},"items":[null,false,"a\\\"b",{"x":2}]}')
    expect(Object.prototype).not.toHaveProperty('safe')
  })
  it('rejects non-JSON objects without calling getters', () => {
    let called = false
    expect(() => canonicalJson({ get x() { called = true; return 1 } })).toThrow('accessors')
    expect(called).toBe(false)
    for (const value of [undefined, Number.NaN, Infinity, new Date(), [undefined], Array(1)]) expect(() => canonicalJson(value)).toThrow()
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow('cycles')
  })
  it('rejects invalid UTF-8, excessive depth and excessive bytes', () => {
    expect(() => parseDefinitionJson(new Uint8Array([0xc0, 0xaf]))).toThrow('UTF-8')
    expect(() => parseDefinitionJson('['.repeat(66) + '0' + ']'.repeat(66))).toThrow('depth')
    expect(() => parseDefinitionJson(' '.repeat(2 * 1024 * 1024 + 1))).toThrow('bytes')
  })
})
