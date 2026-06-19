import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isDir, isSymlink, pathExists, readTextFile, removePath, writeFileLf } from '../util/fs.js'
import {
  assembleProjectWorkspace,
  ensureCurrentSymlink,
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
 * DIRECTORY link is a 'junction' and a per-FILE link falls back to a 'copy'
 * (Windows file-symlinks need admin/Dev-Mode). So dir-link assertions accept
 * symlink|junction, and per-file agent assertions check placement + content
 * (which holds for symlink OR copy) — the stronger POSIX-only symlink checks
 * stay guarded behind `!IS_WIN` so POSIX coverage is never weakened.
 */

const IS_WIN = process.platform === 'win32'
const DIR_LINK = IS_WIN ? 'junction' : 'symlink'

function setupFakeScriptDir(scriptDir: string): void {
  writeFileLf(path.join(scriptDir, 'package.json'), `${JSON.stringify({ version: '5.0.0' })}\n`)
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'), '# arch\nmemory: {{MEMORY_PATH}}\n')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-developer.md'), '# dev\n')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-reviewer.md'), '# reviewer\n')
  // Optional specialists — NOT in the CORE trio, so they are only linked into a
  // workspace whose selection includes them (exercises the superset+filter split).
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-backend-developer.md'), '# backend\n')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-frontend-developer.md'), '# frontend\n')
  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), '# rules\n')
  writeFileLf(path.join(scriptDir, 'templates', 'commands', 'specrails', 'implement.md'), '/specrails:implement\n')
  writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
}

