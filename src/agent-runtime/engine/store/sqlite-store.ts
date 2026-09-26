import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { BaseStore, type Item, type Operation, type OperationResults, type SearchItem, type SearchOperation } from '@langchain/langgraph-checkpoint'
import { canonicalJson } from '../canonical-json.js'
import { EngineError, type JsonObject } from '../contracts.js'
import { privateSqlitePath } from '../storage/private-path.js'

export interface ProjectMemory {
  get(namespace: string[], key: string): Promise<Item | null>
  search(namespace: string[], options?: Omit<SearchOperation, 'namespacePrefix'>): Promise<SearchItem[]>
  put(namespace: string[], key: string, value: JsonObject): Promise<void>
  delete(namespace: string[], key: string): Promise<void>
}
const DEFAULT_NAMESPACES = [['roles', '*', 'sessions'], ['verification', 'known-commands'], ['review', 'notes']]
const matchesPrefix = (namespace: readonly string[], prefix: readonly string[]) => namespace.length >= prefix.length && prefix.every((part, index) => part === '*' || part === namespace[index])
const fail = (message: string): never => { throw new EngineError('invalid_arguments', message) }
function namespaceCheck(namespace: string[], empty = false): void {
  if (!Array.isArray(namespace) || (!empty && !namespace.length) || namespace.length > 16 || namespace.some(part => typeof part !== 'string' || !part || part.length > 128 || part.includes('\0'))) fail('Store namespaces require 1–16 bounded string components')
}
function page(value: number | undefined, defaultValue: number, max: number): number {
  const result = value ?? defaultValue
  if (!Number.isSafeInteger(result) || result < 0 || result > max) fail('Invalid bounded store pagination')
  return result
}
const equal = (a: unknown, b: unknown) => a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b)
function filterCheck(filter: Record<string, unknown> | undefined): void {
  if (filter === undefined) return
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) fail('Store filters must be JSON objects')
  canonicalJson(filter)
  for (const expected of Object.values(filter)) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && Object.keys(expected).some(key => key.startsWith('$'))) {
      for (const operator of Object.keys(expected)) if (!['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'].includes(operator)) fail(`Unsupported store filter ${operator}`)
    }
  }
}
function filtered(value: Record<string, unknown>, filter: Record<string, unknown> | undefined): boolean {
  return Object.entries(filter ?? {}).every(([key, expected]) => {
    const actual = Object.hasOwn(value, key) ? value[key] : undefined
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && Object.keys(expected).some(name => name.startsWith('$'))) {
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === '$eq') return equal(actual, operand)
        if (operator === '$ne') return !equal(actual, operand)
        if (!['$gt', '$gte', '$lt', '$lte'].includes(operator)) return fail(`Unsupported store filter ${operator}`)
        if (typeof actual !== typeof operand || !['number', 'string'].includes(typeof actual)) return false
        const left = actual as number, right = operand as number
        return operator === '$gt' ? left > right : operator === '$gte' ? left >= right : operator === '$lt' ? left < right : left <= right
      })
    }
    return equal(actual, expected)
  })
}
const item = (row: Record<string, SQLOutputValue>): Item => ({ namespace: JSON.parse(String(row.namespace)), key: String(row.key), value: JSON.parse(String(row.value)), createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)) })

/** One local project owns this store. It is independent of run history and is never copied by fork. */
export class SqliteProjectStore extends BaseStore {
  private closed = false
  private constructor(readonly filename: string, private readonly sqlite: DatabaseSync, private readonly readOnly: boolean) { super() }

  static async open(backlogRoot: string, options: { readOnly?: boolean } = {}): Promise<SqliteProjectStore> {
    const filename = path.join(path.resolve(backlogRoot), '.specrails', 'engine-store.sqlite')
    let target: string
    try { target = await privateSqlitePath(filename, { create: !options.readOnly && !existsSync(filename), readOnly: options.readOnly }) }
    catch (error) {
      // Independent runs may race to create the same project-owned file.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      target = await privateSqlitePath(filename, { readOnly: options.readOnly })
    }
    const sqlite = new DatabaseSync(target, { readOnly: options.readOnly ?? false })
    try {
      sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
      if (!options.readOnly) {
        sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
        try {
          const version = Number(sqlite.prepare('PRAGMA user_version').get()!.user_version)
          if (version === 0) sqlite.exec('CREATE TABLE items(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(namespace,key)); PRAGMA user_version=1;')
          else if (version !== 1) throw new EngineError('store_incompatible', `Unsupported project store schema ${version}`)
          sqlite.exec('COMMIT')
        } catch (error) { sqlite.exec('ROLLBACK'); throw error }
      } else if (Number(sqlite.prepare('PRAGMA user_version').get()!.user_version) !== 1) throw new EngineError('store_incompatible', 'Unsupported project store schema')
      return new SqliteProjectStore(target, sqlite, options.readOnly ?? false)
    } catch (error) { sqlite.close(); throw error }
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    if (!Array.isArray(operations) || operations.length > 1000) fail('A store batch is limited to 1000 operations')
    if (this.closed) throw new EngineError('store_closed', 'Project store is closed')
    const write = operations.some(operation => 'value' in operation)
    if (write && this.readOnly) throw new EngineError('store_access_denied', 'This store connection is read-only')
    this.sqlite.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try {
      const results = operations.map(operation => this.operation(operation)) as OperationResults<Op>
      this.sqlite.exec('COMMIT'); return results
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error }
  }

