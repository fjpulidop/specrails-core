import type { AgentExecutor } from '../../executor-types.js'
import { validateDescriptor } from '../domain/descriptor.js'
import type { DriverDescriptor } from '../domain/types.js'
import type { DriverCatalog, DriverFactory } from '../ports.js'
import { ClaudeDriverFactory, type ClaudeDriverOptions } from './claude/driver.js'
import { CodexDriverFactory, type CodexDriverOptions } from './codex/driver.js'
import { ExecutorDriverFactory, executorDescriptor, type ExecutorDriverOptions } from './executor/driver.js'

/**
 * Closed, frozen registry of session drivers (like the engine PieceRegistry).
 * Adding a provider is a reviewed change: a drivers/<id>/ folder, an entry
 * here, and a passing conformance run. Duplicate ids and invalid descriptors
 * are rejected at construction.
 */
export class DriverRegistry implements DriverCatalog {
  private readonly factories: ReadonlyMap<string, DriverFactory>

  constructor(factories: readonly DriverFactory[]) {
    const map = new Map<string, DriverFactory>()
    for (const factory of factories) {
      validateDescriptor(factory.descriptor)
      if (map.has(factory.descriptor.id)) throw new Error(`Duplicate session driver "${factory.descriptor.id}"`)
      map.set(factory.descriptor.id, factory)
    }
    this.factories = map
    Object.freeze(this)
  }

  get(driverId: string): DriverFactory | undefined {
    return this.factories.get(driverId)
  }

  descriptors(): DriverDescriptor[] {
    return [...this.factories.values()].map((factory) => factory.descriptor)
  }
}

export interface DriverRegistryOptions {
  claude?: ClaudeDriverOptions | false
  codex?: CodexDriverOptions | false
  /** Non-resident providers backed by existing batch executors (Gemini, Kimi, OpenAI-compatible connections). */
  executors?: Array<{ id: string; displayName: string; executor: AgentExecutor; options?: ExecutorDriverOptions }>
  /** Extra factories (tests, embedding hosts). */
  extra?: DriverFactory[]
}

export function createDriverRegistry(options: DriverRegistryOptions = {}): DriverRegistry {
  return new DriverRegistry([
    ...(options.claude === false ? [] : [new ClaudeDriverFactory(options.claude ?? {})]),
    ...(options.codex === false ? [] : [new CodexDriverFactory(options.codex ?? {})]),
    ...(options.executors ?? []).map((entry) => new ExecutorDriverFactory(executorDescriptor(entry.id, entry.displayName), entry.executor, entry.options ?? {})),
    ...(options.extra ?? []),
  ])
}
