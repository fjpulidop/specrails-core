import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isDir, isSymlink, pathExists, readTextFile, realpathSafe, writeFileLf } from '../util/fs.js'
import { main } from '../cli.js'
import { runAssemble, runInstallFramework, runSwapCurrent, readPackageVersion } from './framework.js'

/**
 * Command-level tests for the offline framework subcommands
 * (`install-framework` / `assemble`). They drive the same code path the desktop
 * bundled-core shell-out uses (`node dist/installer/cli.js install-framework …`)
 * and assert the framework is materialized + the workspace is SYMLINKED with NO
 * network and NO openspec init.
 *
 * Platform-aware: on Windows a per-FILE agent link is a COPY (not a symlink) and
 * a whole-DIR link is a junction (still reported as a symlink by lstat). So the
 * agent-file check verifies placement + content; the dir-link check verifies it
 * resolves into the framework. POSIX-only symlink assertions stay guarded.
 */

const IS_WIN = process.platform === 'win32'

function setupFakeScriptDir(scriptDir: string): void {
  writeFileLf(path.join(scriptDir, 'package.json'), `${JSON.stringify({ version: '5.0.0' })}\n`)
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'), '# arch\n')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-developer.md'), '# dev\n')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-reviewer.md'), '# reviewer\n')
  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), '# rules\n')
  writeFileLf(
    path.join(scriptDir, 'templates', 'commands', 'specrails', 'implement.md'),
    '/specrails:implement\n',
  )
  writeFileLf(
    path.join(scriptDir, 'templates', 'kimi', 'specrails', 'run-skill.mjs'),
    '// managed Kimi runner fixture\n',
  )
  writeFileLf(
    path.join(
      scriptDir,
      'templates',
      'kimi',
      'specrails',
      'vendor',
      'js-yaml',
      'js-yaml.mjs',
    ),
    '// vendored js-yaml fixture\n',
  )
  writeFileLf(
    path.join(
      scriptDir,
      'templates',
      'kimi',
      'specrails',
      'vendor',
      'js-yaml',
      'LICENSE',
    ),
    'fixture license\n',
  )
  writeFileLf(
    path.join(
      scriptDir,
      'templates',
      'kimi',
      'specrails',
      'vendor',
      'js-yaml',
      'NOTICE.md',
    ),
    'fixture notice\n',
  )
  writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
}

