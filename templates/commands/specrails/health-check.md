---
name: "Health Check Dashboard"
description: "Run a comprehensive codebase health check — tests, linting, coverage, complexity, and dependency audit. Compare with previous runs to detect regressions."
category: Workflow
tags: [workflow, health, quality, dashboard]
---

Run a full health check for **{{PROJECT_NAME}}**: detect available tools, execute each quality check, compare results against the previous run, detect regressions, compute a health grade, and store a snapshot for future comparison.

**Input:** $ARGUMENTS — optional flags:
- `--since <date>` — use the report from this date (ISO format: YYYY-MM-DD) as the comparison baseline instead of the most recent
- `--only <checks>` — comma-separated subset to run. Valid values: `tests`, `coverage`, `lint`, `complexity`, `deps`, `perf`, `static`
- `--save` — always save the snapshot even when `--only` is used (default: skip save for partial runs)

---

## Phase 0: Argument Parsing

Parse `$ARGUMENTS` to set runtime variables.

**Variables to set:**

- `COMPARE_DATE` — string (ISO date) or empty string. Default: `""` (use most recent report).
- `CHECKS_FILTER` — array of check names or the string `"all"`. Default: `"all"`.
- `SAVE_SNAPSHOT` — boolean. Default: `true` when `CHECKS_FILTER="all"`, `false` for partial runs unless `--save` is present.

**Parsing rules:**

1. Scan `$ARGUMENTS` for `--since <date>`. If found, set `COMPARE_DATE=<date>`. Strip from arguments.
2. Scan for `--only <checks>`. If found:
   - Split `<checks>` on commas to produce an array.
   - Validate each entry against the allowed set: `tests`, `coverage`, `lint`, `complexity`, `deps`, `perf`, `static`.
   - If any unknown value is found: print `Error: unknown check "<value>". Valid checks: tests, coverage, lint, complexity, deps, perf, static` and stop.
   - Set `CHECKS_FILTER=<validated-array>`.
   - Set `SAVE_SNAPSHOT=false` (partial run — snapshot may be incomplete).
3. Scan for `--save`. If found, set `SAVE_SNAPSHOT=true` regardless of `CHECKS_FILTER`.

**Print active configuration:**

```
Running checks: <all | comma-separated list> | Static analysis: <enabled|disabled> | Comparing to: <COMPARE_DATE or "latest">
```

---

## Phase 1: Toolchain Detection

Detect available tools for each check category. Run all detections simultaneously (in parallel). For each category, try tools in the order listed — use the first one found.

If `CHECKS_FILTER` is not `"all"`, skip detection for categories not in the filter.

For each category, set two variables:
- `TOOL_<CHECK>` — the tool name or command string (e.g., `"jest"`, `"eslint"`)
- `TOOL_<CHECK>_AVAILABLE` — boolean (`true` / `false`)

**Detection sequences:**

- **tests:** Try in order: `jest`, `vitest`, `mocha`, `pytest`, `go test`, `cargo test`, `rspec`, `dotnet test`. If none found, check whether `{{CI_COMMANDS}}` provides a test command — use it as fallback and set `TOOL_TESTS="ci-commands"`.
- **coverage:** Try in order: `nyc`, `c8`, `pytest-cov`, `coverage` (Python), `go test -cover`, `cargo tarpaulin`, `lcov`.
- **lint:** Try in order: `eslint`, `pylint`, `flake8`, `ruff`, `golangci-lint`, `rubocop`, `cargo clippy`.
- **complexity:** Try in order: `lizard`, `radon`, `gocyclo`, `plato`. If none found, set `TOOL_COMPLEXITY_AVAILABLE=false` — complexity will be estimated from linter output if lint ran.
- **deps:** Try in order: `npm audit`, `pip-audit`, `govulncheck`, `cargo audit`, `bundle audit`.
- **perf:** Look for a performance entry point at these paths in order:
  1. `scripts/perf.sh`
  2. `scripts/benchmark.sh`
  3. A `"perf"` or `"benchmark"` script key in `package.json`
  4. A `perf` or `benchmark` target in `Makefile`

  If found, set `TOOL_PERF=<path-or-command>` and `TOOL_PERF_AVAILABLE=true`. Otherwise set `TOOL_PERF_AVAILABLE=false`.

