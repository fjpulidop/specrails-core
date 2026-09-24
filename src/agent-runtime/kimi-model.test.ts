import { describe, expect, it } from 'vitest'

import { normalizeKimiCliModel } from './kimi-model.js'

describe('normalizeKimiCliModel', () => {
  it('namespaces only the managed short aliases', () => {
    expect(normalizeKimiCliModel('k3')).toBe('kimi-code/k3')
    expect(normalizeKimiCliModel('kimi-for-coding')).toBe('kimi-code/kimi-for-coding')
    expect(normalizeKimiCliModel('kimi-code/k3')).toBe('kimi-code/k3')
    expect(normalizeKimiCliModel('moonshot/kimi-k2')).toBe('moonshot/kimi-k2')
  })

  it('rejects unsafe or oversized ids', () => {
    for (const bad of ['', '-k3', 'k3 --yolo', 'a'.repeat(129)]) expect(() => normalizeKimiCliModel(bad)).toThrow(/Kimi model id/)
  })
})
