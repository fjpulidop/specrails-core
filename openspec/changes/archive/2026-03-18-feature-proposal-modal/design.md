---
id: feature-proposal-modal
title: Feature Proposal Modal — Technical Design
---

# Technical Design: Spec Proposal Modal

## Overview

This feature spans two repositories. Changes to `specrails` are limited to one new command template. All server, DB, and frontend work lives in `specrails-manager`.

---

## 1. specrails repo — Command Template

### 1.1 File: `templates/commands/propose-spec.md`

**Location:** `templates/commands/propose-spec.md` (NOT in `templates/commands/sr/` — that subdirectory is only for the generated output namespace, not the source templates).

**Purpose:** A Claude Code slash command that accepts a raw spec idea and produces a structured proposal document as markdown. This command is run by `QueueManager._resolveCommand()` — it is resolved from `.claude/commands/sr/propose-spec.md` in the target project. The `templates/commands/` files are what get installed into target repos via `install.sh`.

**Design constraints:**
- Must output **only** structured markdown — no free-form prose preamble
- Must instruct Claude to read the codebase before proposing (to ground proposals in reality)
- Must produce a predictable section structure that the frontend can display cleanly
- Uses `$ARGUMENTS` as the raw idea text from the user
- Should set expectations: this command proposes, it does not implement

**Required output sections (H2-level):**
```
## Feature Title
## Problem Statement
## Proposed Solution
## Out of Scope
## Acceptance Criteria
## Technical Considerations
## Estimated Complexity
```

**Template structure:**
```markdown
---
description: Explore a spec idea and produce a structured proposal
---

You are a senior product engineer helping to evaluate and structure a spec proposal.
The user's raw idea is: $ARGUMENTS

[Instructions for codebase exploration + structured output...]
```

---

## 2. specrails-manager — Server

### 2.1 DB Migration (Migration 5): `proposals` table

Added to `server/db.ts` as migration index 5 in the `MIGRATIONS` array.

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

**Status state machine:**
```
input → exploring → review → refining → created
                          ↘ cancelled
```

- `input`: proposal row created, not yet submitted
- `exploring`: initial Claude run in progress
- `review`: streaming done, awaiting user feedback or create action
- `refining`: refinement turn (--resume) in progress
- `created`: issue successfully created via `gh`
- `cancelled`: user cancelled at any point

**Status invariants:**
- Only `exploring` and `refining` have an active Claude process
- `result_markdown` is NULL until first `exploring` → `review` transition
- `issue_url` is NULL until `created` status

### 2.2 DB Public API additions (`server/db.ts`)

New functions alongside existing chat DB functions:

```typescript
// Proposal row type
export interface ProposalRow {
  id: string
  idea: string
  session_id: string | null
  status: string
  result_markdown: string | null
  issue_url: string | null
  created_at: string
  updated_at: string
}

// CRUD
export function createProposal(db: DbInstance, opts: { id: string; idea: string }): void
export function getProposal(db: DbInstance, id: string): ProposalRow | undefined
export function listProposals(db: DbInstance, opts?: { limit?: number; offset?: number }): ProposalRow[]
export function updateProposal(
  db: DbInstance,
  id: string,
  patch: {
    status?: string
    session_id?: string
    result_markdown?: string
    issue_url?: string
  }
): void
export function deleteProposal(db: DbInstance, id: string): void
```

### 2.3 ProposalManager class (`server/proposal-manager.ts`)

**New file.** Analogous to `ChatManager` — manages the Claude CLI subprocess lifecycle for proposals.

**Key design decisions:**

**Decision 1: Reuse `ChatManager` pattern, not `ChatManager` class.**
`ChatManager` is designed around persistent conversation threads with message history. Proposals have a different lifecycle: one initial run (`/sr:propose-spec`), zero or more refinement turns (`--resume`), and a terminal issue-creation run. Reusing `ChatManager` would require threading its `SYSTEM_PROMPT`, `autoTitle`, and conversation DB logic through the proposal flow. Instead, `ProposalManager` is a clean copy of the relevant spawn/stream/resume pattern with proposal-specific logic.

**Decision 2: Issue creation via a separate `--resume` turn.**
When the user clicks "Create Issue", the server sends a `--resume` turn with a standardised prompt:
```
Create a GitHub Issue based on the proposal above. Use label "user-proposed". Output only the issue URL on the final line.
```
This avoids a separate `gh issue create` shell invocation and keeps the Claude session context (the proposal content) available for the creation prompt. The `issue_url` is extracted from the final line of Claude's response via a regex (`https://github.com/.*/issues/\d+`).

