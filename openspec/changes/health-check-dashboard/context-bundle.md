---
change: health-check-dashboard
type: context-bundle
---

# Context Bundle: Codebase Health Check Dashboard

Everything a developer needs to implement this feature. No other file needs to be read first.

---

## What You Are Building

A new slash command template: `templates/commands/health-check.md`.

When a user runs `/health-check` in any specrails-installed repo, this command:

1. Parses optional `--since` and `--only` flags from `$ARGUMENTS`
2. Detects the available toolchain (test runner, linter, coverage tool, dependency auditor, complexity analyzer, perf script) by probing for common tool names
3. Loads the most recent health report from `.claude/health-history/` (if any)
4. Runs all available checks sequentially
5. Computes pass/fail/regression status per check and an overall A–F grade
6. Prints a formatted health report to the terminal
7. Stores the report as JSON at `.claude/health-history/<YYYY-MM-DD>-<short-sha>.json`

This is a single Markdown file. There are no new agents, no changes to `install.sh`, no changes to any existing command. The command is picked up automatically by `/setup` because `install.sh` already does `cp -r "$SCRIPT_DIR/templates/"*` and then `/setup` generates `.claude/commands/` from the templates.

---

## Files to Change

| File | Change type | Notes |
|------|-------------|-------|
| `templates/commands/health-check.md` | **Create** | The only file to write |

**Do NOT modify:**
- `install.sh` — no change needed; templates are copied automatically
- `templates/commands/implement.md` — unrelated
- Any existing `.claude/commands/` files — those are generated, not source

---

## Current State of the Command Template Directory

```
templates/commands/
├── implement.md               # Full pipeline command (complex, multi-phase)
├── product-backlog.md         # Simple viewer command (good reference for structure)
└── update-product-driven-backlog.md
```

There is no `health-check.md` yet. You are creating it from scratch.

---

## How the Template System Works

1. `install.sh` copies everything in `templates/` to `.claude/setup-templates/` in the target repo.
2. When the user runs `/setup` in Claude Code, the setup command reads templates from `.claude/setup-templates/`, substitutes `{{PLACEHOLDER}}` tokens with project-specific values, and writes the resolved files to `.claude/commands/`, `.claude/agents/`, etc.
3. The substituted commands become the user's active slash commands.

Your template will have `{{PROJECT_NAME}}` and `{{CI_COMMANDS}}` placeholders. These are already resolved by `/setup` for every installed repo (they appear in `implement.md`). No new placeholder resolution logic is needed anywhere.

**Placeholder rules (from CLAUDE.md conventions):**
- Only use `{{UPPER_SNAKE_CASE}}` for values substituted statically by `/setup`
- Runtime variables in command logic (`DRY_RUN`, `TOOL_TESTS`, etc.) use plain `UPPER_SNAKE_CASE` inline in prose — never `{{...}}` syntax
- Every `{{PLACEHOLDER}}` must be one that `/setup` already knows how to resolve

---

## Exact File to Create

### `templates/commands/health-check.md`

#### Frontmatter

```yaml
---
name: "Health Check Dashboard"
description: "Run all CI checks, produce a health report with trend comparison, and store a snapshot"
category: Workflow
tags: [workflow, health, quality, dashboard, ci]
---
```

#### Input Declaration (immediately after frontmatter, before Phase 0)

```markdown
Run a full quality health check on {{PROJECT_NAME}}. Detects available tools automatically — no configuration required.

**Input:** $ARGUMENTS (optional)

- `--since <YYYY-MM-DD>` — compare against the report from this date instead of the most recent
- `--only <checks>` — run only the specified checks (comma-separated: `tests`, `coverage`, `lint`, `complexity`, `deps`, `perf`)

Examples:
- `/health-check` — run all checks, compare to latest
- `/health-check --only deps,lint` — quick security + linting pass
- `/health-check --since 2026-03-01` — compare to a specific historical baseline

---
```

#### Phase 0: Argument Parsing

Parse `$ARGUMENTS`. Set:

