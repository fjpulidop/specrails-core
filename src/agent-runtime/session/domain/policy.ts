import { SessionError } from './errors.js'
import type { DriverDescriptor, McpServerSpec, SessionLimits, SessionPolicy, SubagentRuntime } from './types.js'

/** Defaults chosen from the provider spike and Desktop's previous mission limits. */
export const DEFAULT_LIMITS: SessionLimits = Object.freeze({
  idleMs: 10 * 60_000,
  stallMs: 15 * 60_000,
  backgroundMaxMs: 2 * 60 * 60_000,
  turnInactivityMs: 5 * 60_000,
  maxSettleHandoffs: 3,
  settleDebounceMs: 1_500,
})

const LIMIT_BOUNDS: Readonly<Record<keyof SessionLimits, readonly [number, number]>> = Object.freeze({
  idleMs: [1_000, 24 * 60 * 60_000],
  stallMs: [1_000, 24 * 60 * 60_000],
  backgroundMaxMs: [1_000, 7 * 24 * 60 * 60_000],
  turnInactivityMs: [1_000, 24 * 60 * 60_000],
  maxSettleHandoffs: [0, 20],
  settleDebounceMs: [0, 60_000],
})

/** What a host may send in `session.open` / `session.update`. Only `subagents` is mandatory. */
export interface SessionPolicyInput {
  subagents: SessionPolicy['subagents']
  onSubagentsSettled?: SessionPolicy['onSubagentsSettled']
  tools?: SessionPolicy['tools']
  permissions?: SessionPolicy['permissions']
  mcp?: { servers?: McpServerSpec[]; inheritUserScope?: boolean }
  limits?: Partial<SessionLimits>
  subagentRuntime?:
    | { mode: 'native'; model?: string; effort?: string }
    | { mode: 'delegated'; driver: string; model: string; effort?: string; maxConcurrent?: number }
}

export const DEFAULT_MAX_DELEGATED = 4
const MAX_DELEGATED_BOUNDS = [1, 16] as const

/** Validate the sub-agent runtime against what the parent driver can enforce. */
function resolveRuntime(input: SessionPolicyInput, driver: DriverDescriptor): SubagentRuntime {
  const runtime = input.subagentRuntime ?? { mode: 'native' as const }
  const caps = driver.capabilities
  if (runtime.mode === 'native') {
    if (runtime.model && !caps.subagentModel) throw unenforceable(`Driver "${driver.id}" cannot choose a model for its own sub-agents`, { field: 'subagentRuntime.model', driver: driver.id })
    if (runtime.effort && !caps.subagentEffort) throw unenforceable(`Driver "${driver.id}" cannot choose an effort for its own sub-agents`, { field: 'subagentRuntime.effort', driver: driver.id })
    return { mode: 'native', ...(runtime.model ? { model: runtime.model } : {}), ...(runtime.effort ? { effort: runtime.effort } : {}) }
  }
  // Delegated: the parent's own tool must be switchable off, or the setting would not hold.
  if (caps.subagents === 'supported' && !caps.subagentDisable) {
    throw unenforceable(`Driver "${driver.id}" cannot disable its own sub-agents, so Core cannot launch them instead`, { field: 'subagentRuntime.mode', driver: driver.id })
  }
  const maxConcurrent = runtime.maxConcurrent ?? DEFAULT_MAX_DELEGATED
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < MAX_DELEGATED_BOUNDS[0] || maxConcurrent > MAX_DELEGATED_BOUNDS[1]) {
    throw new SessionError('invalid_params', `policy.subagentRuntime.maxConcurrent must be an integer in [${MAX_DELEGATED_BOUNDS[0]}, ${MAX_DELEGATED_BOUNDS[1]}]`, { path: 'policy.subagentRuntime.maxConcurrent' })
  }
  if (!runtime.model) throw new SessionError('invalid_params', 'Delegated sub-agents need a model', { path: 'policy.subagentRuntime.model' })
  return { mode: 'delegated', driver: runtime.driver, model: runtime.model, ...(runtime.effort ? { effort: runtime.effort } : {}), maxConcurrent }
}

