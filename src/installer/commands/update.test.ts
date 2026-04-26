import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PrerequisiteError } from '../util/errors.js'
import { mkdirp, pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import { runUpdate } from './update.js'

async function setupFakeScriptDir(scriptDir: string, version: string): Promise<void> {
  writeFileLf(path.join(scriptDir, 'VERSION'), `${version}\n`)
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'), 'v2-arch')
  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), 'v2-rules')
  writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
}

async function simulateExistingInstall(repoRoot: string, version: string): Promise<void> {
  mkdirp(repoRoot)
  await initRepo(repoRoot)
  writeFileLf(path.join(repoRoot, '.specrails', 'specrails-version'), `${version}\n`)
  writeFileLf(
    path.join(repoRoot, '.specrails', 'specrails-manifest.json'),
    JSON.stringify({ version, installed_at: '2026-01-01T00:00:00Z', artifacts: {} }, null, 2),
  )
  mkdirp(path.join(repoRoot, '.claude', 'commands', 'specrails'))
}

describe('runUpdate', () => {
  let tmpDir: string
  let prevCwd: string
  let prevScriptDirOverride: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-update-test-'))
    prevCwd = process.cwd()
    prevScriptDirOverride = process.env.SPECRAILS_CORE_SCRIPT_DIR
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevScriptDirOverride === undefined) delete process.env.SPECRAILS_CORE_SCRIPT_DIR
    else process.env.SPECRAILS_CORE_SCRIPT_DIR = prevScriptDirOverride
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

    // specrails-version file was rewritten to the new version.
    const newVersion = readTextFile(path.join(repoRoot, '.specrails', 'specrails-version')).trim()
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

    // specrails-version file is unchanged.
    const stillOld = readTextFile(path.join(repoRoot, '.specrails', 'specrails-version')).trim()
    expect(stillOld).toBe('4.2.0')
  })

  it('preserves reserved paths (profiles + custom-* agents)', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    await simulateExistingInstall(repoRoot, '4.2.0')
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    writeFileLf(
      path.join(repoRoot, '.specrails', 'profiles', 'team.json'),
      '{"name":"team-profile"}',
    )
    writeFileLf(
      path.join(repoRoot, '.claude', 'agents', 'custom-reviewer.md'),
      'custom reviewer content',
    )

    await runUpdate({ 'root-dir': repoRoot })

    // Reserved files remain byte-identical.
    expect(
      readTextFile(path.join(repoRoot, '.specrails', 'profiles', 'team.json')),
    ).toBe('{"name":"team-profile"}')
    expect(
      readTextFile(path.join(repoRoot, '.claude', 'agents', 'custom-reviewer.md')),
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
      // Quick-tier placement happened: bundled agents are in .claude/agents/
      // (not just under setup-templates/).
      expect(pathExists(path.join(repoRoot, '.claude', 'agents', 'sr-architect.md'))).toBe(true)
    })

    it('reads agent_teams=true from install-config.yaml and keeps team-* commands', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      // Add team-* commands to the fake script source.
      writeFileLf(path.join(scriptDir, 'commands', 'team-debug.md'), 'team debug')
      writeFileLf(path.join(scriptDir, 'commands', 'team-review.md'), 'team review')
      await simulateExistingInstall(repoRoot, '4.2.0')
      writeFileLf(
        path.join(repoRoot, '.specrails', 'install-config.yaml'),
        [
          'version: 1',
          'provider: claude',
          'agent_teams: true',
          'agents:',
          '  selected: [sr-architect]',
          '',
        ].join('\n'),
      )
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot })
      expect(result.agentTeams).toBe(true)
      const cmdsDir = path.join(repoRoot, '.claude', 'commands', 'specrails')
      expect(pathExists(path.join(cmdsDir, 'team-debug.md'))).toBe(true)
      expect(pathExists(path.join(cmdsDir, 'team-review.md'))).toBe(true)
    })

    it('--agent-teams flag wins over install-config.yaml when set', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      // Config says agent_teams off; flag forces on.
      writeFileLf(
        path.join(repoRoot, '.specrails', 'install-config.yaml'),
        [
          'version: 1',
          'provider: claude',
          'agent_teams: false',
          'agents:',
          '  selected: [sr-architect]',
          '',
        ].join('\n'),
      )
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot, 'agent-teams': true })
      expect(result.agentTeams).toBe(true)
    })

    it('falls back to tier=full + agent_teams=false when no install-config.yaml exists', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot })
      expect(result.tier).toBe('full')
      expect(result.agentTeams).toBe(false)
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
      // Rules staging is populated.
      expect(pathExists(path.join(repoRoot, '.specrails', 'setup-templates', 'rules', 'general.md'))).toBe(true)
      // Manifest still bumped to current version.
      const manifest = JSON.parse(
        readTextFile(path.join(repoRoot, '.specrails', 'specrails-manifest.json')),
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
      expect(pathExists(path.join(repoRoot, '.specrails', 'setup-templates', 'agents', 'sr-architect.md'))).toBe(true)
    })

    it('--only=web-manager warns and exits without writing (deprecated)', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot, only: 'web-manager' })
      expect(result.scope).toBe('web-manager')
      // specrails-version unchanged.
      expect(readTextFile(path.join(repoRoot, '.specrails', 'specrails-version')).trim()).toBe('4.2.0')
    })

    it('--only=core re-applies the full bundled template layer', async () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      await setupFakeScriptDir(scriptDir, '5.0.0')
      await simulateExistingInstall(repoRoot, '4.2.0')
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

      const result = await runUpdate({ 'root-dir': repoRoot, only: 'core' })
      expect(result.scope).toBe('core')
      // Bundled commands present (full scaffold ran).
      expect(pathExists(path.join(repoRoot, '.claude', 'commands', 'specrails', 'enrich.md'))).toBe(true)
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

    const manifest = JSON.parse(
      readTextFile(path.join(repoRoot, '.specrails', 'specrails-manifest.json')),
    )
    expect(manifest.version).toBe('5.0.0')
    // Artifacts map contains entries for bundled commands.
    expect(manifest.artifacts['commands/specrails/enrich.md']).toBeDefined()
    expect(pathExists(path.join(repoRoot, '.claude', 'commands', 'specrails', 'enrich.md'))).toBe(
      true,
    )
  })
})
