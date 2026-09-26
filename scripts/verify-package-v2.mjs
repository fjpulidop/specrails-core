// Engine v2 acceptance against the ACTUAL installed package (npm pack + install
// into an isolated consumer prefix). Every step runs the shipped CLI entries as
// separate processes and asserts machine-readable output only; no provider is
// invoked because the acceptance definition contains no AI node.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { run } from './release-utils.mjs'

/** Public SDK names documented by src/agent-runtime/engine/index.ts. */
export const ENGINE_SDK_EXPORTS = ['createRun', 'resumeRun', 'signalRun', 'cancelRun', 'definitionRunDirectory', 'forkRun', 'statusRun',
  'preflightDefinition', 'configuredRoles', 'validateWorkflowDefinition', 'workflowDefinitionSchema', 'definitionVersion', 'canonicalJson',
  'validationPieceRegistry', 'PieceRegistry', 'compileWorkflowDefinition', 'describeDefinition', 'PIECE_KINDS', 'EngineError']
export const NODE_KIND_COUNT = 16

/** Run one CLI entry and parse its JSON lines; stdout must contain nothing else. */
export function cliJson(entry, args, options) {
  const { input, ...rest } = options
  const result = spawnSync(process.execPath, [...entry, ...args], { encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, input, ...rest })
  if (result.error) throw result.error
  const lines = result.stdout.split('\n').filter(line => line.trim()).map(line => {
    try { return JSON.parse(line) } catch { throw new Error(`Runtime stdout must be JSON lines; got: ${line.slice(0, 400)}\n${result.stderr}`) }
  })
  return { code: result.status, lines, last: lines.at(-1), stderr: result.stderr }
}

function describe(step, value) { return `${step}: ${JSON.stringify(value?.last ?? value).slice(0, 2000)}\n${value?.stderr ?? ''}` }

