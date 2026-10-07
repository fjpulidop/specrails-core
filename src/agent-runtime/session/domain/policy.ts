import { SessionError } from './errors.js'
import type { DriverDescriptor, McpServerSpec, SessionLimits, SessionPolicy } from './types.js'

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
  if (tools.mode === 'none' && caps.resident && caps.subagents === 'supported' && input.subagents === 'enabled') {
    throw unenforceable('A session without tools cannot launch sub-agents; disable sub-agents or allow tools', { field: 'tools.mode' })
  }

  return {
    subagents: input.subagents,
    onSubagentsSettled,
    tools: { mode: tools.mode, ...(tools.allow ? { allow: [...tools.allow] } : {}), ...(tools.deny ? { deny: [...tools.deny] } : {}) },
    permissions: input.permissions ?? 'workspace-write',
    mcp: { servers: [...(input.mcp?.servers ?? [])], inheritUserScope: input.mcp?.inheritUserScope ?? false },
    limits: resolveLimits(input.limits),
  }
}

/** True when the effective sub-agent behaviour of the session is "enabled". */
export function subagentsActive(policy: SessionPolicy, driver: DriverDescriptor): boolean {
  return policy.subagents === 'enabled' && driver.capabilities.subagents === 'supported'
}
