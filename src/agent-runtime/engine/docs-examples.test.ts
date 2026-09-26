import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { NODE_KINDS_VERSION } from './cli.js'
import type { JsonObject, JsonValue, PieceDescriptor } from './contracts.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { validationPieceRegistry } from './pieces/index.js'

/**
 * Documentation under docs/engine-v2 is executable evidence: every complete
 * definition validates through the same in-process path as
 * `runtime workflows validate --stdin --config <roles>`, and the piece catalog
 * is rendered from the production registry so the page cannot drift.
 */
const docsRoot = new URL('../../../docs/engine-v2/', import.meta.url)
const fixturesRoot = new URL('./__fixtures__/', import.meta.url)
/** The role catalog the fixtures test uses; docs examples may only reference these roles. */
const roles = { architect: { access: 'read' }, developer: { access: 'write' }, reviewer: { access: 'read' } } as const
export const CATALOG_START = '<!-- piece-catalog:generated:start -->'
export const CATALOG_END = '<!-- piece-catalog:generated:end -->'
const REGENERATE = 'SPECRAILS_UPDATE_DOCS=1 npx vitest run src/agent-runtime/engine/docs-examples.test.ts'

const docFiles = (): string[] => readdirSync(docsRoot).filter(file => file.endsWith('.md')).sort()
const docPath = (file: string): string => fileURLToPath(new URL(file, docsRoot))

/** Every fenced ```json block whose text mentions "schemaVersion" is a complete definition. */
export function definitionBlocks(markdown: string): string[] {
  const blocks: string[] = []
  for (const match of markdown.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm)) if (match[1].includes('"schemaVersion"')) blocks.push(match[1])
  return blocks
}

function range(min: JsonValue | undefined, max: JsonValue | undefined, unit = '', exclusiveMin: JsonValue | undefined = undefined): string {
  const low = typeof min === 'number' ? min : undefined, high = typeof max === 'number' ? max : undefined
  const suffix = unit ? ' ' + unit : ''
  if (typeof exclusiveMin === 'number') return ` (> ${exclusiveMin}${suffix})`
  if (low !== undefined && high !== undefined) return ` (${low}–${high}${suffix})`
  if (low !== undefined) return ` (≥ ${low}${suffix})`
  if (high !== undefined) return ` (≤ ${high}${suffix})`
  return ''
}

/** Compact, deterministic rendering of a closed JSON-schema subset used by piece descriptors. */
export function describeSchema(schema: JsonValue | undefined): string {
  if (schema === true || schema === undefined) return 'any'
  if (schema === false) return 'never'
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'any'
  const value = schema as JsonObject
  if (Object.hasOwn(value, 'const')) return '`' + JSON.stringify(value.const) + '`'
  if (Array.isArray(value.enum)) return value.enum.map(entry => '`' + JSON.stringify(entry) + '`').join(' / ')
  if (Array.isArray(value.oneOf)) return value.oneOf.map(alternative => describeSchema(alternative)).join(' / ')
  switch (value.type) {
    case 'string': {
      const parts = ['string' + range(value.minLength, value.maxLength, 'chars')]
      if (typeof value.pattern === 'string') parts.push('matching `' + value.pattern + '`')
      return parts.join(' ')
    }
    case 'integer':
    case 'number': return String(value.type) + range(value.minimum, value.maximum, '', value.exclusiveMinimum)
    case 'boolean': return 'boolean'
    case 'array': return 'array of ' + describeSchema(value.items) + range(value.minItems, value.maxItems, 'items')
    case 'object': {
      if (value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
        const required = Array.isArray(value.required) ? value.required.map(String) : []
        const fields = Object.entries(value.properties).map(([name, field]) => '`' + name + '`: ' + describeSchema(field)).join(', ')
        return 'object { ' + fields + ' }' + (required.length ? ' (required: ' + required.map(name => '`' + name + '`').join(', ') + ')' : '')
      }
      if (value.additionalProperties && typeof value.additionalProperties === 'object') return 'object of ' + describeSchema(value.additionalProperties as JsonValue)
      return 'object'
    }
    default: return 'any'
  }
}

