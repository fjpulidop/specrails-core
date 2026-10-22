## 1. Redaction rules

- [x] 1.1 Add `src/shared/secret-redaction.ts` with `REDACTED`, `isSecretName`, `redactSecrets` and `redactSecretsDeep`: bounded patterns, `indexOf`-based PEM scan, idempotent.
- [x] 1.2 Unit tests (`secret-redaction.test.ts`): every pattern, names kept and redacted, multiple secrets in one string, ordinary words, idempotence, determinism, nested objects and arrays, depth bound, 1 MB adversarial inputs.

## 2. Journal boundary

- [x] 2.1 Add `session/domain/redaction.ts` with `redactSessionEvent` and `redactSessionSnapshot` (free text and tool I/O only; configuration, identifiers, usage and fingerprints untouched). Tests in `domain/redaction.test.ts`.
- [x] 2.2 `SqliteSessionJournal.append`: fold originals, persist/cache a redacted snapshot, insert and return redacted events. Same in `MemoryJournal`.
- [x] 2.3 Journal contract test (both adapters): stored, returned and replayed events and the snapshot are redacted; the fingerprint matches the original text.

## 3. Host

- [x] 3.1 `session.open` and `session.snapshot` return redacted snapshots.
- [x] 3.2 End-to-end host test on the SQLite runtime: live feed equals replay, snapshot redacted, provider receives the raw input, idempotent retry accepted, raw SQLite and WAL bytes free of the secret.

## 4. Docs and verification

- [x] 4.1 `docs/agent-sessions/journal.md` secret redaction section (rules, scope, trade-offs, existing journals), `protocol.md` note, journal README, `SECURITY.md`, `CLAUDE.md` layout line.
- [x] 4.2 `npm run ci`.
