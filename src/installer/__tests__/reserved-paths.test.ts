import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runInit } from '../commands/init.js'
import { runUpdate } from '../commands/update.js'
import { mkdirp, readTextFile, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'

/**
 * End-to-end audit: the installer (init AND update) must NEVER mutate
 * the two reserved regions:
 *   - .specrails/profiles/**        (hub / team profile JSON)
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

function sprinkleReservedFixtures(repoRoot: string): ReservedFixtures {
  const profileJson = {
    abs: path.join(repoRoot, '.specrails', 'profiles', 'team.json'),
    contents: JSON.stringify({ name: 'team', owner: 'alice' }, null, 2) + '\n',
  }
  const profileInNested = {
    abs: path.join(repoRoot, '.specrails', 'profiles', 'env', 'prod.json'),
    contents: JSON.stringify({ env: 'prod' }) + '\n',
  }
  const customAgent = {
    abs: path.join(repoRoot, '.claude', 'agents', 'custom-reviewer.md'),
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
  let prevSkipPrereqs: string | undefined
  let prevScriptDirOverride: string | undefined
  let prevCwd: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-reserved-test-'))
    prevCwd = process.cwd()
    prevSkipPrereqs = process.env.SPECRAILS_SKIP_PREREQS
    prevScriptDirOverride = process.env.SPECRAILS_CORE_SCRIPT_DIR
    process.env.SPECRAILS_SKIP_PREREQS = '1'
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevSkipPrereqs === undefined) delete process.env.SPECRAILS_SKIP_PREREQS
    else process.env.SPECRAILS_SKIP_PREREQS = prevSkipPrereqs
    if (prevScriptDirOverride === undefined) delete process.env.SPECRAILS_CORE_SCRIPT_DIR
    else process.env.SPECRAILS_CORE_SCRIPT_DIR = prevScriptDirOverride
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('init preserves profile JSON and custom-* agents when they pre-exist', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const repoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    const fx = sprinkleReservedFixtures(repoRoot)

    await runInit({
      'root-dir': repoRoot,
      yes: true,
      provider: 'claude',
      quick: true,
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

    // Simulate a prior install with specrails-version + old manifest.
    writeFileLf(path.join(repoRoot, '.specrails', 'specrails-version'), '4.0.0\n')
    writeFileLf(
      path.join(repoRoot, '.specrails', 'specrails-manifest.json'),
      JSON.stringify({ version: '4.0.0', installed_at: '2026-01-01T00:00:00Z', artifacts: {} }),
    )
    mkdirp(path.join(repoRoot, '.claude', 'commands', 'specrails'))

    const fx = sprinkleReservedFixtures(repoRoot)

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

    const fx = sprinkleReservedFixtures(repoRoot)

    await runInit({ 'root-dir': repoRoot, yes: true, provider: 'claude' })
    assertReservedUntouched(fx)

    await runUpdate({ 'root-dir': repoRoot })
    assertReservedUntouched(fx)
  })
})
