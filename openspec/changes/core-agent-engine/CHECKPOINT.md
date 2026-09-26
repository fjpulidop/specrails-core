# Checkpoint — 26 September 2026

## CI continuation — 26 September 2026, 22:25 CEST

Run 36268127165 (37a46681) completed: all general/runtime matrix jobs and all three installed-package recovery jobs passed. Windows C1 spikes remain failing while local C1 integration awaits explicit approval after auto-review rejection. Coverage failed two late-fork integration cases at their explicit 40-second POSIX ceiling (not a coverage threshold failure). Raised only these multi-workflow fork test ceilings, plus their related incomplete-journal case, to 120 seconds on POSIX; Windows remains 180 seconds. Assertions and coverage thresholds are unchanged. Focused fork regression: 6/6 passed in 51.17 seconds. Full CI rerun is still required for this change.


The user requested a checkpoint because their weekly quota was almost exhausted.
The original objective remains **the entire plan, not just the foundations**.
This checkpoint is unfinished implementation, not production acceptance. Do not
merge, release, check off pending gates, or describe the complete migration as done.

## Codex continuation — 26 September 2026, 20:30 CEST

- Windows general also found an invalid performance assumption in active-duration acceptance: resume was required to complete faster than a fixed 1200ms human pause. Kept the semantic assertions (exactly unchanged duration across pause, resume increment bounded by measured resume wall time, stable terminal duration) and removed only the arbitrary speed assertion.
- Follow-up CI 36267164838 on e49a4268 passed installed-package recovery on Windows, Linux and macOS. Runtime-3 found another hardcoded 60-second compiler Batch timeout; removed those two overrides so Vitest's existing 180-second Windows / 60-second POSIX policy applies. This failure and its cleanup EPERM follow the timeout; no tests skipped or thresholds lowered.
- Full-status scoped committed outputs are committed as c5defe25; 12 runtime tests, typecheck and build passed. Desktop consumes them at settlement and packet healing, preserving scope/attempt identities and multiple reviewer verdicts without inventing an aggregate.

- Remote CI run 36265688629 on 4dd75eae completed: coverage/build, all Linux/macOS jobs, and all six Windows runtime partitions passed. Windows general/installed recovery failed because the fault preload used a drive path as an ESM URL; fixed using pathToFileURL. Three test declarations also overrode the Windows timeout with 40 seconds; they now retain the configured 180-second Windows limit. Local focused engine regression: 16/16 pass.
- Rebalanced the two new expensive engine suites (fork and implementation compiler) across the existing three Windows runtime jobs; no extra runner or removed test. Actual Vitest inventories verified exactly: 46/44/42 of 132 tests, exhaustive and disjoint. Script tests: 24/24. Remote Windows C1 spike ACL failure remains pending integration of the separate C1 branch; local merge was blocked by automatic review and user clarification is still pending. No merge was executed.

This update supersedes the partial-wave findings below only where stated. Work remains in progress; no merge or release occurred.

