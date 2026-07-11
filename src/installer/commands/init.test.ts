import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isDir, isSymlink, mkdirp, pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import { frameworkRoot, resolveArtifacts } from '../util/registry.js'
import { resetLoggerStreams, setLoggerStreams } from '../util/logger.js'
import { runInit, warnUnknownSelectedAgents } from './init.js'

/**
 * Integration-style tests for `runInit`. Uses a real filesystem
 * tmpdir so we exercise fs + git paths end-to-end. The
 * SPECRAILS_SKIP_PREREQS escape hatch lets us skip the
 * claude-auth / npm checks which would otherwise require an
 * installed Claude CLI in the test environment.
 *
 * Platform-aware: per-FILE agent links are symlinks on POSIX but COPIES on
 * Windows (Windows file-symlinks need admin/Dev-Mode). So the framework agent
 * assertion checks placement + content (holds for symlink OR copy); the stronger
 * `isSymbolicLink()` check is guarded POSIX-only so coverage isn't weakened.
 */

const IS_WIN = process.platform === 'win32'

async function setupFakeScriptDir(scriptDir: string): Promise<void> {
  writeFileLf(path.join(scriptDir, 'package.json'), `${JSON.stringify({ version: '4.2.0' })}\n`)
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'), 'arch')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-developer.md'), 'dev')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-reviewer.md'), 'reviewer')
  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), 'rules')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
}

