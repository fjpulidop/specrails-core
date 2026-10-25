# Durable controls

`ControlInbox` appends cancellation, pause and operator messages through short SQLite transactions without acquiring the execution lease. Request IDs provide exact-payload idempotence. Messages contain at most 20,000 UTF-16 code units and 80,000 UTF-8 bytes; the pending queue permits 128 messages and 512 KiB total. Durable event sequence preserves receipt order even when timestamps are equal.

Admission claims pending steering in the same transaction that creates an eligible `prompt` or `role-turn` attempt. A rollback restores the queue. `appendSteering: false` leaves it untouched. Each physical attempt owns its assigned messages; human continuation reuses that attempt, while a new retry does not consume them again. Operator text is JSON-delimited under `## Operator steering` and cannot replace frozen acceptance requirements.

Cancellation is observed by the run owner and acknowledged under its fence after effects are stopped. Missing runs fail explicitly. New terminal controls are rejected; exact retries of previously accepted controls remain idempotent. Forks drop both consumed and pending controls.

A pause request (`kind 'pause'`, payload `{reason}`) is checked only at attempt admission, never before a later provider invocation of an admitted attempt, so in-flight work completes. The refused admission raises `paused`; the owner settles the run `paused`, records `workflow_paused {requestId, reason}`, consumes the request and releases its lease. An explicit resume consumes requests that arrived before it. The `'pause'` kind needs run database schema 2; `pauseRun` upgrades a schema 1 database of the same Core package in place.
