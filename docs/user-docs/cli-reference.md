# CLI Reference

All commands are Claude Code slash commands. Run them inside Claude Code (`claude`) from your project directory.

---

## Core workflow

### `/sr:implement`

Implement a feature through the full agent pipeline: design → code → tests → docs → review → PR.

```
/sr:implement #85
/sr:implement #85, #71, #63
/sr:implement "add a health check endpoint"
/sr:implement UI, Analytics
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--dry-run` / `--preview` | Run the full pipeline without git operations or PR creation |
| `--apply <name>` | Apply a previously cached dry-run |

**Pipeline phases:**

| Phase | Agent | What happens |
|-------|-------|-------------|
| 3a | Architect | Designs the implementation, creates a task list |
| 3b | Developer | Writes code across all affected layers |
| 3c | Test Writer | Generates tests for new code |
| 3d | Doc Sync | Updates CHANGELOG and relevant docs |
| 4 | Security Reviewer | Scans for secrets and vulnerabilities |
| 4b | Reviewer | Runs your CI suite, fixes lint/type errors |
| 4b-conf | — | Confidence gate: scores implementation across 5 dimensions |
| 5 | — | Creates a pull request |

**Single vs. parallel:**

A single issue runs sequentially on the current branch. Multiple issues run in parallel — each gets an isolated git worktree, and results are merged automatically.

---

### `/sr:retry`

Resume a failed `/sr:implement` run from the last successful phase.

```
/sr:retry <feature-name>
/sr:retry --list
/sr:retry <feature-name> --from architect
/sr:retry <feature-name> --dry-run
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--list` | List all saved pipeline states |
| `--from <phase>` | Force resume from a specific phase |
| `--dry-run` | Resume in preview mode |

**Valid `--from` values:** `architect`, `developer`, `test-writer`, `doc-sync`, `reviewer`, `ship`, `ci`

Pipeline state is saved to `.claude/pipeline-state/<feature-name>.json` after each phase.

---

### `/sr:batch-implement`

Implement multiple independent features in parallel using git worktrees.

```
/sr:batch-implement #85, #71, #63
```

Each feature gets its own worktree, its own agent pipeline, and its own PR. Use this instead of `/sr:implement` with multiple issues when you want explicit control over parallel execution.

---

## Product and backlog

### `/sr:product-backlog`

View your prioritized product backlog, ranked by VPC persona fit and estimated effort.

```
/sr:product-backlog
/sr:product-backlog UI, API
```

Reads GitHub Issues labeled `product-driven-backlog`. Produces a ranked table per area, top 3 recommendations, and a safe implementation order based on issue dependencies.

---

### `/sr:update-product-driven-backlog`

Generate new feature ideas through product discovery and create GitHub Issues.

```
/sr:update-product-driven-backlog
/sr:update-product-driven-backlog UI, API
```

The Product Manager researches your competitive landscape, generates 2–4 feature ideas per area, and scores each against your user personas. Creates GitHub Issues with full VPC evaluation if write access is available.

---

## Analysis and inspection

### `/sr:health-check`

Run a comprehensive codebase quality analysis.

```
/sr:health-check
```

Analyzes code quality, test coverage, technical debt, complexity, and dependency health. Compares with previous runs to detect regressions.

---

### `/sr:refactor-recommender`

Scan the codebase for refactoring opportunities, ranked by impact/effort ratio.

```
/sr:refactor-recommender
```

Identifies duplicates, overly long functions, large files, dead code, outdated patterns, and complex logic. Optionally creates GitHub Issues for tracking.

---

### `/sr:compat-check`

Analyze the backwards-compatibility impact of a proposed change.

```
/sr:compat-check #85
/sr:compat-check #85 --save
```

Detects removed endpoints, changed method signatures, changed response shapes, and behavioral changes. When breaking changes are found, generates a migration guide.

`--save` updates the stored API baseline so future checks compare against the new surface.

The Architect runs this automatically as part of every `/sr:implement` pipeline.

---

### `/sr:why`

Search agent explanation records in plain language.

```
/sr:why "why did we choose this database schema"
/sr:why "explain the auth middleware design"
/sr:why "why is pagination implemented this way"
```

Agents write decision rationale to `.claude/agent-memory/explanations/` as they work. `/sr:why` searches these records semantically. Useful for onboarding, code review, and revisiting past decisions.

---

### `/sr:vpc-drift`

Detect when your VPC personas have drifted from what your product actually delivers.

```
/sr:vpc-drift
/sr:vpc-drift --persona "Alex,Sara"
/sr:vpc-drift --verbose
/sr:vpc-drift --format json
```

Compares persona Jobs/Pains/Gains against your backlog, implemented features, and agent memory. Produces a per-persona alignment score and recommendations for updating your VPC.

---

### `/sr:memory-inspect`

Inspect and clean up agent memory directories.

```
/sr:memory-inspect
/sr:memory-inspect sr-developer
/sr:memory-inspect --stale 14
/sr:memory-inspect --prune
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--stale <days>` | Flag files older than N days |
| `--prune` | Delete stale files (prompts for confirmation) |

Agent memory lives in `.claude/agent-memory/sr-*/`.

---

### `/sr:propose-spec`

Explore a feature idea and produce a structured proposal ready for the OpenSpec pipeline.

```
/sr:propose-spec "add rate limiting to the API"
```

Produces: problem statement, proposed solution, out-of-scope items, acceptance criteria, technical considerations, and a complexity estimate.

---

## OpenSpec commands

OpenSpec is the structured design-to-code workflow. Use these commands when you want explicit control over each artifact: proposal → design → tasks → implementation.

### `/opsx:ff` — Fast Forward

Create all OpenSpec artifacts at once (proposal + design + tasks + context bundle), then hand off to the developer.

```
/opsx:ff
```

Use this when you know what you want to build and don't need to review each artifact step by step.

---

### `/opsx:new` — New Change

Start a new change by creating a proposal. Advances through artifacts one at a time.

```
/opsx:new
```

---

### `/opsx:continue` — Continue Change

Create the next artifact in the sequence for the current in-progress change.

```
/opsx:continue
```

Typical sequence: proposal → design → tasks → context bundle.

---

### `/opsx:apply` — Apply Change

Implement the tasks from a designed change. Hands off to the Developer agent.

```
/opsx:apply
```

---

### `/opsx:verify` — Verify Change

Validate that the implementation matches the change artifacts before archiving.

```
/opsx:verify
```

---

### `/opsx:archive` — Archive Change

Finalize and archive a completed change.

```
/opsx:archive
```

---

### `/opsx:explore` — Explore

Open-ended thinking mode for brainstorming, investigating problems, or clarifying requirements before starting a change.

```
/opsx:explore
```

---

### Typical OpenSpec flows

**Fast path:**
```
/opsx:ff       → create all artifacts
/opsx:apply    → implement
/opsx:verify   → validate
/opsx:archive  → finalize
```

**Step by step:**
```
/opsx:new      → proposal
/opsx:continue → design
/opsx:continue → tasks
/opsx:continue → context bundle
/opsx:apply    → implement
/opsx:archive  → finalize
```

---

## Installer flags

The `npx specrails-core@latest init` command accepts:

| Flag | Effect |
|------|--------|
| `--root-dir <path>` | Install into this directory (default: current directory) |
| `--yes` / `-y` | Skip confirmation prompts |

---

[← Quick Start](quick-start.md) · [FAQ →](faq.md) · [← Installation](installation.md)
