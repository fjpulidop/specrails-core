---
change: health-check-dashboard
type: design
---

# Technical Design: Codebase Health Check Dashboard

## Overview

The `/health-check` command is a single Markdown slash command that uses Claude's built-in tool-calling to run quality checks, aggregate results, compare against historical reports, and store a new snapshot. No agent spawning is required — this is a single-turn orchestration command.

The design principle is **graceful degradation with dynamic discovery**: the command never assumes a specific toolchain. It probes for tools, runs what is available, and produces a consistent report schema regardless of which checks fired.

---

## Architecture

```
/health-check
     |
     v
Phase 0: Parse arguments
  - Optional: --since <date> (compare against report from that date, not latest)
  - Optional: --only <checks> (comma-separated: tests,coverage,lint,complexity,deps,perf)
     |
     v
Phase 1: Detect toolchain (parallel probes)
  - Test runner: jest / pytest / go test / cargo test / mocha / rspec / ...
  - Coverage tool: nyc/c8 / coverage.py / go cover / llvm-cov / ...
  - Linter: eslint / pylint / golangci-lint / rubocop / ...
  - Dependency auditor: npm audit / pip-audit / govulncheck / cargo audit / ...
  - Complexity: lizard / radon / gocyclo / (estimated from linter output)
  - Performance: project-defined baseline script (detected by convention)
     |
     v
Phase 2: Load previous report (if any)
  - Read .claude/health-history/ directory listing
  - Load the most recent JSON (or the --since target)
  - If no history: first-run mode (no regression comparison possible)
     |
     v
Phase 3: Run checks (sequential — avoids resource contention)
  For each check in [tests, coverage, lint, complexity, deps, perf]:
    - If tool detected: run check, parse output, extract metric
    - If tool absent: mark check as SKIPPED
     |
     v
Phase 4: Build health report
  - Compute pass/fail/regression for each metric
  - Compare against previous report values
  - Assign an overall health grade (A/B/C/D/F)
     |
     v
Phase 5: Display report + store snapshot
  - Print formatted report to terminal
  - Write JSON snapshot to .claude/health-history/<ISO-date>-<short-sha>.json
```

---

## Command Template Structure

The template file is `templates/commands/health-check.md`. It uses the same `{{PLACEHOLDER}}` substitution pattern as other command templates. Two placeholders are needed:

| Placeholder | Resolved by /setup to |
|---|---|
| `{{PROJECT_NAME}}` | The target project's name (already resolved in other commands) |
| `{{CI_COMMANDS}}` | Project-specific CI/lint/test commands (already resolved in implement.md) |

Because both of these placeholders are already present in other command templates, `/setup` will resolve them automatically. No new placeholder resolution logic is needed in `install.sh`.

The `{{CI_COMMANDS}}` placeholder provides a fallback for projects that have a top-level CI command (e.g., `npm test`, `make test`). When present, the command can use it as a high-confidence test runner. Dynamic detection still runs first — `{{CI_COMMANDS}}` is the fallback, not the primary.

---

## Health Check Definitions

### Check 1: Test Suite

**Tool detection order:** `jest`, `vitest`, `mocha`, `pytest`, `go test`, `cargo test`, `rspec`, `dotnet test`, then `{{CI_COMMANDS}}` as fallback.

**Run:** Execute with JSON/verbose output mode where supported.

**Metrics extracted:**
- `tests_total` — total test count
- `tests_passed` — passed count
- `tests_failed` — failed count
- `tests_skipped` — skipped count
- `pass_rate` — percentage (0.0–100.0)
- `duration_seconds` — total run time

**Regression threshold:** pass_rate drops by more than 1% vs. previous.

---

### Check 2: Code Coverage

**Tool detection order:** `nyc`/`c8` (JS), `coverage.py`/`pytest-cov` (Python), `go test -cover` (Go), `cargo tarpaulin` (Rust), `lcov` (C/C++).

**Metrics extracted:**
- `coverage_pct` — line/statement coverage percentage
- `coverage_type` — "line" | "branch" | "statement"
- `coverage_delta` — vs. previous report (computed, not from tool)

**Regression threshold:** coverage drops by more than 2 percentage points vs. previous.

---

### Check 3: Linting

**Tool detection order:** `eslint`, `pylint`, `flake8`, `ruff`, `golangci-lint`, `rubocop`, `cargo clippy`.

