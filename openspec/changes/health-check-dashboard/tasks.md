---
change: health-check-dashboard
type: tasks
---

# Tasks: Codebase Health Check Dashboard

Tasks are ordered sequentially. Each task depends on the one before it unless stated otherwise.

---

## T1 — Create `templates/commands/health-check.md` skeleton [templates]

**Description:**
Create the file `templates/commands/health-check.md` with the command frontmatter, input declaration, and phase scaffold. Do not fill in phase bodies yet — establish structure and headings only. This gives subsequent tasks a stable insertion target.

**Files involved:**
- `templates/commands/health-check.md` (create)

**Acceptance criteria:**
- File exists at the correct path
- YAML frontmatter present with fields: `name`, `description`, `category`, `tags`
- `name` is `"Health Check Dashboard"`
- `category` is `"Workflow"`
- `tags` includes `workflow`, `health`, `quality`, `dashboard`
- File declares `**Input:** $ARGUMENTS` with description of `--since` and `--only` flags
- Phase headings present: Phase 0, Phase 1, Phase 2, Phase 3, Phase 4, Phase 5
- Uses `{{PROJECT_NAME}}` and `{{CI_COMMANDS}}` placeholders (no others)
- No placeholder tokens other than `{{PROJECT_NAME}}` and `{{CI_COMMANDS}}`

**Dependencies:** none

---

## T2 — Implement Phase 0: Argument parsing [templates]

**Description:**
Fill in Phase 0 in `templates/commands/health-check.md`. Phase 0 parses `$ARGUMENTS` for two optional flags:

- `--since <date>` — use the report from this date as the comparison baseline instead of the most recent
- `--only <checks>` — comma-separated subset of checks to run (`tests`, `coverage`, `lint`, `complexity`, `deps`, `perf`)

Set variables: `COMPARE_DATE` (string or empty), `CHECKS_FILTER` (array or "all"). If no flags: defaults are empty string and "all". Print a one-line summary of active flags.

**Files involved:**
- `templates/commands/health-check.md`

**Acceptance criteria:**
- Phase 0 prose clearly defines `COMPARE_DATE` and `CHECKS_FILTER` variables
- Default values are stated explicitly
- `--only` values are validated against the six known check names; unknown values cause an error message and stop
- Phase 0 ends with a print of active configuration (e.g., `Running checks: all | Comparing to: latest`)
- Follows the same inline-variable pattern as implement.md (no `{{PLACEHOLDER}}` for runtime vars)

**Dependencies:** T1

---

## T3 — Implement Phase 1: Toolchain detection [templates]

**Description:**
Fill in Phase 1. For each of the six check categories, define the detection probe sequence. Detection runs in parallel (all probes issued simultaneously). Each category produces a `TOOL_<CHECK>` variable (the detected tool name or command) and a `TOOL_<CHECK>_AVAILABLE` boolean.

Detection sequences per category (try in order, use first found):

- **tests:** `jest`, `vitest`, `mocha`, `pytest`, `go test`, `cargo test`, `rspec`, `dotnet test`, then fall back to `{{CI_COMMANDS}}`
- **coverage:** `nyc`, `c8`, `pytest-cov`, `coverage` (Python), `go test -cover`, `cargo tarpaulin`, `lcov`
- **lint:** `eslint`, `pylint`, `flake8`, `ruff`, `golangci-lint`, `rubocop`, `cargo clippy`
- **complexity:** `lizard`, `radon`, `gocyclo`, `plato`
- **deps:** `npm audit`, `pip-audit`, `govulncheck`, `cargo audit`, `bundle audit`
- **perf:** check for `scripts/perf.sh`, `scripts/benchmark.sh`, `package.json` script named `"perf"` or `"benchmark"`, `Makefile` target `perf`/`benchmark`

End Phase 1 with a detection summary table.

**Files involved:**
- `templates/commands/health-check.md`

**Acceptance criteria:**
- Detection runs in parallel (prose says "detect all simultaneously")
- Each category's probe sequence matches the list above exactly
- `TOOL_<CHECK>` and `TOOL_<CHECK>_AVAILABLE` variables defined for all six categories
- If `CHECKS_FILTER` is set, skip detection for excluded categories
- Detection summary table shows: Category | Tool Found | Tool Name
- Uses `{{CI_COMMANDS}}` as the tests fallback

**Dependencies:** T2

---

## T4 — Implement Phase 2: Load previous report [templates]

**Description:**
Fill in Phase 2. The command reads `.claude/health-history/` to find the most recent JSON report. If `COMPARE_DATE` is set, find the report closest to that date. Set `PREV_REPORT_PATH` (file path or null) and `IS_FIRST_RUN` (boolean).

If `.claude/health-history/` does not exist or is empty: set `IS_FIRST_RUN=true`. Print a first-run notice that no regression comparison will be possible.

If a previous report is found: load it and set `PREV_REPORT` to its parsed content. Print: `Comparing to: <previous report date> (<git-short-sha>)`.

**Files involved:**
- `templates/commands/health-check.md`

**Acceptance criteria:**
- `PREV_REPORT_PATH`, `IS_FIRST_RUN`, and `PREV_REPORT` variables defined
- First-run case is handled gracefully with a clear notice
- `--since` flag drives report selection when `COMPARE_DATE` is set
- If `--since` date matches no report, print a warning and fall back to the most recent
- Phase ends with a one-line print indicating what the comparison baseline is (or "first run")

**Dependencies:** T3

---

## T5 — Implement Phase 3: Run checks [templates]

