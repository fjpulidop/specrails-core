# Design

## Context

See proposal.md for motivation. Recovery currently assumes a legacy WorkflowState and calls inspectPipeline before every action. The relevant distinction is not only JSON versus SQLite: v2 definitions can be ledger-only, while implementation pieces can own a parent journal or separate scoped implementation journals.

### Clarifications

No requester clarification is required. The ticket fixes the outcome and permits action-specific closed failures. Its four engineering questions are resolved below from source, rather than left to implementation. No access to the private reference run is assumed; automated fixtures are the implementation evidence, and reference-run/user validation belongs to the host after delivery.

### Local reference patterns

- Core `src/agent-runtime/recovery.ts`: `runRecovery`, `safePath`, Attempt, exact replacement, replay reconciliation and unchanged-candidate guard. `src/agent-runtime/recovery.test.ts` creates a real temporary Git repository, uses `initializePipeline` and `runWorkflow`, binds real saved checks and invokes pinned OpenSpec. Keep these behavioral tests, including pending-operation reconciliation, cancellation and forbidden paths.
- `src/agent-runtime/durable-store.ts`: `readWorkflowEnvelope` already exports checksum/run-ID validation; `readWorkflowState` is sufficient. Actual legacy path is `<pipeline>/<runId>/agent-workflow/<runId>/checkpoint.json`, not the v2 directory itself. `acquireWorkflowLease` owns `<workflowDirectory>/<runId>/.lease`.
- `src/agent-runtime/engine/runs.ts`: `definitionRunDirectory` places run.sqlite directly in agent-workflow. `execute` uses `RunLease.acquire`, heartbeat, a linked AbortController, and release after settlement. `src/agent-runtime/engine/checkpoint/lease.ts` is the actual v2 exclusion/fencing protocol; it is NOT compatible with the legacy directory lease alone.
- `src/agent-runtime/engine/run-status.ts`: `observeLedger`, `projectRunStatus` and `statusRun` demonstrate read-only opening and guaranteed close. `projectRunStatus.state.scopes` preserves scope identities; its `steps` map collapses repeated node paths across scopes and must not be used alone for interrupted-step admission. `src/agent-runtime/engine/runs.test.ts` covers real SQLite reopening, byte-preserving status, and ledger-only runs without state.json.
- `src/pipeline/pipeline-state.ts`: `inspectPipeline` validates the saved journal context, computes the CURRENT candidate hash, validates receipts and exposes archive phase; `verifyPipeline` executes registered scoped checks and retains real evidence. These APIs work on implementation journals independently of the workflow's checkpoint format. They require state.json: never create one to make recovery pass.
- `src/agent-runtime/verification-plan.ts`: `readVerificationPlan` validates integrity, runId and scope; `expandedPlanCommands` resolves admitted check IDs. A frozen config is not a substitute for a saved verification plan/check ID.
- `src/agent-runtime/engine/pieces/implementation-binding.ts`: `deriveImplementationBinding`; `src/agent-runtime/engine/piece-dependencies.ts`: `implementationBindings`, `candidateScope`, `verification`; `src/agent-runtime/engine/pieces/implementation.ts`: `createImplementationAdapter`. Bindings live in piece_state under binding:implementation and can point to scoped journals. Validate parent identity, derived directory, repository subset and frozen context before reading them. The existing implementation fixture and `src/agent-runtime/engine/pieces/implementation-step.test.ts` show real v2 implementations; no existing recovery-engine adapter exists.
- `src/agent-runtime/cli.ts`: `runtimeFailure` already serializes EngineError as `{error:{code,message,details}}`; the recovery branch retains original runtime identity. Reuse this, with a regression in `src/agent-runtime/cli.test.ts`, rather than adding another CLI envelope.
- Desktop `server/modules/agent-runtime/runtime/agent-runtime-recovery.ts`: `invokeRuntimeRecovery` resolves retained Core, validates scopedRecovery, sends strict argv/stdin, bounds output and time, but only reads string errors. Its adjacent test uses temporary executable fixture scripts. `agent-runtime-controls.ts`: `AgentRuntimeControls.recovery` reserves project/run activity, invalidates cache, records successful mutation results and currently folds errors into a generic block. `agent-runtime-controls.test.ts` has deferred-promise reservation and failed-operation cleanup tests. `agent-runtime-controls-router.ts` already returns RuntimeControlError's status/code/message, so needs no production change.

