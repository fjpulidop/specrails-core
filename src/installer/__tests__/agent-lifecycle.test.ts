import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Role and entry-point invariants. The programmatic runtime owns the
 * lifecycle (architect → developer → verify → reviewer → archive); the
 * installed role definitions only bind each role to its official OpenSpec
 * workflow and keep delivery with the host.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (...parts: string[]): string => readFileSync(path.join(repoRoot, 'templates', ...parts), 'utf8')

const ROLES = [
  { id: 'sr-architect', skill: 'opsx:ff' },
  { id: 'sr-developer', skill: 'opsx:apply' },
  { id: 'sr-reviewer', skill: 'opsx:verify' },
] as const

describe.each(ROLES)('$id role definition', ({ id, skill }) => {
  const agent = read('agents', `${id}.md`)
  const rail = read('codex-skills', 'rails', id, 'SKILL.md')

  it('declares its identity in frontmatter', () => {
    expect(agent).toMatch(new RegExp(`^---\\nname: ${id}\\n`))
    expect(rail).toMatch(new RegExp(`^---\\nname: ${id}\\n`))
  })

  it(`runs the official ${skill} workflow through the Skill tool`, () => {
    expect(agent).toContain(`Skill("${skill}"`)
    expect(rail).toContain(`Skill("${skill}"`)
  })

  it('reads scope from the frozen execution context and leaves delivery to the host', () => {
    for (const text of [agent, rail]) {
      expect(text).toContain('SPECRAILS_EXECUTION_CONTEXT')
      expect(text).toMatch(/host owns/)
    }
  })

  it('keeps the Codex rail body identical to the agent body', () => {
    const body = (text: string): string => text.slice(text.indexOf('\n---\n') + 5).replaceAll('{{PROJECT_NAME}}', 'this repository')
    expect(body(rail)).toBe(body(agent))
  })

  it('carries no retired placeholders or agent-memory contract', () => {
    expect(agent.match(/\{\{[A-Z_]+\}\}/g) ?? []).toEqual(['{{PROJECT_NAME}}'])
    expect(agent).not.toContain('agent-memory')
  })
})

describe('implementation entry points use the programmatic lifecycle', () => {
  it.each(['implement', 'batch-implement', 'retry'])('%s delegates lifecycle control to the runtime', (name) => {
    const text = read('commands', 'specrails', `${name}.md`)
    expect(text).toContain('agent-runtime.mjs')
    expect(text).toContain('resume --context')
    expect(text).not.toContain('spawn_agent')
  })
})
