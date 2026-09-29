import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteProjectStore } from './sqlite-store.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'project store with spaces '))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = await SqliteProjectStore.open(directory)
  cleanup.push(async () => store.close())
  return { store, directory }
}

describe('project SQLite BaseStore', () => {
  it('persists across runs while isolating projects and supporting deletion/read-only connections', async () => {
    const { store, directory } = await fixture(), other = await fixture(), ns = ['roles', 'reviewer', 'sessions']
    await store.put(ns, 'role', { session: 'private' })
    expect(await other.store.get(ns, 'role')).toBeNull()
    store.close()
    const reader = await SqliteProjectStore.open(directory, { readOnly: true })
    try {
      expect(await reader.get(ns, 'role')).toMatchObject({ value: { session: 'private' }, createdAt: expect.any(Date), updatedAt: expect.any(Date) })
      await expect(reader.put(ns, 'role', {})).rejects.toMatchObject({ code: 'store_access_denied' })
    } finally { reader.close() }
    const reopened = await SqliteProjectStore.open(directory)
    try { await reopened.delete(ns, 'role'); expect(await reopened.get(ns, 'role')).toBeNull() } finally { reopened.close() }
    if (process.platform !== 'win32') {
      expect(statSync(store.filename).mode & 0o777).toBe(0o600)
      expect(statSync(path.dirname(store.filename)).mode & 0o777).toBe(0o700)
    }
  })

  it('commits ordered batches atomically with read-your-writes and rolls back invalid operations', async () => {
    const { store } = await fixture(), ns = ['review', 'notes']
    const result = await store.batch([{ namespace: ns, key: 'one', value: { score: 1 } }, { namespace: ns, key: 'one' }])
    expect(result[1]).toMatchObject({ value: { score: 1 } })
    await expect(store.batch([{ namespace: ns, key: 'one', value: { score: 2 } }, { namespace: ns, key: 'two', value: { bad: Number.NaN } }])).rejects.toThrow()
    expect(await store.get(ns, 'one')).toMatchObject({ value: { score: 1 } })
    expect(await store.get(ns, 'two')).toBeNull()
    await expect(store.put(ns, 'one', { text: 'x'.repeat(2 * 1024 * 1024) })).rejects.toMatchObject({ code: 'output_limit' })
    await expect(store.put(ns, 'one', {}, ['text'])).rejects.toMatchObject({ code: 'store_index_unsupported' })
    expect(await store.get(ns, 'one')).toMatchObject({ value: { score: 1 } })
  })

  it('implements component prefixes, JSON comparisons, stable pagination and namespace wildcard lists', async () => {
    const { store } = await fixture()
    await store.batch([
      { namespace: ['roles', 'a', 'sessions'], key: '2', value: { score: 2, nested: { exact: true } } },
      { namespace: ['roles', 'a', 'sessions'], key: '1', value: { score: 1, nested: { exact: true } } },
      { namespace: ['roles', 'b', 'sessions'], key: '3', value: { score: 3, nested: { exact: false } } },
      { namespace: ['roles-other'], key: '4', value: { score: 4 } },
    ])
    expect((await store.search(['roles'], { filter: { score: { $gte: 2, $lt: 4 } } })).map(item => item.key)).toEqual(['2', '3'])
    expect((await store.search(['roles'], { filter: { nested: { exact: true } }, offset: 1, limit: 1 })).map(item => item.key)).toEqual(['2'])
    expect(await store.listNamespaces({ prefix: ['roles', '*'], suffix: ['sessions'], maxDepth: 2 })).toEqual([['roles', 'a'], ['roles', 'b']])
    expect(await store.listNamespaces({ maxDepth: 1, limit: 1 })).toHaveLength(1)
    await expect(store.search(['roles'], { query: 'private session' })).rejects.toMatchObject({ code: 'store_query_unsupported' })
    await expect(store.search([], { filter: { score: { $unknown: 1 } } })).rejects.toThrow('Unsupported store filter')
    await expect(store.search([], { limit: -1 })).rejects.toThrow('pagination')
  })

  it('enforces declared piece permissions and namespace confinement without exposing raw SQLite', async () => {
    const { store } = await fixture(), ns = ['roles', 'a', 'sessions']
    const none = store.forAccess('none'), reader = store.forAccess('read'), writer = store.forAccess('write', { namespacePrefixes: [ns] })
    await writer.put(ns, 'session', { id: 'one' })
    expect(await reader.get(ns, 'session')).toMatchObject({ value: { id: 'one' } })
    await expect(none.get(ns, 'session')).rejects.toMatchObject({ code: 'store_access_denied' })
    await expect(reader.delete(ns, 'session')).rejects.toMatchObject({ code: 'store_access_denied' })
    await expect(writer.get(['roles', 'b', 'sessions'], 'session')).rejects.toMatchObject({ code: 'store_access_denied' })
    await expect(writer.search(['roles'])).rejects.toMatchObject({ code: 'store_access_denied' })
    await expect(reader.get(['secrets'], 'token')).rejects.toMatchObject({ code: 'store_access_denied' })
    await writer.delete(ns, 'session')
    expect(await reader.get(ns, 'session')).toBeNull()
  })
})
