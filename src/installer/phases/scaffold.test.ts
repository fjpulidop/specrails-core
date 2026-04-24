import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isDir, pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import { detectExistingSetup, scaffoldInstallation } from './scaffold.js'

function setupFakeSource(scriptDir: string): void {
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'), 'arch')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-developer.md'), 'dev')
  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), 'rules')
  writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
  writeFileLf(path.join(scriptDir, 'commands', 'team-review.md'), 'team review')
  writeFileLf(path.join(scriptDir, 'commands', 'team-debug.md'), 'team debug')
}

describe('scaffold', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-scaffold-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('detectExistingSetup', () => {
    it('returns false on a clean repo', () => {
      expect(
        detectExistingSetup({ repoRoot: tmpDir, providerDir: '.claude' }),
      ).toBe(false)
    })

    it('returns true when .claude/agents/ has content', () => {
      writeFileLf(path.join(tmpDir, '.claude', 'agents', 'foo.md'), '')
      expect(
        detectExistingSetup({ repoRoot: tmpDir, providerDir: '.claude' }),
      ).toBe(true)
    })

    it('returns true when openspec/ exists with content', () => {
      writeFileLf(path.join(tmpDir, 'openspec', 'specs', 'x.md'), '')
      expect(
        detectExistingSetup({ repoRoot: tmpDir, providerDir: '.claude' }),
      ).toBe(true)
    })
  })

  describe('scaffoldInstallation', () => {
    it('creates the provider + setup-templates skeleton', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakeSource(scriptDir)

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'claude',
        providerDir: '.claude',
        agentTeams: false,
        tier: 'full',
      })

      expect(isDir(path.join(repoRoot, '.claude', 'commands', 'specrails'))).toBe(true)
      expect(isDir(path.join(repoRoot, '.specrails', 'setup-templates', 'agents'))).toBe(true)
      expect(isDir(path.join(repoRoot, '.specrails', 'setup-templates', 'rules'))).toBe(true)
    })

    it('copies templates into setup-templates/', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakeSource(scriptDir)

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'claude',
        providerDir: '.claude',
        agentTeams: false,
        tier: 'full',
      })

      const copied = path.join(
        repoRoot,
        '.specrails',
        'setup-templates',
        'agents',
        'sr-architect.md',
      )
      expect(pathExists(copied)).toBe(true)
    })

    it('writes bundled enrich + doctor into <provider>/commands/specrails/', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakeSource(scriptDir)

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'claude',
        providerDir: '.claude',
        agentTeams: false,
        tier: 'full',
      })

      const dest = path.join(repoRoot, '.claude', 'commands', 'specrails')
      expect(pathExists(path.join(dest, 'enrich.md'))).toBe(true)
      expect(pathExists(path.join(dest, 'doctor.md'))).toBe(true)
    })

    it('skips team-* commands when agentTeams=false', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakeSource(scriptDir)

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'claude',
        providerDir: '.claude',
        agentTeams: false,
        tier: 'full',
      })

      const dest = path.join(repoRoot, '.claude', 'commands', 'specrails')
      expect(pathExists(path.join(dest, 'team-review.md'))).toBe(false)
      expect(pathExists(path.join(dest, 'team-debug.md'))).toBe(false)
    })

    it('includes team-* commands when agentTeams=true', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakeSource(scriptDir)

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'claude',
        providerDir: '.claude',
        agentTeams: true,
        tier: 'full',
      })

      const dest = path.join(repoRoot, '.claude', 'commands', 'specrails')
      expect(pathExists(path.join(dest, 'team-review.md'))).toBe(true)
      expect(pathExists(path.join(dest, 'team-debug.md'))).toBe(true)
    })

    it('quick tier places agents + rules directly under <providerDir>', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakeSource(scriptDir)

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'claude',
        providerDir: '.claude',
        agentTeams: false,
        tier: 'quick',
      })

      expect(pathExists(path.join(repoRoot, '.claude', 'agents', 'sr-architect.md'))).toBe(true)
      expect(pathExists(path.join(repoRoot, '.claude', 'rules', 'general.md'))).toBe(true)
    })

    it('adds entries to .gitignore without duplicating existing lines', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakeSource(scriptDir)
      writeFileLf(path.join(repoRoot, '.gitignore'), '.specrails/\nnode_modules/\n')

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'claude',
        providerDir: '.claude',
        agentTeams: false,
        tier: 'full',
      })

      const contents = readTextFile(path.join(repoRoot, '.gitignore'))
      const count = (contents.match(/\.specrails\/\n/g) || []).length
      expect(count).toBe(1)
      expect(contents).toContain('.claude/agent-memory/')
    })

    it('codex provider places enrich/doctor as Agent Skills', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakeSource(scriptDir)

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'codex',
        providerDir: '.codex',
        agentTeams: false,
        tier: 'full',
      })

      expect(pathExists(path.join(repoRoot, '.agents', 'skills', 'enrich', 'SKILL.md'))).toBe(true)
      expect(pathExists(path.join(repoRoot, '.agents', 'skills', 'doctor', 'SKILL.md'))).toBe(true)
    })
  })
})
