import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdirp, pathExists, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import { runInit } from './init.js'

/**
 * Integration-style tests for `runInit`. Uses a real filesystem
 * tmpdir so we exercise fs + git paths end-to-end. The
 * SPECRAILS_SKIP_PREREQS escape hatch lets us skip the
 * claude-auth / npm checks which would otherwise require an
 * installed Claude CLI in the test environment.
 */

async function setupFakeScriptDir(scriptDir: string): Promise<void> {
  writeFileLf(path.join(scriptDir, 'VERSION'), '4.2.0\n')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'), 'arch')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-developer.md'), 'dev')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-reviewer.md'), 'reviewer')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-merge-resolver.md'), 'merge')
  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), 'rules')
  writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
}

describe('runInit', () => {
  let tmpDir: string
  let prevSkipPrereqs: string | undefined
  let prevSkipOpenSpecInit: string | undefined
  let prevCwd: string

  let prevScriptDirOverride: string | undefined
  let prevPath: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-init-test-'))
    prevSkipPrereqs = process.env.SPECRAILS_SKIP_PREREQS
    prevSkipOpenSpecInit = process.env.SPECRAILS_SKIP_OPENSPEC_INIT
    prevScriptDirOverride = process.env.SPECRAILS_CORE_SCRIPT_DIR
    prevPath = process.env.PATH
    process.env.SPECRAILS_SKIP_PREREQS = '1'
    process.env.SPECRAILS_SKIP_OPENSPEC_INIT = '1'
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
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('installs into a fresh git repo on the quick tier', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    mkdirp(repoRoot)
    await setupFakeScriptDir(scriptDir)
    await initRepo(repoRoot)

    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir
    const result = await runInit({
      'root-dir': repoRoot,
      yes: true,
      provider: 'claude',
      quick: true,
    })

    expect(result.provider).toBe('claude')
    expect(result.tier).toBe('quick')
    expect(result.repoRoot).toBe(repoRoot)

    // .specrails/specrails-version file is written from runInit's
    // script-dir lookup (the in-repo specrails-core — not the fake one).
    // We only assert that the per-repo skeleton was created.
    expect(pathExists(path.join(repoRoot, '.claude', 'commands', 'specrails'))).toBe(true)
    expect(pathExists(path.join(repoRoot, '.specrails', 'setup-templates', 'agents'))).toBe(true)
  })

  it('reads provider + tier from install-config.yaml when --from-config is passed', async () => {
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
        'agent_teams: true',
        'agents:',
        '  selected: [sr-architect]',
        '',
      ].join('\n'),
    )

    const result = await runInit({
      'root-dir': repoRoot,
      yes: true,
      'from-config': true,
    })

    expect(result.tier).toBe('quick')
    expect(result.agentTeams).toBe(true)
    expect(pathExists(path.join(repoRoot, '.claude', 'agents', 'sr-architect.md'))).toBe(true)
    expect(pathExists(path.join(repoRoot, '.claude', 'agents', 'sr-developer.md'))).toBe(true)
    expect(pathExists(path.join(repoRoot, '.claude', 'agents', 'sr-reviewer.md'))).toBe(true)
    expect(pathExists(path.join(repoRoot, '.claude', 'agents', 'sr-merge-resolver.md'))).toBe(true)
  })

  it('rejects --provider codex with a "coming soon" error', async () => {
    const repoRoot = path.join(tmpDir, 'repo')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    await expect(
      runInit({ 'root-dir': repoRoot, yes: true, provider: 'codex' }),
    ).rejects.toThrow(/Codex/)
  })

  // Fake openspec binary uses a POSIX shell script (#!/bin/sh) that
  // Windows cannot execute. The init flow itself is platform-agnostic
  // (covered by other tests on Windows runners); only the test fixture
  // is POSIX-only.
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
    process.env.PATH = `${binDir}:${prevPath ?? process.env.PATH ?? ''}`

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

    await runInit({
      'root-dir': repoRoot,
      yes: true,
      provider: 'claude',
      quick: true,
    })

    expect(pathExists(path.join(repoRoot, 'openspec', 'changes', 'archive'))).toBe(true)
    expect(pathExists(path.join(repoRoot, 'openspec', 'specs'))).toBe(true)
    expect(pathExists(path.join(repoRoot, '.claude', 'commands', 'opsx', 'propose.md'))).toBe(true)
    expect(
      pathExists(path.join(repoRoot, '.claude', 'skills', 'openspec-propose', 'SKILL.md')),
    ).toBe(true)
  })
})
