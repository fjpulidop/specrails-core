import {
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import {
  KIMI_REQUIRED_OPENSPEC_SKILLS,
  normalizeKimiOpenSpecSkills,
} from './init.js'

describe('normalizeKimiOpenSpecSkills', () => {
  let tmpDir: string
  let repoRoot: string
  let artifactRoot: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-kimi-openspec-'))
    repoRoot = path.join(tmpDir, 'repo')
    artifactRoot = path.join(tmpDir, 'workspace')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  function seedAll(base: string, marker = 'generated'): void {
    for (const skill of KIMI_REQUIRED_OPENSPEC_SKILLS) {
      writeFileLf(path.join(base, skill, 'SKILL.md'), `${marker}:${skill}\n`)
    }
  }

  it('atomically normalizes the complete legacy output and prunes only managed directories', () => {
    const legacyRoot = path.join(repoRoot, '.kimi', 'skills')
    seedAll(legacyRoot)
    writeFileLf(path.join(legacyRoot, 'user-skill', 'SKILL.md'), 'user-byte-content\n')

    expect(normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)).toEqual([
      ...KIMI_REQUIRED_OPENSPEC_SKILLS,
    ])

    for (const skill of KIMI_REQUIRED_OPENSPEC_SKILLS) {
      expect(
        readTextFile(path.join(artifactRoot, '.kimi-code', 'skills', skill, 'SKILL.md')),
      ).toBe(`generated:${skill}\n`)
      expect(pathExists(path.join(legacyRoot, skill))).toBe(false)
    }
    expect(readTextFile(path.join(legacyRoot, 'user-skill', 'SKILL.md'))).toBe(
      'user-byte-content\n',
    )
  })

  it('accepts corrected upstream output, refreshes managed destinations, and preserves user files', () => {
    const correctedRoot = path.join(repoRoot, '.kimi-code', 'skills')
    seedAll(correctedRoot, 'corrected')
    const first = KIMI_REQUIRED_OPENSPEC_SKILLS[0]
    writeFileLf(
      path.join(artifactRoot, '.kimi-code', 'skills', first, 'SKILL.md'),
      'existing-destination-byte-content\n',
    )
    writeFileLf(path.join(repoRoot, '.kimi-code', 'user.json'), '{"keep":true}\n')

    normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)

    expect(
      readTextFile(path.join(artifactRoot, '.kimi-code', 'skills', first, 'SKILL.md')),
    ).toBe(`corrected:${first}\n`)
    expect(readTextFile(path.join(repoRoot, '.kimi-code', 'user.json'))).toBe('{"keep":true}\n')
    expect(pathExists(path.join(correctedRoot, KIMI_REQUIRED_OPENSPEC_SKILLS[1]))).toBe(
      false,
    )
  })

  it('refreshes every managed skill on a relocated second update', () => {
    const legacyRoot = path.join(repoRoot, '.kimi', 'skills')
    seedAll(legacyRoot, 'first-release')
    normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)

    const correctedRoot = path.join(repoRoot, '.kimi-code', 'skills')
    seedAll(correctedRoot, 'second-release')
    writeFileLf(
      path.join(artifactRoot, '.kimi-code', 'skills', 'custom-user', 'SKILL.md'),
      'keep-user-skill\n',
    )

    normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)

    for (const skill of KIMI_REQUIRED_OPENSPEC_SKILLS) {
      expect(
        readTextFile(path.join(artifactRoot, '.kimi-code', 'skills', skill, 'SKILL.md')),
      ).toBe(`second-release:${skill}\n`)
    }
    expect(
      readTextFile(
        path.join(artifactRoot, '.kimi-code', 'skills', 'custom-user', 'SKILL.md'),
      ),
    ).toBe('keep-user-skill\n')
  })

  it('fails closed when any required workflow is missing', () => {
    const legacyRoot = path.join(repoRoot, '.kimi', 'skills')
    seedAll(legacyRoot)
    rmSync(path.join(legacyRoot, 'openspec-verify-change'), {
      recursive: true,
      force: true,
    })
    expect(() => normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)).toThrow(
      /required Kimi skill openspec-verify-change/,
    )
    // The cleanup phase runs only after the complete inventory validates.
    expect(pathExists(path.join(legacyRoot, 'openspec-apply-change'))).toBe(true)
  })

  it('rejects a generated SKILL.md symlink without reading or deleting its target', () => {
    if (process.platform === 'win32') return
    const legacyRoot = path.join(repoRoot, '.kimi', 'skills')
    seedAll(legacyRoot)
    const first = KIMI_REQUIRED_OPENSPEC_SKILLS[0]
    const outside = path.join(tmpDir, 'outside-skill.md')
    writeFileLf(outside, 'outside-byte-content\n')
    rmSync(path.join(legacyRoot, first, 'SKILL.md'))
    symlinkSync(outside, path.join(legacyRoot, first, 'SKILL.md'))

    expect(() => normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)).toThrow(
      /unsafe Kimi OpenSpec skill.*symlink/,
    )
    expect(readTextFile(outside)).toBe('outside-byte-content\n')
    expect(pathExists(path.join(legacyRoot, first))).toBe(true)
  })

  it('rejects nested source symlinks before mutating any managed destination', () => {
    if (process.platform === 'win32') return
    const legacyRoot = path.join(repoRoot, '.kimi', 'skills')
    seedAll(legacyRoot)
    const first = KIMI_REQUIRED_OPENSPEC_SKILLS[0]
    const outside = path.join(tmpDir, 'outside-reference.txt')
    writeFileLf(outside, 'outside\n')
    symlinkSync(outside, path.join(legacyRoot, first, 'reference.txt'))

    expect(() => normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)).toThrow(
      /unsafe Kimi OpenSpec skill.*symlink/,
    )
    expect(
      pathExists(
        path.join(artifactRoot, '.kimi-code', 'skills', first, 'SKILL.md'),
      ),
    ).toBe(false)
  })

  it('rejects a symlinked artifact root instead of copying outside it', () => {
    if (process.platform === 'win32') return
    const legacyRoot = path.join(repoRoot, '.kimi', 'skills')
    seedAll(legacyRoot)
    const outside = path.join(tmpDir, 'outside-workspace')
    writeFileLf(path.join(outside, 'sentinel.txt'), 'keep\n')
    symlinkSync(outside, artifactRoot)

    expect(() => normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)).toThrow(
      /destination must be a real directory/,
    )
    expect(readTextFile(path.join(outside, 'sentinel.txt'))).toBe('keep\n')
    expect(pathExists(path.join(outside, '.kimi-code'))).toBe(false)
  })

  it('uses unpredictable sibling temp names and preserves colliding user paths', () => {
    const legacyRoot = path.join(repoRoot, '.kimi', 'skills')
    seedAll(legacyRoot)
    const destinationRoot = path.join(artifactRoot, '.kimi-code', 'skills')
    const first = KIMI_REQUIRED_OPENSPEC_SKILLS[0]
    const oldPredictableTemp = path.join(
      destinationRoot,
      `.${first}.specrails-tmp-${process.pid}`,
    )
    const oldPredictableBackup = path.join(
      destinationRoot,
      `.${first}.specrails-backup-${process.pid}`,
    )
    writeFileLf(path.join(oldPredictableTemp, 'keep.txt'), 'temp-user\n')
    writeFileLf(path.join(oldPredictableBackup, 'keep.txt'), 'backup-user\n')

    normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)

    expect(readTextFile(path.join(oldPredictableTemp, 'keep.txt'))).toBe(
      'temp-user\n',
    )
    expect(readTextFile(path.join(oldPredictableBackup, 'keep.txt'))).toBe(
      'backup-user\n',
    )
    const unexpectedManagedTemps = readdirSync(destinationRoot).filter(
      (entry) =>
        entry.startsWith(`.${first}.specrails-tmp-`) &&
        entry !== path.basename(oldPredictableTemp),
    )
    expect(unexpectedManagedTemps).toEqual([])
  })
})