Versions: Core package/lock pin LangGraph 1.5.1, Zod 4.6.7, OpenSpec 1.14.3, TypeScript 7.0.2 and Vitest 5.0.5; Node minimum is 22.22.3 (older prose is stale). Core node_modules is absent, so these are lockfile versions, not an asserted installed environment. Desktop uses Express 5/Zod 4 and root Vitest via its manifest/lock. No framework feature or dependency is added. This change is server-side; no React rendering, new screen, translated strings or frontend state update is needed. Awaited subprocess errors flow through the existing HTTP message surface, and controller finally cleanup remains authoritative.

## Goals / Non-Goals

Goals: retain one action implementation and one history format, adapt only engine authority and locking, and make unsafe states explicit.

## Non-Goals

No changes to resume, relaunch, settle, fork, idle admission, providers, workflow traversal, checkpoint contents, installed runtime selection, schema versions, file creation/deletion, or worktree allocation. No automatic journal reconstruction or migration. No blanket declaration that every v2 definition is unsupported.

## Decisions

### 1. A focused adapter, with observed authority separate from action execution

Create `src/agent-runtime/recovery-engine-adapter.ts`. Export the contracted `RecoveryEngine = 'legacy' | 'v2'`, `detectRecoveryEngine(runDir): Promise<RecoveryEngine | null>` and `readNormalizedRecoveryState(runDir, engine): Promise<NormalizedRecoveryState>`. Here runDir is `pipelineStateDirectory(context)`, the parent of agent-workflow. The result of detection is the enum/null exactly as the specified function contract states; do not introduce a conflicting `{engine}` wrapper. Internally retain the derived engine with loaded authority, never persist it.

Detection tests v2 `<runDir>/agent-workflow/run.sqlite` first, then the existing legacy location using the saved run ID. Obtain/validate the ID from the frozen context (the pipeline directory is named by runId); never scan other runs or treat access errors as ENOENT. Both present means v2 wins, including corrupt-v2-plus-valid-legacy. Neither present alone produces the existing missing-run sentence. A directory/symlink/corrupt/unsupported-schema store is a saved but unusable run, not absence.

Keep NormalizedRecoveryState exactly `{status:string,nextStep:string|null,steps:Record<string,{status:string}>,candidateHash:string|null}`. Legacy delegates to readWorkflowState and uses the existing journal candidate for candidateHash. V2 opens RunDatabase readOnly, reads observeLedger/projectRunStatus, validates run identity and the frozen request context against the caller, and closes in finally. Preserve status and nextStep; populate steps from ALL scoped rows with collision-free keys (scopeId + encoded nodePath), ensuring an interrupted sibling cannot be hidden. Extra internal authority (journals, plan, archive evidence, lease handle) is separate from this contracted shape.

Resolve implementation journal authority read-only: prefer a valid root journal belonging to this context; inspect all saved implementation bindings for additional archive evidence. A single binding may supply a journal only if its validated context covers the requested repository and the repair's complete candidate scope. Reuse inspectPipeline and readVerificationPlan for that authoritative context, never the first unvalidated directory found. Multiple differing scopes/check plans cannot be silently combined into a new plan. Fail the affected mutation/check with an actionable unsupported error when no unique applicable full scope exists. This is a safety limit of the current action contract, which has no scope selector, not an excuse to reject normal root implementation runs.

A supported failed root implementation with run.sqlite, state.json and saved plan supports all seven actions. Inspect returns parent frozen repositories and normalized v2 lifecycle alongside real journal verification/checks and parent history. History and file reads need no pipeline journal once SQLite context identity is validated. For journal-less v2 inspect, report saved status/repositories/history, any integrity-valid parent saved plan, and verification invalid with an explicit unavailable-evidence reason; do not claim a saved SQLite receipt is current without fingerprinting. Missing or conflicting authority for inspection itself is an unsupported inspect. For journal-less or ambiguously scoped writes, candidateHash is null until the current candidate AND archive state can be proven from an applicable journal: patch/check fail closed. Do not substitute the saved candidate_json.hash for the current worktree fingerprint, initialize a journal, invent check IDs from config, or create a fake successful receipt.

This answers the state-mapping question: status/nextStep/current scoped step statuses come from SQLite, candidateHash and implementation archive phase come from validated current journal inspection; completion/history supplies additional positive archive/completed evidence. Never use absence of an archive node name as proof of safety. `status === succeeded`, successful completion or any applicable archived journal prevents repair. A failed completion does not become a succeeded run just because completion_json is non-null.

### 2. Match the engine lease and keep SQLite observations read-only

