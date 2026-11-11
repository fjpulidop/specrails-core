## Context

Engine v2 runs host-authored definitions made of reviewed pieces. A paused run (exit 2) holds no process and no lease; `runtime resume` continues it from the last committed step. The only interrupts today are human (`approval`, `question`, `gate`). Desktop's PR CI loop (`factory:pr-ci`, paired change) must wait for GitHub, push commits and prepare base merges between AI turns, all host-owned effects.

Verified before the change:

- `candidateHash` is the content of tracked + untracked, non-ignored working-tree files (`candidateManifest`); it never reads HEAD. A host commit or push that keeps the tree leaves it unchanged; a prepared merge changes it like any edit.
- During a merge in progress `git ls-files --cached` lists an unmerged path once per stage; the manifest deduplicates it, so `MERGE_HEAD` does not confuse candidate measurement, and `role-turn` does not run git.
- `resume` does not compare the tree with the paused state: the candidate is re-measured lazily (`executionSnapshot`), and a write piece's terminal re-measures it.
- A `write` piece terminal without a receipt clears `$verified`; a `read` piece keeps it while the hash is unchanged.

## Goals / Non-Goals

Goals: a generic, typed machine interrupt; host results validated and redacted; resume idempotent (same result accepted twice, a different one refused); the definition keeps all loop logic.

Non-Goals: any GitHub/CI knowledge in Core; Core enforcing the host's wait timeout (no process exists while paused); new SQLite tables (interrupts already store `kind` and payload generically).

## Decisions

1. **Piece shape.** `host-task` params: `task` (`^[a-z0-9][a-z0-9.-]{0,63}$`), `input` (object, interpolated like every param), `outcomes` (1–8 unique outcome labels, never `failed`), `effect: read | write` (returned by `getEffect`), optional `timeoutMs` (host hint, copied to the request) and `requiresVerified`. `getOutcomes` = `[...outcomes, 'failed']`. `requiresAI: false`, `storeAccess: none`.
2. **Interrupt payload.** `{ kind: 'host-task', task, input, outcomes, effect, timeoutMs?, candidate: { hash, verified, receiptId? }, nodePath, scopeId, attemptId }`. The candidate attestation is measured by Core at interrupt time so the host never needs Core's fingerprint to know whether the tree it will commit is verified.
3. **`requiresVerified`.** When true and the current candidate is not verified, the piece ends with outcome `failed` (`unverified_candidate`) before interrupting. Desktop's `pr.sync` uses it, so only a verified candidate is ever pushed.
4. **Resume transport.** `--host-result <file>` (JSON `{ outcome, output? }`, ≤ 256 KiB) requires `--interrupt-id` of a pending `host-task`. Validation happens before the answer is persisted (`validateAnswers`) and again in the piece. Human flags against a `host-task` interrupt, and `--host-result` against a human one, are `invalid_resume`. Persisted answers are immutable (`answer_conflict`), so a repeated resume with the same result is a no-op and a different one is refused.
5. **Output.** `$outputs[node] = { task, outcome, result, candidateHash }` (hash measured on resume, after the effect, so definitions can detect a later role turn's progress) with `result` deep-redacted; one `$history` line `Host task <task>: <outcome>`. A host `failed` returns `status: 'failed'`, error `host_task_failed` with the redacted `output.detail`.
6. **Effect guidance.** A host task that only commits/pushes an unchanged tree should declare `effect: read` so verification survives; a task that changes the tree (merge preparation) declares `write`.

## Risks / Trade-offs

- A host that never answers leaves the run paused forever: hosts own the timeout (`timeoutMs` is the hint) and must resolve with a declared outcome or `failed`.
- Forks copy pending interrupts like any pause; the host re-dispatches by interrupt id, so handlers must be idempotent (documented in `desktop-integration.md`).
