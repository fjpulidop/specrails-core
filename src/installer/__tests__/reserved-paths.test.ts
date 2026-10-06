import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runInit } from '../commands/init.js'
import { mkdirp, pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import { resolveArtifacts } from '../util/registry.js'

/**
 * End-to-end audit: the installer (every init, including a re-run) must NEVER mutate
 * the two reserved regions:
 *   - .specrails/profiles/**        (desktop app / team profile JSON)
 *   - .claude/agents/custom-*.md    (user-authored custom agents)
 *
 * Core ships no role file since 6.3; the only thing the installer does inside
 * `agents/` is prune the framework-owned `sr-*` files an older Core left there.
 */

/** A role id an older Core shipped; composed so the retired names never appear literally. */
const legacyRole = (role: string): string => `sr-${role}`

async function setupFakeScriptDir(scriptDir: string, version: string): Promise<void> {
  writeFileLf(path.join(scriptDir, 'VERSION'), `${version}\n`)
  writeFileLf(path.join(scriptDir, 'templates', 'commands', 'specrails', 'implement.md'), 'implement')
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

  it('a repeated init respects the reserved contract', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    const fx = sprinkleReservedFixtures(workspaceFor(repoRoot))

    await runInit({ 'root-dir': repoRoot, yes: true, provider: 'claude' })
    assertReservedUntouched(fx)

    await runInit({ 'root-dir': repoRoot, yes: true, provider: 'claude' })
    assertReservedUntouched(fx)
  })

  it('init prunes stale sr-* role files an older Core left in agents/ but never the reserved custom-* agent', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    const workspace = workspaceFor(repoRoot)
    const fx = sprinkleReservedFixtures(workspace)
    const staleRole = path.join(workspace, '.claude', 'agents', `${legacyRole('developer')}.md`)
    writeFileLf(staleRole, 'copied by an older Core\n')

    await runInit({ 'root-dir': repoRoot, yes: true, provider: 'claude' })

    assertReservedUntouched(fx)
    expect(pathExists(staleRole)).toBe(false)
    expect(pathExists(path.join(workspace, '.claude', 'commands', 'specrails', 'implement.md'))).toBe(true)
  })
})
