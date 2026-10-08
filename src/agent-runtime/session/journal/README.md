# Session journal

`SqliteSessionJournal` implements the `SessionJournal` port for one scope.

## What it owns

- **Location:** `~/.specrails/sessions/<scope>/sessions.sqlite`, where `<scope>` is a project key or `global`.
  - Resolved by `sessionsRoot()` in `src/shared/specrails-home.ts`, which honours `SPECRAILS_REGISTRY_HOME`.
  - The runtime never writes session state inside a repository.
- **Session records:** driver, working directory, host metadata.
- **Events:** the append-only, gap-free event sequence of every session.
- **Snapshot:** each session's folded snapshot, committed with its events.
- **Usage baselines:** the last cumulative provider totals per provider session reference.
- **Host lease:** one per scope.

## Invariants

- Every write runs in one `BEGIN IMMEDIATE` transaction that first asserts the host lease (owner + epoch, not expired). A replaced or expired owner gets `journal_locked`, and none of its writes become visible.
- `append` folds the batch with the domain reducer before inserting. An unfoldable batch rolls back entirely. Events, snapshot and optional baseline commit together.
- Sequences start at 1 and never skip. Readers page with `read(sessionId, afterSeq, limit)`.
- Provider I/O and observer delivery never run inside a transaction. The application publishes notifications only after `append` returns.
- Schema changes are ordered, forward-only migrations (`schema.ts`), one transaction each, tracked by `PRAGMA user_version`. A newer schema is refused with `store_incompatible` and the file is left untouched.
- Storage is private: directory 0700 and file 0600 on POSIX; current-user ACLs on Windows (`engine/storage/private-path.ts`).

## Bounds

- Snapshots keep the latest 100 turns and 500 terminal inputs; `turnCount` counts every turn. Every event stays readable through cursor replay.
- Turn and sub-agent output is coalesced and capped in the application, with an `output.truncated` event.
- `sweepClosed(olderThan)` removes closed sessions, cascading their events. Open sessions are never swept.

## Lease and crash semantics

- **Timing:** the lease lasts 60 s and renews every 15 s (`unref`'d timer).
- **Loss:** if renewal fails, `onLeaseLost` fires and the host must stop.
- **Reacquisition:** `open` reports how the previous owner left:
  - `released`: clean shutdown;
  - `lost`: the lease expired without release, for example after a SIGKILL;
  - `none`: first owner.
- **Recovery:** the host uses this to choose the reason when it marks left-over work interrupted (`restart` or `host_lost`).
- **Crashes:** a SIGKILL during a write leaves every batch either fully committed or absent. WAL with `synchronous=FULL` makes committed batches durable.

## Tests

- [`journal-contract.test.ts`](journal-contract.test.ts) runs one behavioural contract against both this adapter and the in-memory double that application tests use.
- [`sqlite-journal.test.ts`](sqlite-journal.test.ts) covers:
  - location and permissions;
  - reopen persistence;
  - single owner and stale-owner fencing;
  - renewal;
  - refusal of newer schemas;
  - retention;
  - unsafe scopes;
  - a real child process killed with SIGKILL mid-stream ([`__fixtures__/journal-crash-worker.mjs`](__fixtures__/journal-crash-worker.mjs)).

The crash test uses the compiled adapter. Run `npm run build` first; `npm test` does this, and the test is skipped when `dist/` is missing.