**Metrics extracted:**
- `lint_errors` — error-severity issue count
- `lint_warnings` — warning-severity issue count
- `lint_score` — computed as `max(0, 100 - errors*5 - warnings*1)` (normalized 0–100)
- `lint_files_checked` — number of files analyzed

**Regression threshold:** lint_errors increases vs. previous, OR lint_score drops more than 5 points.

---

### Check 4: Code Complexity

**Tool detection order:** `lizard` (language-agnostic), `radon` (Python), `gocyclo` (Go), `plato` (JS legacy).

If no dedicated complexity tool is detected: Claude estimates complexity signals from linter output (many linters report complexity rules) and reports as ESTIMATED rather than MEASURED.

**Metrics extracted:**
- `avg_cyclomatic_complexity` — mean across functions
- `max_cyclomatic_complexity` — highest single function
- `high_complexity_functions` — count of functions above threshold (>10 CCN)
- `complexity_source` — "measured" | "estimated" | "unavailable"

**Regression threshold:** `high_complexity_functions` increases vs. previous.

---

### Check 5: Dependency Vulnerabilities

**Tool detection order:** `npm audit` (Node.js), `pip-audit` (Python), `govulncheck` (Go), `cargo audit` (Rust), `bundle audit` (Ruby).

**Metrics extracted:**
- `vuln_critical` — critical severity count
- `vuln_high` — high severity count
- `vuln_moderate` — moderate severity count
- `vuln_low` — low severity count
- `vuln_total` — total count

**Regression threshold:** any increase in `vuln_critical` or `vuln_high` vs. previous.

---

### Check 6: Performance Baseline

**Detection:** Look for a performance script at these conventional paths (in order):
1. `scripts/perf.sh`
2. `scripts/benchmark.sh`
3. `package.json` script named `"perf"` or `"benchmark"`
4. `Makefile` target `perf` or `benchmark`

If none found: check is SKIPPED. Performance is intentionally not probed blindly — running arbitrary benchmarks without a known entry point is unsafe.

**Metrics extracted (if detected):**
- `perf_p50_ms` — median latency (if script outputs standard format)
- `perf_p95_ms` — 95th percentile
- `perf_p99_ms` — 99th percentile
- `perf_custom` — raw key-value map from script stdout (best-effort parse)

**Regression threshold:** p50 increases by more than 10% vs. previous.

---

## Health Grade

After all checks run, compute an overall health grade:

| Grade | Criteria |
|-------|----------|
| A | No regressions. pass_rate >= 95%. coverage_pct >= 80%. lint_errors == 0. vuln_critical == 0 && vuln_high == 0. |
| B | No critical regressions. One of: pass_rate 90–94%, OR coverage_pct 70–79%, OR lint_errors 1–5, OR vuln_high <= 2. |
| C | One regression detected. OR pass_rate 80–89%. OR vuln_critical > 0. |
| D | Multiple regressions detected. OR pass_rate < 80%. OR vuln_critical > 2. |
| F | Test suite fails to run. OR pass_rate < 50%. |

When no previous report exists (first run), regressions cannot be detected — the grade is based only on current metric thresholds.

---

## Report Format

The terminal output follows this structure:

```
## Codebase Health Report — <project-name>
Date: <ISO date> | Commit: <short SHA> | Compared to: <previous report date or "first run">

Overall Grade: A/B/C/D/F  (<one-line summary>)

### Test Suite      [PASS/FAIL/SKIPPED]
  Tests: N passed, N failed, N skipped (N total)
  Pass rate: N% <delta vs previous>
  Duration: Xs

### Code Coverage   [PASS/FAIL/SKIPPED/ESTIMATED]
  Coverage: N% <delta vs previous>
  Type: line/branch/statement

### Linting         [PASS/FAIL/SKIPPED]
  Score: N/100 <delta vs previous>
  Errors: N  Warnings: N

### Complexity      [MEASURED/ESTIMATED/SKIPPED]
  Avg CCN: N  Max CCN: N
  High-complexity functions: N (>10 CCN) <delta vs previous>

### Dependencies    [PASS/FAIL/SKIPPED]
  Vulnerabilities: N critical, N high, N moderate, N low

### Performance     [PASS/FAIL/SKIPPED]
  p50: Nms  p95: Nms  p99: Nms <delta vs previous>

---
Regressions detected: N
  - <check>: <metric> changed from X to Y
Stored: .claude/health-history/<filename>.json
```

