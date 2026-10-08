# Session host

`SessionHost` serves the [session protocol](../../../../docs/agent-sessions/protocol.md):
JSON-RPC 2.0 over NDJSON stdio. Only `agent-runtime/cli.ts` (`runtime host`)
constructs it, which the architecture test enforces.

## What it owns

- **Framing:** a 2 MiB line limit. A malformed or oversized request gets an error, and the host keeps serving.
- **Method table:** one handler per method, in a closed table. Each handler validates params against a closed schema in `protocol.ts` and calls exactly one `SessionService` use case.
- **Error mapping:** domain `SessionError` codes go to `data.code`/`data.retryable`; schema violations to `-32602`; unknown methods to `-32601`.
- **Output:**
  - Responses go before notifications and are never dropped.
  - Notifications carry committed events only.
  - Writes honour stream backpressure.
  - When the queue exceeds its bound, the busiest session's queued notifications are dropped after a `session.lagged { sessionId, deliveredSeq }` notice. The journal keeps every event, so clients catch up with `session.events`.
- **Lifecycle:**
  - Requests are refused until `initialize`.
  - `host.shutdown`, a closed stdin or SIGINT/SIGTERM retire providers, record interruptions, release the journal lease and resolve `done`.
  - A lost lease sends `host.leaseLost` and stops.

## Tests

[`server.test.ts`](server.test.ts) covers:

- the in-process protocol: handshake, error mapping, gap-free notifications equal to journal replay, lag shedding, shutdown, input close and lease loss;
- a smoke test of the compiled binary (`npm run build` first) that runs initialize, list and shutdown over real stdio.
