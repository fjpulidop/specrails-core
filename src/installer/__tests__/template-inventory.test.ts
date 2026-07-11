import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isDir } from '../util/fs.js'

/**
 * v5 ships exactly the three core agents and none of the removed commands,
 * personas, or non-core agents. This audit locks that inventory so a stray
 * template can never sneak back in.
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

const REMOVED_COMMAND_FILES = [
  'enrich.md',
  'reconfig.md',
  'vpc-drift.md',
  'auto-propose-backlog-specs.md',
  'get-backlog-specs.md',
  'merge-resolve.md',
]

describe('template inventory (v5)', () => {
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

  it('does not ship any removed command template', () => {
    const cmds = new Set(readdirSync(path.join(TEMPLATES, 'commands', 'specrails')))
    for (const f of REMOVED_COMMAND_FILES) {
      expect(cmds.has(f), `${f} must not exist`).toBe(false)
    }
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

  it('ships a default profile scoped to the core trio', () => {
    const profile = JSON.parse(
      readFileSync(path.join(TEMPLATES, 'profiles', 'default.json'), 'utf8'),
    ) as { agents: Array<{ id: string }> }
    const ids = profile.agents.map((a) => a.id).sort()
    expect(ids).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'])
  })
})
