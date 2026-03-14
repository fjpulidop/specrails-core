---
change: agent-failure-learning
type: delta-spec
---

# Delta Spec: Agent Post-Mortem & Failure Learning Loop

This document describes the spec-level changes this feature introduces. It defines what the system SHALL do after this change is applied.

---

## 1. New Capability: Failure Record Store

**Spec statement:** The specrails agent system SHALL maintain a shared failure record store at `.claude/agent-memory/failures/`.

### 1.1 Store structure

The failure store:
- Is a directory at `.claude/agent-memory/failures/`
- Contains one JSON file per recorded failure class
- Contains a `README.md` documenting the JSON schema
- MAY be empty (fresh install or zero-failure history)
- MUST NOT require any external tool or script to read or write

### 1.2 Failure record schema

Each failure record MUST be a valid JSON file with the following fields:

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `agent` | string | yes | Always `"reviewer"` |
| `timestamp` | string | yes | ISO 8601 UTC |
| `feature` | string | yes | Kebab-case OpenSpec change name |
| `error_type` | string | yes | Kebab-case from canonical list, or a new kebab-case value |
| `root_cause` | string | yes | Concrete description; specific file/line if known |
| `file_pattern` | string | yes | Glob pattern (e.g., `"*.sh"`, `"templates/agents/*.md"`) |
| `prevention_rule` | string | yes | Actionable imperative ("Always...", "Never...") |
| `severity` | string | yes | `"error"` or `"warning"` |

### 1.3 Filename convention

Failure record filenames MUST follow this pattern:
```
<YYYY-MM-DD>-<error-type-slug>.json
```

Where `<error-type-slug>` is the value of the `error_type` field. The date prefix ensures records sort by recency in directory listings.

---

## 2. Modified Capability: Reviewer Agent

**Spec statement:** After completing a review session, the reviewer agent SHALL write failure records to the failure store for each distinct failure class it corrected.

### 2.1 Trigger condition

The reviewer MUST write a failure record when it:
- Fixed a CI check failure
- Fixed a lint error
- Fixed a test failure
- Fixed an unresolved placeholder in a generated file
- Fixed a shell script quoting, escaping, or flag error

The reviewer MUST NOT write a record when:
- All CI checks passed on first run (no fixes were required)
- The failure was a transient environment issue (network timeout, missing tool, etc.) rather than a code issue

### 2.2 One record per failure class

The reviewer MUST write one record per distinct failure class per review session. If ten instances of the same lint error appear in different files, one record is written, not ten. The `root_cause` field describes the pattern; the `prevention_rule` covers the class.

### 2.3 Idempotency

Before writing a new record, the reviewer MUST scan `.claude/agent-memory/failures/` for an existing file where `error_type` matches and the `prevention_rule` is substantively identical. If found, the reviewer MUST skip writing a new record.

### 2.4 Ordering

Failure records are written after the review report is produced (post-workflow). They do not block or delay the reviewer's output.

---

## 3. Modified Capability: Developer Agent

**Spec statement:** During Phase 1 (Understand), the developer agent SHALL read recent failure records from the failure store and use matching records as guardrails in its implementation.

### 3.1 Reading protocol

At the start of Phase 1, the developer MUST:
1. Check whether `.claude/agent-memory/failures/` exists and contains any JSON files.
2. If yes: read the records and identify those where `file_pattern` matches files it will be creating or modifying.
3. For each matching record: treat the `prevention_rule` as an explicit guardrail in its implementation plan.
4. If the directory does not exist or is empty: proceed normally with no behavior change.

### 3.2 Matching logic

The developer uses contextual judgment to match `file_pattern` values against its expected file set. It is not required to perform strict glob expansion — it reads the patterns and applies reasonable matching based on file names and extensions.

### 3.3 Non-blocking

The failure-record reading step MUST NOT block implementation if the store is unavailable, empty, or cannot be read. It is advisory context, not a gate.

---

## 4. New Artifact: Failure Store README

**Spec statement:** `.claude/agent-memory/failures/README.md` SHALL exist and document the failure record JSON schema for human and agent reference.

### 4.1 Required content

The README MUST include:
- The full JSON schema with all field names, types, and descriptions
- The canonical `error_type` value list
- The filename convention
- A note that the store is written by the reviewer and read by the developer

---

## 5. Backward Compatibility

**Spec statement:** Repos with no failure records (fresh installs or zero-failure history) SHALL behave identically to the pre-change state. No new required configuration, no new environment variables, and no pipeline phase changes.

The only observable change in a zero-failure-history repo is the presence of `.claude/agent-memory/failures/README.md`.
