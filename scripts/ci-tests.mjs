import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMain } from './release-utils.mjs'

export const RUNTIME_FILES = ['src/agent-runtime/core-host.test.ts', 'src/agent-runtime/compact-runtime.test.ts',
  'src/agent-runtime/engine/fork.test.ts', 'src/agent-runtime/engine/implementation-compiler.test.ts']
export const RUNTIME_PARTS = 3
export const RECOVERY_FILE = 'src/agent-runtime/engine/robustness.test.ts'
const RECOVERY_ARGS = ['--maxWorkers', '1', '--maxConcurrency', '1']

/**
 * Partition grammar (every OS/Node combination must use one complete set):
 *   full                         everything in one unfiltered invocation
 *   general                      all non-runtime suites, then recovery serially
 *   general-K/N                  vitest shard K/N of the non-runtime, non-recovery suites
 *   recovery                     the recovery suite alone, serially
 *   runtime-K/N                  line-balanced slice K of N of the runtime suites
 */
export function parsePartition(name) {
  if (name === 'full' || name === 'general' || name === 'recovery') return { kind: name }
  const match = /^(general|runtime)-(\d+)\/(\d+)$/.exec(name ?? '')
  assert.ok(match, 'Unknown CI test partition')
  const [part, count] = [Number(match[2]), Number(match[3])]
  assert.ok(count >= 1 && part >= 1 && part <= count, 'CI test partition out of range')
  return { kind: match[1], part, count }
}

/** A set of partitions must run every suite exactly once. */
export function assertCompletePartitionSet(names) {
  const parsed = names.map(parsePartition)
  const count = kind => parsed.filter(item => item.kind === kind).length
  const complete = kind => {
    const rows = parsed.filter(item => item.kind === kind && item.count)
    assert.ok(rows.length > 0, `${kind} suites must be partitioned`)
    assert.ok(rows.every(item => item.count === rows[0].count), `Mixed ${kind} partition counts`)
    assert.deepEqual(rows.map(item => item.part).sort((a, b) => a - b), Array.from({ length: rows[0].count }, (_, i) => i + 1), `Incomplete ${kind} partitions`)
  }
  if (count('full')) return assert.equal(parsed.length, 1, 'full cannot be combined with other partitions')
  complete('runtime')
  const plainGeneral = parsed.filter(item => item.kind === 'general' && !item.count).length
  if (plainGeneral) {
    // `general` runs every non-runtime suite, recovery included.
    assert.equal(count('general'), 1, 'general cannot be combined with general shards')
    assert.equal(count('recovery'), 0, 'general already runs recovery')
  } else {
    complete('general')
    assert.equal(count('recovery'), 1, 'Sharded general partitions need exactly one recovery partition')
  }
}

// Keep parameterized cases declared on one line together. Distribute each
// file independently so every runner gets a share of the expensive suites.
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