Legacy retains acquireWorkflowLease for all actions. V2 observations use read-only SQLite plus the existing directory lease to serialize recovery-history access with other recovery calls; inspect a live SQLite lease and refuse a currently active run rather than pretending to own its execution lease. No read action opens SQLite writable or heartbeats it. V2 observation is diagnostic, not a claim that multiple filesystem reads form one atomic candidate snapshot; no receipt/certification results from it.

V2 patch/check first perform read-only capability preflight, path and authority validation; unsupported calls stop before any writable open/history publication. Then hold the recovery directory lease AND acquire the actual RunLease on existing run.sqlite using a fresh owner UUID. A directory lease alone cannot fence v2 resume. Re-read authoritative state and candidate after lease acquisition, recheck terminal/archive/interruption conditions, and reject concurrent authority changes rather than applying stale preflight results. AcknowledgeInterrupted never overrides an active lease. A running saved status with an expired/no owner can proceed only with acknowledgement. Legacy semantics remain as written.

Bind a linked AbortController to caller cancellation and lease-heartbeat loss. Assert the execution token immediately before publishing history/file effects and before starting checks, and after awaited checks before recording outcomes. Await check subprocess termination, stop heartbeat, release token, close database and release directory lease in finally, including acquisition failures. Use existing lease APIs without changing runtime lifecycle code or synthesizing a LangGraph attempt. Lease acquisition/release may update SQLite lease/revision/timing metadata for WRITE actions; checkpoint, candidate certification, attempt and completion truth are not edited. Reads do not do this. Unsupported preflight leaves both stores, worktree and history untouched. If state changes between preflight and acquisition, return the existing concurrent/block error and require reinspection; do not mislabel it as missing or perform a repair.

### 3. Keep the existing recovery action path

`runRecovery` retains its real public signature and Promise<unknown> return. Replace only legacy-specific admission/state/lease reads with adapter authority. Keep request schema, safePath and forbidden-path filtering, WorkspaceTools, protected-plan rules, expectedHash/exactly-one replacement, history cap/pagination, replay/requestHash and retry guard unchanged. The history remains `<pipeline>/<parentRunId>/recovery-history.json` for both engines, not under the SQLite directory or child journal; Attempt is unchanged.

Use the same current candidate hash for Attempt and the failed-check guard. For supported journal-backed v2 checks, resolve only a saved plan's checkId, invoke existing verifyPipeline with the matching validated journal context and existing 45-second deadline; keep real scoped evidence and OpenSpec report validation. Do not commit engine receipts or grant acceptance. After a patch, the next call recomputes the candidate, invalidating old evidence naturally. No workflow state/checkpoint is updated to pretend the repair completed the run. Original resume still owns revalidation.

### 4. Preserve the error over the actual subprocess boundary

Export `RecoveryErrorCode = 'runtime_recovery_blocked' | 'recovery_unsupported_engine'` from recovery.ts. Define/re-export RecoveryUnsupportedEngineError with public code/action/recommendation/message; use EngineError inheritance in the adapter so existing runtimeFailure emits the code and `{action,recommendation}` details. Include action and a concrete next step in message, e.g. 'Recovery patch is unsupported for this v2 run because its candidate/archive scope is unavailable. Preserve the original worktree; fork the run through the supported control after inspecting its saved evidence.' Never automatically fork or relaunch.

Desktop invokeRuntimeRecovery accepts both old string errors and the bounded structured runtime-result error. Only a validated code recovery_unsupported_engine with string message/action/recommendation becomes a typed unsupported error carrying those properties. Preserve recommendations in the message even when only code/message are sent by the existing HTTP route. Other errors, timeout, oversized/malformed output and uncertain transport outcomes retain current generic behavior. AgentRuntimeControls.recovery maps this typed error to RuntimeControlError(409, 'recovery_unsupported_engine', message); generic blocks remain HTTP 409/runtime_recovery_blocked. Distinct RESPONSE CODE means JSON error code, not a gratuitously different HTTP status. Existing API/MCP message consumers already display the recommendation; no screen is required.

### Rejected alternatives

- Request engine flag: clients cannot reliably identify the saved store.
- Reusing only acquireWorkflowLease for v2 writes: the live engine never acquires it.
- Taking SQLite RunLease for inspect/history/file reads: violates read-only observations by changing revisions/lease state.
- Using projectRunStatus.steps alone: hides interrupted sibling scopes under repeated node paths.
- Fabricating legacy checkpoints, journals, candidate hashes or verification plans: destroys saved-state authority.
- General candidate-scope/verification framework refactor: not needed to support the existing implementation seam; unsupported ambiguous scopes are explicit.
- Splitting read and write delivery/specs: would leave recovery half usable and violates the ticket.

## Blast radius

