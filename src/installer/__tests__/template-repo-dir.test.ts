/**
 * Guard test for STAGE 3 (runtime template re-pointing).
 *
 * Background: at runtime a rail spawns with `cwd = <workspace>` (where the
 * relocated `.claude/agents`, profiles, `.specrails/local-tickets.json` and
 * run-state live and resolve correctly cwd-relative) while the user's SOURCE
 * code, `openspec/**`, `.git`, and the GitHub remote stay in the REPO, reached
 * via `${SPECRAILS_REPO_DIR:-.}`. The spawner sets `SPECRAILS_REPO_DIR` to the
 * repo path; UNSET defaults to `.` so a classic in-repo run is byte-identical.
 *
 * This test is the cheapest insurance against a regression that points a
 * repo-resident read/write or a git/gh command at the workspace cwd. It greps
 * the IN-SCOPE runtime prompt templates for repo-resident literals that MUST be
 * wrapped in `${SPECRAILS_REPO_DIR` (or scoped via `cd "${SPECRAILS_REPO_DIR…`)
 * and FAILS if any operative occurrence is neither wrapped nor explicitly
 * allow-listed.
 *
 * It is deliberately scoped to the implement / retry / ship pipeline templates
 * (Claude + the mirrored codex/gemini skills) — the ones the spawner runs with
 * `cwd = <workspace>`. Other templates (`compat-check`, `opsx-diff`,
 * `explore-spec`, `merge-resolve`, …) are out of this change's scope and are not
 * scanned.
 *
 * The allow-list is tight on purpose: each entry pairs a file with a stable
 * substring of the exact line that is allowed to mention a repo-resident literal
 * WITHOUT the wrapper — always because the mention is prose, a stored relative
 * descriptor, a Skill-internal behaviour note, a report/summary line, or a
 * worktree-relative `git -C <worktree-path>` (where the worktree IS the cwd-side
 * repo copy). A real miss (an operative read/write or git mutation pointed at
 * the workspace) is NOT on the list and therefore fails.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const T = (rel: string) => path.join(REPO_ROOT, 'templates', rel)

/** The runtime prompt templates re-pointed by STAGE 3. */
const IN_SCOPE_FILES = [
  // Claude agents
  'agents/sr-developer.md',
  'agents/sr-architect.md',
  'agents/sr-reviewer.md',
  'agents/sr-backend-developer.md',
  'agents/sr-frontend-developer.md',
  // Claude commands
  'commands/specrails/implement.md',
  'commands/specrails/retry.md',
  // Codex skills (orchestrators + baseline trio + layer devs)
  'codex-skills/implement/SKILL.md',
  'codex-skills/retry/SKILL.md',
  'codex-skills/rails/sr-architect/SKILL.md',
  'codex-skills/rails/sr-developer/SKILL.md',
  'codex-skills/rails/sr-reviewer/SKILL.md',
  'codex-skills/rails/sr-backend-developer/SKILL.md',
  'codex-skills/rails/sr-frontend-developer/SKILL.md',
  // Gemini commands
  'gemini-commands/implement.toml',
] as const

/** The exact token every repo-resident reference must carry. */
const WRAPPER = '${SPECRAILS_REPO_DIR'

/**
 * Lines allowed to mention a repo-resident openspec literal WITHOUT the wrapper.
 * Key = in-scope file; value = list of stable substrings. A scanned line is
 * exempt when it CONTAINS any of the file's substrings. Reasons are inline.
 */
