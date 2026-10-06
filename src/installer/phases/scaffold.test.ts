import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
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
  pruneStaleRoleArtifacts,
  scaffoldInstallation,
  translateClaudeTextForKimi,
} from './scaffold.js'

/** A role id an older Core shipped; composed so the retired names never appear literally. */
const legacyRole = (role: string): string => `sr-${role}`

function setupFakeSource(scriptDir: string): void {
  writeFileLf(path.join(scriptDir, 'templates', 'commands', 'specrails', 'implement.md'), 'implement')
  // Codex settings templates — fake content with placeholders the installer
  // substitutes.
  writeFileLf(
    path.join(scriptDir, 'templates', 'settings', 'codex-config.toml'),
    'model = "{{MODEL_NAME}}"\n',
  )
}

function setupRichFakeSource(scriptDir: string): void {
  // Commands: the runtime entry points. An `unknown-ph.md` exercises token stripping.
  const cmds = [
    ['implement.md', '/specrails:implement for {{PROJECT_NAME}}\n'],
    ['retry.md', '/specrails:retry'],
    ['unknown-ph.md', 'raw {{UNKNOWN_PLACEHOLDER}} trailing'],
  ] as const
  for (const [name, content] of cmds) {
    writeFileLf(path.join(scriptDir, 'templates', 'commands', 'specrails', name), content)
  }
}

