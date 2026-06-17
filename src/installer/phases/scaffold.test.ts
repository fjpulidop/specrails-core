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
  // Codex settings templates — fake content with placeholders the installer
  // substitutes.
  writeFileLf(
    path.join(scriptDir, 'templates', 'settings', 'codex-config.toml'),
    'model = "{{MODEL_NAME}}"\n',
  )
  writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
  writeFileLf(path.join(scriptDir, 'commands', 'setup.md'), 'legacy setup')
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
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

    function setupGeminiFakeSource(scriptDir: string): void {
      setupRichFakeSource(scriptDir)
      writeFileLf(
        path.join(scriptDir, 'templates', 'gemini-commands', 'implement.toml'),
        "description = \"Implementation Pipeline\"\nprompt = '''GEMINI_IMPLEMENT_SENTINEL invoke_agent sr-architect'''\n",
      )
      writeFileLf(
        path.join(scriptDir, 'templates', 'gemini-commands', 'batch-implement.toml'),
        "description = \"Batch\"\nprompt = '''GEMINI_BATCH_SENTINEL'''\n",
      )
      writeFileLf(
        path.join(scriptDir, 'templates', 'settings', 'gemini-settings.json'),
        '{\n  "experimental": { "enableAgents": true }\n}\n',
      )
    }

    function scaffoldGemini(scriptDir: string, repoRoot: string): void {
      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'gemini',
        providerDir: '.gemini',
        agentTeams: false,
        tier: 'quick',
      })
    }

    it('emits the gemini artifact tree (agents .md + commands .toml + settings + GEMINI.md)', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo-gemini')
      setupGeminiFakeSource(scriptDir)
      scaffoldGemini(scriptDir, repoRoot)

      // Agents: .gemini/agents/sr-*.md with gemini frontmatter (model + tools), no claude color/memory keys.
      const arch = readTextFile(path.join(repoRoot, '.gemini', 'agents', 'sr-architect.md'))
      expect(arch.startsWith('---\nname: sr-architect\n')).toBe(true)
      expect(arch).toContain('model: gemini-2.5-pro')
      expect(arch).toContain('tools: [read_file, write_file, run_shell_command, glob, search_file_content]')
      expect(isDir(path.join(repoRoot, '.gemini', 'agent-memory', 'sr-architect'))).toBe(true)
      expect(pathExists(path.join(repoRoot, '.gemini', 'agents', 'sr-developer.md'))).toBe(true)
      expect(pathExists(path.join(repoRoot, '.gemini', 'agents', 'sr-reviewer.md'))).toBe(true)
      // VPC-dependent agent excluded from the quick tier.
      expect(pathExists(path.join(repoRoot, '.gemini', 'agents', 'sr-product-manager.md'))).toBe(false)

      // Commands: hand-authored orchestrator override copied verbatim; others transformed to TOML.
      const impl = readTextFile(path.join(repoRoot, '.gemini', 'commands', 'specrails', 'implement.toml'))
      expect(impl).toContain('GEMINI_IMPLEMENT_SENTINEL')
      const why = readTextFile(path.join(repoRoot, '.gemini', 'commands', 'specrails', 'why.toml'))
      expect(why.startsWith('description = ')).toBe(true)
      expect(why).toContain("prompt = '''")
      expect(why).toContain('/specrails:why')

      // Settings + GEMINI.md.
      const settings = JSON.parse(readTextFile(path.join(repoRoot, '.gemini', 'settings.json')))
      expect(settings.experimental.enableAgents).toBe(true)
      const gmd = readTextFile(path.join(repoRoot, 'GEMINI.md'))
      expect(gmd).toContain('specrails-managed:start')
      expect(gmd).toContain('.gemini/')
      expect(gmd).toContain('.specrails/local-tickets.json')
      // No throw, no codex/claude leakage.
      expect(isDir(path.join(repoRoot, '.gemini', 'skills'))).toBe(false)
    })

    it('deep-merges .gemini/settings.json (preserves user keys) and upserts GEMINI.md', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo-gemini-merge')
      setupGeminiFakeSource(scriptDir)
      // Pre-seed a user settings.json + a user-authored GEMINI.md.
      writeFileLf(
        path.join(repoRoot, '.gemini', 'settings.json'),
        '{\n  "theme": "GitHub",\n  "experimental": { "vimMode": true }\n}\n',
      )
      writeFileLf(path.join(repoRoot, 'GEMINI.md'), '# My notes\nkeep this\n')

      scaffoldGemini(scriptDir, repoRoot)

      const settings = JSON.parse(readTextFile(path.join(repoRoot, '.gemini', 'settings.json')))
      expect(settings.theme).toBe('GitHub') // user key survives
      expect(settings.experimental.vimMode).toBe(true) // nested user key survives
      expect(settings.experimental.enableAgents).toBe(true) // ours added
      const gmd = readTextFile(path.join(repoRoot, 'GEMINI.md'))
      expect(gmd).toContain('# My notes') // user content preserved
      expect(gmd).toContain('keep this')
      expect(gmd).toContain('specrails-managed:start') // managed block appended
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
      expect(pathExists(path.join(dest, 'setup.md'))).toBe(false)
    })

    it('prunes legacy setup aliases and shell artefacts during scaffold', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakeSource(scriptDir)
      writeFileLf(path.join(repoRoot, '.claude', 'commands', 'setup.md'), 'legacy')
      writeFileLf(path.join(repoRoot, '.claude', 'commands', 'specrails', 'setup.md'), 'legacy')
      writeFileLf(path.join(repoRoot, '.specrails', 'bin', 'doctor.sh'), '#!/bin/sh\n')
      writeFileLf(
        path.join(repoRoot, '.specrails', 'setup-templates', '.provider-detection.json'),
        '{}\n',
      )
      writeFileLf(
        path.join(repoRoot, '.specrails', 'setup-templates', 'settings', 'integration-contract.json'),
        '{}\n',
      )
      writeFileLf(path.join(repoRoot, '.specrails-version'), '4.0.0\n')

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'claude',
        providerDir: '.claude',
        agentTeams: false,
        tier: 'full',
      })

      expect(pathExists(path.join(repoRoot, '.claude', 'commands', 'setup.md'))).toBe(false)
      expect(pathExists(path.join(repoRoot, '.claude', 'commands', 'specrails', 'setup.md'))).toBe(
        false,
      )
      expect(pathExists(path.join(repoRoot, '.specrails', 'bin', 'doctor.sh'))).toBe(false)
      expect(
        pathExists(path.join(repoRoot, '.specrails', 'setup-templates', '.provider-detection.json')),
      ).toBe(false)
      expect(
        pathExists(
          path.join(repoRoot, '.specrails', 'setup-templates', 'settings', 'integration-contract.json'),
        ),
      ).toBe(false)
      expect(pathExists(path.join(repoRoot, '.specrails-version'))).toBe(false)
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
        // sr-merge-resolver is now optional — NOT placed by default
        expect(pathExists(path.join(agentsDir, 'sr-merge-resolver.md'))).toBe(false)
        expect(pathExists(path.join(agentsDir, 'sr-product-manager.md'))).toBe(false)
        expect(pathExists(path.join(agentsDir, 'sr-product-analyst.md'))).toBe(false)
      })

      it('honours selectedAgents for config-driven quick installs while keeping the baseline trio', () => {
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
          selectedAgents: ['sr-architect'],
        })

        const agentsDir = path.join(repoRoot, '.claude', 'agents')
        expect(pathExists(path.join(agentsDir, 'sr-architect.md'))).toBe(true)
        expect(pathExists(path.join(agentsDir, 'sr-developer.md'))).toBe(true)
        // sr-merge-resolver is optional — not placed unless explicitly selected
        expect(pathExists(path.join(agentsDir, 'sr-merge-resolver.md'))).toBe(false)
        expect(pathExists(path.join(agentsDir, 'sr-reviewer.md'))).toBe(true)
        expect(pathExists(path.join(agentsDir, 'sr-frontend-developer.md'))).toBe(false)

        const cmdsDir = path.join(repoRoot, '.claude', 'commands', 'specrails')
        // merge-resolve command is excluded because sr-merge-resolver was not selected
        expect(pathExists(path.join(cmdsDir, 'merge-resolve.md'))).toBe(false)
        expect(pathExists(path.join(cmdsDir, 'implement.md'))).toBe(true)
        expect(pathExists(path.join(cmdsDir, 'auto-propose-backlog-specs.md'))).toBe(false)
        expect(pathExists(path.join(cmdsDir, 'get-backlog-specs.md'))).toBe(false)
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
        // sr-merge-resolver is now optional and not placed by default → merge-resolve excluded too
        expect(pathExists(path.join(cmdsDir, 'merge-resolve.md'))).toBe(false)
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

      // Codex skills live under <providerDir>/skills/ now (was: .agents/skills/
      // in the pre-§18 gated state — that path was never read by codex).
      expect(pathExists(path.join(repoRoot, '.codex', 'skills', 'enrich', 'SKILL.md'))).toBe(true)
      expect(pathExists(path.join(repoRoot, '.codex', 'skills', 'doctor', 'SKILL.md'))).toBe(true)
    })

    it('codex provider applies codex-config.toml + AGENTS.md (no rules.star)', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo-codex-settings')
      setupFakeSource(scriptDir)

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'codex',
        providerDir: '.codex',
        agentTeams: false,
        tier: 'quick',
      })

      expect(pathExists(path.join(repoRoot, '.codex', 'config.toml'))).toBe(true)
      expect(pathExists(path.join(repoRoot, 'AGENTS.md'))).toBe(true)
      // rules.star is intentionally NOT written — codex 0.128.0+ keeps
      // sandbox policy inside config.toml itself (top-level `sandbox_mode`).
      expect(pathExists(path.join(repoRoot, '.codex', 'rules.star'))).toBe(false)

      const configToml = require('node:fs').readFileSync(path.join(repoRoot, '.codex', 'config.toml'), 'utf8')
      // {{MODEL_NAME}} should be substituted with gpt-5.5-mini (default)
      expect(configToml).toContain('gpt-5.5-mini')
      expect(configToml).not.toContain('{{MODEL_NAME}}')
      // Top-level `model = "..."` schema, not `[model] / name = ...`
      expect(configToml).toMatch(/^model\s*=\s*"gpt-5\.5-mini"/m)

      const agentsMd = require('node:fs').readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')
      expect(agentsMd).toContain('<!-- specrails-managed:start -->')
      expect(agentsMd).toContain('<!-- specrails-managed:end -->')
      expect(agentsMd).toContain('repo-codex-settings')
    })

    it('codex provider does NOT create .claude/agent-memory/ directories', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo-no-claude-memory')
      setupFakeSource(scriptDir)

      scaffoldInstallation({
        scriptDir,
        repoRoot,
        provider: 'codex',
        providerDir: '.codex',
        agentTeams: false,
        tier: 'quick',
      })

      // The claude-only quick-tier placement is skipped, so no
      // .claude/agent-memory/ should be created on a codex project.
      expect(pathExists(path.join(repoRoot, '.claude'))).toBe(false)
    })
  })

  describe('rail skill parity', () => {
    it('every core agent has a codex-native rail under templates/codex-skills/rails/', () => {
      // Codex cannot load Claude's .claude/agents/ convention, so each core
      // agent must have a codex-native rail SKILL.md it can invoke via
      // spawn_agent / $-mention. (The old claude-shape templates/skills/rails/
      // copies were vestigial — unused on Claude, overridden on codex, and
      // shipped with unsubstituted placeholders — so they were removed; the
      // Claude path uses templates/agents/ directly.)
      const fs = require('node:fs')
      const repoRoot = path.resolve(__dirname, '..', '..', '..')
      const railIds = ['sr-architect', 'sr-developer', 'sr-reviewer']
      for (const id of railIds) {
        const claudePath = path.join(repoRoot, 'templates', 'agents', id + '.md')
        const codexPath = path.join(repoRoot, 'templates', 'codex-skills', 'rails', id, 'SKILL.md')
        expect(fs.existsSync(claudePath), `${claudePath} missing`).toBe(true)
        expect(fs.existsSync(codexPath), `${codexPath} missing — every core agent needs a codex-native rail`).toBe(true)
      }
    })
  })
})
