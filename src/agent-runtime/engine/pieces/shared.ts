import { capturePattern } from '../regex.js'
import type { EngineAnswer, HistoryEntry, JsonObject, JsonValue, PieceExecutionContext } from '../contracts.js'

export const stringSchema = { type: 'string', maxLength: 32_000 } satisfies JsonObject
export const idSchema = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' } satisfies JsonObject
export const positiveInteger = { type: 'integer', minimum: 1, maximum: 2_147_483_647 } satisfies JsonObject
export const captureSchema = { type: 'array', maxItems: 64, items: {
  type: 'object', additionalProperties: false, required: ['name', 'pattern'], properties: {
    name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$', not: { enum: ['__proto__', 'prototype', 'constructor'] } },
    pattern: { type: 'string', maxLength: 200 }, group: { type: 'integer', minimum: 0, maximum: 200 },
  },
} } satisfies JsonObject

export function paramsSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return { type: 'object', additionalProperties: false, properties, required }
}

export function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }
export function text(value: JsonValue | undefined): string { return typeof value === 'string' ? value : '' }
export function boundedText(value: string, limit = 32_000): string {
  return value.length <= limit ? value : value.slice(0, Math.max(0, limit - 12)).replace(/[\uD800-\uDBFF]$/, '') + '\n[truncated]'
}
export function historyEntry(context: PieceExecutionContext, text: string, ordinal = 0): HistoryEntry {
  return { id: context.frame.attemptId + ':history:' + ordinal, transition: context.frame.transition,
    attempt: context.frame.attempt, ordinal, nodePath: context.frame.nodePath, text: boundedText(text), ...(text.length > 32_000 ? { truncated: true } : {}) }
}
export function answerEntry(context: PieceExecutionContext, value: JsonValue, ordinal = 0): EngineAnswer {
  return { id: context.frame.attemptId + ':answer:' + ordinal, transition: context.frame.transition,
    attempt: context.frame.attempt, ordinal, nodePath: context.frame.nodePath, value }
}
export function captures(params: JsonObject, output: string): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const capture of (params.captureVars ?? []) as Array<{ name: string; pattern: string; group?: number }>) {
    const match = capturePattern(capture.pattern, output)
    const value = match?.[capture.group ?? 1]
    if (value !== undefined) values[capture.name] = value
  }
  return values
}
