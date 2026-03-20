# Spec: Performance Regression Detector Agent

The `sr-performance-reviewer` agent detects performance regressions in code changes. It benchmarks
modified code paths before/after a change and compares metrics against configurable thresholds.
Runs as part of the CI pipeline (GitHub Actions) and as a manual pipeline phase.

---

## Requirements

### Requirement: Benchmark execution
`sr-performance-reviewer` SHALL accept a list of modified files and determine which require
performance measurement based on file type and path patterns. It SHALL execute relevant benchmarks
and collect metrics for each affected code path.

#### Scenario: Modified file triggers benchmark
- **GIVEN** a list of modified files containing `src/queue-manager.ts`
- **WHEN** `sr-performance-reviewer` runs
- **THEN** it identifies benchmarks associated with `queue-manager` and executes them

#### Scenario: Documentation-only changes skip benchmarks
- **GIVEN** a list of modified files containing only `.md` and `.txt` files
- **WHEN** `sr-performance-reviewer` runs
- **THEN** it outputs `NO_PERF_IMPACT` and exits without running benchmarks

### Requirement: Metrics collection
The agent SHALL collect three categories of metrics:

- **Execution time** (ms): wall-clock duration of benchmark scenarios
- **Memory usage** (MB): peak heap allocation during benchmark run
- **Throughput** (ops/sec): operations per second for throughput-sensitive paths

#### Scenario: Metrics are collected per benchmark
- **GIVEN** a benchmark scenario runs successfully
- **WHEN** results are collected
- **THEN** execution_time_ms, peak_memory_mb, and throughput_ops_sec are recorded for each scenario

### Requirement: Threshold configuration
The agent SHALL compare collected metrics against thresholds defined in `.specrails/perf-thresholds.yml`
(project level) or via environment variables (CI level). Missing config files SHALL use built-in
defaults.

**Default thresholds:**
| Metric | Regression threshold | Critical threshold |
|--------|---------------------|--------------------|
| Execution time | +20% | +50% |
| Memory usage | +15% | +40% |
| Throughput | -15% | -40% |

**Environment variable overrides:**
- `PERF_REGRESSION_TIME_PCT` — execution time regression percentage (default: 20)
- `PERF_REGRESSION_MEMORY_PCT` — memory regression percentage (default: 15)
- `PERF_REGRESSION_THROUGHPUT_PCT` — throughput regression percentage (default: 15)
- `PERF_CRITICAL_TIME_PCT` — critical execution time threshold (default: 50)
- `PERF_CRITICAL_MEMORY_PCT` — critical memory threshold (default: 40)
- `PERF_CRITICAL_THROUGHPUT_PCT` — critical throughput threshold (default: 40)
- `PERF_BASELINE_BRANCH` — branch to use as baseline (default: `main`)

#### Scenario: Project config overrides defaults
- **GIVEN** `.specrails/perf-thresholds.yml` sets `execution_time_regression_pct: 10`
- **WHEN** a benchmark shows a 15% slowdown
- **THEN** the result is flagged as a regression (exceeds the 10% project threshold)

#### Scenario: Environment variable overrides project config
- **GIVEN** `.specrails/perf-thresholds.yml` sets `execution_time_regression_pct: 20`
- **AND** `PERF_REGRESSION_TIME_PCT=5` is set
- **WHEN** a benchmark shows an 8% slowdown
- **THEN** the result is flagged as a regression (env var takes precedence)

#### Scenario: Missing config uses defaults
- **GIVEN** no `.specrails/perf-thresholds.yml` exists
- **AND** no environment variables are set
- **WHEN** a benchmark shows a 10% slowdown
- **THEN** no regression is flagged (within the 20% default threshold)

### Requirement: Baseline comparison
The agent SHALL compare current metrics against a baseline. The baseline is determined in priority order:

1. Metrics stored in `.specrails/perf-baseline.json` committed to the repository
2. Metrics collected by running benchmarks on `PERF_BASELINE_BRANCH` (default: `main`)
3. If neither is available, the agent outputs `NO_BASELINE` and marks the run as informational only

#### Scenario: Stored baseline is used
- **GIVEN** `.specrails/perf-baseline.json` exists with valid metrics
- **WHEN** `sr-performance-reviewer` runs
- **THEN** it compares current metrics against the stored baseline without re-running benchmarks on main

