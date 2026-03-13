---
change: refactor-recommender
type: design
---

# Design: Refactor Priority Recommender

## Context

specrails installs a complete agent workflow system into target repos. Slash commands in `.claude/commands/` are the primary user-facing interface. Templates in `templates/commands/` are source files that `install.sh` copies to `.claude/setup-templates/commands/`, and `/setup` then installs them into `.claude/commands/` with placeholders resolved.

The refactor-recommender is a **command, not an agent**. It runs in the main Claude Code conversation thread. No sub-agents are launched. Claude's built-in code analysis capabilities perform the scanning — no external static analysis tools are required. This keeps the feature universally compatible across all target repos regardless of language or toolchain.

## Goals / Non-Goals

**Goals:**
- Find six categories of refactoring debt with code evidence
- Score each finding on impact and effort (1-5 integers)
- Create GitHub Issues labeled `refactor-opportunity` with full context
- Produce a ranked summary table
- Work on any codebase without language-specific tooling

**Non-Goals:**
- No code transformation or PR creation
- No JIRA support in this iteration
- No custom scoring thresholds or config files
- No scheduled or CI-triggered runs

---

## Command Template Design

### File

`templates/commands/refactor-recommender.md`

### Frontmatter

```yaml
---
name: "Refactor Recommender"
description: "Scan the codebase for refactoring opportunities, score by impact/effort, and create ranked GitHub Issues"
category: Workflow
tags: [workflow, refactoring, technical-debt, code-quality]
---
```

### Placeholders Used

| Placeholder | Resolved by | Value in specrails |
|-------------|-------------|-------------------|
| `{{PROJECT_NAME}}` | `/setup` | `specrails` |
| `{{BACKLOG_PROVIDER_NAME}}` | `/setup` | `GitHub Issues` |

These are the only two placeholders needed. The command is otherwise self-contained. No per-project analysis is required to fill them.

### Arguments

`$ARGUMENTS` accepts two optional inputs, space-separated:
- One or more file/directory paths (comma-separated) to scope analysis. If omitted, the entire repo is analyzed (excluding `node_modules/`, `.git/`, `.claude/`, `vendor/`).
- `--dry-run` flag: when present, skip GitHub Issue creation and output all findings to console only.

Example invocations:
```
/refactor-recommender
/refactor-recommender src/
/refactor-recommender src/,lib/ --dry-run
/refactor-recommender --dry-run
```

---

## Analysis Design

### Six Analysis Categories

The command runs six sequential analysis passes. Each pass produces zero or more findings.

#### 1. Duplicate Code

**Detection approach:** Read all source files in scope. Identify semantically duplicated logic — functions or blocks that perform the same operation with minor surface differences (different variable names, slightly different control flow). This is NOT textual deduplication but semantic: two functions that parse URLs by splitting on `?` then `/` are duplicates even if named differently.

**Signal strength:** Focus on duplicates of 10+ lines. Flag only when the duplication appears in two or more distinct files (same-file duplication is a different refactor category: extract function).

**Snippet format:** Show both locations — `File A: lines N-M` and `File B: lines N-M`. The proposed snippet shows a shared extracted function with both call sites updated.

#### 2. Long Functions

**Detection approach:** Read source files. Flag any function/method exceeding a language-appropriate threshold:

| Language | Threshold |
|----------|-----------|
| Shell (`.sh`) | 40 lines |
| JavaScript/TypeScript | 50 lines |
| Python | 50 lines |
| Go | 60 lines |
| All others | 50 lines |

These thresholds are embedded in the command prompt. They are not configurable in v1.

**Snippet format:** Current snippet shows the function signature + first and last 5 lines with `...` in the middle. Proposed snippet shows the function decomposed into 2-4 smaller named functions, with a brief annotation of what each sub-function does.

#### 3. Large Files

**Detection approach:** List all source files in scope, check line counts.

| Language | Threshold |
|----------|-----------|
| Shell (`.sh`) | 400 lines |
| Markdown (`.md`) | 600 lines |
| All others | 300 lines |

