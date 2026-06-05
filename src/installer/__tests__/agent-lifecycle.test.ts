import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Lifecycle invariant tests for the three sr-* agent templates.
 *
 * These tests assert that the Claude agent templates drive the OpenSpec
 * lifecycle through the `openspec` CLI DIRECTLY — not via the interactive
 * `/opsx:*` Skill wrappers. Those wrappers call AskUserQuestion/TodoWrite and
 * pause for input, so inside a non-interactive subagent they stall and push
 * the agent to hand-author a "simulated" (CLI-unregistered) change:
 *
 *   - sr-architect: scaffolds via `openspec new change` + `openspec validate`
 *                   (no Skill/opsx:ff indirection); specName guard; never
 *                   hand-creates the change directory
 *   - sr-developer: drives tasks.md directly (no Skill/opsx:apply); checkbox
 *                   gate `- [ ]` checked; specName guard; Phase 4 prerequisite
 *   - sr-reviewer:  task gate present; archives via `openspec archive -y` and
 *                   `openspec validate --strict` (no Skill/opsx:archive);
 *                   specName guard
 *
 * Each invariant is tested against the two live Claude sources that must
 * stay in lockstep:
 *   - the canonical Claude subagent template (templates/agents/)
 *   - the installed Claude subagent file (.claude/agents/)
 *
 * Codex enforces the equivalent OpenSpec-CLI lifecycle through its own
 * codex-native skills; that contract is asserted at the bottom of this file.
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

      it('scaffolds via the openspec CLI directly (no Skill/opsx:* indirection)', () => {
        const bodyStart = content.indexOf('\n---\n') + 5
        const body = content.slice(bodyStart)
        // CLI-first: the agent runs `openspec new change` and validates.
        expect(body).toMatch(/openspec new change/)
        expect(body).toMatch(/openspec validate/)
        // No interactive Skill wrappers — those stall in a non-interactive subagent.
        expect(body).not.toMatch(/Skill\("opsx:/)
      })

      it('registers the change through the CLI and never hand-creates the change dir', () => {
        // The agent authors the artifact PROSE, but the change itself must be
        // registered by `openspec new change` — never mkdir'd by hand.
        expect(content).toMatch(/never create the change directory/)
        expect(content).toMatch(/proposal/)
        expect(content).toMatch(/design\.md/)
        expect(content).toMatch(/tasks/)
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

      it('drives tasks.md directly and does NOT use the opsx:apply Skill wrapper', () => {
        expect(content).toMatch(/read the task list directly/)
        expect(content).toMatch(/tasks\.md/)
        // Must NOT route through the interactive Skill wrapper.
        expect(content).not.toMatch(/Skill\("opsx:apply"/)
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

      it('archives via the openspec CLI (no opsx:archive Skill wrapper)', () => {
        expect(content).toMatch(/openspec archive "<specName>" -y/)
        // The real CLI archive syncs delta specs + moves the dir; the Skill
        // wrapper does a manual move that skips sync and nests a Task spawn.
        expect(content).not.toMatch(/Skill\("opsx:archive"/)
      })

      it('runs openspec validate --strict as a structural gate', () => {
        expect(content).toMatch(/openspec validate "<specName>" --strict/)
      })

      it('states archive step is only reachable when task gate passes', () => {
        // The CLI archive command must appear AFTER the Task Completion Gate.
        const archiveIndex = content.indexOf('openspec archive "<specName>" -y')
        const gateIndex = content.indexOf('Task Completion Gate')
        expect(archiveIndex).toBeGreaterThanOrEqual(0)
        expect(gateIndex).toBeGreaterThanOrEqual(0)
        // Gate must appear before archive instruction
        expect(gateIndex).toBeLessThan(archiveIndex)
      })
    })
  }
})

/**
 * Codex archive contract.
 *
 * Regression guard for the bug where a codex `clean` run closed the ticket
 * but never archived the OpenSpec change (the archive step was absent from
 * every committed version of the codex implement orchestrator).
 *
 * Archive is authorized by the orchestrator after aggregation, then executed
 * by the reviewer rail in archive-only mode. This keeps the aggregate verdict
 * decision in the orchestrator while forcing the lifecycle close through the
 * reviewer and the OpenSpec CLI.
 */
function readCodexSkill(relPath: string): string {
  return readFileSync(path.join(repoRoot, 'templates', 'codex-skills', relPath), 'utf8')
}

describe('codex implement orchestrator archive contract', () => {
  const content = readCodexSkill(path.join('implement', 'SKILL.md'))

  it('runs `openspec archive <slug> -y`', () => {
    expect(content).toMatch(/openspec archive .*-y/)
  })

  it('makes archive mandatory on a clean verdict', () => {
    expect(content).toMatch(/mandatory[\s\S]{0,40}clean/i)
  })

  it('validates / re-confirms task boxes BEFORE archiving (gate precedes archive)', () => {
    // Anchor on the exact Phase 5 command strings: a bare `openspec archive`
    // also appears in the top-of-file contract clause, which would defeat a
    // loose indexOf comparison.
    const gateIndex = content.indexOf('openspec validate "<slug>" --strict')
    const archiveIndex = content.indexOf('openspec archive "<slug>" -y')
    expect(gateIndex).toBeGreaterThanOrEqual(0)
    expect(archiveIndex).toBeGreaterThanOrEqual(0)
    expect(gateIndex).toBeLessThan(archiveIndex)
  })

  it('exposes an Archive field in the mandatory final-report template', () => {
    expect(content).toMatch(/Archive:\s+archived/)
  })

  it('verifies the archive landed under openspec/changes/archive/<slug>', () => {
    expect(content).toMatch(/changes\/archive\/[^\n]*<slug>/)
  })

  it('delegates the clean archive close to sr-reviewer with authorization', () => {
    expect(content).toMatch(/\$sr-reviewer/)
    expect(content).toMatch(/ARCHIVE_ONLY=true/)
    expect(content).toMatch(/ARCHIVE_AUTHORIZED=true/)
  })
})

describe('codex reviewer rail archive contract', () => {
  const content = readCodexSkill(path.join('rails', 'sr-reviewer', 'SKILL.md'))

  it('archives with the OpenSpec CLI only when the orchestrator authorizes it', () => {
    expect(content).toMatch(/ARCHIVE_AUTHORIZED=true/)
    expect(content).toMatch(/ARCHIVE_ONLY=true/)
    expect(content).toMatch(/openspec archive "<slug>" -y/)
  })

  it('validates and checks task boxes before archiving', () => {
    const gateIndex = content.indexOf('openspec validate "<slug>" --strict')
    const taskIndex = content.indexOf('- [ ]')
    const archiveIndex = content.indexOf('openspec archive "<slug>" -y')
    expect(gateIndex).toBeGreaterThanOrEqual(0)
    expect(taskIndex).toBeGreaterThanOrEqual(0)
    expect(archiveIndex).toBeGreaterThanOrEqual(0)
    expect(gateIndex).toBeLessThan(archiveIndex)
    expect(taskIndex).toBeLessThan(archiveIndex)
  })
})
