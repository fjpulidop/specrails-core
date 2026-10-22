## Context

`ActiveSession.commit` builds events, folds them into its in-memory state, calls `journal.append`, and publishes the envelopes `append` returns. `SqliteSessionJournal.append` folds the batch into the persisted snapshot and inserts each event as JSON. Hosts read events live (`session.event`), by cursor (`session.events`) and as snapshots (`session.open`, `session.snapshot`; the latter returns the live in-memory state for an active session).

The snapshot keeps an input fingerprint (FNV-1a of the input text) and its length, used to accept an idempotent retry of the same `inputId`. A resumed session rebuilds its configuration (model, effort, `systemPrompt`, policy) from the persisted snapshot.

## Decisions

### Redact at the journal adapter, return the redacted envelopes
The adapter is the persistence boundary: every caller (active sessions, session open, recovery) goes through it. Returning redacted envelopes makes the published stream identical to the stored one, so live and replay never disagree. Alternative considered: redact in `ActiveSession.commit` before appending. Rejected because the fold would then fingerprint the redacted text and break idempotent retries, and because the redaction would be bypassed by other `append` callers.

### Fold originals, persist a redacted snapshot
The adapter folds the original events (fingerprints and lengths match the live session), then redacts the snapshot's free text (open turn text, sub-agent description, reason and result, closed reason) before storing and caching it. The next fold starts from the redacted snapshot, which only affects display text. Re-redaction is idempotent and a value glued to an earlier `[REDACTED]` (`TOKEN=[REDACTED]cdef`) is closed, so streamed text accumulated in the snapshot stays redacted.

### Do not redact configuration
`systemPrompt`, `session.updated.changes` and `policy` are host-supplied and read back from the snapshot to resume. Redacting them would change what the provider receives after a restart. They are not tool I/O.

### Redact host snapshots in the host server
`session.open` and `session.snapshot` wrap the returned snapshot in `redactSessionSnapshot`. The service keeps the raw in-memory state for internal use (delegation, recovery), so no behaviour depends on redacted text.

### Rules live in `src/shared`
`shared ← pipeline ← agent-runtime`: the shared helper is reachable from the session domain. `pipeline-state.ts` cannot import it (it is copied into projects, Node built-ins only), so its env-value redaction stays separate.

### Bounded patterns
All quantifiers have explicit upper bounds; no unbounded nested repetition. The assignment pattern only starts at a name boundary (negative look-behind) and refines the name with `isSecretName`. PEM blocks are found with `indexOf`, reusing the next END position, so a string full of BEGIN markers stays linear. Tests run each pattern on 1 MB adversarial inputs.

### Name heuristics
Names are split on camelCase, kebab-case, dots and underscores. `auth` must be a whole word (`author`, `authority`, `authenticate` are kept); `token` must not be followed by `s` or `iz` (`max_tokens`, `tokenizer` are kept). Bare `session`/`sessionId` are protocol identifiers and stay; `session_token|secret|key|cookie` are redacted. Values `true`, `false`, `null`, `undefined`, type names and `$VAR` references are kept after a secret-like name.

## Risks / Trade-offs

- Over-redaction of code (`token = readToken()` → `token = [REDACTED]()`): accepted, the journal is a display log.
- A secret split across two streamed deltas can leak the tail in the event stream; `turn.completed.text` and the snapshot are redacted whole. Output is coalesced (50 ms) so splits are rare.
- Unknown formats and short flags (`-pSECRET`) are not detected; the rules are best effort, documented in `SECURITY.md`.
- Existing journals keep their unredacted events.

## Contract

No change. `integration-contract.json` declares the journal root, not its content, and redacted values keep their types. Open PRs #435–#438 bump `schemaVersion`; this change does not, so there is nothing to rebase.