- `COMPARE_DATE` — extracted from `--since <date>`, or empty string
- `CHECKS_FILTER` — extracted from `--only <list>`, parsed into an array, or the string "all"

Validate `--only` values: if any value is not one of `tests`, `coverage`, `lint`, `complexity`, `deps`, `perf`, print an error listing valid values and stop.

Print: `Running checks: <CHECKS_FILTER value> | Comparing to: <COMPARE_DATE or "latest">`

#### Phase 1: Toolchain Detection

Detect all six check categories simultaneously (parallel probes using Bash tool calls in parallel). For each category, try tools in the order listed below. Stop at the first one found. Set `TOOL_<CHECK>` and `TOOL_<CHECK>_AVAILABLE`.

If `CHECKS_FILTER` excludes a category, skip its detection.

Detection probe sequences:

**tests:**
Try in order: `jest`, `vitest`, `mocha`, `pytest`, `go test`, `cargo test`, `rspec`, `dotnet test`.
If none found but `{{CI_COMMANDS}}` is non-empty, set `TOOL_TESTS={{CI_COMMANDS}}` and `TOOL_TESTS_AVAILABLE=true`.
Otherwise: `TOOL_TESTS_AVAILABLE=false`.

**coverage:**
Try: `nyc`, `c8`, `pytest-cov` (check for `pytest --cov` availability), `coverage` (Python), `go test -cover` (available if Go project detected), `cargo tarpaulin`, `lcov`.

**lint:**
Try: `eslint`, `pylint`, `flake8`, `ruff`, `golangci-lint`, `rubocop`, `cargo clippy`, `shellcheck`.

**complexity:**
Try: `lizard`, `radon`, `gocyclo`, `plato`.
If none found: `TOOL_COMPLEXITY_AVAILABLE=false`, `COMPLEXITY_SOURCE="unavailable"`. (Will attempt estimation from lint output in Phase 3.)

**deps:**
Try: `npm audit` (if `package.json` present), `pip-audit` (if `requirements.txt` or `pyproject.toml` present), `govulncheck` (if `go.mod` present), `cargo audit` (if `Cargo.toml` present), `bundle audit` (if `Gemfile` present).

**perf:**
Check for (in order): `scripts/perf.sh`, `scripts/benchmark.sh`, `package.json` script named `"perf"` or `"benchmark"` (read `package.json` scripts block), `Makefile` target `perf` or `benchmark`.

Print detection summary table:

```
| Category    | Status    | Tool                |
|-------------|-----------|---------------------|
| tests       | found     | jest                |
| coverage    | found     | nyc                 |
| lint        | found     | eslint              |
| complexity  | not found | (will estimate)     |
| deps        | found     | npm audit           |
| perf        | not found | skipped             |
```

#### Phase 2: Load Previous Report

Run:
```bash
ls -t .claude/health-history/*.json 2>/dev/null | head -1
```

Cases:
- **No files / directory absent:** Set `IS_FIRST_RUN=true`, `PREV_REPORT=null`. Print: `First run — no regression comparison available.`
- **Files present, no `--since`:** Load the most recent file. Set `IS_FIRST_RUN=false`, `PREV_REPORT_PATH=<file>`.
- **`--since` set:** Find the file whose filename date is closest to (but not after) `COMPARE_DATE`. If none found, warn and fall back to most recent.

Print: `Comparing to: <report filename> (<git_short_sha from that report>)` or `First run`.

#### Phase 3: Run Checks (sequential)

For each check in order — tests, coverage, lint, complexity, deps, perf:

**Skip condition:** `TOOL_<CHECK>_AVAILABLE=false` AND the check is not `complexity` (which can estimate). OR check is excluded by `CHECKS_FILTER`. Set `RESULT_<CHECK>.status = "skipped"`, all metrics null, continue.

**Run commands (use these exact flags for JSON output):**

