import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fingerprint } from './durable-store.js'
import { write } from './graph/artifacts.js'
import type { AgentRole } from './executor-types.js'
import type { RepositoryContextSnapshot } from './repository-context.js'

export interface RoleSession {
  identity: string
  sessionId: string
  context: RepositoryContextSnapshot
}
export interface RoleExecutionState {
  sessions: Partial<Record<AgentRole, RoleSession>>
  routes: Partial<Record<AgentRole, { tier: 'base' | 'escalation'; reason: string; attemptId: string }>>
}
/** Host-owned auxiliary state lives under the workflow's existing run lease.
 * A corrupted packet fails explicitly; it is never used as missing context. */
export function readRoleState(directory: string): RoleExecutionState {
  const file = path.join(directory, 'role-execution.json')
  if (!existsSync(file)) return { sessions: {}, routes: {} }
  if (statSync(file).size > 2 * 1024 * 1024) throw new Error('Role execution state exceeds its size limit')
  const envelope = JSON.parse(readFileSync(file, 'utf8'))
  if (envelope.schemaVersion !== 1 || envelope.checksum !== fingerprint(envelope.data) || !envelope.data?.sessions || !envelope.data?.routes) throw new Error('Role execution state failed its integrity check')
  return envelope.data as RoleExecutionState
}
export function writeRoleState(directory: string, data: RoleExecutionState): void {
  const content = JSON.stringify({ schemaVersion: 1, checksum: fingerprint(data), data }) + '\n'
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Role execution state exceeds its size limit')
  write(path.join(directory, 'role-execution.json'), content)
}
