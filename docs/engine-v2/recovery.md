# Recovery, forks and steering

Always inspect the retained original runtime. `runtime status --context context.json --compact` is read-only: it reports the lease, pending interrupts, recoverable attempts, completion, workflow identity, usage and committed event cursor without opening a provider.

A paused run normally has no lease. Answer a question with `runtime resume --context context.json --answer 'the answer'`; select an interrupt with `--interrupt-id` when necessary. Approvals use `--approve` with the saved node path. Resume uses frozen inputs and rejects replacement definitions or configuration.

An active lease blocks competing execution. After a crash, wait until the lease expires. Expiry alone does not authorize repeating an uncertain write: inspect `state.recoverableSteps`, review the worktree and pass the exact returned `attemptId` to `--recover`. Already committed effects are reused. Explicit recovery may repeat an effect whose external result was not committed; the engine does not claim exactly-once external shell or provider side effects in that uncertainty window.

Fork with `runtime fork --context context.json --from nodePath --run-id new-run`. Use `--scope-id` and `--visit` to select ambiguous historical cuts. The source must be inactive and remains unchanged. The child inherits committed history and usage, but not active controls or provider sessions. `--state patch.json` applies an allowed state patch only to the child and invalidates affected certification. Forking before a question creates an inactive running child with no pending question yet; its first resume executes that question and pauses. A fork is not a repository rollback: Desktop owns worktree scope and retained runtime linkage.

`runtime cancel --context context.json --request-id stable-id` appends a durable cancellation request without taking the execution lease. The owner stops descendants and settles cancellation. A host may kill a nonresponsive process after its grace period, but must then inspect durable status and recovery requirements. On Windows, forced process termination is not POSIX SIGTERM; use the cooperative cancel command for portable behavior.

Send operator instructions over stdin:

```sh
printf '%s' 'Keep the existing acceptance tests intact' | specrails-core runtime signal --context context.json --stdin --request-id operator-001
```

Core returns `runtime-signal-accepted` with `id` and the durable `acceptedAt`. Reusing the same id and text is idempotent; changing text under an existing id is a conflict. New controls are rejected for terminal runs. Messages are limited to 20,000 UTF-16 characters and 80,000 UTF-8 bytes; the pending inbox also has count and byte limits.

Acceptance is not consumption. The next eligible prompt or role attempt claims pending messages in its admission transaction. Status exposes `state.steering` with bounded previews, total pending/consumed counts, a truncation flag and the consuming attempt/time. At most 512 receipts are returned, with pending receipts prioritized; a preview contains at most 240 characters. Retrying an uncertain HTTP response should reuse the same id. An older retained runtime without consumption reporting cannot prove that a message was consumed.
