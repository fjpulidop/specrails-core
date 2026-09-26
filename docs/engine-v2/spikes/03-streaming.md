# Streaming and committed JSONL lifecycle

Status: local measurements require a hybrid adapter; cross-platform acceptance pending.

Question: do `streamMode: ['updates', 'custom']`, writer and `streamEvents` expose enough information to reproduce existing graph, agent, verification, span and workflow events after the transaction that gives them authority?

Exit criteria: run a deterministic six-phase implementation-shaped graph with fixture agent/verification events and an instrumented SQLite saver. Record stream arrival relative to pending-write/checkpoint commits, latency and serialized byte volume; compare updates/custom with streamEvents. A lifecycle event must not claim durable completion before its ledger/pending-write commit. Agent progress may be transient but cannot substitute for committed usage/terminal evidence. Prove this on all three target platforms.

## Procedure and local measurements (2026-09-26)

The same six deterministic implementation-shaped phase functions run first through the experimental graph and then the existing `runWorkflow` callback path. Fixture writer payloads exercise agent and verification framing; no real provider, full `runCoreWorkflow` acceptance or receipt-parity claim is made. A second pass inserts a 5 ms async delay before `putWrites` to test callback ordering under a legitimately asynchronous saver.

An initial full Node 22.22.3/macOS arm64 probe measured:

| Source | Events and ordering | Bytes / elapsed |
| --- | --- | --- |
| Natural updates/custom | 6 updates, 6 custom; 0 updates observed before commit in this run | 1,196 stream bytes; 8.08 ms; mean custom latency 0.134 ms |
| Saver delayed 5 ms | All 6 updates arrived before their pending-write/ledger commit | 1,193 stream bytes; 53.19 ms |
| `streamEvents` v2 | 8 chain starts, 8 chain ends, 6 stream events; all 6 node ends arrived before ledger commit | 9,244 bytes; 15.61 ms |
| Existing callbacks | 14 workflow events, 6 spans, 6 progress events; succeeded with reported fixture usage | 6,804 bytes; 375.32 ms |

The candidate's post-commit observer emitted exactly six terminal events and verified each row through SQLite before emission. Volumes measure different payloads, and the fixture is too small to infer performance gains. The evidence JSON includes later runs and exact source/platform metadata.

## Event mapping and decision

| Public JSONL | Authority |
| --- | --- |
| `runtime-graph` | Compiled definition metadata emitted once at invocation start |
| `agent-event`, `verification-output` | Writer/custom progress; transient output does not establish committed completion |
| `workflow-event` terminal/retry/branch lifecycle | Durable ledger events emitted after their pending-write/evidence transaction, with production attempt identity and sequence |
| `runtime-efficiency-event` | Recorded invocation evidence/usage, then emitted after its owning transaction |
| `span` | `streamEvents` timing as observation, correlated with committed attempt identity; a chain-end is not a completion acknowledgement |
| `runtime-status`, `runtime-result` | Committed run state read after required pending writes/checkpoints settle |

Choose the hybrid adapter. Even `durability:'sync'` does not make raw update or chain-end delivery a universal post-commit callback. The delayed saver proves a valid counterexample rather than depending on a timing accident in the natural run. C3 must implement durable event sequencing, idempotent attempt/invocation projection, output caps and recovery replay; this spike only proves the ordering boundary. Linux/Windows runs and the full implementation pairing evidence remain pending acceptance gates.
