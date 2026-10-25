import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { PipelineContext } from '../../pipeline/pipeline-state.js'
import { changeSet } from '../change-scope.js'
import { child, write } from './artifacts.js'

/**
 * `openspec/capability-map.json`: for every capability, the files archived
 * changes touched. The archive node maintains it; baseline-on-touch reads it
 * to decide whether the blast radius of a new change is already covered by a
 * capability. Paths are repository-relative, prefixed `<repositoryId>:` for
 * repositories other than the artifact repository.
 */
export const CAPABILITY_MAP_PATH = 'openspec/capability-map.json'
export const CAPABILITY_MAP_SCHEMA_VERSION = 1
const FILE_LIMIT = 2000
const CHANGE_LIMIT = 500

export interface CapabilityEntry { files: string[]; changes: string[] }
export interface CapabilityMap { schemaVersion: typeof CAPABILITY_MAP_SCHEMA_VERSION; capabilities: Record<string, CapabilityEntry> }

export function readCapabilityMap(context: Pick<PipelineContext, 'artifactRoot'>): CapabilityMap {
  try {
    const file = child(context.artifactRoot, CAPABILITY_MAP_PATH)
    if (!existsSync(file)) return { schemaVersion: CAPABILITY_MAP_SCHEMA_VERSION, capabilities: {} }
    const value = JSON.parse(readFileSync(file, 'utf8')) as CapabilityMap
    if (value?.schemaVersion !== CAPABILITY_MAP_SCHEMA_VERSION || !value.capabilities || typeof value.capabilities !== 'object') return { schemaVersion: CAPABILITY_MAP_SCHEMA_VERSION, capabilities: {} }
    return value
  } catch { return { schemaVersion: CAPABILITY_MAP_SCHEMA_VERSION, capabilities: {} } }
}
/** `<repositoryId>:<path>` outside the artifact repository, the bare path inside it. */
export function qualifiedPath(context: Pick<PipelineContext, 'artifactRepositoryId'>, repositoryId: string, file: string): string {
  return repositoryId === context.artifactRepositoryId ? file : repositoryId + ':' + file
}
/** Capabilities a change's delta specs touch (active or archived change directory). */
export function changeCapabilities(changeDirectory: string): string[] {
  const specs = path.join(changeDirectory, 'specs')
  try { return readdirSync(specs, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(path.join(specs, entry.name, 'spec.md'))).map(entry => entry.name).sort() } catch { return [] }
}

/**
 * Merges an archived change into the map: its capabilities gain the files the
 * run changed (OpenSpec artifacts and Core metadata excluded). Idempotent, so
 * a repeated archive step after a crash records nothing twice.
 */
export function recordArchivedChange(context: PipelineContext, change: string, archiveDirectory: string): CapabilityMap {
  const capabilities = changeCapabilities(archiveDirectory)
  const map = readCapabilityMap(context)
  if (!capabilities.length) return map
  const files = changeSet(context, change).flatMap(set => set.files.filter(file => file.status !== 'deleted' && !/^(?:openspec|\.specrails)\//.test(file.path)).map(file => qualifiedPath(context, set.repositoryId, file.path)))
  for (const capability of capabilities) {
    const entry = map.capabilities[capability] ?? { files: [], changes: [] }
    map.capabilities[capability] = {
      files: [...new Set([...entry.files, ...files])].sort().slice(0, FILE_LIMIT),
      changes: [...new Set([...entry.changes, change])].slice(-CHANGE_LIMIT),
    }
  }
  map.capabilities = Object.fromEntries(Object.entries(map.capabilities).sort(([left], [right]) => left.localeCompare(right, 'en')))
  write(child(context.artifactRoot, CAPABILITY_MAP_PATH), JSON.stringify(map, null, 2) + '\n')
  return map
}
