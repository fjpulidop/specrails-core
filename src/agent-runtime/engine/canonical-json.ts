import { createHash } from 'node:crypto'
import { EngineError, type JsonValue } from './contracts.js'

export const MAX_DEFINITION_BYTES = 2 * 1024 * 1024
export const MAX_JSON_DEPTH = 64
const invalidSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

function fail(message: string): never { throw new EngineError('invalid_definition', message) }
function validString(value: string): void {
  if (invalidSurrogate.test(value)) fail('JSON strings must contain valid Unicode scalar values')
}

/** RFC 8785: emit sorted keys directly, avoiding JS integer-key enumeration order. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>()
  function encode(item: unknown, depth: number): string {
    if (depth > MAX_JSON_DEPTH) fail(`JSON exceeds depth ${MAX_JSON_DEPTH}`)
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('JSON numbers must be finite')
      return JSON.stringify(item)
    }
    if (typeof item === 'string') { validString(item); return JSON.stringify(item) }
    if (typeof item !== 'object') return fail('Only JSON values are permitted')
    if (active.has(item)) fail('JSON must not contain cycles')
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('JSON objects must have a plain prototype')
    if (Object.getOwnPropertySymbols(item).length) fail('JSON objects must not contain symbol keys')
    active.add(item)
    let encoded: string
    if (Array.isArray(item)) {
      encoded = '[' + Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor || !('value' in descriptor)) fail('JSON arrays must not contain holes or accessors')
        return encode(descriptor.value, depth + 1)
      }).join(',') + ']'
    } else {
      encoded = '{' + Object.keys(item).sort().map(key => {
        validString(key)
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (!('value' in descriptor)) fail('JSON objects must not contain accessors')
        return JSON.stringify(key) + ':' + encode(descriptor.value, depth + 1)
      }).join(',') + '}'
    }
    active.delete(item)
    return encoded
  }
  return encode(value, 0)
}

/** Reject duplicate keys before JSON.parse could silently discard their evidence. */
export function parseDefinitionJson(input: string | Uint8Array): JsonValue {
  if (Buffer.byteLength(input) > MAX_DEFINITION_BYTES) fail(`Definition exceeds ${MAX_DEFINITION_BYTES} bytes`)
  let source: string
  try { source = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input) }
  catch { return fail('Definition is not valid UTF-8') }
  let cursor = 0
  function whitespace(): void { while (/[\x20\x09\x0a\x0d]/.test(source[cursor] ?? '\0')) cursor += 1 }
  function string(): string {
    const start = cursor++
    while (cursor < source.length) {
      const token = source[cursor++]
      if (token === '\\') { cursor += 1; continue }
      if (token === '"') {
        let value: string
        try { value = JSON.parse(source.slice(start, cursor)) as string } catch { return fail('Invalid JSON string') }
        validString(value)
        return value
      }
    }
    return fail('Unterminated JSON string')
  }
  function parse(depth: number): JsonValue {
    if (depth > MAX_JSON_DEPTH) fail(`JSON exceeds depth ${MAX_JSON_DEPTH}`)
    whitespace()
    const token = source[cursor]
    if (token === '"') return string()
    if (token === '{' || token === '[') {
      cursor += 1
      whitespace()
      const object = token === '{'
      const value: JsonValue[] | Record<string, JsonValue> = object ? Object.create(null) as Record<string, JsonValue> : []
      const close = object ? '}' : ']'
      if (source[cursor] === close) { cursor += 1; return value }
      while (cursor < source.length) {
        whitespace()
        if (object) {
          if (source[cursor] !== '"') fail('JSON object key must be a string')
          const key = string()
          if (Object.hasOwn(value, key)) fail(`Duplicate JSON key: ${key}`)
          whitespace()
          if (source[cursor++] !== ':') fail('Expected colon after JSON key')
          ;(value as Record<string, JsonValue>)[key] = parse(depth + 1)
        } else (value as JsonValue[]).push(parse(depth + 1))
        whitespace()
        const next = source[cursor++]
        if (next === close) return value
        if (next !== ',') fail('Expected JSON comma or closing delimiter')
      }
      return fail('Unterminated JSON container')
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(cursor))?.[0]
    if (!literal) return fail('Invalid JSON value')
    cursor += literal.length
    const value = JSON.parse(literal) as JsonValue
    if (typeof value === 'number' && !Number.isFinite(value)) fail('JSON numbers must be finite')
    return value
  }
  const value = parse(0)
  whitespace()
  if (cursor !== source.length) fail('Unexpected content after JSON value')
  return value
}

export function definitionVersion(definition: unknown): string {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) fail('Definition must be an object')
  // Encode before copying to reject accessor properties without invoking them.
  canonicalJson(definition)
  const content = Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'version'))
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex')
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}
