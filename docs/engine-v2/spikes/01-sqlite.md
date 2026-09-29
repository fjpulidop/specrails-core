# SQLite binding and packaging

Status: candidate A accepted after all three platform, private-storage, packed-package and paired Desktop assembly gates passed; see [the exact evidence](README.md#accepted-evidence-2026-09-26).

Question: can `node:sqlite` on Desktop's Node 22.22.3 provide the public `BaseCheckpointSaver` contract and atomic graph evidence without a native npm module? If it fails a required guarantee, compare `@langchain/langgraph-checkpoint-sqlite`/`better-sqlite3` against the same harness before selecting a binding.

Exit criteria: macOS arm64, Linux x64 and Windows x64 each execute a 200-node real LangGraph graph, kill its child process at every committed node boundary and resume without lost or repeated completed nodes. Kill between pending-write and ledger statements must roll back both. WAL must be active; POSIX files/directories must be 0600/0700 (Windows permission representation is recorded separately). On macOS and Linux, median and p90 checkpoint `put` must each be below 5 ms; on Windows, latency is recorded evidence only. Mean and maximum are always recorded (criterion revised 28 September 2026, see below). The real npm package and paired Desktop assembly must work with the target Node. No production `engines.node` change occurs until all evidence is accepted.

The prototype must use the serializer supplied by checkpoint 1.1.5, test get/list/put/putWrites/deleteThread behavior and observe actual graph persistence calls. A transaction over unrelated test tables is insufficient. Transactions must not span provider execution or stream waits.

## Procedure and observed boundary

`sqlite-saver.mjs` implements the public checkpoint saver API using the dependency's serializer. The fixture ledger references the same task/namespace/checkpoint as LangGraph's `writes`. `putWrites` commits pending results and ledger rows together in a short transaction. LangGraph writes the aggregate snapshot through `put` later. Resume consumes committed pending writes, so it does not repeat those nodes even if the process never reaches the next snapshot. A wrapper around the provider call cannot simply assume ownership of both callbacks.

`sqlite-probe.mjs` starts a fresh Node child for each of 200 sequential boundaries in one real 200-node graph. Every child fsyncs a fault marker immediately before killing itself; POSIX acceptance requires `SIGKILL`, while Windows additionally checks its flushed marker and termination result. Both platforms reject a kill-failure marker or evidence that graceful database cleanup ran. Each parent checks the exact durable frontier, its join to pending writes and execution count before allowing the next resume. Separate kills before the transaction and between pending-write/ledger statements prove rollback and one replay of uncommitted read work. The probe also checks typed serialization, namespace/history filtering, parent configuration, special-write replacement, ordinary-write deduplication and thread deletion.

## Local measurements (2026-09-26)

Environment: macOS arm64, Node 22.22.3, SQLite 3.51.3, LangGraph 1.4.14, checkpoint 1.1.5. The measured 200-boundary run retained exactly 200 completed nodes and 200 executions; pre-commit crashes left neither terminal evidence nor a durable result. WAL was active; database/directory modes were 0600/0700. An initial full probe measured mean `put` 0.301 ms over 202 calls (maximum 2.117 ms), below the 5 ms criterion. These are fixture measurements, not an engine performance promise; the JSON artifact records subsequent runs and source identity.

The executable fixture is excluded from TypeScript production compilation and the npm tarball. CI passed a real packed-package install/exercise and the paired Desktop source assembly on the same exact Node after the probes. This confirms current package compatibility; it does not claim a v2 engine has been shipped.

The paired Desktop smoke on Node 22.22.3 against the original Core `dist` also passed: 12 fixture calls; 120 tokens before approval, 24 tokens during the approval continuation and 0 on terminal resume. Missing billing remained unknown and host Git state remained immutable. This is evidence for the existing legacy Core/Desktop subprocess pairing; it is not evidence that a packaged or assembled v2 engine works.

The real Desktop source assembler subsequently passed locally on the same Node using pinned Desktop `70c9e8a4a7fbc26b89ed5ac724aed97dfcc27d9f`. It installed Core's locked production closure, exercised the staged workflow and pinned OpenSpec, and returned runtime identity 6.0.1 / workflow 7 / instructions 10. The resulting `source-bundle.json` SHA-256 was `6909973ebc00dbc9a45280ee2dad36e90199b7aa8bf5bafa8a2829833827985c`; the Core lock SHA-256 was `b24797c564bf404a5a5a3e1a87ba50b2a79252e1876c9751302724d38c1f235b`. The assembly artifact also records exact assembler/package-input hashes. This fulfills the local source-assembly probe; CI must establish the equivalent result on the other platforms. No registry lock or release version was changed, and the experimental saver is not shipped.

## Accepted decision and production responsibilities

Select candidate A (`node:sqlite`) for C3 with minimum Node `>=22.22.3`, the exact tested version. It passed checkpoint API, durability, latency and packaging on macOS arm64, Linux x64 and Windows x64 without a native npm dependency. Candidate B did not need measurement because A met every criterion; no comparative performance claim is made. This experiment PR itself preserves the existing production minimum.

The [accepted CI artifacts](README.md#accepted-evidence-2026-09-26) verify the protected Windows directory and SQLite file ownership/ACL, as well as POSIX modes. They include identical source and assembly hashes across all platforms. The fixture ledger has no production leases, receipts, repeated visits, attempt identifiers or event sequence: C3 must design and test those around this boundary. No transaction may remain open during provider work or asynchronous serialization.

## Latency criterion revision — 28 September 2026

The original gate compared the mean `put` with 5 ms. Under `synchronous=FULL` each
`put` fsyncs, so on hosted Windows runners the mean mostly measures a few slow
shared-disk flushes: the accepted run measured 4.164 ms, and two later runs of
unchanged spike code measured 9.92 ms and 6.92 ms while every durability check
passed (macOS 0.28 ms, Linux 0.72 ms). With the owner's approval the gate now
requires the median and the nearest-rank p90 to be below 5 ms on every platform.
The same bound still catches a systematic slowdown of the typical checkpoint;
mean and maximum remain in the evidence JSON. No durability, permission or
packaging criterion changed.

A later run of the same code on the Windows hosted runner measured a 16.71 ms
median, while an earlier one passed below 5 ms. Windows fsync latency on shared
runners varies by more than an order of magnitude, so no fixed bound is a
reliable signal there. With the owner's approval, Windows latency is now
`informational`: it is recorded in the evidence (`latencyGate`), and Windows is
still gated by durability (200/200 boundaries), private-storage ACLs and
packaging. macOS and Linux keep the enforced median/p90 < 5 ms gate.
