/**
 * Route overrides (capability `routeOverrides`): a host resumes a definition run with
 * some roles moved to another provider/model/effort for the REST of that run — for
 * example after the original provider refused on its usage limit. The frozen request
 * (agent-runtime-request.json and the ledger's request_json) never changes: each
 * accepted override is a durable `routes_overridden` ledger event, and every later
 * admission of the run applies the recorded overrides in order on top of the frozen
 * configuration. Completed attempts keep the provider they ran on (invocations record
 * it), so spend stays attributed per provider; a moved role's session never carries
 * across (its session identity includes the selection), so its next turn starts fresh.
 */
import { readFileSync } from 'node:fs'
import { BUILTIN_ROLES, ROLE_ID, isBuiltinRole, type RuntimeAgentConfig, type RuntimeConfig, type RuntimeProviderConfig } from '../executor-types.js'
import type { RunDatabase } from './checkpoint/database.js'
import { EngineError } from './contracts.js'

export const ROUTE_OVERRIDES_VERSION = 1
export const ROUTE_OVERRIDE_EVENT = 'routes_overridden'
const MAX_REQUEST_BYTES = 64 * 1024
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TOKEN = /^[a-z][a-z0-9-]{0,63}$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/
const CLIS = ['claude', 'codex', 'gemini', 'kimi'] as const

export interface RouteOverride { provider: string; model?: string; effort?: string }
export interface RouteOverrideRequest {
  schemaVersion: 1
  /** Idempotency key: the same id with the same routes is accepted once; a different body is a conflict. */
  requestId: string
  /** Why the host moved the roles (lowercase token, e.g. `provider-limit`). */
  reason?: string
  /** The provider the roles leave (informational; recorded in the ledger). */
  fromProvider?: string
  /** Role id (`architect`, `developer`, `reviewer`, `fixer` or a configured custom role) → its new route. */
  routes: Record<string, RouteOverride>
  /** CLI provider connections the frozen configuration lacks (the target provider), never an API connection. */
  providers?: Array<Extract<RuntimeProviderConfig, { kind: 'cli' }>>
}

