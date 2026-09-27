import { expect, it } from 'vitest'
import type { JsonObject, PieceExecutionContext } from '../contracts.js'
import { initialDefinitionState } from '../state.js'
import { assignPiece } from './assign.js'
import { validationPieceRegistry } from './index.js'

const piece = assignPiece()
const registry = validationPieceRegistry()
const context = (vars: JsonObject = {}): PieceExecutionContext => ({
  state: { ...initialDefinitionState(), $vars: vars },
} as PieceExecutionContext)

it('produces an atomic scoped update without changing the input state or invoking infrastructure', async () => {
  const input = context({ iteration: 2, previous: 'retained' })
  const params = { set: { passFailed: false, selection: ['repo-a', 'repo-b'] }, increment: { iteration: 1 } }
  expect(registry.validateParams('assign', params, '/params')).toEqual([])
  expect(await piece.execute(params, input)).toEqual({ outcome: 'next', vars: { passFailed: false, selection: ['repo-a', 'repo-b'], iteration: 3 },
    output: { vars: { passFailed: false, selection: ['repo-a', 'repo-b'], iteration: 3 } } })
  expect(input.state.$vars).toEqual({ iteration: 2, previous: 'retained' })
})

it.each<JsonObject>([{}, { attempts: '1' }, { attempts: 1.5 }, { attempts: Number.MAX_SAFE_INTEGER }])('rejects an invalid counter before applying any companion assignments: %j', async vars => {
  const input = context({ unchanged: 'original', ...vars })
  await expect(piece.execute({ set: { unchanged: 'modified' }, increment: { attempts: 1 } }, input)).rejects.toMatchObject({ code: 'invalid_assignment' })
  expect(input.state.$vars.unchanged).toBe('original')
})

it('rejects overlapping operations instead of silently choosing their order', async () => {
  await expect(piece.execute({ set: { attempts: 0 }, increment: { attempts: 1 } }, context({ attempts: 2 }))).rejects.toMatchObject({ code: 'invalid_assignment' })
})

it('enforces the combined assignment bound even when both maps individually fit', async () => {
  const set = Object.fromEntries(Array.from({ length: 64 }, (_, index) => ['value' + index, index]))
  await expect(piece.execute({ set, increment: { attempts: 1 } }, context({ attempts: 0 }))).rejects.toMatchObject({ code: 'invalid_assignment' })
})

it.each(['constructor', '__proto__', 'prototype', 'parent.child', '$counter', 'a'.repeat(65)])('rejects unsafe or unaddressable variable names: %s', name => {
  expect(registry.validateParams('assign', { set: { [name]: true } }, '/params')).not.toEqual([])
})

it.each([{}, { set: {} }, { increment: { attempts: 0.5 } }, { increment: { attempts: Number.MAX_SAFE_INTEGER + 1 } }])('rejects incomplete or noninteger operations: %j', params => {
  expect(registry.validateParams('assign', params as JsonObject, '/params')).not.toEqual([])
})

it('keeps independent branch inputs isolated while applying signed integer deltas', async () => {
  const left = context({ remaining: 2 }), right = context({ remaining: 2 })
  expect(await piece.execute({ increment: { remaining: -1 } }, left)).toMatchObject({ vars: { remaining: 1 } })
  expect(right.state.$vars.remaining).toBe(2)
  expect(left.state.$vars.remaining).toBe(2)
})
