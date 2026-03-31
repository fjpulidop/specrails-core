# Workflows & Commands

SpecRails commands are Claude Code slash commands that orchestrate the agent pipeline. Here's every command, what it does, and when to use it.

## The main workflow: `/specrails:implement`

This is the command you'll use most. It takes a feature request and drives it through the entire pipeline — from architecture to shipped PR.

### Usage

```
/specrails:implement #85                          # From a GitHub Issue
/specrails:implement #85, #71, #63               # Multiple issues (parallel)
/specrails:implement "add dark mode toggle"       # Text description
/specrails:implement UI, Analytics               # By area (explores + selects)
```

### Flags

| Flag | Effect |
|------|--------|
| `--dry-run` / `--preview` | Run the full pipeline without git operations or PRs |
| `--apply <name>` | Apply a previously cached dry-run |

### Pipeline phases

When you run `/specrails:implement #85`, here's what happens:

```
Phase -1    Environment check
            ↓ prerequisites verified
Phase 0     Parse input, detect mode + snapshot issue state
            ↓ feature(s) identified
Phase 3a.0  Conflict check — verify issue unchanged since Phase 0
            ↓ no external modifications detected
Phase 3a    Architect → design + tasks + compat check
            ↓ implementation plan ready
Phase 3b    Developer → write code
            ↓ implementation complete
Phase 3c    Test Writer → generate tests
            ↓ tests passing
Phase 3d    Doc Sync → update docs
            ↓ docs in sync
Phase 4     Security Reviewer → scan
            ↓ no critical findings
Phase 4b    Layer reviewers (Frontend + Backend, parallel)
            + Generalist Reviewer → run CI + fix issues
            ↓ CI green
Phase 4b-conf  Confidence gate → score 0–100% across 5 aspects
            ↓ score meets threshold (or override)
Phase 4c.0  Conflict check — verify issue unchanged before ship
            ↓ no external modifications detected
Phase 5     Create PR
```

### Single vs. multi-feature

| Mode | Behavior |
|------|----------|
| **Single feature** | Sequential pipeline, one branch |
| **Multiple features** | Parallel pipelines in **git worktrees**, auto-merged |

For multiple features, each gets its own isolated worktree. Agents run concurrently, and results are merged automatically at the end.

### Example output

```
/specrails:implement #85
```

```
┌─ Phase 3a: Architecture ──────────────────────┐
│ Architect analyzed issue #85                    │
│ Design: REST endpoint + middleware + migration   │
│ Tasks: 4 ordered steps                          │
└─────────────────────────────────────────────────┘

┌─ Phase 3b: Implementation ────────────────────┐
│ Developer completed 4/4 tasks                   │
│ Files: 6 created, 2 modified                    │
└─────────────────────────────────────────────────┘

┌─ Phase 3c: Tests ─────────────────────────────┐
│ Test Writer generated 12 tests                  │
│ Coverage: 87% of new code                       │
└─────────────────────────────────────────────────┘

┌─ Phase 4b: Review ────────────────────────────┐
│ Frontend Reviewer: bundle +2kb, WCAG ok         │
│ Backend Reviewer: no N+1, indexes ok            │
│ ✓ lint      ✓ typecheck     ✓ tests            │
│ Fixed: 1 import, 1 lint warning                 │
└─────────────────────────────────────────────────┘

┌─ Phase 4b-conf: Confidence ───────────────────┐
│ Correctness: 92%  Tests: 87%  Security: 95%     │
│ Performance: 88%  Maintainability: 90%          │
│ Overall: 90% — threshold met                    │
└─────────────────────────────────────────────────┘

PR #42 created: feat: add health check endpoint
```

---

## `/specrails:batch-implement`

Orchestrates **multiple independent features** in parallel using git worktrees. Use this when you have several unrelated features to ship at once.

```
/specrails:batch-implement #85, #71, #63
```

Each feature gets its own worktree, its own agent pipeline, and its own PR. Features run concurrently for maximum speed.

---

## `/specrails:get-backlog-specs`

View your prioritized product backlog, ranked by VPC fit and effort.

```
/specrails:get-backlog-specs                # Full backlog
/specrails:get-backlog-specs UI, API        # Filter by area
```

### What it shows

The Product Analyst reads your backlog (local tickets in `.specrails/local-tickets.json` by default, or GitHub Issues labeled `product-driven-backlog` if configured) and produces:

- **Backlog table** per area — sorted by Total Persona Score
- **Top 3 recommendations** — ranked by VPC score / effort ratio, filtered to Wave 1 of the safe implementation order
- **Metadata** — area, persona fit scores, effort estimate, description
- **Safe Implementation Order** — dependency DAG built from `Prerequisites:` fields in issue bodies; cycles are detected and reported; topological sort determines the order

### Example output

