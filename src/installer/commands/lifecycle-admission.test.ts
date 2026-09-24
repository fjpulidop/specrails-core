import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frameworkLifecycleLockPath, withFrameworkLifecycleLock, withInstallRollback } from '../util/install-transaction.js'
import { runAssemble, runInstallFramework, runSwapCurrent } from './framework.js'
import { runInit, snapshotWorkspaceProviderSelections } from './init.js'

vi.mock('../phases/prereqs.js', () => ({
  checkPrerequisites: vi.fn(async (options: { explicitProvider?: string }) => ({ provider: options.explicitProvider ?? 'claude' })),
}))

let root: string
let framework: string
let script: string
let repo: string
const file = (name: string, value: string) => { mkdirSync(path.dirname(name), { recursive: true }); writeFileSync(name, value) }
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'core-lifecycle-'))
  framework = path.join(root, '.specrails', 'framework')
  script = path.join(root, 'package')
  repo = path.join(root, 'repo')
  mkdirSync(framework, { recursive: true }); mkdirSync(repo)
  file(path.join(script, 'package.json'), JSON.stringify({ version: '5.0.0' }))
  file(path.join(repo, '.specrails', 'specrails-version'), '4.0.0')
  vi.stubEnv('SPECRAILS_REGISTRY_HOME', root)
  vi.stubEnv('SPECRAILS_CORE_SCRIPT_DIR', script)
  vi.stubEnv('SPECRAILS_SKIP_PREREQS', '1')
  vi.stubEnv('SPECRAILS_SKIP_OPENSPEC_INIT', '1')
  vi.stubEnv('SPECRAILS_RELOCATE', '0')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('framework lifecycle admission', () => {
  it('holds exclusive admission until rollback finishes; another success cannot be undone', async () => {
    const current = path.join(framework, 'current')
    const old = path.join(framework, '4.0.0')
    const next = path.join(framework, '5.0.0')
    mkdirSync(old); symlinkSync(old, current, process.platform === 'win32' ? 'junction' : 'dir')
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const failure = withFrameworkLifecycleLock(framework, () => withInstallRollback([current, next], async () => {
      mkdirSync(next)
      rmSync(current); symlinkSync(next, current, process.platform === 'win32' ? 'junction' : 'dir')
      await waiting
      throw new Error('OpenSpec failed')
    }))
    const second = vi.fn()
    await expect(withFrameworkLifecycleLock(framework, second)).rejects.toThrow('Another Core installation')
    expect(second).not.toHaveBeenCalled()
    release()
    await expect(failure).rejects.toThrow('OpenSpec failed')
    expect(existsSync(next)).toBe(false)
    expect(realpathSync(current)).toBe(realpathSync(old))
    await withFrameworkLifecycleLock(framework, () => {
      mkdirSync(next); rmSync(current); symlinkSync(next, current, process.platform === 'win32' ? 'junction' : 'dir')
    })
    expect(realpathSync(current)).toBe(realpathSync(next))
    expect(existsSync(frameworkLifecycleLockPath(framework))).toBe(false)
  })

  it('recovers only a positively dead owner without waiting', async () => {
    const lock = frameworkLifecycleLockPath(framework)
    file(lock, JSON.stringify({ pid: 987654321, token: 'dead' }))
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      expect(pid).toBe(987654321)
      throw Object.assign(new Error('no process'), { code: 'ESRCH' })
    })
    const apply = vi.fn(() => 7)
    expect(await withFrameworkLifecycleLock(framework, apply)).toBe(7)
    expect(existsSync(lock)).toBe(false)
  })

  it.each(['malformed', JSON.stringify({ pid: 0 }), JSON.stringify({ pid: process.pid })])('does not steal unknown/live owner %s', async (owner) => {
    file(frameworkLifecycleLockPath(framework), owner)
    await expect(withFrameworkLifecycleLock(framework, vi.fn())).rejects.toThrow('Another Core installation')
    expect(readFileSync(frameworkLifecycleLockPath(framework), 'utf8')).toBe(owner)
  })

  it('admits only one stale-owner reclaimer while another process is probing the dead owner', async () => {
    const lock = frameworkLifecycleLockPath(framework)
    file(lock, JSON.stringify({ pid: 987654321, token: 'dead' }))
    const second = vi.fn()
    let rival: Promise<unknown> | undefined
    vi.spyOn(process, 'kill').mockImplementation(() => {
      rival = withFrameworkLifecycleLock(framework, second).catch((error: unknown) => error)
      throw Object.assign(new Error('no process'), { code: 'ESRCH' })
    })
    await withFrameworkLifecycleLock(framework, async () => {
      expect(await rival).toBeInstanceOf(Error)
      expect(second).not.toHaveBeenCalled()
      expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid)
    })
  })

  it.each([
    ['.claude', 'agents'],
    ['.kimi-code', 'skills'],
    ['.kimi-code', 'skills/rails'],
    ['.specrails', 'profiles'],
  ])('preserves live reserved changes, new files and deliberate deletions during rollback of %s/%s', async (providerName, reservedDirectory) => {
    const provider = path.join(repo, providerName)
    const reserved = path.join(provider, reservedDirectory)
    const managed = path.join(provider, 'managed.txt')
    file(managed, 'old managed')
    file(path.join(reserved, 'custom-edited.md'), 'old custom')
    file(path.join(reserved, 'custom-deleted.md'), 'deleted by user')
    await expect(withInstallRollback([provider], async () => {
      file(managed, 'new managed')
      file(path.join(reserved, 'custom-edited.md'), 'new custom')
      file(path.join(reserved, 'custom-created.md'), 'created while awaiting')
      rmSync(path.join(reserved, 'custom-deleted.md'))
      throw new Error('fixture failure')
    })).rejects.toThrow('fixture failure')
    expect(readFileSync(managed, 'utf8')).toBe('old managed')
    expect(readFileSync(path.join(reserved, 'custom-edited.md'), 'utf8')).toBe('new custom')
    expect(readFileSync(path.join(reserved, 'custom-created.md'), 'utf8')).toBe('created while awaiting')
    expect(existsSync(path.join(reserved, 'custom-deleted.md'))).toBe(false)
  })

  it('restores managed Unicode trees while preserving live custom edits after failure', async () => {
    const provider = path.join(root, 'José User Home', 'Proyecto español', '.claude')
    const managed = path.join(provider, 'Guía', '契約.md')
    const custom = path.join(provider, 'agents', 'custom-español.md')
    file(managed, 'original managed Unicode bytes')
    file(custom, 'original custom bytes')
    await expect(withInstallRollback([provider], async () => {
      file(managed, 'failed replacement')
      file(custom, 'new user-authored bytes')
      throw new Error('Unicode update fixture failed')
    })).rejects.toThrow('Unicode update fixture failed')
    expect(readFileSync(managed, 'utf8')).toBe('original managed Unicode bytes')
    expect(readFileSync(custom, 'utf8')).toBe('new user-authored bytes')
  })

  it('never removes a replacement owner when finishing an operation', async () => {
    const lock = frameworkLifecycleLockPath(framework)
    await withFrameworkLifecycleLock(framework, () => file(lock, 'replacement-owner'))
    expect(readFileSync(lock, 'utf8')).toBe('replacement-owner')
  })

  it('shares admission across init and every Desktop low-level mutation', async () => {
    await withFrameworkLifecycleLock(framework, async () => {
      const mutations = [
        () => runInit({ 'root-dir': repo, provider: 'claude', yes: true }),
        () => runInstallFramework({ 'framework-dir': framework, provider: 'claude', version: '5.0.0', 'no-swap': true }),
        () => runSwapCurrent({ 'framework-dir': framework, version: '5.0.0' }),
        () => runAssemble({ 'framework-dir': framework, workspace: repo, 'code-root': repo, provider: 'claude', version: '5.0.0' }),
      ]
      for (const mutation of mutations) await expect(mutation()).rejects.toThrow('Another Core installation')
      expect(readFileSync(path.join(repo, '.specrails', 'specrails-version'), 'utf8')).toBe('4.0.0')
      expect(existsSync(path.join(framework, 'current'))).toBe(false)
    })
  })
})