**Decision 3: Process lifecycle isolation per proposal.**
Each proposal gets its own `ChildProcess` tracked in a `Map<proposalId, ChildProcess>`. There is no queuing — proposals are independent of the job queue. Multiple proposals can explore simultaneously (though the UI exposes only one modal at a time, the server supports concurrency).

**Class interface:**

```typescript
export class ProposalManager {
  constructor(broadcast: (msg: WsMessage) => void, db: DbInstance, cwd: string)

  isActive(proposalId: string): boolean
  async startExploration(proposalId: string, idea: string): Promise<void>
  async sendRefinement(proposalId: string, feedback: string): Promise<void>
  async createIssue(proposalId: string): Promise<void>
  cancel(proposalId: string): void
}
```

**Spawn pattern for `startExploration`:**
```typescript
const args = [
  '--dangerously-skip-permissions',
  '--output-format', 'stream-json',
  '--verbose',
  '-p', resolvedPrompt,  // /sr:propose-spec resolved to full content with idea substituted
]
spawn('claude', args, { cwd: project.path, ... })
```

**Spawn pattern for `sendRefinement`:**
```typescript
const args = [
  '--dangerously-skip-permissions',
  '--output-format', 'stream-json',
  '--verbose',
  '--resume', proposal.session_id,
  '-p', feedback,
]
```

**Stream handling:** identical to `ChatManager.sendMessage` — read stdout line-by-line, parse JSON, extract text from `assistant` events, accumulate buffer, broadcast `proposal_stream` deltas. On `result` event, capture `session_id`. On `close(0)`, transition status and broadcast `proposal_ready` or `proposal_refined` or `proposal_issue_created` as appropriate.

**Command resolution:** `ProposalManager` must resolve `/sr:propose-spec` to its full prompt content (same logic as `QueueManager._resolveCommand`). Extract this resolution logic into a shared utility in `server/command-resolver.ts` so both `QueueManager` and `ProposalManager` can use it without duplication.

### 2.4 Command resolver utility (`server/command-resolver.ts`)

**New file.** Extracted from `QueueManager._resolveCommand` (lines 233–270 of queue-manager.ts):

```typescript
export function resolveCommand(command: string, cwd: string): string
```

- Takes a slash command string and the project's working directory
- Returns the resolved prompt content (frontmatter stripped, `$ARGUMENTS` substituted)
- Falls back to pass-through if the command file is not found

`QueueManager._resolveCommand` is refactored to call this utility.

### 2.5 ProjectContext extension (`server/project-registry.ts`)

Add `proposalManager: ProposalManager` to `ProjectContext` interface and instantiate it in `_loadProjectContext`.

### 2.6 New WS message types (`server/types.ts`)

```typescript
export interface ProposalStreamMessage {
  type: 'proposal_stream'
  projectId: string
  proposalId: string
  delta: string
  timestamp: string
}

export interface ProposalReadyMessage {
  type: 'proposal_ready'
  projectId: string
  proposalId: string
  markdown: string
  timestamp: string
}

export interface ProposalRefinedMessage {
  type: 'proposal_refined'
  projectId: string
  proposalId: string
  markdown: string
  timestamp: string
}

export interface ProposalIssueCreatedMessage {
  type: 'proposal_issue_created'
  projectId: string
  proposalId: string
  issueUrl: string
  timestamp: string
}

export interface ProposalErrorMessage {
  type: 'proposal_error'
  projectId: string
  proposalId: string
  error: string
  timestamp: string
}
```

These are added to the `WsMessage` union type.

### 2.7 Proposal API routes (`server/project-router.ts`)

Three new routes added to the project router under the existing project middleware:

```
POST   /api/projects/:projectId/propose
POST   /api/projects/:projectId/propose/:id/refine
POST   /api/projects/:projectId/propose/:id/create-issue
DELETE /api/projects/:projectId/propose/:id
GET    /api/projects/:projectId/propose/:id
GET    /api/projects/:projectId/propose
```

**POST `/propose`**
- Body: `{ idea: string }`
- Creates a proposal row in DB (status: `input`), transitions to `exploring`, fires `startExploration` async
- Returns `202 { proposalId }`

