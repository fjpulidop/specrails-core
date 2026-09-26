# SQLite binding and packaging

Status: local candidate A passed; three-platform and paired assembly acceptance pending.

Question: can `node:sqlite` on Desktop's Node 22.22.3 provide the public `BaseCheckpointSaver` contract and atomic graph evidence without a native npm module? If it fails a required guarantee, compare `@langchain/langgraph-checkpoint-sqlite`/`better-sqlite3` against the same harness before selecting a binding.

Exit criteria: macOS arm64, Linux x64 and Windows x64 each execute a 200-node real LangGraph graph, kill its child process at every committed node boundary and resume without lost or repeated completed nodes. Kill between pending-write and ledger statements must roll back both. WAL must be active; POSIX files/directories must be 0600/0700 (Windows permission representation is recorded separately). Mean checkpoint `put` must be below 5 ms. The real npm package and paired Desktop assembly must work with the target Node. No production `engines.node` change occurs until all evidence is accepted.

The prototype must use the serializer supplied by checkpoint 1.1.5, test get/list/put/putWrites/deleteThread behavior and observe actual graph persistence calls. A transaction over unrelated test tables is insufficient. Transactions must not span provider execution or stream waits.

## Procedure and observed boundary

`sqlite-saver.mjs` implements the public checkpoint saver API using the dependency's serializer. The fixture ledger references the same task/namespace/checkpoint as LangGraph's `writes`. `putWrites` commits pending results and ledger rows together in a short transaction. LangGraph writes the aggregate snapshot through `put` later. Resume consumes committed pending writes, so it does not repeat those nodes even if the process never reaches the next snapshot. A wrapper around the provider call cannot simply assume ownership of both callbacks.

`sqlite-probe.mjs` starts a fresh Node child for each of 200 sequential boundaries in one real 200-node graph. Every child fsyncs a fault marker immediately before killing itself; POSIX acceptance requires `SIGKILL`, while Windows additionally checks its flushed marker and termination result. Each parent checks the exact durable frontier, its join to pending writes and execution count before allowing the next resume. Separate kills before the transaction and between pending-write/ledger statements prove rollback and one replay of uncommitted read work. The probe also checks typed serialization, namespace/history filtering, parent configuration, special-write replacement, ordinary-write deduplication and thread deletion.

## Local measurements (2026-09-26)

Environment: macOS arm64, Node 22.22.3, SQLite 3.51.3, LangGraph 1.4.14, checkpoint 1.1.5. The measured 200-boundary run retained exactly 200 completed nodes and 200 executions; pre-commit crashes left neither terminal evidence nor a durable result. WAL was active; database/directory modes were 0600/0700. An initial full probe measured mean `put` 0.301 ms over 202 calls (maximum 2.117 ms), below the 5 ms criterion. These are fixture measurements, not an engine performance promise; the JSON artifact records subsequent runs and source identity.

The executable fixture is excluded from TypeScript production compilation and the npm tarball. CI adds a real packed-package install/exercise on the same exact Node after the probes. This confirms current package compatibility; it does not claim a v2 engine has been shipped. Desktop assembly still needs separately attached evidence.

The paired Desktop smoke on Node 22.22.3 against the original Core `dist` also passed: 12 fixture calls; 120 tokens before approval, 24 tokens during the approval continuation and 0 on terminal resume. Missing billing remained unknown and host Git state remained immutable. This is evidence for the existing legacy Core/Desktop subprocess pairing; it is not evidence that a packaged or assembled v2 engine works.

## Decision and remaining gates

Prefer candidate A provisionally: it passes the local checkpoint API, durability and latency requirements without a native npm dependency. Do not raise `engines.node`, drop Node 20 or add a production saver yet. The proposed future engine minimum is `>=22.13.0` only if the remaining decision gate accepts A. Candidate B remains the fallback if a required platform, package or guarantee fails; no comparative performance claim is made without measuring it.

Linux x64 and Windows x64 CI artifacts, macOS CI confirmation, Desktop assembly and a Windows private-directory ACL policy remain required. POSIX mode bits on Windows do not prove access restrictions. The fixture ledger has no production leases, receipts, repeated visits, attempt identifiers or event sequence: C3 must design/test those before adopting this boundary. No transaction may remain open during provider work or asynchronous serialization. C1 is not complete solely because this local probe passes.
