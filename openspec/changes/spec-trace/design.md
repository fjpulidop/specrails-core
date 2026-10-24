## Context

`pipeline-state.ts` is copied into every project and may import Node built-ins only (`src/architecture.test.ts`). Verification receipts record each command, its working directory and exit code, but not which test files it executed; the runtime already decides that for the test-reachability guardrail (`compact/test-reachability.ts`).

## Decisions

1. **Self-contained scanner, injectable reachability.** `spec-trace.ts` takes a `reaches(root, command, file)` function. Core (verify node, `specrails-core pipeline trace`) injects `commandReachesTest`, which expands npm scripts. The copied `trace.mjs` uses a literal fallback: a command naming test-shaped paths or existing directories reaches only those; any other command is assumed to run every test.
2. **Touched requirements come from the deltas.** ADDED, MODIFIED and RENAMED-to requirements of the change's delta specs are both "touched" and added to the requirement set, so a change is traceable before archive; REMOVED and RENAMED-from ids leave the set, which turns a stale tag into `untagged`.
3. **Evidence is explicit.** With a receipt, executed means "reached by a command that exited 0". Without one, nothing is executed unless the caller passes `--tests-passed` (a CI step after the test suite). `failed` and `not-executed` are distinct reasons.
4. **Advisory in the runtime.** The trace is written after the verification decision and never changes it. It is recorded in the acceptance report as a finding, not a check: any non-passed check, even optional, would turn the acceptance status into `with-exceptions` for every run without tags. Enforcement is the reviewer's (a touched requirement without a demonstrated tag is an issue), and `--check` in CI.
5. **Fail-open.** Unreadable files are skipped; a scan error in the runtime yields no trace; the CLI exits 0 outside `--check`.
6. **Drift sweep as a reference definition.** A host-declared read role keeps it read-only by construction and reuses the role-turn structured output; it needs no new piece.

## Non-Goals

- Desktop UI, analytics and the CI script template.
- Parsing test frameworks to bind a tag to one test case: the tag binds the file it lives in.
- Changing the OpenSpec format.

## Risks / Trade-offs

- A repository-wide walk on every passing verification costs I/O. Bounded to 20,000 files of at most 1 MiB, skipping dependency and build directories.
- The literal fallback in the copied runner is coarser than Core's reachability; it errs toward "reached".