function unenforceable(message: string, detail: Record<string, unknown>): SessionError {
  return new SessionError('policy_unenforceable', message, detail)
}

function resolveLimits(input: Partial<SessionLimits> | undefined): SessionLimits {
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(input ?? {}) as Array<[keyof SessionLimits, number | undefined]>) {
    if (value === undefined) continue
    const bounds = LIMIT_BOUNDS[key]
    if (!bounds) throw new SessionError('invalid_params', `Unknown limit "${key}"`, { path: `policy.limits.${key}` })
    if (!Number.isInteger(value) || value < bounds[0] || value > bounds[1]) {
      throw new SessionError('invalid_params', `policy.limits.${key} must be an integer in [${bounds[0]}, ${bounds[1]}]`, { path: `policy.limits.${key}` })
    }
    limits[key] = value
  }
  return limits
}

/**
 * Resolve a host policy against a driver's declared capabilities. The result is
 * fully specified; anything the driver cannot enforce is refused, never ignored.
 */
export function resolvePolicy(input: SessionPolicyInput, driver: DriverDescriptor): SessionPolicy {
  const caps = driver.capabilities
  const supportsSubagents = caps.subagents === 'supported'

  if (input.subagents === 'disabled' && supportsSubagents && !caps.subagentDisable) {
    throw unenforceable(`Driver "${driver.id}" cannot disable sub-agents`, { field: 'subagents', driver: driver.id })
  }

  const onSubagentsSettled = input.onSubagentsSettled ?? (caps.autonomousContinuation ? 'provider-native' : 'resume-agent')
  if (onSubagentsSettled === 'provider-native' && supportsSubagents && input.subagents === 'enabled' && !caps.autonomousContinuation) {
    throw unenforceable(`Driver "${driver.id}" does not continue on its own after sub-agents finish`, { field: 'onSubagentsSettled', driver: driver.id })
  }

  const tools = input.tools ?? { mode: 'default' as const }
  if (!caps.toolFiltering && (tools.mode !== 'default' || tools.allow?.length || tools.deny?.length)) {
    throw unenforceable(`Driver "${driver.id}" cannot restrict its tool set`, { field: 'tools', driver: driver.id })
  }
  if (tools.mode === 'none' && caps.resident && caps.subagents === 'supported' && input.subagents === 'enabled') {
    throw unenforceable('A session without tools cannot launch sub-agents; disable sub-agents or allow tools', { field: 'tools.mode' })
  }

  return {
    subagents: input.subagents,
    subagentRuntime: resolveRuntime(input, driver),
    onSubagentsSettled,
    tools: { mode: tools.mode, ...(tools.allow ? { allow: [...tools.allow] } : {}), ...(tools.deny ? { deny: [...tools.deny] } : {}) },
    permissions: input.permissions ?? 'workspace-write',
    mcp: { servers: [...(input.mcp?.servers ?? [])], inheritUserScope: input.mcp?.inheritUserScope ?? false },
    limits: resolveLimits(input.limits),
  }
}

/** True when the provider's own sub-agents may run (enabled and not delegated to Core). */
export function nativeSubagentsAllowed(policy: SessionPolicy): boolean {
  return policy.subagents === 'enabled' && policy.subagentRuntime.mode === 'native'
}

/** True when Core launches this session's sub-agents itself. */
export function delegatedSubagents(policy: SessionPolicy): policy is SessionPolicy & { subagentRuntime: Extract<SubagentRuntime, { mode: 'delegated' }> } {
  return policy.subagents === 'enabled' && policy.subagentRuntime.mode === 'delegated'
}

/** True when the effective native sub-agent behaviour of the session is "enabled". */
export function subagentsActive(policy: SessionPolicy, driver: DriverDescriptor): boolean {
  return nativeSubagentsAllowed(policy) && driver.capabilities.subagents === 'supported'
}
