# Engine architecture

A published definition is strict JSON with a canonical SHA-256 identity. Admission validates the schema, closed piece catalog, roles, outcomes, routing and verification policy before starting effects. The frozen request binds that identity, runtime configuration and repository scope for every continuation.

The compiler builds a real LangGraph graph, nested component graphs and Send-based map branches. NodeExecution owns the effect gate and AI semaphore; the durable ledger owns visit and physical-attempt identities. Pure validation, expressions and reducers do not initialize providers. Composition binds provider, filesystem, command, evidence and project-memory adapters.

SQLite uses WAL and synchronous FULL. The saver stores LangGraph checkpoints and pending writes alongside the engine ledger. Terminal step rows, response memo, usage and committed lifecycle events share transaction ownership. JSONL observers only project committed events; an observer failure cannot replay a billed call. A lease fences competing writers and stale owners. Its production TTL is 60 seconds with a 15-second heartbeat.

Read operations can overlap. Writers and verification share exclusive repository admission; nested coordinators release permits while descendants execute. The run-wide AI limit and local map limits both apply. Physical invocation reservations preserve unknown tokens and cost rather than converting missing provider values to zero. Retried and inherited invocations retain attribution and cannot be billed twice by projection.

Every write invalidates certification. Verification installs a receipt only for its bound candidate and full scope; success requiring verification checks that binding again. A component's success does not complete its parent. Delivery must inspect the terminal completion verdict, not infer success from a process exit or a completed child.

The project store is separate from each run ledger. Namespaces and declared piece access constrain reusable session metadata, review notes and known-command observations. Advisory memory failure must not repeat inference or skip verification. OpenTelemetry export is optional and observations never become execution authority.

The real CLI robustness harness uses a thirty-node provider-free graph, an external test preload and SIGKILL at admission, effect, pending-write and snapshot boundaries. It waits for the unmodified production lease TTL and requires explicit recovery for uncertain writes. Production code has no environment-controlled crash hook. CI repeats the harness against the installed npm package on Linux x64, macOS arm64 and Windows x64.