#### Scenario: Branch baseline fallback
- **GIVEN** `.specrails/perf-baseline.json` does not exist
- **WHEN** `sr-performance-reviewer` runs in CI
- **THEN** it checks out `PERF_BASELINE_BRANCH`, runs benchmarks, stores results, then runs on the feature branch

### Requirement: Historical performance tracking
The agent SHALL append benchmark results to `.specrails/perf-history.jsonl` (newline-delimited JSON).
Each record SHALL include: timestamp (ISO 8601), branch name, commit SHA, scenario name, and all metrics.
The file SHALL be committed to the repository to track trends over time.

#### Scenario: Results are appended to history
- **GIVEN** a successful benchmark run on branch `feat/queue-refactor`
- **WHEN** the run completes
- **THEN** a new JSON record is appended to `.specrails/perf-history.jsonl`

#### Scenario: History record schema
Each record in `.specrails/perf-history.jsonl` SHALL contain:
```json
{
  "timestamp": "2026-03-20T14:00:00.000Z",
  "branch": "feat/queue-refactor",
  "commit": "abc1234",
  "scenario": "queue-manager/enqueue-throughput",
  "execution_time_ms": 142,
  "peak_memory_mb": 48.2,
  "throughput_ops_sec": 7042
}
```

### Requirement: Regression reporting
The agent SHALL output a structured report with:
- Summary line: `PERF_STATUS: PASS | REGRESSION | CRITICAL`
- Per-scenario table with delta percentages and status icons
- Actionable recommendations for critical regressions

The final line of output MUST be exactly one of:
- `PERF_STATUS: PASS` — no regressions detected
- `PERF_STATUS: REGRESSION` — regressions detected within critical bounds (warning)
- `PERF_STATUS: CRITICAL` — one or more metrics exceed critical thresholds (blocks CI)
- `PERF_STATUS: NO_BASELINE` — no baseline available, informational run only
- `PERF_STATUS: NO_PERF_IMPACT` — no performance-sensitive files modified

#### Scenario: Clean run outputs PASS
- **GIVEN** all metrics are within threshold
- **WHEN** the report is generated
- **THEN** the final output line is `PERF_STATUS: PASS`

#### Scenario: Regression outputs REGRESSION
- **GIVEN** execution time increased by 25% (above 20% threshold, below 50% critical)
- **WHEN** the report is generated
- **THEN** the final output line is `PERF_STATUS: REGRESSION`

#### Scenario: Critical regression blocks CI
- **GIVEN** execution time increased by 60% (above 50% critical threshold)
- **WHEN** the CI job reads the status
- **THEN** `PERF_STATUS: CRITICAL` causes the CI step to exit with code 1

### Requirement: CI integration
A GitHub Actions workflow SHALL run `sr-performance-reviewer` on every pull request targeting `main`.
The workflow SHALL:
- Run on `pull_request` events targeting `main`
- Collect the list of changed files from the PR diff
- Pass changed files and environment to the agent
- Cache `.specrails/perf-history.jsonl` between runs
- Fail the check if `PERF_STATUS: CRITICAL` is detected
- Post a summary comment on the PR with the performance report

#### Scenario: PR triggers performance check
- **GIVEN** a PR is opened targeting `main`
- **WHEN** the `performance-regression` workflow runs
- **THEN** the agent runs and a PR comment is posted with the report

#### Scenario: CRITICAL blocks merge
- **GIVEN** the agent outputs `PERF_STATUS: CRITICAL`
- **WHEN** the CI workflow reads the output
- **THEN** the step exits with code 1 and the required check fails, blocking the merge

---

## Output reference

### Status codes
| Status | Meaning | CI behavior |
|--------|---------|-------------|
| `PASS` | All metrics within thresholds | Check passes |
| `REGRESSION` | Some metrics exceed warning thresholds | Check passes with warning annotation |
| `CRITICAL` | One or more metrics exceed critical thresholds | Check fails, blocks merge |
| `NO_BASELINE` | No baseline available | Check passes (informational) |
| `NO_PERF_IMPACT` | No performance-sensitive files changed | Check passes (skipped) |

### Files written
| File | Purpose |
|------|---------|
| `.specrails/perf-baseline.json` | Committed baseline metrics |
| `.specrails/perf-history.jsonl` | Append-only performance history |
| `.specrails/perf-thresholds.yml` | Project-level threshold config (optional) |