export function runPartition(partition, { listOnly = false, spawnProcess = spawnSync, blobDir } = {}) {
  const spec = parsePartition(partition)
  const vitest = path.resolve('node_modules/vitest/vitest.mjs')
  let invocation = 0
  // With blobDir, each test run also records coverage and a blob report for
  // the coverage merge job. Thresholds only apply to the merged report.
  const coverage = () => {
    invocation++
    const slug = partition.replace(/[^a-z0-9]+/gi, '-') + '-' + invocation
    // Partial HTML/lcov reports are throwaway: only the blob reaches the merge.
    return ['--coverage', `--coverage.reportsDirectory=${path.join(os.tmpdir(), `core-coverage-${process.pid}-${slug}`)}`,
      ...['lines', 'functions', 'statements', 'branches'].map(metric => `--coverage.thresholds.${metric}=0`),
      '--reporter=default', '--reporter=blob', `--outputFile.blob=${path.join(blobDir, 'blob-' + slug + '.json')}`]
  }
  const invoke = (args, timeout) => {
    const result = spawnProcess(process.execPath, [vitest, ...args], { stdio: 'inherit', ...(timeout ? { timeout } : {}), windowsHide: true })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `Vitest ${args[0]} failed (${result.signal ?? result.status})`)
  }
  const run = args => invoke(['run', ...args, ...(blobDir ? coverage() : [])])
  const excluded = files => files.flatMap(file => ['--exclude', file])
  if (spec.kind !== 'runtime') assert.ok(!listOnly, '--list-only is for runtime partitions')
  // Each recovery case drives thirty real CLI nodes and waits for the
  // production lease TTL. Isolate them from other process-heavy suites
  // and serialize their CLI trees on Windows; retain every crash phase,
  // the real lease deadline and the test's bounded recovery assertions.
  const recovery = () => run([RECOVERY_FILE, ...RECOVERY_ARGS])
  if (spec.kind === 'full') return run([])
  if (spec.kind === 'recovery') return recovery()
  if (spec.kind === 'general') {
    if (spec.count) return run([...excluded([...RUNTIME_FILES, RECOVERY_FILE]), `--shard=${spec.part}/${spec.count}`])
    run(excluded([...RUNTIME_FILES, RECOVERY_FILE]))
    return recovery()
  }
  const temp = mkdtempSync(path.join(os.tmpdir(), 'core-ci-inventory-'))
  try {
    const collect = (filters, name) => {
      const output = path.join(temp, name + '.json')
      // Vitest 5 lists by static parsing by default, which reports `expect(…)`
      // calls and unexpanded `each` titles as tests; `run file:line` then finds
      // no test there. Collect by executing the files, as `run` does.
      invoke(['list', ...filters, '--staticParse=false', '--includeTaskLocation', '--json', output], 120_000)
      return JSON.parse(readFileSync(output, 'utf8'))
    }
    const inventory = collect(RUNTIME_FILES, 'all')
    assert.equal(new Set(inventory.map(test => test.file)).size, RUNTIME_FILES.length, 'All runtime suites must be collected')
    const selected = partitionTests(inventory, spec.count)[spec.part - 1]
    const filters = [...new Set(selected.map(test => `${path.relative(process.cwd(), test.file).split(path.sep).join('/')}:${test.location.line}`))]
    // Validate the runner's interpretation as well as our partition algorithm:
    // a Vitest upgrade must fail closed rather than silently dropping cases.
    assertSelection(selected, collect(filters, 'selected'))
    console.log(`${partition}: ${selected.length}/${inventory.length} runtime tests; exact selection verified`)
    if (!listOnly) run(filters)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/** Merge partition blobs; the configured coverage thresholds apply to the merged report only. */
export function mergeCoverage(blobDir, { spawnProcess = spawnSync } = {}) {
  const blobs = readdirSync(blobDir).filter(file => /^blob-.+\.json$/.test(file))
  assert.ok(blobs.length > 0, 'No coverage blobs to merge')
  console.log(`Merging ${blobs.length} coverage blobs: ${blobs.sort().join(', ')}`)
  // Vitest rejects any non-blob entry in the merge directory.
  const merge = mkdtempSync(path.join(os.tmpdir(), 'core-coverage-merge-'))
  try {
    for (const blob of blobs) copyFileSync(path.join(blobDir, blob), path.join(merge, blob))
    const result = spawnProcess(process.execPath, [path.resolve('node_modules/vitest/vitest.mjs'), 'run', `--merge-reports=${merge}`, '--coverage'], { stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `Vitest coverage merge failed (${result.signal ?? result.status})`)
  } finally {
    rmSync(merge, { recursive: true, force: true })
  }
}

if (isMain(import.meta.url)) {
  const blob = process.argv.indexOf('--blob')
  try {
    if (process.argv[2] === 'merge') mergeCoverage(path.resolve(process.argv[3]))
    else runPartition(process.argv[2], { listOnly: process.argv.includes('--list-only'), blobDir: blob > 0 ? path.resolve(process.argv[blob + 1]) : undefined })
  }
  catch (error) { console.error(error); process.exitCode = 1 }
}
