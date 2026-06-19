import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PrerequisiteError } from '../util/errors.js'
import { mkdirp, pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import { resolveArtifacts } from '../util/registry.js'
import { runUpdate } from './update.js'

async function setupFakeScriptDir(scriptDir: string, version: string): Promise<void> {
  writeFileLf(path.join(scriptDir, 'package.json'), `${JSON.stringify({ version })}\n`)
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'), 'v2-arch')
  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), 'v2-rules')
  writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
}

describe('runUpdate', () => {
  let tmpDir: string
  let registryHome: string
  let prevCwd: string
  let prevScriptDirOverride: string | undefined
  let prevRegistryHome: string | undefined

  /** Resolve the relocated artifact workspace for a repo (allocate so update finds it). */
  function workspaceFor(repoRoot: string): string {
    return resolveArtifacts(repoRoot, {
      allocate: true,
      home: registryHome,
      providers: ['claude'],
    }).artifactRoot
  }

  /**
   * Simulate a prior relocate-always install: allocate the registry entry and
   * write the marker + manifest into the resolved WORKSPACE (not the repo).
   */
  async function simulateExistingInstall(repoRoot: string, version: string): Promise<void> {
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    const ws = workspaceFor(repoRoot)
    writeFileLf(path.join(ws, '.specrails', 'specrails-version'), `${version}\n`)
    writeFileLf(
      path.join(ws, '.specrails', 'specrails-manifest.json'),
      JSON.stringify({ version, installed_at: '2026-01-01T00:00:00Z', artifacts: {} }, null, 2),
    )
    mkdirp(path.join(ws, '.claude', 'commands', 'specrails'))
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-update-test-'))
    registryHome = mkdtempSync(path.join(os.tmpdir(), 'specrails-update-home-'))
    prevCwd = process.cwd()
    prevScriptDirOverride = process.env.SPECRAILS_CORE_SCRIPT_DIR
    prevRegistryHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = registryHome
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevScriptDirOverride === undefined) delete process.env.SPECRAILS_CORE_SCRIPT_DIR
    else process.env.SPECRAILS_CORE_SCRIPT_DIR = prevScriptDirOverride
    if (prevRegistryHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = prevRegistryHome
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(registryHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('refuses to run when no prior install is present', async () => {
    const repoRoot = path.join(tmpDir, 'repo')
    mkdirp(repoRoot)
    await expect(
      runUpdate({ 'root-dir': repoRoot }),
    ).rejects.toBeInstanceOf(PrerequisiteError)
  })

  it('reports previous version and bumps to current version', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    await simulateExistingInstall(repoRoot, '4.2.0')
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    const result = await runUpdate({ 'root-dir': repoRoot })
    expect(result.previousVersion).toBe('4.2.0')
    expect(result.currentVersion).toBe('5.0.0')
    expect(result.provider).toBe('claude')

    // specrails-version file was rewritten to the new version (in the workspace).
    const ws = workspaceFor(repoRoot)
    const newVersion = readTextFile(path.join(ws, '.specrails', 'specrails-version')).trim()
    expect(newVersion).toBe('5.0.0')
  })

  it('--dry-run does not write files', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    await simulateExistingInstall(repoRoot, '4.2.0')
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    const result = await runUpdate({ 'root-dir': repoRoot, 'dry-run': true })
    expect(result.dryRun).toBe(true)

    // specrails-version file is unchanged (in the workspace).
    const ws = workspaceFor(repoRoot)
    const stillOld = readTextFile(path.join(ws, '.specrails', 'specrails-version')).trim()
    expect(stillOld).toBe('4.2.0')
  })

  it('preserves reserved paths (profiles + custom-* agents)', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    await simulateExistingInstall(repoRoot, '4.2.0')
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    // Reserved regions live under the relocated workspace now.
    const ws = workspaceFor(repoRoot)
    writeFileLf(
      path.join(ws, '.specrails', 'profiles', 'team.json'),
      '{"name":"team-profile"}',
    )
    writeFileLf(
      path.join(ws, '.claude', 'agents', 'custom-reviewer.md'),
      'custom reviewer content',
    )

    await runUpdate({ 'root-dir': repoRoot })

    // Reserved files remain byte-identical.
    expect(
      readTextFile(path.join(ws, '.specrails', 'profiles', 'team.json')),
    ).toBe('{"name":"team-profile"}')
    expect(
      readTextFile(path.join(ws, '.claude', 'agents', 'custom-reviewer.md')),
    ).toBe('custom reviewer content')
  })

  describe('install-config.yaml is honoured on update', () => {
    it('reads tier=quick from install-config.yaml and re-applies quick-tier placement', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      writeFileLf(
        path.join(repoRoot, '.specrails', 'install-config.yaml'),
        [
          'version: 1',
          'provider: claude',
          'tier: quick',
          'agents:',
          '  selected: [sr-architect, sr-developer]',
          '',
        ].join('\n'),
      )
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot })
      expect(result.tier).toBe('quick')
      // Quick-tier placement happened: bundled agents are in <ws>/.claude/agents/
      // (not just under setup-templates/).
      const ws = workspaceFor(repoRoot)
      expect(pathExists(path.join(ws, '.claude', 'agents', 'sr-architect.md'))).toBe(true)
    })

    it('falls back to tier=full when no install-config.yaml exists', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot })
      expect(result.tier).toBe('full')
    })
  })

  describe('--provider override (multi-provider)', () => {
    it('updates the FORCED provider even when .claude exists (auto-detect would pick claude)', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      // Multi-provider workspace: both .claude (created by simulateExistingInstall)
      // and .gemini are present. Auto-detection returns claude (.claude first).
      mkdirp(path.join(workspaceFor(repoRoot), '.gemini', 'commands', 'specrails'))
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot, provider: 'gemini' })
      expect(result.provider).toBe('gemini')
    })

    it('auto-detects (claude first) when --provider is omitted — backward compatible', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      mkdirp(path.join(workspaceFor(repoRoot), '.gemini', 'commands', 'specrails'))
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot })
      expect(result.provider).toBe('claude')
    })

    it('rejects an invalid --provider value', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      await expect(
        runUpdate({ 'root-dir': repoRoot, provider: 'bogus' }),
      ).rejects.toThrow(/--provider value must be 'claude', 'codex', or 'gemini'/)
    })
  })

  describe('--only flag', () => {
    it('defaults to scope=all when --only is omitted', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot })
      expect(result.scope).toBe('all')
    })

    it('--only=rules refreshes only the rules subtree', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot, only: 'rules' })
      expect(result.scope).toBe('rules')
      const ws = workspaceFor(repoRoot)
      // Rules staging is populated (under the workspace).
      expect(pathExists(path.join(ws, '.specrails', 'setup-templates', 'rules', 'general.md'))).toBe(true)
      // Manifest still bumped to current version.
      const manifest = JSON.parse(
        readTextFile(path.join(ws, '.specrails', 'specrails-manifest.json')),
      )
      expect(manifest.version).toBe('5.0.0')
    })

    it('--only=agents refreshes only the agents subtree', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot, only: 'agents' })
      expect(result.scope).toBe('agents')
      expect(pathExists(path.join(workspaceFor(repoRoot), '.specrails', 'setup-templates', 'agents', 'sr-architect.md'))).toBe(true)
    })

    it('--only=web-manager warns and exits without writing (deprecated)', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot, only: 'web-manager' })
      expect(result.scope).toBe('web-manager')
      // specrails-version unchanged (in the workspace).
      expect(readTextFile(path.join(workspaceFor(repoRoot), '.specrails', 'specrails-version')).trim()).toBe('4.2.0')
    })

    it('--only=core re-applies the full bundled template layer', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot, only: 'core' })
      expect(result.scope).toBe('core')
      // Bundled commands present (full scaffold ran) — under the workspace.
      expect(pathExists(path.join(workspaceFor(repoRoot), '.claude', 'commands', 'specrails', 'enrich.md'))).toBe(true)
    })

    it('unknown --only value falls back to scope=all with a warning', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot, only: 'bogus' })
      expect(result.scope).toBe('all')
    })
  })

  it('refreshes the manifest version to match the installed core', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    await simulateExistingInstall(repoRoot, '4.2.0')
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    await runUpdate({ 'root-dir': repoRoot })

    const ws = workspaceFor(repoRoot)
    const manifest = JSON.parse(
      readTextFile(path.join(ws, '.specrails', 'specrails-manifest.json')),
    )
    expect(manifest.version).toBe('5.0.0')
    // Artifacts map contains entries for bundled commands.
    expect(manifest.artifacts['commands/specrails/enrich.md']).toBeDefined()
    expect(pathExists(path.join(ws, '.claude', 'commands', 'specrails', 'enrich.md'))).toBe(
      true,
    )
  })
})
