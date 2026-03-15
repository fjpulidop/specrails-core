---
change: refactor-recommender
type: context-bundle
---

# Context Bundle: Refactor Priority Recommender

This document contains everything a developer needs to implement this change without reading any other file.

---

## What You Are Building

A new Claude Code slash command `templates/commands/refactor-recommender.md` that:

1. Scans the codebase for six categories of technical debt: duplicate code, long functions, large files, circular dependencies, outdated patterns, and dead code.
2. Scores each finding on impact (1-5) and effort (1-5) and computes a composite score using `impact * 2 + (6 - effort)`.
3. Creates a GitHub Issue per finding labeled `refactor-opportunity`, containing before/after code snippets and rationale.
4. Outputs a ranked summary table of all findings.
5. Respects a `--dry-run` flag (no issues created) and optional path scoping via `$ARGUMENTS`.

**This is a command file only — no agent, no shell script, no new config.** The entire implementation is one Markdown file placed at `templates/commands/refactor-recommender.md`, plus a resolved copy at `.claude/commands/refactor-recommender.md`.

---

## Files to Change

### Create

| Path | Description |
|------|-------------|
| `templates/commands/refactor-recommender.md` | The source template with `{{PLACEHOLDER}}` syntax |
| `.claude/commands/refactor-recommender.md` | The resolved specrails instance (no unresolved `{{...}}` strings) |

### Do NOT Modify

| Path | Reason |
|------|--------|
| `install.sh` | Line 319 already copies `templates/` wholesale — no change needed |
| `commands/setup.md` | Already handles all files in `templates/commands/` — no change needed |
| Any agent files | This feature is a command, not an agent |
| Any existing command files | No existing commands are affected |

---

## Existing Patterns to Follow

### Command file structure

Study `templates/commands/update-product-driven-backlog.md` as the closest existing analogue — it also:
- Creates GitHub Issues with a specific label
- Has a dry-run / write-access gate
- Uses `gh label create --force` for idempotent label creation
- Checks for existing issues before creating duplicates
- Outputs a summary at the end

The frontmatter pattern for all command templates:
```yaml
---
name: "Human-Readable Name"
description: "One-sentence description"
category: Workflow
tags: [workflow, relevant-tag, another-tag]
---
```

### Placeholder substitution

Only two placeholders are needed in this command:
- `{{PROJECT_NAME}}` — resolved to `specrails` in the `.claude/` copy
- `{{BACKLOG_PROVIDER_NAME}}` — resolved to `GitHub Issues` in the `.claude/` copy

Look at how these appear in `templates/commands/product-backlog.md` for usage examples. The pattern is always `{{UPPER_SNAKE_CASE}}`.

**Important:** Runtime-injected values like `$ARGUMENTS` are NOT placeholders. They are literal `$ARGUMENTS` in the file and are evaluated at command runtime by Claude Code.

### gh CLI patterns used in existing commands

From `templates/commands/update-product-driven-backlog.md`:

```bash
# Idempotent label creation
gh label create "label-name" --color "HEXHEX" --description "..." --force

# Fetch existing issues for dedup check
gh issue list --label "label-name" --state open --json title,number --limit 200

# Create an issue
gh issue create --title "..." --body "..." --label "label-name"

# Auth check
gh auth status 2>&1
```

---

## Exact Content to Write

### `templates/commands/refactor-recommender.md`

Write the file with this exact structure (expand each section as described):

