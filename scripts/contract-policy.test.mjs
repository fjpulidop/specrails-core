import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load as yaml } from 'js-yaml'
import { declaresBreakingChange, diffContract, evaluateContractChange, parseSchemaVersion } from './check-contract-bump.mjs'
import { assertTagCiGreen, evaluatePromotion } from './promote-stable.mjs'

const base = {
  schemaVersion: '5.2',
  agentRuntime: {
    nodeKinds: ['prompt', 'verify', 'shell'],
    sessions: { capabilities: ['sessions', 'delegation'], eventTypes: ['session.opened', 'session.closed'] },
    builtins: [{ id: 'specrails-implementation', version: '7' }],
  },
  lifecycle: { initCommand: 'init', timeoutMs: 1000 },
}
const clone = (value) => structuredClone(value)
const with_ = (mutate) => { const next = clone(base); mutate(next); return next }

test('parses MAJOR.MINOR schema versions and rejects anything else', () => {
  assert.deepEqual(parseSchemaVersion('5.2'), [5, 2, 0])
  assert.deepEqual(parseSchemaVersion('6.0.1'), [6, 0, 1])
  for (const bad of ['5', 'v5.2', '05.2', 5.2, null]) assert.equal(parseSchemaVersion(bad), null)
})

test('fixture: unchanged contract passes', () => {
  const verdict = evaluateContractChange({ base, head: clone(base) })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.changed, false)
})

test('fixture: additive change with a minor bump passes', () => {
  const head = with_((c) => { c.schemaVersion = '5.3'; c.agentRuntime.nodeKinds.push('openspec-validate'); c.agentRuntime.sessions.interrupts = true })
  const verdict = evaluateContractChange({ base, head, messages: ['feat(sessions): add interrupts'] })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
  assert.deepEqual(verdict.breaking, [])
})

test('fixture: additive change without a bump fails', () => {
  const head = with_((c) => { c.agentRuntime.sessions.eventTypes.push('session.interrupted') })
  const verdict = evaluateContractChange({ base, head, messages: ['feat: add event'] })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors[0], /did not increase/)
})

test('a lower or equal schemaVersion fails even for additive changes', () => {
  const head = with_((c) => { c.schemaVersion = '5.1'; c.extra = 1 })
  assert.equal(evaluateContractChange({ base, head }).ok, false)
})

test('fixture: removal with a major bump and BREAKING declaration passes', () => {
  const head = with_((c) => { c.schemaVersion = '6.0'; c.agentRuntime.sessions.capabilities = ['sessions']; delete c.lifecycle.timeoutMs })
  const verdict = evaluateContractChange({ base, head, messages: ['refactor(sessions)!: retire delegation capability'] })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
  assert.deepEqual(verdict.breaking, ['removed $.agentRuntime.sessions.capabilities["delegation"]', 'removed $.lifecycle.timeoutMs'])
})

test('fixture: removal without a major bump fails', () => {
  const head = with_((c) => { c.schemaVersion = '5.3'; c.agentRuntime.nodeKinds = ['prompt', 'verify'] })
  const verdict = evaluateContractChange({ base, head, messages: ['feat!: drop shell\n\nBREAKING CHANGE: shell node removed'] })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join('\n'), /requires a major schemaVersion bump[\s\S]*nodeKinds\["shell"\]/)
})

test('removal with a major bump but no BREAKING declaration fails', () => {
  const head = with_((c) => { c.schemaVersion = '6.0'; c.agentRuntime.sessions.eventTypes = ['session.opened'] })
  const verdict = evaluateContractChange({ base, head, messages: ['feat(sessions): simplify events'] })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join('\n'), /BREAKING CHANGE/)
})

test('a changed value type and a removed identified builtin are breaking', () => {
  const head = with_((c) => { c.schemaVersion = '5.3'; c.lifecycle.initCommand = ['init']; c.agentRuntime.builtins = [{ id: 'other', version: '1' }] })
  const verdict = evaluateContractChange({ base, head, messages: ['fix!: x'] })
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.breaking, ['removed $.agentRuntime.builtins[id=specrails-implementation]', 'type changed $.lifecycle.initCommand (string -> array)'])
})

test('changed scalar values only need a bump and are reported for review', () => {
  const head = with_((c) => { c.schemaVersion = '5.3'; c.agentRuntime.builtins[0].version = '8' })
  const verdict = evaluateContractChange({ base, head })
  assert.equal(verdict.ok, true)
  assert.match(verdict.notes.join('\n'), /builtins\[id=specrails-implementation\]\.version/)
})

test('deleting the contract fails; a new contract passes when well formed', () => {
  assert.equal(evaluateContractChange({ base, head: null }).ok, false)
  assert.equal(evaluateContractChange({ base: null, head: base }).ok, true)
  assert.equal(evaluateContractChange({ base: null, head: { schemaVersion: 'x' } }).ok, false)
})

test('free-text annotation edits need no bump; other prose-like values do', () => {
  const annotated = with_((c) => { c.lifecycle.description = 'old'; c.agentRuntime.notes = 'n' })
  const reworded = clone(annotated)
  reworded.lifecycle.description = 'clearer wording'
  delete reworded.agentRuntime.notes
  reworded.agentRuntime.documentation = 'docs/agent-runtime.md'
  const verdict = evaluateContractChange({ base: annotated, head: reworded })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
  assert.match(verdict.notes.join('\n'), /annotations changed[\s\S]*lifecycle\.description/)
  assert.equal(evaluateContractChange({ base: annotated, head: { ...reworded, schemaVersion: '5.1' } }).ok, false)
  const semantic = with_((c) => { c.lifecycle.initCommand = 'install' })
  assert.match(evaluateContractChange({ base, head: semantic }).errors.join(), /did not increase/)
})

