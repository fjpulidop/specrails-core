import { describe, expect, it } from 'vitest'
import { contentDigest } from './canonical-json.js'
import type { HistoryEntry } from './contracts.js'
import { initialDefinitionState, mergeHistory, mergeOrdered, mergeRevision } from './state.js'

const entry = (id: string, transition: number, text = id): HistoryEntry => ({ id, transition, attempt: 1, ordinal: 1, nodePath: 'node', text })

describe('definition state reducers', () => {
  it('orders concurrent records deterministically and deduplicates replay', () => {
    const a = entry('a', 1), b = entry('b', 2)
    expect(mergeOrdered([b], [a, b])).toEqual([a, b])
    expect(mergeOrdered([a], [b])).toEqual(mergeOrdered([b], [a]))
    expect(() => mergeOrdered([a], [{ ...a, text: 'different' }])).toThrow('conflicting')
  })
  it('bounds full serialized history, including empty/oversized escaped entries', () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(String(i), i, ''))
    expect(JSON.stringify(mergeHistory([], entries, 200)).length).toBeLessThanOrEqual(200)
    const huge = mergeHistory([], [entry('huge', 1, '\n'.repeat(10_000))], 200)
    expect(huge[0].truncated).toBe(true)
    expect(JSON.stringify(huge).length).toBeLessThanOrEqual(200)
    expect(mergeHistory(huge, [entry('later', 2)], 200).at(-1)?.id).toBe('later')
  })
  it('uses durable usage revisions to avoid a stale branch double-counting unknown usage', () => {
    const initial = initialDefinitionState().$usage
    const unknown = { ...initial, revision: 1, invocations: 1, costUsd: null, knownCostUsd: 0.5 }
    expect(mergeRevision(unknown, initial)).toEqual(unknown)
    expect(mergeRevision(unknown, { ...unknown })).toEqual(unknown)
    expect(() => mergeRevision(unknown, { ...unknown, knownCostUsd: 1 })).toThrow('revision')
  })
  it('detaches initial variables and consistently hashes terminal JSON', () => {
    const vars = { nested: { value: 1 } }
    const state = initialDefinitionState(vars)
    vars.nested.value = 2
    expect(state.$vars.nested).toEqual({ value: 1 })
    expect(contentDigest({ b: 2, a: 1 })).toBe(contentDigest({ a: 1, b: 2 }))
  })
})