- CLI acceptance now passes 7/7. Corrected tests to compare the database before their own lease mutation and read historical rows inside a transaction. A fork before a question is inactive/running until its first resume reaches the question.
- Added the real thirty-node CLI robustness harness. All seven cases passed locally (four SIGKILL boundaries with the real 60-second lease TTL, large output, cooperative cancel, POSIX SIGTERM). Fault injection lives in an external test preload; production execution has no crash environment switch.
- Installed npm package acceptance and the same robustness harness passed on macOS arm64 / Node 22.22.3. Evidence: `/private/tmp/core-v2-package-acceptance/engine-robustness.json` and release-manifest.json. The new three-platform `engine-robustness` CI job is written and actionlint passes; remote execution is still pending.
- Core steering status now projects up to 512 receipts, prioritizing pending messages, 240-character previews, total pending/consumed counts and authoritative consuming attempt/time. Signal acceptance returns Core's durable acceptedAt. Five inbox tests and typecheck passed. Paired Desktop consumes this projection rather than writing a second receipt ledger.
- C9 architecture, definition examples, extension and recovery guides now exist; all four initial docs checks pass with eight complete definitions. Added actual CLI validation of the examples, awaiting the full suite currently running.
- Full offline definition evaluation passed all 10 observations; independent acceptance true, correction prompt target met, no observed quality drop or extra invocations. Monetary conclusion remains inconclusive. Raw report: `evidence/offline-definition-evaluation.json`.
- Verified Core changes are saved in `c282a12b` with DCO. Local C1 ancestry integration was rejected by automatic approval review because the handoff prohibits merges; clarification is pending. No merge executed. C1/C2 branch reconciliation and remote CI dispatch remain outstanding.
- Full Core coverage passed: 98 files, 1215 passed / 1 Windows-only skip, 605.27 seconds; statements 87.89%, branches 79.95%, functions 93.21%, lines 93.99%. This includes actual CLI validation of all eight documentation examples. Thresholds unchanged. C1/C2 ancestry, full paired Desktop/Web work and remote platform gates remain pending.
- Follow-up D2 transport fix: v2 `runtime-result` now carries authoritative `revision` and `eventCursor`, allowing Desktop to persist the final projection frontier atomically. Build and all seven real CLI acceptance tests passed after this change; the full coverage result above predates this additive field change.
- Follow-up cancellation fix: retrying an accepted cancellation no longer duplicates `workflow_cancelled` or replaces terminal truth reached before lease acquisition. Run lifecycle tests passed 11/11 and build passed. CI run 36265688629 was dispatched on preceding commit 4dd75eae; it is not acceptance of this later fix.

## Continuation checkpoint — 26 September 2026, 19:55 CEST (Claude Code session)

A second assistant session resumed from this checkpoint, verified every claim
below against code and tests, planned the remaining work, and started a first
implementation wave with parallel agents. That wave was cut by the account's
session limit before any agent finished or verified its work. **Nothing from the
wave is verified or committed on this branch.** The partial edits are left
uncommitted in `/private/tmp/specrails-core-engine-v2` and backed up on branch
`wip/claude-wave1-core` (pushed if the push succeeded; check `git branch -r`).
Treat them as a head start, not as accepted work: keep what passes, rewrite what
does not. Read this section first, then the original checkpoint below.

### Verified baseline (HEAD `af7bbcd8`, all commands on macOS arm64, Node 22.22.3)

| Claim | Result |
| --- | --- |
| `npm run typecheck`, `npm run build` | pass (exit 0) |
| Engine suite `vitest run src/agent-runtime/engine` | 26 files, **156/156** pass |
| `fork.test.ts -t 'exact incomplete implementation'` (the rerun the C3-C7-C8 note asked for) | **passes** (15.3 s) |
| Full suite `vitest run` (no coverage) | 94 files, **1188 passed / 1 skipped** (Windows-only quoting case); 683 s |
| `npm run test:scripts` | 24/24 |
| actionlint on `.github/workflows/*.yml` | 0 findings |
| `git diff --check origin/main...HEAD` | 7 delta spec files end with an extra blank line (cosmetic) |
| Coverage / `npm run ci` / `check:package` on this HEAD | **not run** (the wave was going to run them) |

Findings the original checkpoint did not state:

- **Core CI has never run on PR #389.** `ci.yml` triggers only on `push: main`,
  `pull_request: main` and `workflow_dispatch`; the PR targets `feat/core-engine-c0`.
  The run IDs cited under "Accepted evidence" belong to other branches. To get
  evidence for this head: `gh workflow run ci.yml --ref feat/core-engine-v2` (or
  widen the triggers to feature branches the way Desktop does with `push: ['**']`).
- Branch ancestry still unreconciled: C1 commits `d2569939`, `e1e25589`, `7ef947df`
  (spike files + docs) and C2 docs commit `ac48c1a0` are not ancestors of HEAD; the
  C2 feature `4ad57b54` was applied as a patch. Plan: `git merge origin/feat/core-engine-c1`
  then cherry-pick `ac48c1a0`, resolving conflicts only in `openspec/` docs.
- The `engine-spikes` CI job pins Desktop commit `70c9e8a4`, which exists only on
  Desktop feature branches (D0 is not merged); re-pin once D0 lands.
- The validation registry advertises exactly these 16 kinds: `prompt, role-turn,
  decider, verify, shell, openspec-validate, openspec-archive, condition, end,
  approval, question, gate, component, map, implementation, join`.

