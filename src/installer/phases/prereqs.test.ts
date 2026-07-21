import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdirp, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import {
  MIN_NODE_VERSION,
  checkPrerequisites,
  isSupportedNodeVersion,
} from './prereqs.js'

describe('Node.js runtime floor', () => {
  it('matches the OpenSpec 1.4.1 minimum exactly', () => {
    expect(MIN_NODE_VERSION).toBe('20.19.0')
    expect(isSupportedNodeVersion('20.18.9')).toBe(false)
    expect(isSupportedNodeVersion('20.19.0')).toBe(true)
    expect(isSupportedNodeVersion('v20.19.1')).toBe(true)
    expect(isSupportedNodeVersion('21.0.0')).toBe(true)
    expect(isSupportedNodeVersion('22.19.0')).toBe(true)
  })

  it('rejects malformed and incomplete versions instead of guessing', () => {
    expect(isSupportedNodeVersion('20.19')).toBe(false)
    expect(isSupportedNodeVersion('latest')).toBe(false)
    expect(isSupportedNodeVersion('')).toBe(false)
  })
})

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
  let prevPath: string | undefined
  let prevKimiHome: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-prereqs-test-'))
    prevSkip = process.env.SPECRAILS_SKIP_PREREQS
    prevPath = process.env.PATH
    prevKimiHome = process.env.KIMI_CODE_HOME
    process.env.SPECRAILS_SKIP_PREREQS = '1'
  })

  afterEach(() => {
    if (prevSkip === undefined) delete process.env.SPECRAILS_SKIP_PREREQS
    else process.env.SPECRAILS_SKIP_PREREQS = prevSkip
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevKimiHome === undefined) delete process.env.KIMI_CODE_HOME
    else process.env.KIMI_CODE_HOME = prevKimiHome
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

  function findExecutable(name: string): string {
    for (const dir of (prevPath ?? '').split(path.delimiter)) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    throw new Error(`test prerequisite missing: ${name}`)
  }

  function installFakeKimi(version: string): void {
    const binDir = path.join(tmpDir, `bin-${version.replace(/\W/g, '-')}`)
    const kimi = path.join(binDir, 'kimi')
    writeFileLf(
      kimi,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "kimi-code ${version}"; exit 0; fi\nexit 0\n`,
    )
    chmodSync(kimi, 0o755)
    process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`
    const kimiHome = path.join(tmpDir, `kimi-home-${version}`)
    process.env.KIMI_CODE_HOME = kimiHome
    writeFileLf(
      path.join(kimiHome, 'credentials', 'kimi-code.json'),
      '{"credential":"never-read"}\n',
    )
  }

  it.skipIf(process.platform === 'win32')(
    'fails explicit Kimi selection with an official installation hint when kimi is missing',
    async () => {
      const binDir = path.join(tmpDir, 'controlled-path')
      mkdirp(binDir)
      for (const executable of ['which', 'git', 'npm']) {
        symlinkSync(findExecutable(executable), path.join(binDir, executable))
      }
      process.env.PATH = binDir
      const repoRoot = path.join(tmpDir, 'missing-kimi')
      mkdirp(repoRoot)
      await initRepo(repoRoot)
      await expect(
        checkPrerequisites({
          repoRoot,
          autoYes: true,
          explicitProvider: 'kimi',
          skipPrereqs: false,
        }),
      ).rejects.toThrow(/Kimi Code CLI is not installed.*https:\/\//)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a Kimi CLI below the tested version floor',
    async () => {
      installFakeKimi('0.26.9')
      const repoRoot = path.join(tmpDir, 'old-kimi')
      mkdirp(repoRoot)
      await initRepo(repoRoot)
      await expect(
        checkPrerequisites({
          repoRoot,
          autoYes: true,
          explicitProvider: 'kimi',
          skipPrereqs: false,
        }),
      ).rejects.toThrow(/0\.26\.9 is unsupported.*0\.27\.0/)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'accepts a supported authenticated Kimi-only selection',
    async () => {
      installFakeKimi('0.27.0')
      const repoRoot = path.join(tmpDir, 'supported-kimi')
      mkdirp(repoRoot)
      await initRepo(repoRoot)
      const result = await checkPrerequisites({
        repoRoot,
        autoYes: true,
        explicitProvider: 'kimi',
        skipPrereqs: false,
      })
      expect(result.provider).toBe('kimi')
      expect(result.availability.kimi).toBe(true)
    },
  )
})
