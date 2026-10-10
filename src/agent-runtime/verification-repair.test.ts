import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validatePipelineContext, type CommandReceipt, type PipelineContext, type VerificationReceipt } from '../pipeline/pipeline-state.js'
import { adoptedOutputNote, boundedBlocker, driftedFailureRoots, environmentFailure, checkoutRelative, hostPreconditionMessage, installRoots, nondeterministicOutputBlocker, preconditionBlock, repairEnvironment, selfMutationOnly } from './verification-repair.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(files: Record<string, string> = {}, dirs: string[] = []): { root: string; context: PipelineContext } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'repair-'))); roots.push(root)
  for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true })
  for (const [name, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text) }
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'repair', backlogRoot: root, artifactRoot: root, artifactRepositoryId: 'app', repositories: [{ id: 'app', name: 'App', path: root }],
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Feature', description: 'Keep behavior', acceptanceCriteria: ['Tests pass'] }] })
  return { root, context }
}
function receipt(commands: Array<Partial<CommandReceipt> & { output: string }>): VerificationReceipt {
  return { id: 'receipt', kind: 'full', scopeHash: 's', candidateHash: 'c', completedAt: new Date().toISOString(), valid: commands.every(command => (command.exitCode ?? 1) === 0),
    commands: commands.map(command => ({ repositoryId: 'app', command: 'npm', args: ['test'], cwd: '', exitCode: 1, durationMs: 1, environmentHash: '', environmentKeys: [], environmentOverrideKeys: [], environmentOverridesHash: '', ...command })) }
}
const spawnResult = (status: number, stderr = '') => ({ status, stdout: '', stderr, pid: 1, output: [], signal: null })

describe('preconditionBlock', () => {
  it('returns a structured blocker for the first failed command whose output is a host precondition, with its kind and checkout-relative cwd', () => {
    const { root, context } = fixture({}, ['packages/app'])
    const cwd = path.join(root, 'packages', 'app')
    const cases: Array<[string, string]> = [
      ['Usage Error: Environment variable not found (NODE_AUTH_TOKEN) in /w/app/.yarnrc.yml', 'environment-variable'],
      ['npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/@acme%2fui', 'credential'],
      ['npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org', 'network'],
      ['Failed to download Chromium 131.0.6778.33 (playwright build v1148), caused by\nError: getaddrinfo ENOTFOUND cdn.playwright.dev', 'network'],
      ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'credential'],
    ]
    for (const [output, kind] of cases) {
      const blocker = preconditionBlock(context, receipt([{ output: 'ok', exitCode: 0, cwd: root }, { output, cwd, command: 'yarn', args: ['test'], evidenceId: 'ev-1' }]))
      expect(blocker, output).toMatchObject({ kind, command: 'yarn', args: ['test'], cwd: 'packages/app', evidenceId: 'ev-1' })
      expect(blocker!.reason).not.toBe('')
      expect(blocker!.requiredAction).toMatch(/then retry the run\.$/)
    }
    expect(preconditionBlock(context, receipt([{ output: 'FAIL src/app.spec.ts\n  ● renders\n    expect(received).toBe(expected)', cwd: root }]))).toBeUndefined()
    expect(preconditionBlock(context, receipt([{ output: 'sh: jest: command not found', cwd: root }]))).toBeUndefined()
    expect(checkoutRelative(context, root)).toBe('.')
    expect(checkoutRelative(context, '/elsewhere')).toBe('/elsewhere')
  })
  it('renders the legacy host-facing sentence from the blocker fields', () => {
    expect(hostPreconditionMessage('the registry rejected the credentials', 'npm', ['ci'], 'packages/app')).toBe('Verification cannot run in this environment: the registry rejected the credentials (`npm ci` in packages/app). This is not a defect in the change, so no correction round was started. Make it available to Specrails (for example in the login shell profile Specrails loads, or with a refreshed registry token), then resume.')
  })
})