### Partial, unverified edits left in the worktree (do not trust without tests)

Typecheck and build pass with these edits. A focused run of
`cli.test.ts integration-contract.test.ts engine/cli-acceptance.test.ts
engine/package-surface.test.ts engine/docs-examples.test.ts install-config.test.ts
legacy-runtime.test.ts core-host.test.ts` gives **120 passed / 7 failed**:

| File | State |
| --- | --- |
| `integration-contract.json` | `agentRuntime.engine = { version: 2, definitionSchema: 'schemas/workflow-definition.schema.json', nodeKindsVersion: 1 }`, `nodeKinds` = the 16 kinds above. Contract stays `5.1`. |
| `src/agent-runtime/cli.ts` | `runtime api` now emits `engineVersion: 2`, `nodeKindsVersion`, `nodeKinds`, capabilities `engineV2/workflowDefinitions/fanOut/fork/steeringInbox: 1` (plus the existing ones). Decision: advertise now because Desktop D5 factories and D7 depend on it; the three-platform robustness gate stays a release gate, not an advertising gate. Revert this decision if you disagree, but do it explicitly. |
| `src/agent-runtime/engine/runs.ts`, `engine/cli.ts` | Frozen request gains `workflow: { id, version, source, definitionHash, engine: 2 }` per contracts.md §9; resume selects the engine from it (legacy when absent). |
| `src/agent-runtime/engine/execution.ts` | Test-only crash hook: honoured only when `SPECRAILS_ENGINE_TEST_HOOKS=1`; `SPECRAILS_ENGINE_CRASH_AT='<nodePath>:<before|during|after-writes|after-snapshot>'`. Documented in `contracts.md` implementation note. Production ignores both. |
| `src/agent-runtime/engine/piece-registry.ts` | Small catalog/kinds helper for the contract test. |
| `src/agent-runtime/cli.test.ts`, `integration-contract.test.ts` | Updated for the advertised surface; passing. |
| `docs/agent-runtime.md` | Capability table updated. |
| `scripts/verify-package.mjs` + new `scripts/verify-package-v2.mjs` | Installed-package v2 flow (validate → run to `question` pause → resume `--answer` → fork → status → api → package exports). **`npm run check:package` was not run after this change.** |
| `src/agent-runtime/engine/__fixtures__/acceptance/{question-flow.json,runtime-config.json}` | Provider-free fixture for the CLI/package tests. |
| `src/agent-runtime/engine/__fixtures__/robustness/{thirty-node.json,marker.mjs}` | 30-node provider-free definition and shell marker helper for the robustness harness. **`engine/robustness.test.ts` was never written**; the CI job `engine-robustness` was never added. |
| `src/agent-runtime/engine/cli-acceptance.test.ts` (new) | 3 failures: "rejects resume with a definition and fork under an active lease without touching the run" (both entry points: the run DB byte size changes 319488→327680, i.e. the assertion or the fork-under-lease path touches the DB — investigate WAL checkpointing before changing production code) and "forks a historical cut ... source database byte-identical" (`runtime-status` shape does not match the expected `{ engineVersion: 2, ... }` object — check the compact status fields). |
| `src/agent-runtime/engine/package-surface.test.ts` (new) | passes. |
| `src/agent-runtime/engine/docs-examples.test.ts` (new) + `docs/engine-v2/pieces.md` (new) | 4 failures because the other C9 documents were never written: expects `docs/engine-v2/README.md`, `definition-format.md` (with the reference examples incl. `freestyle` and byte-equal copies of the four published fixtures), `recovery.md`, `adding-a-piece.md`, `desktop-integration.md`; `pieces.md` header is stale and the test supports `SPECRAILS_UPDATE_DOCS=1` to regenerate the descriptor catalog. |
| `openspec/changes/core-agent-engine/contracts.md` | Dated "Implementation note" about capability advertisement, frozen request and test hooks. |

Also pending from that wave (written to a request file, not applied): update
`src/agent-runtime/engine/README.md` ("capabilities remain disabled" is now
false) and append a dated clarification to `c3-protocol.md` §"Implementation
clarifications" that `fork`/`steeringInbox` are advertised.

