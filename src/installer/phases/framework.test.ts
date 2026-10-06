import { cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as filesystem from '../util/fs.js'
import { isDir, isSymlink, pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import {
  assembleProjectWorkspace,
  ensureCurrentSymlink,
  frameworkStampPath,
  installFramework,
} from './scaffold.js'

/**
 * Unit tests for the bundled-framework split:
 *   installFramework (idempotent, versioned static materialization)
 *   ensureCurrentSymlink (atomic `current` swap)
 *   assembleProjectWorkspace (symlink static subtrees + seed project layer)
 *
 * These exercise the functions directly (no init/update orchestration) so the
 * idempotency + link/seed invariants are pinned independently of the CLI flow.
 *
 * Platform-aware: `symlinkOrCopy` returns 'symlink' on POSIX, but on Windows a
 * DIRECTORY link is a 'junction'. So dir-link assertions accept
 * symlink|junction — the stronger POSIX-only symlink checks stay guarded
 * behind `!IS_WIN` so POSIX coverage is never weakened.
 */

const IS_WIN = process.platform === 'win32'
const DIR_LINK = IS_WIN ? 'junction' : 'symlink'

function setupFakeScriptDir(scriptDir: string): void {
  writeFileLf(path.join(scriptDir, 'package.json'), `${JSON.stringify({ version: '5.0.0' })}\n`)
  writeFileLf(path.join(scriptDir, 'templates', 'commands', 'specrails', 'implement.md'), '/specrails:implement\n')
}

/** Relative path of the one managed workflow file inside a claude framework/workspace. */
const IMPLEMENT = path.join('commands', 'specrails', 'implement.md')

/** A role id an older Core shipped; composed so the retired names never appear literally. */
const legacyRole = (role: string): string => `sr-${role}`

/**
 * Lay out what an older Core (≤ 6.2) left in a workspace `agents/` dir: a
 * per-file symlink and a Windows copy-fallback regular file for framework roles,
 * next to a user-owned `custom-*` agent that must survive byte-identical.
 */
function seedStaleClaudeRoles(agentsDir: string): { custom: string; customContent: string } {
  const customContent = '# custom serena\nuser-authored content\n'
  const custom = path.join(agentsDir, 'custom-serena.md')
  writeFileLf(custom, customContent)
  const linkTarget = path.join(path.dirname(agentsDir), 'old-framework-developer.md')
  writeFileLf(linkTarget, '# linked developer (old framework)\n')
  symlinkSync(linkTarget, path.join(agentsDir, `${legacyRole('developer')}.md`), 'file')
  writeFileLf(path.join(agentsDir, `${legacyRole('reviewer')}.md`), '# copied reviewer (old framework)\n')
  return { custom, customContent }
}

describe('bundled framework — installFramework / ensureCurrentSymlink / assembleProjectWorkspace', () => {
  let tmpDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-framework-test-'))
    // Nothing may write to the real home dir — redirect it to prove that.
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    const fakeHome = path.join(tmpDir, 'fake-home')
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  describe('installFramework', () => {
    it('refreshes a framework under Unicode paths without losing sibling provider bytes', () => {
      const scriptDir = path.join(tmpDir, 'Paquete español')
      const fwDir = path.join(tmpDir, 'José User Home', 'framework')
      setupFakeScriptDir(scriptDir)
      const input = {
        scriptDir, frameworkDir: fwDir, provider: 'claude' as const,
        providerDir: '.claude', version: '5.0.0',
      }
      installFramework(input)
      const sibling = path.join(fwDir, '5.0.0', '.codex', 'skills', 'Guía', '契約.md')
      writeFileLf(sibling, 'unchanged sibling provider instructions')
      writeFileLf(path.join(scriptDir, 'templates', IMPLEMENT), '# updated implement')
      expect(installFramework(input).materialized).toBe(true)
      expect(readTextFile(path.join(fwDir, '5.0.0', '.claude', IMPLEMENT)))
        .toBe('# updated implement')
      expect(readTextFile(sibling)).toBe('unchanged sibling provider instructions')
    })

    it('materializes the provider-static subtree once under <frameworkDir>/<version>/<providerDir>', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      setupFakeScriptDir(scriptDir)

      const res = installFramework({
        scriptDir,
        frameworkDir: fwDir,
        provider: 'claude',
        providerDir: '.claude',
        version: '5.0.0',
      })

      expect(res.materialized).toBe(true)
      const fwClaude = path.join(fwDir, '5.0.0', '.claude')
      expect(isDir(path.join(fwClaude, 'commands', 'specrails'))).toBe(true)
      expect(pathExists(path.join(fwClaude, IMPLEMENT))).toBe(true)
      expect(pathExists(path.join(fwClaude, 'rules'))).toBe(false)
      // Roles are runtime-defined: the framework store carries no agents/ subtree.
      expect(pathExists(path.join(fwClaude, 'agents'))).toBe(false)
      // setup-templates is materialized at the version root.
      expect(isDir(path.join(fwDir, '5.0.0', '.specrails', 'setup-templates', 'commands'))).toBe(true)
      expect(pathExists(path.join(fwDir, '5.0.0', '.specrails', 'setup-templates', 'agents'))).toBe(false)
      // The framework copy carries NO per-workspace state: no agent-memory dir,
      // and the project-named instruction file is stripped.
      expect(pathExists(path.join(fwClaude, 'agent-memory'))).toBe(false)
      expect(pathExists(path.join(fwDir, '5.0.0', 'CLAUDE.md'))).toBe(false)
    })

    it('is idempotent with a deterministic stamp and repairs same-version corruption', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      setupFakeScriptDir(scriptDir)

      const first = installFramework({
        scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0',
      })
      expect(first.materialized).toBe(true)

      const archPath = path.join(fwDir, '5.0.0', '.claude', IMPLEMENT)
      const stampPath = frameworkStampPath(path.join(fwDir, '5.0.0'), '.claude')
      const firstStamp = readTextFile(stampPath)

      // An unchanged retry is a true no-op and the stamp is byte-deterministic
      // (there is no install timestamp churn).
      const unchanged = installFramework({
        scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0',
      })
      expect(unchanged.materialized).toBe(false)
      expect(readTextFile(stampPath)).toBe(firstStamp)

      // Corrupt a managed byte at the SAME version. The content hash must force
      // a clean repair, restoring both output and the original deterministic
      // stamp rather than trusting stamp existence alone.
      writeFileLf(archPath, 'TAMPERED')

      const repaired = installFramework({
        scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0',
      })
      expect(repaired.materialized).toBe(true)
      expect(readTextFile(archPath)).toContain('/specrails:implement')
      expect(readTextFile(stampPath)).toBe(firstStamp)
    })

    it('keeps the live framework and prior stamp when same-version generation fails', () => {
      const scriptDir = path.join(tmpDir, 'core-failure')
      const fwDir = path.join(tmpDir, 'framework-failure')
      setupFakeScriptDir(scriptDir)
      const input = { scriptDir, frameworkDir: fwDir, provider: 'claude' as const, providerDir: '.claude', version: '5.0.0' }
      installFramework(input)
      ensureCurrentSymlink(fwDir, '5.0.0')
      const live = path.join(fwDir, 'current', '.claude', IMPLEMENT)
      const original = readTextFile(live)
      const stamp = readTextFile(frameworkStampPath(path.join(fwDir, '5.0.0'), '.claude'))
      writeFileLf(path.join(scriptDir, 'templates', IMPLEMENT), '# replacement')
      const write = filesystem.writeFileLf
      vi.spyOn(filesystem, 'writeFileLf').mockImplementation((file, contents) => {
        if (file.includes('.materialize-') && file.includes('.framework-stamp')) throw new Error('fixture disk write failed')
        return write(file, contents)
      })
      expect(() => installFramework(input)).toThrow('fixture disk write failed')
      expect(readTextFile(live)).toBe(original)
      expect(readTextFile(frameworkStampPath(path.join(fwDir, '5.0.0'), '.claude'))).toBe(stamp)
      expect(readdirSync(fwDir).some(name => name.startsWith('.materialize-'))).toBe(false)
    })

    it('refreshes changed runtime bytes at the same version and retains the prior framework', () => {
      const scriptDir = path.join(tmpDir, 'core-runtime')
      const fwDir = path.join(tmpDir, 'framework-runtime')
      setupFakeScriptDir(scriptDir)
      const runtime = path.join(scriptDir, 'dist', 'pipeline', 'pipeline-state.js')
      writeFileLf(runtime, '// first runtime')
      const input = { scriptDir, frameworkDir: fwDir, provider: 'claude' as const, providerDir: '.claude', version: '5.0.0' }
      installFramework(input)
      writeFileLf(runtime, '// second runtime')
      expect(installFramework(input).materialized).toBe(true)
      expect(readTextFile(path.join(fwDir, '5.0.0', '.specrails', 'runtime', 'pipeline-state.mjs'))).toContain('second runtime')
      const previous = readdirSync(fwDir).find(name => name.startsWith('.previous-5.0.0-'))!
      expect(previous).toBeTruthy()
      expect(readTextFile(path.join(fwDir, previous, '.specrails', 'runtime', 'pipeline-state.mjs'))).toContain('first runtime')
    })

    it('repairs a missing managed file at the same version', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      setupFakeScriptDir(scriptDir)

      installFramework({
        scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0',
      })
      const implementPath = path.join(fwDir, '5.0.0', '.claude', IMPLEMENT)
      rmSync(implementPath)
      expect(pathExists(implementPath)).toBe(false)

      const repaired = installFramework({
        scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0',
      })
      expect(repaired.materialized).toBe(true)
      expect(readTextFile(implementPath)).toContain('/specrails:implement')
    })

    it('materializes a codex framework with config.toml but no project-named AGENTS.md', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      setupFakeScriptDir(scriptDir)
      writeFileLf(path.join(scriptDir, 'templates', 'settings', 'codex-config.toml'), 'model = "{{MODEL_NAME}}"\n')

      installFramework({
        scriptDir, frameworkDir: fwDir, provider: 'codex', providerDir: '.codex', version: '5.0.0',
      })

      const fwCodex = path.join(fwDir, '5.0.0', '.codex')
      expect(pathExists(path.join(fwCodex, 'config.toml'))).toBe(true)
      expect(readTextFile(path.join(fwCodex, 'config.toml'))).toContain('gpt-5.5-mini')
      // The project-named AGENTS.md is NOT part of the shared copy.
      expect(pathExists(path.join(fwDir, '5.0.0', 'AGENTS.md'))).toBe(false)
    })
  })

  describe('installFramework — no role artifact for any provider', () => {
    it.each([
      ['claude', '.claude', ['agents']],
      ['codex', '.codex', [path.join('skills', 'rails')]],
      ['gemini', '.gemini', ['agents']],
      ['kimi', '.kimi-code', []],
    ] as const)('%s framework has commands and runtime but no role subtree', (provider, providerDir, retired) => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      setupFakeScriptDir(scriptDir)
      writeFileLf(path.join(scriptDir, 'templates', 'kimi', 'specrails', 'run-skill.mjs'), '// runner\n')
      for (const vendored of ['js-yaml.mjs', 'LICENSE', 'NOTICE.md']) {
        writeFileLf(path.join(scriptDir, 'templates', 'kimi', 'specrails', 'vendor', 'js-yaml', vendored), '// vendored\n')
      }

      installFramework({ scriptDir, frameworkDir: fwDir, provider, providerDir, version: '5.0.0' })

      const fwProvider = path.join(fwDir, '5.0.0', providerDir)
      for (const relative of retired) expect(pathExists(path.join(fwProvider, relative)), relative).toBe(false)
      expect(pathExists(path.join(fwProvider, 'agent-memory'))).toBe(false)
      const skills = path.join(fwProvider, 'skills')
      // `sr-implement` is the claude workflow skill, not a role.
      const roleDirs = isDir(skills) ? readdirSync(skills).filter((name) => /^sr-(?!implement$)/.test(name)) : []
      expect(roleDirs).toEqual([])
      const workflow = provider === 'claude' ? IMPLEMENT
        : provider === 'codex' ? path.join('skills', 'implement', 'SKILL.md')
          : provider === 'gemini' ? path.join('commands', 'specrails', 'implement.toml')
            : path.join('skills', 'specrails-implement', 'SKILL.md')
      expect(pathExists(path.join(fwProvider, workflow)), workflow).toBe(true)
    })

    it('swapCurrent:false materializes WITHOUT swapping current (multi-provider safety)', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      setupFakeScriptDir(scriptDir)

      // First version exists + current points at it.
      installFramework({ scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0' })
      ensureCurrentSymlink(fwDir, '5.0.0')
      expect(realpathSync(path.join(fwDir, 'current'))).toBe(realpathSync(path.join(fwDir, '5.0.0')))

      // Materialize a NEW version WITHOUT swapping — current must stay at 5.0.0.
      installFramework({ scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '6.0.0' })
      // (installFramework itself never swaps; the swap lives in ensureFramework /
      // ensureCurrentSymlink. Assert current is untouched until we swap.)
      expect(realpathSync(path.join(fwDir, 'current'))).toBe(realpathSync(path.join(fwDir, '5.0.0')))
      expect(isDir(path.join(fwDir, '6.0.0', '.claude', 'commands'))).toBe(true)

      // Now the single explicit swap makes 6.0.0 visible.
      ensureCurrentSymlink(fwDir, '6.0.0')
      expect(realpathSync(path.join(fwDir, 'current'))).toBe(realpathSync(path.join(fwDir, '6.0.0')))
    })
  })

  describe('ensureCurrentSymlink', () => {
    it('points current at the version dir and swaps atomically to a new version', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      setupFakeScriptDir(scriptDir)

      installFramework({ scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0' })
      ensureCurrentSymlink(fwDir, '5.0.0')
      expect(realpathSync(path.join(fwDir, 'current'))).toBe(realpathSync(path.join(fwDir, '5.0.0')))

      // Materialize a second version alongside, then swap — one rename updates all.
      installFramework({ scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '6.0.0' })
      ensureCurrentSymlink(fwDir, '6.0.0')
      expect(realpathSync(path.join(fwDir, 'current'))).toBe(realpathSync(path.join(fwDir, '6.0.0')))
      // The old version dir is NOT destroyed (non-destructive side-by-side).
      expect(isDir(path.join(fwDir, '5.0.0', '.claude', 'commands'))).toBe(true)
    })
  })

  describe('assembleProjectWorkspace', () => {
    function materialize(fwDir: string, scriptDir: string, version = '5.0.0'): void {
      installFramework({ scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version })
      ensureCurrentSymlink(fwDir, version)
    }

    it('symlinks static subtrees + seeds the project layer as real files', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      const ws = path.join(tmpDir, 'ws')
      const repo = path.join(tmpDir, 'repo')
      setupFakeScriptDir(scriptDir)
      materialize(fwDir, scriptDir)

      const res = assembleProjectWorkspace({
        workspace: ws, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '5.0.0', codeRoot: repo, scriptDir,
      })

      // commands/ is a whole-dir link into framework/current (symlink on
      // POSIX, junction on Windows). Assert they RESOLVE to the framework — the
      // realpath check holds for both link kinds.
      expect(realpathSync(path.join(ws, '.claude', 'commands'))).toBe(
        realpathSync(path.join(fwDir, 'current', '.claude', 'commands')),
      )
      expect(res.links['commands']).toBe(DIR_LINK)
      expect(res.links['rules']).toBeUndefined()
      expect(res.links['agents']).toBeUndefined()
      expect(readTextFile(path.join(ws, '.claude', IMPLEMENT))).toBe('/specrails:implement\n')
      // Roles are runtime-defined: no agents/ dir, no role file, no agent-memory.
      expect(pathExists(path.join(ws, '.claude', 'agents'))).toBe(false)
      expect(pathExists(path.join(ws, '.claude', 'agent-memory'))).toBe(false)
      // manifest records the framework version.
      expect(readFileSync(path.join(ws, '.specrails', 'specrails-version'), 'utf8').trim()).toBe('5.0.0')
    })

    it('preserves a pre-existing custom-*.md agent (reserved path) and adds nothing next to it', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      const ws = path.join(tmpDir, 'ws')
      const repo = path.join(tmpDir, 'repo')
      setupFakeScriptDir(scriptDir)
      materialize(fwDir, scriptDir)
      writeFileLf(path.join(ws, '.claude', 'agents', 'custom-reviewer.md'), 'USER CONTENT')

      assembleProjectWorkspace({
        workspace: ws, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '5.0.0', codeRoot: repo, scriptDir,
      })

      expect(readTextFile(path.join(ws, '.claude', 'agents', 'custom-reviewer.md'))).toBe('USER CONTENT')
      expect(lstatSync(path.join(ws, '.claude', 'agents', 'custom-reviewer.md')).isSymbolicLink()).toBe(false)
      // The user's dir is the only thing in agents/: no framework role joins it.
      expect(readdirSync(path.join(ws, '.claude', 'agents'))).toEqual(['custom-reviewer.md'])
    })

    it('two projects SHARE one framework copy — the second assemble does not re-materialize', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      const wsA = path.join(tmpDir, 'wsA')
      const wsB = path.join(tmpDir, 'wsB')
      setupFakeScriptDir(scriptDir)

      const first = installFramework({ scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0' })
      ensureCurrentSymlink(fwDir, '5.0.0')
      expect(first.materialized).toBe(true)

      assembleProjectWorkspace({
        workspace: wsA, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '5.0.0', codeRoot: path.join(tmpDir, 'repoA'), scriptDir,
      })
      // A SECOND project: installFramework is a no-op (idempotent share).
      const second = installFramework({ scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0' })
      expect(second.materialized).toBe(false)
      assembleProjectWorkspace({
        workspace: wsB, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '5.0.0', codeRoot: path.join(tmpDir, 'repoB'), scriptDir,
      })

      // The SHARED property holds on BOTH platforms: the framework store is
      // materialized exactly once (second install was a no-op, asserted above)
      // and both workspaces' command dirs resolve to the SAME framework copy.
      const wsACommands = path.join(wsA, '.claude', 'commands')
      const wsBCommands = path.join(wsB, '.claude', 'commands')
      expect(readTextFile(path.join(wsACommands, 'specrails', 'implement.md')))
        .toBe(readTextFile(path.join(wsBCommands, 'specrails', 'implement.md')))
      expect(realpathSync(wsACommands)).toBe(realpathSync(wsBCommands))
    })

    it('re-assemble after a version swap re-points the links and prunes the roles an older Core left', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      const ws = path.join(tmpDir, 'ws')
      const repo = path.join(tmpDir, 'repo')
      setupFakeScriptDir(scriptDir)
      materialize(fwDir, scriptDir, '5.0.0')
      assembleProjectWorkspace({
        workspace: ws, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '5.0.0', codeRoot: repo, scriptDir,
      })
      // An older Core linked/copied role files into agents/ next to a user agent.
      const wsAgents = path.join(ws, '.claude', 'agents')
      const { custom, customContent } = seedStaleClaudeRoles(wsAgents)
      expect(readdirSync(wsAgents).sort()).toEqual(['custom-serena.md', `${legacyRole('developer')}.md`, `${legacyRole('reviewer')}.md`])

      writeFileLf(path.join(scriptDir, 'templates', IMPLEMENT), '/specrails:implement v6\n')
      materialize(fwDir, scriptDir, '6.0.0')
      assembleProjectWorkspace({
        workspace: ws, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '6.0.0', codeRoot: repo, scriptDir,
      })

      // The command link follows the swap (re-pointed on POSIX, refreshed copy on Windows).
      expect(readTextFile(path.join(ws, '.claude', IMPLEMENT))).toBe('/specrails:implement v6\n')
      if (!IS_WIN) {
        expect(realpathSync(path.join(ws, '.claude', 'commands'))).toBe(realpathSync(path.join(fwDir, '6.0.0', '.claude', 'commands')))
      }
      // Only the user's agent remains, byte-identical; both the stale symlink and
      // the copy-fallback regular file are gone.
      expect(readdirSync(wsAgents)).toEqual(['custom-serena.md'])
      expect(readTextFile(custom)).toBe(customContent)
      expect(lstatSync(custom).isSymbolicLink()).toBe(false)
      // The prune removed the links, never their targets.
      expect(readTextFile(path.join(ws, '.claude', 'old-framework-developer.md'))).toBe('# linked developer (old framework)\n')
    })

    it('prunes stale role artifacts even when the workspace was never linked before (fresh assemble over an old layout)', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      const ws = path.join(tmpDir, 'ws-old')
      const repo = path.join(tmpDir, 'repo-old')
      setupFakeScriptDir(scriptDir)
      materialize(fwDir, scriptDir)
      const wsAgents = path.join(ws, '.claude', 'agents')
      const { custom, customContent } = seedStaleClaudeRoles(wsAgents)
      // Unknown names are user files too: never touched.
      writeFileLf(path.join(wsAgents, 'notes.md'), 'my notes\n')
      writeFileLf(path.join(wsAgents, 'sr-role.txt'), 'not a role file\n')

      assembleProjectWorkspace({
        workspace: ws, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '5.0.0', codeRoot: repo, scriptDir,
      })

      expect(readdirSync(wsAgents).sort()).toEqual(['custom-serena.md', 'notes.md', 'sr-role.txt'])
      expect(readTextFile(custom)).toBe(customContent)
    })

    it('prunes gemini role files and seeds no acknowledgment or agent-memory', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      const ws = path.join(tmpDir, 'ws-gem')
      const repo = path.join(tmpDir, 'repo-gem')
      setupFakeScriptDir(scriptDir)
      writeFileLf(path.join(scriptDir, 'templates', 'settings', 'gemini-settings.json'), '{\n  "experimental": { "enableAgents": true }\n}\n')
      const wsAgents = path.join(ws, '.gemini', 'agents')
      const { custom, customContent } = seedStaleClaudeRoles(wsAgents)

      installFramework({ scriptDir, frameworkDir: fwDir, provider: 'gemini', providerDir: '.gemini', version: '5.0.0' })
      ensureCurrentSymlink(fwDir, '5.0.0')
      const res = assembleProjectWorkspace({
        workspace: ws, frameworkDir: fwDir, provider: 'gemini', providerDir: '.gemini',
        version: '5.0.0', codeRoot: repo, scriptDir,
      })

      expect(res.links['commands']).toBe(DIR_LINK)
      expect(res.links['agents']).toBeUndefined()
      expect(pathExists(path.join(ws, 'GEMINI.md'))).toBe(true)
      expect(pathExists(path.join(ws, '.gemini', 'commands', 'specrails', 'implement.toml'))).toBe(true)
      expect(readdirSync(wsAgents)).toEqual(['custom-serena.md'])
      expect(readTextFile(custom)).toBe(customContent)
      expect(pathExists(path.join(ws, '.gemini', 'agent-memory'))).toBe(false)
      // No headless acknowledgment is written any more (nothing to acknowledge).
      expect(pathExists(path.join(os.homedir(), '.gemini'))).toBe(false)
    })

    it('prunes codex rails and kimi role skills while custom-* skills stay byte-identical', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      setupFakeScriptDir(scriptDir)
      writeFileLf(path.join(scriptDir, 'templates', 'settings', 'codex-config.toml'), 'model = "{{MODEL_NAME}}"\n')
      writeFileLf(path.join(scriptDir, 'templates', 'kimi', 'specrails', 'run-skill.mjs'), '// runner\n')
      for (const vendored of ['js-yaml.mjs', 'LICENSE', 'NOTICE.md']) {
        writeFileLf(path.join(scriptDir, 'templates', 'kimi', 'specrails', 'vendor', 'js-yaml', vendored), '// vendored\n')
      }
      for (const [provider, providerDir] of [['codex', '.codex'], ['kimi', '.kimi-code']] as const) {
        installFramework({ scriptDir, frameworkDir: fwDir, provider, providerDir, version: '5.0.0' })
      }
      ensureCurrentSymlink(fwDir, '5.0.0')

      // Kimi: a flat `skills/` dir mixing an old role, a user role and an OpenSpec skill.
      const wsKimi = path.join(tmpDir, 'ws-kimi')
      const kimiSkills = path.join(wsKimi, '.kimi-code', 'skills')
      writeFileLf(path.join(kimiSkills, legacyRole('architect'), 'SKILL.md'), 'old role\n')
      writeFileLf(path.join(kimiSkills, 'custom-auditor', 'SKILL.md'), 'custom-role-byte-content\n')
      writeFileLf(path.join(kimiSkills, 'openspec-apply-change', 'SKILL.md'), 'openspec\n')
      assembleProjectWorkspace({
        workspace: wsKimi, frameworkDir: fwDir, provider: 'kimi', providerDir: '.kimi-code',
        version: '5.0.0', codeRoot: path.join(tmpDir, 'repo-kimi'), scriptDir,
      })
      expect(pathExists(path.join(kimiSkills, legacyRole('architect')))).toBe(false)
      expect(readTextFile(path.join(kimiSkills, 'custom-auditor', 'SKILL.md'))).toBe('custom-role-byte-content\n')
      expect(readTextFile(path.join(kimiSkills, 'openspec-apply-change', 'SKILL.md'))).toBe('openspec\n')
      expect(pathExists(path.join(kimiSkills, 'specrails-implement', 'SKILL.md'))).toBe(true)
      expect(pathExists(path.join(wsKimi, '.kimi-code', 'agent-memory'))).toBe(false)

      // Codex: an in-repo copy whose `skills/` is a real dir still holding rails.
      const wsCodex = path.join(tmpDir, 'ws-codex')
      const codexSkills = path.join(wsCodex, '.codex', 'skills')
      writeFileLf(path.join(codexSkills, 'rails', legacyRole('developer'), 'SKILL.md'), 'old rail\n')
      assembleProjectWorkspace({
        workspace: wsCodex, frameworkDir: fwDir, provider: 'codex', providerDir: '.codex',
        version: '5.0.0', codeRoot: path.join(tmpDir, 'repo-codex'), scriptDir, copyStatics: true,
      })
      expect(pathExists(path.join(codexSkills, 'rails'))).toBe(false)
      expect(pathExists(path.join(codexSkills, 'implement', 'SKILL.md'))).toBe(true)
      expect(isSymlink(codexSkills)).toBe(false)
    })

    describe('retired batch-implement workflow is pruned from installed workspaces', () => {
      const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
      const PROVIDERS = [
        { provider: 'claude', providerDir: '.claude' },
        { provider: 'codex', providerDir: '.codex' },
        { provider: 'gemini', providerDir: '.gemini' },
        { provider: 'kimi', providerDir: '.kimi-code' },
      ] as const
      // Every provider artifact a pre-6.1 Core rendered for batch-implement.
      function batchArtifacts(ws: string, provider: string, providerDir: string): string[] {
        const root = path.join(ws, providerDir)
        if (provider === 'claude') {
          return [path.join(root, 'commands', 'specrails', 'batch-implement.md'), path.join(root, 'skills', 'sr-batch-implement')]
        }
        if (provider === 'codex') return [path.join(root, 'skills', 'batch-implement')]
        if (provider === 'gemini') return [path.join(root, 'commands', 'specrails', 'batch-implement.toml')]
        return [path.join(root, 'skills', 'specrails-batch-implement')]
      }
      function implementArtifact(ws: string, provider: string, providerDir: string): string {
        const root = path.join(ws, providerDir)
        if (provider === 'claude') return path.join(root, 'commands', 'specrails', 'implement.md')
        if (provider === 'codex') return path.join(root, 'skills', 'implement', 'SKILL.md')
        if (provider === 'gemini') return path.join(root, 'commands', 'specrails', 'implement.toml')
        return path.join(root, 'skills', 'specrails-implement', 'SKILL.md')
      }

      for (const { provider, providerDir } of PROVIDERS) {
        for (const copyStatics of [false, true]) {
          it(`${provider} ${copyStatics ? 'in-repo copy' : 'relocated link'}: an update drops batch-implement and keeps reserved paths`, () => {
            const scriptDir = path.join(tmpDir, 'core')
            const fwDir = path.join(tmpDir, 'framework')
            const ws = path.join(tmpDir, 'ws')
            const repo = path.join(tmpDir, 'repo')
            // A pre-6.1 package: the real templates plus the retired command,
            // which was byte-identical to implement.md.
            cpSync(path.join(coreRoot, 'templates'), path.join(scriptDir, 'templates'), { recursive: true })
            writeFileLf(path.join(scriptDir, 'package.json'), `${JSON.stringify({ version: '6.0.0' })}\n`)
            const retired = path.join(scriptDir, 'templates', 'commands', 'specrails', 'batch-implement.md')
            writeFileLf(retired, readTextFile(path.join(scriptDir, 'templates', 'commands', 'specrails', 'implement.md')))
            const assemble = (version: string) => {
              installFramework({ scriptDir, frameworkDir: fwDir, provider, providerDir, version })
              // Pre-6.1 Core also generated a Claude `sr-batch-implement` skill from
              // the command; this Core no longer has that mapping, so seed it the way
              // the old materialization wrote it.
              if (provider === 'claude' && version === '6.0.0') {
                writeFileLf(path.join(fwDir, version, providerDir, 'skills', 'sr-batch-implement', 'SKILL.md'), '---\nname: sr-batch-implement\n---\n')
              }
              ensureCurrentSymlink(fwDir, version)
              assembleProjectWorkspace({ workspace: ws, frameworkDir: fwDir, provider, providerDir, version, codeRoot: repo, scriptDir, copyStatics })
            }

            assemble('6.0.0')
            for (const artifact of batchArtifacts(ws, provider, providerDir)) expect(pathExists(artifact), artifact).toBe(true)

            // Desktop-owned reserved regions and an unmanaged user skill.
            const reserved: Array<[string, string]> = [
              [path.join(ws, '.specrails', 'profiles', 'team.json'), '{"name":"team"}\n'],
              [path.join(ws, '.specrails', 'profiles', 'env', 'prod.json'), '{"env":"prod"}\n'],
            ]
            if (provider === 'claude' || provider === 'gemini') {
              reserved.push([path.join(ws, providerDir, 'agents', 'custom-reviewer.md'), '# custom reviewer\n'])
            }
            if (provider === 'kimi') {
              reserved.push([path.join(ws, providerDir, 'skills', 'custom-reviewer', 'SKILL.md'), '# custom role\n'])
              reserved.push([path.join(ws, providerDir, 'skills', 'my-notes', 'SKILL.md'), '# user skill\n'])
            }
            for (const [file, content] of reserved) writeFileLf(file, content)

            // 6.1 no longer ships the command; updating re-assembles the workspace.
            rmSync(retired)
            writeFileLf(path.join(scriptDir, 'package.json'), `${JSON.stringify({ version: '6.1.0' })}\n`)
            assemble('6.1.0')

            for (const artifact of batchArtifacts(ws, provider, providerDir)) expect(pathExists(artifact), artifact).toBe(false)
            for (const artifact of batchArtifacts(path.join(fwDir, 'current'), provider, providerDir)) expect(pathExists(artifact), artifact).toBe(false)
            expect(pathExists(implementArtifact(ws, provider, providerDir))).toBe(true)
            for (const [file, content] of reserved) expect(readTextFile(file), file).toBe(content)
          })
        }
      }
    })
  })
})
