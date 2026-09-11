import type { AgentExecutor, AgentLimits, AgentRequest, AgentResult, RuntimeConfig } from './executor-types.js'
import { AgentExecutionError, validateAgentRequest } from './executor-types.js'
import { validateRuntimeConfig } from './config.js'
import { CliExecutor, type CliExecutorOptions } from './cli-executor.js'
import { OpenAICompatibleExecutor, type OpenAICompatibleOptions } from './openai-executor.js'

export { CliExecutor, buildCliInvocation, parseCliOutput } from './cli-executor.js'
export { OpenAICompatibleExecutor } from './openai-executor.js'
export { AgentExecutionError } from './executor-types.js'
export type * from './executor-types.js'
export class ExecutorRegistry {
  private readonly executors = new Map<string, AgentExecutor>()
  register(id: string, executor: AgentExecutor): this {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || typeof executor?.execute !== 'function') throw new Error('Invalid executor registration')
    this.executors.set(id, executor)
    return this
  }
  get(id: string): AgentExecutor {
    const executor = this.executors.get(id)
    if (!executor) throw new AgentExecutionError(`No executor registered for provider '${id}'`, 'provider_not_found')
    return executor
  }
  ids(): string[] { return [...this.executors.keys()] }
  validateLimits(id: string, limits: AgentLimits): void { this.get(id).validateLimits?.(limits) }
  async execute(id: string, request: AgentRequest): Promise<AgentResult> {
    validateAgentRequest(request)
    const result = await this.get(id).execute(request)
    if (!result || typeof result.text !== 'string' || !result.text.trim() || !result.usage || ['inputTokens', 'outputTokens', 'costUsd'].some(key => {
      const value = result.usage[key as keyof typeof result.usage]
      return value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    })) throw new AgentExecutionError('Executor returned an invalid result', 'invalid_executor_result')
    return result
  }
}
export interface ExecutorRegistryOptions {
  cli?: CliExecutorOptions
  openai?: OpenAICompatibleOptions
  /** Programmatic registrations replace configured executors or add new provider aliases. */
  executors?: Record<string, AgentExecutor>
}
export function createExecutorRegistry(input: RuntimeConfig, options: ExecutorRegistryOptions = {}): ExecutorRegistry {
  const config = validateRuntimeConfig(input, { registeredProviderIds: Object.keys(options.executors ?? {}) })
  const registry = new ExecutorRegistry()
  for (const provider of config.providers) registry.register(provider.id, provider.kind === 'cli' ? new CliExecutor(provider.cli, options.cli) : new OpenAICompatibleExecutor(provider, options.openai))
  for (const [id, executor] of Object.entries(options.executors ?? {})) registry.register(id, executor)
  return registry
}