**Detection summary table** (print after all probes complete):

```
| Category   | Available | Tool              |
|------------|-----------|-------------------|
| tests      | yes/no    | <tool or N/A>     |
| coverage   | yes/no    | <tool or N/A>     |
| lint       | yes/no    | <tool or N/A>     |
| complexity | yes/no    | <tool or N/A>     |
| deps       | yes/no    | <tool or N/A>     |
| perf       | yes/no    | <tool or N/A>     |
| static     | yes       | ai-analysis       |
```

The `static` check is always available (AI-assisted analysis requires no external tools).

---

## Phase 2: Load Previous Report

Read `{{SPECRAILS_DIR}}/health-history/` to find the comparison baseline.

**Variables to set:**
- `PREV_REPORT_PATH` — absolute file path or `null`
- `IS_FIRST_RUN` — boolean
- `PREV_REPORT` — parsed JSON object or `null`

**Logic:**

1. Check whether `{{SPECRAILS_DIR}}/health-history/` exists and contains `.json` files.
   - If directory is absent or empty: set `IS_FIRST_RUN=true`, `PREV_REPORT_PATH=null`, `PREV_REPORT=null`. Print: `First run — no previous report found. Regression comparison is not available.` Proceed.

2. If reports exist and `COMPARE_DATE` is empty: select the most recently modified `.json` file.

3. If `COMPARE_DATE` is set: find the report whose filename date component is closest to `COMPARE_DATE` (without exceeding it). If no report matches within 7 days, print: `Warning: no report found near <COMPARE_DATE>. Falling back to most recent.` Then use the most recent.

4. Set `IS_FIRST_RUN=false`, `PREV_REPORT_PATH=<path>`, load file content into `PREV_REPORT`.

5. Print one line:

   - First run: `Baseline: first run (no comparison)`
   - Report found: `Comparing to: <YYYY-MM-DD> (<short-sha from filename>)`

---

## Phase 3: Run Checks

Run checks **sequentially** in this order: `tests`, `coverage`, `lint`, `complexity`, `deps`, `perf`. Sequential execution avoids resource contention that would skew timing and coverage metrics.

For each check, follow this pattern:

**Skip condition:** If `TOOL_<CHECK>_AVAILABLE=false` OR check is excluded by `CHECKS_FILTER`:
- Set `RESULT_<CHECK> = { status: "skipped", tool: null, metrics: null }`
- Print `<check>: SKIPPED`
- Continue to next check.

**Run:** Execute the tool with the command shown below. If the tool exits non-zero: set `status: "fail"`, capture the error message, record whatever partial metrics are available, and continue — do NOT abort the command.

**Store:** Set `RESULT_<CHECK>` to a structured object with `status`, `tool`, and `metrics` fields.

---

### Check: tests

Run command (first tool that matches):

- `jest`: `jest --json 2>/dev/null` — parse JSON stdout for `numPassedTests`, `numFailedTests`, `numPendingTests`, `testResults[].duration`
- `vitest`: `vitest run --reporter=json 2>/dev/null` — parse JSON for equivalent fields
- `mocha`: `mocha --reporter json 2>/dev/null` — parse `stats` object
- `pytest`: `pytest --tb=no -q 2>&1` — extract pass/fail/skip counts from summary line
- `go test`: `go test ./... -v 2>&1` — count `--- PASS`, `--- FAIL`, `--- SKIP` lines
- `cargo test`: `cargo test 2>&1` — parse `test result:` summary line
- `rspec`: `rspec --format json 2>/dev/null` — parse JSON
- `dotnet test`: `dotnet test --logger "console;verbosity=normal" 2>&1` — extract summary
- `ci-commands` fallback: run `{{CI_COMMANDS}}` and extract pass/fail counts from output using best-effort parsing