```markdown
---
name: "Refactor Recommender"
description: "Scan the codebase for refactoring opportunities, score by impact/effort, and create ranked GitHub Issues"
category: Workflow
tags: [workflow, refactoring, technical-debt, code-quality]
---

Analyze {{PROJECT_NAME}} for technical debt and refactoring opportunities. Scores each finding by impact and effort, creates GitHub Issues labeled `refactor-opportunity`, and produces a ranked priority list.

**Input:** $ARGUMENTS — accepts:
- Optional comma-separated file or directory paths to scope the analysis
- Optional `--dry-run` flag: outputs findings without creating GitHub Issues

Examples:
- `/refactor-recommender` — analyze entire repo
- `/refactor-recommender src/` — analyze src/ only
- `/refactor-recommender --dry-run` — preview without creating issues
- `/refactor-recommender src/,lib/ --dry-run` — scoped preview

**IMPORTANT: This command reads code only.** Never write, modify, or delete source files.

---

## Phase 0: Environment Pre-flight

Check GitHub CLI authentication:
```bash
gh auth status 2>&1
```

Set `GH_AVAILABLE=true` if authenticated, `false` otherwise.

If `GH_AVAILABLE=false` and `--dry-run` is NOT set:
> Warning: GitHub CLI is not authenticated. Issues cannot be created. Add `--dry-run` to see findings without creating issues, or run `gh auth login` to authenticate.
> Proceeding in dry-run mode.
Set `DRY_RUN=true` automatically.

Report:
```
## Environment
| Tool | Status |
|------|--------|
| Backlog provider | {{BACKLOG_PROVIDER_NAME}} — ok/unavailable |
| dry-run mode | active/inactive |
```

---

## Phase 1: Parse Arguments and Determine Scope

### Flag detection

Scan `$ARGUMENTS` for `--dry-run`:
- If present: set `DRY_RUN=true`, remove from argument string
- If absent: set `DRY_RUN=false`

### Path scoping

Parse remaining `$ARGUMENTS` as comma-separated paths. If empty, set `SCOPE_PATHS=.` (entire repo).

Apply default exclusions regardless of scope:
- `node_modules/`
- `.git/`
- `.claude/`
- `vendor/`
- `dist/` and `build/`

Print:
```
Scope: <paths or "entire repo">
Exclusions: node_modules/, .git/, .claude/, vendor/, dist/, build/
```

### Large codebase detection

Count source files in scope. If more than 500 files:
- Print: "Large codebase detected (N files). Prioritizing recently modified files."
- Run: `git log --name-only --pretty=format: -n 100 | sort -u` to get recently modified files
- Restrict analysis to recently modified files within scope

---

## Phase 2: Analysis

Run six sequential analysis passes. For each pass, print progress:
`Analyzing: <Category Name>...`

Initialize `FINDINGS=[]`.

### 2.1 Duplicate Code

Read all source files in scope. Identify semantically duplicated logic — functions or blocks of 10+ lines that perform the same operation in two or more distinct files, even if variable names or minor details differ.

For each duplicate pair found, create a finding:
- **Category**: `Duplicate Code`
- **File**: primary file (list both locations in the snippet)
- **Current snippet**: both code locations (max 40 lines total, truncated with `...` if longer)
- **Proposed snippet**: a shared extracted function + updated call sites
- **Rationale**: why the duplication is a problem and what extraction enables

### 2.2 Long Functions

Read source files. Flag functions/methods exceeding these thresholds:

| Language | Threshold |
|----------|-----------|
| Shell (`.sh`) | 40 lines |
| JavaScript/TypeScript | 50 lines |
| Python | 50 lines |
| Go | 60 lines |
| All others | 50 lines |

For each violation:
- **Category**: `Long Function`
- **File**: file path + function name + line range
- **Current snippet**: function signature + first 5 lines + `...` + last 5 lines
- **Proposed snippet**: function decomposed into 2-4 named sub-functions with brief annotations

### 2.3 Large Files

List source files in scope. Check line counts.

| Language | Threshold |
|----------|-----------|
| Shell (`.sh`) | 400 lines |
| Markdown (`.md`) | 600 lines |
| All others | 300 lines |

For each violation:
- **Category**: `Large File`
- **File**: file path + line count
- **Current snippet**: the file's section headings or top-level function list (structural map)
- **Proposed snippet**: suggested module split with new file names and their responsibility

### 2.4 Circular Dependencies

Read all import/require/source statements. Build a mental dependency graph. Flag any cycle (A→B→C→A).

Patterns to detect by language:
- JS/TS: `import ... from '...'`, `require('...')`
- Python: `import ...`, `from ... import`
- Go: `import "..."`
- Shell: `source ...`, `. ...`

For each cycle:
- **Category**: `Circular Dependency`
- **File**: primary file in the cycle
- **Current snippet**: one import line per file in the cycle, showing the chain
- **Proposed snippet**: which import to break + the abstraction to extract (e.g., "move shared types to utils/types.ts")

### 2.5 Outdated Patterns

Look for known anti-patterns:

| File type | Anti-patterns |
|-----------|--------------|
| `.sh` | Backtick command substitution `` `cmd` `` (use `$(cmd)`), unquoted `$VARIABLES`, `[ ]` tests (prefer `[[ ]]`) |
| `.js` / `.ts` | `var` declarations, callback-style `function(err, result)` adjacent to Promise-based code, `any` type clusters (3+ in same file), `// @ts-ignore` |
| Markdown templates | Inconsistent placeholder casing (mixed `{{placeholder}}` and `{{PLACEHOLDER}}`) |
| Any | TODO/FIXME comments — flag clusters of 3+ in the same file |