describe('framework subcommands (install-framework / assemble)', () => {
  let tmpDir: string
  let scriptDir: string
  let fwDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined
  let originalScriptDirOverride: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-fw-cmd-test-'))
    scriptDir = path.join(tmpDir, 'core')
    fwDir = path.join(tmpDir, 'framework')
    setupFakeScriptDir(scriptDir)
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalScriptDirOverride = process.env.SPECRAILS_CORE_SCRIPT_DIR
    const fakeHome = path.join(tmpDir, 'fake-home')
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    // Point the framework commands at the fake package dir.
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    if (originalScriptDirOverride === undefined) delete process.env.SPECRAILS_CORE_SCRIPT_DIR
    else process.env.SPECRAILS_CORE_SCRIPT_DIR = originalScriptDirOverride
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  describe('runInstallFramework', () => {
    it('materializes the framework and points current at the version', async () => {
      const out = await runInstallFramework({
        'framework-dir': fwDir,
        provider: 'claude',
        version: '5.0.0',
      })
      expect(out.providerDir).toBe('.claude')
      const fwClaude = path.join(fwDir, '5.0.0', '.claude')
      expect(isDir(path.join(fwClaude, 'agents'))).toBe(true)
      expect(pathExists(path.join(fwClaude, 'agents', 'sr-architect.md'))).toBe(true)
      // current → 5.0.0. `current` is a dir link (symlink on POSIX, junction on
      // Windows); assert it RESOLVES to the version dir (holds for both kinds),
      // keep the stronger symlink check POSIX-only.
      expect(realpathSafe(path.join(fwDir, 'current'))).toBe(realpathSafe(path.join(fwDir, '5.0.0')))
      if (!IS_WIN) expect(isSymlink(path.join(fwDir, 'current'))).toBe(true)
      expect(isDir(path.join(fwDir, 'current', '.claude', 'agents'))).toBe(true)
    })

    it('is idempotent — a second call does not throw and keeps the framework', async () => {
      await runInstallFramework({ 'framework-dir': fwDir, provider: 'claude', version: '5.0.0' })
      await runInstallFramework({ 'framework-dir': fwDir, provider: 'claude', version: '5.0.0' })
      expect(isDir(path.join(fwDir, '5.0.0', '.claude', 'agents'))).toBe(true)
    })

    it('rejects a missing --framework-dir', async () => {
      await expect(
        runInstallFramework({ provider: 'claude', version: '5.0.0' }),
      ).rejects.toThrow(/framework-dir is required/)
    })

    it('rejects an invalid provider', async () => {
      await expect(
        runInstallFramework({ 'framework-dir': fwDir, provider: 'bogus', version: '5.0.0' }),
      ).rejects.toThrow(/provider value must be/)
    })

    it.each([
      ['dot segment', '.'],
      ['parent dot segment', '..'],
      ['traversal', '../victim'],
      ['POSIX separator', '5.0.0/child'],
      ['Windows separator', '5.0.0\\child'],
      ['NUL', '5.0.0\0child'],
    ])('rejects an unsafe --version (%s)', async (label, version) => {
      await expect(
        runInstallFramework({
          'framework-dir': fwDir,
          provider: 'claude',
          version,
        }),
      ).rejects.toThrow(/safe framework version identifier/)
      if (label === 'traversal') {
        expect(pathExists(path.join(tmpDir, 'victim'))).toBe(false)
      }
    })

    it('accepts a safe semver prerelease with build metadata', async () => {
      const version = '5.0.0-beta.1+build.7'
      const out = await runInstallFramework({
        'framework-dir': fwDir,
        provider: 'claude',
        version,
      })
      expect(out.version).toBe(version)
      expect(isDir(path.join(fwDir, version, '.claude', 'agents'))).toBe(true)
    })
  })

  describe('runAssemble', () => {
    it('symlinks the framework subtrees into the workspace and seeds the project layer', async () => {
      await runInstallFramework({ 'framework-dir': fwDir, provider: 'claude', version: '5.0.0' })

      const workspace = path.join(tmpDir, 'ws')
      const codeRoot = path.join(tmpDir, 'repo')
      writeFileLf(path.join(codeRoot, 'README.md'), '# repo')

      const out = await runAssemble({
        workspace,
        'framework-dir': fwDir,
        provider: 'claude',
        version: '5.0.0',
        'code-root': codeRoot,
      })
      expect(out.providerDir).toBe('.claude')

      // agents/ is a real dir holding per-file links into the framework (symlink
      // on POSIX, copy on Windows). Assert placement + content (holds for both);
      // the stronger symlink check is POSIX-only.
      const wsAgents = path.join(workspace, '.claude', 'agents')
      expect(isDir(wsAgents)).toBe(true)
      const wsArch = path.join(wsAgents, 'sr-architect.md')
      const fwArch = path.join(fwDir, 'current', '.claude', 'agents', 'sr-architect.md')
      expect(pathExists(wsArch)).toBe(true)
      expect(readTextFile(wsArch)).toBe(readTextFile(fwArch))
      if (!IS_WIN) expect(isSymlink(wsArch)).toBe(true)
      // commands/ is a whole-dir link (symlink on POSIX, junction on Windows) →
      // resolves into the framework on both.
      expect(realpathSafe(path.join(workspace, '.claude', 'commands'))).toBe(
        realpathSafe(path.join(fwDir, 'current', '.claude', 'commands')),
      )
      // agent-memory is a REAL writable dir, never linked.
      const memDir = path.join(workspace, '.claude', 'agent-memory', 'sr-architect')
      expect(isDir(memDir)).toBe(true)
      expect(isSymlink(memDir)).toBe(false)
      // The version marker the gate checks for is written.
      expect(pathExists(path.join(workspace, '.specrails', 'specrails-version'))).toBe(true)
    })

    it('fails when the framework was not materialized first', async () => {
      const workspace = path.join(tmpDir, 'ws')
      const codeRoot = path.join(tmpDir, 'repo')
      await expect(
        runAssemble({
          workspace,
          'framework-dir': fwDir,
          provider: 'claude',
          version: '5.0.0',
          'code-root': codeRoot,
        }),
      ).rejects.toThrow(/not materialized/)
    })

    it('rejects a missing --workspace', async () => {
      await expect(
        runAssemble({ 'framework-dir': fwDir, provider: 'claude', version: '5.0.0', 'code-root': tmpDir }),
      ).rejects.toThrow(/workspace is required/)
    })

    it('rejects an unsafe --version before resolving framework content', async () => {
      await expect(
        runAssemble({
          workspace: path.join(tmpDir, 'ws-unsafe-version'),
          'framework-dir': fwDir,
          provider: 'claude',
          version: '../victim',
          'code-root': tmpDir,
        }),
      ).rejects.toThrow(/safe framework version identifier/)
    })
  })

  describe('--no-swap + swap-current (multi-provider materialize-all-then-swap-once)', () => {
    it('install-framework --no-swap materializes without swapping; swap-current finalises', async () => {
      // Existing version + current pointed at it.
      await runInstallFramework({ 'framework-dir': fwDir, provider: 'claude', version: '5.0.0' })
      const before = realpathSafe(path.join(fwDir, 'current'))

      // Materialize a new version with --no-swap → current stays put.
      const out = await runInstallFramework({
        'framework-dir': fwDir, provider: 'claude', version: '6.0.0', 'no-swap': true,
      })
      expect(out.swapped).toBe(false)
      expect(realpathSafe(path.join(fwDir, 'current'))).toBe(before) // unchanged
      expect(isDir(path.join(fwDir, '6.0.0', '.claude', 'agents'))).toBe(true)

      // The single explicit swap makes 6.0.0 visible.
      const swapOut = await runSwapCurrent({ 'framework-dir': fwDir, version: '6.0.0' })
      expect(swapOut.version).toBe('6.0.0')
      expect(realpathSafe(path.join(fwDir, 'current'))).toBe(realpathSafe(path.join(fwDir, '6.0.0')))
    })

    it('default install-framework still swaps current (single-provider init unchanged)', async () => {
      const out = await runInstallFramework({ 'framework-dir': fwDir, provider: 'claude', version: '5.0.0' })
      expect(out.swapped).toBe(true)
      expect(realpathSafe(path.join(fwDir, 'current'))).toBe(realpathSafe(path.join(fwDir, '5.0.0')))
    })

    it('swap-current rejects a missing --framework-dir', async () => {
      await expect(runSwapCurrent({ version: '5.0.0' })).rejects.toThrow(/framework-dir is required/)
    })

    it('swap-current rejects an unsafe --version before registry resolution', async () => {
      await expect(
        runSwapCurrent({ 'framework-dir': fwDir, version: '..\\victim' }),
      ).rejects.toThrow(/safe framework version identifier/)
    })

    it('swap-current rejects a nonexistent version without moving current', async () => {
      await runInstallFramework({
        'framework-dir': fwDir,
        provider: 'claude',
        version: '5.0.0',
      })
      const before = realpathSafe(path.join(fwDir, 'current'))

      await expect(
        runSwapCurrent({ 'framework-dir': fwDir, version: 'does-not-exist' }),
      ).rejects.toThrow(/is not materialized/)
      expect(realpathSafe(path.join(fwDir, 'current'))).toBe(before)
    })

    it('swap-current rejects a target missing a provider served by current', async () => {
      await runInstallFramework({
        'framework-dir': fwDir,
        provider: 'claude',
        version: '4.11.0',
      })
      const before = realpathSafe(path.join(fwDir, 'current'))

      // Only Kimi is present in the destination. The current Claude framework
      // still has live consumers, so exposing this target would break them.
      await runInstallFramework({
        'framework-dir': fwDir,
        provider: 'kimi',
        version: '4.12.0',
        'no-swap': true,
      })
      await expect(
        runSwapCurrent({
          'framework-dir': fwDir,
          version: '4.12.0',
          providers: 'claude,kimi',
        }),
      ).rejects.toThrow(/incomplete.*claude: missing \.claude\//)
      expect(realpathSafe(path.join(fwDir, 'current'))).toBe(before)
    })

    it('swap-current rejects corrupt managed content even when the stamp exists', async () => {
      await runInstallFramework({
        'framework-dir': fwDir,
        provider: 'claude',
        version: '4.12.0',
        'no-swap': true,
      })
      writeFileLf(
        path.join(fwDir, '4.12.0', '.claude', 'agents', 'sr-architect.md'),
        'corrupt after materialize\n',
      )

      await expect(
        runSwapCurrent({
          'framework-dir': fwDir,
          version: '4.12.0',
          providers: 'claude',
        }),
      ).rejects.toThrow(/managed content does not match stamp/)
      expect(pathExists(path.join(fwDir, 'current'))).toBe(false)
    })
  })

  describe('cli.main dispatch', () => {
    it('routes install-framework + assemble through main() with exit 0', async () => {
      const ifCode = await main([
        'install-framework',
        '--framework-dir',
        fwDir,
        '--provider',
        'claude',
        '--version',
        '5.0.0',
      ])
      expect(ifCode).toBe(0)

      const workspace = path.join(tmpDir, 'ws2')
      const codeRoot = path.join(tmpDir, 'repo2')
      writeFileLf(path.join(codeRoot, 'README.md'), '# repo')
      const asmCode = await main([
        'assemble',
        '--workspace',
        workspace,
        '--framework-dir',
        fwDir,
        '--provider',
        'claude',
        '--version',
        '5.0.0',
        '--code-root',
        codeRoot,
      ])
      expect(asmCode).toBe(0)
      expect(isDir(path.join(workspace, '.claude', 'agents'))).toBe(true)
    })

    it('routes install-framework --no-swap then swap-current through main()', async () => {
      const ifCode = await main([
        'install-framework', '--framework-dir', fwDir, '--provider', 'claude', '--version', '5.0.0', '--no-swap',
      ])
      expect(ifCode).toBe(0)
      // --no-swap means current was NOT created yet.
      expect(pathExists(path.join(fwDir, 'current'))).toBe(false)

      const swapCode = await main(['swap-current', '--framework-dir', fwDir, '--version', '5.0.0'])
      expect(swapCode).toBe(0)
      expect(realpathSafe(path.join(fwDir, 'current'))).toBe(realpathSafe(path.join(fwDir, '5.0.0')))
    })

    it('returns non-zero exit when a required flag is missing', async () => {
      const code = await main(['install-framework', '--provider', 'claude', '--version', '5.0.0'])
      expect(code).toBe(40)
    })
  })

  describe('readPackageVersion', () => {
    it('reads the package version from the script dir', () => {
      expect(readPackageVersion(scriptDir)).toBe('5.0.0')
    })

    it('returns unknown for a dir without package.json', () => {
      expect(readPackageVersion(path.join(tmpDir, 'nope'))).toBe('unknown')
    })
  })
})