const invalid = (message: string): never => { throw new EngineError('invalid_route_override', message) }
const object = (value: unknown, field: string): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid(`${field} must be an object`)
const only = (value: Record<string, unknown>, keys: string[], field: string): void => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${field}.${key} is not a known field`)
}

/** Structural validation; the effective configuration is validated again at admission. */
export function parseRouteOverrideRequest(input: unknown): RouteOverrideRequest {
  const value = object(input, 'route override')
  only(value, ['schemaVersion', 'requestId', 'reason', 'fromProvider', 'routes', 'providers'], 'route override')
  if (value.schemaVersion !== ROUTE_OVERRIDES_VERSION) invalid('schemaVersion must be 1')
  if (typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) invalid('requestId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  if (value.reason !== undefined && (typeof value.reason !== 'string' || !TOKEN.test(value.reason))) invalid('reason must be a lowercase token')
  if (value.fromProvider !== undefined && (typeof value.fromProvider !== 'string' || !PROVIDER_ID.test(value.fromProvider))) invalid('fromProvider must be a provider id')
  const rawRoutes = object(value.routes, 'routes')
  const routes: Record<string, RouteOverride> = {}
  for (const [role, raw] of Object.entries(rawRoutes)) {
    if (role !== 'fixer' && !ROLE_ID.test(role)) invalid(`routes.${role} is not a role id`)
    const route = object(raw, `routes.${role}`)
    only(route, ['provider', 'model', 'effort'], `routes.${role}`)
    if (typeof route.provider !== 'string' || !PROVIDER_ID.test(route.provider)) invalid(`routes.${role}.provider must be a provider id`)
    if (route.model !== undefined && (typeof route.model !== 'string' || !route.model.trim() || route.model.length > 256 || /[\r\n\0]/.test(route.model) || route.model.startsWith('-'))) invalid(`routes.${role}.model is not a model id`)
    if (route.effort !== undefined && (typeof route.effort !== 'string' || !EFFORT.test(route.effort))) invalid(`routes.${role}.effort is not an effort id`)
    routes[role] = { provider: route.provider as string, ...(route.model === undefined ? {} : { model: route.model as string }), ...(route.effort === undefined ? {} : { effort: route.effort as string }) }
  }
  if (!Object.keys(routes).length) invalid('routes must name at least one role')
  let providers: RouteOverrideRequest['providers']
  if (value.providers !== undefined) {
    if (!Array.isArray(value.providers) || value.providers.length > 8) invalid('providers must be an array of at most 8 CLI connections')
    providers = (value.providers as unknown[]).map((item, index) => {
      const provider = object(item, `providers[${index}]`)
      only(provider, ['id', 'kind', 'cli'], `providers[${index}]`)
      if (provider.kind !== 'cli' || !CLIS.includes(provider.cli as typeof CLIS[number])) invalid(`providers[${index}] must be a CLI connection (${CLIS.join(', ')})`)
      if (typeof provider.id !== 'string' || !PROVIDER_ID.test(provider.id)) invalid(`providers[${index}].id must be a provider id`)
      return { id: provider.id as string, kind: 'cli' as const, cli: provider.cli as typeof CLIS[number] }
    })
  }
  return { schemaVersion: 1, requestId: value.requestId as string, ...(value.reason === undefined ? {} : { reason: value.reason as string }),
    ...(value.fromProvider === undefined ? {} : { fromProvider: value.fromProvider as string }), routes, ...(providers ? { providers } : {}) }
}

export function readRouteOverrideFile(file: string): RouteOverrideRequest {
  let text: string
  try {
    const bytes = readFileSync(file)
    if (bytes.byteLength > MAX_REQUEST_BYTES) invalid(`Route override exceeds ${MAX_REQUEST_BYTES} bytes`)
    text = bytes.toString('utf8')
  } catch (error) { if (error instanceof EngineError) throw error; return invalid('Route override file is unreadable') }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return invalid('Route override is not valid JSON') }
  return parseRouteOverrideRequest(parsed)
}

/** The selection a moved role runs on: the new route, keeping only the role's turn ceiling. Escalation and thinking belong to the old engine. */
function moved(previous: RuntimeAgentConfig | undefined, route: RouteOverride): RuntimeAgentConfig {
  return { provider: route.provider, ...(route.model === undefined ? {} : { model: route.model }), ...(route.effort === undefined ? {} : { effort: route.effort }),
    ...(previous?.maxTurns === undefined ? {} : { maxTurns: previous.maxTurns }) }
}

/** The frozen configuration with the overrides applied in order. Unknown roles are refused. */
export function applyRouteOverrides(frozen: RuntimeConfig, overrides: readonly RouteOverrideRequest[]): RuntimeConfig {
  const config = structuredClone(frozen)
  for (const override of overrides) {
    for (const provider of override.providers ?? []) {
      const existing = config.providers.find(item => item.id === provider.id)
      if (!existing) config.providers.push(provider)
      else if (existing.kind !== 'cli' || existing.cli !== provider.cli) invalid(`Provider ${provider.id} is already configured differently`)
    }
    for (const [role, route] of Object.entries(override.routes)) {
      if (role === 'fixer') {
        if (!config.fixer) invalid('This run has no fixer engine to move')
        config.fixer = moved(config.fixer, route)
      } else if (isBuiltinRole(role)) {
        config.agents[role] = moved(config.agents[role], route)
        // A normalized configuration mirrors built-ins under roles; both must stay equal.
        if (config.roles?.[role]) { const { access, artifacts, prompt, openspecSkill } = config.roles[role]; config.roles[role] = { ...config.agents[role], access, artifacts, ...(prompt === undefined ? {} : { prompt }), ...(openspecSkill === undefined ? {} : { openspecSkill }) } }
      } else {
        const descriptor = config.roles?.[role]
        if (!descriptor) invalid(`Role ${role} is not configured for this run`)
        const { access, artifacts, prompt, openspecSkill } = descriptor!
        config.roles![role] = { ...moved(descriptor, route), access, artifacts, ...(prompt === undefined ? {} : { prompt }), ...(openspecSkill === undefined ? {} : { openspecSkill }) }
      }
    }
  }
  return config
}

/** Every override the run accepted, oldest first (inherited by a fork when recorded before its cut). */
export function recordedRouteOverrides(database: RunDatabase): RouteOverrideRequest[] {
  return database.sqlite.prepare('SELECT payload_json FROM events WHERE type=? ORDER BY sequence').all(ROUTE_OVERRIDE_EVENT)
    .map(row => parseRouteOverrideRequest((JSON.parse(String(row.payload_json)) as { payload: unknown }).payload))
}

/** Same request id and body: already applied. Same id, different body: a conflict. */
export function routeOverrideRecorded(recorded: readonly RouteOverrideRequest[], request: RouteOverrideRequest): boolean {
  const same = recorded.find(item => item.requestId === request.requestId)
  if (!same) return false
  if (JSON.stringify(same) !== JSON.stringify(request)) throw new EngineError('control_conflict', 'A different route override already used this request id')
  return true
}

/** Roles whose effective route changes, for the host's run log. */
export function overriddenRoles(request: RouteOverrideRequest): string[] {
  return Object.keys(request.routes).sort((a, b) => (BUILTIN_ROLES as readonly string[]).indexOf(a) - (BUILTIN_ROLES as readonly string[]).indexOf(b) || a.localeCompare(b))
}