**POST `/propose/:id/refine`**
- Body: `{ feedback: string }`
- Validates proposal exists and is in `review` status (409 if active)
- Transitions to `refining`, fires `sendRefinement` async
- Returns `202 { ok: true }`

**POST `/propose/:id/create-issue`**
- No body required
- Validates proposal is in `review` status
- Fires `createIssue` async
- Returns `202 { ok: true }`

**DELETE `/propose/:id`**
- Cancels active process if running, transitions to `cancelled`
- Returns `200 { ok: true }`

**GET `/propose/:id`**
- Returns full proposal row

**GET `/propose`**
- Returns list of proposals (latest first, limit 20)

**Error cases:**
- 404 if proposal not found
- 409 if proposal has an active process running (use `proposalManager.isActive(id)`)
- 400 if idea is empty
- 400 if feedback is empty

---

## 3. specrails-manager — Client

### 3.1 New hook: `useProposal.ts` (`client/src/hooks/useProposal.ts`)

Manages all proposal state for a single active proposal session.

**State shape:**
```typescript
interface ProposalState {
  proposalId: string | null
  status: 'idle' | 'exploring' | 'review' | 'refining' | 'created' | 'cancelled' | 'error'
  streamingText: string         // accumulates during exploring/refining
  resultMarkdown: string        // final markdown after exploration completes
  issueUrl: string | null
  errorMessage: string | null
}
```

**WebSocket subscriptions** (from `useSharedWebSocket`):
- `proposal_stream` → append delta to `streamingText` (filter by `proposalId` and `projectId`)
- `proposal_ready` → set `resultMarkdown = markdown`, clear `streamingText`, status → `review`
- `proposal_refined` → set `resultMarkdown = markdown`, clear `streamingText`, status → `review`
- `proposal_issue_created` → set `issueUrl`, status → `created`
- `proposal_error` → set `errorMessage`, status → `error`

**API calls:**
- `startProposal(idea)` → POST `/propose`, sets `proposalId`, status → `exploring`
- `sendRefinement(feedback)` → POST `/propose/:id/refine`, status → `refining`
- `createIssue()` → POST `/propose/:id/create-issue`, status stays `review` until WS confirms
- `cancel()` → DELETE `/propose/:id`, status → `cancelled`
- `reset()` → clears all state back to `idle`

**Project isolation:** all API calls use `getApiBase()` (which already resolves to `/api/projects/:projectId` in hub mode). WS messages are filtered by both `projectId` and `proposalId`.

### 3.2 New component: `SpecProposalModal.tsx` (`client/src/components/SpecProposalModal.tsx`)

A `Dialog`-based modal with distinct visual states matching the proposal lifecycle.

**Props:**
```typescript
interface SpecProposalModalProps {
  open: boolean
  onClose: () => void
}
```

**Visual states and their content:**

**`idle` (input step):**
- Large textarea: "Describe the spec you'd like to build..."
- Placeholder subtext: "Claude will read the codebase and structure your idea into a full proposal"
- "Explore Idea" button (primary, disabled when textarea empty)
- Cancel button

**`exploring` (streaming step):**
- Header: "Exploring your idea..."
- Streaming markdown render (same pattern as `SetupChat.tsx` — `ReactMarkdown` + `remarkGfm` + `MD_CLASSES` prose styling)
- Animated cursor at end of stream
- Bouncing dots when streaming but no text yet
- "Cancel" button (calls `cancel()`)
- The original idea text shown in a faded pill at the top for reference

**`review` (review step):**
- Full scrollable markdown render of `resultMarkdown` (not streaming)
- Two-column footer:
  - Left: feedback textarea ("Suggest refinements...") + "Refine" button
  - Right: "Create GitHub Issue" button (primary, green)
- "Start Over" button (ghost, resets to idle)
- "Cancel" button

**`refining` (refinement in progress):**
- Shows previous `resultMarkdown` faded in background
- Streaming overlay for new content
- "Cancel" button only

**`created` (success step):**
- Success icon + "Issue Created" heading
- Clickable issue URL (opens in new tab)
- "Propose Another" button (resets to idle)
- "Close" button

**`error` step:**
- Error message display
- "Try Again" button (resets to idle)
- "Close" button

