import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load as yaml } from 'js-yaml'
import { partitionTests, assertSelection, RUNTIME_PARTS } from './ci-tests.mjs'

const inventory = ['core', 'compact'].flatMap(file => Array.from({ length: 12 }, (_, index) => ({ file, name: `test ${index} [.*] > nested`, location: { line: Math.floor(index / 2) + 1 } })))

test('runtime partitions are disjoint and exhaustive, keeping parameterized cases together', () => {
  const parts = partitionTests(inventory)
  assert.equal(parts.length, RUNTIME_PARTS)
  assertSelection(inventory, parts.flat())
  const owners = new Map()
  parts.forEach((part, index) => {
    assert.deepEqual([...new Set(part.map(item => item.file))].sort(), ['compact', 'core'])
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
test('CI retains all OS/Node combinations and the main push release gate without duplicate branch push runs', () => {
  const ci = yaml(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  assert.deepEqual(ci.on.push.branches, ['main'])
  assert.deepEqual(ci.on.pull_request.branches, ['main'])
  const matrix = ci.jobs.test.strategy.matrix
  for (const node of ['22.22.3', '24']) {
    assert.ok(matrix.node.includes(node))
    for (const os of ['ubuntu-latest', 'macos-latest']) assert.ok(matrix.os.includes(os))
    assert.deepEqual(matrix.include.filter(row => row.os === 'windows-latest' && row.node === node).map(row => row.partition).sort(), ['general', 'runtime-1', 'runtime-2', 'runtime-3'])
  }
  assert.deepEqual(matrix.partition, ['full'])
  assert.deepEqual(matrix.exclude, [{ os: 'ubuntu-latest', node: '24', partition: 'full' }])
  assert.equal(ci.jobs.coverage['runs-on'], 'ubuntu-latest')
  assert.equal(ci.jobs.coverage.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], '24')
  assert.equal(ci.jobs.coverage.steps.some(step => step.run === 'npm run test:coverage'), true)
  assert.equal(ci.jobs.coverage.steps.some(step => step.run === 'npm run test:scripts'), true)
  const verifiedPackage = ci.jobs.coverage.steps.findIndex(step => step.run?.startsWith('node scripts/verify-package.mjs'))
  const uploadedPackage = ci.jobs.coverage.steps.findIndex(step => step.with?.name === 'core-package')
  assert.ok(verifiedPackage > ci.jobs.coverage.steps.findIndex(step => step.run === 'npm run test:coverage'))
  assert.ok(uploadedPackage > verifiedPackage)
  assert.equal(ci.jobs.coverage.steps[uploadedPackage].if, undefined, 'Never upload a release artifact after failed validation')
  assert.equal(ci.jobs.test.steps.some(step => step.with?.name === 'core-package'), false)
  const packageStep = ci.jobs.test.steps.find(step => step.name === 'Install and exercise the actual npm package on this OS')
  assert.equal(packageStep.if, "matrix.node == '24' && (matrix.partition == 'full' || matrix.partition == 'general')")
})
