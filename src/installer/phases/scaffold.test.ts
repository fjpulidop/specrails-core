import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isDir,
  isSymlink,
  listDir,
  pathExists,
  readTextFile,
  writeFileLf,
} from '../util/fs.js'
import {
  assembleProjectWorkspace,
  detectExistingSetup,
  ensureCurrentSymlink,
  installFramework,
  scaffoldInstallation,
  translateClaudeTextForKimi,
  translateOpsxSkillCallsForGemini,
  writeGeminiAgentAcknowledgments,
} from './scaffold.js'

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
}

function setupRichFakeSource(scriptDir: string): void {
  // v5 ships exactly the three core agents.
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

  // Commands: the surviving v5 set. An `unknown-ph.md` exercises token stripping.
  const cmds = [
    ['implement.md', '/specrails:implement\nmemory: {{MEMORY_PATH}}\n'],
    ['why.md', '/specrails:why'],
    ['unknown-ph.md', 'raw {{UNKNOWN_PLACEHOLDER}} trailing'],
  ] as const
  for (const [name, content] of cmds) {
    writeFileLf(path.join(scriptDir, 'templates', 'commands', 'specrails', name), content)
  }

  writeFileLf(
    path.join(scriptDir, 'templates', 'rules', 'general.md'),
    '# rules for {{PROJECT_NAME}}\n',
  )

  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
}

