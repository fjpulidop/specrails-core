## ADDED Requirements

### Requirement: Secrets are redacted before the session journal persists events
The session journal SHALL replace recognisable secrets in free text and tool I/O with `[REDACTED]` before it stores events or snapshots. The rules cover secret-like key names and assignments, authorization headers, credential flags, URL passwords, well-known key formats and PEM private key blocks (docs/agent-sessions/journal.md).

#### Scenario: Tool input with an environment object
- **WHEN** a `turn.tool` event carries `input: { env: { GITHUB_TOKEN: "ghp_…", HOME: "/home/me" } }`
- **THEN** the stored event MUST carry `env.GITHUB_TOKEN = "[REDACTED]"` and `env.HOME = "/home/me"`

#### Scenario: Tool output with several secrets
- **WHEN** a tool output contains `export SECRET=…`, an `Authorization: Bearer …` header and a private key block
- **THEN** every secret MUST be replaced with `[REDACTED]`, the header scheme MUST be kept and the surrounding text MUST be unchanged

#### Scenario: Ordinary words
- **WHEN** text contains `author`, `authority`, `max_tokens: 4096`, `tokenizer` or `sessionId=abc`
- **THEN** the text MUST be stored unchanged

#### Scenario: Raw database bytes
- **WHEN** a session journals a secret in input, tool I/O, output and completion text
- **THEN** neither the SQLite file nor its WAL MUST contain the secret

### Requirement: Live, replayed and snapshot views carry the same redacted text
The envelopes returned by `append` SHALL be the redacted ones, so `session.event` notifications equal `session.events` replay, and `session.open` and `session.snapshot` SHALL return redacted snapshots, including for live sessions.

#### Scenario: Live feed equals replay
- **WHEN** a host receives `session.event` notifications for events with secrets and then replays them with `session.events`
- **THEN** both MUST be equal and contain `[REDACTED]` instead of the secrets

### Requirement: Redaction does not change behaviour
Redaction SHALL NOT change event shapes, the protocol version, identifiers, usage numbers, host configuration (`systemPrompt`, `session.updated.changes`, `policy`), input fingerprints, or the text delivered to the provider.

#### Scenario: Provider input and retries
- **WHEN** a host sends input containing a secret and later retries the same `inputId` with the same text
- **THEN** the provider MUST receive the original text
- **AND** the retry MUST be accepted as idempotent

#### Scenario: Usage is preserved
- **WHEN** a `turn.completed` or `subagent.usage` event is journaled
- **THEN** its usage values MUST be stored unchanged

### Requirement: Redaction is bounded and deterministic
Redaction SHALL run in time linear in the input length with bounded patterns, and SHALL be deterministic and idempotent.

#### Scenario: Adversarial input
- **WHEN** a 1 MB string of repeated markers (`token="`, `--token `, `-----BEGIN PRIVATE KEY-----`, `sk-`) is redacted
- **THEN** redaction MUST complete within the test budget

#### Scenario: Existing journals
- **WHEN** a journal written by an older Core is opened
- **THEN** its stored events MUST be left as they are
