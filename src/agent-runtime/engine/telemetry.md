# Optional trace export

Set `SPECRAILS_OTEL_ENDPOINT=http://127.0.0.1:4318` to enable OTLP/HTTP JSON export. A `/v1/traces` suffix is appended unless supplied already. The adapter follows [OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding): hexadecimal trace/span IDs, numeric enums and decimal-string nanosecond timestamps.

Every committed lifecycle event becomes a point span with stable run/sequence identity. These spans describe durable history; their zero duration is not an estimate of provider execution time. Only run/node/scope/branch/attempt identifiers and event metadata leave the process. Prompts, responses, operator messages and raw errors remain local. Transient progress never manufactures committed lifecycle spans.

Export is disabled without the environment variable. A bounded queue holds at most 512 pending spans plus one batch of 64 in flight. Requests time out after three seconds; collector responses are limited to 64 KiB. Queue overflow and collector errors are observational and cannot change workflow results or replay provider calls. Export is best effort and does not claim exactly-once remote delivery; stable IDs let a collector identify repeats. The run owner flushes and closes the observer at shutdown.

`otel.test.ts` exercises a real local HTTP collector, payload privacy, duplicate IDs, disabled configuration, queue overflow and failure isolation.