### Remaining Core work, in order, with acceptance

1. **Robustness harness (C3 gate, CHECKPOINT item 2).** Write
   `src/agent-runtime/engine/robustness.test.ts` driving the REAL CLI
   (`dist/agent-runtime/cli.js`) on `__fixtures__/robustness/thirty-node.json`:
   SIGKILL before effect / during a write piece / after pending writes / after
   snapshot (resume never repeats a completed node; shell marker files count once;
   interrupted write requires `--recover` and `status` exposes
   `state.recoverableSteps`); two-process contention (`lease_held`, exit 1) and
   expired-lease takeover; SIGTERM cancellation (`cancelled`, resumable, no
   orphan children) and `cancel --context --request-id`; modified definition on
   resume (`definition_hash_mismatch`/`resume_incompatible`); >2 MB shell output
   within the JSONL line bound. Add job `engine-robustness` to `ci.yml`
   (ubuntu-latest, macos-15, windows-latest, Node 22.22.3, against the packed
   package via `npm pack` + `SPECRAILS_ENGINE_CLI=<installed cli.js>`), validate
   with actionlint, dispatch CI on the branch and record the run ID here.
2. **Package/CLI acceptance (item 3).** Make `cli-acceptance.test.ts` pass, run
   `npm run check:package` with the new v2 flow, keep the legacy checks and output
   line format.
3. **C9 docs (tasks 10.1/10.2).** Write the five missing `docs/engine-v2/*.md`
   files grounded in the code, make `docs-examples.test.ts` pass, add the legacy
   banner to `docs/agent-runtime.md`.
4. **Offline evaluation against final source (item 4).**
   `node dist/agent-runtime/cli.js runtime evaluate --output <dir> --definition <fixture>`
   over the fixtures in `engine/__fixtures__/*.json` plus the focused-correction
   corpus (`/private/tmp/core-engine-v2-focused-correction/` has the previous
   report); store the JSON under `openspec/changes/core-agent-engine/evidence/`.
   No paid benchmarks; no invented savings.
5. **Reconcile ancestry** (merge C1, cherry-pick `ac48c1a0`), trim the 7 EOF blank
   lines, update `tasks.md` checkboxes only for work with evidence, rewrite the
   PR #389 body for the final scope. Then `npm run ci` (never lower thresholds).

### Environment notes for this continuation

- Node 22.22.3: `export PATH=/private/tmp/specrails-engine-tools/node-v22.22.3-darwin-arm64/bin:$PATH`.
- `dist/` was rebuilt at 19:52 with the partial edits.
- Desktop paired tests resolve Core from `../specrails-core`, which does not
  exist; export `SPECRAILS_CORE_SOURCE_DIR=/private/tmp/specrails-core-engine-v2`
  and `SPECRAILS_EFFICIENCY_CORE_ROOT=/private/tmp/specrails-core-engine-v2`
  when running Desktop suites instead of creating a symlink.
- Paired Desktop continuation: `openspec/changes/core-agent-engine/CHECKPOINT-GLOBAL.md`
  in `/private/tmp/specrails-desktop-engine` has the matching section, the shared
  server API contracts and the Desktop/Web plan.

## User scope and authority

Implement Core engine v2 with LangGraph, all pieces and lifecycle operations;
Desktop integration and an n8n-style visual editor with drag/drop, connections,
all configuration options, human interaction, recovery and reusable workflows;
optimize agent quality/cost, CI, releases and testing; update Core/Desktop/Web
documentation; solve discovered gaps. Branches and PR creation are authorized.
The user requested autonomy and no postponed implementation. Actual rollout
evidence cannot be invented: the two-release legacy retirement gate still needs
real releases and telemetry. No merge or release has been performed.

The briefing, complete contracts and plan were read in that order. Paired OpenSpec
artifacts were created, validated and committed before code. Original supplied
documents were `/Users/javi/Desktop/core-agent-engine{,-contracts,-implementer-brief,-tasks-core,-tasks-desktop}.md`;
the paired change contains the working contracts, tasks and reference plan.
Read this checkpoint, the Desktop checkpoint documents, and then the remaining
tasks. Preserve already accepted foundation work.

