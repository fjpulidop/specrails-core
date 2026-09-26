# Checkpoint — 26 September 2026

The user requested a checkpoint because their weekly quota was almost exhausted.
The original objective remains **the entire plan, not just the foundations**.
This checkpoint is unfinished implementation, not production acceptance. Do not
merge, release, check off pending gates, or describe the complete migration as done.

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
| Integrated Core WIP | `feat/core-engine-v2`, `/private/tmp/specrails-core-engine-v2` | Draft checkpoint PR; see branch |
| Integrated Desktop WIP | `feat/core-engine-desktop-v2`, `/private/tmp/specrails-desktop-engine` | Draft checkpoint PR; see branch |

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
