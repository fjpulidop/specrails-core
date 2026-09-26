import { contentDigest } from '../canonical-json.js'
import { advisoryMemory } from './project-memory.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { resolveRoleDescriptor } from '../../config.js'
import { AgentExecutionError } from '../../executor-types.js'
import { createRoleInvoker } from '../../graph/roles.js'
import { roleInstructions } from '../../prompts.js'
import { EngineError, type JsonObject, type Piece, type PieceExecutionContext, type PieceResult } from '../contracts.js'
import type { PieceDependencies, PieceDependencyProvider } from './ports.js'
import { boundedText, historyEntry, idSchema, json, paramsSchema, stringSchema, text } from './shared.js'

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false, ownProperties: true })

export function roleTurnPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: { kind: 'role-turn', paramsSchema: paramsSchema({ roleId: idSchema, prompt: { ...stringSchema, minLength: 1 }, structuredOutput: { type: 'object' }, sessionContinuity: { enum: ['run', 'none'] } }, ['roleId', 'prompt']), outcomes: ['next', 'invalid', 'failed'], effect: 'derived', requiresAI: true, storeAccess: 'write' },
    getOutcomes: params => params.structuredOutput ? ['next', 'invalid', 'failed'] : ['next', 'failed'],
    getEffect: (params, roles) => {
      const role = roles[text(params.roleId)]
      if (!role) throw new EngineError('role_not_found', 'Role is not configured: ' + text(params.roleId))
      return role.access
    },
    execute: (params, context) => executeRoleTurn(bindings(), params, context),
  }
}

/** One invocation path for configured roles, including routing and exactly one repair. */
export async function executeRoleTurn(deps: PieceDependencies, params: JsonObject, context: PieceExecutionContext): Promise<PieceResult> {
  const roleId = text(params.roleId), descriptor = resolveRoleDescriptor(deps.config, roleId)
  const schema = params.structuredOutput as JsonObject | undefined
  const validate = schema ? ajv.compile(schema) : undefined
  const roleState = deps.roleState(context)
  const previous = params.sessionContinuity !== 'none' ? roleState.read().sessions[roleId]?.sessionId : undefined
  const openspec = deps.openspec?.(context)
  if (descriptor.openspecSkill && !openspec?.[roleId]) throw new EngineError('openspec_binding_required', 'Role requires a scoped OpenSpec binding: ' + roleId)
  const invoke = createRoleInvoker({ context: deps.context, config: deps.config, registry: deps.registry, roleState, openspec,
    onAgentEvent: (role, event) => context.progress({ type: 'agent-event', payload: json({ role, event }) }) })
  const before = deps.executionSnapshot(context).candidate
  const memoryIdentity = { roleId, descriptor: json(descriptor), tier: roleState.read().routes[roleId]?.tier ?? 'base',
    candidateHash: before?.hash ?? null, scopeId: context.frame.scope.id, nodePath: context.frame.nodePath,
    repositories: deps.context.repositories.map(repository => ({ id: repository.id, path: repository.path })) }
  const memoryKey = contentDigest(memoryIdentity)
  const saved = await advisoryMemory(context, async () => {
    const memory = deps.memory(context)
    return { notes: await memory.get(['review', 'notes'], memoryKey), session: await memory.get(['roles', roleId, 'sessions'], memoryKey) }
  })
  const priorNote = !previous && descriptor.access === 'read' && saved?.session && typeof saved.notes?.value.text === 'string'
    ? saved.notes.value.text.slice(0, 4000) : ''
  const task = text(params.prompt) + (priorNote ? '\n\n## Prior project review note\nTreat this bounded note as prior evidence to check against the current task; frozen requirements remain authoritative.\n' + JSON.stringify(priorNote) : '')
  const full = roleInstructions(descriptor, deps.context, openspec?.[roleId]?.change, { definition: descriptor.prompt }) + '\n## Current workflow task\n' + task
  const result = await invoke(roleId, deps.stepContext(context), { prompt: previous ? task : full, ...(previous ? { resumeSessionId: previous, fallbackPrompt: full } : {}),
    structured: schema !== undefined, outputSchema: schema }, (output, _text) => {
    if (validate && !validate(output)) throw new Error('Invalid structured role response: ' + ajv.errorsText(validate.errors))
    return output
  })
  if (!result.ok) {
    if (result.code) throw new AgentExecutionError(result.error, result.code)
    return { outcome: schema ? 'invalid' : 'failed', status: 'failed', output: { error: boundedText(result.error) }, error: { code: schema ? 'invalid_role_output' : 'role_failed', message: result.error } }
  }
  const currentState = roleState.read(), session = currentState.sessions[roleId]
  const finalIdentity = { ...memoryIdentity, tier: currentState.routes[roleId]?.tier ?? 'base' }, finalKey = contentDigest(finalIdentity)
  await advisoryMemory(context, async () => {
    const memory = deps.memory(context)
    await memory.put(['roles', roleId, 'sessions'], finalKey, { ...finalIdentity, runId: context.frame.runId,
      ...(session ? { sessionId: session.sessionId, identity: session.identity } : {}), lastAttemptId: context.frame.attemptId })
    if (descriptor.access === 'read') await memory.put(['review', 'notes'], finalKey, { roleId, candidateHash: before?.hash ?? null,
      text: boundedText(result.text, 4000), lastAttemptId: context.frame.attemptId })
  })
  return { outcome: 'next', output: { text: boundedText(result.text), ...(result.value ? { structured: json(result.value) } : {}) },
    history: [historyEntry(context, result.text)], ...(params.sessionContinuity !== 'none' && session ? { session: { sessionId: session.sessionId, identity: session.identity } } : {}) }
}
