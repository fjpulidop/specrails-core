import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { run } from './release-utils.mjs'

const DESKTOP_COMMIT = '70c9e8a4a7fbc26b89ed5ac724aed97dfcc27d9f'
const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { desktop: { type: 'string' }, dest: { type: 'string' }, output: { type: 'string' } } })
assert.ok(values.desktop && values.dest && values.output, 'Use --desktop <pinned checkout> --dest <outside source> --output <evidence.json>')
assert.equal(process.versions.node, '22.22.3', 'Assembly evidence uses exact Desktop Node 22.22.3')
const desktop = path.resolve(values.desktop), destination = path.resolve(values.dest), output = path.resolve(values.output)
mkdirSync(path.dirname(output), { recursive: true })
const evidence = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  coreCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root }), coreWorkingTreeDirty: !!run('git', ['status', '--porcelain'], { cwd: root }),
  expectedDesktopCommit: DESKTOP_COMMIT, desktopCommit: run('git', ['rev-parse', 'HEAD'], { cwd: desktop }),
  scope: 'Exact pinned Desktop assembler against locked Core source; proves assembly and existing runtime/OpenSpec smoke, not registry publication or a shipped v2 engine' }
try {
  assert.equal(evidence.desktopCommit, DESKTOP_COMMIT, 'Desktop assembler must match the reviewed paired commit')
  const inputs = ['scripts/assemble-bundled-core.mjs', 'scripts/assemble-core-source.mjs', 'package.json', 'package-lock.json']
  run('git', ['diff', '--exit-code', DESKTOP_COMMIT, '--', ...inputs], { cwd: desktop })
  evidence.desktopInputSha256 = Object.fromEntries(inputs.map(file => [file, createHash('sha256').update(readFileSync(path.join(desktop, file))).digest('hex')]))
  run(process.execPath, [path.join(desktop, 'scripts/assemble-bundled-core.mjs'), '--source', root, '--dest', destination], { cwd: desktop, timeout: 600_000 })
  const metadata = readFileSync(path.join(destination, 'source-bundle.json'))
  const bundle = JSON.parse(metadata.toString('utf8'))
  const lockHash = createHash('sha256').update(readFileSync(path.join(root, 'package-lock.json'))).digest('hex')
  assert.equal(bundle.packageLockSha256, lockHash)
  assert.equal(bundle.runtimeApiVersion, 1)
  assert.equal(existsSync(path.join(destination, 'src/agent-runtime/engine/__spikes__')), false)
  assert.equal(existsSync(path.join(destination, 'dist/agent-runtime/engine/__spikes__')), false)
  const api = JSON.parse(run(process.execPath, [path.join(destination, 'dist/agent-runtime/cli.js'), 'api'], { cwd: destination }))
  assert.equal(api.type, 'runtime-api')
  assert.equal(api.apiVersion, 1)
  Object.assign(evidence, { status: 'passed', sourceBundleSha256: createHash('sha256').update(metadata).digest('hex'), sourceBundle: bundle,
    packageLockSha256: lockHash, runtimeIdentity: api.runtimeIdentity, prototypesExcluded: true })
} catch (error) {
  evidence.status = 'failed'; evidence.error = { message: error.message, stack: error.stack }; process.exitCode = 1
  process.stderr.write(error.stack + '\n')
} finally {
  evidence.finishedAt = new Date().toISOString()
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n')
  process.stdout.write(`C1 paired source assembly ${evidence.status}: ${output}\n`)
}