describe('copied provider inventory', () => {
  it('discovers all copied providers recorded in the manifest and retains their role selections', () => {
    file(path.join(repo, '.specrails', 'specrails-manifest.json'), JSON.stringify({ providers: ['claude', 'codex', 'gemini', 'kimi'] }))
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      const dir = provider === 'kimi' ? '.kimi-code' : '.' + provider
      for (const role of ['sr-architect', 'sr-developer', 'sr-reviewer']) {
        file(path.join(repo, dir, ...(provider === 'codex' ? ['skills', 'rails', role, 'SKILL.md'] : provider === 'kimi' ? ['skills', role, 'SKILL.md'] : ['agents', role + '.md'])), 'role')
      }
    }
    expect(Object.keys(snapshotWorkspaceProviderSelections(repo))).toEqual(['claude', 'codex', 'gemini', 'kimi'])
    for (const roles of Object.values(snapshotWorkspaceProviderSelections(repo))) expect(roles).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'])
  })

  it('recognizes legacy copies without inventory but does not enroll a user-only provider directory', () => {
    for (const role of ['sr-architect', 'sr-developer', 'sr-reviewer']) file(path.join(repo, '.claude', 'agents', role + '.md'), 'role')
    file(path.join(repo, '.gemini', 'agents', 'custom-user.md'), 'custom')
    expect(snapshotWorkspaceProviderSelections(repo)).toEqual({ claude: ['sr-architect', 'sr-developer', 'sr-reviewer'] })
  })
})
