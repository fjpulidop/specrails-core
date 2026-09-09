import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { load as yaml } from 'js-yaml'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { integrity, releaseVersion, validateVersions, validateArtifact, validatePackFiles, validateRelease, run } from './release-utils.mjs'
import { awaitCi, selectCiRun, isCurrentMain } from './await-ci.mjs'
import { readArtifact, publishedState, assertMonotonicRelease, compareStableVersions } from './publish-package.mjs'
import { isolatedEnvironment } from './verify-package.mjs'

const sha = 'a'.repeat(40)
const bytes = Buffer.from('real package bytes')
const manifest = { schemaVersion: 1, name: 'specrails-core', version: '5.0.0', sha, filename: 'specrails-core-5.0.0.tgz', integrity: integrity(bytes) }
const versions = () => [{ name: 'specrails-core', version: '5.0.0' }, { version: '5.0.0', packages: { '': { version: '5.0.0' } } }, { '.': '5.0.0' }]
const packFiles = ['package.json', 'bin/specrails-core.mjs', 'dist/installer/cli.js', 'dist/installer/runtime/pipeline-state.js', 'integration-contract.json', 'pinned-versions.json', 'schemas/profile.v1.json', 'templates/codex-skills/implement/SKILL.md'].map((path) => ({ path }))
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
const ciRun = (changes = {}) => ({ id: 10, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', ...changes })

test('release tag syntax accepts stable tags only', () => {
  assert.equal(releaseVersion('v5.0.0'), '5.0.0')
  for (const value of ['main', '5.0.0', 'v05.0.0', 'v5.0.0-rc.1', 'v5.0.0\n', 'v5.0.0;echo token', '../v5.0.0']) assert.throws(() => releaseVersion(value))
})
test('release versions require root lockfile and release-please parity', () => {
  validateVersions('5.0.0', ...versions())
  for (const index of [0, 1, 2]) {
    const inputs = versions()
    if (index === 2) inputs[index]['.'] = '4.12.0'; else inputs[index].version = '4.12.0'
    assert.throws(() => validateVersions('5.0.0', ...inputs))
  }
  const inputs = versions(); inputs[1].packages[''].version = '4.12.0'
  assert.throws(() => validateVersions('5.0.0', ...inputs))
})
test('artifact validation binds exact bytes, version and tested commit', () => {
  assert.equal(validateArtifact(manifest, bytes, { version: '5.0.0', sha }), manifest)
  assert.throws(() => validateArtifact(manifest, Buffer.from('different'), { version: '5.0.0', sha }))
  assert.throws(() => validateArtifact(manifest, bytes, { version: '5.0.1', sha }))
  assert.throws(() => validateArtifact(manifest, bytes, { version: '5.0.0', sha: 'b'.repeat(40) }))
})
test('artifact validation rejects traversal and unexpected package names', () => {
  for (const filename of ['../secret.tgz', '/tmp/secret.tgz', 'specrails-core-5.0.0.tgz\n']) assert.throws(() => validateArtifact({ ...manifest, filename }, bytes, { version: '5.0.0', sha }))
  assert.throws(() => validateArtifact({ ...manifest, name: 'other-package' }, bytes, { version: '5.0.0', sha }))
})
test('packed files require the shipped runtime and dispatcher', () => {
  validatePackFiles(packFiles)
  assert.throws(() => validatePackFiles(packFiles.filter((file) => !file.path.includes('pipeline-state'))), /missing/)
})
test('packed files reject private environment, Git state and dependency entries', () => {
  for (const unsafe of ['../secret', '.env', 'docs/.env.local', 'node_modules/pkg/index.js', '.git/config', '.specrails/local-tickets.json', 'docs\\secret']) {
    assert.throws(() => validatePackFiles([...packFiles, { path: unsafe }]), /private or unsafe/)
  }
})
test('CI selection rejects wrong SHA, PR runs, branches, and stale successful attempts', () => {
  assert.equal(selectCiRun([ciRun({ id: 100, head_sha: 'b'.repeat(40) }), ciRun({ id: 99, event: 'pull_request' }), ciRun({ id: 98, head_branch: 'feature' }), ciRun({ id: 11, conclusion: 'failure' }), ciRun()], sha).conclusion, 'failure')
  assert.equal(selectCiRun([ciRun({ run_attempt: 1 }), ciRun({ run_attempt: 2, status: 'in_progress' })], sha).status, 'in_progress')
})
test('CI gate waits for exact completed main run and returns artifact run ID', async () => {
  let calls = 0, sleeps = 0
  const id = await awaitCi({ repository: 'owner/repo', sha, token: 'fixture-token', fetchImpl: async () => response(200, { workflow_runs: ++calls === 1 ? [ciRun({ status: 'in_progress' })] : [ciRun()] }), sleep: async () => { sleeps++ } })
  assert.equal(id, '10'); assert.equal(sleeps, 1)
})
test('CI gate fails closed for failed/cancelled/skipped runs', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped']) await assert.rejects(awaitCi({ repository: 'owner/repo', sha, token: 'fixture-token', fetchImpl: async () => response(200, { workflow_runs: [ciRun({ conclusion })] }) }), new RegExp(conclusion))
})
test('CI gate is bounded when the exact run never appears', async () => {
  let calls = 0
  await assert.rejects(awaitCi({ repository: 'owner/repo', sha, token: 'fixture-token', maxAttempts: 2, sleep: async () => {}, fetchImpl: async () => { calls++; return response(200, { workflow_runs: [ciRun({ head_sha: 'b'.repeat(40) })] }) } }), /Timed out/)
  assert.equal(calls, 2)
})
test('CI API authorization failure cannot bypass release gate', async () => {
  await assert.rejects(awaitCi({ repository: 'owner/repo', sha, token: 'fixture-token', fetchImpl: async () => response(403) }), /HTTP 403/)
})
test('registry missing version can be published but errors cannot', async () => {
  assert.equal(await publishedState('5.0.0', manifest.integrity, async () => response(404)), 'new')
  for (const status of [401, 403, 500]) await assert.rejects(publishedState('5.0.0', manifest.integrity, async () => response(status)), /registry check failed/)
})
test('idempotent release retry requires byte-identical published tarball', async () => {
  const pkg = { name: 'specrails-core', version: '5.0.0', dist: { integrity: manifest.integrity } }
  assert.equal(await publishedState('5.0.0', manifest.integrity, async () => response(200, pkg)), 'identical')
  await assert.rejects(publishedState('5.0.0', manifest.integrity, async () => response(200, { ...pkg, dist: { integrity: 'sha512-different' } })), /different bytes/)
})
test('artifact reader rejects traversal before accessing a path', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'core-artifact-'))
  try {
    writeFileSync(path.join(temp, 'release-manifest.json'), JSON.stringify({ ...manifest, filename: '../private.tgz' }))
    assert.throws(() => readArtifact(temp, { version: '5.0.0', sha }), /Unsafe/)
    writeFileSync(path.join(temp, 'release-manifest.json'), JSON.stringify(manifest))
    writeFileSync(path.join(temp, manifest.filename), bytes)
    assert.equal(readArtifact(temp, { version: '5.0.0', sha }).manifest.integrity, manifest.integrity)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
test('package smoke isolates HOME, registry and provider control overrides', () => {
  const old = process.env.SPECRAILS_CORE_SCRIPT_DIR
  process.env.SPECRAILS_CORE_SCRIPT_DIR = '/do-not-read-real-checkout'
  try {
    const env = isolatedEnvironment('/fixture/home')
    assert.equal(env.HOME, '/fixture/home'); assert.equal(env.USERPROFILE, '/fixture/home')
    assert.equal(env.SPECRAILS_CORE_SCRIPT_DIR, undefined)
    assert.equal(env.NODE_AUTH_TOKEN, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.SPECRAILS_REGISTRY_HOME, path.join('/fixture/home', 'registry'))
  } finally { if (old === undefined) delete process.env.SPECRAILS_CORE_SCRIPT_DIR; else process.env.SPECRAILS_CORE_SCRIPT_DIR = old }
})
test('real Git release gate rejects wrong tags, untested commits and non-main history', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'core-release-git-'))
  try {
    const env = isolatedEnvironment(temp)
    const git = (...args) => run('git', ['-C', temp, '-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { env })
    git('init', '--initial-branch=main')
    mkdirSync(path.join(temp, 'empty-hooks'))
    git('config', 'core.hooksPath', path.join(temp, 'empty-hooks'))
    for (const [index, name] of ['package.json', 'package-lock.json', '.release-please-manifest.json'].entries()) writeFileSync(path.join(temp, name), JSON.stringify(versions()[index]))
    git('add', '.'); git('commit', '-m', 'fixture')
    const original = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/main', original); git('tag', 'v5.0.0')
    assert.deepEqual(validateRelease(temp, 'v5.0.0', original), { sha: original, version: '5.0.0' })
    assert.throws(() => validateRelease(temp, 'v5.0.0', 'f'.repeat(40)), /tested commit/)
    git('checkout', '-b', 'unmerged'); writeFileSync(path.join(temp, 'change'), 'new bytes'); git('add', '.'); git('commit', '-m', 'unmerged')
    assert.throws(() => validateRelease(temp, 'v5.0.0'), /tested commit/)
    git('tag', '-f', 'v5.0.0')
    assert.throws(() => validateRelease(temp, 'v5.0.0'), /failed/)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('release ordering compares numeric components and rejects non-stable versions', () => {
  assert.equal(compareStableVersions('5.10.0', '5.9.9'), 1)
  assert.equal(compareStableVersions('5.0.0', '5.0.0'), 0)
  assert.equal(compareStableVersions('4.99.9', '5.0.0'), -1)
  assert.throws(() => compareStableVersions('5.0.0-beta.1', '5.0.0'))
})
test('publishing an old tag cannot downgrade npm latest, even during a retry', async () => {
  await assert.rejects(assertMonotonicRelease('4.12.0', async () => response(200, { name: 'specrails-core', version: '5.0.0' })), /older release/)
  await assertMonotonicRelease('5.0.0', async () => response(200, { name: 'specrails-core', version: '5.0.0' }))
  await assertMonotonicRelease('5.1.0', async () => response(200, { name: 'specrails-core', version: '5.0.0' }))
  await assertMonotonicRelease('5.0.0', async () => response(404))
  await assert.rejects(assertMonotonicRelease('5.0.0', async () => response(503)), /HTTP 503/)
})

test('Release Please metadata gate skips old main pushes and fails closed on API errors', async () => {
  const input = { repository: 'owner/repo', sha, token: 'fixture-token' }
  assert.equal(await isCurrentMain({ ...input, fetchImpl: async () => response(200, { object: { sha } }) }), true)
  assert.equal(await isCurrentMain({ ...input, fetchImpl: async () => response(200, { object: { sha: 'b'.repeat(40) } }) }), false)
  await assert.rejects(isCurrentMain({ ...input, fetchImpl: async () => response(403) }), /HTTP 403/)
  await assert.rejects(isCurrentMain({ ...input, fetchImpl: async () => response(200, {}) }), /no valid main SHA/)
})


test('automatic publication takes checkout, expected SHA and artifact CI from the release tag evidence', () => {
  const { jobs } = yaml(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const evidence = jobs['release-evidence']
  assert.ok(evidence, 'the tagged commit needs its own CI gate after Release Please')
  const checkout = evidence.steps.find(step => step.uses?.startsWith('actions/checkout@') && step.with.path === 'release-source')
  assert.equal(checkout.with.ref, "${{ format('refs/tags/{0}', needs.release-please.outputs.tag) }}")
  assert.equal(evidence.steps.find(step => step.id === 'ci').env.RELEASE_CI_SHA, '${{ steps.release.outputs.sha }}')
  assert.equal(evidence.permissions['id-token'], undefined)
  assert.equal(evidence.steps[0].with.ref, undefined, 'orchestration helpers come from the triggering workflow, not the older tag')
  assert.equal(evidence.steps.find(step => step.id === 'release')['working-directory'], 'release-source')
  assert.match(evidence.steps.find(step => step.id === 'release').run, /GITHUB_WORKSPACE\/scripts\/validate-release/)
  assert.ok(jobs.publish.needs.includes('release-evidence'))
  assert.match(jobs.publish.if, /needs\.release-evidence\.result == 'success'/)
  const publishCheckout = jobs.publish.steps.find(step => step.uses?.startsWith('actions/checkout@'))
  const validate = jobs.publish.steps.find(step => step.id === 'release')
  assert.equal(publishCheckout.with.ref, validate.env.EXPECTED_SHA)
  assert.match(validate.env.EXPECTED_SHA, /needs\.release-evidence\.outputs\.sha/)
  assert.doesNotMatch(validate.env.EXPECTED_SHA, /github\.sha/)
  const download = jobs.publish.steps.find(step => step.uses?.startsWith('actions/download-artifact@') && step.if.includes("'push'"))
  assert.equal(download.with['run-id'], '${{ needs.release-evidence.outputs.run_id }}')
})

test('a delayed release selects the tagged ancestor CI and rejects the triggering commit artifact', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'core-delayed-release-'))
  try {
    const env = isolatedEnvironment(temp)
    const git = (...args) => run('git', ['-C', temp, '-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { env })
    git('init', '--initial-branch=main')
    mkdirSync(path.join(temp, 'empty-hooks')); git('config', 'core.hooksPath', path.join(temp, 'empty-hooks'))
    for (const [index, name] of ['package.json', 'package-lock.json', '.release-please-manifest.json'].entries()) writeFileSync(path.join(temp, name), JSON.stringify(versions()[index]))
    git('add', '.'); git('commit', '-m', 'release version')
    const tagged = git('rev-parse', 'HEAD'); git('tag', 'v5.0.0')
    writeFileSync(path.join(temp, 'test-fix'), 'later test-only change'); git('add', '.'); git('commit', '-m', 'fix CI')
    const trigger = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', trigger)
    assert.throws(() => validateRelease(temp, 'v5.0.0', trigger), /tested commit/)
    git('checkout', '--detach', 'refs/tags/v5.0.0')
    const release = validateRelease(temp, 'v5.0.0')
    assert.equal(release.sha, tagged)
    const workflow_runs = [ciRun({ id: 20, head_sha: trigger }), ciRun({ id: 10, head_sha: tagged })]
    const input = { repository: 'owner/repo', sha: release.sha, token: 'fixture-token', fetchImpl: async () => response(200, { workflow_runs }) }
    assert.equal(await awaitCi(input), '10')
    // Exercise the actual CLI environment wiring used by Actions, including a
    // later GITHUB_SHA. Stub only the network response, never run a publication.
    const output = path.join(temp, 'actions-output')
    const fetchStub = path.join(temp, 'fetch-stub.mjs')
    writeFileSync(fetchStub, `globalThis.fetch = async url => { if (!url.includes('head_sha=${tagged}')) throw new Error('Requested CI for the wrong commit'); return { ok: true, json: async () => (${JSON.stringify({ workflow_runs })}) }; };`)
    const cli = path.resolve('scripts/await-ci.mjs')
    run(process.execPath, ['--import', pathToFileURL(fetchStub).href, cli], { env: { ...env, GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: trigger, RELEASE_CI_SHA: tagged, GH_TOKEN: 'fixture-token', GITHUB_OUTPUT: output } })
    assert.match(readFileSync(output, 'utf8'), /run_id=10/)

    assert.equal(validateArtifact({ ...manifest, sha: tagged }, bytes, release).sha, tagged)
    assert.throws(() => validateArtifact({ ...manifest, sha: trigger }, bytes, release), /identity/)
    workflow_runs[1].conclusion = 'failure'
    await assert.rejects(awaitCi(input), /CI .* is failure/)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