export function verifyEngineV2({ root, installed, prefix, temp, env, contract }) {
  const dist = [path.join(installed, 'dist', 'agent-runtime', 'cli.js')]
  const bin = [path.join(installed, 'bin', 'specrails-core.mjs'), 'runtime']
  const fixtures = path.join(root, 'src', 'agent-runtime', 'engine', '__fixtures__', 'acceptance')
  const published = JSON.parse(readFileSync(path.join(fixtures, 'question-flow.json'), 'utf8'))
  const config = JSON.parse(readFileSync(path.join(fixtures, 'runtime-config.json'), 'utf8'))
  const workspace = path.join(temp, 'engine v2 acceptance')
  const repository = path.join(workspace, 'repo'), backlogRoot = path.join(workspace, 'backlog')
  mkdirSync(repository, { recursive: true }); mkdirSync(backlogRoot, { recursive: true })
  run('git', ['init', '-q', repository], { env })
  const context = runId => ({ schemaVersion: 1, runId, backlogRoot, artifactRoot: repository, artifactRepositoryId: 'repo',
    repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [{ id: 1, title: 'Package acceptance', description: 'Provider-free engine v2 acceptance' }] })
  const file = (name, value) => { const target = path.join(workspace, name); writeFileSync(target, JSON.stringify(value)); return target }
  const configFile = file('runtime-config.json', config)
  const opts = { cwd: workspace, env }

  // Draft -> published: the shipped validator recomputes the canonical hash.
  const { version, ...draft } = published
  const validated = cliJson(bin, ['workflows', 'validate', '--stdin'], { ...opts, input: JSON.stringify(draft) })
  assert.equal(validated.code, 0, describe('workflows validate', validated))
  assert.equal(validated.lines.length, 1, 'validate emits exactly one JSON line')
  assert.equal(validated.last.type, 'runtime-definition-validated')
  assert.equal(validated.last.ok, true)
  assert.match(validated.last.version, /^[0-9a-f]{64}$/)
  assert.equal(validated.last.version, version, 'Installed validator must reproduce the fixture hash')
  assert.equal(validated.last.definition.version, version)
  assert.ok(Array.isArray(validated.last.graph?.nodes) && validated.last.graph.nodes.length === 4, 'validated graph lists the four nodes')
  const tampered = cliJson(dist, ['workflows', 'validate', '--stdin'], { ...opts, input: JSON.stringify({ ...published, version: 'f'.repeat(64) }) })
  assert.equal(tampered.code, 1)
  assert.ok(tampered.last.errors?.some(error => error.code === 'definition_hash_mismatch'), describe('hash mismatch', tampered))
  const definitionFile = file('definition.json', validated.last.definition)

  // Run to a question pause.
  const sourceContext = file('source-context.json', context('package-engine-source'))
  const paused = cliJson(dist, ['run', '--context', sourceContext, '--config', configFile, '--definition', definitionFile], opts)
  assert.equal(paused.code, 2, describe('run', paused))
  assert.equal(paused.lines[0].type, 'runtime-graph')
  assert.equal(paused.lines[0].engineVersion, 2)
  assert.equal(paused.lines[0].definitionHash, version)
  assert.equal(paused.last.type, 'runtime-result')
  assert.equal(paused.last.engineVersion, 2)
  assert.equal(paused.last.status, 'paused')
  assert.equal(paused.last.pendingQuestion?.stepId, 'ask')
  assert.equal(paused.last.completion, null)
  assert.equal(paused.last.workflow?.version, version)
  assert.ok(paused.lines.filter(line => line.type === 'workflow-event').length >= 3, 'run streams committed workflow events')
  const database = path.join(backlogRoot, '.specrails', 'pipeline', 'package-engine-source', 'agent-workflow', 'run.sqlite')
  assert.ok(existsSync(database), 'engine v2 run persists run.sqlite')
  const conflicting = cliJson(dist, ['run', '--context', sourceContext, '--config', configFile, '--definition', definitionFile, '--workflow', 'specrails-implementation'], opts)
  assert.equal(conflicting.code, 1)
  assert.equal(conflicting.lines.length, 1, 'fatal errors emit one line')
  assert.deepEqual([conflicting.last.type, conflicting.last.status, conflicting.last.error?.code], ['runtime-result', 'failed', 'invalid_arguments'], describe('run --definition --workflow', conflicting))

  // Compact status shape.
  for (const entry of [bin, dist]) {
    const status = cliJson(entry, ['status', '--context', sourceContext, '--compact'], opts)
    assert.equal(status.code, 0, describe('status', status))
    assert.equal(status.lines.length, 1)
    assert.equal(status.last.type, 'runtime-status')
    assert.equal(status.last.engineVersion, 2)
    assert.ok(Object.hasOwn(status.last.state, 'lease'), 'compact status reports the execution lease')
    assert.equal(status.last.state.lease, null, 'a paused run holds no execution lease')
    assert.equal(status.last.state.status, 'paused')
    assert.equal(status.last.state.pendingInterrupts?.length, 1)
    assert.deepEqual(status.last.workflow, { id: published.id, version, source: 'definition' })
    assert.equal(status.last.completion, null)
    assert.equal(typeof status.last.state.usage?.durationMs, 'number')
    assert.equal(status.last.efficiencySummary?.schemaVersion, 1)
    assert.equal(status.last.efficiencySummary?.invocations?.total, 0, 'a provider-free run records no provider invocation')
  }

  // Resume with the answer.
  const succeeded = cliJson(dist, ['resume', '--context', sourceContext, '--answer', 'continue'], opts)
  assert.equal(succeeded.code, 0, describe('resume --answer', succeeded))
  assert.equal(succeeded.last.type, 'runtime-result')
  assert.equal(succeeded.last.status, 'succeeded')
  assert.deepEqual(succeeded.last.completion, { ok: true, reasons: [], verified: false })
  assert.equal(succeeded.last.efficiencySummary?.schemaVersion, 1)
  const frozen = cliJson(dist, ['resume', '--context', sourceContext, '--definition', definitionFile], opts)
  assert.equal(frozen.code, 1)
  assert.equal(frozen.last.error?.code, 'invalid_arguments', describe('resume --definition', frozen))
  const sourceBytes = readFileSync(database)

  // Fork from the question and resume the fork; the source stays byte-identical.
  const forked = cliJson(dist, ['fork', '--context', sourceContext, '--from', 'ask', '--run-id', 'package-engine-fork'], opts)
  assert.equal(forked.code, 0, describe('fork', forked))
  assert.equal(forked.lines.length, 1)
  assert.equal(forked.last.type, 'runtime-forked')
  assert.equal(forked.last.runId, 'package-engine-fork')
  assert.equal(forked.last.forkOf, 'package-engine-source')
  assert.equal(forked.last.fromNodePath, 'ask')
  const forkContext = file('fork-context.json', context('package-engine-fork'))
  const forkStatus = cliJson(bin, ['status', '--context', forkContext, '--compact'], opts)
  assert.equal(forkStatus.last.forkOf, 'package-engine-source', describe('fork status', forkStatus))
  assert.equal(forkStatus.last.state.status, 'paused')
  const forkDone = cliJson(bin, ['resume', '--context', forkContext, '--answer', 'fork continues'], opts)
  assert.equal(forkDone.code, 0, describe('fork resume', forkDone))
  assert.equal(forkDone.last.status, 'succeeded')
  assert.equal(forkDone.last.forkOf, 'package-engine-source')
  assert.equal(forkDone.last.completion?.ok, true)
  assert.deepEqual(readFileSync(database), sourceBytes, 'fork never modifies the source database')
  // A state patch applies to the destination only: the condition now routes to the failure end.
  const patched = cliJson(dist, ['fork', '--context', sourceContext, '--from', 'check', '--run-id', 'package-engine-patched', '--state', file('patch.json', { $vars: { stop: true } })], opts)
  assert.equal(patched.code, 0, describe('fork --state', patched))
  const stopped = cliJson(dist, ['resume', '--context', file('patched-context.json', context('package-engine-patched'))], opts)
  assert.equal(stopped.code, 1, describe('patched fork resume', stopped))
  assert.equal(stopped.last.status, 'failed')
  assert.deepEqual(stopped.last.completion, { ok: false, reasons: ['stopped_by_fork_patch'], verified: false })
  assert.deepEqual(readFileSync(database), sourceBytes)
  const missing = cliJson(dist, ['fork', '--context', file('missing-context.json', context('package-engine-missing')), '--from', 'ask', '--run-id', 'package-engine-never'], opts)
  assert.equal(missing.code, 1)
  assert.equal(missing.last.error?.code, 'run_not_found', describe('fork missing run', missing))

  // Catalog and API advertisement.
  const workflows = cliJson(bin, ['workflows', 'list'], opts)
  assert.equal(workflows.code, 0, describe('workflows list', workflows))
  assert.equal(workflows.last.type, 'runtime-workflows')
  assert.equal(workflows.last.nodeKinds?.length, NODE_KIND_COUNT, `runtime workflows must list ${NODE_KIND_COUNT} node kinds`)
  const api = cliJson(bin, ['api'], opts)
  assert.equal(api.code, 0, describe('api', api))
  const contractEngine = contract.agentRuntime?.engine
  const advertised = api.last.engineVersion !== undefined || contractEngine !== undefined
  let apiNote = 'runtime api does not yet advertise engineVersion 2 or nodeKinds (integration-contract.json has no agentRuntime.engine either); v2 remains unadvertised in this package'
  if (advertised) {
    assert.equal(api.last.engineVersion, 2, `runtime api must advertise engineVersion 2 once the engine ships; got ${JSON.stringify(api.last.engineVersion)} (contract: ${JSON.stringify(contractEngine)})`)
    assert.ok(Array.isArray(api.last.nodeKinds) && api.last.nodeKinds.length === NODE_KIND_COUNT && api.last.nodeKinds.every(kind => typeof kind === 'string'),
      `runtime api must list the ${NODE_KIND_COUNT} node kinds as strings; got ${JSON.stringify(api.last.nodeKinds)}`)
    assert.deepEqual([...api.last.nodeKinds].sort(), workflows.last.nodeKinds.map(kind => kind.kind).sort(), 'runtime api and runtime workflows must agree on node kinds')
    assert.equal(api.last.capabilities?.engineV2, 1, 'runtime api must advertise capabilities.engineV2 with engineVersion 2')
    assert.equal(contractEngine?.version, 2, 'integration-contract.json agentRuntime.engine.version must be 2 when the API advertises engineVersion 2')
    assert.equal(contractEngine?.definitionSchema, 'schemas/workflow-definition.schema.json')
    apiNote = 'runtime api advertises engineVersion 2 and node kinds'
  }

  // Package exports resolve from a consumer module, not from the source checkout.
  const probe = path.join(prefix, 'engine-exports-probe.mjs')
  writeFileSync(probe, `
    import { createRequire } from 'node:module'
    import { readFileSync } from 'node:fs'
    const require = createRequire(import.meta.url)
    const schemaPath = require.resolve('specrails-core/schemas/workflow-definition.schema.json')
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
    require.resolve('specrails-core/schemas/agent-runtime.schema.json')
    const engine = await import('specrails-core/agent-runtime/engine')
    const expected = ${JSON.stringify(ENGINE_SDK_EXPORTS)}
    const missing = expected.filter(name => engine[name] === undefined)
    if (missing.length) throw new Error('Engine SDK export missing: ' + missing.join(', '))
    if (JSON.stringify(engine.workflowDefinitionSchema) !== JSON.stringify(schema)) throw new Error('Packaged schema differs from the SDK schema')
    if (engine.PIECE_KINDS.length !== ${NODE_KIND_COUNT}) throw new Error('PIECE_KINDS must list ${NODE_KIND_COUNT} kinds')
    const definition = JSON.parse(readFileSync(process.argv[2], 'utf8'))
    const result = engine.validateWorkflowDefinition(definition, engine.validationPieceRegistry(), {}, { published: true })
    if (!result.ok || result.version !== definition.version) throw new Error('SDK validation failed: ' + JSON.stringify(result))
    const { version: _published, ...draft } = definition
    if (engine.definitionVersion(draft) !== definition.version) throw new Error('definitionVersion drifted from the CLI hash')
    console.log(JSON.stringify({ schemaPath, exports: expected.length }))
  `)
  const exportsProbe = JSON.parse(run(process.execPath, [probe, definitionFile], { cwd: prefix, env }))
  assert.equal(realpathSync(exportsProbe.schemaPath), realpathSync(path.join(installed, 'schemas', 'workflow-definition.schema.json')))
  return { apiNote }
}
