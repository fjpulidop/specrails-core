import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Lifecycle invariant tests for the three sr-* agent templates.
 *
 * These tests assert that the templates contain the structural patterns
 * required by the fix-agent-openspec-lifecycle change:
 *
 *   - sr-architect: opsx:new precedes opsx:ff; specName guard present;
 *                   hand-authoring prohibition present
 *   - sr-developer: opsx:apply present; checkbox gate `- [ ]` checked;
 *                   specName guard present; Phase 4 prerequisite note present
 *   - sr-reviewer:  task gate present; opsx:archive present;
 *                   specName guard present
 *
 * Each invariant is tested against BOTH the canonical template file
 * (templates/agents/) and the installed agent file (.claude/agents/).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')

function readTemplate(name: string): string {
  return readFileSync(path.join(repoRoot, 'templates', 'agents', `${name}.md`), 'utf8')
}

function readInstalled(name: string): string {
  return readFileSync(path.join(repoRoot, '.claude', 'agents', `${name}.md`), 'utf8')
}

describe('sr-architect lifecycle invariants', () => {
  const files = {
    template: readTemplate('sr-architect'),
    installed: readInstalled('sr-architect'),
  }

  for (const [label, content] of Object.entries(files)) {
    describe(`[${label}]`, () => {
      it('does not mention /opsx:ff as a self-trigger in the frontmatter description', () => {
        // Extract just the frontmatter block (between first two ---)
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
        expect(frontmatterMatch).not.toBeNull()
        const frontmatter = frontmatterMatch![0]
        // The description must not say the agent triggers autonomously on /opsx:ff
        expect(frontmatter).not.toMatch(/invokes OpenSpec commands related to fast-forward/)
        expect(frontmatter).not.toMatch(/user invokes.*\/opsx:ff/)
      })

      it('states the agent is launched by orchestrator with specName argument', () => {
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
        expect(frontmatterMatch).not.toBeNull()
        const frontmatter = frontmatterMatch![0]
        expect(frontmatter).toMatch(/orchestrator/)
        expect(frontmatter).toMatch(/specName/)
      })

      it('contains specName required-argument guard', () => {
        expect(content).toMatch(/specName is required/)
        expect(content).toMatch(/\[error\] specName is required/)
      })

      it('contains opsx:new invocation before opsx:ff in the body', () => {
        // Strip the frontmatter block before checking order — the frontmatter
        // legitimately mentions opsx:ff (to say the agent does NOT auto-trigger
        // on it), but Step 0 in the body must list opsx:new before opsx:ff.
        const bodyStart = content.indexOf('\n---\n') + 5
        const body = content.slice(bodyStart)
        expect(body).toMatch(/opsx:new/)
        expect(body).toMatch(/opsx:ff/)
        // Verify ordering within body: opsx:new must appear before opsx:ff
        const newIndex = body.indexOf('opsx:new')
        const ffIndex = body.indexOf('opsx:ff')
        expect(newIndex).toBeGreaterThanOrEqual(0)
        expect(ffIndex).toBeGreaterThanOrEqual(0)
        expect(newIndex).toBeLessThan(ffIndex)
      })

      it('prohibits hand-authoring of proposal.md, design.md, tasks.md', () => {
        expect(content).toMatch(/MUST NOT hand-author/)
        expect(content).toMatch(/proposal\.md/)
        expect(content).toMatch(/design\.md/)
        expect(content).toMatch(/tasks\.md/)
      })
    })
  }
})

describe('sr-developer lifecycle invariants', () => {
  const files = {
    template: readTemplate('sr-developer'),
    installed: readInstalled('sr-developer'),
  }

  for (const [label, content] of Object.entries(files)) {
    describe(`[${label}]`, () => {
      it('contains specName required-argument guard', () => {
        expect(content).toMatch(/specName is required/)
        expect(content).toMatch(/\[error\] specName is required/)
      })

      it('invokes opsx:apply via Skill tool before writing files', () => {
        expect(content).toMatch(/opsx:apply/)
        // Must instruct to use Skill tool, not shell command
        expect(content).toMatch(/Skill\("opsx:apply"/)
      })

      it('contains checkbox verification gate checking for - [ ] pattern', () => {
        // Must mention the exact markdown checkbox pattern
        expect(content).toMatch(/- \[ \]/)
      })

      it('halts and reports incomplete tasks when unchecked boxes found', () => {
        expect(content).toMatch(/HALT/)
        expect(content).toMatch(/incomplete/)
      })

      it('states Phase 4 is unreachable unless checkbox gate passes', () => {
        expect(content).toMatch(/Phase 4 is (only reachable|unreachable)/)
      })
    })
  }
})

describe('sr-reviewer lifecycle invariants', () => {
  const files = {
    template: readTemplate('sr-reviewer'),
    installed: readInstalled('sr-reviewer'),
  }

  for (const [label, content] of Object.entries(files)) {
    describe(`[${label}]`, () => {
      it('contains specName required-argument guard', () => {
        expect(content).toMatch(/specName is required/)
        expect(content).toMatch(/\[error\] specName is required/)
      })

      it('contains Task Completion Gate step that checks - [ ] pattern', () => {
        expect(content).toMatch(/Task Completion Gate/)
        expect(content).toMatch(/- \[ \]/)
      })

      it('blocks archive when unchecked tasks remain', () => {
        expect(content).toMatch(/BLOCK archive/)
      })

      it('invokes opsx:archive via Skill tool only when gate passes', () => {
        expect(content).toMatch(/opsx:archive/)
        expect(content).toMatch(/Skill\("opsx:archive"/)
      })

      it('states archive step is only reachable when task gate passes', () => {
        // Step 6 (Archive) should be conditional on Step 5 (gate) passing
        const archiveIndex = content.indexOf('opsx:archive')
        const gateIndex = content.indexOf('Task Completion Gate')
        expect(archiveIndex).toBeGreaterThanOrEqual(0)
        expect(gateIndex).toBeGreaterThanOrEqual(0)
        // Gate must appear before archive instruction
        expect(gateIndex).toBeLessThan(archiveIndex)
      })
    })
  }
})