| Tool | Command |
|------|---------|
| `jest` | `npx jest --json --passWithNoTests 2>/dev/null` |
| `vitest` | `npx vitest run --reporter=json 2>/dev/null` |
| `pytest` | `pytest --tb=no -q 2>/dev/null` |
| `go test` | `go test ./... -v 2>/dev/null` |
| `cargo test` | `cargo test 2>/dev/null` |
| `eslint` | `npx eslint . --format json 2>/dev/null` |
| `pylint` | `pylint . --output-format=json 2>/dev/null` |
| `ruff` | `ruff check . --output-format=json 2>/dev/null` |
| `golangci-lint` | `golangci-lint run --out-format json 2>/dev/null` |
| `shellcheck` | `shellcheck **/*.sh --format=json 2>/dev/null` |
| `npm audit` | `npm audit --json 2>/dev/null` |
| `pip-audit` | `pip-audit --format json 2>/dev/null` |
| `govulncheck` | `govulncheck -json ./... 2>/dev/null` |
| `cargo audit` | `cargo audit --json 2>/dev/null` |
| `nyc` / `c8` | `npx c8 report --reporter=json 2>/dev/null` (run after tests) |
| `lizard` | `lizard . --output-file /dev/stdout --output-format json 2>/dev/null` |

**Tool failure handling:** If a run command exits non-zero, set `RESULT_<CHECK>.status = "fail"` and `RESULT_<CHECK>.error = <stderr excerpt>`. Never abort the command — continue to the next check.

**Coverage note:** Coverage tools must run after (or alongside) the test command. When both tests and coverage are available, run `npx c8 npx jest --json` (or equivalent) to get both in one pass. Store metrics separately in `RESULT_TESTS` and `RESULT_COVERAGE`.

**Complexity estimation fallback:** If `TOOL_COMPLEXITY_AVAILABLE=false` but lint ran, attempt to extract complexity signals from lint output (many linters report cyclomatic complexity violations). Set `RESULT_COMPLEXITY.metrics.complexity_source = "estimated"`. If no signals found: `complexity_source = "unavailable"`.

Print after each check: `  <check>: <STATUS> (<tool name or "skipped">)`

#### Phase 4: Compute Grade and Regressions

Using `RESULT_<CHECK>` for each check and `PREV_REPORT` (if not first run):

**Compute deltas** (only when `IS_FIRST_RUN=false`):
- `delta_pass_rate` = current `pass_rate` − previous `pass_rate`
- `delta_coverage` = current `coverage_pct` − previous `coverage_pct`
- `delta_lint_errors` = current `lint_errors` − previous `lint_errors`
- `delta_lint_score` = current `lint_score` − previous `lint_score`
- `delta_high_complexity` = current `high_complexity_functions` − previous
- `delta_vuln_critical` = current `vuln_critical` − previous
- `delta_vuln_high` = current `vuln_high` − previous
- `delta_perf_p50` = current `perf_p50_ms` − previous (if both non-null)

**Detect regressions** (only when `IS_FIRST_RUN=false`):
- `delta_pass_rate < -1.0` → regression
- `delta_coverage < -2.0` → regression
- `delta_lint_errors > 0` → regression
- `delta_lint_score < -5` → regression
- `delta_high_complexity > 0` → regression
- `delta_vuln_critical > 0` → regression
- `delta_vuln_high > 0` → regression
- `delta_perf_p50 > 0.10 * previous_p50` → regression (10% increase)

**Compute grade** (evaluate in order; first matching grade wins):

| Grade | Conditions |
|-------|-----------|
| F | `RESULT_TESTS.status == "fail"` OR `pass_rate < 50` |
| D | Multiple regressions detected OR `pass_rate < 80` OR `vuln_critical > 2` |
| C | One regression detected OR (`pass_rate >= 80` AND `vuln_critical <= 2`) |
| B | No critical regressions AND `pass_rate >= 90` AND `coverage_pct >= 70` AND `lint_errors <= 5` AND `vuln_high <= 2` |
| A | No regressions AND `pass_rate >= 95` AND `coverage_pct >= 80` AND `lint_errors == 0` AND `vuln_critical == 0` AND `vuln_high == 0` |