describe('scaffold', () => {
  let tmpDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-scaffold-test-'))
    // Redirect the home dir so the scaffold can be proven to never touch it
    // (older Core wrote gemini acknowledgments there).
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

    it('returns true when .claude/commands/ has content', () => {
      writeFileLf(path.join(tmpDir, '.claude', 'commands', 'specrails', 'implement.md'), '')
      expect(
        detectExistingSetup({ artifactRoot: tmpDir, codeRoot: tmpDir, providerDir: '.claude' }),
      ).toBe(true)
    })

    it('ignores a user-owned .claude/agents/ dir: role files no longer mean an installation', () => {
      writeFileLf(path.join(tmpDir, '.claude', 'agents', 'custom-foo.md'), '')
      writeFileLf(path.join(tmpDir, '.claude', 'agents', `${legacyRole('architect')}.md`), '')
      expect(
        detectExistingSetup({ artifactRoot: tmpDir, codeRoot: tmpDir, providerDir: '.claude' }),
      ).toBe(false)
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
      expect(isDir(path.join(repoRoot, '.specrails', 'setup-templates', 'commands'))).toBe(true)
      expect(pathExists(path.join(repoRoot, '.specrails', 'setup-templates', 'agents'))).toBe(false)
    })

    function setupGeminiFakeSource(scriptDir: string): void {
      setupRichFakeSource(scriptDir)
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

    it('emits the gemini artifact tree (commands .toml + settings + GEMINI.md) and no subagent', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo-gemini')
      setupGeminiFakeSource(scriptDir)
      scaffoldGemini(scriptDir, repoRoot)

      // Roles are runtime-defined: no .gemini/agents/, no agent-memory and no
      // headless acknowledgment written to the (redirected) home dir.
      expect(pathExists(path.join(repoRoot, '.gemini', 'agents'))).toBe(false)
      expect(pathExists(path.join(repoRoot, '.gemini', 'agent-memory'))).toBe(false)
      expect(pathExists(path.join(os.homedir(), '.gemini'))).toBe(false)

      // Commands: every workflow entry point is generated as TOML from its command body.
      const retry = readTextFile(path.join(repoRoot, '.gemini', 'commands', 'specrails', 'retry.toml'))
      expect(retry.startsWith('description = ')).toBe(true)
      expect(retry).toContain("prompt = '''")
      expect(retry).toContain('/specrails:retry')
      expect(readTextFile(path.join(repoRoot, '.gemini', 'commands', 'specrails', 'implement.toml'))).toContain('/specrails:implement')

      // Settings + GEMINI.md.
      const settings = JSON.parse(readTextFile(path.join(repoRoot, '.gemini', 'settings.json')))
      expect(settings.experimental.enableAgents).toBe(true)
      const gmd = readTextFile(path.join(repoRoot, 'GEMINI.md'))
      expect(gmd).toContain('specrails-managed:start')
      expect(gmd).toContain('.gemini/')
      expect(gmd).toContain('frozen scope and official OpenSpec workflow')
      expect(gmd).not.toContain('Prefer the `/specrails:*` commands')
      // No throw, no codex/claude leakage.
      expect(isDir(path.join(repoRoot, '.gemini', 'skills'))).toBe(true)
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
        'commands',
        'specrails',
        'implement.md',
      )
      expect(pathExists(copied)).toBe(true)
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

    it('places commands directly under <providerDir> and no role file', () => {
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

      expect(pathExists(path.join(repoRoot, '.claude', 'commands', 'specrails', 'implement.md'))).toBe(true)
      expect(pathExists(path.join(repoRoot, '.claude', 'agents'))).toBe(false)
      expect(pathExists(path.join(repoRoot, '.claude', 'rules'))).toBe(false)
    })

    describe('placeholders + role-free placement', () => {
      it('places no role file and no agent-memory for claude', () => {
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

        expect(pathExists(path.join(repoRoot, '.claude', 'agents'))).toBe(false)
        expect(pathExists(path.join(repoRoot, '.claude', 'agent-memory'))).toBe(false)
        expect(readdirSync(path.join(repoRoot, '.claude')).sort()).toEqual(['commands', 'skills'])
        expect(readdirSync(path.join(repoRoot, '.claude', 'skills'))).toEqual(['sr-implement'])
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
        const implement = readTextFile(path.join(repoRoot, '.claude', 'commands', 'specrails', 'implement.md'))
        expect(implement).toContain(`/specrails:implement for ${projectName}`)
        expect(implement).not.toContain('{{PROJECT_NAME}}')
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

    it('codex provider places workflow commands as Agent Skills', () => {
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
      const skill = readTextFile(path.join(repoRoot, '.codex', 'skills', 'implement', 'SKILL.md'))
      expect(skill).toMatch(/^---\nname: implement\n/)
      expect(pathExists(path.join(repoRoot, '.codex', 'skills', 'doctor'))).toBe(false)
      // No codex-native rail: roles are runtime-defined.
      expect(pathExists(path.join(repoRoot, '.codex', 'skills', 'rails'))).toBe(false)
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
})

describe('pruneStaleRoleArtifacts', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-prune-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it.each(['claude', 'gemini'] as const)('%s: removes sr-*.md links and copies in agents/ and keeps every other file byte-identical', (provider) => {
    const providerDir = path.join(tmpDir, `.${provider}`)
    const agents = path.join(providerDir, 'agents')
    const target = path.join(tmpDir, 'framework-role.md')
    writeFileLf(target, 'framework role\n')
    writeFileLf(path.join(agents, 'custom-serena.md'), 'custom\n')
    symlinkSync(target, path.join(agents, `${legacyRole('developer')}.md`), 'file')
    writeFileLf(path.join(agents, `${legacyRole('reviewer')}.md`), 'copied role\n')
    writeFileLf(path.join(agents, 'notes.md'), 'notes\n')
    writeFileLf(path.join(agents, 'sr-role.txt'), 'not markdown\n')
    writeFileLf(path.join(agents, legacyRole('architect'), 'README.md'), 'a directory, not a role file\n')

    pruneStaleRoleArtifacts(providerDir, provider)

    expect(readdirSync(agents).sort()).toEqual(['custom-serena.md', 'notes.md', legacyRole('architect'), 'sr-role.txt'].sort())
    expect(readTextFile(path.join(agents, 'custom-serena.md'))).toBe('custom\n')
    expect(readTextFile(target)).toBe('framework role\n')
  })

  it('codex: removes skills/rails/sr-* and the emptied rails/ container, never a custom-* rail', () => {
    const providerDir = path.join(tmpDir, '.codex')
    const rails = path.join(providerDir, 'skills', 'rails')
    writeFileLf(path.join(rails, legacyRole('developer'), 'SKILL.md'), 'old rail\n')
    writeFileLf(path.join(rails, legacyRole('reviewer'), 'SKILL.md'), 'old rail\n')
    writeFileLf(path.join(providerDir, 'skills', 'implement', 'SKILL.md'), 'workflow\n')

    pruneStaleRoleArtifacts(providerDir, 'codex')
    expect(pathExists(rails)).toBe(false)
    expect(readTextFile(path.join(providerDir, 'skills', 'implement', 'SKILL.md'))).toBe('workflow\n')

    // A custom rail keeps the container alive and stays byte-identical.
    writeFileLf(path.join(rails, legacyRole('developer'), 'SKILL.md'), 'old rail\n')
    writeFileLf(path.join(rails, 'custom-x', 'SKILL.md'), 'custom rail\n')
    pruneStaleRoleArtifacts(providerDir, 'codex')
    expect(readdirSync(rails)).toEqual(['custom-x'])
    expect(readTextFile(path.join(rails, 'custom-x', 'SKILL.md'))).toBe('custom rail\n')
  })

  it('codex: never prunes through a skills/ symlink into the shared framework', () => {
    const framework = path.join(tmpDir, 'framework', '.codex', 'skills')
    writeFileLf(path.join(framework, 'rails', legacyRole('developer'), 'SKILL.md'), 'framework-owned\n')
    const providerDir = path.join(tmpDir, '.codex')
    writeFileLf(path.join(providerDir, '.keep'), '')
    symlinkSync(framework, path.join(providerDir, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')

    pruneStaleRoleArtifacts(providerDir, 'codex')
    expect(readTextFile(path.join(framework, 'rails', legacyRole('developer'), 'SKILL.md'))).toBe('framework-owned\n')
  })

  it('kimi: removes skills/sr-* (links and dirs) and keeps custom-*, openspec-* and workflow skills', () => {
    const providerDir = path.join(tmpDir, '.kimi-code')
    const skills = path.join(providerDir, 'skills')
    const target = path.join(tmpDir, 'framework-skill')
    writeFileLf(path.join(target, 'SKILL.md'), 'framework role\n')
    writeFileLf(path.join(skills, 'custom-auditor', 'SKILL.md'), 'custom\n')
    symlinkSync(target, path.join(skills, legacyRole('architect')), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileLf(path.join(skills, legacyRole('reviewer'), 'SKILL.md'), 'copied role\n')
    writeFileLf(path.join(skills, 'openspec-apply-change', 'SKILL.md'), 'openspec\n')
    writeFileLf(path.join(skills, 'specrails-implement', 'SKILL.md'), 'workflow\n')

    pruneStaleRoleArtifacts(providerDir, 'kimi')

    expect(readdirSync(skills).sort()).toEqual(['custom-auditor', 'openspec-apply-change', 'specrails-implement'])
    expect(readTextFile(path.join(skills, 'custom-auditor', 'SKILL.md'))).toBe('custom\n')
    expect(readTextFile(path.join(target, 'SKILL.md'))).toBe('framework role\n')
  })

  it('is a no-op on a workspace without the subtree', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'kimi'] as const) {
      const providerDir = path.join(tmpDir, provider)
      expect(() => pruneStaleRoleArtifacts(providerDir, provider)).not.toThrow()
      expect(pathExists(providerDir)).toBe(false)
    }
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
  }

  it('renders directory workflows without Claude invocation syntax and no role skill', () => {
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
    expect(workflow).not.toContain('/specrails:')
    expect(workflow).not.toContain('/skill:')
    expect(workflow).not.toContain('subagent_type')
    expect(workflow).not.toContain('.claude/')

    // Roles are runtime-defined: only workflow skills are rendered.
    expect(readdirSync(path.join(repoRoot, '.kimi-code', 'skills')).sort()).toEqual(['specrails-implement', 'specrails-retry', 'specrails-unknown-ph'])
    expect(pathExists(path.join(repoRoot, '.kimi-code', 'agent-memory'))).toBe(false)

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

  it('rematerializes a same-version framework that still has role skills from an older build', () => {
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
    writeFileLf(path.join(skillsDir, legacyRole('architect'), 'SKILL.md'), 'role-from-an-older-build\n')
    writeFileLf(
      path.join(skillsDir, 'rails', legacyRole('architect'), 'SKILL.md'),
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
    expect(pathExists(path.join(skillsDir, legacyRole('architect')))).toBe(false)
    expect(pathExists(path.join(skillsDir, 'specrails-implement', 'SKILL.md'))).toBe(true)

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
    // A role skill an older Core linked into the flat layout.
    writeFileLf(path.join(workspace, '.kimi-code', 'skills', legacyRole('architect'), 'SKILL.md'), 'old role\n')

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
    expect(pathExists(path.join(workspace, '.kimi-code', 'skills', legacyRole('architect')))).toBe(false)
    expect(pathExists(path.join(workspace, '.kimi-code', 'agent-memory'))).toBe(false)
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
        'Skill("opsx:sync") /specrails:why /sr:implement .claude/agents/custom-reviewer.md subagent_type',
      ),
    ).toBe(
      'Skill(skill="openspec-sync-specs", args="") ' +
        'Skill(skill="specrails-why", args=<arguments following this command>) ' +
        'Skill(skill="specrails-implement", args=<arguments following this command>) ' +
        '.kimi-code/skills/custom-reviewer/SKILL.md role_skill',
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

    // The real package ships no role template, so no `sr-*` skill is rendered.
    expect(pathExists(path.join(scriptDir, 'templates', 'agents'))).toBe(false)
    expect(generatedSkillDirs.map((entry) => path.basename(entry)).filter((name) => name.startsWith('sr-'))).toEqual([])

    const allSkillFiles = workflows.map((name) => path.join(workflowRoot, name, 'SKILL.md'))
    for (const skillFile of allSkillFiles) {
      const rendered = readTextFile(skillFile)
      expect(rendered).toMatch(/^---\nname: [^\n]+\ndescription: [^\n]+\ntype: prompt\n---\n/)
      expect(rendered).not.toContain('.claude')
      expect(rendered).not.toContain('/specrails:')
      expect(rendered).not.toContain('/skill:')
      expect(rendered).not.toContain('subagent_type')
      expect(rendered).not.toContain('Skill("opsx:')
      expect(rendered).not.toContain('## Kimi runtime context contract')
      expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/)
    }
    const implement = readTextFile(
      path.join(workflowRoot, 'specrails-implement', 'SKILL.md'),
    )
    expect(implement).toContain('agent-runtime.mjs run --context')
    expect(implement).not.toContain('AGENT_MODEL')
    expect(implement).not.toContain('--role-wave-file')
    // implement owns multi-ticket aggregate runs; no separate batch workflow ships.
    expect(implement).toContain('Multiple tickets share one aggregate context and one runtime invocation')
    expect(pathExists(path.join(workflowRoot, 'specrails-batch-implement'))).toBe(false)

    const retry = readTextFile(
      path.join(workflowRoot, 'specrails-retry', 'SKILL.md'),
    )
    expect(retry).toContain('agent-runtime.mjs resume --context')
    expect(retry).not.toContain('--role-wave-file')
    expect(retry).toContain('The runtime selects the next phase')
    expect(retry).not.toContain('`KIMI_ROLE_WAVE`')


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
    expect(largestMaterializedPrompt).toBeGreaterThan(0)
  })
})
