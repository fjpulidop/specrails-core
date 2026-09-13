import { it, expect } from 'vitest'
import { Ajv } from 'ajv'
import { codexOutputSchema, restoreOptionalFields } from './codex-schema.js'
import { ARCHITECT_OUTPUT_SCHEMA, DEVELOPER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from './prompts.js'
import { providerDiagnostic } from './provider-diagnostic.js'
it.each([ARCHITECT_OUTPUT_SCHEMA, DEVELOPER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA])('makes every nested object compatible with strict Codex output', schema => {
  const original = structuredClone(schema)
  const strict = codexOutputSchema(schema)
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(walk); return }
    const node = value as Record<string, unknown>
    if (node.properties) { expect(node.required).toEqual(Object.keys(node.properties)); expect(node.additionalProperties).toBe(false) }
    Object.values(node).forEach(walk)
  }
  walk(strict)
  expect(schema).toEqual(original)
})
it('accepts the architect response with null optional fields and restores the original contract', () => {
  const raw = { confidence: 'high', question: null, planningDepth: null, planningReason: null, referencePatterns: null, riskFlags: null, verification: [{ repositoryId: 'front', command: 'npm', args: ['test'], cwd: null }] }
  expect(new Ajv().compile(codexOutputSchema(ARCHITECT_OUTPUT_SCHEMA))(raw)).toBe(true)
  const restored = restoreOptionalFields(raw, ARCHITECT_OUTPUT_SCHEMA)
  expect(restored).toEqual({ confidence: 'high', verification: [{ repositoryId: 'front', command: 'npm', args: ['test'] }] })
  expect(new Ajv().compile(ARCHITECT_OUTPUT_SCHEMA)(restored)).toBe(true)
  expect(restoreOptionalFields({ confidence: null, question: null }, ARCHITECT_OUTPUT_SCHEMA)).toEqual({ confidence: null })
})
it('exposes structured failure details while redacting credentials', () => {
  const stdout = JSON.stringify({ type: 'turn.failed', error: { message: JSON.stringify({ error: { code: 'invalid_json_schema', message: "Missing 'cwd'. token-value Bearer example-token api_key=abc123 https://u:p@example.com/path?token=hidden" } }) } })
  const message = providerDiagnostic(stdout, '', { API_TOKEN: 'token-value' })
  expect(message).toContain("invalid_json_schema: Missing 'cwd'")
  for (const secret of ['token-value', 'example-token', 'abc123', 'u:p', 'hidden']) expect(message).not.toContain(secret)
})


it('restores optional null fields inside the flat developer check schema', () => {
  const raw = { summary: 'Done', files: [], tests: [], verification: 'Core will run checks', incomplete: [], verificationChecks: [{ kind: 'command', key: 'unit', repositoryId: 'front', label: 'Unit tests', command: 'npm', args: ['test'], cwd: null, timeoutMs: null, entrypoint: null, files: null }] }
  expect(new Ajv().compile(codexOutputSchema(DEVELOPER_OUTPUT_SCHEMA))(raw)).toBe(true)
  const restored = restoreOptionalFields(raw, DEVELOPER_OUTPUT_SCHEMA)
  expect(restored).toMatchObject({ verificationChecks: [{ kind: 'command', key: 'unit', command: 'npm' }] })
  expect((restored as { verificationChecks: object[] }).verificationChecks[0]).not.toHaveProperty('entrypoint')
  expect(new Ajv().compile(DEVELOPER_OUTPUT_SCHEMA)(restored)).toBe(true)
})