describe('installRoots', () => {
  it('installs where the nearest lockfile or manifest above the failing command lives, and always keeps every repository root', () => {
    const { root, context } = fixture({ 'packages/app/yarn.lock': '', 'package-lock.json': '{}' }, ['packages/app/src', 'tools'])
    const commands = receipt([{ output: '', cwd: path.join(root, 'packages', 'app', 'src') }, { output: '', cwd: path.join(root, 'tools') }, { output: '', cwd: '/outside', repositoryId: 'other' }]).commands
    expect(installRoots(context, commands)).toEqual([path.join(root, 'packages', 'app'), root])
  })
})

describe('repairEnvironment', () => {
  it('runs the planned installs once, narrates them like the legacy graph and reports what succeeded', () => {
    const { root, context } = fixture({ 'package.json': '{"devDependencies":{"jest":"^29"}}' })
    const spawn = vi.fn(() => spawnResult(0)) as never
    const notes: string[] = []
    const repair = repairEnvironment(context, receipt([{ output: 'sh: jest: command not found', cwd: root }]), undefined, text => notes.push(text), spawn)
    expect(repair.refused).toBeUndefined()
    expect(repair.installs).toMatchObject([{ command: 'npm', args: ['install', '--no-audit', '--no-fund', '--loglevel=error'], root, ok: true }])
    expect(notes[0]).toBe(`[environment] npm install --no-audit --no-fund --loglevel=error (${path.basename(root)})`)
    expect(notes.at(-1)).toBe(`Environment: installed node dependencies in ${path.basename(root)}`)
  })
  it('refuses with a credential blocker when the install itself hits a precondition', () => {
    const { root, context } = fixture({ 'package.json': '{"devDependencies":{"@acme/ui":"^1"}}' })
    const spawn = vi.fn(() => spawnResult(1, 'npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/@acme%2fui')) as never
    const repair = repairEnvironment(context, receipt([{ output: "Error: Cannot find package '@acme/ui'", cwd: root }]), undefined, () => {}, spawn)
    expect(repair.refused).toMatchObject({ kind: 'credential', command: 'npm', cwd: '.', reason: 'installing its dependencies failed because the package registry rejected the credentials available to verification commands (HTTP 401/403)' })
    expect(repair.refused!.requiredAction).toContain('registry credentials')
  })
  it('names the exact install to repeat with network access when a browser download fails offline', () => {
    const { root, context } = fixture({ 'package.json': '{"devDependencies":{"@playwright/test":"^1.48"}}' }, ['node_modules/@playwright/test'])
    const spawn = vi.fn(() => spawnResult(1, 'Failed to download Chromium 131.0.6778.33 (playwright build v1148), caused by\nError: getaddrinfo ENOTFOUND cdn.playwright.dev')) as never
    const repair = repairEnvironment(context, receipt([{ output: "browserType.launch: Executable doesn't exist at /Users/dev/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-mac-arm64/headless_shell", cwd: root }]), undefined, () => {}, spawn)
    expect(repair.refused).toMatchObject({ kind: 'network', command: 'npx', args: ['playwright', 'install', 'chromium'], cwd: '.', requiredAction: 'Run `npx playwright install chromium` in . with network access, then retry the run.' })
  })
  it('honors the lockfile-repair guardrail', () => {
    const { root, context } = fixture({ 'package.json': '{"devDependencies":{"jest":"^29"}}', 'package-lock.json': '{"lockfileVersion":3}' })
    const spawn = vi.fn(() => spawnResult(1, 'npm error code EINTEGRITY')) as never
    const repair = repairEnvironment(context, receipt([{ output: 'sh: jest: command not found', cwd: root }]), { 'lockfile-repair': false }, () => {}, spawn)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(existsSync(path.join(root, 'package-lock.json'))).toBe(true)
    expect(repair.installs[0]).toMatchObject({ ok: false })
    expect(repair.refused).toBeUndefined()
  })
})