**Metrics to extract:** `tests_total`, `tests_passed`, `tests_failed`, `tests_skipped`, `pass_rate` (0.0–100.0), `duration_seconds`.

Set `RESULT_TESTS`.

---

### Check: coverage

Run command:

- `nyc` / `c8`: `nyc report --reporter=text-summary 2>/dev/null` or `c8 report --reporter=text-summary 2>/dev/null` — parse "Statements" or "Lines" coverage percentage
- `pytest-cov`: re-run as `pytest --cov --cov-report=term-missing -q 2>&1` or read `.coverage` via `coverage report 2>/dev/null`
- `coverage` (Python): `coverage report 2>/dev/null` — extract `TOTAL` line percentage
- `go test -cover`: `go test -cover ./... 2>&1` — extract `coverage: N.N%` from each package, compute mean
- `cargo tarpaulin`: `cargo tarpaulin --out Stdout 2>/dev/null` — extract coverage percentage
- `lcov`: `lcov --summary coverage.info 2>/dev/null` — extract lines-found/lines-hit

**Metrics to extract:** `coverage_pct` (float), `coverage_type` (`"line"` / `"branch"` / `"statement"`).

Set `RESULT_COVERAGE`.

---

### Check: lint

Run command:

- `eslint`: `eslint . --format json 2>/dev/null` — count `severity: 2` (errors) and `severity: 1` (warnings) across all results; count files analyzed
- `pylint`: `pylint --output-format json <src-dir-or-.> 2>/dev/null` — count messages by type (`error`, `warning`)
- `flake8`: `flake8 --format default . 2>&1` — count lines with `E` prefix (errors) vs `W` prefix (warnings)
- `ruff`: `ruff check --output-format json . 2>/dev/null` — parse JSON array, count by severity
- `golangci-lint`: `golangci-lint run --out-format json 2>/dev/null` — count issues by severity
- `rubocop`: `rubocop --format json 2>/dev/null` — parse offenses by severity
- `cargo clippy`: `cargo clippy --message-format json 2>/dev/null` — count `"level":"error"` and `"level":"warning"` messages

**Metrics to extract:** `lint_errors`, `lint_warnings`, `lint_files_checked`. Compute `lint_score = max(0, 100 - lint_errors * 5 - lint_warnings * 1)`.

Set `RESULT_LINT`.

---

### Check: complexity

If `TOOL_COMPLEXITY_AVAILABLE=false`:
- If `RESULT_LINT` is available (lint ran and has output): set `complexity_source: "estimated"` — use Claude's reasoning to estimate complexity signals from lint output (e.g., complexity-related lint rules fired). Set numeric metrics to `null`.
- Otherwise: set `complexity_source: "unavailable"`, all metrics `null`, `status: "skipped"`.

Run command (if tool available):

- `lizard`: `lizard . --csv 2>/dev/null` — parse CSV, compute average CCN, max CCN, count functions with CCN > 10
- `radon`: `radon cc . -a -j 2>/dev/null` — parse JSON, use `average_complexity` field; count items with complexity > 10
- `gocyclo`: `gocyclo -over 10 . 2>/dev/null` and `gocyclo -avg . 2>/dev/null` — extract average and functions exceeding threshold
- `plato`: `plato -r -d /tmp/plato-report . 2>/dev/null && cat /tmp/plato-report/report.json` — extract `summary.average.maintainability`

**Metrics to extract:** `avg_cyclomatic_complexity` (float), `max_cyclomatic_complexity` (int), `high_complexity_functions` (int, count with CCN > 10), `complexity_source` (`"measured"` / `"estimated"` / `"unavailable"`).

