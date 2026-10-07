# Session journal

Each scope (a project key or `global`) has one journal. Session state never
lives inside a repository.

```
~/.specrails/sessions/<scope>/sessions.sqlite
```

`SPECRAILS_REGISTRY_HOME` relocates `~`, the same way it does for the registry
and workspaces.

## What is stored

| Data | Purpose |
| --- | --- |
| Session records | Driver, working directory, host metadata (for example a conversation id) |
| Events | The append-only, gap-free sequence of every session; the source of truth |
| Snapshots | The folded state of each session, committed with its events (latest 100 turns and 500 finished inputs; `turnCount` counts all) |
| Usage baselines | The last cumulative provider totals per provider session, so per-turn usage stays correct across processes and `--resume` |
| Host lease | One live host per scope, fenced by an epoch |

## Guarantees

- **Atomic:** a batch of events, its snapshot and its baseline commit in one transaction, or not at all. A SIGKILL mid-write leaves no partial batch.
- **No replay:** an input is committed before it is written to the provider. If the host stops in between, the input is recorded as `interrupted`, never sent twice.
- **Interruptions are explicit:**
  - A restarted host marks running turns, inputs and sub-agents `interrupted`. The reason is `restart`, or `host_lost` when the previous owner died without releasing the lease.
  - Nothing is relaunched.
  - The next user input carries a one-time notice listing the affected work.
- **One owner:** a second host for the same scope fails with `journal_locked`. A host whose lease was taken over gets `host.leaseLost` and stops.
- **Schema evolution:** ordered, forward-only migrations. A journal written by a newer Core is refused (`store_incompatible`) and left untouched.
- **Private:** directory 0700 and file 0600 on POSIX; current-user ACLs on Windows.

## Retention

Closed sessions can be swept after a retention window; open sessions never
are. Hosts own the retention policy. The runtime exposes `sweepClosed`.

Implementation notes and tests:
[`src/agent-runtime/session/journal/README.md`](../../src/agent-runtime/session/journal/README.md).
