import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireVerificationSlot, verificationSlotCount, type SlotOwner } from './verification-slots.js'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'verify-slots-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const other = (pid: number) => ({ pid, host: os.hostname() })
const occupy = (index: number, owner: Omit<SlotOwner, 'since'>) => {
  mkdirSync(path.join(root, `slot-${index}`), { recursive: true })
  writeFileSync(path.join(root, `slot-${index}`, 'owner.json'), JSON.stringify({ ...owner, since: 'x' }))
}

describe('verificationSlotCount', () => {
  it('defaults to one turn, accepts a count, and turns off with 0 or off', () => {
    expect(verificationSlotCount({})).toBe(1)
    expect(verificationSlotCount({ SPECRAILS_VERIFY_SLOTS: '3' })).toBe(3)
    expect(verificationSlotCount({ SPECRAILS_VERIFY_SLOTS: '0' })).toBe(0)
    expect(verificationSlotCount({ SPECRAILS_VERIFY_SLOTS: 'off' })).toBe(0)
    expect(verificationSlotCount({ SPECRAILS_VERIFY_SLOTS: 'many' })).toBe(1)
  })
})

describe('acquireVerificationSlot', () => {
  it('records the holder, waits while every turn is taken, and proceeds when one is released', async () => {
    const release = await acquireVerificationSlot({ root, slots: 1, owner: other(111) })
    expect(JSON.parse(readFileSync(path.join(root, 'slot-0', 'owner.json'), 'utf8'))).toMatchObject({ pid: 111 })
    const onWait = vi.fn()
    let acquired = false
    const second = acquireVerificationSlot({ root, slots: 1, pollMs: 10, owner: other(222), isAlive: () => true, isAncestor: () => false, onWait }).then(r => { acquired = true; return r })
    await new Promise(r => setTimeout(r, 60))
    expect(acquired).toBe(false)
    expect(onWait).toHaveBeenCalledTimes(1)
    expect(onWait.mock.calls[0][0]).toEqual([expect.objectContaining({ pid: 111 })])
    release(); release()
    const releaseSecond = await second
    expect(JSON.parse(readFileSync(path.join(root, 'slot-0', 'owner.json'), 'utf8'))).toMatchObject({ pid: 222 })
    releaseSecond()
    expect(existsSync(path.join(root, 'slot-0'))).toBe(false)
  })

  it('uses the next free turn when several are configured', async () => {
    occupy(0, other(111))
    const release = await acquireVerificationSlot({ root, slots: 2, owner: other(222), isAlive: () => true, isAncestor: () => false })
    expect(JSON.parse(readFileSync(path.join(root, 'slot-1', 'owner.json'), 'utf8'))).toMatchObject({ pid: 222 })
    release()
  })

  it('reclaims a turn whose holder is gone', async () => {
    occupy(0, other(999_999))
    const release = await acquireVerificationSlot({ root, slots: 1, owner: other(222), isAlive: owner => owner.pid !== 999_999, isAncestor: () => false })
    expect(JSON.parse(readFileSync(path.join(root, 'slot-0', 'owner.json'), 'utf8'))).toMatchObject({ pid: 222 })
    release()
  })

  it('runs within the turn of an enclosing verification instead of waiting for it', async () => {
    occupy(0, other(111))
    const release = await acquireVerificationSlot({ root, slots: 1, pollMs: 10, owner: other(222), isAlive: () => true, isAncestor: owner => owner.pid === 111 })
    release()
    expect(JSON.parse(readFileSync(path.join(root, 'slot-0', 'owner.json'), 'utf8'))).toMatchObject({ pid: 111 })
  })

  it('stops waiting when the verification is cancelled', async () => {
    occupy(0, other(111))
    const controller = new AbortController()
    const waiting = acquireVerificationSlot({ root, slots: 1, pollMs: 10, owner: other(222), isAlive: () => true, isAncestor: () => false, signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('is a no-op when turns are turned off', async () => {
    const release = await acquireVerificationSlot({ root: path.join(root, 'none'), slots: 0 })
    release()
    expect(existsSync(path.join(root, 'none'))).toBe(false)
  })

  it('finds a real live holder and its own process ancestry with the default probes', async () => {
    const release = await acquireVerificationSlot({ root, slots: 1, owner: other(process.ppid) })
    // The parent process is alive and an ancestor: a nested caller runs within its turn.
    const nested = await acquireVerificationSlot({ root, slots: 1, pollMs: 10, owner: other(process.pid) })
    nested()
    release()
  })
})