Set `RESULT_COMPLEXITY`. Status is `"measured"` when a tool ran, `"estimated"` when inferred, `"skipped"` when neither is possible.

---

### Check: deps

Run command:

- `npm audit`: `npm audit --json 2>/dev/null` — parse `vulnerabilities` object; count by `severity` field
- `pip-audit`: `pip-audit --format json 2>/dev/null` — parse JSON array; count by `fix_versions` presence and severity
- `govulncheck`: `govulncheck ./... 2>&1` — extract vulnerability counts from summary; if no JSON flag, use Claude's reasoning on text output
- `cargo audit`: `cargo audit --json 2>/dev/null` — parse `vulnerabilities.list`, count by `advisory.severity`
- `bundle audit`: `bundle audit check 2>&1` — parse output for `Insecure Source` and `Unpatched versions`; classify by severity from advisory text

**Metrics to extract:** `vuln_critical`, `vuln_high`, `vuln_moderate`, `vuln_low`, `vuln_total`.

Set `RESULT_DEPS`.

---

### Check: perf

If `TOOL_PERF_AVAILABLE=false`: set `RESULT_PERF = { status: "skipped", tool: null, metrics: null }`, print `perf: SKIPPED`, continue.

Run the detected entry point. After it completes, attempt to parse its stdout for these standard keys:
- `p50`, `p50_ms`, `median_ms` → `perf_p50_ms`
- `p95`, `p95_ms` → `perf_p95_ms`
- `p99`, `p99_ms` → `perf_p99_ms`
- Any remaining numeric key-value pairs → `perf_custom`

If the script output does not contain recognizable keys, set all latency fields to `null` and store the raw output in `perf_custom.raw`.

**Metrics to extract:** `perf_p50_ms`, `perf_p95_ms`, `perf_p99_ms`, `perf_custom`.

Set `RESULT_PERF`.

---

**Phase 3 summary** (print after all checks):

```
tests: <PASS|FAIL|SKIPPED> (<tool>)
coverage: <PASS|FAIL|SKIPPED> (<tool>)
lint: <PASS|FAIL|SKIPPED> (<tool>)
complexity: <MEASURED|ESTIMATED|SKIPPED> (<tool>)
deps: <PASS|FAIL|SKIPPED> (<tool>)
perf: <PASS|FAIL|SKIPPED> (<tool>)
```

---

## Phase 3.5: Static Code Analysis

Perform static code inspection to detect issues that tools cannot surface: missing documentation, broken imports, and unused exports. These checks are language-aware and use AI-assisted code reading rather than external tooling.

Always exclude the following directories from analysis:
- `node_modules/`, `.git/`, `dist/`, `build/`, `vendor/`, `{{SPECRAILS_DIR}}/`, `coverage/`

For each finding, record a structured object:
```
{ severity: "critical"|"warning"|"info", check: string, file: string, line: number, description: string, action: string }
```

Set `STATIC_FINDINGS = []` before starting. Append each finding to this list.

---

### Check: documentation

Scan public-facing code units (exported functions, classes, interfaces, modules) for missing documentation comments.

**Language-specific rules:**

- **TypeScript/JavaScript**: Identify functions/classes with `export` keyword. Check whether a JSDoc block (`/** ... */`) appears immediately above the declaration. Missing JSDoc on exported symbols = finding.
- **Python**: Identify top-level functions, classes, and methods. Check for a docstring (a string literal as the first statement in the body). Missing docstring on public (non-underscore-prefixed) symbols = finding.
- **Ruby**: Identify public methods and classes. Check for a YARD/RDoc comment (`# @param`, `##`, or any comment block) immediately above the definition. Missing comment on public methods in lib/ = finding.
- **Go**: Identify exported types and functions (capitalized names). Check for a doc comment (line starting with `// <ExportedName>`) immediately above. Missing comment on exported symbols = finding.