test('detects BREAKING declarations in headers, footers and PR titles only', () => {
  assert.equal(declaresBreakingChange(['feat(api)!: x']), true)
  assert.equal(declaresBreakingChange(['feat: x\n\nBREAKING CHANGE: y']), true)
  assert.equal(declaresBreakingChange(['feat: x\n\nBREAKING-CHANGE: y']), true)
  assert.equal(declaresBreakingChange(['feat: mention breaking change in prose', 'fix: x!']), false)
})

test('the shipped contract diffs cleanly against itself and has a valid version', () => {
  const contract = JSON.parse(readFileSync(new URL('../integration-contract.json', import.meta.url), 'utf8'))
  assert.ok(parseSchemaVersion(contract.schemaVersion))
  assert.deepEqual(diffContract(contract, clone(contract)), { removed: [], typeChanged: [], valueChanged: [], added: [] })
})

// --- stable promotion ---------------------------------------------------------
const day = 24 * 60 * 60 * 1000
const now = Date.parse('2026-10-21T00:00:00Z')
const iso = (daysAgo) => new Date(now - daysAgo * day).toISOString()
const packument = (overrides = {}) => ({
  name: 'specrails-core',
  'dist-tags': { latest: '6.6.5', stable: '6.6.2' },
  versions: { '6.6.2': {}, '6.6.3': {}, '6.6.4': {}, '6.6.5': {} },
  time: { '6.6.2': iso(40), '6.6.3': iso(20), '6.6.4': iso(10), '6.6.5': iso(2) },
  ...overrides,
})

test('promotes a version that was latest for at least seven days', () => {
  const verdict = evaluatePromotion({ version: '6.6.4', packument: packument(), now })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
  assert.equal(Math.round(verdict.latestDays), 8)
})

test('refuses a version that was latest for less than seven days', () => {
  assert.match(evaluatePromotion({ version: '6.6.5', packument: packument(), now }).errors.join(), /latest for 2\.0 days/)
  const quick = packument({ time: { ...packument().time, '6.6.4': iso(10), '6.6.5': iso(6) } })
  assert.equal(evaluatePromotion({ version: '6.6.4', packument: quick, now }).ok, false)
})

test('refuses unpublished, malformed, deprecated, backwards or ahead-of-latest versions', () => {
  assert.equal(evaluatePromotion({ version: '9.9.9', packument: packument(), now }).ok, false)
  assert.equal(evaluatePromotion({ version: '6.6.4-rc.1', packument: packument(), now }).ok, false)
  assert.match(evaluatePromotion({ version: '6.6.4', packument: packument({ versions: { ...packument().versions, '6.6.4': { deprecated: 'bad' } } }), now }).errors.join(), /deprecated/)
  assert.match(evaluatePromotion({ version: '6.6.2', packument: packument({ 'dist-tags': { latest: '6.6.5', stable: '6.6.3' } }), now }).errors.join(), /backwards/)
  assert.match(evaluatePromotion({ version: '6.6.4', packument: packument({ 'dist-tags': { latest: '6.6.3' } }), now }).errors.join(), /newer than latest/)
})

test('re-promoting the current stable is a no-op', () => {
  assert.deepEqual(evaluatePromotion({ version: '6.6.2', packument: packument(), now }), { ok: true, noop: true, errors: [], latestDays: 0 })
})

const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
const sha = 'b'.repeat(40)
const github = (run) => async (url) => (url.includes('/commits/') ? response(200, { sha }) : response(200, { workflow_runs: run ? [run] : [] }))

test('requires a green CI push run on main for the tag commit', async () => {
  const green = { id: 7, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' }
  assert.deepEqual(await assertTagCiGreen({ version: '6.6.4', repository: 'o/r', token: 't', fetchImpl: github(green) }), { sha, runId: '7' })
  await assert.rejects(assertTagCiGreen({ version: '6.6.4', repository: 'o/r', token: 't', fetchImpl: github({ ...green, conclusion: 'failure' }) }), /stable requires a green tag/)
  await assert.rejects(assertTagCiGreen({ version: '6.6.4', repository: 'o/r', token: 't', fetchImpl: github(null) }), /No CI push run/)
  await assert.rejects(assertTagCiGreen({ version: '6.6.4', repository: 'o/r', token: '', fetchImpl: github(green) }), /token/)
  await assert.rejects(assertTagCiGreen({ version: '6.6.4', repository: 'o/r', token: 't', fetchImpl: async () => response(404, {}) }), /Cannot resolve tag/)
})

test('workflows wire the contract gate on PRs and keep promotion manual and dry by default', () => {
  const read = (name) => yaml(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'))
  const gate = read('ci.yml').jobs['contract-policy']
  assert.equal(gate.if, "github.event_name == 'pull_request'")
  assert.equal(gate.steps[0].with['fetch-depth'], 0)
  assert.equal(gate.steps.at(-1).run, 'node scripts/check-contract-bump.mjs')
  const promote = read('promote-stable.yml')
  assert.deepEqual(Object.keys(promote.on), ['workflow_dispatch'])
  assert.equal(promote.on.workflow_dispatch.inputs.dry_run.default, true)
  assert.equal(promote.concurrency.group, 'core-release')
  assert.equal(promote.jobs.promote.permissions['id-token'], undefined)
})