```
┌─ API ──────────────────────────────────────────┐
│ #  Issue   Score  Effort  Description           │
│ 1  #85     12/15  Medium  Health check endpoint │
│ 2  #71     10/15  Low     Rate limiting          │
│ 3  #63      8/15  High    GraphQL migration      │
└─────────────────────────────────────────────────┘

Safe Implementation Order (Wave 1):
1. #71 — Rate limiting (no prerequisites)
2. #85 — Health check (requires #71)
3. #63 — GraphQL migration (requires #85)
```

---

## `/specrails:auto-propose-backlog-specs`

Generate new feature ideas through product discovery. The Product Manager (Opus) researches your competitive landscape and generates ideas evaluated against your personas.

```
/specrails:auto-propose-backlog-specs              # All areas
/specrails:auto-propose-backlog-specs UI, API      # Focus areas
```

### What it does

1. Reads all persona files (VPC profiles)
2. Researches competitors via web search
3. Generates 2–4 feature ideas per area
4. Scores each against every persona (0–5)
5. Creates tickets in your active backlog provider (local tickets by default; GitHub Issues or JIRA if configured) or displays for manual creation

---

## `/specrails:refactor-recommender`

Scan for refactoring opportunities ranked by impact/effort ratio.

```
/specrails:refactor-recommender
```

Identifies duplicates, long functions, large files, dead code, outdated patterns, and complex logic. Optionally creates GitHub Issues for tracking.

---

## `/specrails:compat-check`

Analyze the backwards compatibility impact of a proposed change before implementation.

```
/specrails:compat-check #85                    # Check a specific issue
/specrails:compat-check #85 --save             # Check and save as the new API baseline
```

The Architect's Phase 6 auto-check runs this analysis as part of every `/specrails:implement` pipeline. You can also run it standalone to evaluate a change before committing to it.

### What it detects

| Category | Examples |
|----------|---------|
| **Removed endpoints** | Deleted routes, removed methods |
| **Changed signatures** | Parameter renames, type changes, reordered args |
| **Changed response shapes** | Added required fields, removed fields, type widening |
| **Behavioral changes** | Changed defaults, altered error codes, modified side effects |

When breaking changes are found, `compat-check` generates a **migration guide** describing what callers need to update.

---

## `/specrails:why`

Search agent explanation records in plain language.

```
/specrails:why "why did we switch to event sourcing"
/specrails:why "why is pagination implemented this way"
/specrails:why "explain the auth middleware design"
```

The Architect, Developer, and Reviewer record decision rationale in `.claude/agent-memory/explanations/` as they work. `/specrails:why` searches these records semantically and surfaces the relevant context.

This is useful for onboarding, code review, and revisiting past decisions without digging through git history.

---

## OpenSpec commands

