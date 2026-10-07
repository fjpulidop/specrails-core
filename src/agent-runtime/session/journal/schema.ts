/**
 * Ordered, forward-only migrations for the long-lived per-scope journal.
 * `PRAGMA user_version` equals the number of applied migrations. Never edit or
 * reorder a shipped entry; append a new one. Unknown future versions are refused.
 */
export const JOURNAL_MIGRATIONS: readonly string[] = Object.freeze([
  // 1 — sessions, events, usage baselines, host lease
  `
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    driver TEXT NOT NULL,
    cwd TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','closed')),
    last_seq INTEGER NOT NULL DEFAULT 0,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL);
  CREATE TABLE events (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(session_id, seq)) WITHOUT ROWID;
  CREATE TABLE usage_baselines (
    provider_ref TEXT PRIMARY KEY,
    baseline_json TEXT NOT NULL,
    updated_at TEXT NOT NULL);
  CREATE TABLE host_lease (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    owner TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL);
  CREATE TABLE lease_epoch (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    epoch INTEGER NOT NULL);
  INSERT INTO lease_epoch(singleton, epoch) VALUES (1, 0);
  CREATE INDEX sessions_status ON sessions(status, updated_at);
  `,
])

export const JOURNAL_SCHEMA_VERSION = JOURNAL_MIGRATIONS.length
