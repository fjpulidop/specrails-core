import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isDir } from '../util/fs.js'

/**
 * Core ships the runtime entry points, provider settings and the Kimi runner —
 * and NO role templates: roles are defined only by the programmatic runtime.
 * This audit locks that inventory so a stray template can never sneak back in.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TEMPLATES = path.join(REPO_ROOT, 'templates')

/**
 * Retired role identifiers that must not reappear anywhere in the repository.
 * Built from parts so this guard never matches itself.
 */
const RETIRED_ROLE_IDS = ['architect', 'developer', 'reviewer'].map((role) => `sr-${role}`)

/** Historical records may keep the names; everything else is live source. */
const ROLE_ID_EXEMPT_PATHS = [/^CHANGELOG\.md$/, /^openspec\//]

describe('template inventory', () => {
  it('ships only commands, the Kimi runner and provider settings', () => {
    expect(readdirSync(TEMPLATES).sort()).toEqual(['commands', 'kimi', 'settings'])
  })

  it('does not ship role agent templates or codex rail skills', () => {
    expect(isDir(path.join(TEMPLATES, 'agents'))).toBe(false)
    expect(isDir(path.join(TEMPLATES, 'codex-skills'))).toBe(false)
    expect(isDir(path.join(TEMPLATES, 'personas'))).toBe(false)
  })

  it('ships only the runtime entry points as commands', () => {
    const cmds = readdirSync(path.join(TEMPLATES, 'commands', 'specrails')).sort()
    expect(cmds).toEqual(['implement.md', 'retry.md'])
  })
})

describe('retired role identifiers', () => {
  it('appear in no tracked file outside CHANGELOG.md and openspec/', () => {
    // `git ls-files` enumerates tracked files only, so gitignored trees
    // (node_modules, dist, coverage, .specrails, …) are never scanned.
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((relative) => relative.length > 0)
      .filter((relative) => !ROLE_ID_EXEMPT_PATHS.some((pattern) => pattern.test(relative)))
    const pattern = new RegExp(RETIRED_ROLE_IDS.join('|'))
    const offenders = tracked.filter((relative) => {
      let text: string
      try {
        text = readFileSync(path.join(REPO_ROOT, relative), 'utf8')
      } catch {
        return false // a path deleted in the working tree but still tracked
      }
      return pattern.test(text)
    })
    expect(offenders).toEqual([])
  })
})
