import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isDir, isSymlink, mkdirp, pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import { frameworkRoot, resolveArtifacts } from '../util/registry.js'
import { resetLoggerStreams, setLoggerStreams } from '../util/logger.js'
import { KIMI_REQUIRED_OPENSPEC_SKILLS, runInit, snapshotWorkspaceProviderSelections } from './init.js'

/**
 * Integration-style tests for `runInit`. Uses a real filesystem
 * tmpdir so we exercise fs + git paths end-to-end. The
 * SPECRAILS_SKIP_PREREQS escape hatch lets us skip the
 * claude-auth / npm checks which would otherwise require an
 * installed Claude CLI in the test environment.
 *
 * Platform-aware: whole-dir links are symlinks on POSIX but junctions on
 * Windows, so link assertions check that the path RESOLVES into the framework;
 * the stronger `isSymlink()` check is guarded POSIX-only so coverage isn't weakened.
 */

const IS_WIN = process.platform === 'win32'

/** Relative path of the managed workflow file inside a claude provider dir. */
const IMPLEMENT = path.join('commands', 'specrails', 'implement.md')

/** A role id an older Core shipped; composed so the retired names never appear literally. */
const legacyRole = (role: string): string => `sr-${role}`

/** Capture every logger line while `run` executes. */
async function captureLog(run: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const sink = new PassThrough()
  sink.on('data', (chunk: Buffer) => lines.push(chunk.toString()))
  setLoggerStreams({ out: sink, err: sink })
  try {
    await run()
  } finally {
    resetLoggerStreams()
  }
  return lines.join('')
}

