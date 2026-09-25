import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializePipeline, repositoryWorkingDirectory, validatePipelineContext, verifyPipeline, withinRepositoryScope, type PipelineContext } from '../pipeline/pipeline-state.js'
import { captureOutOfScope, changeBases, changeSet, discardOutOfScopeEdits, outOfScope, renderChangeSet, repositoryChanges } from './change-scope.js'
import { addDeveloperChecks, expandedPlanCommands, initializeVerificationPlan, validateProposedChecks } from './verification-plan.js'
import { proposedVerification } from './graph/artifacts.js'
import { repositoryContext } from './repository-context.js'

let root: string, checkout: string
function write(file: string, text: string): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
/** A file git restored: a Windows checkout with core.autocrlf rewrites its line endings. */
function restored(file: string): string { return readFileSync(file, 'utf8').replace(/\r\n/g, '\n') }
function git(args: string[]): string {
  const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
function context(scope?: unknown): PipelineContext {
  return validatePipelineContext({
    schemaVersion: 1, runId: 'scope-fixture', backlogRoot: path.join(root, 'workspace'), artifactRoot: checkout, artifactRepositoryId: 'app',
    repositories: [{ id: 'app', name: 'app', path: checkout, ...(scope === undefined ? {} : { scope }) }],
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [{ id: 1, title: 'Navigation', description: 'Fix the app navigation', repositoryIds: ['app'] }],
  })
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'change scope '))
  checkout = path.join(root, 'monorepo')
  mkdirSync(path.join(root, 'workspace'))
  write(path.join(checkout, 'package.json'), '{"scripts":{"test":"turbo run test"}}\n')
  write(path.join(checkout, 'yarn.lock'), '# root lock\n')
  write(path.join(checkout, '.yarnrc.yml'), 'npmAuthToken: "${NODE_AUTH_TOKEN}"\n')
  write(path.join(checkout, 'apps/app/package.json'), '{"scripts":{"test":"jest"}}\n')
  write(path.join(checkout, 'apps/app/src/nav.js'), 'module.exports = 1\n')
  write(path.join(checkout, 'apps/app/AGENTS.md'), '# App rules\nUse yarn test:app for focused tests.\n')
  write(path.join(checkout, 'apps/other/src/mappings.js'), 'module.exports = {}\n')
  spawnSync('git', ['init', '-q', checkout])
  git(['add', '.'])
  git(['-c', 'user.name=Scope', '-c', 'user.email=scope@example.invalid', 'commit', '-qm', 'baseline'])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('repository scope in the execution context', () => {
  it('normalizes directories as spelled on disk, drops nested entries and treats the root as the whole checkout', () => {
    expect(context(['./apps/app/', 'apps/app/src']).repositories[0]!.scope).toEqual(['apps/app'])
    expect(context(['.']).repositories[0]!.scope).toBeUndefined()
    expect(context(['apps/other', 'apps/app']).repositories[0]!.scope).toEqual(['apps/other', 'apps/app'])
    if (process.platform === 'darwin' || process.platform === 'win32') expect(context(['Apps/App']).repositories[0]!.scope).toEqual(['apps/app'])
  })

  it.each([[[]], [['../outside']], [['/abs']], [['apps/missing']], [['apps/app/src/nav.js']], ['apps/app']])('rejects invalid scope %j', scope => {
    expect(() => context(scope)).toThrow(/scope/i)
  })

  it('rejects a symlinked scope directory', () => {
    symlinkSync(path.join(checkout, 'apps/app'), path.join(checkout, 'apps/link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => context(['apps/link'])).toThrow(/real directory/)
  })

  it('answers membership and the default working directory', () => {
    const repository = context(['apps/app']).repositories[0]!
    expect(withinRepositoryScope(repository, 'apps/app/src/nav.js')).toBe(true)
    expect(withinRepositoryScope(repository, 'apps/app')).toBe(true)
    expect(withinRepositoryScope(repository, 'apps/application/x.js')).toBe(false)
    expect(withinRepositoryScope(repository, '.yarnrc.yml')).toBe(false)
    expect(repositoryWorkingDirectory(repository)).toBe(path.join(realpathSync(checkout), 'apps', 'app'))
    expect(withinRepositoryScope(context().repositories[0]!, '.yarnrc.yml')).toBe(true)
  })
})

describe('scoped verification', () => {
  it('runs host commands without cwd in the scope directory, keeps explicit cwd and freezes both in the plan', async () => {
    const scoped = context(['apps/app'])
    initializePipeline(scoped, 'scoped-change')
    const plan = initializeVerificationPlan(scoped, [
      { repositoryId: 'app', command: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'] },
      { repositoryId: 'app', command: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'], cwd: '.' },
    ], [])
    const commands = expandedPlanCommands(scoped, plan)
    expect(commands.map(command => command.cwd)).toEqual(['apps/app', '.'])
    const receipt = await verifyPipeline(scoped, { kind: 'full', commands })
    expect(receipt.commands.map(command => command.cwd)).toEqual([path.join(realpathSync(checkout), 'apps', 'app'), realpathSync(checkout)])
  })

  it('keeps model-proposed checks inside the scope and repairs the ones that escape it', () => {
    const scoped = context(['apps/app'])
    initializePipeline(scoped, 'scoped-change')
    initializeVerificationPlan(scoped, [], [])
    const check = { kind: 'command', key: 'focused', label: 'Focused', repositoryId: 'app', command: 'yarn', args: ['test:app'] }
    expect(() => validateProposedChecks(scoped, [{ ...check, cwd: '.' }])).toThrow(/^Invalid verification proposal cwd/)
    expect(() => validateProposedChecks(scoped, [{ ...check, cwd: 'apps/other' }])).toThrow(/outside the repository scope/)
    expect(validateProposedChecks(scoped, [{ ...check, cwd: 'apps/app/src' }])).toHaveLength(1)
    const plan = addDeveloperChecks(scoped, [check as never])
    expect(expandedPlanCommands(scoped, plan).at(-1)!.cwd).toBe('apps/app')
    expect(() => proposedVerification(scoped, [], [{ repositoryId: 'app', command: 'yarn', args: ['test'], cwd: '.' }])).toThrow(/^Invalid proposed verification command cwd/)
    expect(proposedVerification(scoped, [], [{ repositoryId: 'app', command: 'yarn', args: ['test'] }])).toEqual([{ repositoryId: 'app', command: 'yarn', args: ['test'] }])
  })

  it('leaves unscoped repositories exactly as before', () => {
    const whole = context()
    initializePipeline(whole, 'whole-change')
    const plan = initializeVerificationPlan(whole, [{ repositoryId: 'app', command: 'yarn', args: ['test'] }], [])
    expect(expandedPlanCommands(whole, plan)[0]!.cwd).toBe('.')
    expect(validateProposedChecks(whole, [{ kind: 'command', key: 'any', label: 'Any', repositoryId: 'app', command: 'yarn', args: ['test'], cwd: '.' }])).toHaveLength(1)
  })
})

describe('change set and out-of-scope edits', () => {
  it('measures the change from git against the recorded base, without runtime state or change artifacts', () => {
    const scoped = context(['apps/app'])
    const bases = changeBases(scoped)
    expect(bases.app).toBe(git(['rev-parse', 'HEAD']))
    write(path.join(checkout, 'apps/app/src/nav.js'), 'module.exports = 2\n')
    write(path.join(checkout, 'apps/app/src/nav.test.js'), 'test\n')
    write(path.join(checkout, 'openspec/changes/scoped-change/tasks.md'), '- [x] 1. Fix\n')
    write(path.join(checkout, '.specrails/runtime/state.json'), '{}\n')
    write(path.join(checkout, 'apps/app/node_modules/pkg/index.js'), '\n')
    git(['-c', 'user.name=Stray', '-c', 'user.email=stray@example.invalid', 'commit', '-qam', 'stray agent commit']) // a commit must not hide the change
    const [set] = changeSet(scoped, 'scoped-change')
    expect(set!.files).toEqual([{ path: 'apps/app/src/nav.js', status: 'modified' }, { path: 'apps/app/src/nav.test.js', status: 'added' }])
    expect(renderChangeSet([set!])).toEqual(['- `apps/app/src/nav.js` (modified)', '- `apps/app/src/nav.test.js` (added)'])
  })

  it('undoes only what a turn changed outside the scope and keeps in-scope work, prior state and lockfile refreshes', () => {
    const scoped = context(['apps/app'])
    // State that predates the turn: a host overlay file present when the run started, and an earlier out-of-scope edit.
    write(path.join(checkout, '.mcp.json'), '{"overlay":true}\n')
    changeBases(scoped)
    write(path.join(checkout, 'apps/other/src/mappings.js'), 'module.exports = { earlier: true }\n')
    const guard = captureOutOfScope(scoped, 'scoped-change')
    // The turn: the requested change plus environment and neighbour "repairs".
    write(path.join(checkout, 'apps/app/src/nav.js'), 'module.exports = 2\n')
    write(path.join(checkout, 'apps/app/package.json'), '{"scripts":{"test":"jest"},"dependencies":{"left-pad":"1.0.0"}}\n')
    write(path.join(checkout, 'yarn.lock'), '# root lock\nleft-pad@1.0.0\n')
    write(path.join(checkout, '.yarnrc.yml'), 'npmAuthToken: "${NODE_AUTH_TOKEN:-}"\n')
    write(path.join(checkout, 'package.json'), '{"scripts":{"test":"turbo run test --filter=app"}}\n')
    write(path.join(checkout, 'apps/other/src/mappings.js'), 'module.exports = { rewritten: true }\n')
    write(path.join(checkout, 'apps/other/src/new.js'), 'new\n')
    write(path.join(checkout, 'apps/other/src/staged.js'), 'staged\n')
    git(['add', 'apps/other/src/staged.js'])
    rmSync(path.join(checkout, '.mcp.json'))
    const discarded = discardOutOfScopeEdits(scoped, guard)
    expect(discarded.map(edit => [edit.path, edit.restored])).toEqual([
      ['.mcp.json', 'previous'], ['.yarnrc.yml', 'base'], ['apps/other/src/mappings.js', 'previous'], ['apps/other/src/new.js', 'removed'], ['apps/other/src/staged.js', 'removed'], ['package.json', 'base'],
    ])
    expect(restored(path.join(checkout, '.yarnrc.yml'))).toBe('npmAuthToken: "${NODE_AUTH_TOKEN}"\n')
    expect(restored(path.join(checkout, 'package.json'))).toBe('{"scripts":{"test":"turbo run test"}}\n')
    expect(readFileSync(path.join(checkout, 'apps/other/src/mappings.js'), 'utf8')).toBe('module.exports = { earlier: true }\n')
    expect(readFileSync(path.join(checkout, '.mcp.json'), 'utf8')).toBe('{"overlay":true}\n')
    expect(existsSync(path.join(checkout, 'apps/other/src/new.js'))).toBe(false)
    expect(git(['diff', '--cached', '--name-only'])).toBe('')
    // In-scope work and the lockfile its manifest change needs survive.
    expect(readFileSync(path.join(checkout, 'apps/app/src/nav.js'), 'utf8')).toBe('module.exports = 2\n')
    expect(readFileSync(path.join(checkout, 'yarn.lock'), 'utf8')).toContain('left-pad')
    const files = changeSet(scoped, 'scoped-change')[0]!.files.map(file => file.path)
    expect(files).toEqual(['apps/app/package.json', 'apps/app/src/nav.js', 'apps/other/src/mappings.js', 'yarn.lock'])
    expect(outOfScope(scoped.repositories[0]!, repositoryChanges(scoped, scoped.repositories[0]!, changeBases(scoped).app!)).map(file => file.path)).toEqual(['.mcp.json', 'apps/other/src/mappings.js'])
  })

  it('keeps a turn that returns an earlier out-of-scope edit to its base content, but restores host state it deleted', () => {
    const scoped = context(['apps/app'])
    write(path.join(checkout, '.mcp.json'), '{"overlay":true}\n')
    changeBases(scoped)
    write(path.join(checkout, 'yarn.lock'), '# refreshed by an earlier host install\n')
    const guard = captureOutOfScope(scoped)
    write(path.join(checkout, 'yarn.lock'), '# root lock\n')
    rmSync(path.join(checkout, '.mcp.json'))
    expect(discardOutOfScopeEdits(scoped, guard).map(edit => edit.path)).toEqual(['.mcp.json'])
    expect(readFileSync(path.join(checkout, 'yarn.lock'), 'utf8')).toBe('# root lock\n')
    expect(existsSync(path.join(checkout, '.mcp.json'))).toBe(true)
  })

  it('does nothing for a repository without scope', () => {
    const whole = context()
    const guard = captureOutOfScope(whole)
    write(path.join(checkout, '.yarnrc.yml'), 'changed\n')
    expect(discardOutOfScopeEdits(whole, guard)).toEqual([])
    expect(readFileSync(path.join(checkout, '.yarnrc.yml'), 'utf8')).toBe('changed\n')
  })

  it('orients the models with the scope instructions and scripts first', () => {
    const text = repositoryContext(context(['apps/app']))
    expect(text).toContain('Repository scope: apps/app/')
    expect(text).toContain('Use yarn test:app for focused tests.')
    expect(text.indexOf('apps/app/package.json scripts: {"test":"jest"}')).toBeLessThan(text.indexOf('package.json scripts: {"test":"turbo run test"}'))
  })
})