/** Markdown for the catalog, in registry order; the doc embeds it verbatim between the markers. */
export function renderPieceCatalog(descriptors: readonly PieceDescriptor[], nodeKindsVersion: number): string {
  const lines: string[] = [
    `Generated from \`validationPieceRegistry().catalog()\`: \`nodeKindsVersion\` ${nodeKindsVersion}, ${descriptors.length} kinds, in registration order.`,
    `Do not edit this section by hand; regenerate it with \`${REGENERATE}\`.`,
    '',
  ]
  for (const descriptor of descriptors) {
    const schema = descriptor.paramsSchema
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties as Record<string, JsonValue> : {}
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
    lines.push(`### Descriptor: \`${descriptor.kind}\``, '')
    lines.push('| Field | Value |', '| --- | --- |')
    lines.push(`| Effect | \`${descriptor.effect}\` |`)
    lines.push(`| Requires AI | ${descriptor.requiresAI ? 'yes' : 'no'} |`)
    lines.push(`| Store access | ${descriptor.storeAccess ? '`' + descriptor.storeAccess + '`' : '`none`'} |`)
    lines.push(`| Declared outcomes | ${descriptor.outcomes.length ? descriptor.outcomes.map(outcome => '`' + outcome + '`').join(', ') : '(none: terminal)'} |`)
    lines.push(`| Additional parameters | ${schema.additionalProperties === false ? 'rejected' : 'allowed'} |`)
    lines.push('')
    const names = Object.keys(properties)
    if (names.length) {
      lines.push('| Parameter | Required | Type |', '| --- | --- | --- |')
      for (const name of names) lines.push(`| \`${name}\` | ${required.has(name) ? 'yes' : 'no'} | ${describeSchema(properties[name])} |`)
      lines.push('')
    } else lines.push('This piece takes no parameters.', '')
    if (Array.isArray(schema.oneOf)) {
      const alternatives = schema.oneOf.map(alternative => alternative && typeof alternative === 'object' && !Array.isArray(alternative) && Array.isArray((alternative as JsonObject).required)
        ? ((alternative as JsonObject).required as JsonValue[]).map(name => '`' + String(name) + '`').join(' + ') : describeSchema(alternative))
      lines.push(`Exactly one of: ${alternatives.join(', ')}.`, '')
    }
  }
  return lines.join('\n').trimEnd()
}

function generatedSection(markdown: string): { before: string; body: string; after: string } {
  const start = markdown.indexOf(CATALOG_START), end = markdown.indexOf(CATALOG_END)
  if (start < 0 || end < 0 || end < start) throw new Error(`docs/engine-v2/pieces.md must contain ${CATALOG_START} and ${CATALOG_END}`)
  const bodyStart = start + CATALOG_START.length
  return { before: markdown.slice(0, bodyStart), body: markdown.slice(bodyStart, end).trim(), after: markdown.slice(end) }
}