For each cluster of violations (group by file):
- **Category**: `Outdated Pattern`
- **File**: file path
- **Current snippet**: the anti-pattern usage (max 20 lines)
- **Proposed snippet**: the modern equivalent

### 2.6 Dead Code

Identify code defined but never referenced within the scoped files:
- Functions/methods defined but never called
- Variables assigned but never read
- Files never imported by any other file in scope
- Commented-out code blocks of 10+ lines

For each finding:
- **Category**: `Dead Code`
- **File**: file path + line range
- **Current snippet**: the dead definition (max 20 lines)
- **Proposed snippet**: `Delete this code.` (plus migration notes if the symbol is exported)

---

## Phase 3: Score and Rank

For each finding in `FINDINGS`, compute:

**Impact score (1-5):**
| Score | Meaning |
|-------|---------|
| 5 | Causes bugs, security risk, or blocks future work |
| 4 | Significant readability or maintainability gain |
| 3 | Meaningful improvement, non-urgent |
| 2 | Nice to have |
| 1 | Cosmetic or stylistic |

**Effort score (1-5):**
| Score | Meaning |
|-------|---------|
| 5 | Trivial: rename, delete, single-line fix |
| 4 | Small: 1-2 hour self-contained change |
| 3 | Medium: half-day, touches multiple files |
| 2 | Large: full day, requires tests |
| 1 | Very large: multi-day, cross-cutting |

**Composite score** = `impact * 2 + (6 - effort)`

Range: 3 (lowest: impact=1, effort=1) to 15 (highest: impact=5, effort=5).

Sort `FINDINGS` by composite score descending. Break ties by impact descending, then effort ascending.

Print per-category summary:
```
Analyzing: Duplicate Code... N findings
Analyzing: Long Functions... N findings
Analyzing: Large Files... N findings
Analyzing: Circular Dependencies... N findings
Analyzing: Outdated Patterns... N findings
Analyzing: Dead Code... N findings
Total: N findings found.
```

If total is 0:
> No significant refactoring opportunities found. Codebase health looks good.
Stop here.

---

## Phase 4: Create GitHub Issues

### If `DRY_RUN=true`

Skip this phase entirely. Proceed to Phase 5.

### If `DRY_RUN=false`

#### 4.1 Ensure label exists (idempotent)

```bash
gh label create "refactor-opportunity" \
  --color "B60205" \
  --description "Identified refactoring opportunity" \
  --force
```

#### 4.2 Fetch existing issues for dedup check

```bash
gh issue list --label "refactor-opportunity" --state open --json title,number --limit 200
```

