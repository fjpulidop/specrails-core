## Why

The agent session journal (`~/.specrails/sessions/<scope>/sessions.sqlite`) stores every tool call's input and output verbatim. Agents routinely run `env`, `export TOKEN=...`, `curl -H "Authorization: Bearer ..."`, pass `--api-key` on command lines and read `.env` files, so provider keys, GitHub tokens and private keys end up in a long-lived local database and in the live event feed Desktop renders. External feedback (2026-10, Phase 4 task 4.1) flagged this. The file is private to the user, but a secret at rest in a display log is still a leak waiting for a backup, a support bundle or a screen share.

## What Changes

- **Redaction rules in `src/shared/secret-redaction.ts`.** `redactSecrets(text)`, `redactSecretsDeep(value)` and `isSecretName(name)`: secret-like key names (token, secret, password, passwd, passphrase, api key, access key, private key, credential, auth as a whole word, authorization, bearer, cookie, session token/secret/key/cookie) and inline patterns (`NAME=value`, `NAME: value`, JSON pairs, `Authorization:` headers, standalone `Bearer`, `--token`/`--api-key`/`--password` flags, URL passwords, `sk-`, `ghp_`, `github_pat_`, `glpat-`, `npm_`, Slack, AWS, Google keys, JWTs, PEM private key blocks). Bounded, linear-time, deterministic and idempotent. Every match becomes `[REDACTED]`.
- **Redaction at the journal boundary.** A pure `redactSessionEvent` / `redactSessionSnapshot` pair in the session domain redacts free text and tool I/O. `SqliteSessionJournal.append` (and the `MemoryJournal` double) folds the batch as produced, then stores, caches and returns redacted copies. The application already publishes the envelopes the journal returns, so the live feed, replay and storage are one redacted stream.
- **Redacted host snapshots.** `session.open` and `session.snapshot` redact the snapshot they return, including the in-memory snapshot of a live session.
- **Unchanged.** Event shapes, the protocol version, usage numbers, identifiers, input fingerprints, host configuration (`systemPrompt`, `session.updated.changes`, `policy`) and what the provider receives.
- **Docs.** `docs/agent-sessions/journal.md` (secret redaction section), `protocol.md`, the journal README and `SECURITY.md`.

## Non-goals

- Rewriting journals written by an older Core (documented; old sessions can be swept or the scope directory removed while no host runs). No `runtime sessions redact` CLI.
- Redacting the pipeline journal: `src/pipeline/pipeline-state.ts` keeps its own `redactRuntimeText`, because it is copied into projects and may only use Node built-ins.
- A contract change. The journal format is not declared in `integration-contract.json` (only its root path), redacted values are still strings, and Desktop needs no capability flag to render them.

## Capabilities

### New Capabilities
- `session-journal-redaction`: the session journal, its live feed and host snapshots never contain recognisable secrets from tool I/O or free text, without changing event shapes, usage or provider input.

### Modified Capabilities
<!-- None: Core has no canonical openspec/specs/ tree; the agent-session-runtime change specifies the journal. -->

## Impact

- Code: `src/shared/secret-redaction.ts` (new), `src/agent-runtime/session/domain/redaction.ts` (new), `journal/sqlite-journal.ts`, `testing/memory-journal.ts`, `host/server.ts`.
- Behaviour: delegated child sessions that receive the parent's recent conversation as context now receive the redacted text (the context is read from the journal). Hosts see `[REDACTED]` where a secret was.
- Desktop: no paired change required.
