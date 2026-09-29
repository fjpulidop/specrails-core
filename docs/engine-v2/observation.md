# Observation and trace correlation

Committed `workflow-event` JSONL records carry a stable `traceId` for the run and
`spanId` for that durable event's sequence. Replaying the same event preserves
both identifiers. Scope, node path and attempt identity remain separate fields;
parallel branches are never correlated by node name alone. Desktop shows recorded
identifiers when you select an attempt in the runtime graph.

Optional OTLP/HTTP export uses those exact identifiers. Set
`SPECRAILS_OTEL_ENDPOINT` in the Core process environment to an HTTP(S) collector
base URL, for example `http://127.0.0.1:4318`. Core appends `/v1/traces` unless
already present. Without the variable there is no export. Credentials, query
strings and URL fragments are rejected; redirects are not followed. Configure
any authenticated forwarding outside this adapter.

Exported spans are **point events in durable history**, with equal start/end
timestamps. They do not measure provider duration. They include run, event,
sequence, node, scope, attempt and branch metadata, not prompts, responses or
other piece payloads. Treat repository-supplied node names as metadata that may
still be sensitive when choosing a collector.

The default queue holds 512 events, sends batches of up to 64, and flushes after
one second or on shutdown. Requests time out after three seconds. Collector
failures, partial rejection and queue overflow are diagnostic failures; they do
not roll back committed work, repeat provider calls or pause the run. Export is
best effort. An identifier in Desktop proves correlation, not that a collector
received the span. Historical runs without recorded identifiers remain without
identifiers in the UI.

`engine/otel.test.ts` runs a local HTTP collector and compares its received IDs
with the JSONL projection, including duplicate-event suppression and bounded
failure handling. No paid provider or external collector is required.

## Offline evaluation

Reference definitions are evaluated offline with
`node scripts/evaluate-definition-corpus.mjs <implementation|implementation-component> <output>`.
The script runs full and optimized modes over the accepted corpus. The paid
`runtime evaluate --real` mode is opt-in, with an explicit model and budget; see
[Reproducible evaluation](../agent-runtime.md#reproducible-evaluation). Offline
acceptance does not establish monetary savings or quality.