**Severity assignment:**
- `critical`: Main entry points (e.g., `index.ts`, `main.go`, `app.rb`) with no module-level documentation
- `warning`: Exported/public function or class with no documentation
- `info`: Non-exported function over 20 lines with no documentation

Scan all source files matching the detected language(s). Skip test files (`*.test.*`, `*.spec.*`, `_test.go`, `spec/**`).

Append each finding to `STATIC_FINDINGS`.

---

### Check: broken_imports

Detect import/require statements that reference non-existent paths. Focus on local relative imports (skip `node_modules`, stdlib, installed packages — these are validated by the runtime).

**Language-specific rules:**

- **TypeScript/JavaScript**: Scan all `import ... from '...'` and `require('...')` statements. For each import path starting with `.` or `/`:
  1. Resolve the path relative to the source file.
  2. Check whether the resolved file exists (try: exact path, `.ts`, `.tsx`, `.js`, `.jsx`, `/index.ts`, `/index.js`).
  3. If no match found: add a `critical` finding.
- **Python**: Scan all `from . import`, `from .. import`, and `import X` with relative markers. Resolve relative paths from the package root. If the resolved module file does not exist: add a `critical` finding.
- **Ruby**: Scan `require_relative '...'` statements. Resolve paths from the source file's directory (try `.rb` extension if missing). If the resolved path does not exist: add a `critical` finding.
- **Go**: Skip — Go's compiler validates imports; broken imports would fail the build.

**Severity:** Always `critical` — a broken import is a runtime error.

Append each finding to `STATIC_FINDINGS`.

---

### Check: unused_exports

Detect exported symbols that are never imported anywhere else in the codebase. Limit to the project source — do not flag exports intended as a library's public API (i.e., symbols re-exported from a barrel file like `index.ts`).

**Language-specific rules:**

- **TypeScript/JavaScript**:
  1. Build a list of all exported symbols: scan `export const`, `export function`, `export class`, `export type`, `export interface`, `export default` across all non-test `.ts`/`.tsx`/`.js` files.
  2. For each exported symbol, search the rest of the codebase for imports of that symbol by name. Exclude the barrel/index file itself.
  3. If no import found anywhere: add a finding with severity `warning` (may be an intentional API export) unless the file is not `index.ts` and not under `src/` root — in that case severity is `info`.
- **Python**:
  1. Scan for symbols listed in `__all__` or public top-level definitions (non-underscore).
  2. Search for usages across the codebase. If the symbol appears only in its definition file: add a `info` finding.
- **Ruby**:
  1. Scan for public constants, classes, and modules defined in `lib/`. Search for `require` or direct references elsewhere. If a class/module in `lib/` is never referenced outside its own file: add a `warning` finding.

**Severity:** `warning` for clearly unexported contexts; `info` when the symbol could be part of a public API.

Append each finding to `STATIC_FINDINGS`.

---

### Phase 3.5 summary

After all three static checks complete, print:

```
documentation: <N findings> (<N critical, N warning, N info>)
broken_imports: <N findings> (<N critical>)
unused_exports: <N findings> (<N warning, N info>)
Static findings total: <N>
```

---

## Phase 4: Build Health Report

Using all `RESULT_<CHECK>` values and `PREV_REPORT` (if `IS_FIRST_RUN=false`), compute the final health report object.

### Step 1: Compute per-metric deltas

For each numeric metric, compute `delta = current_value - prev_value`. If `IS_FIRST_RUN=true`, set all deltas to `"N/A (first run)"`.

Delta notation convention:
- For metrics where higher is better (pass_rate, coverage_pct, lint_score): positive delta = improvement, negative delta = regression.
- For metrics where lower is better (lint_errors, vuln_*, high_complexity_functions): positive delta = regression, negative delta = improvement.

### Step 2: Detect regressions

A regression is triggered when any of the following thresholds is crossed vs. the previous report:

| Check | Threshold |
|-------|-----------|
| tests | `pass_rate` drops by more than 1% |
| coverage | `coverage_pct` drops by more than 2 percentage points |
| lint | `lint_errors` increases vs. previous |
| lint | `lint_score` drops by more than 5 points |
| complexity | `high_complexity_functions` increases vs. previous |
| deps | `vuln_critical` increases vs. previous |
| deps | `vuln_high` increases vs. previous |
| perf | `perf_p50_ms` increases by more than 10% vs. previous |

If `IS_FIRST_RUN=true`: set `REGRESSIONS=[]` (no regression detection possible on first run).

Build `REGRESSIONS` as a list of objects: `{ check, metric, previous, current, delta }`.

### Step 3: Assign health grade

Evaluate criteria in order from F to A; assign the first grade whose criteria are met:

| Grade | Criteria |
|-------|----------|
| F | Test suite fails to run (RESULT_TESTS.status = "fail") OR pass_rate < 50% |
| D | Multiple regressions detected (len(REGRESSIONS) >= 2) OR pass_rate < 80% OR vuln_critical > 2 |
| C | One regression detected OR pass_rate 80–89% OR vuln_critical > 0 |
| B | No critical regressions. Any one of: pass_rate 90–94%, OR coverage_pct 70–79%, OR lint_errors 1–5, OR vuln_high <= 2 |
| A | No regressions. pass_rate >= 95%. coverage_pct >= 80% (if measured). lint_errors == 0 (if measured). vuln_critical == 0 AND vuln_high == 0 (if measured). |

When `IS_FIRST_RUN=true`, regressions cannot be detected — base the grade on absolute metric thresholds only (no regression criteria apply).

When a check is SKIPPED, omit its metric from grade criteria (do not penalize for unavailable tools).

### Step 4: Assemble HEALTH_REPORT

Build `HEALTH_REPORT` as a structured object matching the JSON storage schema exactly:

```
HEALTH_REPORT = {
  schema_version: "1",
  project: "{{PROJECT_NAME}}",
  timestamp: <ISO 8601 current datetime>,
  git_sha: <full SHA from `git rev-parse HEAD` or "unknown">,
  git_short_sha: <7-char SHA from `git rev-parse --short HEAD` or "unknown">,
  git_branch: <branch from `git rev-parse --abbrev-ref HEAD` or "unknown">,
  checks: {
    tests: { status, tool, metrics: { tests_total, tests_passed, tests_failed, tests_skipped, pass_rate, duration_seconds } },
    coverage: { status, tool, metrics: { coverage_pct, coverage_type } },
    lint: { status, tool, metrics: { lint_errors, lint_warnings, lint_score, lint_files_checked } },
    complexity: { status, tool, metrics: { avg_cyclomatic_complexity, max_cyclomatic_complexity, high_complexity_functions, complexity_source } },
    deps: { status, tool, metrics: { vuln_critical, vuln_high, vuln_moderate, vuln_low, vuln_total } },
    perf: { status, tool, metrics: { perf_p50_ms, perf_p95_ms, perf_p99_ms, perf_custom } }
  },
  static_findings: <STATIC_FINDINGS array — each: { severity, check, file, line, description, action }>,
  grade: <"A"|"B"|"C"|"D"|"F">,
  regressions: <REGRESSIONS array>,
  comparison_report: <PREV_REPORT_PATH basename or null>
}
```

---

## Phase 5: Display Report and Store Snapshot

### Action 1: Display

Render the health report to the terminal using Markdown formatting:

