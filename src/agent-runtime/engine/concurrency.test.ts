import { describe, expect, it } from 'vitest'
import { ConcurrencyGate, RepositoryEffectGate } from './concurrency.js'

describe('shared execution admission', () => {
  it('bounds overlapping calls and releases permits after failure', async () => {
    const gate = new ConcurrencyGate(2)
    let active = 0, peak = 0
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (async () => {
      const release = await gate.acquire()
      try {
        peak = Math.max(peak, ++active)
        await new Promise(resolve => setTimeout(resolve, 2))
        if (index === 2) throw new Error('provider failed')
      } finally { active--; release(); release() }
    })()))
    expect(peak).toBe(2)
    expect(active).toBe(0)
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1)
    const release = await gate.acquire(); release()
  })
  it('admits concurrent reads, then a queued writer, before later readers', async () => {
    const gate = new RepositoryEffectGate(), events: string[] = []
    const first = await gate.acquire('read'), second = await gate.acquire('read')
    const writer = gate.acquire('write').then(release => { events.push('writer'); return release })
    const reader = gate.acquire('read').then(release => { events.push('reader'); return release })
    first(); await Promise.resolve(); expect(events).toEqual([])
    second(); const finishWrite = await writer; expect(events).toEqual(['writer'])
    finishWrite(); (await reader)(); expect(events).toEqual(['writer', 'reader'])
  })
  it('cancels queued admission without leaking or overtaking permits', async () => {
    const gate = new ConcurrencyGate(1), controller = new AbortController(), first = await gate.acquire()
    const cancelled = gate.acquire(controller.signal)
    const assertion = expect(cancelled).rejects.toMatchObject({ code: 'aborted' })
    controller.abort(); await assertion
    const next = gate.acquire(); first(); (await next)()
    await expect(gate.acquire(controller.signal)).rejects.toMatchObject({ code: 'aborted' })
    await expect(gate.acquire(undefined, 2)).rejects.toMatchObject({ code: 'invalid_arguments' })
    expect(() => new ConcurrencyGate(0)).toThrow()
  })
})
