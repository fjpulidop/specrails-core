import { readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { runCliProcess, type CliProcessRunner } from './cli-process.js'
import { AgentExecutionError, type CliProvider, type ExecutorCapabilities, type RuntimeAgentConfig, type RuntimeConfig } from './executor-types.js'
import type { ExecutorRegistry } from './executors.js'

export function unknownCapabilities(transport: string): ExecutorCapabilities {
  return { transport, continuation: 'unknown', effortSupport: 'unknown', supportedEfforts: null, observedModel: false, observedEffort: false }
}

/** Introspection never calls an inference endpoint. A flag is not proof that
 * a transport restores history, so built-in continuation stays conservative. */
export async function cliCapabilities(provider: CliProvider, model: string | undefined, options: { runProcess?: CliProcessRunner; env?: NodeJS.ProcessEnv } = {}): Promise<ExecutorCapabilities> {
  const result = unknownCapabilities(provider === 'kimi' ? 'kimi-acp' : `${provider}-cli`)
  if (provider === 'kimi') return { ...result, continuation: 'unsupported', effortSupport: 'unsupported', supportedEfforts: [] }
  if (provider === 'gemini') return result
  const env = options.env ?? process.env
  try {
    const runner = options.runProcess ?? runCliProcess
    const help = await runner({ command: provider, args: ['--help'] }, { cwd: tmpdir(), env, timeoutMs: 10_000 })
    if (help.exitCode !== 0) return result
    if (provider === 'claude') {
      const section = /--effort\s+<[^>]+>([\s\S]*?)(?=\n\s+--|$)/.exec(help.stdout)?.[1]
      const levels = section?.match(/\(([^)]+)\)/)?.[1].split(',').map(value => value.trim())
      if (levels?.length && levels.every(value => /^[a-z][a-z0-9_-]{0,31}$/.test(value))) return { ...result, effortSupport: 'supported', supportedEfforts: levels }
    } else if (model && help.stdout.includes('--config')) {
      // Use the installed client's own bounded, fresh model catalog. Do not
      // infer reasoning support from a model prefix or another provider.
      const file = path.join(env.CODEX_HOME ?? path.join(env.HOME ?? homedir(), '.codex'), 'models_cache.json')
      if (statSync(file).size > 2 * 1024 * 1024) return result
      const cache = JSON.parse(readFileSync(file, 'utf8'))
      const age = Date.now() - Date.parse(cache.fetched_at)
      if (!Number.isFinite(age) || age < -60_000 || age > 24 * 60 * 60_000) return result
      const version = await runner({ command: provider, args: ['--version'] }, { cwd: tmpdir(), env, timeoutMs: 10_000 })
      if (version.exitCode !== 0 || version.stdout.trim() !== `codex-cli ${cache.client_version}`) return result
      const entry = Array.isArray(cache.models) ? cache.models.find((item: { slug?: unknown }) => item?.slug === model) : undefined
      const levels: unknown = entry?.supported_reasoning_levels?.map((item: { effort?: unknown }) => item?.effort)
      if (Array.isArray(levels) && levels.length && levels.every(value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value))) {
        return { ...result, effortSupport: 'supported', supportedEfforts: [...new Set(levels)] }
      }
    }
  } catch { /* Missing/stale metadata is unknown, never optimistic support. */ }
  return result
}

export function assertEffortSupported(selection: Pick<RuntimeAgentConfig, 'effort'>, capability: ExecutorCapabilities): void {
  if (selection.effort !== undefined && (capability.effortSupport !== 'supported' || !capability.supportedEfforts?.includes(selection.effort))) {
    throw new AgentExecutionError(`Requested effort '${selection.effort}' is not confirmed for ${capability.transport}. Select a supported effort or provider default.`, 'provider_capability_unsupported')
  }
}

export async function configuredCapabilities(config: RuntimeConfig, registry: ExecutorRegistry) {
  const probes = new Map<string, ReturnType<ExecutorRegistry['capabilities']>>()
  const probe = (provider: string, model?: string) => {
    const key = JSON.stringify([provider, model ?? null])
    if (!probes.has(key)) probes.set(key, registry.capabilities(provider, model))
    return probes.get(key)!
  }
  const roles = []
  for (const [role, selected] of Object.entries(config.agents)) {
    for (const [tier, choice] of [['base', selected], ...(selected.escalation ? [['escalation', selected.escalation]] : [])] as Array<[string, { model?: string; effort?: string }]>) {
      roles.push({ role, tier, provider: selected.provider, model: choice.model ?? null, requestedEffort: choice.effort ?? null, ...await probe(selected.provider, choice.model) })
    }
  }
  return { schemaVersion: 1 as const, roles }
}
