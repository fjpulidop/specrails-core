# Desktop integration contract

Desktop owns worktrees, project settings, process admission, HTTP/UI controls, ticket ownership and PR delivery. Core executes one frozen definition in one retained runtime process, including nested graphs. Hosts must not independently traverse the same definition or infer completion from a child step.

Before launch, resolve the actual provider and role configuration, validate with that configuration, retain the exact Core package, and persist context, host environment, definition, configuration and selection provenance. Structural authoring validation defers role binding; it does not authorize execution. A continued or forked run uses its original package and frozen inputs even after an installation update.

Consume committed JSONL events using their run identity and monotonic sequence. Store the projection cursor atomically with each projected event and physical invocation accounting; reject a repeated identity with changed content. Keep provider null/missing usage distinct from zero and do not add the terminal aggregate to already-recorded physical calls. Imported fork history does not become new billed usage.

On restart, use retained `runtime status --compact` before orphan settlement or worktree cleanup. `state.lease.expiresAt` is epoch milliseconds; `active` is Core's observation. A paused run has no executor lease. Unavailable status is an inspection failure, not evidence of failed work. Persist pending interrupts, exact recoverable attempt identities, Core revision and event cursor for explicit continuation. A successful Core run may still need Desktop's delivery settlement.

Delivery requires a succeeded terminal result, `completion.ok`, and verified scope whenever the workflow wrote to the repository. A successful process or an unverified child cannot authorize a PR. Settlement and ticket/outbox effects must remain idempotent across restart and reattachment.

The host's per-project execution claims additionally prevent a parent and fork from concurrently modifying their shared worktree. Core's per-run lease alone cannot fence two different run databases over one checkout. Release claims while waiting for a human, reacquire before continuation, and preserve an actually live Core owner during restart inspection.

Use the durable steering inbox for operator instructions. See [recovery and steering](recovery.md) for accepted-versus-consumed semantics. Package metadata advertises capabilities; hosts must capability-gate authoring and launching while retaining the older engine for its historical runs. Legacy retirement requires measured migration parity and the agreed real-release telemetry gate, not guessed usage or fabricated rollout evidence.