const OPENSPEC_ALLOW: Record<string, string[]> = {
  'agents/sr-reviewer.md': [
    // `opsx:archive` is a Skill that resolves openspec itself — these describe
    // what the SKILL does internally, not the reviewer's own on-disk access.
    '`opsx:archive` **syncs the delta specs**',
    '**You are EMULATING (a CRITICAL FAILURE) if you** run `mkdir`/`mv`',
    '**4 — Execution receipt.** Finish with an `## OpenSpec Skill Execution Receipt`',
  ],
  'commands/specrails/implement.md': [
    // Stored pipeline-state JSON value: a repo-RELATIVE descriptor consumed via
    // wrapped sites (retry prefixes it at read time). Wrapping the stored value
    // would bake an unexpanded shell token into the JSON.
    '"openspec_artifacts": "openspec/changes/<feature-name>/"',
    // Human-facing log/report lines (printed, not executed).
    'Resolution report: openspec/changes/<feature>/merge-resolution-report.md',
    '| OpenSpec proposal | openspec/changes/',
    '| OpenSpec design | openspec/changes/',
    '| OpenSpec tasks | openspec/changes/',
    '| OpenSpec context-bundle | openspec/changes/',
    '| Score file | `openspec/changes/<name>/confidence-score.json` |',
  ],
  'commands/specrails/retry.md': [
    // Documents the shape of the stored relative descriptor (prefixed on read).
    '- `OPENSPEC_ARTIFACTS` ← `openspec_artifacts` (e.g. `openspec/changes/<name>/`)',
  ],
  'codex-skills/implement/SKILL.md': [
    // Contract prose + ASCII pipeline diagram + report summary line.
    'without an archived change under `openspec/changes/archive/`',
    'produces openspec/changes/<slug>/{proposal,design,tasks,specs}',
    'archived (`openspec/changes/archive/<slug>/` exists)',
    'Archive:   archived → openspec/changes/archive/<slug>',
  ],
  'codex-skills/retry/SKILL.md': [
    // State-summary output lines (printed to the user).
    'Change pkg:  openspec/changes/<slug>/ (<found / missing>)',
    'change package at `openspec/changes/<slug>/` (<found|missing>)',
  ],
  'codex-skills/rails/sr-architect/SKILL.md': [
    // Frontmatter description + the architect's structured REPORT fields
    // (descriptive locations, not operative reads).
    'description: "Architect role for the specrails implement pipeline.',
    '- Path: `openspec/changes/<change-slug>/`',
    '- Proposal: `openspec/changes/<change-slug>/proposal.md`',
    '- Design: `openspec/changes/<change-slug>/design.md`',
    '- Tasks: `openspec/changes/<change-slug>/tasks.md`',
    'OpenSpec change: openspec/changes/<slug>/',
  ],
  'codex-skills/rails/sr-developer/SKILL.md': [
    // "Changed:" report block listing the touched artefact (descriptive).
    '- openspec/changes/<slug>/tasks.md',
  ],
  'codex-skills/rails/sr-frontend-developer/SKILL.md': [
    // "Changed:" report block listing the touched artefact (descriptive).
    '- openspec/changes/<slug>/tasks.md',
  ],
}

/**
 * Lines allowed to carry a `git`/`gh` command WITHOUT the wrapper. Same shape
 * as OPENSPEC_ALLOW.
 */
const GIT_ALLOW: Record<string, string[]> = {
  'commands/specrails/implement.md': [
    // `<worktree-path>` is an absolute git-worktree path supplied by the runtime
    // — `git -C <worktree-path>` already targets it directly.
    'git -C <worktree-path> diff main --name-only',
    'git -C <worktree-path> diff main -- <file>',
    'git worktree remove <worktree-path> --force',
    'git-worktree path supplied by the runtime', // the explanatory sentence
    // Prose: describes that multi-feature runs execute in isolated git worktrees.
    'Multi-feature runs execute in **isolated git worktrees**',
    // Prose error-context strings (printed, not executed).
    '**Pipeline state:** update `ship` → `done` if git operations',
  ],
  'commands/specrails/retry.md': [
    // Prose: "discover files from git diff".
    'the sr-test-writer will discover files from git diff',
  ],
  'codex-skills/implement/SKILL.md': [
    // Prose forbidding speculative inspection during a wait.
    'Run `find`, `git status`, `git diff`, `npm test`, `ls`, or',
  ],
  'gemini-commands/implement.toml': [
    // Read-only inspection examples listed as prose (backtick references).
    '`git status`, `openspec status`) and to CONFIRM what the',
  ],
}

/**
 * Lines allowed to carry a verb-form `openspec <verb>` invocation WITHOUT the
 * wrapper — always because the mention is descriptive prose (a backtick-quoted
 * reference inside a sentence, a report field, or a contract note), NOT an
 * operative shell invocation. An operative `openspec <verb>` that actually runs
 * MUST be wrapped as `(cd "${SPECRAILS_REPO_DIR:-.}" && openspec <verb> …)`.
 */
const OPENSPEC_VERB_ALLOW: Record<string, string[]> = {
  'agents/sr-architect.md': [
    // Prose describing what the opsx:ff Skill does internally + a report field.
    '`opsx:ff` runs `openspec new change` and then drives `openspec instructions`',
    'verified artifacts (paths + `openspec status` result)',
  ],
  'codex-skills/implement/SKILL.md': [
    // Contract prose: archiving is an obligation; failure-mode enumeration.
    'Archiving (`openspec archive`) is a hard obligation',
    'If `openspec validate`, `openspec archive`, or the step-3',
  ],
  'codex-skills/rails/sr-architect/SKILL.md': [
    // Prose: "stays trackable by `openspec status`" + a re-run hint + a
    // do-not-hand-off note. The operative calls on the surrounding lines ARE
    // wrapped; these are descriptive references.
    'stays trackable by `openspec status`',
    're-run `openspec new change …`',
    'that fails `openspec validate`',
  ],
  'codex-skills/rails/sr-reviewer/SKILL.md': [
    // Prose describing the archive step + the named "only mutation" note.
    'confirm all tasks are checked, run `openspec archive`, and',
    'mutation is `openspec archive "<slug>" -y` during Step 7 when',
  ],
  'gemini-commands/implement.toml': [
    // Read-only inspection examples + failure-mode prose (backtick references).
    '`git status`, `openspec status`) and to CONFIRM what the',
    '(`openspec validate <id> --strict`).',
    'running `openspec archive` (or moving files) to get past a failing',
  ],
}

