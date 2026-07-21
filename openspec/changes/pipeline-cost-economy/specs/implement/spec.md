## ADDED Requirements

### Requirement: Scoped test execution in developer task cycles
The developer agent SHALL run tests scoped to the test file(s) a task touches during every TDD cycle step (RED, GREEN, REFACTOR), deriving the scoped invocation from the project's full test command. The developer SHALL NOT run the full project suite inside a task cycle.

#### Scenario: Per-task scoped run
- **WHEN** the developer completes the GREEN step of a task that modified `src/foo.ts` with tests in `src/foo.test.ts`
- **THEN** it re-runs only `src/foo.test.ts` (e.g. `npx vitest run src/foo.test.ts`), not the whole suite

### Requirement: Single bounded full-suite gate in the developer phase
The developer agent SHALL run the full CI-equivalent suite exactly once, at its validation gate after all tasks are checked. On failures it SHALL re-run only the failing test files between fixes, with a budget of 2 fix cycles followed by one final full-suite confirmation. If failures persist after the budget, the developer SHALL halt and report the failing tests verbatim to the orchestrator instead of continuing to loop, weakening tests, or handing off silently.

#### Scenario: Gate failure within budget
- **WHEN** the gate run fails 3 tests in one file
- **THEN** the developer fixes and re-runs only that file, and after convergence runs the full suite one final time

#### Scenario: Budget exhausted
- **WHEN** failures persist after 2 fix cycles and the final full run
- **THEN** the developer halts and reports the failing test names verbatim — it does not enter an unbounded fix loop

### Requirement: Scoped reviewer fix re-runs with one final full confirmation
The reviewer SHALL run the full ordered CI check list once as the pipeline's authoritative run. When a check fails, fix re-runs SHALL be scoped to the failed check and failing files where the runner supports it. After up to 3 fix-and-verify cycles the reviewer SHALL re-run the full ordered list exactly once to confirm everything passes together.

#### Scenario: Reviewer fixes one lint failure
- **WHEN** only the lint check fails on two files
- **THEN** the reviewer re-runs lint on those files after fixing, and the full ordered list only once at the end

### Requirement: Runner-output economy in agent reasoning
When a test, lint, or build command fails, the developer and reviewer agents SHALL carry forward only the failing test/rule names and a relevant error excerpt of at most ~50 lines. Full runner logs SHALL NOT be re-pasted into agent reasoning. Both agents SHALL apply loop detection (the same command run 3 times with no intervening code change means stop and reassess) and file re-read discipline (state what was already learned before re-reading an unchanged file).

#### Scenario: Large failing suite output
- **WHEN** a scoped run emits a 2,000-line log with 2 failures
- **THEN** the agent extracts the 2 failing test names and the relevant excerpt only

### Requirement: Developer prompts carry the test-economy contract
Phase 3b SHALL include in every developer agent prompt a reminder that per-task test runs are scoped, the full suite runs once at the developer's validation gate, and the reviewer owns the pipeline's authoritative full CI run.

#### Scenario: Prompt construction
- **WHEN** Phase 3b launches any developer agent
- **THEN** the prompt contains the test-economy reminder

### Requirement: Design confidence gate before implementation
The pipeline SHALL evaluate the architect's `design-confidence.json` for each feature after Phase 3a and before Phase 3b. A missing file SHALL produce a warning and proceed (backward compatible). `high` or `medium` SHALL proceed. `low` SHALL halt that feature before any implementation cost is paid, printing the architect's `blocking_question` and re-run instructions, updating pipeline state (`developer` → `skipped`, error context carries the question), performing no git or backlog operations for that feature, and leaving the OpenSpec artifacts in place as a resumable starting point. `--confidence-override "<reason>"` SHALL bypass this gate as well as the Phase 4b-conf gate. In multi-feature mode the halt SHALL be per-feature.

#### Scenario: Low confidence halts one feature
- **WHEN** a multi-feature run has feature A at `low` and feature B at `high`
- **THEN** feature A halts before Phase 3b with its blocking question while feature B continues normally

#### Scenario: Missing artifact
- **WHEN** `design-confidence.json` does not exist for a feature
- **THEN** the pipeline warns and proceeds exactly as before this change

#### Scenario: Override
- **WHEN** the run was invoked with `--confidence-override "accepted risk"`
- **THEN** a `low` confidence proceeds to Phase 3b with the override logged