async function setupFakeScriptDir(
  scriptDir: string,
  version = '4.2.0',
): Promise<void> {
  writeFileLf(path.join(scriptDir, 'package.json'), `${JSON.stringify({ version })}\n`)
  writeFileLf(path.join(scriptDir, 'templates', IMPLEMENT), `${version}-implement`)
  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), 'rules')
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
      '.kimi-code',
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      '.mcp.json',
    ]) {
      expect(pathExists(path.join(repoRoot, name)), `repo must not contain ${name}`).toBe(false)
    }
  }

  it('installs the workflow commands into a fresh git repo and places no role file', async () => {
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
    expect(pathExists(path.join(fw, '4.2.0', '.specrails', 'setup-templates', 'commands')), 'setup-templates in framework').toBe(true)
    // Roles are runtime-defined: the framework store carries no agents/ subtree.
    expect(pathExists(path.join(fwClaude, 'agents'))).toBe(false)
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
    expect(readTextFile(path.join(ws, '.claude', IMPLEMENT))).toBe('4.2.0-implement')
    // No role file, no agents/ dir and no agent-memory: roles are runtime-defined.
    expect(pathExists(path.join(ws, '.claude', 'agents'))).toBe(false)
    expect(pathExists(path.join(ws, '.claude', 'agent-memory'))).toBe(false)
    // The workspace records the framework version it consumes.
    expect(readFileSync(path.join(ws, '.specrails', 'specrails-version'), 'utf8').trim()).toBe('4.2.0')
    // setup-templates is NOT copied per-workspace anymore (it lives in framework).
    expect(pathExists(path.join(ws, '.specrails', 'setup-templates'))).toBe(false)
    // Repo-immutability invariant.
    assertRepoHasNoSpecrailsArtifacts(repoRoot)
  })

  it('treats -y exactly like --yes and initializes a fresh non-git directory', async () => {
    const scriptDir = path.join(tmpDir, 'core-short-y')
    const repoRoot = path.join(tmpDir, 'repo-short-y')
    mkdirp(repoRoot)
    await setupFakeScriptDir(scriptDir)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    const result = await runInit({
      'root-dir': repoRoot,
      y: true,
      provider: 'claude',
      relocate: true,
    })

    expect(result.provider).toBe('claude')
    expect(pathExists(path.join(repoRoot, '.git'))).toBe(true)
    assertRepoHasNoSpecrailsArtifacts(repoRoot)
  })

  it('reads the provider from install-config.yaml, tolerates a legacy tier key and ignores the legacy agents selection with a warning', async () => {
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
        `  selected: [${legacyRole('architect')}]`,
        '',
      ].join('\n'),
    )

    const log = await captureLog(async () => {
      await runInit({
        'root-dir': repoRoot,
        yes: true,
        provider: 'claude',
        'from-config': true,
        relocate: true,
      })
    })

    // One deprecation warning, the install succeeds, and no role file is placed.
    expect(log).toContain('Loaded install config from')
    expect(log.match(/agents\.selected.*ignored since Core 6\.3/g)).toHaveLength(1)
    expect(log).toContain('init complete')
    const ws = workspaceFor(repoRoot)
    expect(pathExists(path.join(ws, '.claude', IMPLEMENT))).toBe(true)
    expect(pathExists(path.join(ws, '.claude', 'agents'))).toBe(false)
    // NOTE: this test pre-creates repo/.specrails/install-config.yaml (a USER
    // file), so the repo-immutability invariant is asserted in the other tests.
    // Here we only assert the installer wrote NO provider artifacts into the repo.
    expect(pathExists(path.join(repoRoot, '.claude'))).toBe(false)
    expect(pathExists(path.join(repoRoot, '.specrails', 'setup-templates'))).toBe(false)
  })

  it('uses explicit --provider as fallback when --from-config does not exist', async () => {
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

  it('rejects invalid --provider values even when --from-config is present', async () => {
    const repoRoot = path.join(tmpDir, 'repo-unknown')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    await expect(
      runInit({
        'root-dir': repoRoot,
        yes: true,
        provider: 'turbofake',
        'from-config': true,
      }),
    ).rejects.toThrow(/must be 'claude', 'codex', 'gemini', or 'kimi'/)
    await expect(
      runInit({
        'root-dir': repoRoot,
        yes: true,
        provider: true,
        'from-config': true,
      }),
    ).rejects.toThrow(/must be 'claude', 'codex', 'gemini', or 'kimi'/)
  })

  it('rejects conflicting --provider + --from-config instead of silently overriding', async () => {
    const repoRoot = path.join(tmpDir, 'repo-provider-conflict')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    writeFileLf(
      path.join(repoRoot, '.specrails', 'install-config.yaml'),
      [
        'version: 1',
        'provider: kimi',
        'tier: quick',
        'agents:',
        `  selected: [${legacyRole('architect')}]`,
        '',
      ].join('\n'),
    )

    await expect(
      runInit({
        'root-dir': repoRoot,
        yes: true,
        provider: 'claude',
        'from-config': true,
      }),
    ).rejects.toThrow(
      /--provider 'claude' conflicts with provider 'kimi' in .*install-config\.yaml/,
    )
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

    // The repo received the framework commands as REAL regular files — NOT
    // symlinks into $HOME/.specrails/framework.
    const repoImplement = path.join(repoRoot, '.claude', IMPLEMENT)
    expect(pathExists(repoImplement), 'repo has implement.md').toBe(true)
    expect(lstatSync(repoImplement).isSymbolicLink(), 'implement.md is NOT a symlink').toBe(false)
    expect(lstatSync(repoImplement).isFile(), 'implement.md is a regular file').toBe(true)
    expect(readTextFile(repoImplement)).toBe('4.2.0-implement')

    // Whole-dir subtrees (commands) are also REAL dirs, not symlinks, in-repo.
    const repoCommands = path.join(repoRoot, '.claude', 'commands', 'specrails')
    expect(isDir(repoCommands)).toBe(true)
    expect(isSymlink(path.join(repoRoot, '.claude', 'commands'))).toBe(false)
    // No role file lands in the repo either.
    expect(pathExists(path.join(repoRoot, '.claude', 'agents'))).toBe(false)

    // The in-repo marker: the specrails-version file lives in the repo's
    // .specrails/, not in a relocated $HOME workspace.
    expect(pathExists(path.join(repoRoot, '.specrails', 'specrails-version'))).toBe(true)
    expect(
      readFileSync(path.join(repoRoot, '.specrails', 'specrails-version'), 'utf8').trim(),
    ).toBe('4.2.0')

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
    // commands instead.
    const ws = workspaceFor(repoRoot)
    expect(ws).not.toBe(repoRoot)
    expect(pathExists(path.join(ws, '.claude', IMPLEMENT))).toBe(true)
    expect(pathExists(path.join(ws, '.specrails', 'specrails-version'))).toBe(true)
  })

  it('carries Claude 4.11 forward when a relocated project adds Kimi on 4.12', async () => {
    const scriptDir = path.join(tmpDir, 'core-cross-version')
    const repoRoot = path.join(tmpDir, 'repo-cross-version')
    mkdirp(repoRoot)
    await setupFakeScriptDir(scriptDir, '4.11.0')
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    await runInit({
      'root-dir': repoRoot,
      yes: true,
      provider: 'claude',
      relocate: true,
    })

    const ws = workspaceFor(repoRoot)
    const fw = frameworkFor()
    const claudeCommands = path.join(ws, '.claude', 'commands')
    const claudeImplement = path.join(ws, '.claude', IMPLEMENT)
    writeFileLf(
      path.join(ws, '.claude', 'agents', 'custom-owner.md'),
      'user-owned-claude-agent\n',
    )
    expect(realpathSync(claudeCommands)).toBe(
      realpathSync(path.join(fw, '4.11.0', '.claude', 'commands')),
    )
    expect(readTextFile(claudeImplement)).toBe('4.11.0-implement')

    // Simulate installing the next Core release while selecting Kimi. Because
    // `current` is global, the 4.12 target must be complete for BOTH providers
    // before one swap makes it visible.
    await setupFakeScriptDir(scriptDir, '4.12.0')
    await runInit({
      'root-dir': repoRoot,
      yes: true,
      provider: 'kimi',
      relocate: true,
    })

    expect(realpathSync(path.join(fw, 'current'))).toBe(
      realpathSync(path.join(fw, '4.12.0')),
    )
    expect(isDir(path.join(fw, '4.12.0', '.claude'))).toBe(true)
    expect(isDir(path.join(fw, '4.12.0', '.kimi-code'))).toBe(true)

    // Existing Claude links remain live and now resolve through the complete
    // 4.12 target; user-owned files in the workspace are byte-preserved.
    expect(realpathSync(claudeCommands)).toBe(
      realpathSync(path.join(fw, '4.12.0', '.claude', 'commands')),
    )
    expect(readTextFile(claudeImplement)).toBe('4.12.0-implement')
    expect(
      readTextFile(path.join(ws, '.claude', 'agents', 'custom-owner.md')),
    ).toBe('user-owned-claude-agent\n')

    // The newly selected provider is assembled from the same destination
    // version, while the previous version remains available for rollback.
    expect(
      pathExists(path.join(ws, '.kimi-code', 'skills', 'specrails-implement', 'SKILL.md')),
    ).toBe(true)
    expect(pathExists(path.join(ws, '.kimi-code', 'agent-memory'))).toBe(false)
    expect(pathExists(path.join(ws, '.kimi-code', 'specrails', 'run-skill.mjs'))).toBe(true)
    expect(isDir(path.join(fw, '4.11.0', '.claude'))).toBe(true)

    const manifest = JSON.parse(
      readTextFile(path.join(ws, '.specrails', 'specrails-manifest.json')),
    ) as { providers: string[]; primary_provider: string }
    expect(manifest.providers).toEqual(['claude', 'kimi'])
    expect(manifest.primary_provider).toBe('claude')
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
    expect(pathExists(path.join(ws, '.claude', IMPLEMENT))).toBe(true)
  })

  it('recognizes a commands-only workspace on reinstall and never warns about missing roles', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo-reinstall')
    mkdirp(repoRoot)
    await setupFakeScriptDir(scriptDir)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    await runInit({ 'root-dir': repoRoot, yes: true, provider: 'claude' })
    expect(pathExists(path.join(repoRoot, '.claude', IMPLEMENT))).toBe(true)
    expect(pathExists(path.join(repoRoot, '.claude', 'agents'))).toBe(false)
    // The in-repo workspace is an installed claude provider — by its commands.
    expect(snapshotWorkspaceProviderSelections(realpathSync(repoRoot))).toEqual({ claude: [] })

    const log = await captureLog(async () => {
      await runInit({ 'root-dir': repoRoot, yes: true, provider: 'claude' })
    })
    expect(log).toContain('init complete')
    expect(log).not.toMatch(/role|agent/i)
    expect(pathExists(path.join(repoRoot, '.claude', 'agents'))).toBe(false)
    const manifest = JSON.parse(
      readTextFile(path.join(repoRoot, '.specrails', 'specrails-manifest.json')),
    ) as { providers: string[] }
    expect(manifest.providers).toEqual(['claude'])
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
        '  for argument in "$@"; do repo="$argument"; done',
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

  it.skipIf(process.platform === 'win32')(
    'initializes Kimi in-repo and normalizes all OpenSpec skills',
    async () => {
      const scriptDir = path.join(tmpDir, 'core-kimi')
      const repoRoot = path.join(tmpDir, 'repo-kimi')
      const binDir = path.join(tmpDir, 'bin-kimi')
      mkdirp(repoRoot)
      mkdirp(binDir)
      await setupFakeScriptDir(scriptDir)
      for (const command of ['implement', 'retry', 'doctor']) {
        writeFileLf(
          path.join(scriptDir, 'templates', 'commands', 'specrails', `${command}.md`),
          `/specrails:${command}\n`,
        )
      }
      await initRepo(repoRoot)
      process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir
      process.env.SPECRAILS_SKIP_OPENSPEC_INIT = '0'

      const fakeOpenSpec = path.join(binDir, 'openspec')
      writeFileLf(
        fakeOpenSpec,
        [
          '#!/bin/sh',
          'if [ "$1" = "init" ]; then',
          '  [ "$2" = "--tools" ] && [ "$3" = "kimi" ] || exit 31',
          '  [ "$4" = "--profile" ] && [ "$5" = "custom" ] || exit 32',
          '  [ -f "$XDG_CONFIG_HOME/openspec/config.json" ] || exit 33',
          '  repo="$6"',
          '  mkdir -p "$repo/openspec/changes/archive" "$repo/openspec/specs"',
          `  for skill in ${KIMI_REQUIRED_OPENSPEC_SKILLS.join(' ')}; do`,
          '    mkdir -p "$repo/.kimi/skills/$skill"',
          '    printf "%s\\n" "---" "name: $skill" "description: generated" "---" > "$repo/.kimi/skills/$skill/SKILL.md"',
          '  done',
          '  exit 0',
          'fi',
          'exit 0',
          '',
        ].join('\n'),
      )
      chmodSync(fakeOpenSpec, 0o755)
      process.env.SPECRAILS_OPENSPEC_BIN = fakeOpenSpec

      const result = await runInit({
        'root-dir': repoRoot,
        yes: true,
        provider: 'kimi',
      })

      expect(result.provider).toBe('kimi')
      expect(pathExists(path.join(repoRoot, '.kimi-code', 'AGENTS.md'))).toBe(true)
      expect(pathExists(path.join(repoRoot, '.kimi-code', 'mcp.json'))).toBe(true)
      expect(pathExists(path.join(repoRoot, 'AGENTS.md'))).toBe(false)
      expect(
        pathExists(
          path.join(repoRoot, '.kimi-code', 'skills', 'specrails-implement', 'SKILL.md'),
        ),
      ).toBe(true)
      for (const skill of KIMI_REQUIRED_OPENSPEC_SKILLS) {
        expect(
          pathExists(path.join(repoRoot, '.kimi-code', 'skills', skill, 'SKILL.md')),
        ).toBe(true)
      }
      expect(pathExists(path.join(repoRoot, '.kimi'))).toBe(false)
      const manifest = JSON.parse(
        readTextFile(path.join(repoRoot, '.specrails', 'specrails-manifest.json')),
      ) as { providers: string[]; primary_provider: string }
      expect(manifest.providers).toEqual(['kimi'])
      expect(manifest.primary_provider).toBe('kimi')
    },
  )
})
