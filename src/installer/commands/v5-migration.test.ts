import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isDir, isFile, pathExists, writeFileLf } from '../util/fs.js'
import { migratePreV5Install, V5_REMOVED } from './v5-migration.js'

describe('migratePreV5Install', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-v5mig-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const seedPreV5Install = (root: string): void => {
    // Core agents (kept) + removed agents.
    for (const id of ['sr-architect', 'sr-developer', 'sr-reviewer']) {
      writeFileLf(path.join(root, '.claude', 'agents', `${id}.md`), `# ${id}`)
    }
    for (const id of V5_REMOVED.agents) {
      writeFileLf(path.join(root, '.claude', 'agents', `${id}.md`), `# ${id}`)
    }
    // Commands: survivors + removed.
    writeFileLf(path.join(root, '.claude', 'commands', 'specrails', 'implement.md'), 'keep')
    for (const id of V5_REMOVED.commands) {
      writeFileLf(path.join(root, '.claude', 'commands', 'specrails', `${id}.md`), 'gone')
    }
    // Codex-style rail skill + enrich staging.
    writeFileLf(path.join(root, '.specrails', 'setup-templates', 'personas', 'p.md'), 'persona')
    writeFileLf(path.join(root, '.specrails', 'setup-templates', 'agents', 'sr-test-writer.md'), 'x')
    // Reserved / untouched fixtures.
    writeFileLf(path.join(root, '.claude', 'agents', 'custom-auditor.md'), '# custom')
    writeFileLf(path.join(root, '.specrails', 'profiles', 'project-default.json'), '{}')
    writeFileLf(path.join(root, '.claude', 'agents', 'personal-notes.md'), 'not ours')
  }

  it('removes every removed agent + command but keeps the core trio and survivors', () => {
    seedPreV5Install(tmpDir)

    migratePreV5Install({ artifactRoot: tmpDir, providerDir: '.claude' })

    const agents = path.join(tmpDir, '.claude', 'agents')
    for (const id of V5_REMOVED.agents) {
      expect(pathExists(path.join(agents, `${id}.md`)), `${id} removed`).toBe(false)
    }
    for (const id of ['sr-architect', 'sr-developer', 'sr-reviewer']) {
      expect(pathExists(path.join(agents, `${id}.md`)), `${id} kept`).toBe(true)
    }

    const cmds = path.join(tmpDir, '.claude', 'commands', 'specrails')
    for (const id of V5_REMOVED.commands) {
      expect(pathExists(path.join(cmds, `${id}.md`)), `${id} command removed`).toBe(false)
    }
    expect(pathExists(path.join(cmds, 'implement.md'))).toBe(true)
  })

  it('removes obsolete setup-templates staging but keeps setup-templates itself', () => {
    seedPreV5Install(tmpDir)

    migratePreV5Install({ artifactRoot: tmpDir, providerDir: '.claude' })

    const staging = path.join(tmpDir, '.specrails', 'setup-templates')
    expect(isDir(path.join(staging, 'personas'))).toBe(false)
    expect(
      pathExists(path.join(staging, 'agents', 'sr-test-writer.md')),
      'removed agent staging pruned',
    ).toBe(false)
    // The staging root itself remains (still holds the survivor tree).
    expect(isDir(staging)).toBe(true)
  })

  it('never touches reserved paths or files it did not create', () => {
    seedPreV5Install(tmpDir)

    migratePreV5Install({ artifactRoot: tmpDir, providerDir: '.claude' })

    expect(isFile(path.join(tmpDir, '.claude', 'agents', 'custom-auditor.md'))).toBe(true)
    expect(isFile(path.join(tmpDir, '.specrails', 'profiles', 'project-default.json'))).toBe(true)
    expect(isFile(path.join(tmpDir, '.claude', 'agents', 'personal-notes.md'))).toBe(true)
  })

  it('is a no-op on a clean v5 install (nothing removed)', () => {
    for (const id of ['sr-architect', 'sr-developer', 'sr-reviewer']) {
      writeFileLf(path.join(tmpDir, '.claude', 'agents', `${id}.md`), `# ${id}`)
    }
    writeFileLf(path.join(tmpDir, '.claude', 'commands', 'specrails', 'implement.md'), 'keep')

    migratePreV5Install({ artifactRoot: tmpDir, providerDir: '.claude' })

    for (const id of ['sr-architect', 'sr-developer', 'sr-reviewer']) {
      expect(pathExists(path.join(tmpDir, '.claude', 'agents', `${id}.md`))).toBe(true)
    }
    expect(pathExists(path.join(tmpDir, '.claude', 'commands', 'specrails', 'implement.md'))).toBe(
      true,
    )
  })
})
