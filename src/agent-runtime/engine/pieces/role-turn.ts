import { contentDigest } from '../canonical-json.js'
import { advisoryMemory } from './project-memory.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { withScopeDefault } from '../../change-scope.js'
import { resolveRoleDescriptor } from '../../config.js'
import { AgentExecutionError } from '../../executor-types.js'
import type { VerificationCommand } from '../../../pipeline/pipeline-state.js'
import { createRoleInvoker } from '../../graph/roles.js'
import { roleInstructions } from '../../prompts.js'
import { EngineError, type JsonObject, type Piece, type PieceExecutionContext, type PieceResult } from '../contracts.js'
import type { PieceDependencies, PieceDependencyProvider } from './ports.js'
import { boundedText, historyEntry, idSchema, json, paramsSchema, invocationTimers, stringSchema, text } from './shared.js'

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false, ownProperties: true })

export function roleTurnPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: { kind: 'role-turn', paramsSchema: paramsSchema({ ...invocationTimers, roleId: idSchema, prompt: { ...stringSchema, minLength: 1 }, structuredOutput: { type: 'object' }, sessionContinuity: { enum: ['run', 'none'] }, verificationProposalsFrom: { type: 'string', minLength: 1, maxLength: 128 } }, ['roleId', 'prompt']), outcomes: ['next', 'invalid', 'failed'], effect: 'derived', requiresAI: true, storeAccess: 'write' },
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
export async function executeRoleTurn(deps: PieceDependencies, params: JsonObject, context: PieceExecutionContext, options: {
  normalizeStructuredOutput?: (output: Record<string, unknown> | undefined, text: string) => Record<string, unknown> | undefined
} = {}): Promise<PieceResult> {
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
  const verification = descriptor.access === 'write' ? hostVerificationPlan(deps, context, params) : undefined
  const full = roleInstructions(descriptor, deps.context, openspec?.[roleId]?.change, { definition: descriptor.prompt, verification }) + '\n## Current workflow task\n' + task
  const result = await invoke(roleId, deps.stepContext(context), { prompt: previous ? task : full, ...(previous ? { resumeSessionId: previous, fallbackPrompt: full } : {}),
    structured: schema !== undefined, lenient: options.normalizeStructuredOutput !== undefined, outputSchema: schema, timeoutMs: params.timeoutMs as number | undefined, idleTimeoutMs: params.idleTimeoutMs as number | undefined }, (output, responseText) => {
    const normalized = options.normalizeStructuredOutput ? options.normalizeStructuredOutput(output, responseText) : output
    if (validate && !validate(normalized)) throw new Error('Invalid structured role response: ' + ajv.errorsText(validate.errors))
    return normalized
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
  return { outcome: 'next', output: { candidateHash: deps.executionSnapshot(context).candidate?.hash ?? null, text: boundedText(result.text), ...(result.value ? { structured: json(result.value) } : {}) },
    history: [historyEntry(context, result.text)], ...(params.sessionContinuity !== 'none' && session ? { session: { sessionId: session.sessionId, identity: session.identity } } : {}) }
}

/** The complete plan the host will run for the repositories in scope: configured checks plus, when `verificationProposalsFrom`
 * names a committed output, its proposals for repositories without a configured check (the rule the verify piece applies). */
function hostVerificationPlan(deps: PieceDependencies, context: PieceExecutionContext, params: JsonObject): VerificationCommand[] {
  const inScope = new Set(deps.context.repositories.map(repository => repository.id))
  const commands = deps.config.verification.filter(command => inScope.has(command.repositoryId)).map(command => withScopeDefault(deps.context, command))
  const configured = new Set(commands.map(command => command.repositoryId))
  const seen = new Set(commands.map(planKey))
  if (typeof params.verificationProposalsFrom === 'string') {
    const source = context.state.$outputs[params.verificationProposalsFrom] as { structured?: { verification?: unknown } } | undefined
    const proposals = Array.isArray(source?.structured?.verification) ? source.structured.verification.slice(0, 20) : []
    for (const proposal of proposals) {
      if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) continue
      const raw = proposal as Partial<VerificationCommand>
      if (typeof raw.repositoryId !== 'string' || typeof raw.command !== 'string' || !Array.isArray(raw.args) || !raw.args.every(arg => typeof arg === 'string')) continue
      if (!inScope.has(raw.repositoryId) || configured.has(raw.repositoryId)) continue
      const command = withScopeDefault(deps.context, { repositoryId: raw.repositoryId, command: raw.command, args: raw.args, ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}) })
      const key = planKey(command)
      if (seen.has(key)) continue
      seen.add(key)
      commands.push(command)
    }
  }
  return commands
}
function planKey(command: VerificationCommand): string {
  return JSON.stringify([command.repositoryId, command.cwd ?? '', command.command, command.args])
}
