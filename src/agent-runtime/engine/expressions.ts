import { EngineError, type CoreDefinitionState, type JsonObject, type JsonValue } from './contracts.js'
import { matchesPattern } from './regex.js'

type Expression = { evaluate(state: CoreDefinitionState): unknown }
type Token = { value: string; kind: 'literal' | 'path' | 'symbol' | 'regex' | 'function'; literal?: unknown }
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])

function invalid(message: string): never { throw new EngineError('invalid_expression', message) }

/** Bounded regex subset: no backreferences, lookaround or quantified groups. */
export function boundedPattern(pattern: string): RegExp {
  if (pattern.length > 200 || /\\[1-9]|\(\?|\)[*+?{]/.test(pattern)) invalid('Pattern uses unsupported or unbounded regular-expression features')
  try { return new RegExp(pattern) } catch { return invalid('Invalid regular expression') }
}

function lookup(state: CoreDefinitionState, path: string): unknown {
  const parts = path.split('.')
  if (!['$outputs', '$vars', '$verified', '$attempts', '$item'].includes(parts[0])) invalid(`Unavailable state channel ${parts[0]}`)
  let value: unknown = state
  for (const part of parts) {
    if (forbiddenKeys.has(part)) invalid('Prototype property access is not permitted')
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** Recursive descent over a closed grammar; no eval or executable expression callbacks. */
export function parseExpression(source: string): Expression {
  if (!source.trim() || source.length > 4096) invalid('Expression must contain 1–4096 characters')
  const tokens: Token[] = []
  let cursor = 0
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) { cursor += 1; continue }
    const rest = source.slice(cursor)
    let match: RegExpExecArray | null
    if ((match = /^(?:&&|\|\||==|!=|<=|>=|[!<>() ,])/.exec(rest))) {
      tokens.push({ value: match[0], kind: 'symbol' })
    } else if ((match = /^\$(?:outputs|vars|verified|attempts|item)(?:\.[A-Za-z0-9_-]+)*/.exec(rest))) {
      if (match[0].split('.').some(part => forbiddenKeys.has(part))) invalid('Prototype property access is not permitted')
      tokens.push({ value: match[0], kind: 'path' })
    } else if ((match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")/.exec(rest))) {
      tokens.push({ value: match[0], kind: 'literal', literal: JSON.parse(match[0]) as JsonValue })
    } else if ((match = /^(?:exists|matches)\b/.exec(rest))) {
      tokens.push({ value: match[0], kind: 'function' })
    } else if ((match = /^\/(?:[^/\\\r\n]|\\.)*\//.exec(rest))) {
      tokens.push({ value: match[0], kind: 'regex', literal: boundedPattern(match[0].slice(1, -1)) })
    } else invalid(`Unexpected expression token at ${cursor}`)
    cursor += match[0].length
    if (tokens.length > 512) invalid('Expression has too many tokens')
  }
  let index = 0
  function take(value: string): void { if (tokens[index++]?.value !== value) invalid(`Expected ${value}`) }
  function primary(depth: number): Expression {
    if (depth > 32) invalid('Expression nesting exceeds 32')
    const token = tokens[index++]
    if (!token) return invalid('Unexpected end of expression')
    if (token.value === '!') { const operand = primary(depth + 1); return { evaluate: state => !operand.evaluate(state) } }
    if (token.value === '(') { const body = binary(0, depth + 1); take(')'); return body }
    if (token.kind === 'literal') return { evaluate: () => token.literal }
    if (token.kind === 'path') return { evaluate: state => lookup(state, token.value) }
    if (token.kind === 'function') {
      take('(')
      const operand = binary(0, depth + 1)
      if (token.value === 'exists') { take(')'); return { evaluate: state => operand.evaluate(state) !== undefined && operand.evaluate(state) !== null } }
      take(',')
      const pattern = tokens[index++]
      if (pattern?.kind !== 'regex') invalid('matches requires a literal regular expression')
      take(')')
      return { evaluate: state => { const value = operand.evaluate(state); return typeof value === 'string' && matchesPattern((pattern.literal as RegExp).source, value) } }
    }
    return invalid(`Unexpected ${token.value}`)
  }
  const precedence: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4 }
  function binary(min: number, depth: number): Expression {
    let left = primary(depth)
    while ((precedence[tokens[index]?.value] ?? -1) >= min) {
      const operator = tokens[index++].value
      const right = binary(precedence[operator] + 1, depth + 1)
      const previous = left
      left = { evaluate: state => {
        const a = previous.evaluate(state)
        if (operator === '&&') return Boolean(a) && Boolean(right.evaluate(state))
        if (operator === '||') return Boolean(a) || Boolean(right.evaluate(state))
        const b = right.evaluate(state)
        if (operator === '==') return a === b
        if (operator === '!=') return a !== b
        if (!((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string'))) return false
        if (operator === '<') return a < b
        if (operator === '<=') return a <= b
        if (operator === '>') return a > b
        return a >= b
      } }
    }
    return left
  }
  const expression = binary(0, 0)
  if (index !== tokens.length) invalid('Unexpected trailing expression tokens')
  return expression
}

export function validateInterpolations(value: JsonValue): void {
  if (typeof value === 'string') {
    const tokens = value.replaceAll('{{{{', '').match(/\{\{[^}]*\}\}/g) ?? []
    for (const token of tokens) if (token.startsWith('{{run.') && !/^\{\{run\.[A-Za-z][A-Za-z0-9_-]*\}\}$/.test(token)) throw new EngineError('invalid_interpolation', `Invalid runtime variable ${token}`)
  } else if (Array.isArray(value)) value.forEach(validateInterpolations)
  else if (value && typeof value === 'object') Object.values(value).forEach(validateInterpolations)
}

export function interpolateParams(params: JsonObject, vars: Record<string, JsonValue>): JsonObject {
  function resolve(value: JsonValue): JsonValue {
    if (typeof value === 'string') return value.replace(/\{\{\{\{|\{\{run\.([A-Za-z][A-Za-z0-9_-]*)\}\}/g, (token, name: string | undefined) => {
      if (token === '{{{{') return '{{'
      if (!name || !Object.hasOwn(vars, name)) throw new EngineError('run_var_missing', `Runtime variable ${name ?? ''} is missing`)
      const replacement = vars[name]
      if (replacement !== null && typeof replacement === 'object') return JSON.stringify(replacement)
      return String(replacement)
    })
    if (Array.isArray(value)) return value.map(resolve)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]))
    return value
  }
  return resolve(params) as JsonObject
}