**Snippet format:** Current snippet shows the file's section headings or function list (the structure, not line content). Proposed snippet shows the suggested module split with new file names.

#### 4. Circular Dependencies

**Detection approach:** Read import/require/source statements across files. Build a directed dependency graph mentally. Flag any cycle: A→B→C→A.

Language-specific import patterns to look for:
- JS/TS: `import ... from`, `require(`
- Python: `import`, `from ... import`
- Go: `import`
- Shell: `source`, `. `

**Snippet format:** Current snippet shows the import chain that creates the cycle (one import line per file involved). Proposed snippet shows the break point — which import should be replaced, and with what abstraction (e.g., "extract shared interface to `utils/types.ts`").

#### 5. Outdated Patterns

**Detection approach:** Look for known anti-patterns specific to the detected file types:

| File type | Anti-patterns to detect |
|-----------|------------------------|
| Shell scripts | `\`backtick\`` command substitution (use `$()`), `[ ]` tests (prefer `[[ ]]` in bash), unquoted variables |
| JavaScript | `var` declarations, `callback(err, result)` patterns where Promises exist nearby, `__dirname` when `import.meta.url` is used elsewhere |
| TypeScript | `any` type annotations (flag clusters of 3+ in the same file), `// @ts-ignore` comments |
| Markdown templates | Inconsistent placeholder casing (mixed `{{placeholder}}` and `{{PLACEHOLDER}}`) |
| Any | TODO/FIXME comments older than 6 months (check git blame if available) |

**Snippet format:** Current snippet shows the anti-pattern usage. Proposed snippet shows the modern equivalent.

#### 6. Dead Code

**Detection approach:** Identify code that is defined but never referenced within the scoped files:
- Functions/methods defined but never called
- Variables assigned but never read
- Files that are never imported by any other file in scope
- Commented-out blocks of 10+ lines

**Snippet format:** Current snippet shows the dead definition. Proposed snippet is simply: "Delete this code."

---

## Scoring Design

Every finding receives two integer scores (1-5):

| Score | Impact (what is gained by fixing) | Effort (how hard to fix) |
|-------|----------------------------------|--------------------------|
| 5 | Critical: causes bugs, security risk, or blocks future work | Trivial: rename, delete, single-line fix |
| 4 | High: significant readability or maintainability gain | Small: 1-2 hour change, self-contained |
| 3 | Medium: meaningful improvement, non-urgent | Medium: half-day, touches multiple files |
| 2 | Low: nice to have | Large: full day, requires tests |
| 1 | Minimal: cosmetic or stylistic only | Very large: multi-day, cross-cutting |

**Composite score** = `impact * 2 + (6 - effort)`. This formula weights impact twice as heavily as ease, producing a range of 3–15. Rationale: a high-impact hard fix (5 impact, 1 effort = score 13) ranks above a low-impact easy fix (1 impact, 5 effort = score 7).

Findings are ranked by composite score descending. Ties are broken by impact descending, then effort ascending.

---

## GitHub Issues Design

### Label

`refactor-opportunity` — created idempotently before any issues are written:

```bash
gh label create "refactor-opportunity" --color "B60205" --description "Identified refactoring opportunity" --force
```

The `--force` flag makes this idempotent (no error if label already exists).

### Duplicate Prevention

Before creating any issue, fetch existing open issues with this label:

```bash
gh issue list --label "refactor-opportunity" --state open --json title,number --limit 200
```

For each finding, compute a dedup key: `<category>:<normalized-file-path>`. If an existing issue title contains this key pattern, skip creation and note "already tracked in #N".

### Issue Title Format

```
[refactor] <Category>: <file-path> (<composite-score>)
```

Example: `[refactor] Long Function: templates/commands/implement.md (11)`

### Issue Body Format

```markdown
## Refactoring Opportunity

**Category:** Long Function
**File:** `templates/commands/implement.md`
**Impact:** 4/5 — High readability gain; function is hard to reason about at current length
**Effort:** 2/5 — Large: requires splitting into named sub-sections with updated cross-references
**Composite Score:** 11/15

---

## Current Code

```<language>
<current snippet — max 40 lines>
```

## Proposed Refactor

```<language>
<proposed snippet — max 40 lines>
```

## Rationale

<2-4 sentences explaining why this is a problem and what the proposed change improves>

---

_Auto-generated by `/refactor-recommender` on {DATE}_
_Scored: Impact {N}/5 × Effort {N}/5 = Composite {N}/15_
```