describe('scaffold', () => {
  let tmpDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-scaffold-test-'))
    // Redirect the home dir so the gemini agent pre-acknowledgment (writes
    // ~/.gemini/acknowledgments/agents.json) never touches the real home dir.
    // os.homedir() reads HOME on POSIX but USERPROFILE on Windows — set both.
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    const fakeHome = path.join(tmpDir, 'fake-home')
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  describe('detectExistingSetup', () => {
    it('returns false on a clean repo', () => {
      expect(
        detectExistingSetup({ artifactRoot: tmpDir, codeRoot: tmpDir, providerDir: '.claude' }),
      ).toBe(false)
    })

    it('returns true when .claude/agents/ has content', () => {
      writeFileLf(path.join(tmpDir, '.claude', 'agents', 'foo.md'), '')
      expect(
        detectExistingSetup({ artifactRoot: tmpDir, codeRoot: tmpDir, providerDir: '.claude' }),
      ).toBe(true)
    })

    it('returns true when openspec/ exists with content', () => {
      writeFileLf(path.join(tmpDir, 'openspec', 'specs', 'x.md'), '')
      expect(
        detectExistingSetup({ artifactRoot: tmpDir, codeRoot: tmpDir, providerDir: '.claude' }),
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
        artifactRoot: repoRoot,
        codeRoot: repoRoot,
        provider: 'claude',
        providerDir: '.claude',
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
        artifactRoot: repoRoot,
        codeRoot: repoRoot,
        provider: 'gemini',
        providerDir: '.gemini',
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
      expect(arch).toContain('model: gemini-3.5-flash')
      expect(arch).toContain('tools: [read_file, write_file, run_shell_command, glob, search_file_content, activate_skill]')
      // Regression guard: a `max_turns`/`maxTurns` frontmatter key makes gemini 0.46
      // silently drop the agent (`invoke_agent` → "Subagent not found"). Verified
      // empirically. It must NEVER be emitted, no matter the documented schema.
      expect(arch).not.toMatch(/max_?turns/i)
      expect(isDir(path.join(repoRoot, '.gemini', 'agent-memory', 'sr-architect'))).toBe(true)
      expect(pathExists(path.join(repoRoot, '.gemini', 'agents', 'sr-developer.md'))).toBe(true)
      const dev = readTextFile(path.join(repoRoot, '.gemini', 'agents', 'sr-developer.md'))
      expect(dev).not.toMatch(/max_?turns/i)
      expect(pathExists(path.join(repoRoot, '.gemini', 'agents', 'sr-reviewer.md'))).toBe(true)
      // VPC-dependent agent excluded from the quick tier.
      expect(pathExists(path.join(repoRoot, '.gemini', 'agents', 'sr-product-manager.md'))).toBe(false)

      // Pre-acknowledgment so the agents load in headless `gemini -p` (else they
      // need an interactive "Acknowledge and Enable" prompt and invoke_agent fails).
      const ackPath = path.join(os.homedir(), '.gemini', 'acknowledgments', 'agents.json')
      expect(pathExists(ackPath)).toBe(true)
      const ack = JSON.parse(readTextFile(ackPath)) as Record<string, Record<string, string>>
      expect(Object.keys(ack[repoRoot])).toEqual(expect.arrayContaining(['sr-architect', 'sr-developer', 'sr-reviewer']))
      const expectedHash = createHash('sha256')
        .update(readTextFile(path.join(repoRoot, '.gemini', 'agents', 'sr-architect.md')))
        .digest('hex')
      expect(ack[repoRoot]['sr-architect']).toBe(expectedHash)

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

    it('grants activate_skill + rewrites Claude Skill("opsx:*") calls in gemini agents', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo-gemini-skill')
      setupGeminiFakeSource(scriptDir)
      // Author the architect template in Claude form (the shared source of truth
      // across providers) — exactly the syntax the real templates use.
      writeFileLf(
        path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'),
        [
          '# arch',
          'First call: Skill("opsx:ff", "<specName> — desc")',
          'Recover with Skill("opsx:continue", "<specName>") or re-run Skill("opsx:ff").',
          'Receipt: the exact Skill("opsx:ff", …) call.',
        ].join('\n') + '\n',
      )
      scaffoldGemini(scriptDir, repoRoot)

      const arch = readTextFile(path.join(repoRoot, '.gemini', 'agents', 'sr-architect.md'))
      // activate_skill granted in the tools frontmatter (else the agent halts with
      // "the required `Skill` tool is not available").
      expect(arch).toContain(', activate_skill]')
      // Every Skill("opsx:*") call form rewritten to gemini's activate_skill;
      // NO Claude Skill( call survives in the generated body.
      expect(arch).toContain('activate_skill(name="openspec-ff-change")')
      expect(arch).toContain('activate_skill(name="openspec-continue-change")')
      expect(arch).not.toContain('Skill("opsx:')
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
        artifactRoot: repoRoot,
        codeRoot: repoRoot,
        provider: 'claude',
        providerDir: '.claude',
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
        artifactRoot: repoRoot,
        codeRoot: repoRoot,
        provider: 'claude',
        providerDir: '.claude',
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
        artifactRoot: repoRoot,
        codeRoot: repoRoot,
        provider: 'claude',
        providerDir: '.claude',
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

    it('quick tier places agents + rules directly under <providerDir>', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakeSource(scriptDir)

      scaffoldInstallation({
        scriptDir,
        artifactRoot: repoRoot,
        codeRoot: repoRoot,
        provider: 'claude',
        providerDir: '.claude',
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
          artifactRoot: repoRoot,
          codeRoot: repoRoot,
          provider: 'claude',
          providerDir: '.claude',
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
          artifactRoot: repoRoot,
          codeRoot: repoRoot,
          provider: 'claude',
          providerDir: '.claude',
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
          artifactRoot: repoRoot,
          codeRoot: repoRoot,
          provider: 'claude',
          providerDir: '.claude',
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
          artifactRoot: repoRoot,
          codeRoot: repoRoot,
          provider: 'claude',
          providerDir: '.claude',
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
          artifactRoot: repoRoot,
          codeRoot: repoRoot,
          provider: 'claude',
          providerDir: '.claude',
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

      it('creates per-agent memory directories + shared explanations dir when an arch/reviewer ships', () => {
        const scriptDir = path.join(tmpDir, 'core')
        const repoRoot = path.join(tmpDir, 'repo')
        setupRichFakeSource(scriptDir)

        scaffoldInstallation({
          scriptDir,
          artifactRoot: repoRoot,
          codeRoot: repoRoot,
          provider: 'claude',
          providerDir: '.claude',
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
        artifactRoot: repoRoot,
        codeRoot: repoRoot,
        provider: 'claude',
        providerDir: '.claude',
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
        artifactRoot: repoRoot,
        codeRoot: repoRoot,
        provider: 'codex',
        providerDir: '.codex',
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
        artifactRoot: repoRoot,
        codeRoot: repoRoot,
        provider: 'codex',
        providerDir: '.codex',
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
        artifactRoot: repoRoot,
        codeRoot: repoRoot,
        provider: 'codex',
        providerDir: '.codex',
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

describe('translateOpsxSkillCallsForGemini', () => {
  it('maps each opsx skill id to its gemini activate_skill name', () => {
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:ff")')).toBe('activate_skill(name="openspec-ff-change")')
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:apply")')).toBe('activate_skill(name="openspec-apply-change")')
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:archive")')).toBe('activate_skill(name="openspec-archive-change")')
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:continue")')).toBe('activate_skill(name="openspec-continue-change")')
    // Non-uniform names — the reason the map must be explicit, not a regex suffix.
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:sync")')).toBe('activate_skill(name="openspec-sync-specs")')
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:explore")')).toBe('activate_skill(name="openspec-explore")')
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:bulk-archive")')).toBe('activate_skill(name="openspec-bulk-archive-change")')
  })

  it('drops positional skill input and the ellipsis placeholder', () => {
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:ff", "<specName> — desc")')).toBe('activate_skill(name="openspec-ff-change")')
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:apply", …)')).toBe('activate_skill(name="openspec-apply-change")')
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:continue", "<specName>")')).toBe('activate_skill(name="openspec-continue-change")')
  })

  it('rewrites multiple calls in one body and preserves surrounding prose', () => {
    const body = 'Run Skill("opsx:ff") then later Skill("opsx:apply", "<x>") to finish.'
    expect(translateOpsxSkillCallsForGemini(body)).toBe(
      'Run activate_skill(name="openspec-ff-change") then later activate_skill(name="openspec-apply-change") to finish.',
    )
  })

  it('leaves unknown opsx ids untouched (no name="undefined")', () => {
    expect(translateOpsxSkillCallsForGemini('Skill("opsx:bogus")')).toBe('Skill("opsx:bogus")')
  })

  it('is a no-op for bodies without Skill calls', () => {
    expect(translateOpsxSkillCallsForGemini('just prose about the skill')).toBe('just prose about the skill')
  })
})

describe('writeGeminiAgentAcknowledgments', () => {
  let tmpDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-ack-test-'))
    // os.homedir() reads HOME on POSIX but USERPROFILE on Windows — set both.
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    const fakeHome = path.join(tmpDir, 'home')
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const ackFile = () => path.join(os.homedir(), '.gemini', 'acknowledgments', 'agents.json')
  const writeAgent = (repoRoot: string, id: string, content: string) =>
    writeFileLf(path.join(repoRoot, '.gemini', 'agents', `${id}.md`), content)
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')

  it('writes sha256-of-file-content per agent under the project-root key', () => {
    const repo = path.join(tmpDir, 'repo')
    writeAgent(repo, 'sr-architect', '---\nname: sr-architect\n---\nbody\n')
    writeGeminiAgentAcknowledgments(repo, ['sr-architect'])
    const ack = JSON.parse(readTextFile(ackFile())) as Record<string, Record<string, string>>
    expect(ack[repo]['sr-architect']).toBe(sha('---\nname: sr-architect\n---\nbody\n'))
  })

  it('merges — preserves other projects and earlier agents across calls', () => {
    const repoA = path.join(tmpDir, 'repoA')
    const repoB = path.join(tmpDir, 'repoB')
    writeAgent(repoA, 'sr-architect', 'A-arch\n')
    writeAgent(repoB, 'sr-developer', 'B-dev\n')
    writeGeminiAgentAcknowledgments(repoA, ['sr-architect'])
    writeGeminiAgentAcknowledgments(repoB, ['sr-developer'])
    writeAgent(repoA, 'sr-reviewer', 'A-rev\n')
    writeGeminiAgentAcknowledgments(repoA, ['sr-reviewer'])
    const ack = JSON.parse(readTextFile(ackFile())) as Record<string, Record<string, string>>
    expect(ack[repoB]['sr-developer']).toBe(sha('B-dev\n')) // other project survives
    expect(ack[repoA]['sr-architect']).toBe(sha('A-arch\n')) // earlier agent survives
    expect(ack[repoA]['sr-reviewer']).toBe(sha('A-rev\n'))
  })

  it('is a no-op when no agent ids are given', () => {
    writeGeminiAgentAcknowledgments(path.join(tmpDir, 'repo'), [])
    expect(pathExists(ackFile())).toBe(false)
  })

  it('recovers from a corrupt existing ack file', () => {
    const repo = path.join(tmpDir, 'repo')
    writeAgent(repo, 'sr-reviewer', 'rev\n')
    writeGeminiAgentAcknowledgments(repo, ['sr-reviewer']) // creates dir + file
    writeFileLf(ackFile(), 'not json{{{')
    writeGeminiAgentAcknowledgments(repo, ['sr-reviewer']) // must not throw
    const ack = JSON.parse(readTextFile(ackFile())) as Record<string, Record<string, string>>
    expect(ack[repo]['sr-reviewer']).toBe(sha('rev\n'))
  })

  it('skips agent ids whose file is missing', () => {
    const repo = path.join(tmpDir, 'repo')
    writeAgent(repo, 'sr-architect', 'arch\n')
    writeGeminiAgentAcknowledgments(repo, ['sr-architect', 'ghost'])
    const ack = JSON.parse(readTextFile(ackFile())) as Record<string, Record<string, string>>
    expect(ack[repo]['sr-architect']).toBe(sha('arch\n'))
    expect(ack[repo]['ghost']).toBeUndefined()
  })

  it('keys the ack on the WORKSPACE (agentsBaseDir) under relocation, not the repo', () => {
    // Under relocation, gemini runs with cwd=<workspace>, so the ack store must be
    // keyed on the workspace providerDir base (3rd arg) — NOT the repo root —
    // otherwise headless `gemini -p` looks up `store[<workspace>]` and finds
    // nothing. The agent files are hashed from the workspace too.
    const repo = path.join(tmpDir, 'repo')
    const workspace = path.join(tmpDir, 'workspace')
    writeAgent(workspace, 'sr-architect', 'ws-arch\n')
    writeGeminiAgentAcknowledgments(repo, ['sr-architect'], workspace)
    const ack = JSON.parse(readTextFile(ackFile())) as Record<string, Record<string, string>>
    expect(ack[workspace]['sr-architect']).toBe(sha('ws-arch\n'))
    expect(ack[repo]).toBeUndefined() // repo is NOT the key under relocation
  })
})

describe('Kimi scaffold', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-kimi-scaffold-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  function setupKimiSource(scriptDir: string): void {
    setupRichFakeSource(scriptDir)
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
      'js-yaml fixture license\n',
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
      'js-yaml fixture notice\n',
    )
    writeFileLf(
      path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'),
      [
        '---',
        'name: sr-architect',
        'description: "Architecture role"',
        'model: sonnet',
        '---',
        'Run Skill("opsx:ff", "<change>") and read .claude/rules/.',
        '',
      ].join('\n'),
    )
  }

  it('renders directory workflows and rail roles without Claude invocation syntax', () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    setupKimiSource(scriptDir)

    scaffoldInstallation({
      scriptDir,
      artifactRoot: repoRoot,
      codeRoot: repoRoot,
      provider: 'kimi',
      providerDir: '.kimi-code',
    })

    const workflow = readTextFile(
      path.join(repoRoot, '.kimi-code', 'skills', 'specrails-implement', 'SKILL.md'),
    )
    expect(workflow).toContain('name: specrails-implement')
    expect(workflow).toContain('description:')
    expect(workflow).toContain('Skill(skill="specrails-implement"')
    expect(workflow).toContain('kimi-code/k3')
    expect(workflow).not.toContain('/specrails:')
    expect(workflow).not.toContain('/skill:')
    expect(workflow).not.toContain('subagent_type')
    expect(workflow).not.toContain('.claude/')

    const role = readTextFile(
      path.join(repoRoot, '.kimi-code', 'skills', 'sr-architect', 'SKILL.md'),
    )
    expect(role).toContain('name: sr-architect')
    expect(role).toContain(
      'Skill(skill="openspec-ff-change", args="<change>")',
    )
    expect(role).toContain('.kimi-code/rules/')
    expect(role).not.toContain('Skill("opsx:')
    expect(role).not.toContain('/skill:')

    const instructions = readTextFile(path.join(repoRoot, '.kimi-code', 'AGENTS.md'))
    expect(instructions).toContain('/skill:specrails-<command>')
    expect(pathExists(path.join(repoRoot, '.kimi-code', 'mcp.json'))).toBe(true)
    expect(pathExists(path.join(repoRoot, 'AGENTS.md'))).toBe(false)
    expect(pathExists(path.join(repoRoot, '.kimi-code', 'commands'))).toBe(false)
    expect(pathExists(path.join(repoRoot, '.kimi-code', 'agents'))).toBe(false)
    expect(
      pathExists(
        path.join(repoRoot, '.kimi-code', 'specrails', 'run-skill.mjs'),
      ),
    ).toBe(true)
    expect(
      pathExists(
        path.join(
          repoRoot,
          '.kimi-code',
          'specrails',
          'vendor',
          'js-yaml',
          'js-yaml.mjs',
        ),
      ),
    ).toBe(true)
    expect(
      pathExists(
        path.join(repoRoot, '.kimi-code', 'skills', 'specrails', 'run-skill.mjs'),
      ),
    ).toBe(false)
  })

  it('rematerializes a same-version framework that still has nested role skills', () => {
    const scriptDir = path.join(tmpDir, 'core')
    const frameworkDir = path.join(tmpDir, 'framework')
    setupKimiSource(scriptDir)

    const initial = installFramework({
      scriptDir,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
    })
    expect(initial.materialized).toBe(true)

    const skillsDir = path.join(initial.providerFrameworkDir, 'skills')
    rmSync(path.join(skillsDir, 'sr-architect'), { recursive: true, force: true })
    writeFileLf(
      path.join(skillsDir, 'rails', 'sr-architect', 'SKILL.md'),
      'undiscoverable-pre-release-role\n',
    )

    const repaired = installFramework({
      scriptDir,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
    })
    expect(repaired.materialized).toBe(true)
    expect(pathExists(path.join(skillsDir, 'rails'))).toBe(false)
    expect(pathExists(path.join(skillsDir, 'sr-architect', 'SKILL.md'))).toBe(true)

    const idempotent = installFramework({
      scriptDir,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
    })
    expect(idempotent.materialized).toBe(false)
  })

  it('repairs a same-version framework that predates the managed skill runner', () => {
    const scriptDir = path.join(tmpDir, 'core')
    const frameworkDir = path.join(tmpDir, 'framework-runner-repair')
    setupKimiSource(scriptDir)

    const initial = installFramework({
      scriptDir,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
    })
    const runnerPath = path.join(
      initial.providerFrameworkDir,
      'specrails',
      'run-skill.mjs',
    )
    rmSync(runnerPath, { force: true })

    const repaired = installFramework({
      scriptDir,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
    })
    expect(repaired.materialized).toBe(true)
    expect(readTextFile(runnerPath)).toBe('// managed Kimi runner fixture\n')
  })

  it('repairs a same-version framework missing the runner YAML vendor', () => {
    const scriptDir = path.join(tmpDir, 'core')
    const frameworkDir = path.join(tmpDir, 'framework-vendor-repair')
    setupKimiSource(scriptDir)

    const initial = installFramework({
      scriptDir,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
    })
    const vendorPath = path.join(
      initial.providerFrameworkDir,
      'specrails',
      'vendor',
      'js-yaml',
      'js-yaml.mjs',
    )
    rmSync(vendorPath, { force: true })

    const repaired = installFramework({
      scriptDir,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
    })
    expect(repaired.materialized).toBe(true)
    expect(readTextFile(vendorPath)).toBe('// vendored js-yaml fixture\n')
  })

  it('assembles granular skills while preserving OpenSpec, custom roles, and user MCP config', () => {
    const scriptDir = path.join(tmpDir, 'core')
    const frameworkDir = path.join(tmpDir, 'framework')
    const workspace = path.join(tmpDir, 'workspace')
    const codeRoot = path.join(tmpDir, 'repo')
    setupKimiSource(scriptDir)

    installFramework({
      scriptDir,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
    })
    ensureCurrentSymlink(frameworkDir, '1.2.3')
    writeFileLf(
      path.join(workspace, '.kimi-code', 'skills', 'rails', 'custom-auditor', 'SKILL.md'),
      'custom-role-byte-content\n',
    )
    writeFileLf(
      path.join(workspace, '.kimi-code', 'skills', 'openspec-apply-change', 'SKILL.md'),
      'corrected-upstream-byte-content\n',
    )
    writeFileLf(path.join(workspace, '.kimi-code', 'mcp.json'), '{"user":true}\n')

    const assembled = assembleProjectWorkspace({
      workspace,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
      codeRoot,
      scriptDir,
    })

    expect(
      readTextFile(
        path.join(workspace, '.kimi-code', 'skills', 'custom-auditor', 'SKILL.md'),
      ),
    ).toBe('custom-role-byte-content\n')
    expect(pathExists(path.join(workspace, '.kimi-code', 'skills', 'rails'))).toBe(false)
    expect(
      readTextFile(
        path.join(workspace, '.kimi-code', 'skills', 'openspec-apply-change', 'SKILL.md'),
      ),
    ).toBe('corrected-upstream-byte-content\n')
    expect(readTextFile(path.join(workspace, '.kimi-code', 'mcp.json'))).toBe('{"user":true}\n')
    expect(
      pathExists(
        path.join(workspace, '.kimi-code', 'skills', 'sr-architect', 'SKILL.md'),
      ),
    ).toBe(true)
    expect(
      pathExists(path.join(workspace, '.kimi-code', 'skills', 'specrails-implement', 'SKILL.md'),
    )).toBe(true)
    expect(pathExists(path.join(workspace, '.kimi-code', 'AGENTS.md'))).toBe(true)
    expect(pathExists(path.join(workspace, 'AGENTS.md'))).toBe(false)
    expect(
      readTextFile(
        path.join(workspace, '.kimi-code', 'specrails', 'run-skill.mjs'),
      ),
    ).toBe('// managed Kimi runner fixture\n')
    expect(
      readTextFile(
        path.join(
          workspace,
          '.kimi-code',
          'specrails',
          'vendor',
          'js-yaml',
          'LICENSE',
        ),
      ),
    ).toBe('js-yaml fixture license\n')
    expect(assembled.links.specrails).toBe(
      process.platform === 'win32' ? 'junction' : 'symlink',
    )
  })

  it('never overwrites a flat custom role when the legacy nested migration conflicts', () => {
    const scriptDir = path.join(tmpDir, 'core')
    const frameworkDir = path.join(tmpDir, 'framework')
    const workspace = path.join(tmpDir, 'workspace-conflict')
    setupKimiSource(scriptDir)

    installFramework({
      scriptDir,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
    })
    ensureCurrentSymlink(frameworkDir, '1.2.3')
    writeFileLf(
      path.join(workspace, '.kimi-code', 'skills', 'custom-auditor', 'SKILL.md'),
      'canonical-custom-role\n',
    )
    writeFileLf(
      path.join(
        workspace,
        '.kimi-code',
        'skills',
        'rails',
        'custom-auditor',
        'SKILL.md',
      ),
      'legacy-conflicting-role\n',
    )

    assembleProjectWorkspace({
      workspace,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
      codeRoot: path.join(tmpDir, 'repo-conflict'),
      scriptDir,
    })

    expect(
      readTextFile(
        path.join(workspace, '.kimi-code', 'skills', 'custom-auditor', 'SKILL.md'),
      ),
    ).toBe('canonical-custom-role\n')
    expect(
      readTextFile(
        path.join(
          workspace,
          '.kimi-code',
          'skills',
          'rails',
          'custom-auditor',
          'SKILL.md',
        ),
      ),
    ).toBe('legacy-conflicting-role\n')
  })

  it('keeps MCP registries as isolated real files across relocated workspaces', () => {
    const scriptDir = path.join(tmpDir, 'core')
    const frameworkDir = path.join(tmpDir, 'framework')
    const workspaceA = path.join(tmpDir, 'workspace-a')
    const workspaceB = path.join(tmpDir, 'workspace-b')
    setupKimiSource(scriptDir)

    installFramework({
      scriptDir,
      frameworkDir,
      provider: 'kimi',
      providerDir: '.kimi-code',
      version: '1.2.3',
    })
    ensureCurrentSymlink(frameworkDir, '1.2.3')
    for (const [workspace, repo] of [
      [workspaceA, path.join(tmpDir, 'repo-a')],
      [workspaceB, path.join(tmpDir, 'repo-b')],
    ]) {
      assembleProjectWorkspace({
        workspace,
        frameworkDir,
        provider: 'kimi',
        providerDir: '.kimi-code',
        version: '1.2.3',
        codeRoot: repo,
        scriptDir,
      })
    }

    const mcpA = path.join(workspaceA, '.kimi-code', 'mcp.json')
    const mcpB = path.join(workspaceB, '.kimi-code', 'mcp.json')
    const frameworkMcp = path.join(
      frameworkDir,
      '1.2.3',
      '.kimi-code',
      'mcp.json',
    )
    expect(isSymlink(mcpA)).toBe(false)
    expect(isSymlink(mcpB)).toBe(false)
    expect(pathExists(frameworkMcp)).toBe(false)

    writeFileLf(mcpA, '{"mcpServers":{"desktop-project-a":{"command":"a"}}}\n')
    expect(readTextFile(mcpB)).toBe('{\n  "mcpServers": {}\n}\n')
    expect(pathExists(frameworkMcp)).toBe(false)
  })

  it('translates provider paths, workflow names, and non-uniform OpenSpec ids', () => {
    expect(
      translateClaudeTextForKimi(
        'Skill("opsx:sync") /specrails:why /sr:implement .claude/agents/sr-reviewer.md subagent_type',
      ),
    ).toBe(
      'Skill(skill="openspec-sync-specs", args="") ' +
        'Skill(skill="specrails-why", args=<arguments following this command>) ' +
        'Skill(skill="specrails-implement", args=<arguments following this command>) ' +
        '.kimi-code/skills/sr-reviewer/SKILL.md role_skill',
    )
  })

  it('renders the complete real-template inventory with no forbidden provider syntax', async () => {
    const scriptDir = process.cwd()
    const repoRoot = path.join(tmpDir, 'real-inventory')
    scaffoldInstallation({
      scriptDir,
      artifactRoot: repoRoot,
      codeRoot: repoRoot,
      provider: 'kimi',
      providerDir: '.kimi-code',
      materializeAllAgents: true,
    })

    const canonicalCommands = listDir(path.join(scriptDir, 'templates', 'commands', 'specrails'))
      .filter((entry) => entry.endsWith('.md') && path.basename(entry) !== 'setup.md')
      .map((entry) => `specrails-${path.basename(entry, '.md')}`)
      .sort()
    const workflowRoot = path.join(repoRoot, '.kimi-code', 'skills')
    const generatedSkillDirs = listDir(workflowRoot).filter((entry) => isDir(entry))
    expect(generatedSkillDirs.map((entry) => path.basename(entry))).not.toContain('rails')
    expect(generatedSkillDirs.map((entry) => path.basename(entry))).not.toContain('personas')
    for (const skillDir of generatedSkillDirs) {
      expect(pathExists(path.join(skillDir, 'SKILL.md'))).toBe(true)
    }

    const workflows = generatedSkillDirs
      .filter((entry) => isDir(entry) && path.basename(entry).startsWith('specrails-'))
      .map((entry) => path.basename(entry))
      .sort()
    expect(workflows).toEqual(canonicalCommands)

    const canonicalRoles = listDir(path.join(scriptDir, 'templates', 'agents'))
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => path.basename(entry, '.md'))
      .sort()
    const roles = generatedSkillDirs
      .filter((entry) => isDir(entry) && path.basename(entry).startsWith('sr-'))
      .map((entry) => path.basename(entry))
      .sort()
    expect(roles).toEqual(canonicalRoles)

    const allSkillFiles = [
      ...workflows.map((name) => path.join(workflowRoot, name, 'SKILL.md')),
      ...roles.map((name) => path.join(workflowRoot, name, 'SKILL.md')),
    ]
    for (const skillFile of allSkillFiles) {
      const rendered = readTextFile(skillFile)
      expect(rendered).toMatch(/^---\nname: [^\n]+\ndescription: [^\n]+\ntype: prompt\n---\n/)
      expect(rendered).not.toContain('.claude')
      expect(rendered).not.toContain('/specrails:')
      expect(rendered).not.toContain('/skill:')
      expect(rendered).not.toContain('subagent_type')
      expect(rendered).not.toContain('Skill("opsx:')
      expect(rendered).toContain('## Kimi runtime context contract')
      expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/)
    }
    for (const workflow of workflows) {
      const rendered = readTextFile(
        path.join(workflowRoot, workflow, 'SKILL.md'),
      )
      expect(rendered).toContain(
        '--role-wave-file .specrails/kimi-role-wave.json',
      )
      expect(rendered).toContain('"roles": [')
      expect(rendered).toContain('"workspace": "current"')
      expect(rendered).toContain('"profile": "inherit"')
      expect(rendered).toContain('`"worktree:<feature-id>"`')
      expect(rendered).toContain('manifest `baseCommit`')
      expect(rendered).not.toContain('ROLE_ARGS=')
      expect(rendered).not.toContain('ROLE_MODEL=')
    }

    const implement = readTextFile(
      path.join(workflowRoot, 'specrails-implement', 'SKILL.md'),
    )
    expect(implement).toContain('.kimi-code/skills/$id/SKILL.md')
    expect(implement).toContain('parsed `AGENT_MODEL` map')
    expect(implement).toContain(
      '"model": "<exact profile model or k3>"',
    )
    expect(implement).toContain('.kimi-code/specrails/run-skill.mjs')
    expect(implement).toContain(
      '--role-wave-file .specrails/kimi-role-wave.json',
    )
    expect(implement).toContain(
      '--role-wave-status <stable-run-id>',
    )
    expect(implement).toContain(
      '--role-merge-file .specrails/kimi-role-merge.json',
    )
    expect(implement).toContain('--role-wave-cleanup <run>')
    expect(implement).toContain('"kimi_role_wave": {')
    expect(implement).toContain('Every change is `{status:"A"|"M"|"D",path}`')
    expect(implement).toContain('Filenames may contain spaces, Unicode')
    expect(implement).not.toContain('cp <worktree-path>/<file>')
    expect(implement).not.toContain('git -C <worktree-path> diff main')
    expect(implement).not.toContain('ROLE_ARGS=')
    expect(implement).not.toContain('ROLE_MODEL=')
    expect(implement).not.toContain('--args "$ROLE_ARGS"')
    expect(implement).not.toContain('-p "/skill:$ROLE_ID')
    expect(implement).not.toContain('${AGENT_MODEL[')
    expect(implement).toContain('--add-dir "${SPECRAILS_REPO_DIR:-.}"')
    expect(implement).toContain('.specrails/profiles/kimi-default.json')
    expect(implement).not.toContain('.specrails/profiles/project-default.json')
    expect(implement).not.toContain('.kimi-code/agents/')
    expect(implement).not.toContain('Apply per-agent model overrides')
    expect(implement).toContain('KIMI_PR_CREATE')

    const batch = readTextFile(
      path.join(workflowRoot, 'specrails-batch-implement', 'SKILL.md'),
    )
    expect(batch).toContain('`skill:"specrails-implement"`')
    expect(batch).toContain('`workspace:"worktree:<feature-id>"`')
    expect(batch).toContain('effective concurrency')
    expect(batch).toContain('`--role-wave-status`')
    expect(batch).toContain('Do not call multiple built-in `Skill` tools')
    expect(batch).toContain('KIMI_BACKLOG_VIEW')

    const telemetry = readTextFile(
      path.join(workflowRoot, 'specrails-telemetry', 'SKILL.md'),
    )
    expect(telemetry).toContain('session_index.jsonl')
    expect(telemetry).toContain('type:"usage.record"')
    expect(telemetry).toContain('`cost_usd:null`')
    expect(telemetry).not.toContain('published Claude pricing')

    const retry = readTextFile(
      path.join(workflowRoot, 'specrails-retry', 'SKILL.md'),
    )
    expect(retry).toContain('`KIMI_ROLE_WAVE`')
    expect(retry).toContain('--role-wave-status <run>')
    expect(retry).toContain('never cleanup before')

    const installedRunner = await import(
      pathToFileURL(
        path.join(repoRoot, '.kimi-code', 'specrails', 'run-skill.mjs'),
      ).href
    ) as {
      parseSkillDocument: (source: string) => {
        description: string
        argumentNames: string[]
      }
      prepareSkillLaunch: (options: {
        providerRoot: string
        skill: string
        model: string
        rawArgs: string
        sessionId?: string
        additionalDirs: string[]
        attachmentPaths: string[]
      }) => {
        prompt: string
        kimiArgs: string[]
      }
      resolveKimiLaunch: (
        args: string[],
        options: {
          platform: string
          binary: string
          readFile: () => string
          fileExists: () => boolean
        },
      ) => {
        command: string
        args: string[]
        stdinText?: string
      }
      windowsCommandLineLength: (command: string, args: string[]) => number
    }
    const parsed = installedRunner.parseSkillDocument(
      [
        '---',
        'name: installed-yaml',
        'description: >-',
        '  Loaded through the copied',
        '  vendored parser',
        'arguments: &args [target, 7, mode]',
        'metadata: { copy: true }',
        '---',
        '$target $mode',
      ].join('\n'),
    )
    expect(parsed.description).toBe(
      'Loaded through the copied vendored parser',
    )
    expect(parsed.argumentNames).toEqual(['target', 'mode'])

    const windowsShim =
      'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\kimi.cmd'
    const windowsShimSource =
      '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs" %*\r\n'
    let largestMaterializedPrompt = 0
    for (const skillFile of allSkillFiles) {
      const skill = path.basename(path.dirname(skillFile))
      const prepared = installedRunner.prepareSkillLaunch({
        providerRoot: path.join(repoRoot, '.kimi-code'),
        skill,
        model: 'k3',
        rawArgs: 'ticket #42 — contexto Unicode 🚀\nsegunda línea',
        sessionId: 'ses_prompt_budget',
        additionalDirs: [],
        attachmentPaths: [],
      })
      largestMaterializedPrompt = Math.max(
        largestMaterializedPrompt,
        prepared.prompt.length,
      )
      const launch = installedRunner.resolveKimiLaunch(prepared.kimiArgs, {
        platform: 'win32',
        binary: windowsShim,
        readFile: () => windowsShimSource,
        fileExists: () => false,
      })
      expect(launch.stdinText).toBe(prepared.prompt)
      expect(launch.args).not.toContain(prepared.prompt)
      expect(
        installedRunner.windowsCommandLineLength(
          launch.command,
          launch.args,
        ),
      ).toBeLessThanOrEqual(30_000)
    }
    // Proves the test exercises the historical CreateProcess regression rather
    // than only small fixtures: implement/enrich exceed 60K materialized.
    expect(largestMaterializedPrompt).toBeGreaterThan(60_000)
  })
})
