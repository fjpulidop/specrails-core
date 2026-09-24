import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isDir } from '../util/fs.js'

/**
 * Core ships exactly the three core agents and the three runtime entry points.
 * This audit locks that inventory so a stray template can never sneak back in.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TEMPLATES = path.join(REPO_ROOT, 'templates')

const REMOVED_AGENT_FILES = [
  'sr-product-manager.md',
  'sr-product-analyst.md',
  'sr-test-writer.md',
  'sr-doc-sync.md',
  'sr-merge-resolver.md',
  'sr-frontend-developer.md',
  'sr-backend-developer.md',
  'sr-frontend-reviewer.md',
  'sr-backend-reviewer.md',
  'sr-security-reviewer.md',
  'sr-performance-reviewer.md',
]

describe('template inventory', () => {
  it('ships exactly the three core agents', () => {
    const agents = readdirSync(path.join(TEMPLATES, 'agents')).filter((f) => f.endsWith('.md')).sort()
    expect(agents).toEqual(['sr-architect.md', 'sr-developer.md', 'sr-reviewer.md'])
  })

  it('does not ship any removed agent template', () => {
    const agents = new Set(readdirSync(path.join(TEMPLATES, 'agents')))
    for (const f of REMOVED_AGENT_FILES) {
      expect(agents.has(f), `${f} must not exist`).toBe(false)
    }
  })

  it('ships only the runtime entry points as commands', () => {
    const cmds = readdirSync(path.join(TEMPLATES, 'commands', 'specrails')).sort()
    expect(cmds).toEqual(['batch-implement.md', 'implement.md', 'retry.md'])
  })

  it('does not ship a personas directory or enrich/merge-resolve codex skills', () => {
    expect(isDir(path.join(TEMPLATES, 'personas'))).toBe(false)
    expect(isDir(path.join(TEMPLATES, 'codex-skills', 'enrich'))).toBe(false)
    expect(isDir(path.join(TEMPLATES, 'codex-skills', 'merge-resolve'))).toBe(false)
  })

  it('ships codex rail skills for only the three core agents', () => {
    const rails = readdirSync(path.join(TEMPLATES, 'codex-skills', 'rails')).sort()
    expect(rails).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'])
  })
})
