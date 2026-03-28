# CLI Reference

SpecRails commands are implemented as Skills (`SKILL.md` format) and run in both Claude Code and Codex. The command syntax is identical on both platforms.

**Platform support key used in this reference:**

| Badge | Meaning |
|-------|---------|
| ✅ Both | Works in Claude Code and Codex |
| 🔵 Claude Code | Claude Code only |
| ⚠️ Limited | Works, but with known limitations (see notes) |

Run commands inside your AI CLI from your project directory:

```bash
claude   # Claude Code
codex    # Codex
```

---

## Core workflow

### `/specrails:implement` ✅ Both

Implement a feature through the full agent pipeline: design → code → tests → docs → review → PR.

```
/specrails:implement #85
/specrails:implement #85, #71, #63
/specrails:implement "add a health check endpoint"
/specrails:implement UI, Analytics
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

> **Codex note**: Parallel worktree isolation is limited in Codex CLI beta. For reliable parallel execution use Codex Cloud, or run one issue at a time with Codex CLI.

---

### `/specrails:telemetry` ✅ Both

Inspect per-agent execution metrics: token usage, estimated API cost, run count, average duration, and success/failure rate.

```
/specrails:telemetry
/specrails:telemetry --period today
/specrails:telemetry --agent sr-developer
/specrails:telemetry --format json
/specrails:telemetry --save
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--period <filter>` | Time window: `today`, `week` (default), or `all` |
| `--agent <name>` | Focus on a single agent (e.g. `sr-developer`) |
| `--format <fmt>` | Output format: `markdown` (default) or `json` |
| `--save` | Write a snapshot to `.claude/telemetry/` after display |

---

### `/specrails:merge-resolve` ✅ Both

Resolve git conflict markers using AI-powered context analysis.

```
/specrails:merge-resolve
/specrails:merge-resolve --files src/api/routes.ts
/specrails:merge-resolve --context openspec/changes/
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--files <paths>` | File paths or globs to process (default: auto-detect from working tree) |
| `--context <dir>` | Directory containing OpenSpec context bundles (default: `openspec/changes/`) |
| `--threshold <n>` | Minimum confidence to auto-apply a resolution |

Reads OpenSpec context bundles from the features that produced each conflict, infers the correct resolution, and writes it in place. Conflicts it cannot safely resolve are left with clean markers for manual review.

---

### `/specrails:retry` ✅ Both

Resume a failed `/specrails:implement` run from the last successful phase.

```
/specrails:retry <feature-name>
/specrails:retry --list
/specrails:retry <feature-name> --from architect
/specrails:retry <feature-name> --dry-run
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

### `/specrails:batch-implement` ⚠️ Limited on Codex

Implement multiple independent features in parallel using git worktrees.

```
/specrails:batch-implement #85, #71, #63
```

Each feature gets its own worktree, its own agent pipeline, and its own PR. Use this instead of `/specrails:implement` with multiple issues when you want explicit control over parallel execution.

> **Codex note**: Worktree isolation is limited in Codex CLI beta. Prefer Codex Cloud for parallel batch work.

---

## Product and backlog

### `/specrails:get-backlog-specs` ✅ Both

View your prioritized product backlog, ranked by VPC persona fit and estimated effort.

```
/specrails:get-backlog-specs
/specrails:get-backlog-specs UI, API
```

Reads GitHub Issues labeled `product-driven-backlog`. Produces a ranked table per area, top 3 recommendations, and a safe implementation order based on issue dependencies.

---

### `/specrails:auto-propose-backlog-specs` ✅ Both

Generate new feature ideas through product discovery and create GitHub Issues.

```
/specrails:auto-propose-backlog-specs
/specrails:auto-propose-backlog-specs UI, API
```

The Product Manager researches your competitive landscape, generates 2–4 feature ideas per area, and scores each against your user personas. Creates GitHub Issues with full VPC evaluation if write access is available.

---

## Analysis and inspection

### `/specrails:refactor-recommender` ✅ Both

Scan the codebase for refactoring opportunities, ranked by impact/effort ratio.

```
/specrails:refactor-recommender
```

Identifies duplicates, overly long functions, large files, dead code, outdated patterns, and complex logic. Optionally creates GitHub Issues for tracking.

---

### `/specrails:compat-check` ✅ Both

Analyze the backwards-compatibility impact of a proposed change.

```
/specrails:compat-check #85
/specrails:compat-check #85 --save
```

Detects removed endpoints, changed method signatures, changed response shapes, and behavioral changes. When breaking changes are found, generates a migration guide.

`--save` updates the stored API baseline so future checks compare against the new surface.

The Architect runs this automatically as part of every `/specrails:implement` pipeline.

---

### `/specrails:why` ✅ Both

Search agent explanation records in plain language.

```
/specrails:why "why did we choose this database schema"
/specrails:why "explain the auth middleware design"
/specrails:why "why is pagination implemented this way"
```

Agents write decision rationale to `.claude/agent-memory/explanations/` as they work. `/specrails:why` searches these records semantically. Useful for onboarding, code review, and revisiting past decisions.

---

### `/specrails:vpc-drift` ✅ Both

Detect when your VPC personas have drifted from what your product actually delivers.

```
/specrails:vpc-drift
/specrails:vpc-drift --persona "Alex,Sara"
/specrails:vpc-drift --verbose
/specrails:vpc-drift --format json
```

Compares persona Jobs/Pains/Gains against your backlog, implemented features, and agent memory. Produces a per-persona alignment score and recommendations for updating your VPC.

---

### `/specrails:memory-inspect` ✅ Both

Inspect and clean up agent memory directories.

```
/specrails:memory-inspect
/specrails:memory-inspect sr-developer
/specrails:memory-inspect --stale 14
/specrails:memory-inspect --prune
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--stale <days>` | Flag files older than N days |
| `--prune` | Delete stale files (prompts for confirmation) |

Agent memory lives in `.claude/agent-memory/sr-*/` (Claude Code) or `.codex/agent-memory/sr-*/` (Codex).

---

### `/specrails:propose-spec` ✅ Both

Explore a feature idea and produce a structured proposal ready for the OpenSpec pipeline.

```
/specrails:propose-spec "add rate limiting to the API"
```

Produces: problem statement, proposed solution, out-of-scope items, acceptance criteria, technical considerations, and a complexity estimate.

---

## OpenSpec commands

OpenSpec is the structured design-to-code workflow. Use these commands when you want explicit control over each artifact: proposal → design → tasks → implementation.

All OpenSpec commands work on both Claude Code and Codex (✅ Both).

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

### `/specrails:opsx-diff` — Spec Change Diff

Visualize the before/after diff of an OpenSpec change.

```
/specrails:opsx-diff <change-name>
/specrails:opsx-diff my-feature --format json
/specrails:opsx-diff my-feature --summary-only
```

**Flags:**

| Flag | Effect |
|------|--------|
| `<change-name>` | Kebab-case name of the change to diff (required) |
| `--format json` | Structured JSON output |
| `--summary-only` | File-level summary only, skip inline diff |

Compares the current specs against the named change. Use during review to confirm a change matches its design intent before archiving.

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
| `--provider <claude\|codex>` | Force a specific AI CLI (default: auto-detect) |

---

[← Quick Start](quick-start.md) · [FAQ →](faq.md) · [← Installation](installation.md) · [Codex vs Claude Code →](codex-vs-claude-code.md)
