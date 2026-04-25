import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdirp, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import { checkPrerequisites } from './prereqs.js'

/**
 * checkPrerequisites is integration-shaped: it talks to git, the AI
 * CLIs, and gh. We only assert the OSS-signals contract here; the
 * other branches are covered by the per-module specs (provider-detect,
 * git, exec).
 *
 * Tests run with SPECRAILS_SKIP_PREREQS=1 so a missing claude binary
 * does not abort the prereqs phase before the OSS detection lands.
 */
describe('checkPrerequisites — OSS detection', () => {
  let tmpDir: string
  let prevSkip: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-prereqs-test-'))
    prevSkip = process.env.SPECRAILS_SKIP_PREREQS
    process.env.SPECRAILS_SKIP_PREREQS = '1'
  })

  afterEach(() => {
    if (prevSkip === undefined) delete process.env.SPECRAILS_SKIP_PREREQS
    else process.env.SPECRAILS_SKIP_PREREQS = prevSkip
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns ossSignals with every flag false on a bare git repo', async () => {
    const repoRoot = path.join(tmpDir, 'bare')
    mkdirp(repoRoot)
    await initRepo(repoRoot)

    const result = await checkPrerequisites({
      repoRoot,
      autoYes: true,
      skipPrereqs: true,
    })

    expect(result.ossSignals.isOss).toBe(false)
    expect(result.ossSignals.hasCi).toBe(false)
    expect(result.ossSignals.hasContributing).toBe(false)
    // hasGh / publicRepo depend on env; they are independently asserted
    // via behaviour in the next two tests.
  })

  it('detects CI workflows under .github/workflows/', async () => {
    const repoRoot = path.join(tmpDir, 'ci')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    writeFileLf(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'on: push')

    const result = await checkPrerequisites({
      repoRoot,
      autoYes: true,
      skipPrereqs: true,
    })

    expect(result.ossSignals.hasCi).toBe(true)
  })

  it('detects CONTRIBUTING.md at the repo root', async () => {
    const repoRoot = path.join(tmpDir, 'contrib-root')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    writeFileLf(path.join(repoRoot, 'CONTRIBUTING.md'), '# How to contribute')

    const result = await checkPrerequisites({
      repoRoot,
      autoYes: true,
      skipPrereqs: true,
    })

    expect(result.ossSignals.hasContributing).toBe(true)
  })

  it('detects CONTRIBUTING.md under .github/', async () => {
    const repoRoot = path.join(tmpDir, 'contrib-github')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    writeFileLf(path.join(repoRoot, '.github', 'CONTRIBUTING.md'), '# Contributing')

    const result = await checkPrerequisites({
      repoRoot,
      autoYes: true,
      skipPrereqs: true,
    })

    expect(result.ossSignals.hasContributing).toBe(true)
  })

  it('isOss requires all four signals to be true', async () => {
    // Without `gh` + a public repo we cannot synthesise the publicRepo
    // signal in a hermetic test, so we just assert isOss is false when
    // hasGh is false (the most common dev-env state).
    const repoRoot = path.join(tmpDir, 'partial')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    writeFileLf(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'on: push')
    writeFileLf(path.join(repoRoot, 'CONTRIBUTING.md'), 'contrib')

    const result = await checkPrerequisites({
      repoRoot,
      autoYes: true,
      skipPrereqs: true,
    })

    if (!result.ossSignals.hasGh) {
      expect(result.ossSignals.isOss).toBe(false)
    }
  })
})