Store existing titles. For each finding, compute dedup key: `<category>:<file-path>` (lowercase, spaces replaced with `-`). If any existing issue title contains this key, skip creation and note the existing issue number.

#### 4.3 Create issue per finding

For each non-duplicate finding, run:

```bash
gh issue create \
  --title "[refactor] <Category>: <file-path> (<composite-score>)" \
  --label "refactor-opportunity" \
  --body "$(cat <<'EOF'
## Refactoring Opportunity

**Category:** <Category>
**File:** `<file-path>`
**Impact:** <N>/5 — <impact rationale>
**Effort:** <N>/5 — <effort rationale>
**Composite Score:** <N>/15

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

<2-4 sentences>

---

_Auto-generated by \`/refactor-recommender\` on $(date +%Y-%m-%d)_
_Project: {{PROJECT_NAME}} | Scored: Impact <N>/5 × Effort <N>/5 = Composite <N>/15_
EOF
)"
```

Store returned issue number for the summary table.

---

## Phase 5: Summary

Print the ranked summary table:

```
## Refactoring Opportunities (<N> found)

| # | Score | Category | File | Impact | Effort | Issue |
|---|-------|----------|------|--------|--------|-------|
| 1 | 13/15 | Outdated Pattern | install.sh | 5/5 | 2/5 | #42 |
| 2 | 11/15 | Long Function | templates/commands/implement.md | 4/5 | 2/5 | #43 |
...
```

If `DRY_RUN=true`, the `Issue` column shows `(dry-run, not created)` for all rows.
If a finding was skipped as a duplicate, the `Issue` column shows `(already tracked: #N)`.

If any issues were created:
```
Top recommendation: Run `/implement #<highest-score-issue-number>` to address the highest-priority item.
```
```

---

### `.claude/commands/refactor-recommender.md`

Identical content to the template above, except:
- `{{PROJECT_NAME}}` → `specrails`
- `{{BACKLOG_PROVIDER_NAME}}` → `GitHub Issues`

---

## Verification Checklist

Before considering this change complete:

- [ ] `templates/commands/refactor-recommender.md` exists
- [ ] YAML frontmatter is valid (name, description, category, tags present)
- [ ] All six analysis categories appear as distinct `###` subsections under Phase 2
- [ ] Composite score formula `impact * 2 + (6 - effort)` appears in Phase 3
- [ ] `--dry-run` flag gating is present in Phase 4 (entire phase skipped when set)
- [ ] `$ARGUMENTS` path scoping logic is present in Phase 1
- [ ] `gh label create "refactor-opportunity" ... --force` appears in Phase 4
- [ ] Duplicate detection (fetch existing issues, check dedup key) appears in Phase 4
- [ ] Issue body template matches the design.md format
- [ ] `{{PROJECT_NAME}}` and `{{BACKLOG_PROVIDER_NAME}}` are the only `{{...}}` placeholders in the template
- [ ] `.claude/commands/refactor-recommender.md` exists
- [ ] `grep '{{[A-Z_]*}}' .claude/commands/refactor-recommender.md` returns no output

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Analysis is too broad — too many low-quality findings | Medium | Thresholds in design.md are conservative. Adjust if >20 findings per run on a typical repo. |
| Analysis is too narrow — 0 findings on real codebases | Low | specrails itself has shell scripts and large Markdown files that should trigger at least large-file and outdated-pattern findings. |
| gh CLI not available or not authenticated | Medium | Phase 0 handles this: auto-switches to dry-run mode with a clear message. |
| Composite score formula produces unintuitive rankings | Low | Formula is documented inline. Developer can adjust weights if needed — just edit the Phase 3 section. |
| Dedup key collision — different issues map to same key | Low | Key is `category:file-path`. Two different refactors in the same file+category would collide. Acceptable for v1 — the analyst can manually untangle if needed. |
