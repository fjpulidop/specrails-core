## 1. C0 — Contract hygiene and frozen legacy fingerprint

Precondition: both paired OpenSpec changes pass strict validation. Preserve audited workflow 7/instructions 10; do not copy historical 6/9 pins. Detailed source checklist: [C0](reference/core-agent-engine-tasks-core.md#c0--higiene-de-contrato-y-fingerprint-congelado-del-legado).

- [x] 1.1 Correct integration schema to 5.1, real workflow/instruction identities, phase order including fixer, all machine CLI operations including evaluate, engine 1/empty pieces/built-in 7 metadata and existing schema pins.
- [x] 1.2 Export a typed runtime CLI operation catalog used by dispatch and assert contract parity; document help as presentation-only.
- [x] 1.3 Extract the existing pure definition fingerprint and implementation workflow factory without changing observable legacy behavior.
- [x] 1.4 Freeze normal and compact-developer fingerprints; test drift in edges, identity, ordering and transition budgets against actual node descriptors.
- [x] 1.5 Use the API constant in runtime identity, correct stale runtime/scaffold docs and record any further audited drift in the tracked plan.
- [x] 1.6 Run affected contract/core-host/CLI/legacy/install-config tests and full `npm run ci`; capture command results and retained-runtime evidence in the C0 PR.
- [x] 1.7 Record dated commit/evidence and remaining publication gate; pair D0 acceptance with published C0 without auto-publishing releases.

C0 evidence, 2026-09-26: implementation [6ab6b3ce](https://github.com/fjpulidop/specrails-core/commit/6ab6b3ce2f26ee5f5d8f8055b9229322a65ad501), [PR #385](https://github.com/fjpulidop/specrails-core/pull/385). On macOS arm64 with Node 22.22.3, the six affected suites passed **144/144** with no skips, including the retained-runtime regression. `npm run ci` exited 0: typecheck passed, **24/24** script tests, **67/67** coverage suites and **1004 passed / 1 platform-only skip**. The pre-existing skip is the Windows executable-path quoting case in `src/installer/util/exec.test.ts`; the successful Windows CI lanes exercise it. No new skip or coverage reduction was introduced. Coverage: statements **86.62%**, branches **78.79%**, functions **91.04%**, lines **92.32%**. Package verification reported: `Verified specrails-core-6.0.1.tgz: two CLI entries, four provider assemblies and four frozen runtime journals`.

The [source-commit CI run](https://github.com/fjpulidop/specrails-core/actions/runs/36227847244) passed all **22 jobs**, covering Linux, macOS and Windows across Node 20/22/24, coverage and package checks. `runtime api` retains `apiVersion: 1`, `workflowVersions: ["7"]`, instructions `"10"` and no v2 capability. OpenSpec strict validation passed with zero issues. C0 publication and therefore D0 release acceptance remain pending; these results do not mark C1 or later engine blocks complete.

## 2. C1 — Evidence-driven SQLite, subgraph and streaming spikes

Independent experiment branch/PR; no production engine implementation or Node minimum change before the decision. See [C1](reference/core-agent-engine-tasks-core.md#c1--spikes-con-gate-de-decisión).

- [ ] 2.1 Write exit criteria first in `docs/engine-v2/spikes/01-sqlite.md`, `02-subgraphs.md`, `03-streaming.md`, including exact versions/platforms and pending evidence.
- [ ] 2.2 Prototype candidate SQLite checkpoint/ledger integration with real LangGraph serialization and checkpoint APIs, preserving run transaction ownership and portable process handling.
- [ ] 2.3 Measure 200-node kill/recovery boundaries, WAL, permission policy, put latency and actual packed/assembled runtime behavior; compare the alternative binding when the preferred candidate fails or lacks required guarantees.
- [ ] 2.4 Probe nested interrupts/resume, `Send`, branch namespaces/history, internal checkpoint fork, deferred join, classified retries and subgraph streams using executable fixture tests.
- [ ] 2.5 Compare updates/custom/writer/streamEvents with current JSONL on fixture execution; measure latency/volume and prove which lifecycle signals occur after durable commit.
- [ ] 2.6 Add reproducible `engine-spikes` CI evidence on macOS arm64, Windows x64 and Linux x64 with Node 22.22.3; preserve coverage, platform/package checks and evidence artifacts.
- [ ] 2.7 Record accepted binding/Node implications, supported graph APIs and event mapping, or explicitly retain pending decisions when evidence is incomplete; update contract/design/plan with limitations.
- [ ] 2.8 Run `npm run ci` and all spike jobs, attach exact results/commit/platform metadata to the C1 PR; keep C3 gated until all required evidence passes.

## 3. C2 — Open roles and explicit executor permissions

Depends on C0; preserve built-in argv. Detailed checklist: [C2](reference/core-agent-engine-tasks-core.md#c2--roles-abiertos-access-artifacts-instructions-nativecommand-y-roles).

- [x] 3.1 Add role descriptors and request access/artifacts/instructions/nativeCommand validation with backward-compatible built-in defaults.
- [x] 3.2 Derive provider, workspace and OpenSpec permissions from descriptors; implement native commands through existing provider strategies.
- [x] 3.3 Extend config/schema, role resolution, prompt construction, routing and efficiency code; tolerate free prompt inputs and advertise openRoles only when complete.
- [x] 3.4 Test built-in argv identity and custom permission/command behavior across provider fixtures, update contract/docs and run `npm run ci`.
- [ ] 3.5 Release gate: pair schema vendoring and role configuration UI with Desktop D1b.

## 4. C3 — Durable definition engine

Depends on accepted C1 and C2. Resolve the open contract questions in design before implementation. Detailed checklist: [C3](reference/core-agent-engine-tasks-core.md#c3--núcleo-del-motor-v2).

- [ ] 4.1 Specify hash bootstrap, private routing channels, verification receipt ordering and actual checkpoint/ledger commit boundaries using C1 evidence.
- [ ] 4.2 Implement/export definition schema, canonical hash and semantic validation with one test per contract error and no executor side effects.
- [ ] 4.3 Implement state reducers, bounded history, null-preserving usage, piece descriptors/registry and test-only pieces.
- [ ] 4.4 Compile static/conditional edges, retry, bounded cycles and proven interruption/composition primitives; test graph equivalence.
- [ ] 4.5 Implement SQLite saver/ledger/lease with atomic terminal records and rollback/crash tests over real graph execution.
- [ ] 4.6 Implement create/resume/status/fork/cancel and explicit interrupted-write recovery with frozen request identity.
- [ ] 4.7 Implement shared budget enforcement and committed/bounded event projection with per-run monotonic sequence.
- [ ] 4.8 Add CLI definition/catalog/validation/fork/status operations and truthful capabilities, schema exports and contract parity.
- [ ] 4.9 Run CLI fixtures, full robustness matrix and `npm run ci` across all required platforms; include packed runtime verification before declaring C3 complete.

## 5. C4 — Basic pieces and Quick SDD

Depends on C3. Detailed checklist: [C4](reference/core-agent-engine-tasks-core.md#c4--piezas-básicas-y-quick-sdd-de-referencia).

- [ ] 5.1 Implement prompt with native commands, identity-bound sessions, sentinels, bounded capture and classified retries.
- [ ] 5.2 Implement portable bounded shell, evidence mode, pinned OpenSpec validation/archive and a pure condition parser without eval.
- [ ] 5.3 Implement approval/question/gate/end according to the validated interruption/terminal protocol.
- [ ] 5.4 Add Quick SDD fixture parity, repair, blocked-question and per-node crash tests; publish the nine implemented basic descriptors.
- [ ] 5.5 Run `npm run ci` and robustness, update contract/docs and coordinate D1/D2/D5 acceptance against the published Core release.

## 6. C5 — Agent pieces and loop policies

Depends on C4.

- [ ] 6.1 Implement role-turn, decider/no-progress and verify using existing invocation/verification policies and real receipts.
- [ ] 6.2 Implement fail-fast, session continuity, bounded history and later-write verification invalidation with failure-path tests.
- [ ] 6.3 Add Freestyle and verify-fix reference definitions plus rule parity/robustness tests; update contract/docs and run `npm run ci`.

## 7. C6 — Implementation composition and fan-out

Depends on C5 and accepted C1 nested-graph evidence.

- [ ] 7.1 Reuse the existing implementation nodes in a dedicated subgraph with journal ownership and resume validation intact.
- [ ] 7.2 Specify safe fan-out effects over shared repositories; implement map/join/component with bounded shared concurrency, nested paths and branch checkpoints.
- [ ] 7.3 Add implementation receipt/acceptance parity over the existing evaluation corpus, internal fork, nested interrupt and all join policy tests.
- [ ] 7.4 Advertise fanOut only when complete; expand robustness, run `npm run ci`, update contract/docs and pair Implement/Batch acceptance with D5.

## 8. C7 — Project store, evaluation and traces

Depends on C6.

- [ ] 8.1 Implement per-project SQLite store namespaces and declared read/write permissions with cross-project isolation and deletion tests.
- [ ] 8.2 Extend offline evaluation to definitions and reference corpus; add optional OpenTelemetry export with fake collector tests and documented configuration.
- [ ] 8.3 Update contract/docs, run definition evaluation and `npm run ci`, and record actual parity/trace evidence.

## 9. C8 — Durable steering inbox

Depends on C3 plus the consuming prompt/role pieces.

- [ ] 9.1 Implement bounded signal ingestion and serialized inbox writes without acquiring or bypassing the execution lease.
- [ ] 9.2 Consume steering atomically at attempt boundaries, render the operator section and expose receipt/consumption state.
- [ ] 9.3 Test recovery/invalidation/fork idempotence and missing-run errors; advertise steeringInbox, update contract/docs and run `npm run ci` with D7 pairing.

## 10. C9 — Engine documentation and cross-repository integration

Depends on C6; synchronize later C7/C8 additions as they ship.

- [ ] 10.1 Publish architecture, definition format, piece catalog, extension guide and recovery documentation under `docs/engine-v2/` with legacy guide links.
- [ ] 10.2 Validate every complete documentation definition through the CLI and keep descriptors/examples aligned with the registry.
- [ ] 10.3 Update corresponding Desktop and specrails-web documentation to shipped behavior; run relevant documentation checks and record the paired commits.
- [ ] 10.4 Execute integrated stage acceptance, full Core/Desktop CI and package compatibility checks; document unresolved limitations without marking later gates complete.

## 11. C10 — Core 7 retirement of the legacy engine

Blocked until published D8, migration parity and two releases of zero legacy-launch telemetry. The existence of v2 files alone is insufficient.

- [ ] 11.1 Record release/telemetry/parity evidence and prove older runs still resolve their retained original runtime.
- [ ] 11.2 Remove only the proven obsolete legacy runner/checkpointer/CLI paths and exclusive tests, retaining identity utilities and current recovery contracts.
- [ ] 11.3 Advance Core major and integration schema to 6.0 in the paired release change; test engine-1 rejection directing users to the retained runtime.
- [ ] 11.4 Run full `npm run ci`, Desktop D8 compatibility/package checks and final three-repository documentation validation; record completion date and commit evidence.
