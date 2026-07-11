import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runInit } from '../commands/init.js'
import { runUpdate } from '../commands/update.js'
import { mkdirp, readTextFile, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import { resolveArtifacts } from '../util/registry.js'

/**
 * End-to-end audit: the installer (init AND update) must NEVER mutate
 * the two reserved regions:
 *   - .specrails/profiles/**        (desktop app / team profile JSON)
 *   - .claude/agents/custom-*.md    (user-authored custom agents)
 *
 * Ports the intent of the retired tests/test-profiles.sh into vitest
 * so it runs in the cross-platform CI matrix and gates every PR.
 */

async function setupFakeScriptDir(scriptDir: string, version: string): Promise<void> {
  writeFileLf(path.join(scriptDir, 'VERSION'), `${version}\n`)
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-architect.md'), 'bundled-arch')
  writeFileLf(path.join(scriptDir, 'templates', 'agents', 'sr-developer.md'), 'bundled-dev')
  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), 'bundled-rules')
  writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
}

interface ReservedFixtures {
  profileJson: { abs: string; contents: string }
  profileInNested: { abs: string; contents: string }
  customAgent: { abs: string; contents: string }
}

// The reserved regions now live under the relocated artifact workspace
// (`artifactRoot`), not the repo. The preservation contract is unchanged —
// only the base directory moved.
function sprinkleReservedFixtures(artifactRoot: string): ReservedFixtures {
  const profileJson = {
    abs: path.join(artifactRoot, '.specrails', 'profiles', 'team.json'),
    contents: JSON.stringify({ name: 'team', owner: 'alice' }, null, 2) + '\n',
  }
  const profileInNested = {
    abs: path.join(artifactRoot, '.specrails', 'profiles', 'env', 'prod.json'),
    contents: JSON.stringify({ env: 'prod' }) + '\n',
  }
  const customAgent = {
    abs: path.join(artifactRoot, '.claude', 'agents', 'custom-reviewer.md'),
    contents: '# custom reviewer\nuser-authored content\n',
  }
  writeFileLf(profileJson.abs, profileJson.contents)
  writeFileLf(profileInNested.abs, profileInNested.contents)
  writeFileLf(customAgent.abs, customAgent.contents)
  return { profileJson, profileInNested, customAgent }
}

function assertReservedUntouched(fx: ReservedFixtures): void {
  expect(readTextFile(fx.profileJson.abs)).toBe(fx.profileJson.contents)
  expect(readTextFile(fx.profileInNested.abs)).toBe(fx.profileInNested.contents)
  expect(readTextFile(fx.customAgent.abs)).toBe(fx.customAgent.contents)
}

describe('reserved paths audit', () => {
  let tmpDir: string
  let registryHome: string
  let prevSkipPrereqs: string | undefined
  let prevSkipOpenSpecInit: string | undefined
  let prevScriptDirOverride: string | undefined
  let prevRegistryHome: string | undefined
  let prevCwd: string

  /** The relocated artifact workspace where reserved regions live. */
  function workspaceFor(repoRoot: string): string {
    return resolveArtifacts(repoRoot, {
      allocate: true,
      home: registryHome,
      providers: ['claude'],
    }).artifactRoot
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-reserved-test-'))
    registryHome = mkdtempSync(path.join(os.tmpdir(), 'specrails-reserved-home-'))
    prevCwd = process.cwd()
    prevSkipPrereqs = process.env.SPECRAILS_SKIP_PREREQS
    prevSkipOpenSpecInit = process.env.SPECRAILS_SKIP_OPENSPEC_INIT
    prevScriptDirOverride = process.env.SPECRAILS_CORE_SCRIPT_DIR
    prevRegistryHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_SKIP_PREREQS = '1'
    // Reserved-paths audit doesn't depend on OpenSpec; skip the npx
    // fetch so the test stays fast and Windows CI doesn't time out.
    process.env.SPECRAILS_SKIP_OPENSPEC_INIT = '1'
    process.env.SPECRAILS_REGISTRY_HOME = registryHome
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevSkipPrereqs === undefined) delete process.env.SPECRAILS_SKIP_PREREQS
    else process.env.SPECRAILS_SKIP_PREREQS = prevSkipPrereqs
    if (prevSkipOpenSpecInit === undefined) delete process.env.SPECRAILS_SKIP_OPENSPEC_INIT
    else process.env.SPECRAILS_SKIP_OPENSPEC_INIT = prevSkipOpenSpecInit
    if (prevScriptDirOverride === undefined) delete process.env.SPECRAILS_CORE_SCRIPT_DIR
    else process.env.SPECRAILS_CORE_SCRIPT_DIR = prevScriptDirOverride
    if (prevRegistryHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = prevRegistryHome
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(registryHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('init preserves profile JSON and custom-* agents when they pre-exist', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    const fx = sprinkleReservedFixtures(workspaceFor(repoRoot))

    await runInit({
      'root-dir': repoRoot,
      yes: true,
      provider: 'claude',
    })

    assertReservedUntouched(fx)
  })

  it('update preserves profile JSON and custom-* agents on re-run', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    // Simulate a prior relocate-always install: marker + manifest in the workspace.
    const ws = workspaceFor(repoRoot)
    writeFileLf(path.join(ws, '.specrails', 'specrails-version'), '4.0.0\n')
    writeFileLf(
      path.join(ws, '.specrails', 'specrails-manifest.json'),
      JSON.stringify({ version: '4.0.0', installed_at: '2026-01-01T00:00:00Z', artifacts: {} }),
    )
    mkdirp(path.join(ws, '.claude', 'commands', 'specrails'))

    const fx = sprinkleReservedFixtures(ws)

    await runUpdate({ 'root-dir': repoRoot })

    assertReservedUntouched(fx)
  })

  it('init + update in sequence both respect the reserved contract', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    const fx = sprinkleReservedFixtures(workspaceFor(repoRoot))

    await runInit({ 'root-dir': repoRoot, yes: true, provider: 'claude' })
    assertReservedUntouched(fx)

    await runUpdate({ 'root-dir': repoRoot })
    assertReservedUntouched(fx)
  })
})