describe('boundedBlocker', () => {
  it('admits a fixer-shaped blocker, bounds every field and rejects unknown kinds', () => {
    expect(boundedBlocker({ kind: 'toolchain', command: 'npx', args: ['playwright', 'install'], cwd: '.', evidence: 'Executable does not exist', requiredAction: 'Install the browser.' }))
      .toEqual({ kind: 'toolchain', reason: 'Executable does not exist', command: 'npx', args: ['playwright', 'install'], cwd: '.', requiredAction: 'Install the browser.' })
    expect(boundedBlocker({ kind: 'network', reason: 'x'.repeat(5_000), command: 'c', args: Array.from({ length: 40 }, () => 'a'.repeat(300)), cwd: '.', requiredAction: 'r', evidenceId: 'e' })).toMatchObject({ reason: 'x'.repeat(2_000), args: Array.from({ length: 16 }, () => 'a'.repeat(256)), evidenceId: 'e' })
    expect(boundedBlocker({ kind: 'weather', reason: 'rain' })).toBeUndefined()
    expect(boundedBlocker('blocked')).toBeUndefined()
    expect(boundedBlocker(null)).toBeUndefined()
  })
})

describe('verification self-mutation', () => {
  const mutated = (exitCode: number, extra: Partial<VerificationReceipt> = {}): VerificationReceipt => ({ ...receipt([{ output: 'ok', exitCode, cwd: '' }]), valid: false,
    selfMutation: { files: [{ repositoryId: 'app', path: 'gen/a.js', change: 'modified' }], commands: [{ repositoryId: 'app', label: 'npm test' }] }, ...extra })
  it('is adoptable only when every command passed and ran, and the receipt is invalid because of the mutation', () => {
    expect(selfMutationOnly(mutated(0))).toBe(true)
    expect(selfMutationOnly(mutated(1))).toBe(false)
    expect(selfMutationOnly(mutated(0, { notRunEvidenceIds: ['x'] }))).toBe(false)
    expect(selfMutationOnly(mutated(0, { selfMutation: undefined }))).toBe(false)
    expect(selfMutationOnly({ ...mutated(0), commands: [{ ...mutated(0).commands[0]!, outcome: 'timed-out' }] })).toBe(false)
  })
  it('builds the typed blocker and the adoption note, and keeps the blocker kind through boundedBlocker', () => {
    const { root, context } = fixture()
    const blocker = nondeterministicOutputBlocker(context, { ...mutated(0), commands: [{ ...mutated(0).commands[0]!, cwd: root }] }, true)
    expect(blocker).toMatchObject({ kind: 'nondeterministic-output', command: 'npm', args: ['test'], cwd: '.', requiredAction: 'Commit the generated output on the base branch or make the generator idempotent, then retry the run.' })
    expect(blocker.reason).toBe('the verification commands modified 1 candidate file: gen/a.js, and modified them again when the host verified the adopted output once more')
    expect(boundedBlocker(blocker)).toEqual(blocker)
    expect(adoptedOutputNote(mutated(0).selfMutation!)).toBe('[verification] adopted 1 generated file(s): gen/a.js')
  })
})

describe('version drift classification', () => {
  it('marks a failure environmental when a package root containing the failing cwd has drifted dependencies', () => {
    const { root, context } = fixture({ 'package.json': JSON.stringify({ dependencies: { exp: '^2.0.0' } }), 'node_modules/exp/package.json': JSON.stringify({ version: '1.4.0' }),
      'packages/web/package.json': JSON.stringify({ dependencies: { ok: '^1.0.0' } }), 'packages/web/node_modules/ok/package.json': JSON.stringify({ version: '1.2.0' }) })
    const failing = receipt([{ output: 'error  Unsafe call  no-unsafe-call', cwd: path.join(root, 'packages', 'web') }])
    expect(driftedFailureRoots(context, failing)).toEqual([{ root, drift: [{ name: 'exp', declared: '^2.0.0', installed: '1.4.0' }] }])
    expect(environmentFailure(context, failing)).toEqual({ drift: [{ root, drift: [{ name: 'exp', declared: '^2.0.0', installed: '1.4.0' }] }] })
    expect(environmentFailure(context, receipt([{ output: 'ok', exitCode: 0, cwd: root }]))).toBeUndefined()
    expect(environmentFailure(context, receipt([{ output: 'sh: jest: command not found', cwd: path.join(root, 'packages', 'web') }]))).toBeDefined()
  })
})