Delta notation: `(+N%)` shown in red/warning, `(-N%)` shown in green for coverage/pass-rate, reversed for errors/failures.

---

## Storage Schema

File path: `.claude/health-history/<YYYY-MM-DD>-<short-sha>.json`

```json
{
  "schema_version": "1",
  "project": "<project-name>",
  "timestamp": "<ISO 8601>",
  "git_sha": "<full SHA>",
  "git_short_sha": "<7-char SHA>",
  "git_branch": "<branch name>",
  "checks": {
    "tests": {
      "status": "pass|fail|skipped",
      "tool": "<detected tool name>",
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
      "tool": "<detected tool name>",
      "metrics": {
        "coverage_pct": 0.0,
        "coverage_type": "line"
      }
    },
    "lint": {
      "status": "pass|fail|skipped",
      "tool": "<detected tool name>",
      "metrics": {
        "lint_errors": 0,
        "lint_warnings": 0,
        "lint_score": 100,
        "lint_files_checked": 0
      }
    },
    "complexity": {
      "status": "measured|estimated|skipped",
      "tool": "<detected tool name or null>",
      "metrics": {
        "avg_cyclomatic_complexity": 0.0,
        "max_cyclomatic_complexity": 0,
        "high_complexity_functions": 0,
        "complexity_source": "measured"
      }
    },
    "deps": {
      "status": "pass|fail|skipped",
      "tool": "<detected tool name>",
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
  "comparison_report": "<previous report filename or null>"
}
```

`schema_version` is included at v1 to allow future format evolution without breaking comparison logic.

---

## File Impact

| File | Change type | Notes |
|------|-------------|-------|
| `templates/commands/health-check.md` | Create | New command template — source of truth |
| `install.sh` | No change | Templates copied automatically via `cp -r templates/*` |

The `.claude/health-history/` directory is a runtime-created convention in target repos. It is created by the command on first run. It should be added to `.gitignore` by the command (or by a note in the report) since health reports are local artifacts, not source-controlled.

---

## Key Design Decisions

**Why a single command rather than a new agent?**
Health checks are a pure orchestration concern: probe tools, run commands, aggregate output, compare JSON. No specialized persona is needed. A Claude Code slash command with direct tool-calling is the simplest form that fully solves the problem. Adding an agent would add invocation overhead and an unnecessary file.

**Why dynamic tool detection rather than configuration?**
The command must work in any codebase immediately after installation. Requiring a config file would add a setup step and reduce adoption. Dynamic detection means zero-configuration. The cost is slightly more probing logic in the command prose, which is acceptable.

**Why JSON for storage rather than Markdown?**
Trend comparison requires machine-readable structured data. Markdown reports are human-friendly output but not suitable for extracting metrics across multiple historical runs. JSON is the right format for the store. The human-readable report is always rendered fresh from the JSON.

**Why sequential checks rather than parallel?**
Test runners, coverage tools, and performance benchmarks can be resource-intensive. Running them in parallel risks CPU/memory contention that skews results — especially performance metrics. Sequential execution produces more reliable measurements at the cost of slightly longer runtime. A full health check is expected to take 1–10 minutes; this is acceptable for a weekly ritual.

**Why `--only` flag for partial runs?**
Lead developers will sometimes want to spot-check a single dimension (e.g., just dependency vulnerabilities on a Friday) without running the full suite. The `--only` flag enables this without creating separate commands.

**Why grade F when the test suite fails to run?**
An unrunnable test suite is the most severe signal — it means the CI gate is broken. Grading it as F ensures this is never masked by good scores in other dimensions.

---

## Edge Cases and Risks

| Risk | Mitigation |
|------|------------|
| Tool outputs vary between versions | Claude reasons about output rather than applying regex; it tolerates format variation |
| Performance benchmarks have side effects | Only run perf if a conventional entry point is explicitly found; never probe blindly |
| `.claude/health-history/` grows unbounded | Command notes after 30 entries that old reports can be pruned; future pagination feature |
| First run has no baseline | Detected cleanly; report marks all deltas as "N/A (first run)" and grades on absolute thresholds only |
| Test run modifies state (seeded DBs, etc.) | Out of scope; this is the same risk that exists in any CI run. Document as a known limitation. |
| `git rev-parse` unavailable | Fall back to timestamp-only filename; short-sha field set to "unknown" |