  private operation(operation: Operation): Item | SearchItem[] | string[][] | null | undefined {
    if ('namespace' in operation) {
      namespaceCheck(operation.namespace)
      if (typeof operation.key !== 'string' || !operation.key || operation.key.length > 256 || operation.key.includes('\0')) fail('Store keys require 1–256 characters')
      const namespace = canonicalJson(operation.namespace)
      if ('value' in operation) {
        if (operation.index !== undefined && operation.index !== false) throw new EngineError('store_index_unsupported', 'Project memory does not configure semantic indexing')
        if (operation.value === null) this.sqlite.prepare('DELETE FROM items WHERE namespace=? AND key=?').run(namespace, operation.key)
        else {
          if (!operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value)) fail('Store values must be JSON objects')
          const encoded = canonicalJson(operation.value)
          if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new EngineError('output_limit', 'Project store item exceeds 2 MiB')
          const at = new Date().toISOString()
          this.sqlite.prepare('INSERT INTO items VALUES(?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(namespace, operation.key, encoded, at, at)
        }
        return undefined
      }
      const row = this.sqlite.prepare('SELECT * FROM items WHERE namespace=? AND key=?').get(namespace, operation.key)
      return row ? item(row) : null
    }
    if ('namespacePrefix' in operation) {
      namespaceCheck(operation.namespacePrefix, true)
      if (operation.query !== undefined) throw new EngineError('store_query_unsupported', 'Project memory supports metadata filters, without semantic search')
      const limit = page(operation.limit, 10, 1000), offset = page(operation.offset, 0, 1_000_000)
      filterCheck(operation.filter)
      if (!limit) return []
      // Prefix predicates are parameterized JSON array components, never SQL identifiers.
      const prefix = operation.namespacePrefix
      const where = ['json_array_length(namespace)>=?', ...prefix.map((_, i) => `json_extract(namespace,'$[${i}]')=?`)].join(' AND ')
      const result: SearchItem[] = []; let skipped = 0
      for (const row of this.sqlite.prepare(`SELECT * FROM items WHERE ${where} ORDER BY namespace,key`).iterate(prefix.length, ...prefix)) {
        const found = item(row)
        if (!filtered(found.value, operation.filter)) continue
        if (skipped++ < offset) continue
        result.push(found)
        if (result.length === limit) break
      }
      return result
    }
    const limit = page(operation.limit, 100, 1000), offset = page(operation.offset, 0, 1_000_000), maxDepth = operation.maxDepth === undefined ? 16 : page(operation.maxDepth, 16, 16)
    if (!maxDepth) fail('Namespace maximum depth must be positive')
    const conditions = operation.matchConditions ?? []
    for (const condition of conditions) { namespaceCheck(condition.path, true); if (!['prefix', 'suffix'].includes(condition.matchType)) fail('Invalid namespace match type') }
    if (!limit) return []
    const seen = new Set<string>(), result: string[][] = []; let skipped = 0
    for (const row of this.sqlite.prepare('SELECT DISTINCT namespace FROM items ORDER BY namespace').iterate()) {
      const namespace = JSON.parse(String(row.namespace)) as string[]
      if (!conditions.every(condition => condition.matchType === 'prefix' ? matchesPrefix(namespace, condition.path) : matchesPrefix([...namespace].reverse(), [...condition.path].reverse()))) continue
      const selected = namespace.slice(0, maxDepth), encoded = canonicalJson(selected)
      if (seen.has(encoded)) continue
      seen.add(encoded)
      if (skipped++ < offset) continue
      result.push(selected)
      if (result.length === limit) break
    }
    return result
  }

  /** Composition grants only a declared capability and namespace subtree to a piece. */
  forAccess(access: 'none' | 'read' | 'write', options: { namespacePrefixes?: readonly (readonly string[])[] } = {}): ProjectMemory {
    const allowed = (options.namespacePrefixes ?? DEFAULT_NAMESPACES).map(prefix => [...prefix])
    for (const prefix of allowed) namespaceCheck(prefix)
    const authorize = (namespace: string[], write = false) => {
      namespaceCheck(namespace)
      if (access === 'none' || (write && access !== 'write') || !allowed.some(prefix => matchesPrefix(namespace, prefix))) throw new EngineError('store_access_denied', 'Piece has no declared access to this project memory namespace')
    }
    return Object.freeze({
      get: async (namespace: string[], key: string) => { authorize(namespace); return this.get(namespace, key) },
      search: async (namespace: string[], options?: Omit<SearchOperation, 'namespacePrefix'>) => { authorize(namespace); return this.search(namespace, options) },
      put: async (namespace: string[], key: string, value: JsonObject) => { authorize(namespace, true); await this.put(namespace, key, value) },
      delete: async (namespace: string[], key: string) => { authorize(namespace, true); await this.delete(namespace, key) },
    })
  }

  close(): void { if (!this.closed) { this.sqlite.close(); this.closed = true } }
}