**UX polish details:**
- Auto-focus textarea on modal open
- `Cmd+Enter` submits the idea textarea
- Scroll to top of markdown render when new result arrives
- Modal width: `max-w-3xl` (wider than ImplementWizard's `max-w-2xl` to accommodate proposal content)
- Streaming markdown uses identical prose classes as `SetupChat.tsx`
- On close: if status is `exploring` or `refining`, auto-cancel the active process before closing

**Accessibility:**
- `DialogTitle` always present (screen reader compatibility)
- Textarea has `aria-label`
- Disabled states are communicated via `disabled` attribute and visual opacity

### 3.3 Dashboard integration (`client/src/pages/DashboardPage.tsx`)

- Add `SpecProposalModal` import
- Add `proposalOpen` boolean state (alongside existing `wizardOpen`)
- Add a "Propose Spec" `PathCard`-style button in the Commands section (or as a standalone CTA if no commands are configured)
- Render `<SpecProposalModal open={proposalOpen} onClose={() => setProposalOpen(false)} />`

The "Propose Spec" button should be visually distinct from the command grid cards — it represents a different interaction model (conversational AI vs. job queue dispatch).

---

## 4. Cross-cutting Concerns

### 4.1 Process cleanup on cancel

When `ProposalManager.cancel(proposalId)` is called:
1. `treeKill(child.pid, 'SIGTERM')` — same as `ChatManager.abort`
2. `updateProposal(db, id, { status: 'cancelled' })`
3. Broadcast `proposal_error` with `error: 'cancelled'` so the client transitions cleanly

### 4.2 Server restart recovery

On `ProposalManager` construction (or on `ProjectRegistry._loadProjectContext`), orphan proposals in `exploring` or `refining` status should be swept to `cancelled` — analogous to the job orphan sweep in `initDb`. This sweep happens at startup, not at runtime.

Add to `initDb` migration or as a separate call in `project-registry.ts`:
```sql
UPDATE proposals SET status = 'cancelled', updated_at = datetime('now')
WHERE status IN ('exploring', 'refining')
```

### 4.3 Project isolation

`ProposalManager` is instantiated per `ProjectContext`, just like `ChatManager`. Each project's proposals live in that project's SQLite DB. The `cwd` passed to Claude CLI is `project.path`. All WS messages carry `projectId`. The frontend filters by `projectId` via the shared WebSocket handler.

### 4.4 Command template installation

`templates/commands/propose-spec.md` must be processed by `install.sh` and placed at `.claude/commands/sr/propose-spec.md` in the target project. The existing installation loop in `install.sh` already handles `templates/commands/sr/*.md` → `.claude/commands/sr/`. The new file goes at `templates/commands/propose-spec.md` but will be copied to `sr/` namespace during install.

Wait — this conflicts with the directory structure. Let me clarify:

- Source: `templates/commands/propose-spec.md` (no `sr/` subdir in templates)
- Installed to: `.claude/commands/sr/propose-spec.md` (with `sr/` namespace in target)

This matches how the issue states it: "Location: `templates/commands/propose-spec.md` in specrails repo (NO `sr/` subdirectory for templates)". The `install.sh` script maps `templates/commands/` content to `.claude/commands/sr/` — the template source directory is flat, the install target is namespaced. Verify this against `install.sh` install logic before implementing.

### 4.5 `gh` availability

`ProposalManager.createIssue` attempts to run Claude with `--resume` and a creation prompt that calls `gh issue create`. If `gh` is not authenticated in the project's environment, Claude will report the error in its output. The `ProposalManager` should detect non-zero exit codes and broadcast a `proposal_error`. The frontend should display a helpful message: "GitHub CLI not available or not authenticated in this project."

---

## 5. Architecture Diagram

```
User (Browser)
  │
  ├─ POST /api/projects/:id/propose          ──→ ProposalManager.startExploration()
  ├─ POST /api/projects/:id/propose/:id/refine ─→ ProposalManager.sendRefinement()
  ├─ POST /api/projects/:id/propose/:id/create-issue → ProposalManager.createIssue()
  └─ DELETE /api/projects/:id/propose/:id    ──→ ProposalManager.cancel()

ProposalManager
  ├─ spawn('claude', [..., '-p', resolvedPrompt], { cwd: project.path })
  ├─ Stream stdout → parse JSON → broadcast proposal_stream
  ├─ On close(0) → update DB → broadcast proposal_ready / proposal_issue_created
  └─ On close(non-0) → broadcast proposal_error

WebSocket (shared connection)
  ├─ proposal_stream → SpecProposalModal streaming render
  ├─ proposal_ready → transition to review state
  ├─ proposal_refined → update review state
  ├─ proposal_issue_created → transition to created state
  └─ proposal_error → transition to error state
```