/** Regexes for the literals we scan for. */
const OPENSPEC_RE = /openspec\/(changes|specs)/
/**
 * Verb-form openspec invocations. A line that matches MUST carry the
 * `${SPECRAILS_REPO_DIR` wrapper (operative, repo-scoped) or be on the curated
 * OPENSPEC_VERB_ALLOW prose allow-list — otherwise it would run `openspec`
 * against the workspace cwd, where there is no OpenSpec project.
 */
const OPENSPEC_VERB_RE = /\bopenspec\s+(validate|status|instructions|archive|new|init|update)\b/
const GIT_MUTATION_RE =
  /\b(git (checkout|commit|push|diff|add|worktree|rev-parse|status)|gh (issue|pr) )/

function isAllowed(allow: Record<string, string[]>, file: string, line: string): boolean {
  const subs = allow[file]
  if (!subs) return false
  return subs.some((s) => line.includes(s))
}

describe('STAGE 3 — runtime templates point repo-resident artifacts at ${SPECRAILS_REPO_DIR:-.}', () => {
  it('every in-scope runtime template exists and is non-empty', () => {
    for (const rel of IN_SCOPE_FILES) {
      const body = readFileSync(T(rel), 'utf8')
      expect(body.length, `${rel} should be a non-empty template`).toBeGreaterThan(0)
    }
  })

  it('every operative openspec/** reference is wrapped in ${SPECRAILS_REPO_DIR (or allow-listed)', () => {
    const misses: string[] = []
    for (const rel of IN_SCOPE_FILES) {
      const lines = readFileSync(T(rel), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!OPENSPEC_RE.test(line)) return
        if (line.includes(WRAPPER)) return // wrapped — good
        if (isAllowed(OPENSPEC_ALLOW, rel, line)) return // prose/report/stored
        misses.push(`${rel}:${i + 1}  ${line.trim()}`)
      })
    }
    expect(
      misses,
      `Bare openspec/** literal(s) found that must be wrapped in \`${WRAPPER}:-.}/openspec/...\`\n` +
        `(or added to OPENSPEC_ALLOW with a reason if genuinely prose):\n` +
        misses.join('\n'),
    ).toEqual([])
  })

  it('every operative `openspec <verb>` invocation is repo-scoped via ${SPECRAILS_REPO_DIR (or allow-listed)', () => {
    // Catches the verb FORMS the path-only OPENSPEC_RE misses: a bare
    // `openspec validate|status|instructions|archive|new|init|update` runs the
    // CLI from cwd=workspace, where there is no OpenSpec project → it fails with
    // "not an OpenSpec project". Operative calls MUST carry the repo-dir wrapper;
    // descriptive prose is curated in OPENSPEC_VERB_ALLOW.
    const misses: string[] = []
    for (const rel of IN_SCOPE_FILES) {
      const lines = readFileSync(T(rel), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!OPENSPEC_VERB_RE.test(line)) return
        if (line.includes(WRAPPER)) return // repo-scoped — good
        if (isAllowed(OPENSPEC_VERB_ALLOW, rel, line)) return // prose/report
        misses.push(`${rel}:${i + 1}  ${line.trim()}`)
      })
    }
    expect(
      misses,
      `Operative \`openspec <verb>\` invocation(s) found that must be repo-scoped as ` +
        `\`(cd "${WRAPPER}:-.}" && openspec <verb> …)\`\n` +
        `(or added to OPENSPEC_VERB_ALLOW with a reason if genuinely prose):\n` +
        misses.join('\n'),
    ).toEqual([])
  })

  it('every git/gh command is scoped to the repo via -C/cd "${SPECRAILS_REPO_DIR (or allow-listed)', () => {
    const misses: string[] = []
    for (const rel of IN_SCOPE_FILES) {
      const lines = readFileSync(T(rel), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!GIT_MUTATION_RE.test(line)) return
        if (line.includes(WRAPPER)) return // `git -C "${SPECRAILS_REPO_DIR..."` or `(cd "${SPECRAILS_REPO_DIR..." && gh ...)`
        if (isAllowed(GIT_ALLOW, rel, line)) return
        misses.push(`${rel}:${i + 1}  ${line.trim()}`)
      })
    }
    expect(
      misses,
      `git/gh command(s) found that must be scoped to the repo via ` +
        `\`git -C "${WRAPPER}:-.}"\` or \`(cd "${WRAPPER}:-.}" && gh ...)\`\n` +
        `(or added to GIT_ALLOW with a reason if genuinely prose/worktree):\n` +
        misses.join('\n'),
    ).toEqual([])
  })

  it('positively confirms the canonical wrapped tokens are present where expected', () => {
    // A sanity anchor so the test cannot pass merely because everything is
    // allow-listed: assert the real wrapping landed in the key spots.
    const implement = readFileSync(T('commands/specrails/implement.md'), 'utf8')
    expect(implement).toContain('${SPECRAILS_REPO_DIR:-.}/openspec/changes/<name>/tasks.md')
    expect(implement).toContain('git -C "${SPECRAILS_REPO_DIR:-.}" checkout -b feat/')
    expect(implement).toContain('git -C "${SPECRAILS_REPO_DIR:-.}" push -u origin')
    expect(implement).toContain('(cd "${SPECRAILS_REPO_DIR:-.}" && gh ...)')
    expect(implement).toContain('cp <worktree-path>/<file> "${SPECRAILS_REPO_DIR:-.}"/<file>')

    const dev = readFileSync(T('agents/sr-developer.md'), 'utf8')
    expect(dev).toContain('${SPECRAILS_REPO_DIR:-.}/openspec/changes/<name>/')
    // The explicit source-edit instruction the developer needs.
    expect(dev).toContain('${SPECRAILS_REPO_DIR:-.}/<path>')

    const retry = readFileSync(T('commands/specrails/retry.md'), 'utf8')
    expect(retry).toContain('${SPECRAILS_REPO_DIR:-.}/<OPENSPEC_ARTIFACTS>tasks.md')
  })

  it('does NOT wrap run-state paths — they follow the workspace (cwd-relative)', () => {
    // pipeline-state, agent-memory, backlog-cache, and the dry-run cache are
    // run-state: they FOLLOW the workspace and must stay cwd-relative. A regression
    // that prefixed them with ${SPECRAILS_REPO_DIR would send them to the repo.
    const RUN_STATE_RE = /(pipeline-state|agent-memory|backlog-cache|\.dry-run)/
    const offenders: string[] = []
    for (const rel of IN_SCOPE_FILES) {
      const lines = readFileSync(T(rel), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!RUN_STATE_RE.test(line)) return
        // Offender = a run-state literal that has the repo-dir wrapper applied to
        // it. We detect the wrapper immediately preceding the run-state segment.
        const wrappedRunState =
          /\$\{SPECRAILS_REPO_DIR[^`'"\s]*\/?[^`'"\s]*(pipeline-state|agent-memory|backlog-cache|\.dry-run)/
        if (wrappedRunState.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`)
        }
      })
    }
    expect(
      offenders,
      `Run-state literal(s) were wrapped in \`${WRAPPER}\` but MUST stay cwd-relative ` +
        `(they follow the workspace, not the repo):\n` + offenders.join('\n'),
    ).toEqual([])
  })

  it('UNSET ${SPECRAILS_REPO_DIR:-.} default keeps the token resolving to "." (byte-identical to today)', () => {
    // The contract: the default `-.` makes an unset env resolve to the current
    // directory. Assert every wrapped occurrence uses the `:-.` default form, so
    // a classic in-repo run (var unset, cwd=repo) is byte-identical to before.
    const offenders: string[] = []
    for (const rel of IN_SCOPE_FILES) {
      const lines = readFileSync(T(rel), 'utf8').split('\n')
      lines.forEach((line, i) => {
        // Find each ${SPECRAILS_REPO_DIR...} occurrence and require the :-. default.
        const re = /\$\{SPECRAILS_REPO_DIR(:-\.)?\}/g
        let m: RegExpExecArray | null
        while ((m = re.exec(line)) !== null) {
          if (m[1] !== ':-.') {
            offenders.push(`${rel}:${i + 1}  ${line.trim()}`)
            break
          }
        }
      })
    }
    expect(
      offenders,
      `Every \`\${SPECRAILS_REPO_DIR...}\` MUST use the \`:-.\` default so an unset ` +
        `environment resolves to "." (byte-identical to a classic in-repo run):\n` +
        offenders.join('\n'),
    ).toEqual([])
  })
})
