## Context

The audited Core checkout is package 6.0.1 with workflow identity 7 and role instructions 10. Desktop invokes its retained Core package in a separate Node process and consumes JSONL; it never imports the runtime into the CommonJS server. The existing workflow runner owns a file checkpoint and ledger, while Desktop separately schedules most loop pieces. The supplied documents describe the destination and retain historical 6.0.0 identifiers; [contracts.md](contracts.md) and the [tracked decision log](reference/core-agent-engine.md#14-decisiones-tomadas-y-preguntas-abiertas-para-el-maintainer) record corrections.

Both repositories have a `core-agent-engine` OpenSpec change. This design authorizes the first C0/C1/D0 preparation; later implementation remains dependent on the stated releases, experiment results and parity gates. The initial design is deliberately provisional at the persistence, nested graph and stream integration boundaries until C1 evidence exists.

## Goals / Non-Goals

**Goals:**

- One Core execution authority for every new definition, with deterministic validation, durable recovery, immutable identity and verifiable evidence.
- Preserve the current legacy graph, retained runtime selection, read/write permissions, null usage semantics and host-owned git/delivery/accounting.
- Reuse LangGraph's tested graph, retry, interrupt, checkpoint and composition primitives behind a closed piece registry.
- Make each delivery independently reviewable and reproducible across supported operating systems; record test commands and remaining gates honestly.

**Non-Goals:**

- No live provider-session steering, user-defined executable pieces, hosted LangSmith dependency or unification of Desktop chat/spec provider adapters.
- No legacy removal, automatic release publication or claim of full initiative completion during C0/C1/D0.
- No change to the copied `pipeline-state.ts` format or a direct Desktop SQLite/runtime import.

## Decisions

### 1. Compatibility precedes extraction

C0 fixes metadata to the running constants, exports CLI operation metadata and extracts the existing implementation definition without changing its order, edges, effects, retry limits or transition budget. Fingerprints cover normal and compact-developer variants and compare with the existing serializer. Deriving a new intended graph from prose was rejected because it could orphan checkpoints. The current 7/10 identity supersedes historical 6/9, including fixture expectations and paired Desktop examples.

The integration contract advances additively to 5.1 with engine 1, an empty piece list and a non-deprecated built-in 7. `evaluate` is a machine CLI operation; `help` is explicitly presentation-only. Capabilities are advertised only as their implementation becomes available. API stays at 1.

### 2. Core owns execution; ports preserve existing effects

The future engine lives under `src/agent-runtime/engine/`: definition validation/compilation, state/reducers, pieces, checkpoint/ledger/lease, run use cases, budgets and event projection. Pure definition, expression, hash and reducer code do not perform filesystem, process or provider effects. Effectful coordinators bind focused ports for executors, verification, OpenSpec, persistence, clock and emission; existing provider strategies remain authoritative. No generic repository or service locator is required.

The dependency direction stays `shared ← pipeline ← agent-runtime ← installer`. `shell` therefore uses runtime process utilities or a justified shared extraction, never an import from `installer/` despite that path appearing in an initial task sketch. Desktop owns graph editing, freezing launch files, runtime retention, git/worktrees, settlement, delivery and `ai_invocations`. This avoids moving transaction or lifecycle ownership across repositories.

### 3. Definitions are frozen data with a closed registry

Core owns the JSON schema, piece parameter schemas, semantic validation and canonical SHA-256 identity. Desktop vendors the public schema byte-for-byte and obtains validation/hash from Core. Definitions use labeled `ends`, bounded transitions, declared roles and immutable component bodies. Product factories live in Desktop; Core keeps fixtures for contract and parity tests.

The compiler uses static/conditional edges, retry policies, interrupts, subgraphs and `Send`/deferred join where C1 proves support. User JavaScript/eval and arbitrary executable plugins are excluded. Final details for initial hash calculation and private routing channels must be specified before C3; the planning examples alone are not an implementation contract for those ambiguities.

### 4. SQLite is selected; its binding and transaction integration are gated

Each v2 run stores checkpoints and evidence in `run.sqlite` with WAL, FULL synchronous writes, foreign keys and a busy timeout. One execution lease protects run ownership. The terminal node evidence and checkpoint must commit together, and persisted events must be emitted after commit. This is a behavioral requirement, not an assumption that a LangGraph callback automatically shares a transaction.

C1 compares `node:sqlite` on Desktop's Node 22.22.3 with the supported LangGraph SQLite adapter/native binding, including actual packed/assembled artifacts. The preferred candidate is evaluated against 200-node crash/recovery, WAL, permissions, latency and Linux/macOS/Windows acceptance. A production Node minimum change requires an accepted decision. File fallback is considered only if both bindings fail and its weaker atomicity is made explicit before changing this contract.

Transactions must be short: provider processes cannot run while holding a SQLite write transaction. C1 must establish a real commit boundary compatible with concurrent branch scheduling and streaming. Steering is a separate process writing only an inbox transaction and must not evade execution ownership.

### 5. Recovery and delivery remain conservative

The frozen request chooses engine 1 or 2 and binds the exact retained runtime, config and definition hash. Resume rejects replacement definitions/config or identity changes. Interrupted write attempts require explicit recovery; completed nodes do not replay. Fork creates a new run from a prior checkpoint and preserves its source. Human interruptions terminate with exit 2 and resume via a new CLI invocation; cancellation aborts descendants and leaves a resumable checkpoint.

Verification binds a receipt to the current candidate. Later writes invalidate it. Business rejection is `succeeded` with `completion.ok: false`, not an infrastructure failure. Desktop admits review only on the applicable verified completion policy. Core never commits, pushes, opens PRs or writes host accounting rows.

### 6. Observability is durable and bounded

Workflow events carry a per-run monotonically increasing sequence across resumes, node path and attempt identity. Graph, agent, verification, span and efficiency events remain additive JSONL. A line is bounded to 1,000,000 characters, history/output is bounded, and unknown usage stays null with separate known totals for budgets. C1 compares streaming-only with a hybrid in which committed ledger events supply workflow lifecycle and writer/custom chunks supply transient agent progress; a hybrid is acceptable if it preserves committed lifecycle ordering.

### 7. CI is optimized without weakening evidence

Existing typecheck, script tests, coverage and package checks remain release gates. Add dedicated C1 evidence jobs at Node 22.22.3 across macOS arm64, Windows x64 and Linux x64, and later a robustness job. Cache keyed dependency installs, partition runtime suites where measured runtime warrants it, cancel superseded runs and preserve evidence artifacts. Do not duplicate the full coverage suite in each spike lane, drop supported Node/platform coverage, lower thresholds, or count source-bundle metadata as release package acceptance. Source/runtime CI changes are implemented with the responsible block, not by these planning artifacts.

## Risks / Trade-offs

- [Checkpoint callback timing can violate atomicity] → Test crashes at real graph/ledger boundaries and do not start C3 until the transaction design is demonstrated.
- [Native ABI, Windows paths or Node minimum changes break packaging] → Test the actual packed artifact and Desktop assembly on all three required platforms; record architecture, Node version and commit.
- [Subgraph namespaces and fork semantics differ from sketches] → C1 tests exact LangGraph 1.4.14 APIs and updates the contract before compiler implementation.
- [Parallel write pieces share a worktree] → Define scheduling and candidate/verification isolation before enabling fan-out writes; default concurrency is 1, schema maximum 8.
- [New capabilities confuse older Desktop versions] → Additive fields, truthful feature discovery, unchanged no-definition legacy invocation and retained package routing.
- [Large initiative expands beyond an acceptable PR] → One block per branch/PR, explicit dependency gates, incremental product factories and final removal only after telemetry.

## Migration Plan

1. Validate both OpenSpec changes strictly before source changes. Deliver separate C0, C1 and D0 PRs; D0 publication acceptance awaits published C0. No releases are automatically published as part of preparation.
2. C2 opens roles after C0 while preserving built-in argv; C3 starts only after accepted C1 evidence and C2. C3 uses fixture pieces with no product change.
3. C4/D1/D1b/D2 introduce basic pieces, authoring and accounting with Quick SDD; C5/D3/D4 add agents, pauses and restart recovery; C6/D5/D6 add implementation/fan-out and complete factory parity.
4. C7/C8/D7 add project memory, evaluation, traces and durable steering. C9 updates normative/public Core docs; corresponding Desktop and Web docs track shipped behavior and final integrated completion.
5. Preserve both engines through two releases of measured migration parity and zero legacy launches. Only D8/C10 remove legacy code in a paired Core 7/contract 6.0 delivery.
6. Rollback during additive stages selects legacy definitions and the retained runtime for existing runs. Never rewrite frozen files or migrate an active checkpoint to a different engine. Schema/migration rollback cannot silently discard recorded evidence.

## Open Questions

C1 must resolve the SQLite binding, exact atomic checkpoint/ledger integration, supported subgraph interrupt/fork APIs and post-commit stream mapping. Before C3 the contract must also resolve initial definition hash calculation, private `$lastOutcome`/`$item` scope, verification's own write effect and terminal receipt ordering. Before C6 it must define safe shared-worktree fan-out semantics. These are implementation gates; neither passing OpenSpec validation nor creating a report file proves them resolved.
