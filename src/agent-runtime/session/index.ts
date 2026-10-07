/**
 * Agent session runtime — public API and composition root.
 *
 * `createSessionRuntime` is the only place where the journal, drivers and the
 * application are wired together. Hosts talk to a running runtime over the
 * session protocol (`specrails-core runtime host --stdio`); embedding it
 * in-process is supported for tests and tools.
 */
import { randomUUID } from 'node:crypto'

import { GLOBAL_SESSION_SCOPE } from '../../shared/specrails-home.js'
import { SessionService, type SessionServiceOptions } from './application/session-service.js'
import type { RateCard } from './domain/usage.js'
import { createDriverRegistry, type DriverRegistryOptions } from './drivers/registry.js'
import { SqliteSessionJournal } from './journal/sqlite-journal.js'
import type { Clock, DriverCatalog, Ids, TimerHandle } from './ports.js'

export { SessionError, isSessionError, type SessionErrorCode } from './domain/errors.js'
export { SESSION_EVENT_TYPES, type SessionEvent, type SessionEventBody, type SessionEventEnvelope, type SessionEventType, type ToolActivity } from './domain/events.js'
export type { SessionSnapshot, SubagentNode, TurnRecord, InputRecord, OpenTurn } from './domain/snapshot.js'
export type { DriverCapabilities, DriverDescriptor, SessionLimits, SessionPolicy, Usage, McpServerSpec, Attachment } from './domain/types.js'
export type { SessionPolicyInput } from './domain/policy.js'
export { DEFAULT_LIMITS } from './domain/policy.js'
export { SessionService, type OpenParams, type SendParams } from './application/session-service.js'
export { createDriverRegistry, DriverRegistry, type DriverRegistryOptions } from './drivers/registry.js'
export type { DriverCatalog, DriverFactory, DriverSession, DriverEvent, SessionJournal } from './ports.js'
export { GLOBAL_SESSION_SCOPE }

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
  after(ms: number, callback: () => void): TimerHandle {
    const timer = setTimeout(callback, Math.max(0, ms))
    timer.unref?.()
    return { cancel: () => clearTimeout(timer) }
  },
}

export const randomIds: Ids = {
  session: () => `ses_${randomUUID()}`,
  turn: () => `turn_${randomUUID()}`,
  input: () => `in_${randomUUID()}`,
}

export interface SessionRuntimeOptions {
  /** Project key (slug) or `global`. */
  scope?: string
  /** Base home for `~/.specrails` (defaults honour SPECRAILS_REGISTRY_HOME). */
  home?: string
  /** Lease owner label; defaults to `host-<pid>`. */
  owner?: string
  drivers?: DriverCatalog | DriverRegistryOptions
  clock?: Clock
  ids?: Ids
  rateCard?: (driver: string, model: string) => RateCard | null
  maxResident?: number
  /** Called when another host takes over the journal; the runtime has stopped writing. */
  onLeaseLost?: () => void
  /** Explicit journal file (tests). */
  journalFile?: string
}

export interface SessionRuntime {
  scope: string
  service: SessionService
  journal: SqliteSessionJournal
  /** Sessions whose running work was recorded as interrupted at startup. */
  recovered: string[]
  /** Retire providers, record interruptions, release the lease. Idempotent. */
  close(): Promise<void>
}

function isCatalog(value: DriverCatalog | DriverRegistryOptions | undefined): value is DriverCatalog {
  return !!value && typeof (value as DriverCatalog).get === 'function' && typeof (value as DriverCatalog).descriptors === 'function'
}

export async function createSessionRuntime(options: SessionRuntimeOptions = {}): Promise<SessionRuntime> {
  const scope = options.scope ?? GLOBAL_SESSION_SCOPE
  let leaseLost = false
  const journal = await SqliteSessionJournal.open({
    scope,
    owner: options.owner ?? `host-${process.pid}`,
    ...(options.home ? { home: options.home } : {}),
    ...(options.journalFile ? { filename: options.journalFile } : {}),
    onLeaseLost: () => { leaseLost = true; options.onLeaseLost?.() },
  })
  const drivers = isCatalog(options.drivers) ? options.drivers : createDriverRegistry(options.drivers ?? {})
  const serviceOptions: SessionServiceOptions = {
    journal,
    drivers,
    clock: options.clock ?? systemClock,
    ids: options.ids ?? randomIds,
    ...(options.rateCard ? { rateCard: options.rateCard } : {}),
    ...(options.maxResident !== undefined ? { maxResident: options.maxResident } : {}),
  }
  const service = new SessionService(serviceOptions)
  // A predecessor that died without releasing the lease lost its host; otherwise it restarted.
  const recovered = service.recover(journal.lease.previous === 'lost' ? 'host_lost' : 'restart')
  let closing: Promise<void> | null = null
  return {
    scope,
    service,
    journal,
    recovered,
    close() {
      closing ??= (async () => {
        if (!leaseLost) await service.shutdown()
        journal.close()
      })()
      return closing
    },
  }
}