---

## Output Design

### Per-category progress output (during analysis)

```
Analyzing: Duplicate Code... 2 findings
Analyzing: Long Functions... 1 finding
Analyzing: Large Files... 0 findings
Analyzing: Circular Dependencies... 0 findings
Analyzing: Outdated Patterns... 3 findings
Analyzing: Dead Code... 1 finding
```

### Final ranked summary table

```
## Refactoring Opportunities (7 found)

| # | Score | Category | File | Impact | Effort | Issue |
|---|-------|----------|------|--------|--------|-------|
| 1 | 13/15 | Outdated Pattern | install.sh | 5/5 | 2/5 | #42 |
| 2 | 11/15 | Long Function | templates/commands/implement.md | 4/5 | 2/5 | #43 |
...

Top recommendation: Run `/implement #42` to address the highest-priority item.
```

In `--dry-run` mode, the `Issue` column shows `(dry-run, not created)` for all rows.

---

## Design Decisions

### D1: Command, not agent

A dedicated agent would add lifecycle overhead (frontmatter, memory directory, color assignment) for a task that is fundamentally a single-conversation analysis. The command runs inline. If the analysis grows complex enough to warrant background execution or multi-repo operation, promoting to an agent is straightforward.

### D2: No external static analysis tools

Tools like ESLint, pylint, or shellcheck would improve detection precision for their respective languages. However, requiring them makes the command fragile (tool not installed → command fails) and language-specific (Python-only repos don't have ESLint). Claude's code reading is sufficient for the six targeted categories and works universally. If a target repo already has these tools configured, the command can optionally use them — but does not depend on them.

### D3: Composite score formula: `impact * 2 + (6 - effort)`

Alternative considered: simple `impact / effort` ratio. Rejected because integer division produces many ties and the ratio is less intuitive to communicate in an issue title. The additive formula with doubled impact weight produces a clean 3-15 range, avoids division-by-zero, and is easy to explain: "impact matters twice as much as ease."

### D4: GitHub Issues only (no JIRA in v1)

The product-backlog and update-product-driven-backlog commands added JIRA support at significant complexity cost. For a v1 refactoring tool, the primary user is an engineer/architect who almost certainly has direct GitHub access. JIRA support can be added later following the same provider-branching pattern used in update-product-driven-backlog.md.

### D5: Max 40 lines per snippet in issue body

Long snippets make issues hard to read and GitHub renders code blocks up to ~100 lines gracefully. 40 lines is a reasonable cap that ensures the before/after contrast is readable without overwhelming the issue. For large-file findings where the "snippet" is a module map, 40 lines is more than sufficient.

### D6: install.sh needs no modification

`install.sh` line 319 runs `cp -r "$SCRIPT_DIR/templates/"* "$REPO_ROOT/.claude/setup-templates/"` — this copies the entire `templates/` directory tree, including `templates/commands/`. Adding a new file to `templates/commands/` is sufficient for it to be included in all future installs. Existing installations will receive it on the next `update.sh` run (which overwrites commands/).

---

## Edge Cases

- **Empty repo or scope with no source files**: Print "No source files found in scope. Nothing to analyze." and stop.
- **All findings already tracked**: Print "All findings already tracked in GitHub Issues. No new issues created." and show the existing issue numbers.
- **GitHub CLI not authenticated**: Print an error with `gh auth login` instructions. In this case, suggest `--dry-run` to still get the findings output.
- **Analysis produces 0 findings across all categories**: Print a positive message ("No significant refactoring opportunities found. Codebase health looks good.") and a summary table with all zeros.
- **Very large codebase (>500 source files)**: Prioritize files changed most recently (check git log) or explicitly scoped via $ARGUMENTS. Note in output: "Large codebase detected — prioritizing recently modified files."
