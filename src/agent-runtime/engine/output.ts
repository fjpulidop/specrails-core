import { EngineError, type JsonValue } from './contracts.js'

export const MAX_PIECE_OUTPUT_BYTES = 262_144
const truncation = '[truncated]'

/** Preserve JSON shape while bounding untrusted provider/command output before checkpointing. */
export function boundPieceOutput(value: JsonValue, maxBytes = MAX_PIECE_OUTPUT_BYTES): JsonValue {
  let remaining = maxBytes
  const active = new Set<object>()
  function string(input: string): string {
    const budget = Math.max(16, remaining - 64)
    const cap = Math.max(0, Math.min(32_000, budget - 16))
    const prefix = (text: string, length: number): string => text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '')
    let candidate = input.length > cap ? prefix(input, cap) + truncation : input
    while (Buffer.byteLength(JSON.stringify(candidate)) > budget && candidate.length > truncation.length) candidate = prefix(candidate, Math.floor(candidate.length / 2)) + truncation
    remaining -= Buffer.byteLength(JSON.stringify(candidate))
    return candidate
  }
  function visit(input: JsonValue, depth: number): JsonValue {
    if (depth > 32 || remaining < 40) { remaining -= truncation.length + 2; return truncation }
    if (typeof input === 'string') return string(input)
    if (input === null || typeof input === 'boolean' || typeof input === 'number') {
      if (typeof input === 'number' && !Number.isFinite(input)) throw new EngineError('invalid_piece_output', 'Piece output must be finite JSON')
      remaining -= String(input).length
      return input
    }
    if (typeof input !== 'object' || active.has(input)) throw new EngineError('invalid_piece_output', 'Piece output must be acyclic JSON')
    active.add(input)
    remaining -= 2
    let result: JsonValue
    if (Array.isArray(input)) {
      const entries: JsonValue[] = []
      for (const entry of input) {
        if (remaining < 80) { entries.push(truncation); remaining -= truncation.length + 3; break }
        remaining -= 1
        entries.push(visit(entry, depth + 1))
      }
      result = entries
    } else {
      const entries: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
      for (const key of Object.keys(input)) {
        const overhead = Buffer.byteLength(JSON.stringify(key)) + 2
        if (remaining < overhead + 80) { entries._coreTruncated = true; remaining -= 22; break }
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!
        if (!('value' in descriptor)) throw new EngineError('invalid_piece_output', 'Piece output cannot contain accessors')
        remaining -= overhead
        entries[key] = visit(descriptor.value as JsonValue, depth + 1)
      }
      result = entries
    }
    active.delete(input)
    return result
  }
  const bounded = visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(bounded)) > maxBytes) throw new EngineError('invalid_piece_output', 'Piece output exceeds the bounded JSON budget')
  return bounded
}