describe('bundled framework — installFramework / ensureCurrentSymlink / assembleProjectWorkspace', () => {
  let tmpDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-framework-test-'))
    // Gemini acks write ~/.gemini — redirect HOME so the real one is untouched.
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

  describe('installFramework', () => {
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
      expect(isDir(path.join(fwClaude, 'agents'))).toBe(true)
      expect(pathExists(path.join(fwClaude, 'agents', 'sr-architect.md'))).toBe(true)
      expect(isDir(path.join(fwClaude, 'commands', 'specrails'))).toBe(true)
      expect(isDir(path.join(fwClaude, 'rules'))).toBe(true)
      // setup-templates is materialized at the version root (shared enrich cache).
      expect(isDir(path.join(fwDir, '5.0.0', '.specrails', 'setup-templates', 'agents'))).toBe(true)
      // The framework copy carries NO per-workspace state: no agent-memory dir,
      // and the project-named instruction file is stripped.
      expect(pathExists(path.join(fwClaude, 'agent-memory'))).toBe(false)
      expect(pathExists(path.join(fwDir, '5.0.0', 'CLAUDE.md'))).toBe(false)
    })

    it('is idempotent — a second call with a matching stamp does NOT re-materialize', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      setupFakeScriptDir(scriptDir)

      const first = installFramework({
        scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0',
      })
      expect(first.materialized).toBe(true)

      // Tamper with a materialized file; an idempotent skip leaves it as-is.
      const archPath = path.join(fwDir, '5.0.0', '.claude', 'agents', 'sr-architect.md')
      writeFileLf(archPath, 'TAMPERED')

      const second = installFramework({
        scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0',
      })
      expect(second.materialized).toBe(false)
      expect(readTextFile(archPath)).toBe('TAMPERED') // proof it was skipped
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

  describe('installFramework — full superset materialization (fix #3 / fix #4)', () => {
    it('materializes EVERY agent regardless of the input selection', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      setupFakeScriptDir(scriptDir)

      // Caller asks for a NARROW selection — the SHARED store must still be the
      // full superset so a later project can link specialists.
      installFramework({
        scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0',
        selectedAgents: ['sr-architect'],
      })

      const fwAgents = path.join(fwDir, '5.0.0', '.claude', 'agents')
      for (const id of ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-backend-developer', 'sr-frontend-developer']) {
        expect(pathExists(path.join(fwAgents, `${id}.md`))).toBe(true)
      }
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
      expect(isDir(path.join(fwDir, '6.0.0', '.claude', 'agents'))).toBe(true)

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
      expect(isDir(path.join(fwDir, '5.0.0', '.claude', 'agents'))).toBe(true)
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

      // commands/ + rules/ are whole-dir links into framework/current (symlink on
      // POSIX, junction on Windows). Assert they RESOLVE to the framework — the
      // realpath check holds for both link kinds.
      expect(realpathSync(path.join(ws, '.claude', 'commands'))).toBe(
        realpathSync(path.join(fwDir, 'current', '.claude', 'commands')),
      )
      expect(res.links['rules']).toBe(DIR_LINK)
      // agents/ is a REAL dir of per-file links (custom-*.md can coexist).
      expect(isDir(path.join(ws, '.claude', 'agents'))).toBe(true)
      expect(isSymlink(path.join(ws, '.claude', 'agents'))).toBe(false)
      // The framework agent is PLACED with matching content (symlink on POSIX,
      // copy on Windows). On POSIX additionally assert the stronger symlink +
      // realpath-dedup properties.
      const wsArch = path.join(ws, '.claude', 'agents', 'sr-architect.md')
      const fwArch = path.join(fwDir, 'current', '.claude', 'agents', 'sr-architect.md')
      expect(pathExists(wsArch)).toBe(true)
      expect(readTextFile(wsArch)).toBe(readTextFile(fwArch))
      if (!IS_WIN) {
        expect(lstatSync(wsArch).isSymbolicLink()).toBe(true)
        expect(realpathSync(wsArch)).toBe(realpathSync(fwArch))
      }
      // agent-memory/ is a REAL writable dir, never a link.
      expect(isDir(path.join(ws, '.claude', 'agent-memory', 'sr-architect'))).toBe(true)
      expect(isSymlink(path.join(ws, '.claude', 'agent-memory'))).toBe(false)
      expect(res.seededMemoryAgents.sort()).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'])
      // explanations/ created (arch + reviewer are explanation authors).
      expect(isDir(path.join(ws, '.claude', 'agent-memory', 'explanations'))).toBe(true)
      // manifest records the framework version.
      expect(readFileSync(path.join(ws, '.specrails', 'specrails-version'), 'utf8').trim()).toBe('5.0.0')
    })

    it('preserves a pre-existing custom-*.md agent (reserved path) while linking framework agents', () => {
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
      // Framework agents are still linked alongside.
      expect(pathExists(path.join(ws, '.claude', 'agents', 'sr-architect.md'))).toBe(true)
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
      // and both workspaces' agent files carry IDENTICAL content.
      const wsAArch = path.join(wsA, '.claude', 'agents', 'sr-architect.md')
      const wsBArch = path.join(wsB, '.claude', 'agents', 'sr-architect.md')
      expect(readTextFile(wsAArch)).toBe(readTextFile(wsBArch))
      // POSIX: both resolve to the SAME physical framework file (per-file symlink
      // dedup). On Windows the files are independent copies, so realpath differs.
      if (!IS_WIN) {
        expect(realpathSync(wsAArch)).toBe(realpathSync(wsBArch))
      }
      // Each workspace has its OWN real agent-memory dir.
      expect(isDir(path.join(wsA, '.claude', 'agent-memory', 'sr-architect'))).toBe(true)
      expect(isDir(path.join(wsB, '.claude', 'agent-memory', 'sr-architect'))).toBe(true)
    })

    it('re-assemble after a version swap re-points the links and drops stale framework agent links', () => {
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

      // New version drops sr-reviewer from the agent set.
      rmSync(path.join(scriptDir, 'templates', 'agents', 'sr-reviewer.md'), { force: true })
      materialize(fwDir, scriptDir, '6.0.0')
      assembleProjectWorkspace({
        workspace: ws, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '6.0.0', codeRoot: repo, scriptDir,
      })

      // After the swap the workspace agent matches 6.0.0's content (re-pointed
      // link on POSIX, refreshed copy on Windows); the stale sr-reviewer agent is
      // dropped on both platforms.
      const wsArch6 = path.join(ws, '.claude', 'agents', 'sr-architect.md')
      const fwArch6 = path.join(fwDir, '6.0.0', '.claude', 'agents', 'sr-architect.md')
      expect(pathExists(wsArch6)).toBe(true)
      expect(readTextFile(wsArch6)).toBe(readTextFile(fwArch6))
      if (!IS_WIN) {
        expect(realpathSync(wsArch6)).toBe(realpathSync(fwArch6))
      }
      expect(pathExists(path.join(ws, '.claude', 'agents', 'sr-reviewer.md'))).toBe(false)
      // agent-memory persisted across the swap (never linked, never dropped).
      expect(isDir(path.join(ws, '.claude', 'agent-memory', 'sr-architect'))).toBe(true)
    })

    it('two projects with DIFFERENT selections each link their OWN specialists from one superset (fix #3)', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      const wsBackend = path.join(tmpDir, 'ws-backend')
      const wsFrontend = path.join(tmpDir, 'ws-frontend')
      setupFakeScriptDir(scriptDir)
      // Project A installs first with a NARROW selection.
      installFramework({
        scriptDir, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude', version: '5.0.0',
        selectedAgents: ['sr-backend-developer'],
      })
      ensureCurrentSymlink(fwDir, '5.0.0')

      assembleProjectWorkspace({
        workspace: wsBackend, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '5.0.0', codeRoot: path.join(tmpDir, 'repoA'), scriptDir,
        selectedAgents: ['sr-backend-developer'],
      })
      // Project B reuses the SAME shared store but selects a DIFFERENT specialist.
      assembleProjectWorkspace({
        workspace: wsFrontend, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '5.0.0', codeRoot: path.join(tmpDir, 'repoB'), scriptDir,
        selectedAgents: ['sr-frontend-developer'],
      })

      const aAgents = path.join(wsBackend, '.claude', 'agents')
      const bAgents = path.join(wsFrontend, '.claude', 'agents')
      // Each workspace has its OWN specialist (the bug was B inheriting A's set).
      expect(pathExists(path.join(aAgents, 'sr-backend-developer.md'))).toBe(true)
      expect(pathExists(path.join(aAgents, 'sr-frontend-developer.md'))).toBe(false)
      expect(pathExists(path.join(bAgents, 'sr-frontend-developer.md'))).toBe(true)
      expect(pathExists(path.join(bAgents, 'sr-backend-developer.md'))).toBe(false)
      // Both still get the CORE trio.
      for (const id of ['sr-architect', 'sr-developer', 'sr-reviewer']) {
        expect(pathExists(path.join(aAgents, `${id}.md`))).toBe(true)
        expect(pathExists(path.join(bAgents, `${id}.md`))).toBe(true)
      }
    })

    it('removes a stale COPY-fallback framework agent on a version swap, preserving custom-*.md (fix #7)', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      const ws = path.join(tmpDir, 'ws-copyfallback')
      const repo = path.join(tmpDir, 'repo-cf')
      setupFakeScriptDir(scriptDir)
      materialize(fwDir, scriptDir, '5.0.0')
      assembleProjectWorkspace({
        workspace: ws, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '5.0.0', codeRoot: repo, scriptDir,
      })

      const wsAgents = path.join(ws, '.claude', 'agents')
      // Simulate a Windows COPY-fallback: replace the sr-reviewer symlink with a
      // REAL (copied) framework file, and add a user custom-*.md alongside.
      removePath(path.join(wsAgents, 'sr-reviewer.md'))
      writeFileLf(path.join(wsAgents, 'sr-reviewer.md'), '# copied reviewer (framework)\n')
      writeFileLf(path.join(wsAgents, 'custom-mine.md'), 'USER CONTENT')
      expect(isSymlink(path.join(wsAgents, 'sr-reviewer.md'))).toBe(false)

      // New version DROPS sr-reviewer entirely.
      rmSync(path.join(scriptDir, 'templates', 'agents', 'sr-reviewer.md'), { force: true })
      materialize(fwDir, scriptDir, '6.0.0')
      assembleProjectWorkspace({
        workspace: ws, frameworkDir: fwDir, provider: 'claude', providerDir: '.claude',
        version: '6.0.0', codeRoot: repo, scriptDir,
      })

      // The stale COPIED framework agent is gone (fix #7: cleanup no longer
      // gates on isSymlink, so copy-fallback files are also removed).
      expect(pathExists(path.join(wsAgents, 'sr-reviewer.md'))).toBe(false)
      // The user custom agent is untouched.
      expect(readTextFile(path.join(wsAgents, 'custom-mine.md'))).toBe('USER CONTENT')
      // Still-provided framework agents remain.
      expect(pathExists(path.join(wsAgents, 'sr-architect.md'))).toBe(true)
    })

    it('seeds gemini headless acks hashing the LINKED agent files', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const fwDir = path.join(tmpDir, 'framework')
      const ws = path.join(tmpDir, 'ws-gem')
      const repo = path.join(tmpDir, 'repo-gem')
      setupFakeScriptDir(scriptDir)
      writeFileLf(path.join(scriptDir, 'templates', 'settings', 'gemini-settings.json'), '{\n  "experimental": { "enableAgents": true }\n}\n')

      installFramework({ scriptDir, frameworkDir: fwDir, provider: 'gemini', providerDir: '.gemini', version: '5.0.0' })
      ensureCurrentSymlink(fwDir, '5.0.0')
      assembleProjectWorkspace({
        workspace: ws, frameworkDir: fwDir, provider: 'gemini', providerDir: '.gemini',
        version: '5.0.0', codeRoot: repo, scriptDir,
      })

      // GEMINI.md seeded (project-named) + agent-memory real dir.
      expect(pathExists(path.join(ws, 'GEMINI.md'))).toBe(true)
      expect(isDir(path.join(ws, '.gemini', 'agent-memory', 'sr-architect'))).toBe(true)
      // Ack file written, keyed on the WORKSPACE (gemini runs with cwd=workspace
      // under relocation), hashing the linked agent file.
      const ackPath = path.join(os.homedir(), '.gemini', 'acknowledgments', 'agents.json')
      expect(pathExists(ackPath)).toBe(true)
      const ack = JSON.parse(readTextFile(ackPath)) as Record<string, Record<string, string>>
      expect(Object.keys(ack[ws])).toEqual(expect.arrayContaining(['sr-architect']))
      expect(ack[repo]).toBeUndefined() // repo is NOT the key under relocation
    })
  })
})
