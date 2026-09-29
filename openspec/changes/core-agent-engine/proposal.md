## Why

Core and Desktop currently run different graph engines, splitting recovery, retry, usage and verification rules across two products. A durable Core engine executing Desktop-authored definitions will give every loop one execution authority while preserving retained runtimes, verified delivery and the existing implementation workflow during migration.

## What Changes

- First deliver C0 contract hygiene and a frozen legacy graph fingerprint, plus C1 experiments on SQLite, subgraphs and committed event streaming. Prepare the paired Desktop D0 compatibility change separately.
- Add, in gated later blocks, JSON workflow definitions, a closed piece registry, open role descriptors, LangGraph compilation, SQLite checkpoints and an atomic evidence ledger, recovery, fork, bounded fan-out and human interruption.
- Expose additive CLI capabilities and JSONL events; Desktop continues to own git, delivery, accounting and product graph definitions.
- Add per-project memory, attempt-boundary steering, offline evaluation and optional traces after the engine is proven.
- Document all blocks C0–C10 here and D0–D8 in the paired Desktop change; synchronize public Core, Desktop and Web documentation as capabilities ship and at final integration.
- **BREAKING, deferred to C10/Core 7 only:** remove the legacy engine after Desktop migration, parity and two releases of zero legacy launch telemetry.

## Capabilities

### New Capabilities

- `runtime-contract-compatibility`: truthful runtime identity, exported operation metadata, legacy fingerprint, retained-package compatibility and versioned capability discovery.
- `workflow-definition-execution`: strict definition validation, canonical identity, a closed registry and a single Core execution authority.
- `durable-workflow-runs`: atomic SQLite durability, lease, interruption, recovery, cancellation and immutable fork semantics.
- `workflow-pieces-and-roles`: explicit role permissions, provider parity, native commands, verification, control flow and composable pieces.
- `runtime-events-and-accounting`: committed ordered JSONL, bounded outputs, nullable usage, graph/status and host-owned accounting evidence.
- `runtime-memory-and-steering`: project-scoped store, durable attempt-boundary steering, evaluation and optional trace export.
- `engine-rollout-validation`: evidence-gated spikes, cross-platform robustness, package verification, staged release compatibility and documentation.

### Modified Capabilities

None: this Core checkout has no existing files under `openspec/specs/`; these specifications establish its normative baseline.

## Impact

Core: `integration-contract.json`, runtime CLI/types/executors/config/schema, `core-host.ts` and workflow fingerprint extraction; later `src/agent-runtime/engine/`, package exports and documentation. The production graph and `pipeline-state.ts` remain behaviorally stable through the additive phases. CI gains reproducible evidence jobs without reducing supported coverage or platform checks.

Paired change: `specrails-desktop/openspec/changes/core-agent-engine`. Shared protocol: [contracts.md](contracts.md). Supplied source documents: [reference/core-agent-engine.md](reference/core-agent-engine.md). The audited baseline is Core **6.0.1**, workflow **7**, instructions **10**, API **1**; the supplied historical 6/9 identity must never be restored. C0 publication remains the D0 release acceptance gate; local pairing does not prove publication or three-platform acceptance.