**Description:**
Fill in Phase 3. Run checks sequentially in this order: tests, coverage, lint, complexity, deps, perf. For each check:

1. If `TOOL_<CHECK>_AVAILABLE=false` OR check excluded by `CHECKS_FILTER`: mark status as SKIPPED, set all metrics to null, continue.
2. Run the detected tool with appropriate flags to produce machine-parseable output.
3. Claude parses the tool's stdout/stderr to extract the metrics defined in `design.md` for that check.
4. Store raw results in `RESULT_<CHECK>` variable.

Include the exact run commands for each tool (e.g., `jest --json`, `eslint --format json`, `npm audit --json`). Where a tool does not support JSON output, extract metrics from human-readable text using Claude's reasoning.

End Phase 3 with a one-line status per check: `<check>: <status> (<tool>)`.

**Files involved:**
- `templates/commands/health-check.md`

**Acceptance criteria:**
- All six checks are covered
- Each check section states: skip condition, run command, metrics to extract, and how to handle tool failure (set status to FAIL, record error message, continue — never abort)
- Exact JSON output flags included for tools that support them: `jest --json`, `eslint --format json`, `npm audit --json`, `pylint --output-format json`, `cargo audit --json`
- `RESULT_<CHECK>` variable defined for each check
- Tool failure (non-zero exit) sets status to FAIL but does not abort the command
- Sequential execution is explicit in the prose (not parallel)

**Dependencies:** T4

---

## T6 — Implement Phase 4: Build health report and compute grade [templates]

**Description:**
Fill in Phase 4. Using all `RESULT_<CHECK>` values and `PREV_REPORT` (if available), compute:

1. Per-check status: PASS / FAIL / SKIPPED / ESTIMATED (complexity only)
2. Per-metric deltas vs. previous report
3. Regression list: any metric that crosses its regression threshold (defined in `design.md`)
4. Overall health grade (A/B/C/D/F) using the grading rubric in `design.md`

Store all computed values in `HEALTH_REPORT` (a structured object ready for JSON serialization and terminal display).

**Files involved:**
- `templates/commands/health-check.md`

**Acceptance criteria:**
- All regression thresholds from `design.md` are represented in the grade logic
- Grade computation follows the A/B/C/D/F rubric exactly as specified in `design.md`
- `HEALTH_REPORT` contains all fields from the JSON storage schema in `design.md`
- Delta notation is signed: positive deltas on errors/failures shown as regressions, positive deltas on coverage/pass-rate shown as improvements
- `IS_FIRST_RUN=true` path: regressions list is empty, deltas shown as "N/A (first run)"

**Dependencies:** T5

---

## T7 — Implement Phase 5: Display report and store snapshot [templates]

**Description:**
Fill in Phase 5. Two actions:

**Action 1 — Display:** Render the health report to the terminal in the format specified in `design.md`. Use Markdown formatting. Each check section shows: status badge (PASS/FAIL/SKIPPED), key metrics, and delta vs. previous. End with the regressions list (or "No regressions detected") and overall grade.

**Action 2 — Store:** Write `HEALTH_REPORT` as JSON to `.claude/health-history/<YYYY-MM-DD>-<short-sha>.json`. Create the directory if it does not exist. After writing, print the file path.

Also print: if the history directory now contains more than 30 files, print a housekeeping notice: `Note: .claude/health-history/ has N reports. Consider pruning old ones with: ls -t .claude/health-history/ | tail -n +31 | xargs -I{} rm .claude/health-history/{}`.

Include a `.gitignore` notice at the end: if `.claude/health-history/` is not in `.gitignore`, print a one-time suggestion to add it.

**Files involved:**
- `templates/commands/health-check.md`

**Acceptance criteria:**
- Terminal report matches the format in `design.md` section "Report Format"
- JSON file is written with correct filename convention: `<YYYY-MM-DD>-<short-sha>.json`
- JSON content matches the storage schema from `design.md` exactly (all fields present, `schema_version: "1"`)
- `git rev-parse --short HEAD` used for short SHA; falls back to `"unknown"` if git unavailable
- Directory creation is idempotent (no error if already exists)
- Housekeeping notice fires when report count exceeds 30
- `.gitignore` suggestion is printed if `.claude/health-history` is not already in `.gitignore`

**Dependencies:** T6

---

## T8 — Manual verification in test repo [commands]

**Description:**
Verify the completed command template works end-to-end by running `/health-check` in the specrails repo itself (which is a known repo with git, Node.js via web-manager, and shellcheck available for linting).

**Verification steps:**
1. Ensure `templates/commands/health-check.md` is installed into `.claude/commands/` by running the `/setup` command (or copy manually for quick verification)
2. Run `/health-check` with no arguments
3. Verify Phase 1 detects at least one tool (e.g., shellcheck for linting, npm for deps)
4. Verify a report is displayed with the correct sections
5. Verify a JSON file is created at `.claude/health-history/`
6. Run `/health-check` a second time and verify the comparison-to-previous section appears
7. Run `/health-check --only lint` and verify only the lint check runs
8. Verify `{{PROJECT_NAME}}` and `{{CI_COMMANDS}}` are resolved (no raw placeholder tokens in output)

**Files involved:** none (verification only)

**Acceptance criteria:**
- All 8 steps pass without errors
- No unresolved `{{...}}` tokens appear in any output
- JSON file is valid JSON (parse with `jq .` to verify)
- Second run shows delta vs. first run

**Dependencies:** T1, T2, T3, T4, T5, T6, T7
