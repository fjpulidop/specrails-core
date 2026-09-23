import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMain } from './release-utils.mjs'

export const RUNTIME_FILES = ['src/agent-runtime/core-host.test.ts', 'src/agent-runtime/compact-runtime.test.ts']
export const RUNTIME_PARTS = 3

// Keep parameterized cases declared on one line together. Distribute each
// file independently so every runner gets a share of both expensive suites.
export function partitionTests(tests, count = RUNTIME_PARTS) {
  assert.ok(Number.isInteger(count) && count > 0, 'Invalid partition count')
  assert.ok(tests.length > 0, 'Runtime test inventory is empty')
  const files = new Map()
  for (const test of tests) {
    assert.ok(typeof test.file === 'string' && typeof test.name === 'string' && Number.isInteger(test.location?.line) && test.location.line > 0, 'Test inventory requires file, name and location')
    if (!files.has(test.file)) files.set(test.file, new Map())
    const lines = files.get(test.file)
    if (!lines.has(test.location.line)) lines.set(test.location.line, [])
    lines.get(test.location.line).push(test)
  }
  const parts = Array.from({ length: count }, () => [])
  for (const lines of files.values()) {
    const sizes = Array(count).fill(0)
    for (const [, group] of [...lines].sort(([a], [b]) => a - b)) {
      const index = sizes.indexOf(Math.min(...sizes))
      parts[index].push(...group)
      sizes[index] += group.length
    }
  }
  assert.ok(parts.every(part => part.length > 0), 'Runtime partitions must not be empty')
  return parts
}

function identity(test) { return JSON.stringify([test.file, test.location?.line, test.name]) }
export function assertSelection(expected, actual) {
  assert.deepEqual(actual.map(identity).sort(), expected.map(identity).sort(), 'Vitest line selection must execute exactly the assigned test inventory')
}

export function runPartition(partition, { listOnly = false } = {}) {
  assert.ok(['full', 'general', 'runtime-1', 'runtime-2', 'runtime-3'].includes(partition), 'Unknown CI test partition')
  const vitest = path.resolve('node_modules/vitest/vitest.mjs')
  const invoke = (args, timeout) => {
    const result = spawnSync(process.execPath, [vitest, ...args], { stdio: 'inherit', ...(timeout ? { timeout } : {}), windowsHide: true })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `Vitest ${args[0]} failed (${result.signal ?? result.status})`)
  }
  if (partition === 'full' || partition === 'general') {
    assert.ok(!listOnly, '--list-only is for runtime partitions')
    invoke(['run', ...(partition === 'general' ? RUNTIME_FILES.flatMap(file => ['--exclude', file]) : [])])
    return
  }
  const temp = mkdtempSync(path.join(os.tmpdir(), 'core-ci-inventory-'))
  try {
    const collect = (filters, name) => {
      const output = path.join(temp, name + '.json')
      invoke(['list', ...filters, '--includeTaskLocation', '--json', output], 120_000)
      return JSON.parse(readFileSync(output, 'utf8'))
    }
    const inventory = collect(RUNTIME_FILES, 'all')
    assert.equal(new Set(inventory.map(test => test.file)).size, RUNTIME_FILES.length, 'Both runtime suites must be collected')
    const selected = partitionTests(inventory)[Number(partition.slice(-1)) - 1]
    const filters = [...new Set(selected.map(test => `${path.relative(process.cwd(), test.file).split(path.sep).join('/')}:${test.location.line}`))]
    // Validate the runner's interpretation as well as our partition algorithm:
    // a Vitest upgrade must fail closed rather than silently dropping cases.
    assertSelection(selected, collect(filters, 'selected'))
    console.log(`${partition}: ${selected.length}/${inventory.length} runtime tests; exact selection verified`)
    if (!listOnly) invoke(['run', ...filters])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (isMain(import.meta.url)) {
  try { runPartition(process.argv[2], { listOnly: process.argv.includes('--list-only') }) }
  catch (error) { console.error(error); process.exitCode = 1 }
}