These commands manage the structured design-to-code workflow powered by [OpenSpec](https://openspec.dev).

### `/opsx:ff` — Fast Forward

Create a change and generate **all artifacts at once** (proposal → design → tasks → context bundle). Use this when you know what you want to build and don't need to step through each artifact.

```
/opsx:ff
```

### `/opsx:new` — New Change

Start a new change with the step-by-step artifact workflow. Creates a proposal first, then you advance through each artifact.

```
/opsx:new
```

### `/opsx:continue` — Continue Change

Resume work on an in-progress change. Creates the next artifact in the sequence.

```
/opsx:continue
```

### `/opsx:apply` — Apply Change

Implement the tasks from a designed change. Hands off to the Developer agent.

```
/opsx:apply
```

### `/opsx:verify` — Verify Change

Validate that implementation matches the change artifacts before archiving.

```
/opsx:verify
```

### `/opsx:archive` — Archive Change

Finalize and archive a completed change. Moves it from active to archived.

```
/opsx:archive
```

### `/opsx:explore` — Explore

Open-ended thinking mode. Use for brainstorming, investigating problems, or clarifying requirements before creating a change.

```
/opsx:explore
```

### `/specrails:opsx-diff` — Spec Change Diff

Visualize the before/after diff of an OpenSpec change — what behavioral requirements are being added, modified, or removed.

```
/specrails:opsx-diff <change-name>
/specrails:opsx-diff my-feature --format json
/specrails:opsx-diff my-feature --summary-only
```

| Flag | Effect |
|------|--------|
| `<change-name>` | Kebab-case name of the change to diff (required) |
| `--format json` | Emit structured JSON instead of markdown |
| `--summary-only` | Show file-level summary only, skip inline line-level diff |

Compares the current specs against the named OpenSpec change. Useful during review to confirm a change matches its design intent before archiving.

### Typical OpenSpec flow

```
/opsx:ff          → Architect creates all artifacts
/opsx:apply       → Developer implements
/opsx:verify      → Validate implementation
/opsx:archive     → Finalize and archive
```

Or step by step:

```
/opsx:new         → Create proposal
/opsx:continue    → Create design
/opsx:continue    → Create tasks
/opsx:continue    → Create context bundle
/opsx:apply       → Implement
/opsx:archive     → Archive
```

---

## `/specrails:telemetry`

Inspect per-agent execution metrics: token usage, estimated API cost, run count, average duration, and success/failure rate.

```
/specrails:telemetry
/specrails:telemetry --period today
/specrails:telemetry --agent sr-developer
/specrails:telemetry --format json
/specrails:telemetry --save
```

### Flags

| Flag | Effect |
|------|--------|
| `--period <filter>` | Time window: `today`, `week` (default), or `all` |
| `--agent <name>` | Focus on a single agent (e.g. `sr-developer`) |
| `--format <fmt>` | Output format: `markdown` (default) or `json` |
| `--save` | Write a snapshot to `.claude/telemetry/` after display |

Reads Claude CLI JSONL session logs and agent-memory files to produce a cost dashboard with trend indicators and optimization recommendations.

---

## `/specrails:merge-resolve`

Resolve git conflict markers using AI-powered context analysis.

```
/specrails:merge-resolve
/specrails:merge-resolve --files src/api/routes.ts src/db/schema.ts
/specrails:merge-resolve --context openspec/changes/
```

### Flags

| Flag | Effect |
|------|--------|
| `--files <paths>` | Explicit file paths or globs to process (default: auto-detect from working tree) |
| `--context <dir>` | Directory of OpenSpec context bundles (default: `openspec/changes/`) |
| `--threshold <n>` | Minimum confidence threshold to auto-apply a resolution |

For each conflict block, the command reads the OpenSpec context bundles from the features that produced the conflict, infers the correct resolution, and writes it in place. Conflicts it cannot safely resolve are left with clean markers for manual review. Always review the result before committing.

---

## `/specrails:retry`

Resume a failed `/specrails:implement` run from the last successful phase — without restarting from scratch.

```
/specrails:retry <feature-name>              # Resume from the failed phase
/specrails:retry --list                      # List all available pipeline states
/specrails:retry <feature-name> --from architect   # Force resume from a specific phase
/specrails:retry <feature-name> --dry-run    # Resume in preview mode
```

When a pipeline fails mid-run (e.g., the reviewer hits a flaky CI issue), SpecRails saves pipeline state to `.claude/pipeline-state/<feature-name>.json`. `/specrails:retry` reads that state, identifies which phases completed, and re-executes only the remaining phases.

Valid `--from` phase values: `architect`, `developer`, `test-writer`, `doc-sync`, `reviewer`, `ship`, `ci`.

---

## `/specrails:vpc-drift`

Detect when your VPC personas have drifted from what your product actually delivers.

```
/specrails:vpc-drift                         # Analyze all personas
/specrails:vpc-drift --persona "Alex,Sara"   # Filter to specific personas
/specrails:vpc-drift --verbose               # Show full attribute lists
/specrails:vpc-drift --format json           # Emit report as JSON
```

Compares persona Jobs/Pains/Gains against the product backlog, implemented features, and agent memory to surface alignment gaps. Produces a per-persona alignment score and concrete recommendations for updating your VPC.

Run this when your backlog feels disconnected from your users, or after a major product pivot.

---

## `/specrails:memory-inspect`

Inspect agent memory directories to understand what your agents remember and clean up stale data.

```
/specrails:memory-inspect                    # Inspect all agent memory
/specrails:memory-inspect sr-developer       # Inspect a specific agent
/specrails:memory-inspect --stale 14         # Flag files older than 14 days
/specrails:memory-inspect --prune            # Delete stale files (after confirmation)
```

Agents write persistent memory to `.claude/agent-memory/sr-*/`. Over time this can accumulate stale or orphaned files. `/specrails:memory-inspect` shows per-agent stats (file count, size, last modified), recent entries, and actionable cleanup recommendations.

---

## `/specrails:propose-spec`

Explore a feature idea and produce a structured proposal ready for the OpenSpec pipeline.

```
/specrails:propose-spec "add rate limiting to the API"
```

The command explores your codebase to understand existing patterns, then produces a structured proposal with: problem statement, proposed solution, out-of-scope items, acceptance criteria, technical considerations, and a complexity estimate.

Use this before creating a GitHub Issue when you want a well-formed spec rather than a rough idea.

---

## Preview mode

Any workflow can be run in preview mode to see what would happen without making changes:

```
/specrails:implement --dry-run #85
```

Preview mode runs the full pipeline but skips:
- Git operations (no commits, no branches)
- PR creation
- Backlog updates

The results are cached. Apply them later with:

```
/specrails:implement --apply health-check-endpoint
```

---

## What's next?

- [Customization](customization.md) — adapt agents, rules, and personas to your project
- [Updating](updating.md) — keep SpecRails up to date

---

[← Agents](agents.md) · [Customization →](customization.md)
