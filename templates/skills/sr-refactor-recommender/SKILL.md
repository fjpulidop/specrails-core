---
name: sr-refactor-recommender
description: "sr:refactor-recommender — Scan the codebase for refactoring opportunities ranked by impact/effort ratio. Optionally creates GitHub Issues for tracking."
license: MIT
compatibility: "Requires git."
metadata:
  author: specrails
  version: "1.0"
---


Scan the codebase for refactoring opportunities, score each by impact/effort ratio and VPC persona value, and optionally create GitHub Issues for the top findings in {{BACKLOG_PROVIDER_NAME}}.

**Input:** `$ARGUMENTS` — optional: comma-separated paths to scope the analysis. Flags: `--dry-run` (print findings without creating issues).

---

## Phase 0: Pre-flight

Check whether the GitHub CLI is available:

```bash
{{BACKLOG_PREFLIGHT}}
```

Set `GH_AVAILABLE=true` if the command succeeds, `GH_AVAILABLE=false` otherwise. Do not stop — analysis proceeds regardless. Parse `--dry-run` from `$ARGUMENTS` and set `DRY_RUN=true` if present.

---

## Phase 1: Scope

Parse paths from `$ARGUMENTS` after stripping any flags. If no paths are provided, scan the entire repository.

Always exclude the following from all analysis:

- `node_modules/`
- `.git/`
- `.claude/`
- `vendor/`
- `dist/`
- `build/`

---

## Phase 1.5: VPC Context

Check whether persona files exist at `.claude/agents/personas/`. This path is present in any repo that has run `/setup`.

```bash
ls .claude/agents/personas/ 2>/dev/null
```

If the directory exists and contains persona files, set `VPC_AVAILABLE=true`. Otherwise set `VPC_AVAILABLE=false` and skip all VPC steps (they are optional enrichment, not blockers).

When `VPC_AVAILABLE=true`, read each persona file and extract a compact VPC summary. For each persona record:

- **name** — persona display name (e.g. "Alex — The Lead Dev")
- **top_jobs** — up to 3 functional jobs relevant to code quality and maintainability
- **critical_pains** — up to 3 pains marked Critical or High related to code reliability, complexity, or developer experience
- **high_gains** — up to 3 gains marked High related to code clarity, speed, or confidence

Store these as an in-memory `VPC_PROFILES` list. You will use it in Phase 3 to score persona fit.

---

## Phase 2: Analysis

Analyze the scoped files across six categories. For each finding record:

- **file** — relative path
- **line_range** — start and end line numbers
- **current_snippet** — the problematic code as-is
- **proposed_snippet** — concrete refactored version
- **rationale** — one sentence explaining the improvement

### Duplicate Code

Find code blocks larger than 10 lines that are substantially similar across two or more files. Consolidation into a shared function or module is the expected refactoring.

### Long Functions

Find functions or methods exceeding 50 lines. Extraction into smaller, single-purpose functions is the expected refactoring.

### Large Files

Find files exceeding 300 lines. Splitting into cohesive modules is the expected refactoring.

### Dead Code

Find unused exports, unreferenced functions, and commented-out blocks that have not been active for the lifetime of the file. Deletion or archival is the expected refactoring.

### Outdated Patterns

Find deprecated APIs and old language syntax: `var` instead of `let`/`const`, callbacks instead of `async`/`await`, legacy framework APIs with documented replacements, etc. Modernisation to current idioms is the expected refactoring.

### Complex Logic

Find deeply nested conditionals (more than 3 levels) and functions with high cyclomatic complexity. Extraction, early-return guards, or strategy patterns are the expected refactoring.

---

## Phase 3: Score and Rank

Score every finding on three dimensions (1–5 each):

- **Impact** — how much the refactoring improves code quality, readability, or maintainability
- **Effort** — how hard the refactoring is to implement (1 = trivial, 5 = major)
- **VPC Value** — how directly this refactoring addresses persona jobs, pains, or gains (1 = no relevance, 5 = resolves a critical persona pain or delivers a high-value gain). Set to 3 when `VPC_AVAILABLE=false`.

**Scoring VPC Value** (only when `VPC_AVAILABLE=true`):

For each finding, reason over `VPC_PROFILES`:

- Does fixing this reduce a **Critical/High pain** for any persona? (e.g. complex logic → harder to trust AI output → Alex's "agents go off the rails" pain) → score 4–5
- Does fixing this deliver a **High gain** for any persona? (e.g. extracting a function → cleaner API surface → easier onboarding → Sara's gain) → score 3–4
- Is there indirect persona value? (e.g. dead code removal → smaller codebase → easier contributor review → Kai) → score 2–3
- No clear persona relevance → score 1–2

Assign one `vpc_value` integer per finding, and note the **primary persona** and **rationale** (one sentence).

**Composite score**: `impact * 2 + (6 - effort) + vpc_value`. Higher is better.

Sort all findings by composite score descending. If the same code block was flagged by multiple categories, keep only the highest-scored entry and discard the duplicates.

---

## Phase 4: Create GitHub Issues

Skip this phase if `GH_AVAILABLE=false` or `DRY_RUN=true`.

First ensure the tracking labels exist:

```bash
gh label create "refactor-opportunity" --color "B60205" --force
```

Fetch existing open issues that already carry the label to avoid duplicates:

```bash
gh issue list --label "refactor-opportunity" --state open --limit 100 --json number,title
```

For each of the **top 5** findings (by composite score) that does not already have a matching open issue, create a GitHub Issue with the following body:

```
## Refactoring Opportunity: {description}

**Category**: {category}
**File**: {file}:{line_range}
**Impact**: {impact}/5 | **Effort**: {effort}/5 | **Score**: {composite}
{vpc_line}

### Current Code
```{lang}
{current_snippet}
```

### Proposed Refactoring
```{lang}
{proposed_snippet}
```

### Rationale
{rationale}

---
_Generated by `/sr:refactor-recommender` in {{PROJECT_NAME}}_
```

Where `{vpc_line}` is included only when `VPC_AVAILABLE=true`:
`**VPC Value**: {vpc_value}/5 — {vpc_persona}: {vpc_rationale}`

---

## Phase 5: Output Summary

Print the following report:

```
## Refactoring Opportunities — {{PROJECT_NAME}}

{N} opportunities found | Sorted by composite score
{vpc_header}

| # | Category | File | Impact | Effort | VPC | Score | Description |
|---|----------|------|--------|--------|-----|-------|-------------|
| 1 | {category} | {file}:{line_range} | {impact}/5 | {effort}/5 | {vpc_value}/5 | {composite} | {description} |
...

### Top 3 Detailed Recommendations

#### 1. {description}
**File**: {file}:{line_range}
**Category**: {category} | **Score**: {composite}
{vpc_detail}

**Current:**
```{lang}
{current_snippet}
```

**Proposed:**
```{lang}
{proposed_snippet}
```

**Rationale:** {rationale}

(repeat for #2 and #3)

Issues created: {N}  (or "dry-run: no issues created")
```

Where:
- `{vpc_header}` is `VPC personas loaded: {persona names}` when `VPC_AVAILABLE=true`, or `VPC personas: not found (run /setup to enable)` otherwise.
- `{vpc_detail}` is `**VPC Value**: {vpc_value}/5 — {vpc_persona}: {vpc_rationale}` when `VPC_AVAILABLE=true`, omitted otherwise.
