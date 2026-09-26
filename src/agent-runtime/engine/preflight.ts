import { validatePipelineContext, validateVerificationRequest, type PipelineContext } from '../../pipeline/pipeline-state.js'
import { normalizeRuntimeConfig, resolveRoleDescriptor, roleIds } from '../config.js'
import { assertEffortSupported } from '../capabilities.js'
import { createExecutorRegistry, type ExecutorRegistry } from '../executors.js'
import type { RuntimeConfig } from '../executor-types.js'
import { EngineError } from './contracts.js'
import { intersectBudgets } from './budget.js'
import type { RoleCatalog, WorkflowDefinition } from './definition-types.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { validationPieceRegistry } from './pieces/index.js'

export interface DefinitionRunRequest {
  context: PipelineContext
  config: RuntimeConfig
  change?: string
}
export interface DefinitionRunInput { context: unknown; config: unknown; definition: unknown; change?: string; registry?: ExecutorRegistry }

export function configuredRoles(config: RuntimeConfig): RoleCatalog {
  return Object.fromEntries(roleIds(config).map(id => [id, { access: resolveRoleDescriptor(config, id).access }]))
}

/** Complete admission is read-only; no run, journal, provider turn or skill is created. */
export async function preflightDefinition(input: DefinitionRunInput) {
  const context = validatePipelineContext(input.context)
  const config = normalizeRuntimeConfig(input.config, { registeredProviderIds: input.registry?.ids() })
  if (config.enabled === false) throw new EngineError('runtime_disabled', 'The project runtime is disabled')
  if (context.ownership.git !== 'host') throw new EngineError('invalid_ownership', 'Definition delivery must be owned by the host')
  const roles = configuredRoles(config), validation = validateWorkflowDefinition(input.definition, validationPieceRegistry(), roles, { published: true })
  if (!validation.ok) throw new EngineError('invalid_definition', 'Definition failed admission', validation.errors.map(error => ({ ...error })))
  const definition: WorkflowDefinition = validation.definition
  if (definition.roles.some(id => resolveRoleDescriptor(config, id).openspecSkill) && !input.change) throw new EngineError('invalid_arguments', 'OpenSpec roles require a frozen change name')
  if (definition.change !== 'none' && (!input.change || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.change) || input.change.length > 64)) throw new EngineError('invalid_arguments', 'This definition requires a change name of at most 64 characters')
  if (definition.journal === 'implementation' && !context.specs.length) throw new EngineError('invalid_scope', 'Implementation requires frozen specs or a goal')
  if (config.verification.length) validateVerificationRequest(context, { kind: 'scoped', commands: config.verification })
  const budget = intersectBudgets(definition.budget, config.limits)
  const registry = input.registry ?? createExecutorRegistry(config)
  const engines = definition.roles.flatMap(id => {
    const role = resolveRoleDescriptor(config, id)
    return [role, ...(role.escalation ? [{ ...role, ...role.escalation }] : [])]
  })
  for (const body of [definition, ...Object.values(definition.components ?? {})]) for (const node of Object.values(body.nodes)) {
    if (node.kind !== 'prompt') continue
    const engine = node.params.engine as { provider: string; model?: string; effort?: string }
    registry.validateLimits(engine.provider, budget)
    if (engine.effort) assertEffortSupported(engine, await registry.capabilities(engine.provider, engine.model))
  }
  for (const engine of engines) {
    registry.validateLimits(engine.provider, budget)
    if (engine.effort) assertEffortSupported(engine, await registry.capabilities(engine.provider, engine.model))
  }
  const request: DefinitionRunRequest = { context, config, ...(input.change ? { change: input.change } : {}) }
  return { request, definition, registry, budget, roles }
}
