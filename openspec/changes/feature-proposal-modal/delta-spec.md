---
id: feature-proposal-modal
title: Feature Proposal Modal — Delta Spec
---

# Delta Spec: Feature Proposal Modal

This document records all specification changes introduced by this feature. It is the diff against the current state of `openspec/specs/`.

---

## New: Command Template — `propose-feature`

**Spec path:** `openspec/specs/commands.md` (or equivalent command registry spec if it exists)

A new slash command `sr:propose-feature` is added to the specrails command library.

### Command specification

| Property | Value |
|----------|-------|
| Name | `propose-feature` |
| Namespace | `sr` |
| Template source | `templates/commands/propose-feature.md` |
| Installed path | `.claude/commands/sr/propose-feature.md` |
| Input | `$ARGUMENTS` — raw feature idea text |
| Output | Structured markdown proposal with 7 required sections |

**Required output sections (order-stable, H2-level):**
1. `## Feature Title`
2. `## Problem Statement`
3. `## Proposed Solution`
4. `## Out of Scope`
5. `## Acceptance Criteria`
6. `## Technical Considerations`
7. `## Estimated Complexity`

**Behavioral contract:**
- Reads the codebase (Glob/Grep/Read tools) before proposing
- Does NOT implement anything — exploration only
- Returns structured markdown, no preamble prose
- Terminates cleanly (no interactive prompts)

---

## New: DB Schema — `proposals` table (per-project SQLite)

**Spec path:** `openspec/specs/database.md` (or equivalent)

A new `proposals` table is added to the per-project SQLite database as Migration 5.

### Schema

```sql
CREATE TABLE IF NOT EXISTS proposals (
  id           TEXT    PRIMARY KEY,
  idea         TEXT    NOT NULL,
  session_id   TEXT,
  status       TEXT    NOT NULL DEFAULT 'input',
  result_markdown TEXT,
  issue_url    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at);
```

### Status state machine

```
input → exploring → review → refining → created
                          ↘ cancelled
any status → cancelled (via DELETE endpoint)
```

### Status invariants

| Status | Meaning | active process? | result_markdown | issue_url |
|--------|---------|-----------------|-----------------|-----------|
| `input` | row created | no | NULL | NULL |
| `exploring` | initial Claude run | yes | NULL | NULL |
| `review` | awaiting user action | no | set | NULL |
| `refining` | refinement turn | yes | set | NULL |
| `created` | issue exists | no | set | set |
| `cancelled` | user cancelled | no | any | NULL |

---

## New: API Surface — Proposal endpoints

**Spec path:** `openspec/specs/api.md` (or equivalent)

Six new endpoints under the project-scoped router:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/projects/:projectId/propose` | Start a new proposal exploration |
| `POST` | `/api/projects/:projectId/propose/:id/refine` | Send refinement feedback (resumes Claude session) |
| `POST` | `/api/projects/:projectId/propose/:id/create-issue` | Trigger GitHub Issue creation |
| `DELETE` | `/api/projects/:projectId/propose/:id` | Cancel and mark as cancelled |
| `GET` | `/api/projects/:projectId/propose/:id` | Fetch single proposal |
| `GET` | `/api/projects/:projectId/propose` | List proposals (latest first, limit 20) |

### Request / Response shapes

**POST `/propose`**
```
Request:  { idea: string }   (idea must be non-empty string)
Response: 202 { proposalId: string }
Errors:   400 if idea is missing/empty
```

**POST `/propose/:id/refine`**
```
Request:  { feedback: string }   (feedback must be non-empty)
Response: 202 { ok: true }
Errors:   404 if proposal not found
          409 if proposal has active process (proposalManager.isActive(id) === true)
          409 if proposal not in 'review' status
          400 if feedback is missing/empty
```

**POST `/propose/:id/create-issue`**
```
Request:  (empty body)
Response: 202 { ok: true }
Errors:   404 if proposal not found
          409 if proposal has active process
          409 if proposal not in 'review' status
```

**DELETE `/propose/:id`**
```
Response: 200 { ok: true }
Errors:   404 if proposal not found
```

**GET `/propose/:id`**
```
Response: 200 { proposal: ProposalRow }
Errors:   404 if not found
```

**GET `/propose`**
```
Query params: limit (default 20, max 100), offset (default 0)
Response: 200 { proposals: ProposalRow[], total: number }
```

---

## New: WebSocket Messages — Proposal events

**Spec path:** `openspec/specs/websocket.md` (or equivalent)

Five new message types added to the `WsMessage` union:

| Type | Trigger | Key fields |
|------|---------|------------|
| `proposal_stream` | Text delta from Claude during exploring/refining | `proposalId`, `delta` |
| `proposal_ready` | Initial exploration completed | `proposalId`, `markdown` |
| `proposal_refined` | Refinement turn completed | `proposalId`, `markdown` |
| `proposal_issue_created` | Issue created successfully | `proposalId`, `issueUrl` |
| `proposal_error` | Process failed or was cancelled | `proposalId`, `error` |

All messages carry `projectId` for multi-project filtering.

---

## Modified: `ProjectContext` interface

**File:** `server/project-registry.ts`

`proposalManager: ProposalManager` added to the `ProjectContext` interface.

---

## New: `ProposalManager` class contract

**File:** `server/proposal-manager.ts`

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(broadcast, db, cwd)` | Same signature as `ChatManager` |
| `isActive` | `(proposalId: string) => boolean` | True if a Claude process is running for this proposal |
| `startExploration` | `async (proposalId: string, idea: string) => void` | Spawn initial Claude run |
| `sendRefinement` | `async (proposalId: string, feedback: string) => void` | Resume session with feedback |
| `createIssue` | `async (proposalId: string) => void` | Resume session with issue creation prompt |
| `cancel` | `(proposalId: string) => void` | Kill active process, set status cancelled |

---

## New: `resolveCommand` utility contract

**File:** `server/command-resolver.ts`

```typescript
export function resolveCommand(command: string, cwd: string): string
```

Resolves `/namespace:command args` to full prompt content. Extracted from `QueueManager._resolveCommand`.

---

## New: Client component — `FeatureProposalModal`

**File:** `client/src/components/FeatureProposalModal.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Controls Dialog visibility |
| `onClose` | `() => void` | Called when user dismisses or completes |

Visual states: `idle`, `exploring`, `review`, `refining`, `created`, `error`.

---

## New: Client hook — `useProposal`

**File:** `client/src/hooks/useProposal.ts`

```typescript
function useProposal(projectId: string | null): {
  state: ProposalState
  startProposal: (idea: string) => Promise<void>
  sendRefinement: (feedback: string) => Promise<void>
  createIssue: () => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}
```

---

## Modified: `DashboardPage`

**File:** `client/src/pages/DashboardPage.tsx`

- Adds "Propose Feature" button/entry point
- Renders `<FeatureProposalModal>` conditional on `proposalOpen` state

---

## Modified: `WsMessage` union type

**File:** `server/types.ts`

Five new message interfaces added to the `WsMessage` union (see WebSocket Messages section above).