describe('engine v2 documentation', () => {
  const registry = validationPieceRegistry()

  it('validates every complete definition in docs/engine-v2 through the in-process validator', () => {
    const seen: Array<{ file: string; index: number; id: string; definition: JsonObject }> = []
    for (const file of docFiles()) {
      const blocks = definitionBlocks(readFileSync(docPath(file), 'utf8'))
      blocks.forEach((block, index) => {
        // The raw text goes through the strict parser exactly like `workflows validate --stdin` bytes.
        const result = validateWorkflowDefinition(block, registry, roles)
        expect(result, `${file} definition #${index + 1}: ${JSON.stringify(result.ok ? [] : result.errors)}`).toMatchObject({ ok: true })
        if (result.ok) seen.push({ file, index, id: result.definition.id, definition: JSON.parse(block) as JsonObject })
      })
    }
    const ids = new Set(seen.filter(entry => entry.file === 'definition-format.md').map(entry => entry.id))
    for (const required of ['freestyle', 'quick-sdd', 'implementation', 'batch-implementation']) expect(ids, 'definition-format.md must keep the reference example ' + required).toContain(required)
    const pauses = seen.filter(entry => entry.file === 'definition-format.md' && Object.values(entry.definition.nodes as Record<string, { kind: string }>).some(node => ['question', 'approval', 'gate'].includes(node.kind)))
    expect(pauses.length, 'definition-format.md must show a question/approval pause').toBeGreaterThan(0)
    const maps = seen.filter(entry => entry.file === 'definition-format.md' && Object.values(entry.definition.nodes as Record<string, { kind: string; params: JsonObject }>).some(node => node.kind === 'map' && node.params.over === 'tickets'))
    expect(maps.length, 'definition-format.md must show a ticket map with a join').toBeGreaterThan(0)
    expect(seen.length).toBeGreaterThanOrEqual(8)
  })

  it('keeps documented copies of the published fixtures byte-equivalent to the fixtures', () => {
    const fixtures = new Map(readdirSync(fixturesRoot).filter(file => file.endsWith('.json')).map(file => {
      const definition = JSON.parse(readFileSync(new URL(file, fixturesRoot), 'utf8')) as JsonObject
      return [String(definition.id), definition]
    }))
    let matched = 0
    for (const file of docFiles()) for (const block of definitionBlocks(readFileSync(docPath(file), 'utf8'))) {
      const definition = JSON.parse(block) as JsonObject
      const fixture = fixtures.get(String(definition.id))
      if (!fixture) continue
      matched += 1
      expect(definition, `${file}: example ${String(definition.id)} differs from src/agent-runtime/engine/__fixtures__`).toEqual(fixture)
    }
    expect(matched).toBeGreaterThanOrEqual(4)
  })

  it('validates all complete examples through the shipped CLI entry', () => {
    const cli = fileURLToPath(new URL('../../../dist/agent-runtime/cli.js', import.meta.url))
    for (const file of docFiles()) for (const block of definitionBlocks(readFileSync(docPath(file), 'utf8'))) {
      const result = spawnSync(process.execPath, [cli, 'workflows', 'validate', '--stdin', '--structural'], { input: block, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
      expect(result.status, `${file}: ${result.error?.message ?? result.stderr}\n${result.stdout}`).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ type: 'runtime-definition-validated', ok: true })
    }
  })

  it('lists exactly the registered kinds and embeds the rendered descriptor catalog', () => {
    const file = docPath('pieces.md')
    let markdown = readFileSync(file, 'utf8')
    const kinds = registry.catalog().map(descriptor => descriptor.kind)
    const headings = [...markdown.matchAll(/^### `([a-z-]+)`$/gm)].map(match => match[1])
    expect(new Set(headings).size, 'each kind has one semantics section').toBe(headings.length)
    expect([...headings].sort()).toEqual([...kinds].sort())
    expect(markdown).toContain(`\`nodeKindsVersion\` ${NODE_KINDS_VERSION}`)
    const rendered = renderPieceCatalog(registry.catalog(), NODE_KINDS_VERSION)
    if (process.env.SPECRAILS_UPDATE_DOCS === '1') {
      const { before, after } = generatedSection(markdown)
      markdown = before + '\n' + rendered + '\n' + after
      writeFileSync(file, markdown)
    }
    expect(generatedSection(markdown).body, `docs/engine-v2/pieces.md descriptor reference is stale; run ${REGENERATE}`).toBe(rendered)
    expect(rendered).toContain(`\`nodeKindsVersion\` ${NODE_KINDS_VERSION}, ${kinds.length} kinds`)
  })

  it('links every engine guide from the README index', () => {
    const readme = readFileSync(docPath('README.md'), 'utf8')
    for (const file of docFiles().filter(file => file !== 'README.md')) expect(readme, 'README.md must link ' + file).toContain('](' + file + ')')
    expect(readme).toContain('../agent-runtime.md')
  })
})
