import { mkdtempSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GitError } from './errors.js'
import { runCommand } from './exec.js'
import { writeFileLf } from './fs.js'
import {
  add,
  commit,
  gitInstalled,
  initRepo,
  isGitRepo,
  repoRoot,
  status,
} from './git.js'

async function ensureCommitIdentity(cwd: string): Promise<void> {
  await runCommand('git', ['config', 'user.email', 'ci@specrails.test'], {
    cwd,
    inherit: false,
  })
  await runCommand('git', ['config', 'user.name', 'SpecRails CI'], {
    cwd,
    inherit: false,
  })
}

describe('git', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-git-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('gitInstalled returns true in CI / dev environments', async () => {
    expect(await gitInstalled()).toBe(true)
  })

  it('isGitRepo is false for a fresh temp directory', async () => {
    expect(await isGitRepo(tmpDir)).toBe(false)
  })

  it('initRepo creates a repo and is idempotent', async () => {
    await initRepo(tmpDir)
    expect(await isGitRepo(tmpDir)).toBe(true)
    // Second call must not throw.
    await initRepo(tmpDir)
    expect(await isGitRepo(tmpDir)).toBe(true)
  })

  it('repoRoot resolves to the init directory', async () => {
    await initRepo(tmpDir)
    const root = await repoRoot(tmpDir)
    // Path equality is fiddly across hosts:
    //   - macOS:   /var/folders/... is a symlink to /private/var/folders/...
    //   - Windows: tmp paths surface as 8.3 short names ("RUNNER~1")
    //              from one source and long names ("runneradmin") from
    //              the other.
    // fs/promises.realpath is sensitive to both: it resolves symlinks
    // AND, on Windows, expands 8.3 short components to their long form.
    // Compare both sides through realpath then case-insensitively (NTFS
    // is case-insensitive but case-preserving).
    const a = (await realpath(root)).toLowerCase()
    const b = (await realpath(tmpDir)).toLowerCase()
    expect(a).toBe(b)
  })

  it('repoRoot throws GitError outside a repo', async () => {
    await expect(repoRoot(tmpDir)).rejects.toBeInstanceOf(GitError)
  })

  it('status returns empty string for a clean repo', async () => {
    await initRepo(tmpDir)
    await ensureCommitIdentity(tmpDir)
    writeFileLf(path.join(tmpDir, 'README.md'), 'hello')
    await add(tmpDir, ['README.md'])
    await commit(tmpDir, 'initial')
    const out = await status(tmpDir)
    expect(out).toBe('')
  })

  it('status reports untracked files', async () => {
    await initRepo(tmpDir)
    writeFileLf(path.join(tmpDir, 'a.txt'), 'untracked')
    const out = await status(tmpDir)
    expect(out).toContain('a.txt')
  })

  it('add with empty pathspecs is a no-op', async () => {
    await initRepo(tmpDir)
    await expect(add(tmpDir, [])).resolves.toBeUndefined()
  })

  it('commit + add round trip produces a clean tree', async () => {
    await initRepo(tmpDir)
    await ensureCommitIdentity(tmpDir)
    writeFileLf(path.join(tmpDir, 'one.txt'), 'payload')
    await add(tmpDir, ['one.txt'])
    await commit(tmpDir, 'add one')
    expect((await status(tmpDir)).trim()).toBe('')
  })
})