For first run: grade on absolute thresholds only (regressions list is empty, deltas all "N/A").

Assemble `HEALTH_REPORT` object with all fields from the JSON storage schema below.

#### Phase 5: Display and Store

**Display** the terminal report in this format:

```
## Codebase Health Report — {{PROJECT_NAME}}
Date: <ISO date> | Commit: <short SHA> | Compared to: <previous date or "first run">

Overall Grade: <letter>  (<one-line summary, e.g., "No regressions. Coverage strong.">)

### Test Suite      [PASS/FAIL/SKIPPED]
  Tests: N passed, N failed, N skipped (N total)
  Pass rate: N%  <delta>
  Duration: Xs

### Code Coverage   [PASS/FAIL/SKIPPED]
  Coverage: N%  <delta>
  Type: line/branch/statement

### Linting         [PASS/FAIL/SKIPPED]
  Score: N/100  <delta>
  Errors: N  Warnings: N

### Complexity      [MEASURED/ESTIMATED/SKIPPED]
  Avg CCN: N  Max CCN: N
  High-complexity functions: N (>10 CCN)  <delta>

### Dependencies    [PASS/FAIL/SKIPPED]
  Vulnerabilities: N critical, N high, N moderate, N low

### Performance     [PASS/FAIL/SKIPPED]
  p50: Nms  p95: Nms  p99: Nms  <delta>

---
Regressions detected: N
  - <check>: <metric> changed from X to Y
Stored: .claude/health-history/<filename>.json
```

Delta notation: positive direction on coverage/pass-rate = improvement (green); positive direction on errors/failures/vulnerabilities = regression (warning).

**Store** the report — derive filename:
```bash
DATE=$(date -u +"%Y-%m-%d")
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
# Write to: .claude/health-history/${DATE}-${SHA}.json
```

Create directory if needed: `mkdir -p .claude/health-history`

**Housekeeping check** after writing:
```bash
COUNT=$(ls .claude/health-history/*.json 2>/dev/null | wc -l | tr -d ' ')
```
If COUNT > 30, print: `Note: .claude/health-history/ has ${COUNT} reports. Consider pruning: ls -t .claude/health-history/ | tail -n +31 | xargs -I{} rm .claude/health-history/{}`

**Gitignore suggestion:**
```bash
grep -q "health-history" .gitignore 2>/dev/null \
  || echo "Tip: add .claude/health-history/ to .gitignore — health reports are local artifacts."
```

---

## JSON Storage Schema (exact)

File: `.claude/health-history/<YYYY-MM-DD>-<short-sha>.json`

```json
{
  "schema_version": "1",
  "project": "{{PROJECT_NAME}}",
  "timestamp": "<ISO 8601 UTC>",
  "git_sha": "<full SHA or unknown>",
  "git_short_sha": "<7-char SHA or unknown>",
  "git_branch": "<branch name or unknown>",
  "checks": {
    "tests": {
      "status": "pass|fail|skipped",
      "tool": "<name or null>",
      "metrics": {
        "tests_total": 0,
        "tests_passed": 0,
        "tests_failed": 0,
        "tests_skipped": 0,
        "pass_rate": 100.0,
        "duration_seconds": 0.0
      }
    },
    "coverage": {
      "status": "pass|fail|skipped",
      "tool": "<name or null>",
      "metrics": {
        "coverage_pct": 0.0,
        "coverage_type": "line"
      }
    },
    "lint": {
      "status": "pass|fail|skipped",
      "tool": "<name or null>",
      "metrics": {
        "lint_errors": 0,
        "lint_warnings": 0,
        "lint_score": 100,
        "lint_files_checked": 0
      }
    },
    "complexity": {
      "status": "measured|estimated|skipped",
      "tool": "<name or null>",
      "metrics": {
        "avg_cyclomatic_complexity": 0.0,
        "max_cyclomatic_complexity": 0,
        "high_complexity_functions": 0,
        "complexity_source": "measured|estimated|unavailable"
      }
    },
    "deps": {
      "status": "pass|fail|skipped",
      "tool": "<name or null>",
      "metrics": {
        "vuln_critical": 0,
        "vuln_high": 0,
        "vuln_moderate": 0,
        "vuln_low": 0,
        "vuln_total": 0
      }
    },
    "perf": {
      "status": "pass|fail|skipped",
      "tool": "<script path or null>",
      "metrics": {
        "perf_p50_ms": null,
        "perf_p95_ms": null,
        "perf_p99_ms": null,
        "perf_custom": {}
      }
    }
  },
  "grade": "A",
  "regressions": [],
  "comparison_report": "<previous filename or null>"
}
```