Only the following implementation files may change. Paths are relative to their named admitted checkout.

| Repository | File | Reason |
| --- | --- | --- |
| Core | src/agent-runtime/recovery-engine-adapter.ts (new) | Detection, read-only normalization, validated journal authority and engine-compatible recovery lease helpers/errors |
| Core | src/agent-runtime/recovery-engine-adapter.test.ts (new) | Real store, scoped status, identity, authority and lease tests |
| Core | src/agent-runtime/recovery.ts | Consume engine authority and lease helpers while retaining common seven-action implementation; error type/re-export |
| Core | src/agent-runtime/recovery.test.ts | Failed SQLite implementation fixture and all-action safety/replay/check/legacy coverage |
| Core | src/agent-runtime/cli.test.ts | Prove structured unsupported recovery errors survive runtimeFailure/CLI output without changing CLI protocol |
| Core | docs/agent-runtime.md | Update scoped recovery section with engine paths, lease/read behavior and supported/unsupported guidance |
| Desktop | server/modules/agent-runtime/runtime/agent-runtime-recovery.ts | Preserve validated structured unsupported error from retained subprocess |
| Desktop | server/modules/agent-runtime/runtime/agent-runtime-recovery.test.ts | Real fixture CLI structured/string/uncertain error compatibility |
| Desktop | server/modules/agent-runtime/runtime/agent-runtime-controls.ts | Map specific error to distinct 409 JSON code and retain recommendation |
| Desktop | server/modules/agent-runtime/runtime/agent-runtime-controls.test.ts | Unsupported mapping, admission and cleanup regressions |
| Desktop | docs/internals/programmatic-agent-runtime.md | Document distinct error code, original-run behavior and supported scope |

Planning artifacts in Core `openspec/changes/runtime-7ac7ce39415f0acb5319/`: proposal.md, design.md, specs/guided-run-recovery/spec.md, tasks.md. No main spec exists today; `openspec list --specs --json` reports no specs. Use one ADDED delta, not an invented replacement of in-flight engine specs. No locales, configuration examples, migrations or generated contracts become stale: request schema/actions/capabilities/envelopes are unchanged; the extensible error code is additive and documented in the runtime guides. durable-store.ts, engine/runs.ts, run-status.ts and pipeline-state.ts are references, not edits: their existing exports suffice. Desktop adds no files or cross-module imports, so its source map/module manifest needs no regeneration.

## Risks / Trade-offs

- [Scope ambiguity] → Read persisted bindings, validate all archive evidence, and refuse unsupported mutation rather than guess which candidate/plan to use. All seven actions remain required on the normal failed v2 implementation fixture.
- [Lost/expired lease during a check] → Heartbeat, linked cancellation, immediate effect assertions and finally cleanup; retain the uncertainty rather than replaying effects. Existing WorkpaceTools atomic publication is synchronous, keeping the final assert-to-write interval small.
- [Read-only observations during concurrent startup] → No certification is emitted; mutation admission always rereads under the real v2 execution lease. Current active lease blocks recovery admission. Unrelated external file writers remain outside the application lease guarantee, as already documented.
- [Corrupt database, wrong run/context, unsafe storage or unsupported schema] → Read-only preflight fails actionably; never downgrade to legacy or migrate. Permission errors are not absence.
- [Check changes candidate] → Existing verification detects drift, and every subsequent request recomputes candidateHash; recovery cannot bless a stale receipt.
- [Error transport compatibility] → Exercise actual stdout JSON and nonzero exit behavior with string and structured errors, malformed output and timeout cleanup; do not classify by matching prose.
- [Cost of inspect] → Same repository fingerprint cost as existing inspectPipeline, proportional to current candidate files. No new hot-path scans, provider calls, global registry or speculative caching.

## Migration Plan

No data migration. Ship paired source changes through the normal host release. Historical retained Core packages remain authoritative; never replace a saved run's runtime to enable this behavior. New code reads both existing formats and writes unchanged history. Rolling back code leaves legacy-compatible history and original stores/worktrees intact; existing old packages may still block v2 guided recovery. Build/tests are host verification, not authoring-role actions.

## Out-of-scope findings

The ticket's simplified legacy path differs from durable-store's nested path; corrected only in detection/documentation. Core README/CONTRIBUTING Node prose lags package.json's minimum; do not clean it up here. Ledger-only definitions and multiple implementation journals exist today; do not infer a synthetic parent journal or add a new scope-selection API. The private reference run is not in the admitted checkouts. Dependencies are not installed in Core, so execution checks require the host's normal dependency setup; no test success is claimed by this plan.
