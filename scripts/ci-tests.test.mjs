import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load as yaml } from 'js-yaml'
import { partitionTests, assertSelection, runPartition, parsePartition, assertCompletePartitionSet, mergeCoverage, RUNTIME_FILES, RUNTIME_PARTS, RECOVERY_FILE } from './ci-tests.mjs'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function record(partition, options = {}) {
  const calls = []
  runPartition(partition, { ...options, spawnProcess(_executable, args) {
    calls.push(args.slice(1))
    return { status: 0 }
  } })
  return calls
}

const inventory = ['core', 'compact', 'fork', 'compiler'].flatMap(file => Array.from({ length: 12 }, (_, index) => ({ file, name: `test ${index} [.*] > nested`, location: { line: Math.floor(index / 2) + 1 } })))

test('runtime partitions are disjoint and exhaustive, keeping parameterized cases together', () => {
  const parts = partitionTests(inventory)
  assert.equal(parts.length, RUNTIME_PARTS)
  assertSelection(inventory, parts.flat())
  const owners = new Map()
  parts.forEach((part, index) => {
    assert.deepEqual([...new Set(part.map(item => item.file))].sort(), ['compact', 'compiler', 'core', 'fork'])
    for (const item of part) {
      const key = item.file + ':' + item.location.line
      if (owners.has(key)) assert.equal(owners.get(key), index)
      owners.set(key, index)
    }
  })
  assert.deepEqual(partitionTests([...inventory].reverse()).map(part => part.map(item => item.name).sort()), parts.map(part => part.map(item => item.name).sort()))
})
test('missing, extra or duplicated selected tests fail closed', () => {
  assert.throws(() => assertSelection(inventory, inventory.slice(1)))
  assert.throws(() => assertSelection(inventory, [...inventory, inventory[0]]))
  assert.throws(() => partitionTests([]))
  assert.throws(() => partitionTests([{ file: 'a', name: 'missing location' }]))
  assert.throws(() => partitionTests(inventory, 0))
  assert.throws(() => partitionTests(inventory.slice(0, 1)))
})
test('the Windows general partition retains recovery in one isolated serial invocation', () => {
  const calls = []
  runPartition('general', { spawnProcess(_executable, args) {
    calls.push(args.slice(1))
    return { status: 0 }
  } })
  assert.equal(calls.length, 2)
  const [general, recovery] = calls
  assert.equal(general[0], 'run')
  const exclusions = general.filter((_, index) => general[index - 1] === '--exclude')
  assert.deepEqual(exclusions, [...RUNTIME_FILES, RECOVERY_FILE])
  assert.equal(general.length, 1 + exclusions.length * 2, 'All remaining suites use the normal unfiltered test inventory')
  assert.deepEqual(recovery, ['run', RECOVERY_FILE, '--maxWorkers', '1', '--maxConcurrency', '1'])
})
test('the full partition retains a single unfiltered invocation for coverage parity', () => {
  const calls = []
  runPartition('full', { spawnProcess(_executable, args) {
    calls.push(args.slice(1))
    return { status: 0 }
  } })
  assert.deepEqual(calls, [['run']])
})
test('a failed general or isolated recovery run fails the partition', () => {
  for (const failedInvocation of [1, 2]) {
    let calls = 0
    assert.throws(() => runPartition('general', { spawnProcess() {
      calls++
      return { status: calls === failedInvocation ? 6 : 0 }
    } }), /Vitest run failed \(6\)/)
    assert.equal(calls, failedInvocation, 'Do not continue after a failed suite')
  }
})
test('the full offline definition corpus runs in parallel with retained failure evidence', () => {
  const ci = yaml(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const job = ci.jobs['definition-evaluation']
  const ids = ['implementation', 'implementation-component'].map(name =>
    JSON.parse(readFileSync(new URL(`../src/agent-runtime/engine/__fixtures__/${name}.json`, import.meta.url), 'utf8')).id)
  assert.deepEqual(job.strategy.matrix.definition, ids)
  assert.equal(job.strategy['fail-fast'], false)
  assert.equal(job.steps.some(step => step.run === 'npm run build'), true)
  assert.equal(job.steps.some(step => step.run?.startsWith('node scripts/evaluate-definition-corpus.mjs')), true)
  const artifact = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(artifact.if, 'always()')
  assert.equal(artifact.with['if-no-files-found'], 'error')
})
test('sharded general partitions exclude runtime and recovery suites; recovery runs alone and serially', () => {
  const [general] = record('general-2/3')
  const exclusions = general.filter((_, index) => general[index - 1] === '--exclude')
  assert.deepEqual(exclusions, [...RUNTIME_FILES, RECOVERY_FILE])
  assert.equal(general.at(-1), '--shard=2/3')
  assert.deepEqual(record('recovery'), [['run', RECOVERY_FILE, '--maxWorkers', '1', '--maxConcurrency', '1']])
})
test('coverage partitions record a uniquely named blob and coverage directory per invocation without partial thresholds', () => {
  const blobDir = path.join(os.tmpdir(), 'blobs')
  const calls = record('general', { blobDir })
  assert.equal(calls.length, 2)
  const outputs = calls.map(call => call.find(arg => arg.startsWith('--outputFile.blob=')))
  const reports = calls.map(call => call.find(arg => arg.startsWith('--coverage.reportsDirectory=')))
  assert.equal(new Set(outputs).size, 2)
  assert.equal(new Set(reports).size, 2)
  for (const call of calls) {
    assert.ok(call.includes('--coverage') && call.includes('--reporter=blob') && call.includes('--reporter=default'))
    for (const metric of ['lines', 'functions', 'statements', 'branches']) assert.ok(call.includes(`--coverage.thresholds.${metric}=0`))
  }
  assert.ok(outputs.every(output => output.startsWith(`--outputFile.blob=${path.join(blobDir, 'blob-general-')}`)))
  assert.equal(record('general').flat().some(arg => arg.startsWith('--coverage')), false, 'Plain test partitions do not collect coverage')
})
test('the coverage merge enforces configured thresholds on the merged report and refuses an empty merge', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'core-blobs-'))
  try {
    assert.throws(() => mergeCoverage(dir, { spawnProcess: () => ({ status: 0 }) }), /No coverage blobs/)
    writeFileSync(path.join(dir, 'blob-general-1.json'), '{}')
    writeFileSync(path.join(dir, 'unrelated.txt'), 'not a blob')
    const calls = []
    mergeCoverage(dir, { spawnProcess(_executable, args) {
      const merge = args[2].slice('--merge-reports='.length)
      calls.push({ args: args.slice(1), files: readdirSync(merge) })
      return { status: 0 }
    } })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].files, ['blob-general-1.json'], 'Only blobs reach the Vitest merge directory')
    assert.equal(calls[0].args.at(-1), '--coverage')
    assert.throws(() => mergeCoverage(dir, { spawnProcess: () => ({ status: 1 }) }), /coverage merge failed/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('a composite partition runs each part in order and stops at the first failure', () => {
  assert.deepEqual(record('general-1/2+recovery'), [
    ['run', ...[...RUNTIME_FILES, RECOVERY_FILE].flatMap(file => ['--exclude', file]), '--shard=1/2'],
    ['run', RECOVERY_FILE, '--maxWorkers', '1', '--maxConcurrency', '1'],
  ])
  let calls = 0
  assert.throws(() => runPartition('general-1/2+recovery', { spawnProcess() { calls++; return { status: 3 } } }), /Vitest run failed \(3\)/)
  assert.equal(calls, 1)
  const blobDir = path.join(os.tmpdir(), 'blobs')
  const outputs = record('general-1/2+recovery', { blobDir }).map(call => call.find(arg => arg.startsWith('--outputFile.blob=')))
  assert.equal(new Set(outputs).size, 2, 'Each composite invocation writes its own blob')
  assertCompletePartitionSet(['general-1/2+recovery', 'general-2/2', 'runtime-1/2', 'runtime-2/2'])
  assert.throws(() => assertCompletePartitionSet(['general-1/2+recovery', 'general-2/2+recovery', 'runtime-1/1']))
})
test('partition names and sets fail closed', () => {
  assert.deepEqual(parsePartition('runtime-2/3'), { kind: 'runtime', part: 2, count: 3 })
  for (const name of ['runtime-1', 'runtime-0/3', 'runtime-4/3', 'general-1/0', 'everything', undefined]) assert.throws(() => parsePartition(name))
  for (const set of [['full'], ['general', 'runtime-1/2', 'runtime-2/2'], ['general-1/2', 'general-2/2', 'recovery', 'runtime-1/3', 'runtime-2/3', 'runtime-3/3']]) assertCompletePartitionSet(set)
  for (const set of [['general', 'runtime-1/2'], ['general', 'recovery', 'runtime-1/1'], ['general-1/2', 'recovery', 'runtime-1/1'],
    ['general-1/2', 'general-2/2', 'runtime-1/1'], ['full', 'general'], ['general', 'general-1/1', 'runtime-1/1'], ['general', 'runtime-1/2', 'runtime-2/3'], ['general']]) {
    assert.throws(() => assertCompletePartitionSet(set), undefined, JSON.stringify(set))
  }
})
test('CI runs a complete partition set for every OS/Node combination and gates the release package on merged coverage', () => {
  const ci = yaml(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  assert.deepEqual(ci.on.push.branches, ['main'])
  assert.ok(Object.hasOwn(ci.on, 'pull_request'), 'Every integration PR must receive CI')
  assert.equal(ci.on.pull_request, null, 'Do not restrict PR bases or changed paths')
  const rows = ci.jobs.test.strategy.matrix.include
  const sets = new Map()
  for (const row of rows) {
    const key = row.os + ' ' + row.node
    sets.set(key, [...(sets.get(key) ?? []), row.partition])
  }
  const combinations = [...sets.keys()].sort()
  assert.deepEqual(combinations, ['macos-latest 22.22.3', 'macos-latest 24', 'ubuntu-latest 22.22.3', 'windows-latest 22.22.3', 'windows-latest 24'])
  for (const partitions of sets.values()) assertCompletePartitionSet(partitions)
  // Ubuntu/Node 24 is exercised by the coverage partitions.
  const coverage = ci.jobs['coverage-partition']
  assert.equal(coverage['runs-on'], 'ubuntu-latest')
  assert.equal(coverage.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], '24')
  assertCompletePartitionSet(coverage.strategy.matrix.partition)
  assert.equal(coverage.strategy['fail-fast'], false)
  assert.ok(coverage.steps.some(step => step.run?.startsWith('node scripts/ci-tests.mjs') && step.run.includes('--blob')))
  // Each OS packages once on Node 24 after a passing partition.
  const packaged = rows.filter(row => row.package).map(row => row.os + ' ' + row.node).sort()
  assert.deepEqual(packaged, ['macos-latest 24', 'windows-latest 24'])
  const packageStep = ci.jobs.test.steps.find(step => step.name === 'Install and exercise the actual npm package on this OS')
  assert.equal(packageStep.if, 'matrix.package')
  const merge = ci.jobs.coverage
  assert.equal(merge.needs, 'coverage-partition')
  const index = predicate => merge.steps.findIndex(predicate)
  const merged = index(step => step.run?.startsWith('node scripts/ci-tests.mjs merge'))
  const verified = index(step => step.run?.startsWith('node scripts/verify-package.mjs'))
  const uploaded = index(step => step.with?.name === 'core-package')
  assert.ok(index(step => step.run === 'npm run test:scripts') >= 0)
  assert.ok(merged >= 0 && verified > merged && uploaded > verified)
  assert.equal(merge.steps[uploaded].if, undefined, 'Never upload a release artifact after failed validation')
  assert.equal(ci.jobs.test.steps.some(step => step.with?.name === 'core-package'), false)
  assert.equal(coverage.steps.some(step => step.with?.name === 'core-package'), false)
})