`schema_version` is `"1"` (string). Include this field in every written report to allow future format migrations.

---

## Existing Patterns to Follow

### Command frontmatter + input declaration (from `product-backlog.md`)

```markdown
---
name: "Product Backlog"
description: "..."
category: Workflow
tags: [workflow, backlog, viewer, product-driven]
---

<brief description using {{BACKLOG_PROVIDER_NAME}}>

**Input:** $ARGUMENTS (optional: ...)
```

The `---` horizontal rule between the input description block and Phase 0 is standard in this template family.

### Runtime variable naming (from `implement.md`)

Runtime variables are plain `UPPER_SNAKE_CASE` inline in prose — never `{{UPPER_SNAKE_CASE}}` for runtime values. Examples from `implement.md`: `GIT_AUTO`, `BACKLOG_WRITE`, `GH_AVAILABLE`, `DRY_RUN`, `CACHE_DIR`.

### Conditional blocks (from `implement.md`)

```markdown
**If `VARIABLE=true`:**
...instructions...

**Otherwise:**
...instructions...
```

Use `**bold**` for condition labels. Use `###` headings for named blocks within a phase (e.g., `### Flag Detection`).

### Parallel vs. sequential execution notes

When probing tools in parallel, the prose states "detect all simultaneously" or "launch in parallel". When checks must be sequential, the prose states "run sequentially in this order" and lists the order explicitly. This sets Claude's execution intent.

---

## Conventions Checklist

- [ ] File name: `health-check.md` (kebab-case)
- [ ] Frontmatter has `name`, `description`, `category`, `tags`
- [ ] Only two `{{PLACEHOLDER}}` tokens used: `{{PROJECT_NAME}}` and `{{CI_COMMANDS}}`
- [ ] Runtime variables in `UPPER_SNAKE_CASE` (no `{{...}}` wrapping)
- [ ] Tool detection runs in parallel (Phase 1)
- [ ] Checks run sequentially (Phase 3) — explicitly stated in prose
- [ ] Tool failure never aborts the command
- [ ] JSON schema has `schema_version: "1"` (string) field
- [ ] Filename convention: `<YYYY-MM-DD>-<short-sha>.json`
- [ ] Gitignore suggestion included in Phase 5
- [ ] Housekeeping notice fires at > 30 reports
- [ ] After writing the file, run: `grep -r '{{[A-Z_]*}}' templates/commands/health-check.md` and confirm only `{{PROJECT_NAME}}` and `{{CI_COMMANDS}}` appear

---

## Risks

| Risk | Mitigation |
|------|------------|
| Test runner side effects (DB seeding, port binding) | Known limitation; document in command intro. User controls when to run. |
| `{{CI_COMMANDS}}` contains multiple commands (newline-separated) | Use only as the fallback run command for tests; treat entire string as the command |
| Coverage tools require tests to have run first | Phase 3 runs tests before coverage; use combined invocation (c8 + jest) when possible |
| JSON output flag unavailable on older tool versions | Claude falls back to parsing human-readable stdout when JSON parse fails |
| `.claude/health-history/` accidentally committed | Phase 5 prints gitignore suggestion; not a blocker for the command |
| `git rev-parse` unavailable (non-git directory) | Fall back to `"unknown"` for SHA fields; filename uses date only |
