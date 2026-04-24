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

function setupRichFakeSource(scriptDir: string): void {
  // Agents (incl. VPC-dependent + reviewer for explanations dir)
  writeFileLf(
    path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'),
    '# arch\nproject: {{PROJECT_NAME}}\nmemory: {{MEMORY_PATH}}\n',
  )
  writeFileLf(
    path.join(scriptDir, 'templates', 'agents', 'sr-developer.md'),
    '# dev\nmemory: {{MEMORY_PATH}}\n',
  )
  writeFileLf(
    path.join(scriptDir, 'templates', 'agents', 'sr-reviewer.md'),
    '# reviewer\nmemory: {{MEMORY_PATH}}\nsecurity: {{SECURITY_EXEMPTIONS_PATH}}\n',
  )
  writeFileLf(
    path.join(scriptDir, 'templates', 'agents', 'sr-product-manager.md'),
    '# product manager\nneeds-enrich: true\npersonas: {{PERSONA_DIR}}\n',
  )
  writeFileLf(
    path.join(scriptDir, 'templates', 'agents', 'sr-product-analyst.md'),
    '# product analyst\nneeds-enrich: true\n',
  )
  writeFileLf(
    path.join(scriptDir, 'templates', 'agents', 'sr-merge-resolver.md'),
    '# merge resolver\nmemory: {{MEMORY_PATH}}\n',
  )

  // Commands (incl. product/merge/team variants so we can assert
  // dependency-driven exclusion).
  const cmds = [
    ['implement.md', '/specrails:implement\nmemory: {{MEMORY_PATH}}\n'],
    ['why.md', '/specrails:why'],
    ['auto-propose-backlog-specs.md', '/specrails:auto-propose-backlog-specs'],
    ['get-backlog-specs.md', '/specrails:get-backlog-specs'],
    ['vpc-drift.md', '/specrails:vpc-drift'],
    ['merge-resolve.md', '/specrails:merge-resolve'],
    ['team-debug.md', '/specrails:team-debug'],
    ['team-review.md', '/specrails:team-review'],
    ['unknown-ph.md', 'raw {{UNKNOWN_PLACEHOLDER}} trailing'],
  ] as const
  for (const [name, content] of cmds) {
    writeFileLf(path.join(scriptDir, 'templates', 'commands', 'specrails', name), content)
  }

  writeFileLf(
    path.join(scriptDir, 'templates', 'rules', 'general.md'),
    '# rules for {{PROJECT_NAME}}\n',
  )

  writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
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

    describe('quick tier — VPC exclusion + placeholders + command deps', () => {
      it('excludes VPC-dependent agents (sr-product-*)', () => {
        const scriptDir = path.join(tmpDir, 'core')
        const repoRoot = path.join(tmpDir, 'repo')
        setupRichFakeSource(scriptDir)

        scaffoldInstallation({
          scriptDir,
          repoRoot,
          provider: 'claude',
          providerDir: '.claude',
          agentTeams: false,
          tier: 'quick',
        })

        const agentsDir = path.join(repoRoot, '.claude', 'agents')
        expect(pathExists(path.join(agentsDir, 'sr-architect.md'))).toBe(true)
        expect(pathExists(path.join(agentsDir, 'sr-developer.md'))).toBe(true)
        expect(pathExists(path.join(agentsDir, 'sr-reviewer.md'))).toBe(true)
        expect(pathExists(path.join(agentsDir, 'sr-merge-resolver.md'))).toBe(true)
        expect(pathExists(path.join(agentsDir, 'sr-product-manager.md'))).toBe(false)
        expect(pathExists(path.join(agentsDir, 'sr-product-analyst.md'))).toBe(false)
      })

      it('substitutes every documented placeholder', () => {
        const scriptDir = path.join(tmpDir, 'core')
        const repoRoot = path.join(tmpDir, 'repo')
        setupRichFakeSource(scriptDir)

        scaffoldInstallation({
          scriptDir,
          repoRoot,
          provider: 'claude',
          providerDir: '.claude',
          agentTeams: false,
          tier: 'quick',
        })

        const projectName = path.basename(repoRoot)
        const archContent = readTextFile(path.join(repoRoot, '.claude', 'agents', 'sr-architect.md'))
        expect(archContent).toContain(`project: ${projectName}`)
        expect(archContent).toContain('memory: .claude/agent-memory/sr-architect/')
        expect(archContent).not.toContain('{{PROJECT_NAME}}')
        expect(archContent).not.toContain('{{MEMORY_PATH}}')

        const reviewer = readTextFile(path.join(repoRoot, '.claude', 'agents', 'sr-reviewer.md'))
        expect(reviewer).toContain('security: .claude/security-exemptions.yaml')
      })

      it('strips unknown {{PLACEHOLDER}} tokens rather than leaving them raw', () => {
        const scriptDir = path.join(tmpDir, 'core')
        const repoRoot = path.join(tmpDir, 'repo')
        setupRichFakeSource(scriptDir)

        scaffoldInstallation({
          scriptDir,
          repoRoot,
          provider: 'claude',
          providerDir: '.claude',
          agentTeams: false,
          tier: 'quick',
        })

        const cmd = readTextFile(path.join(repoRoot, '.claude', 'commands', 'specrails', 'unknown-ph.md'))
        expect(cmd).toBe('raw  trailing')
      })

      it('excludes commands whose required agents were excluded', () => {
        const scriptDir = path.join(tmpDir, 'core')
        const repoRoot = path.join(tmpDir, 'repo')
        setupRichFakeSource(scriptDir)

        scaffoldInstallation({
          scriptDir,
          repoRoot,
          provider: 'claude',
          providerDir: '.claude',
          agentTeams: false,
          tier: 'quick',
        })

        const cmdsDir = path.join(repoRoot, '.claude', 'commands', 'specrails')
        // Product-manager gone → auto-propose-backlog-specs + vpc-drift gone
        expect(pathExists(path.join(cmdsDir, 'auto-propose-backlog-specs.md'))).toBe(false)
        expect(pathExists(path.join(cmdsDir, 'vpc-drift.md'))).toBe(false)
        // Product-analyst gone → get-backlog-specs gone
        expect(pathExists(path.join(cmdsDir, 'get-backlog-specs.md'))).toBe(false)
        // Merge-resolver IS installed → merge-resolve stays
        expect(pathExists(path.join(cmdsDir, 'merge-resolve.md'))).toBe(true)
        // Unrelated commands stay
        expect(pathExists(path.join(cmdsDir, 'implement.md'))).toBe(true)
        expect(pathExists(path.join(cmdsDir, 'why.md'))).toBe(true)
      })

      it('excludes team-* commands unless agentTeams is true', () => {
        const scriptDir = path.join(tmpDir, 'core')
        const repoRoot = path.join(tmpDir, 'repo')
        setupRichFakeSource(scriptDir)

        scaffoldInstallation({
          scriptDir,
          repoRoot,
          provider: 'claude',
          providerDir: '.claude',
          agentTeams: false,
          tier: 'quick',
        })

        const cmdsDir = path.join(repoRoot, '.claude', 'commands', 'specrails')
        expect(pathExists(path.join(cmdsDir, 'team-debug.md'))).toBe(false)
        expect(pathExists(path.join(cmdsDir, 'team-review.md'))).toBe(false)
      })

      it('includes team-* commands when agentTeams is true', () => {
        const scriptDir = path.join(tmpDir, 'core')
        const repoRoot = path.join(tmpDir, 'repo')
        setupRichFakeSource(scriptDir)

        scaffoldInstallation({
          scriptDir,
          repoRoot,
          provider: 'claude',
          providerDir: '.claude',
          agentTeams: true,
          tier: 'quick',
        })

        const cmdsDir = path.join(repoRoot, '.claude', 'commands', 'specrails')
        expect(pathExists(path.join(cmdsDir, 'team-debug.md'))).toBe(true)
        expect(pathExists(path.join(cmdsDir, 'team-review.md'))).toBe(true)
      })

      it('creates per-agent memory directories + shared explanations dir when an arch/reviewer ships', () => {
        const scriptDir = path.join(tmpDir, 'core')
        const repoRoot = path.join(tmpDir, 'repo')
        setupRichFakeSource(scriptDir)

        scaffoldInstallation({
          scriptDir,
          repoRoot,
          provider: 'claude',
          providerDir: '.claude',
          agentTeams: false,
          tier: 'quick',
        })

        const memRoot = path.join(repoRoot, '.claude', 'agent-memory')
        expect(isDir(path.join(memRoot, 'sr-architect'))).toBe(true)
        expect(isDir(path.join(memRoot, 'sr-developer'))).toBe(true)
        expect(isDir(path.join(memRoot, 'sr-reviewer'))).toBe(true)
        expect(isDir(path.join(memRoot, 'explanations'))).toBe(true)
      })
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