describe('runInit', () => {
  let tmpDir: string
  let registryHome: string
  let prevSkipPrereqs: string | undefined
  let prevSkipOpenSpecInit: string | undefined
  let prevCwd: string

  let prevScriptDirOverride: string | undefined
  let prevPath: string | undefined
  let prevOpenSpecBin: string | undefined
  let prevRegistryHome: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-init-test-'))
    // Relocate-always: point the registry/workspace $HOME at a fresh tmp so
    // artifacts land there, NOT in the real ~/.specrails.
    registryHome = mkdtempSync(path.join(os.tmpdir(), 'specrails-init-home-'))
    prevSkipPrereqs = process.env.SPECRAILS_SKIP_PREREQS
    prevSkipOpenSpecInit = process.env.SPECRAILS_SKIP_OPENSPEC_INIT
    prevScriptDirOverride = process.env.SPECRAILS_CORE_SCRIPT_DIR
    prevPath = process.env.PATH
    prevOpenSpecBin = process.env.SPECRAILS_OPENSPEC_BIN
    prevRegistryHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_SKIP_PREREQS = '1'
    process.env.SPECRAILS_SKIP_OPENSPEC_INIT = '1'
    process.env.SPECRAILS_REGISTRY_HOME = registryHome
    prevCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevSkipPrereqs === undefined) delete process.env.SPECRAILS_SKIP_PREREQS
    else process.env.SPECRAILS_SKIP_PREREQS = prevSkipPrereqs
    if (prevSkipOpenSpecInit === undefined) delete process.env.SPECRAILS_SKIP_OPENSPEC_INIT
    else process.env.SPECRAILS_SKIP_OPENSPEC_INIT = prevSkipOpenSpecInit
    if (prevScriptDirOverride === undefined) delete process.env.SPECRAILS_CORE_SCRIPT_DIR
    else process.env.SPECRAILS_CORE_SCRIPT_DIR = prevScriptDirOverride
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevOpenSpecBin === undefined) delete process.env.SPECRAILS_OPENSPEC_BIN
    else process.env.SPECRAILS_OPENSPEC_BIN = prevOpenSpecBin
    if (prevRegistryHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = prevRegistryHome
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(registryHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  /** Resolve the relocated artifact workspace for a repo (readers pass allocate:false). */
  function workspaceFor(repoRoot: string): string {
    return resolveArtifacts(repoRoot, { allocate: false, home: registryHome }).artifactRoot
  }

  /** The versioned framework store (`<home>/.specrails/framework`). */
  function frameworkFor(): string {
    return frameworkRoot(registryHome)
  }

  /**
   * Assert the repo-immutability invariant: after a relocate-always install the
   * repo contains NO Specrails-owned artifact (only openspec/** if it ran).
   */
  function assertRepoHasNoSpecrailsArtifacts(repoRoot: string): void {
    for (const name of [
      '.specrails',
      '.claude',
      '.codex',
      '.gemini',
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      '.mcp.json',
    ]) {
      expect(pathExists(path.join(repoRoot, name)), `repo must not contain ${name}`).toBe(false)
    }
  }

  it('installs the core agents into a fresh git repo', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    mkdirp(repoRoot)
    await setupFakeScriptDir(scriptDir)
    await initRepo(repoRoot)

    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir
    // `--relocate` keeps the $HOME-workspace symlink layout this test asserts;
    // standalone in-repo placement is exercised by the dedicated in-repo test.
    const result = await runInit({
      'root-dir': repoRoot,
      yes: true,
      provider: 'claude',
      relocate: true,
    })

    expect(result.provider).toBe('claude')
    expect(result.repoRoot).toBe(repoRoot)

    // Bundled-framework: the static framework is materialized ONCE under
    // `<home>/.specrails/framework/<version>/<providerDir>/`; the workspace
    // providerDir subtrees are SYMLINKS to `framework/current/...`.
    const fw = frameworkFor()
    const fwClaude = path.join(fw, '4.2.0', '.claude')
    expect(isDir(path.join(fwClaude, 'commands', 'specrails')), 'framework commands materialized').toBe(true)
    expect(pathExists(path.join(fw, '4.2.0', '.specrails', 'setup-templates', 'agents')), 'setup-templates in framework').toBe(true)
    // `current` points at the version dir.
    expect(realpathSync(path.join(fw, 'current'))).toBe(realpathSync(path.join(fw, '4.2.0')))

    // The workspace providerDir subtrees resolve THROUGH the framework copy.
    const ws = workspaceFor(repoRoot)
    expect(pathExists(path.join(ws, '.claude', 'commands', 'specrails'))).toBe(true)
    // `commands/` is a whole-dir link (symlink on POSIX, junction on Windows) →
    // resolves into the framework on both. The realpath check holds for both link
    // kinds; the stronger symlink assertion is POSIX-only.
    if (!IS_WIN) expect(isSymlink(path.join(ws, '.claude', 'commands'))).toBe(true)
    expect(realpathSync(path.join(ws, '.claude', 'commands'))).toBe(
      realpathSync(path.join(fwClaude, 'commands')),
    )
    // `agents/` is a REAL dir of per-file links (so custom-*.md can coexist);
    // each framework agent is PLACED with matching content (symlink on POSIX,
    // copy on Windows). The stronger symlink check is POSIX-only.
    expect(isDir(path.join(ws, '.claude', 'agents'))).toBe(true)
    expect(isSymlink(path.join(ws, '.claude', 'agents'))).toBe(false)
    const wsArch = path.join(ws, '.claude', 'agents', 'sr-architect.md')
    expect(pathExists(wsArch)).toBe(true)
    expect(readTextFile(wsArch)).toBe(readTextFile(path.join(fwClaude, 'agents', 'sr-architect.md')))
    if (!IS_WIN) expect(lstatSync(wsArch).isSymbolicLink()).toBe(true)
    // `agent-memory/` is a REAL writable dir — NEVER a link into the framework.
    expect(isDir(path.join(ws, '.claude', 'agent-memory', 'sr-architect'))).toBe(true)
    expect(isSymlink(path.join(ws, '.claude', 'agent-memory'))).toBe(false)
    // The workspace records the framework version it consumes.
    expect(readFileSync(path.join(ws, '.specrails', 'specrails-version'), 'utf8').trim()).toBe('4.2.0')
    // setup-templates is NOT copied per-workspace anymore (it lives in framework).
    expect(pathExists(path.join(ws, '.specrails', 'setup-templates'))).toBe(false)
    // Repo-immutability invariant.
    assertRepoHasNoSpecrailsArtifacts(repoRoot)
  })

  it('reads provider + agents from install-config.yaml (tolerating a legacy tier key) when --from-config is passed', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    mkdirp(repoRoot)
    await setupFakeScriptDir(scriptDir)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    writeFileLf(
      path.join(repoRoot, '.specrails', 'install-config.yaml'),
      [
        'version: 1',
        'provider: claude',
        'tier: quick',
        'agents:',
        '  selected: [sr-architect]',
        '',
      ].join('\n'),
    )

    await runInit({
      'root-dir': repoRoot,
      yes: true,
      'from-config': true,
      relocate: true,
    })

    const ws = workspaceFor(repoRoot)
    expect(pathExists(path.join(ws, '.claude', 'agents', 'sr-architect.md'))).toBe(true)
    expect(pathExists(path.join(ws, '.claude', 'agents', 'sr-developer.md'))).toBe(true)
    expect(pathExists(path.join(ws, '.claude', 'agents', 'sr-reviewer.md'))).toBe(true)
    // Removed v4 agents never exist — only the core trio ships.
    expect(pathExists(path.join(ws, '.claude', 'agents', 'sr-merge-resolver.md'))).toBe(false)
    // NOTE: this test pre-creates repo/.specrails/install-config.yaml (a USER
    // file), so the repo-immutability invariant is asserted in the other tests.
    // Here we only assert the installer wrote NO provider artifacts into the repo.
    expect(pathExists(path.join(repoRoot, '.claude'))).toBe(false)
    expect(pathExists(path.join(repoRoot, '.specrails', 'setup-templates'))).toBe(false)
  })

  it('accepts --provider codex and produces a codex install (.codex/ + AGENTS.md)', async () => {
    const repoRoot = path.join(tmpDir, 'repo-codex')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    const result = await runInit({ 'root-dir': repoRoot, yes: true, provider: 'codex', relocate: true })
    expect(result.provider).toBe('codex')
    const ws = workspaceFor(repoRoot)
    // Provider-derived layout: .codex/ + AGENTS.md — under the workspace.
    expect(pathExists(path.join(ws, '.codex'))).toBe(true)
    expect(pathExists(path.join(ws, 'AGENTS.md'))).toBe(true)
    // codex-config.toml written by applyCodexSettings (no rules.star —
    // codex 0.128.0+ keeps sandbox policy inside config.toml itself).
    expect(pathExists(path.join(ws, '.codex', 'config.toml'))).toBe(true)
    expect(pathExists(path.join(ws, '.codex', 'rules.star'))).toBe(false)
    // .claude/ is NOT created on codex projects
    expect(pathExists(path.join(ws, '.claude'))).toBe(false)
    // Repo-immutability: nothing Specrails-owned in the repo.
    assertRepoHasNoSpecrailsArtifacts(repoRoot)
  })

  it('rejects --provider with an unknown value', async () => {
    const repoRoot = path.join(tmpDir, 'repo-unknown')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    await expect(
      runInit({ 'root-dir': repoRoot, yes: true, provider: 'turbofake' as never }),
    ).rejects.toThrow(/must be 'claude', 'codex', or 'gemini'/)
  })

  it('installs IN-REPO by default (no --relocate, no pre-existing registry entry): real files, not symlinks', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo-inrepo')
    mkdirp(repoRoot)
    await setupFakeScriptDir(scriptDir)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    // No registry entry exists for this repo and no --relocate is passed → the
    // standalone in-repo layout: artifacts land in the repo as REAL files so a
    // user's `claude` running in the repo finds them.
    const result = await runInit({
      'root-dir': repoRoot,
      yes: true,
      provider: 'claude',
    })
    expect(result.provider).toBe('claude')

    // The repo received the framework agents as REAL regular files — NOT symlinks
    // into $HOME/.specrails/framework.
    const repoArch = path.join(repoRoot, '.claude', 'agents', 'sr-architect.md')
    expect(pathExists(repoArch), 'repo has sr-architect.md').toBe(true)
    expect(lstatSync(repoArch).isSymbolicLink(), 'sr-architect.md is NOT a symlink').toBe(false)
    expect(lstatSync(repoArch).isFile(), 'sr-architect.md is a regular file').toBe(true)
    expect(readTextFile(repoArch).length, 'sr-architect.md has content').toBeGreaterThan(0)

    // Whole-dir subtrees (commands) are also REAL dirs, not symlinks, in-repo.
    const repoCommands = path.join(repoRoot, '.claude', 'commands', 'specrails')
    expect(isDir(repoCommands)).toBe(true)
    expect(isSymlink(path.join(repoRoot, '.claude', 'commands'))).toBe(false)

    // The in-repo marker: the specrails-version file lives in the repo's
    // .specrails/, not in a relocated $HOME workspace.
    expect(pathExists(path.join(repoRoot, '.specrails', 'specrails-version'))).toBe(true)
    expect(
      readFileSync(path.join(repoRoot, '.specrails', 'specrails-version'), 'utf8').trim(),
    ).toBe('4.2.0')

    // agent-memory is a REAL writable dir either way (never linked).
    expect(isDir(path.join(repoRoot, '.claude', 'agent-memory', 'sr-architect'))).toBe(true)

    // No relocated workspace was allocated for this repo: the resolver falls back
    // to the in-repo layout (artifactRoot === the repo's canonical realpath).
    expect(workspaceFor(repoRoot)).toBe(realpathSync(repoRoot))
  })

  it('relocates to the $HOME workspace with --relocate (repo stays pristine)', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo-relocate')
    mkdirp(repoRoot)
    await setupFakeScriptDir(scriptDir)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    await runInit({
      'root-dir': repoRoot,
      yes: true,
      provider: 'claude',
      relocate: true,
    })

    // The repo got NOTHING Specrails-owned — it stays pristine.
    assertRepoHasNoSpecrailsArtifacts(repoRoot)

    // The relocated $HOME workspace (under SPECRAILS_REGISTRY_HOME) holds the
    // agents instead.
    const ws = workspaceFor(repoRoot)
    expect(ws).not.toBe(repoRoot)
    expect(pathExists(path.join(ws, '.claude', 'agents', 'sr-architect.md'))).toBe(true)
    expect(pathExists(path.join(ws, '.specrails', 'specrails-version'))).toBe(true)
  })

  it('relocates when SPECRAILS_RELOCATE=1 is set (env opt-in)', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo-relocate-env')
    mkdirp(repoRoot)
    await setupFakeScriptDir(scriptDir)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    const prevRelocate = process.env.SPECRAILS_RELOCATE
    process.env.SPECRAILS_RELOCATE = '1'
    try {
      await runInit({ 'root-dir': repoRoot, yes: true, provider: 'claude' })
    } finally {
      if (prevRelocate === undefined) delete process.env.SPECRAILS_RELOCATE
      else process.env.SPECRAILS_RELOCATE = prevRelocate
    }

    // Repo pristine; artifacts in the relocated workspace.
    assertRepoHasNoSpecrailsArtifacts(repoRoot)
    const ws = workspaceFor(repoRoot)
    expect(ws).not.toBe(repoRoot)
    expect(pathExists(path.join(ws, '.claude', 'agents', 'sr-architect.md'))).toBe(true)
  })

  // Uses a POSIX shell script as a fake openspec binary, pointed at via
  // SPECRAILS_OPENSPEC_BIN so the installer doesn't shell out to npx
  // (which would hit the live npm registry). #!/bin/sh fixture means
  // the test only runs on POSIX.
  it.skipIf(process.platform === 'win32')('runs openspec init and creates OpenSpec project files when the CLI is available', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    const binDir = path.join(tmpDir, 'bin')
    mkdirp(repoRoot)
    mkdirp(binDir)
    await setupFakeScriptDir(scriptDir)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir
    process.env.SPECRAILS_SKIP_OPENSPEC_INIT = '0'

    const fakeOpenSpec = path.join(binDir, 'openspec')
    writeFileLf(
      fakeOpenSpec,
      [
        '#!/bin/sh',
        'if [ "$1" = "init" ]; then',
        '  repo="$4"',
        '  mkdir -p "$repo/openspec/changes/archive" "$repo/openspec/specs"',
        '  mkdir -p "$repo/.claude/commands/opsx" "$repo/.claude/skills/openspec-propose"',
        '  : > "$repo/.claude/commands/opsx/propose.md"',
        '  : > "$repo/.claude/skills/openspec-propose/SKILL.md"',
        '  exit 0',
        'fi',
        'if [ "$1" = "--version" ]; then',
        '  echo "1.2.0"',
        '  exit 0',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    )
    chmodSync(fakeOpenSpec, 0o755)
    process.env.SPECRAILS_OPENSPEC_BIN = fakeOpenSpec

    await runInit({
      'root-dir': repoRoot,
      yes: true,
      provider: 'claude',
    })

    expect(pathExists(path.join(repoRoot, 'openspec', 'changes', 'archive'))).toBe(true)
    expect(pathExists(path.join(repoRoot, 'openspec', 'specs'))).toBe(true)
    expect(pathExists(path.join(repoRoot, '.claude', 'commands', 'opsx', 'propose.md'))).toBe(true)
    expect(
      pathExists(path.join(repoRoot, '.claude', 'skills', 'openspec-propose', 'SKILL.md')),
    ).toBe(true)
  })
})

describe('warnUnknownSelectedAgents', () => {
  const capture = (): { lines: string[]; restore: () => void } => {
    const lines: string[] = []
    const sink = new PassThrough()
    sink.on('data', (chunk: Buffer) => lines.push(chunk.toString()))
    setLoggerStreams({ out: sink, err: sink })
    return { lines, restore: () => resetLoggerStreams() }
  }

  it('warns for each selected agent that no longer ships', () => {
    const { lines, restore } = capture()
    try {
      warnUnknownSelectedAgents(['sr-architect', 'sr-frontend-developer', 'sr-test-writer'])
    } finally {
      restore()
    }
    const out = lines.join('')
    expect(out).toContain(`'sr-frontend-developer'`)
    expect(out).toContain(`'sr-test-writer'`)
    expect(out).toContain('removed in v5')
    expect(out).not.toContain(`'sr-architect'`)
  })

  it('is silent for the core trio and for undefined', () => {
    const { lines, restore } = capture()
    try {
      warnUnknownSelectedAgents(['sr-architect', 'sr-developer', 'sr-reviewer'])
      warnUnknownSelectedAgents(undefined)
    } finally {
      restore()
    }
    expect(lines.join('')).toBe('')
  })
})
