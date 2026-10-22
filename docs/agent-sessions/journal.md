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
- **Redacted:** secrets in tool I/O and free text are replaced with `[REDACTED]` before they are stored (see below).

## Secret redaction

Tool calls routinely carry credentials: environment dumps, `export TOKEN=...`,
`Authorization` headers, API keys on command lines, `.env` reads. The journal
redacts them before anything is persisted.

**Where it applies.** The journal adapter (`journal/sqlite-journal.ts`) folds
each batch as produced and then stores, returns and replays redacted copies.
Because the application publishes the envelopes the journal returns, the live
`session.event` feed, `session.events` replay and the stored events are the same
redacted stream. `session.open` and `session.snapshot` redact the snapshot they
return, including the in-memory snapshot of a live session. What the provider
receives is never changed: input is delivered as the host sent it.

**What is redacted.** Free text and tool I/O: `input.accepted.text`,
`turn.output.delta`, `turn.tool.input`/`output`, `turn.completed.text`/`error`,
`subagent.started.description`/`prompt`, `subagent.output.delta`/`tool`,
`subagent.result.summary`, `reason` fields and `provider.diagnostic.message`;
in snapshots, the open turn text and sub-agent descriptions, reasons and
results. Every redacted value becomes `[REDACTED]`; shapes, identifiers,
sequence numbers and usage numbers are unchanged, and the protocol version
stays 1.

**What is not redacted.** Host-supplied configuration (`systemPrompt`,
`session.updated.changes`, `policy`) and session metadata: a resumed session
reads its configuration back from the snapshot, so changing it would change
what the provider receives. Input fingerprints are computed from the text as
sent, so an idempotent retry of the same input still matches.

**Rules** (`src/shared/secret-redaction.ts`):

- Object keys whose name is secret-like have their string values replaced at
  any depth (for example `env.GITHUB_TOKEN`, `headers.Authorization`,
  `credentials.*`). Numbers, booleans and null are kept.
- Secret-like names contain `token`, `secret`, `password`/`passwd`,
  `passphrase`, `api_key`, `access_key`, `private_key`, `credential`, `auth` as
  a whole word, `authorization`, `bearer`, `cookie`, or
  `session_token`/`session_secret`/`session_key`/`session_cookie`. CamelCase,
  kebab-case and dotted names are split into words first.
- In strings: `NAME=value`, `NAME: value` and `"name": "value"` for those names;
  `Authorization: <scheme> <value>` (the scheme is kept); a standalone
  `Bearer <token>` of 16 or more characters; `--token v`, `--api-key=v`,
  `--password "v"` and other flags whose name ends with a secret word;
  `scheme://user:password@host`; well-known formats (`sk-…`, `ghp_`/`gho_`/
  `ghu_`/`ghs_`/`ghr_…`, `github_pat_…`, `glpat-…`, `npm_…`, `xox[abeoprs]-…`,
  `xapp-…`, `AKIA…`/`ASIA…`, `AIza…`, JSON Web Tokens) and
  `-----BEGIN … PRIVATE KEY-----` blocks, including a truncated block without
  its END line.

**Trade-offs.** The rules prefer redacting too much over leaking: a value after
a secret-like name is replaced even when it is code (`token = readToken()`
shows `token = [REDACTED]()`). Ordinary words are kept: `author`, `authority`,
`authenticate`, `max_tokens`, `tokenizer`, bare `session`/`sessionId`, values
such as `true`, `null` or `string`, and `$VARIABLE` references. Known gaps: a
secret split across two streamed output deltas can leak the part after the
split (the final `turn.completed.text` and the snapshot are redacted whole);
short flags such as `mysql -pSECRET` and secrets with no recognisable name or
format are not detected.

**Cost.** Every pattern is bounded and linear in the input length; PEM blocks
are located with `indexOf`. A 1 MB adversarial string redacts in milliseconds.

**Existing journals are not rewritten.** Events stored by an older Core stay as
they were. Remove old sessions with `sweepClosed`, or delete
`~/.specrails/sessions/<scope>/` while no host is running.

## Retention

Closed sessions can be swept after a retention window; open sessions never
are. Hosts own the retention policy. The runtime exposes `sweepClosed`.

Implementation notes and tests:
[`src/agent-runtime/session/journal/README.md`](../../src/agent-runtime/session/journal/README.md).
