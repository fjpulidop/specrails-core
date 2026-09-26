import { Ajv2020 } from 'ajv/dist/2020.js'
import { canonicalJson, definitionVersion, MAX_DEFINITION_BYTES, parseDefinitionJson } from './canonical-json.js'
import { EngineError } from './contracts.js'
import { workflowDefinitionSchema } from './definition-schema.js'
import type { ComponentBody, DefinitionGraph, DefinitionIssue, DefinitionNode, DefinitionValidation, RoleCatalog, WorkflowDefinition, WorkflowDefinitionDraft } from './definition-types.js'
import { boundedPattern, parseExpression, validateInterpolations } from './expressions.js'
import type { PieceRegistry } from './piece-registry.js'

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false, ownProperties: true })
const draftSchema = { ...workflowDefinitionSchema, required: workflowDefinitionSchema.required.filter(key => key !== 'version') }
const validateShape = ajv.compile(draftSchema)

/** Returns a published, detached document. Defaults never change its canonical identity. */
export function validateWorkflowDefinition(input: unknown, registry: PieceRegistry, roles: RoleCatalog = {}, options: { published?: boolean; structural?: boolean } = {}): DefinitionValidation {
  const errors: DefinitionIssue[] = []
  const add = (code: string, path: string, message: string): void => { errors.push({ code, path, message }) }
  try {
    const raw = typeof input === 'string' || input instanceof Uint8Array ? parseDefinitionJson(input) : input
    const canonical = canonicalJson(raw)
    if (Buffer.byteLength(canonical) > MAX_DEFINITION_BYTES) throw new EngineError('invalid_definition', `Definition exceeds ${MAX_DEFINITION_BYTES} bytes`)
    if (!validateShape(raw)) return { type: 'runtime-definition-validated', ok: false, errors: (validateShape.errors ?? []).map(error => ({ code: 'invalid_definition', path: error.instancePath, message: error.message ?? 'Invalid definition' })) }
    const draft = JSON.parse(canonical) as WorkflowDefinitionDraft
    const version = definitionVersion(draft)
    if (options.published && !draft.version) add('definition_version_missing', '/version', 'Execution requires a published definition')
    if (draft.version && draft.version !== version) add('definition_hash_mismatch', '/version', 'Definition version does not match its canonical content')
    const definition: WorkflowDefinition = { ...draft, version }
    // Portable authoring cannot resolve project bindings. Execution always calls
    // this validator again with the real role catalog and structural=false.
    const unresolved = options.structural ? definition.roles.filter(role => !Object.hasOwn(roles, role)) : []
    if (unresolved.length) roles = { ...roles, ...Object.fromEntries(unresolved.map(role => [role, { access: 'read' as const }])) }
    const graph: DefinitionGraph = { id: definition.id, version, entry: definition.entry, nodes: [], edges: [] }
    for (const role of definition.roles) if (!Object.hasOwn(roles, role)) add('role_not_found', '/roles', `Role ${role} is not configured`)
    let implementations = 0
    let writes = false
    const successfulEnds: Array<{ path: string; verified: boolean }> = []
    const bodies = definition.components ?? {}
    const validatedBodies = new Set<string>()
    let referenceChecks = 0

    function effectOf(node: DefinitionNode, ancestry: string[] = []): 'read' | 'write' {
      if (++referenceChecks > 100_000) throw new EngineError('definition_complexity', 'Definition reference analysis exceeds its bounded work limit')
      if (node.kind !== 'component' && node.kind !== 'map') return registry.effect(node.kind, node.params, roles)
      const ref = node.params[node.kind === 'component' ? 'ref' : 'body']
      if (typeof ref !== 'string' || !Object.hasOwn(bodies, ref) || ancestry.includes(ref)) return 'read'
      return Object.values(bodies[ref].nodes).some(child => effectOf(child, [...ancestry, ref]) === 'write') ? 'write' : 'read'
    }

    // Check every ancestry even when a shared body was already validated along a shorter path.
    function inspectReferences(body: ComponentBody, ancestry: string[], prefix: string): void {
      for (const [id, node] of Object.entries(body.nodes)) {
        if (++referenceChecks > 100_000) throw new EngineError('definition_complexity', 'Definition reference analysis exceeds its bounded work limit')
        if (node.kind !== 'component' && node.kind !== 'map') continue
        const ref = node.params[node.kind === 'component' ? 'ref' : 'body']
        if (typeof ref !== 'string' || !Object.hasOwn(bodies, ref)) continue
        if (ancestry.includes(ref)) add('component_cycle', prefix + '/nodes/' + id, 'Recursive component reference is not permitted')
        else if (ancestry.length >= 3) add('component_depth', prefix + '/nodes/' + id, 'Component nesting cannot exceed three levels')
        else inspectReferences(bodies[ref], [...ancestry, ref], '/components/' + ref)
      }
    }

    function inspect(body: ComponentBody, prefix: string, ancestry: string[]): void {
      if (!Object.hasOwn(body.nodes, body.entry)) add('node_not_found', prefix + '/entry', `Entry ${body.entry} does not exist`)
      const reachable = new Set<string>()
      const pending = [body.entry]
      let terminal = false
      while (pending.length) {
        const id = pending.pop()!
        if (reachable.has(id)) continue
        reachable.add(id)
        const node = Object.hasOwn(body.nodes, id) ? body.nodes[id] : undefined
        if (!node) continue
        if (node.kind === 'end' || Object.values(node.ends).includes(null)) terminal = true
        pending.push(...Object.values(node.ends).filter((target): target is string => target !== null))
      }
      if (!terminal) add('no_terminal_path', prefix + '/entry', 'No terminal path is reachable from this entry')
      for (const [id, node] of Object.entries(body.nodes)) {
        const path = prefix + '/nodes/' + id
        const nodePath = prefix ? prefix.replace(/^\/components\//, '') + '/' + id : id
        errors.push(...registry.validateParams(node.kind, node.params, path))
        for (const [outcome, target] of Object.entries(node.ends)) {
          if (target !== null && !Object.hasOwn(body.nodes, target)) add('node_not_found', path + '/ends/' + outcome, `Target ${target} does not exist`)
          graph.edges.push({ from: nodePath, outcome, to: target === null ? null : (prefix ? prefix.replace(/^\/components\//, '') + '/' : '') + target })
        }
        try {
          validateInterpolations(node.params)
          if (node.kind === 'condition' && typeof node.params.expr === 'string') parseExpression(node.params.expr)
          if (Array.isArray(node.params.captureVars)) for (const capture of node.params.captureVars) {
            if (capture && typeof capture === 'object' && !Array.isArray(capture) && typeof capture.pattern === 'string') boundedPattern(capture.pattern)
          }
          const roleId = node.params.roleId
          if (node.kind === 'role-turn' || node.kind === 'decider') {
            if (typeof roleId !== 'string' || !definition.roles.includes(roleId)) add('role_undeclared', path + '/params/roleId', 'Used role must appear in definition.roles')
            if (typeof roleId !== 'string' || !Object.hasOwn(roles, roleId)) add('role_not_found', path + '/params/roleId', 'Used role is not configured')
            if (node.kind === 'decider' && typeof roleId === 'string' && roles[roleId]?.access !== 'read') add('invalid_role_access', path + '/params/roleId', 'Decider role must be read-only')
          }
          const effect = effectOf(node)
          writes ||= effect === 'write'
          let outcomes = registry.outcomes(node.kind, node.params)
          if (node.kind === 'component') {
            const ref = node.params.ref
            if (typeof ref === 'string' && Object.hasOwn(bodies, ref)) outcomes = bodies[ref].outputs ?? ['next', 'failed']
          }
          if (Object.keys(node.ends).sort().join('\0') !== [...outcomes].sort().join('\0')) add('invalid_outcomes', path + '/ends', `Expected exactly ${outcomes.join(', ') || 'no outcomes'}`)
          graph.nodes.push({ id, nodePath, kind: node.kind, effect, outcomes: [...outcomes] })
        } catch (error) { add(error instanceof EngineError ? error.code : 'invalid_piece_params', path, error instanceof Error ? error.message : String(error)) }
        if (node.kind === 'implementation') implementations += 1
        if (node.kind === 'end' && node.params.outcome === 'success') successfulEnds.push({ path, verified: node.params.requiresVerified === true })
        if (node.kind === 'end' && node.params.exit !== undefined) {
          if (!prefix || typeof node.params.exit !== 'string' || !(body.outputs ?? ['next', 'failed']).includes(node.params.exit)) add('invalid_component_exit', path + '/params/exit', 'Exit must be a declared output of the containing component')
        }
        if (node.kind === 'map') {
          const target = node.ends.next
          if (!target || body.nodes[target]?.kind !== 'join') add('invalid_map_join', path + '/ends', 'Map next must target its join')
        }
        if (node.kind === 'join') {
          const predecessors = Object.entries(body.nodes).filter(([, predecessor]) => Object.values(predecessor.ends).includes(id))
          if (predecessors.length !== 1 || predecessors[0][1].kind !== 'map') add('invalid_map_join', path, 'Join must have exactly one map predecessor')
        }
        if (node.kind === 'map' || node.kind === 'component') {
          const ref = node.params[node.kind === 'map' ? 'body' : 'ref']
          if (typeof ref !== 'string' || !Object.hasOwn(bodies, ref)) add('component_not_found', path + '/params', 'Referenced component does not exist')
          else if (ancestry.includes(ref)) add('component_cycle', path + '/params', 'Recursive component reference is not permitted')
          else if (ancestry.length >= 3) add('component_depth', path + '/params', 'Component nesting cannot exceed three levels')
          else if (!validatedBodies.has(ref)) {
            validatedBodies.add(ref)
            inspect(bodies[ref], '/components/' + ref, [...ancestry, ref])
          }
        }
      }
    }
    inspect(definition, '', [])
    for (const [name, body] of Object.entries(bodies)) if (!validatedBodies.has(name)) { validatedBodies.add(name); inspect(body, '/components/' + name, [name]) }
    inspectReferences(definition, [], '')
    for (const [name, body] of Object.entries(bodies)) inspectReferences(body, [name], '/components/' + name)
    if ((definition.journal === 'ledger-only' && implementations !== 0) || (definition.journal === 'implementation' && (implementations !== 1 || definition.change === 'none'))) add('journal_mismatch', '/journal', 'Implementation journals require exactly one implementation piece and an existing or new change')
    if (writes && definition.delivery?.requiresVerified !== false && definition.delivery?.requiresVerified !== true) for (const end of successfulEnds) if (!end.verified) add('verification_required', end.path, 'Successful write workflows require verification or explicit delivery opt-out')
    return errors.length ? { type: 'runtime-definition-validated', ok: false, errors } : { type: 'runtime-definition-validated', ok: true, version, definition, graph }
  } catch (error) {
    return { type: 'runtime-definition-validated', ok: false, errors: [{ code: error instanceof EngineError ? error.code : 'invalid_definition', path: '', message: error instanceof Error ? error.message : String(error) }] }
  }
}
