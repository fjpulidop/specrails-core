import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdirp, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import { runDoctor } from './doctor.js'

describe('runDoctor', () => {
  let tmpDir: string
  let prevCwd: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-doctor-test-'))
    prevCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports failures for an empty directory', async () => {
    const result = await runDoctor({ 'root-dir': tmpDir })
    expect(result.failed).toBeGreaterThan(0)
    // Must mention missing agents/ and missing CLAUDE.md.
    const messages = result.results.map((r) => r.message).join('\n')
    expect(messages).toMatch(/agents\/ directory not found/)
    expect(messages).toMatch(/CLAUDE\.md: missing/)
  })

  it('passes agent + CLAUDE.md + git checks when they are present', async () => {
    const repoRoot = path.join(tmpDir, 'repo')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    writeFileLf(path.join(repoRoot, 'CLAUDE.md'), '# project')
    writeFileLf(path.join(repoRoot, 'agents', 'architect', 'AGENTS.md'), 'arch agent')
    writeFileLf(path.join(repoRoot, 'agents', 'developer', 'AGENTS.md'), 'dev agent')

    const result = await runDoctor({ 'root-dir': repoRoot })
    const passes = result.results.filter((r) => r.kind === 'pass').map((r) => r.message).join('\n')
    expect(passes).toContain('Git: initialized')
    expect(passes).toContain('CLAUDE.md: present')
    expect(passes).toMatch(/Agent files: 2 agent\(s\)/)
  })
})