```
## Codebase Health Report — {{PROJECT_NAME}}
Date: <ISO date> | Commit: <git_short_sha> | Compared to: <previous report date or "first run">

Overall Grade: <A/B/C/D/F>  (<one-line summary>)

### Test Suite      [<PASS/FAIL/SKIPPED>]
  Tests: N passed, N failed, N skipped (N total)
  Pass rate: N% <delta: (+N%) or (-N%) or N/A (first run)>
  Duration: Xs

### Code Coverage   [<PASS/FAIL/SKIPPED/ESTIMATED>]
  Coverage: N% <delta vs previous>
  Type: line/branch/statement

### Linting         [<PASS/FAIL/SKIPPED>]
  Score: N/100 <delta vs previous>
  Errors: N  Warnings: N

### Complexity      [<MEASURED/ESTIMATED/SKIPPED>]
  Avg CCN: N  Max CCN: N
  High-complexity functions: N (>10 CCN) <delta vs previous>

### Dependencies    [<PASS/FAIL/SKIPPED>]
  Vulnerabilities: N critical, N high, N moderate, N low

### Performance     [<PASS/FAIL/SKIPPED>]
  p50: Nms  p95: Nms  p99: Nms <delta vs previous>

---
Regressions detected: N
<if N > 0, list each:>
  - <check>: <metric> changed from X to Y (<delta>)
<if N == 0:>
  No regressions detected.

---

### Static Analysis Findings  [<N total: N critical, N warning, N info>]

<if STATIC_FINDINGS is empty:>
  No static findings detected.

<if STATIC_FINDINGS is non-empty:>

  | Severity | Check | File | Line | Finding | Action |
  |----------|-------|------|------|---------|--------|
  <for each finding in STATIC_FINDINGS, sorted by severity (critical first, then warning, then info):>
  | <CRITICAL|WARNING|INFO> | <check> | <file> | <line> | <description> | <action> |

  <if any critical findings:>
  #### Critical Findings (require immediate attention)
  <for each critical finding:>
  **[CRITICAL] <check>** — `<file>:<line>`
  > <description>
  > **Action:** <action>

  <if any warning findings (limit to top 5 by file breadth — prefer findings spread across more files):>
  #### Warnings (recommended fixes)
  <for each warning finding, up to 5:>
  **[WARNING] <check>** — `<file>:<line>`
  > <description>
  > **Action:** <action>
  <if more than 5 warning findings:>
  > ... and N more warnings. Run with `--only static` to see all.

  <if any info findings:>
  #### Info (low-priority improvements)
  Summary: N info-level findings across N files. Run with `--only static` to see full list.
```

For delta display: wrap positive deltas on error/failure metrics in `(+N)` to indicate regression; wrap negative deltas on pass-rate/coverage in `(-N%)` styled as improvement. For terminal rendering, use plain notation — the sign alone conveys direction.

### Action 2: Store snapshot

Only store if `SAVE_SNAPSHOT=true`.

1. Determine filename: `<YYYY-MM-DD>-<git_short_sha>.json` where the date is today's ISO date. If git is unavailable, use `<YYYY-MM-DD>-unknown.json`.
2. Create `{{SPECRAILS_DIR}}/health-history/` if it does not exist (idempotent — no error if already present).
3. Write `HEALTH_REPORT` serialized as JSON to `{{SPECRAILS_DIR}}/health-history/<filename>`.
4. Print: `Stored: {{SPECRAILS_DIR}}/health-history/<filename>`

### Housekeeping notice

After writing (or after checking the directory if `SAVE_SNAPSHOT=false`), count `.json` files in `{{SPECRAILS_DIR}}/health-history/`. If count > 30, print:

```
Note: {{SPECRAILS_DIR}}/health-history/ has N reports. Consider pruning old ones with:
  ls -t {{SPECRAILS_DIR}}/health-history/ | tail -n +31 | xargs -I{} rm {{SPECRAILS_DIR}}/health-history/{}
```

### .gitignore suggestion

Check whether `{{SPECRAILS_DIR}}/health-history` appears in `.gitignore` (if `.gitignore` exists). If it does not appear, print:

```
Tip: health history reports are local artifacts. Add to .gitignore:
  echo '{{SPECRAILS_DIR}}/health-history/' >> .gitignore
```
