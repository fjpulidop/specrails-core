import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { npm, run } from './release-utils.mjs'
import { sqliteProbe } from '../src/agent-runtime/engine/__spikes__/sqlite-probe.mjs'
import { subgraphProbe } from '../src/agent-runtime/engine/__spikes__/subgraph-probe.mjs'
import { streamingProbe } from '../src/agent-runtime/engine/__spikes__/streaming-probe.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--output', 'Usage: npm run test:engine-spikes -- [--output <directory>]')
assert.equal(process.versions.node, '22.22.3', 'Use exact Desktop Node 22.22.3 for comparable C1 evidence')
const output = path.resolve(args[1] ?? path.join(root, 'engine-spike-results'))
mkdirSync(output, { recursive: true })
const scratch = mkdtempSync(path.join(os.tmpdir(), 'core engine C1 '))
const prototypeDirectory = 'src/agent-runtime/engine/__spikes__'
const measuredFiles = ['scripts/run-engine-spikes.mjs', 'package.json', 'package-lock.json', ...readdirSync(path.join(root, prototypeDirectory)).map(name => `${prototypeDirectory}/${name}`)].sort()
const sourceDigest = createHash('sha256')
for (const file of measuredFiles) sourceDigest.update(file + '\0').update(readFileSync(path.join(root, file)))
const evidence = {
  schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', commit: run('git', ['rev-parse', 'HEAD'], { cwd: root }),
  platform: process.platform, arch: process.arch, node: process.version, sqlite: process.versions.sqlite,
  workingTreeDirty: !!run('git', ['status', '--porcelain'], { cwd: root }), prototypeSourceSha256: sourceDigest.digest('hex'), measuredFiles,
  dependencies: Object.fromEntries(['@langchain/langgraph', '@langchain/langgraph-checkpoint'].map(name => [name, JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version])),
  results: {},
}
const save = () => writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
try {
  save()
  for (const [name, probe] of [['sqlite', sqliteProbe], ['subgraphs', subgraphProbe], ['streaming', streamingProbe]]) {
    process.stderr.write(`Running C1 ${name} probe (${process.platform}/${process.arch})\n`)
    evidence.results[name] = await probe(scratch)
    save()
  }
  const [pack] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, env: { ...process.env, npm_config_cache: path.join(scratch, 'npm-cache') } }))
  assert.ok(pack.files.every(file => !file.path.includes('__spikes__') && !file.path.startsWith('engine-spike-results/')), 'Spikes must not leak into the npm package')
  evidence.results.package = { dryRun: true, name: pack.name, version: pack.version, files: pack.files.length, prototypesExcluded: true,
    acceptance: 'Actual npm install/package smoke is a separate mandatory CI step; Desktop assembly evidence is a paired gate' }
  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'
  evidence.error = { message: error.message, stack: error.stack }
  process.exitCode = 1
  process.stderr.write(error.stack + '\n')
} finally {
  evidence.finishedAt = new Date().toISOString()
  save()
  rmSync(scratch, { recursive: true, force: true })
  process.stdout.write(`C1 ${evidence.status}: ${path.join(output, 'evidence.json')}\n`)
}
