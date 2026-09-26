import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { workflowDefinitionSchema } from './definition-schema.js'
import type { WorkflowDefinitionDraft } from './definition-types.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { PieceRegistry } from './piece-registry.js'
import type { Piece } from './contracts.js'

const piece = (kind: string, outcomes: string[], effect: 'read' | 'write' = 'read'): Piece => ({
  descriptor: { kind, outcomes, effect, requiresAI: false, paramsSchema: { type: 'object' } },
  execute: async () => ({ outcome: outcomes[0] ?? 'success' }),
})
const registry = new PieceRegistry([piece('condition', ['true', 'false']), piece('shell', ['ok', 'fail', 'failed'], 'write'), piece('end', []), piece('implementation', ['next', 'rejected', 'failed'], 'write'), piece('component', ['next', 'failed']), piece('map', ['next']), piece('join', ['next', 'fail']), piece('role-turn', ['next', 'failed'])])
const draft = (): WorkflowDefinitionDraft => ({ schemaVersion: 1, id: 'sample', title: 'Sample', journal: 'ledger-only', change: 'none', entry: 'check', maxTransitions: 10, roles: [], nodes: {
  check: { kind: 'condition', params: { expr: '$vars.ready == true' }, ends: { true: 'done', false: null } },
  done: { kind: 'end', params: { outcome: 'success', requiresVerified: true }, ends: {} },
} })

function codes(value: unknown): string[] { const result = validateWorkflowDefinition(value, registry); return result.ok ? [] : result.errors.map(error => error.code) }

describe('definition admission', () => {
  it('publishes a raw draft, roundtrips its hash and preserves absence of defaults', () => {
    const result = validateWorkflowDefinition(draft(), registry)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected valid fixture')
    expect(result.type).toBe('runtime-definition-validated')
    expect(result.definition.version).toMatch(/^[a-f0-9]{64}$/)
    expect(result.definition).not.toHaveProperty('policies')
    expect(validateWorkflowDefinition(result.definition, registry, {}, { published: true })).toEqual(result)
    expect(result.graph.edges).toHaveLength(2)
    expect(codes({ ...result.definition, title: 'Edited' })).toContain('definition_hash_mismatch')
  })
  it('keeps the packaged schema identical to the validator source', () => {
    expect(JSON.parse(readFileSync(new URL('../../../schemas/workflow-definition.schema.json', import.meta.url), 'utf8'))).toEqual(workflowDefinitionSchema)
  })
  it('requires published version for execution and rejects duplicate raw JSON keys', () => {
    const result = validateWorkflowDefinition(draft(), registry, {}, { published: true })
    expect(result.ok).toBe(false)
    expect(codes('{"id":"one","id":"two"}')).toContain('invalid_definition')
  })
  it.each(['START', 'END', 'next', '$outputs'])('rejects reserved node %s', id => {
    const value = draft(); value.entry = id; value.nodes = { [id]: value.nodes.done }
    expect(codes(value)).toContain('invalid_definition')
  })
  it('rejects unknown nodes, pieces, wrong outcomes and unreachable terminals', () => {
    const unknown = draft(); unknown.nodes.check.ends.true = 'missing'
    expect(codes(unknown)).toContain('node_not_found')
    const wrong = draft(); wrong.nodes.check.ends = { next: null }
    expect(codes(wrong)).toContain('invalid_outcomes')
    const loop = draft(); loop.nodes.check.ends = { true: 'check', false: 'check' }
    expect(codes(loop)).toContain('no_terminal_path')
    const unavailable = draft(); unavailable.nodes.check.kind = 'prompt'
    expect(codes(unavailable)).toContain('unknown_piece')
  })
  it('validates role declarations, journals and verification policy', () => {
    const role = draft(); role.nodes.check = { kind: 'role-turn', params: { roleId: 'custom' }, ends: { next: 'done', failed: null } }
    expect(codes(role)).toEqual(expect.arrayContaining(['role_undeclared', 'role_not_found']))
    const write = draft(); write.nodes.check = { kind: 'shell', params: {}, ends: { ok: 'done', fail: null, failed: null } }; write.nodes.done.params.requiresVerified = false
    expect(codes(write)).toContain('verification_required')
    write.delivery = { requiresVerified: false }
    expect(codes(write)).toEqual([])
    write.journal = 'implementation'
    expect(codes(write)).toContain('journal_mismatch')
  })
  it('rejects recursive components, invalid joins and unsafe expressions', () => {
    const cycle = draft(); cycle.nodes.check = { kind: 'component', params: { ref: 'recurse' }, ends: { next: 'done', failed: null } }
    cycle.components = { recurse: { entry: 'self', nodes: { self: { kind: 'component', params: { ref: 'recurse' }, ends: { next: null, failed: null } } } } }
    expect(codes(cycle)).toContain('component_cycle')
    const join = draft(); join.nodes.check = { kind: 'join', params: {}, ends: { next: 'done', fail: null } }
    expect(codes(join)).toContain('invalid_map_join')
    const expr = draft(); expr.nodes.check.params.expr = 'process.exit()'
    expect(codes(expr)).toContain('invalid_expression')
  })
  it('enforces strict piece schemas and parameter-dependent outcomes', () => {
    const variable = piece('condition', ['true', 'false'])
    variable.descriptor.paramsSchema = { type: 'object', required: ['expr'], additionalProperties: false, properties: { expr: { type: 'string' } } }
    variable.getOutcomes = params => params.expr === 'true' ? ['true'] : ['true', 'false']
    const strict = new PieceRegistry([variable, piece('end', [])])
    const value = draft(); value.nodes.check.params.extra = true
    expect(validateWorkflowDefinition(value, strict).ok).toBe(false)
    delete value.nodes.check.params.extra; value.nodes.check.params.expr = 'true'; value.nodes.check.ends = { true: 'done' }
    expect(validateWorkflowDefinition(value, strict).ok).toBe(true)
  })
})
