import { describe, expect, it } from 'vitest'
import { boundPieceOutput, MAX_PIECE_OUTPUT_BYTES } from './output.js'

describe('bounded piece output', () => {
  it('retains useful fields of ten-megabyte output within the checkpoint/JSONL budget', () => {
    const output = boundPieceOutput({ exitCode: 0, stdout: 'x'.repeat(10_000_000), stderr: '' })
    expect(output).toMatchObject({ exitCode: 0, stderr: '' })
    expect((output as { stdout: string }).stdout).toContain('[truncated]')
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(MAX_PIECE_OUTPUT_BYTES)
  })
  it('bounds UTF-8 and escaping overhead across many keys and array entries', () => {
    for (const value of [Array.from({ length: 1000 }, () => '\n😀'.repeat(1000)), Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ['field' + i, '€'.repeat(1000)]))]) {
      expect(Buffer.byteLength(JSON.stringify(boundPieceOutput(value)))).toBeLessThanOrEqual(MAX_PIECE_OUTPUT_BYTES)
    }
  })
  it('rejects non-JSON and cyclic piece values', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => boundPieceOutput(cyclic as never)).toThrow('acyclic')
    expect(() => boundPieceOutput(Number.NaN)).toThrow('finite')
  })
})