## Branches and durable review artifacts

| Work | Branch / local checkout | PR |
| --- | --- | --- |
| Core C0 | `feat/core-engine-c0`, `/Users/javi/repos/specrails-core` | [385](https://github.com/fjpulidop/specrails-core/pull/385) |
| Core C1 SQLite/public LangGraph probes | `feat/core-engine-c1`, `/private/tmp/specrails-core-engine-c1` | [386](https://github.com/fjpulidop/specrails-core/pull/386) |
| Core C2 open roles | `feat/core-engine-c2`, `/private/tmp/specrails-core-engine-c2` | [387](https://github.com/fjpulidop/specrails-core/pull/387) |
| Desktop D0 | `feat/core-engine-d0`, `/Users/javi/repos/specrails-desktop` | [706](https://github.com/fjpulidop/specrails-desktop/pull/706) |
| Core CI | `codex/ci-engine-optimization`, `/private/tmp/specrails-core-ci-engine` | [388](https://github.com/fjpulidop/specrails-core/pull/388) |
| Desktop CI/release | `codex/ci-engine-optimization`, `/private/tmp/specrails-desktop-ci-engine` | [707](https://github.com/fjpulidop/specrails-desktop/pull/707) |
| Web rollout notes | `docs/core-engine-rollout`, `/private/tmp/specrails-web-engine-docs` | [218](https://github.com/fjpulidop/specrails-web/pull/218) |
| Integrated Core WIP | `feat/core-engine-v2`, `/private/tmp/specrails-core-engine-v2` | [389](https://github.com/fjpulidop/specrails-core/pull/389) |
| Integrated Desktop WIP | `feat/core-engine-desktop-v2`, `/private/tmp/specrails-desktop-engine` | [708](https://github.com/fjpulidop/specrails-desktop/pull/708) |

Foundation and CI PRs are ready for review. Integration PRs remain drafts. Every
created PR is attached to the Codex task. Temporary checkouts may disappear after
OS cleanup; use the pushed branches. Preserve unrelated untracked user work in
the original Web checkout. Do not reset or clean original repositories.

Integration Core started from C0 evidence `11665acb`, merged C1 through
`29ab492e` in `33257b7b`, and applied the C2 production patch without its OpenSpec
ancestry. Reconcile the remaining C1 evidence/ancestry (`d2569939`, `e1e25589`,
`7ef947df`) and C2 (`4ad57b54`, `ac48c1a0`) before final PR stacking. Production
ACL fixes are already present. Desktop started from D0 `70c9e8a4`. The verified
CI/release implementation from PR707 `97cfabbb` was copied into integration;
reconcile its documentation and branch ancestry later, preserving feature edits.

## Accepted evidence

- C0 CI `36227847244`: green; 1,004 tests passed, one existing Windows skip,
  24 script tests, four package assemblies and frozen journals.
- C1 final three-platform CI `36230546712`: green on exact Node **22.22.3**,
  actual Desktop assembly and npm consumer. 200 SIGKILL boundaries per platform.
  Mean SQLite put: macOS 0.282 ms, Linux 0.721 ms, Windows 4.164 ms (<5 ms).
  Accepted binding: `node:sqlite`; minimum Node 22.22.3. Full suite 998 passed,
  one existing skip; scripts 24. This is probe evidence, not production C3 proof.
- C2: 1,030 tests passed, one existing skip, scripts 24, four packages and the
  frozen built-in argv goldens. Legacy identities remain workflow **7** and
  instructions **10**, API **1**, integration schema **5.1**.
- D0 final CI `36228425753` and Windows parity `36228427506`: green.
  Server 8,794 passed/8 existing skips, client 4,647 passed, scripts 86.
- Core CI optimization `36230750772`: all gates green. Removes duplicate
  Ubuntu/Node24 full lane while retaining coverage and tested release tarball.
- Desktop CI optimization `36233342790`: all 18 checks green in **4m05s**,
  versus 15m50s baseline. Server shards 1m43s–2m42s, client 2m18s–3m10s,
  aggregation 35s/43s. Earlier queued run `36230773446` took 22m52s: retain this
  distinction; do not promise hosted runner latency. All 94 script tests passed.
  Exact-SHA trusted frontend reuse includes authenticated missing/expired-asset
  rebuild once, with no fallback for corruption/API/identity failures.
- Integrated Core latest focused composition checks: **48/48** across runs,
  graph description, prompts, role state, open roles and integration contract.
  Additional compiler suites, pieces, native implementation/QuickSDD/Batch,
  SQLite crash/store/inbox/lease/fork suites passed during development; their
  evidence is in agent checkpoint notes and local logs. Not a final full CI run.
- Offline focused correction evaluation: **2/2 independently accepted**, no
  extra invocations, prompt **2,879 → 1,595 bytes (44.60% reduction)**, exceeding
  the 40% target. This does not establish paid monetary savings. Full initial
  definition corpus was 10/10 before subsequent changes; rerun at final source.

## Implemented Core structure

`src/agent-runtime/engine/` contains strict canonical JSON/hash validation, the
published schema and actual 16-piece registry, LangGraph compilation, nested
components/Send maps/deferred joins, isolated state, FIFO effect/AI admission,
intersected budgets, durable SQLite saver/ledger/leases, fork, cancellation,
steering inbox, project memory and optional OTLP HTTP telemetry. Provider turns
reuse the existing invoker with SQLite-scoped session/memo/accounting ports.
Implementation delegates to the native Core nodes/journal instead of copying
their business rules. Role settings and native command policy are open (C2).

The CLI supports definition run/validate/catalog, status, resume, fork, signal,
cancel, invalidate-by-fork and evaluate definitions. Both fatal CLI entry points
emit JSON. SDK and definition-schema exports are added. **Engine v2 capability is
still intentionally unadvertised** in `runtime api`/integration engine metadata;
enable and update parity tests only once integrated/package acceptance is ready.

Important completed decisions:

- Every terminal effect and LangGraph pending write share a SQLite transaction;
  effects/AI permits are released only after commit. An uncertain write needs
  explicit recovery. Durable provider usage is charged once by invocation ID.
- Pending or unreported billing remains unknown; residual reservations retain
  unknown dimensions rather than releasing spent but unreported headroom.
- Parent coordinators do not hold child permits. Sessions are shared across
  developer/fixer within one implementation but isolated across map branches.
- Forks copy public checkpoint history and preserve completed siblings; only
  incomplete implementations restore/rebind their exact journal snapshot.
  Completed implementation evidence stays inherited/read-only. Candidate scope
  snapshots preserve exact metadata exclusions; actual code changes invalidate
  inherited certification. `$vars`/`$outputs` patches clear certification.
- Fork archive only normalizes the exact OpenSpec-generated default Purpose to
  original provenance; authored Purpose or different requirements still conflict.
  Original run databases/journals/spec files must remain unchanged.
- Claimed steering reaches both prompt and role-turn exactly once. Custom role
  prompts are preserved. A transport with `resumeRequiresFullContext` receives
  full instructions even when a session ID is supplied. Custom escalation uses
  the existing single protocol-repair slot, with no added speculative turns.
- Focused correction removes only Node internal dispatch frames, retaining
  assertions, actual/expected values, application frames and complete evidence
  IDs. Legacy prompt/argv defaults remain unchanged.
- `settlePause()` runs after the graph reaches the idle interrupt barrier;
  parallel branches cannot leave a paused run marked running.
- Status is read-only: no filesystem fingerprint, permissions mutation or lease
  acquisition. It includes pending interruptions, reservations, lease, recovery
  attempts, durable efficiency summary and active duration excluding human wait.
  Final create/resume status is projected after releasing the execution lease.

## Required next work (do not silently defer)

1. Read the paired Desktop `CHECKPOINT-D1-D3.md`, `CHECKPOINT-D1B-D5.md` and
   `CHECKPOINT.md` (D4). Finish their precise pending integration/recovery work.
   Do not reimplement the already complete visual authoring or role settings.
2. Add **production** C3 robustness: actual CLI 30-node graph, SIGKILL before,
   during and after writes; real lease expiration/two-process contention;
   explicit `--recover`; graceful cancellation and checkpoint behavior; run on
   Linux/macOS/Windows exact Node22.22.3 with the actual installed npm package.
   Existing six low-level SIGKILL tests and C1 probes do not replace this gate.
3. Finish CLI/package acceptance tests for the latest fork/invalidate, structured
   fatal errors, status/efficiency summary and public engine SDK/schema exports.
   `scripts/verify-package.mjs` still only exercises legacy workflow; extend it
   with actual installed v2 execution/resume/fork. No fake capabilities.
4. Re-run full offline evaluation against final source (including correction
   target and all independent behavioral oracles). Paid cost claims require real
   billing; do not run unbounded paid benchmarks or invent savings.
5. Advertise actual v2 API/integration capability and 16 node kinds, add package
   compatibility/retained-runtime tests, and complete the frozen request contract.
   Currently v2 context/config/definition are authoritative in SQLite, while
   legacy request files remain separate. Verify Desktop's retained host metadata.
6. Desktop D4 has storage migration/APIs but backend recovery, orphan restart,
   isolated delivery reattachment and fork routes are not complete. Preserve
   worktree/settlement ownership and paused runs across restart.
7. Desktop D5 four factories exist; **eight named starter templates remain**.
   D6 telemetry/deprecation, D7 full steering UI, D8 migration/retirement and any
   pending D3 graph/fork visualization require completion/verification.
8. Complete Core/Desktop guides and Web's eight-language user documentation.
   Web PR218 currently contains rollout notes only. Complete C9 docs/evaluation
   and prepare C10/D8 retirement with real rollout gates, not fabricated history.
9. Run required full Core/Desktop coverage, typecheck, architecture, source map,
   build/package/provider and native gates; never lower thresholds. Review
   generated boundary manifests instead of bypassing fixed architecture rules.
10. Reconcile stacked branches/evidence, rewrite draft PRs for final scope,
    publish all required implementation PRs and attach them to the task.

## Local execution and continuation

- Exact Node22: `/private/tmp/specrails-engine-tools/node-v22.22.3-darwin-arm64/bin`.
  Prepend to PATH for Core; its modules are symlinked to the original Core tree.
- Desktop local shared `better-sqlite3` is built for system Node25.9 ABI141.
  Use system Node for local Desktop tests; **do not rebuild shared native deps**.
  CI uses independent exact Node22 trees. Root/client have separate installs.
- OpenSpec global1.2 is stale. Use
  `/Users/javi/repos/specrails-core/node_modules/.bin/openspec` (1.4.1).
- actionlint: `/private/tmp/specrails-engine-tools/actionlint/actionlint -shellcheck=`.
- Useful local logs: `/private/tmp/core-v2-composition-tests.log`,
  `/private/tmp/core-v2-checkpoint-{typecheck,build}.log`,
  `/private/tmp/desktop-engine-checkpoint-typecheck.log`,
  `/private/tmp/core-engine-v2-focused-correction/evaluation.json`.
- Sandbox may block Git metadata/network; authorized branch/PR operations work
  with normal escalation. Sandbox `gh` authentication failure is not reliable.
- No recurring automation was created. Resume when the user has quota, from this
  checkpoint and the pushed integration branches, preserving the complete goal.

## Saved checkpoint references

Core source commit: `9ae02add`; Desktop source commit: `4c84e95c`. Both pushed.
Final checkpoint verification: Core typecheck/build pass and focused tests 48/48;
Desktop full typecheck and architecture pass. The working trees were clean after
source commits. Later documentation-only commits add these cross-references.
Read `CHECKPOINT-C3-C7-C8.md` in Core for detailed persistence/fork notes.

## Fork acknowledgement recovery — 26 September 2026, 23:03 CEST

Added optional fork request idempotency backed by a durable child receipt. Repeated
identical requests return the original receipt without changing source/child DBs;
different cuts/patches/IDs still reject an existing destination. The receipt is
committed before publication and remains stable after child progress. Core fork
suite passed 7 tests (53.19s), typecheck and build passed. Desktop's paired CLI test
also reproduced a post-publication host-file failure and repaired it on retry
without replacing either Core database (34 paired bridge/recovery tests passed).
This is groundwork for the pending Desktop fork endpoint/ownership transfer.
