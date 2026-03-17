---
id: feature-proposal-modal
title: Feature Proposal Modal — Task Breakdown
---

# Task Breakdown: Feature Proposal Modal

Tasks are ordered by dependency. Each task specifies its layer tag, files involved, and acceptance criteria.

---

## T1 — Add `propose-feature` command template [specrails]

**Layer:** `[specrails]`

**Description:**
Create the `/sr:propose-feature` Claude Code command template. This is the prompt that drives the initial exploration. It must instruct Claude to read the codebase first, then produce a structured proposal with exactly seven H2 sections.

**Files:**
- Create: `/Users/javi/repos/specrails/templates/commands/propose-feature.md`

**Template structure:**
```markdown
---
description: Explore a feature idea and produce a structured proposal
---

You are a senior product engineer helping evaluate and structure a feature proposal for this codebase.

The user's raw idea is:

$ARGUMENTS

## Your Task

Before proposing anything, explore the codebase to understand:
1. What already exists that relates to this idea
2. What the current architecture looks like in the relevant area
3. What constraints or patterns you must respect

Use Read, Glob, and Grep to explore. Take at least 3 codebase reads before writing the proposal.

## Required Output

Output ONLY the following structured markdown. Do not add any preamble or explanation outside these sections.

## Feature Title
[A concise, action-oriented title, e.g., "Add Real-Time Cost Alerts"]

## Problem Statement
[2-3 sentences: what problem does this solve? Who experiences it? What is the current workaround?]

## Proposed Solution
[3-5 sentences: what exactly will be built? Be specific about the UI, API, and data changes.]

## Out of Scope
[Bullet list of things this proposal deliberately does NOT cover]

## Acceptance Criteria
[Numbered list of testable outcomes. Each criterion must be independently verifiable.]

## Technical Considerations
[Bullet list of implementation notes, constraints from the existing architecture, risks, and dependencies]

## Estimated Complexity
[One of: Low (< 1 day) / Medium (1-3 days) / High (3-7 days) / Very High (> 1 week)]
[One sentence justifying the estimate]
```

**Acceptance criteria:**
- File exists at `templates/commands/propose-feature.md`
- Has YAML frontmatter with `description` field
- Uses `$ARGUMENTS` exactly once (the raw idea placeholder)
- Output sections are H2-level and match the seven required names exactly
- Instructs codebase exploration before proposing
- No interactive prompts or user-confirmation steps in the instructions

**Dependencies:** none

---

## T2 — Add DB migration for `proposals` table [manager-server]

**Layer:** `[manager-server]`

**Description:**
Add Migration 5 to `server/db.ts`. The `proposals` table tracks proposal lifecycle state per-project. Add the `ProposalRow` TypeScript interface to `server/types.ts`.

**Files:**
- Modify: `/Users/javi/repos/specrails-manager/server/db.ts`
- Modify: `/Users/javi/repos/specrails-manager/server/types.ts`

**Changes to `db.ts`:**
1. Add `ProposalRow` interface (exported):
   ```typescript
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
   ```
2. Append Migration 5 to the `MIGRATIONS` array:
   ```typescript
   // Migration 5: proposals table
   (db) => {
     db.exec(`
       CREATE TABLE IF NOT EXISTS proposals (
         id              TEXT    PRIMARY KEY,
         idea            TEXT    NOT NULL,
         session_id      TEXT,
         status          TEXT    NOT NULL DEFAULT 'input',
         result_markdown TEXT,
         issue_url       TEXT,
         created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
         updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
       );
       CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
       CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at);
     `)
   },
   ```
3. Add orphan sweep for proposals at the end of `initDb`:
   ```typescript
   db.prepare(
     "UPDATE proposals SET status = 'cancelled', updated_at = ? WHERE status IN ('exploring', 'refining')"
   ).run(new Date().toISOString())
   ```

4. Add CRUD functions at the bottom of `db.ts`:
   ```typescript
   export function createProposal(db: DbInstance, opts: { id: string; idea: string }): void
   export function getProposal(db: DbInstance, id: string): ProposalRow | undefined
   export function listProposals(db: DbInstance, opts?: { limit?: number; offset?: number }): { proposals: ProposalRow[]; total: number }
   export function updateProposal(db: DbInstance, id: string, patch: { status?: string; session_id?: string; result_markdown?: string; issue_url?: string }): void
   export function deleteProposal(db: DbInstance, id: string): void
   ```

**Changes to `types.ts`:**
- Import and re-export `ProposalRow` from `./db`

**Acceptance criteria:**
- `initDb(':memory:')` creates the `proposals` table with all columns
- `createProposal` + `getProposal` round-trip correctly
- `updateProposal` updates `updated_at` automatically
- `listProposals` returns rows ordered by `created_at DESC`
- Orphan sweep sets `exploring` and `refining` proposals to `cancelled` on DB init
- Migration is idempotent (`CREATE TABLE IF NOT EXISTS`)

**Dependencies:** none

---

## T3 — Extract `resolveCommand` utility [manager-server]

**Layer:** `[manager-server]`

**Description:**
Extract `QueueManager._resolveCommand` into a standalone exported function in a new `server/command-resolver.ts` file. Refactor `QueueManager` to use the extracted function. This avoids duplicating the command resolution logic in `ProposalManager`.

**Files:**
- Create: `/Users/javi/repos/specrails-manager/server/command-resolver.ts`
- Modify: `/Users/javi/repos/specrails-manager/server/queue-manager.ts`

**New file `command-resolver.ts`:**
```typescript
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Resolves a slash command string to its full prompt content.
 * Reads the command file from .claude/commands/ or .claude/skills/,
 * strips YAML frontmatter, and substitutes $ARGUMENTS.
 *
 * Falls back to returning the command string as-is if the file is not found.
 */
export function resolveCommand(command: string, cwd: string): string {
  const match = command.match(/^\/([^\s]+)\s*(.*)$/s)
  if (!match) return command

  const commandPath = match[1]
  const commandArgs = match[2].trim()

  const filePath = join(cwd, '.claude', 'commands', ...commandPath.split(':')) + '.md'
  const skillPath = join(cwd, '.claude', 'skills', ...commandPath.split(':')) + '.md'

  const resolvedPath = existsSync(filePath) ? filePath : existsSync(skillPath) ? skillPath : null

  if (!resolvedPath) return command

  let content = readFileSync(resolvedPath, 'utf-8')
  content = content.replace(/^---[\s\S]*?---\s*/, '')
  content = content.replace(/\$ARGUMENTS/g, commandArgs)
  return content.trim()
}
```

**Changes to `queue-manager.ts`:**
- Import `resolveCommand` from `./command-resolver`
- Replace the body of `_resolveCommand` with a call to `resolveCommand(command, this._cwd ?? process.cwd())`

**Acceptance criteria:**
- `resolveCommand('/sr:implement #5', '/path/to/project')` behaves identically to the old private method
- `QueueManager` tests still pass without modification
- `command-resolver.ts` exports only `resolveCommand` (single responsibility)

**Dependencies:** none (T2 and T3 can be done in parallel)

---

## T4 — Add WebSocket message types for proposals [manager-server]

**Layer:** `[manager-server]`

**Description:**
Add five new message interfaces to `server/types.ts` and extend the `WsMessage` union type.

**Files:**
- Modify: `/Users/javi/repos/specrails-manager/server/types.ts`

**Changes:**
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

Add all five to the `WsMessage` union.

**Acceptance criteria:**
- TypeScript compiles without errors after these additions
- All five types are present in the `WsMessage` union
- All five interfaces include `projectId` and `proposalId` for client-side filtering

**Dependencies:** none (can be done in parallel with T2, T3)

---

## T5 — Implement `ProposalManager` class [manager-server]

**Layer:** `[manager-server]`

**Description:**
Create `server/proposal-manager.ts`. This class manages the Claude CLI subprocess lifecycle for proposals — initial exploration, refinement, and issue creation. It is structurally similar to `ChatManager` but purpose-built for the proposal flow.

**Files:**
- Create: `/Users/javi/repos/specrails-manager/server/proposal-manager.ts`

**Implementation notes:**

1. Imports: `spawn`, `createInterface`, `treeKill`, `v4 as uuidv4` (not needed here actually — IDs are passed in), `resolveCommand` from `./command-resolver`, DB functions from `./db`, WS types from `./types`.

2. **`startExploration(proposalId, idea)`:**
   - Fetch proposal from DB; if not found, broadcast error and return
   - Build the command: `/sr:propose-feature <idea>`
   - Resolve it: `resolveCommand('/sr:propose-feature ' + idea, this._cwd)`
   - If resolution returns the raw command (file not found), use it as-is (graceful degradation)
   - Update proposal status to `exploring`
   - Spawn Claude with `--dangerously-skip-permissions --output-format stream-json --verbose -p <resolved>`
   - Stream stdout: parse JSON lines, extract text from `assistant` events, broadcast `proposal_stream`
   - On `result` event: capture `session_id`
   - On close(0): update proposal `{ status: 'review', result_markdown: fullText, session_id: captured }`, broadcast `proposal_ready`
   - On close(non-0): update proposal `{ status: 'input' }` (allow retry), broadcast `proposal_error`

3. **`sendRefinement(proposalId, feedback)`:**
   - Fetch proposal; verify `session_id` is not null
   - Update status to `refining`
   - Spawn with `--resume <session_id> -p <feedback>`
   - Same stream/close handling as exploration
   - On close(0): update `{ status: 'review', result_markdown: newFullText, session_id: newSessionId }`, broadcast `proposal_refined`

4. **`createIssue(proposalId)`:**
   - Fetch proposal; verify `session_id` is not null
   - Update status to `refining` (reuse — process is active)
   - Fixed prompt: `"Based on the proposal above, create a GitHub Issue with the label 'user-proposed'. Output only the URL of the created issue on the last line of your response."`
   - Spawn with `--resume <session_id> -p <prompt>`
   - On close(0): extract URL from fullText using regex `/https:\/\/github\.com\/[^\s]+\/issues\/\d+/`
   - If URL found: update `{ status: 'created', issue_url: url }`, broadcast `proposal_issue_created`
   - If URL not found: update `{ status: 'review' }`, broadcast `proposal_error` with message "Issue creation failed — GitHub CLI may not be available or not authenticated"

5. **`cancel(proposalId)`:**
   - If process active: `treeKill(pid, 'SIGTERM')`
   - Update `{ status: 'cancelled' }`
   - Broadcast `proposal_error` with `error: 'cancelled'`

6. **Streaming buffer:** accumulate `fullText` per-proposal in a `Map<string, string>`. Clear on process exit.

**Acceptance criteria:**
- `isActive(id)` returns true during exploration/refinement, false after
- `startExploration` transitions proposal from `input` → `exploring` → `review` (on success) or `input` (on error)
- `sendRefinement` requires existing `session_id` (returns early and broadcasts error if null)
- `createIssue` extracts GitHub issue URL from Claude's response
- `cancel` kills the process and transitions to `cancelled`
- Server restart leaves no orphaned `exploring` proposals (handled by T2 orphan sweep)

**Dependencies:** T2, T3, T4

---

## T6 — Extend `ProjectContext` with `ProposalManager` [manager-server]

**Layer:** `[manager-server]`

**Description:**
Add `proposalManager` to the `ProjectContext` interface and instantiate it in `ProjectRegistry._loadProjectContext`.

**Files:**
- Modify: `/Users/javi/repos/specrails-manager/server/project-registry.ts`

**Changes:**
1. Import `ProposalManager` from `./proposal-manager`
2. Add `proposalManager: ProposalManager` to the `ProjectContext` interface
3. In `_loadProjectContext`, instantiate: `const proposalManager = new ProposalManager(boundBroadcast, db, project.path)`
4. Include `proposalManager` in the `ctx` object literal

**Acceptance criteria:**
- TypeScript compiles without errors
- Each project context has its own `ProposalManager` instance with the correct `cwd`
- Existing `chatManager`, `queueManager`, `setupManager` instantiation is unchanged

**Dependencies:** T5

---

## T7 — Add proposal API routes [manager-server]

**Layer:** `[manager-server]`

**Description:**
Add six new routes to `server/project-router.ts` under the existing project middleware. Routes follow the existing pattern: access `ctx(req)` for the project context, respond 202 and fire async, guard with `isActive()` to prevent concurrent operations.

**Files:**
- Modify: `/Users/javi/repos/specrails-manager/server/project-router.ts`

**Changes:**
Add the following route handlers after the chat routes section, before `return router`:

```typescript
// ─── Proposal routes ─────────────────────────────────────────────────────────

router.get('/:projectId/propose', (req, res) => { ... })
router.post('/:projectId/propose', async (req, res) => { ... })
router.get('/:projectId/propose/:id', (req, res) => { ... })
router.post('/:projectId/propose/:id/refine', async (req, res) => { ... })
router.post('/:projectId/propose/:id/create-issue', async (req, res) => { ... })
router.delete('/:projectId/propose/:id', (req, res) => { ... })
```

Import `createProposal`, `getProposal`, `listProposals`, `updateProposal`, `deleteProposal` from `./db`.
Import `ProposalManager` (for type usage only — access via `ctx(req).proposalManager`).

**Route details:**

**GET `/propose`:**
```typescript
const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100)
const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0
const result = listProposals(ctx(req).db, { limit, offset })
res.json(result)
```

**POST `/propose`:**
```typescript
const { idea } = req.body ?? {}
if (!idea || typeof idea !== 'string' || !idea.trim()) {
  res.status(400).json({ error: 'idea is required' }); return
}
const id = uuidv4()
createProposal(ctx(req).db, { id, idea: idea.trim() })
res.status(202).json({ proposalId: id })
ctx(req).proposalManager.startExploration(id, idea.trim()).catch((err) => {
  console.error('[project-router] proposal startExploration error:', err)
})
```

**GET `/propose/:id`:**
```typescript
const proposal = getProposal(ctx(req).db, req.params.id)
if (!proposal) { res.status(404).json({ error: 'Proposal not found' }); return }
res.json({ proposal })
```

**POST `/propose/:id/refine`:**
```typescript
const proposal = getProposal(ctx(req).db, req.params.id)
if (!proposal) { res.status(404).json({ error: 'Proposal not found' }); return }
const { feedback } = req.body ?? {}
if (!feedback || typeof feedback !== 'string' || !feedback.trim()) {
  res.status(400).json({ error: 'feedback is required' }); return
}
if (ctx(req).proposalManager.isActive(req.params.id)) {
  res.status(409).json({ error: 'PROPOSAL_BUSY' }); return
}
if (proposal.status !== 'review') {
  res.status(409).json({ error: 'Proposal is not in review state' }); return
}
res.status(202).json({ ok: true })
ctx(req).proposalManager.sendRefinement(req.params.id, feedback.trim()).catch((err) => {
  console.error('[project-router] proposal sendRefinement error:', err)
})
```

**POST `/propose/:id/create-issue`:**
```typescript
const proposal = getProposal(ctx(req).db, req.params.id)
if (!proposal) { res.status(404).json({ error: 'Proposal not found' }); return }
if (ctx(req).proposalManager.isActive(req.params.id)) {
  res.status(409).json({ error: 'PROPOSAL_BUSY' }); return
}
if (proposal.status !== 'review') {
  res.status(409).json({ error: 'Proposal is not in review state' }); return
}
res.status(202).json({ ok: true })
ctx(req).proposalManager.createIssue(req.params.id).catch((err) => {
  console.error('[project-router] proposal createIssue error:', err)
})
```

**DELETE `/propose/:id`:**
```typescript
const proposal = getProposal(ctx(req).db, req.params.id)
if (!proposal) { res.status(404).json({ error: 'Proposal not found' }); return }
ctx(req).proposalManager.cancel(req.params.id)
res.json({ ok: true })
```

**Acceptance criteria:**
- All six routes exist and return correct status codes
- POST `/propose` with empty body returns 400
- POST `/propose/:id/refine` while process is active returns 409
- POST `/propose/:id/create-issue` while not in `review` status returns 409
- TypeScript compiles without errors

**Dependencies:** T5, T6

---

## T8 — Implement `useProposal` hook [manager-client]

**Layer:** `[manager-client]`

**Description:**
Create the client-side hook that manages all proposal state and WebSocket subscriptions for a single proposal session.

**Files:**
- Create: `/Users/javi/repos/specrails-manager/client/src/hooks/useProposal.ts`

**State interface:**
```typescript
export type ProposalStatus = 'idle' | 'exploring' | 'review' | 'refining' | 'created' | 'cancelled' | 'error'

export interface ProposalState {
  proposalId: string | null
  status: ProposalStatus
  streamingText: string
  resultMarkdown: string
  issueUrl: string | null
  errorMessage: string | null
}
```

**Hook signature:**
```typescript
export function useProposal(projectId: string | null): {
  state: ProposalState
  startProposal: (idea: string) => Promise<void>
  sendRefinement: (feedback: string) => Promise<void>
  createIssue: () => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}
```

**Implementation notes:**
- Use `useReducer` for state (following the ImplementWizard pattern)
- Subscribe to WebSocket via `useSharedWebSocket().registerHandler` on mount, deregister on unmount
- Filter all WS messages by `msg.projectId === projectId && msg.proposalId === state.proposalId`
- `proposal_stream`: append to `streamingText`
- `proposal_ready`: set `resultMarkdown = markdown`, clear `streamingText`, status → `review`
- `proposal_refined`: set `resultMarkdown = markdown`, clear `streamingText`, status → `review`
- `proposal_issue_created`: set `issueUrl`, status → `created`
- `proposal_error`: if `error === 'cancelled'` set status → `cancelled`, else status → `error`, set `errorMessage`
- API base: `getApiBase()` (handles both hub and single-project mode)
- `reset()`: dispatch back to initial state (proposalId: null, status: 'idle', all other fields cleared)

**Important — proposalId race condition:**
After `startProposal` posts to the server, the `proposalId` is received synchronously from the 202 response. Set it in state immediately so WS messages arriving before the component re-renders can be correctly filtered. Use a `useRef` to track the current proposalId for the WS handler closure.

**Acceptance criteria:**
- State transitions match the state machine in the delta-spec
- WS messages from other proposals or other projects are ignored
- `cancel()` fires DELETE and transitions state locally (does not wait for WS)
- `reset()` produces a clean idle state suitable for re-opening the modal

**Dependencies:** T4, T7

---

## T9 — Implement `FeatureProposalModal` component [manager-client]

**Layer:** `[manager-client]`

**Description:**
Create the full modal component. This is the premium UX surface. Every state transition should feel smooth and intentional.

**Files:**
- Create: `/Users/javi/repos/specrails-manager/client/src/components/FeatureProposalModal.tsx`

**Implementation:**

Use `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` from `./ui/dialog`.
Use `Button` from `./ui/button`.
Use `ReactMarkdown` + `remarkGfm` with the same `MD_CLASSES` prose string from `SetupChat.tsx` (copy the constant verbatim — do not import from SetupChat).

**State source:** `useProposal(activeProjectId)` from `useHub()`.

**`idle` step:**
```tsx
<DialogContent className="max-w-3xl glass-card">
  <DialogHeader>
    <DialogTitle>Propose a Feature</DialogTitle>
  </DialogHeader>
  <div className="space-y-3">
    <p className="text-xs text-muted-foreground">
      Describe your idea in plain language. Claude will read the codebase and structure it into a full proposal.
    </p>
    <textarea
      autoFocus
      className={cn(
        'w-full resize-none rounded-md border border-border/50 bg-background/50',
        'px-3 py-2 text-sm placeholder:text-muted-foreground',
        'focus:outline-none focus:ring-1 focus:ring-dracula-purple/50',
        'min-h-[120px] max-h-64'
      )}
      placeholder="e.g. I want users to be able to set a budget alert so they get notified when API costs exceed a threshold..."
      value={idea}
      onChange={(e) => setIdea(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); handleExplore() }
      }}
    />
    <p className="text-[10px] text-muted-foreground">Cmd+Enter to submit</p>
  </div>
  <DialogFooter>
    <Button variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
    <Button size="sm" onClick={handleExplore} disabled={!idea.trim()}>
      Explore Idea
    </Button>
  </DialogFooter>
</DialogContent>
```

**`exploring` step:**
- Header: "Exploring your idea..."
- Original idea shown in a `<div className="text-xs text-muted-foreground bg-muted/20 rounded px-2 py-1 italic">{idea}</div>`
- Scrollable content area with streaming markdown render (same pattern as SetupChat)
- Animated cursor and bouncing dots (copy from SetupChat.tsx)
- Auto-scroll ref pointing to bottom
- Footer: Cancel button only

**`review` step:**
- Scrollable content area: full `resultMarkdown` rendered with ReactMarkdown
- Separator line between proposal and refinement area
- Refinement row: `<textarea placeholder="Suggest refinements..." />` + `<Button>Refine</Button>`
- Primary action: `<Button className="bg-green-600 hover:bg-green-700">Create GitHub Issue</Button>`
- Ghost: `<Button variant="ghost">Start Over</Button>`

**`refining` step:**
- Shows previous proposal (faded: `opacity-50`) while new content streams below it
- Same streaming render as `exploring` step
- Footer: Cancel button only

**`created` step:**
```tsx
<div className="py-6 text-center space-y-3">
  <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mx-auto">
    <CheckCircle className="w-6 h-6 text-green-500" />
  </div>
  <h3 className="text-sm font-semibold">Issue Created</h3>
  <a href={issueUrl} target="_blank" rel="noopener noreferrer"
     className="text-xs text-dracula-purple hover:underline break-all">
    {issueUrl}
  </a>
</div>
<DialogFooter>
  <Button variant="ghost" size="sm" onClick={reset}>Propose Another</Button>
  <Button size="sm" onClick={handleClose}>Done</Button>
</DialogFooter>
```

**`error` step:**
```tsx
<div className="py-4 space-y-2">
  <p className="text-xs text-red-400">{errorMessage ?? 'An error occurred'}</p>
</div>
<DialogFooter>
  <Button variant="ghost" size="sm" onClick={reset}>Try Again</Button>
  <Button variant="ghost" size="sm" onClick={handleClose}>Close</Button>
</DialogFooter>
```

**Close handling:**
```typescript
function handleClose() {
  if (state.status === 'exploring' || state.status === 'refining') {
    cancel()  // kill active process
  }
  if (state.status !== 'created') {
    reset()
  }
  onClose()
}
```

**`idea` local state:** the textarea value is local to the modal component (not in `useProposal`) since it is UI-only. It is cleared on `reset()`.

**Acceptance criteria:**
- All six visual states render without errors
- Streaming markdown uses identical prose classes as `SetupChat.tsx`
- `Cmd+Enter` submits from textarea
- Modal auto-focuses textarea on open (via `autoFocus` attribute)
- Close while exploring/refining cancels the active process
- "Start Over" resets to idle without closing the modal
- "Propose Another" resets to idle without closing the modal
- TypeScript compiles without errors
- No emojis in UI text (design system uses icons from lucide-react)

**Dependencies:** T8

---

## T10 — Integrate into `DashboardPage` [manager-client]

**Layer:** `[manager-client]`

**Description:**
Add the "Propose Feature" entry point to the Dashboard and wire up the modal.

**Files:**
- Modify: `/Users/javi/repos/specrails-manager/client/src/pages/DashboardPage.tsx`

**Changes:**
1. Import `FeatureProposalModal` from `../components/FeatureProposalModal`
2. Add `const [proposalOpen, setProposalOpen] = useState(false)` alongside `wizardOpen`
3. Add a "Propose Feature" button. It should be placed below the Commands section, as its own section:

```tsx
<section>
  <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
    Feature Discovery
  </h2>
  <button
    type="button"
    onClick={() => setProposalOpen(true)}
    className={cn(
      'w-full flex items-center gap-3 p-4 rounded-lg border border-border/30 text-left glass-card',
      'hover:border-dracula-purple/40 hover:bg-dracula-current/30 transition-all active:scale-[0.98]'
    )}
  >
    <div className="w-8 h-8 rounded-md bg-dracula-purple/20 flex items-center justify-center flex-shrink-0">
      <Lightbulb className="w-4 h-4 text-dracula-purple" />
    </div>
    <div>
      <p className="text-sm font-medium">Propose a Feature</p>
      <p className="text-xs text-muted-foreground mt-0.5">
        Describe an idea — Claude will structure it into a GitHub Issue
      </p>
    </div>
  </button>
</section>
```

4. Add `<FeatureProposalModal open={proposalOpen} onClose={() => setProposalOpen(false)} />` alongside other modals

Import `Lightbulb` from `lucide-react`.
Import `cn` from `../lib/utils`.

**Acceptance criteria:**
- "Propose a Feature" button visible on Dashboard
- Clicking it opens `FeatureProposalModal`
- Modal opens and closes correctly
- TypeScript compiles without errors
- Existing `ImplementWizard` and `BatchImplementWizard` behavior unchanged

**Dependencies:** T9

---

## T11 — Tests: DB migration and CRUD [tests]

**Layer:** `[tests]`

**Description:**
Add tests for the new `proposals` table migration and all CRUD functions in `server/db.ts`. Follow the pattern in `server/db.test.ts` — use `:memory:` DB.

**Files:**
- Modify: `/Users/javi/repos/specrails-manager/server/db.test.ts`

**Test cases to add:**

```typescript
describe('proposals', () => {
  it('migration 5 creates the proposals table', () => {
    const db = makeDb()
    const tables = db.prepare('SELECT name FROM sqlite_master WHERE type=?').all('table') as { name: string }[]
    expect(tables.map(t => t.name)).toContain('proposals')
  })

  it('createProposal inserts a row with input status', () => { ... })
  it('getProposal returns the created row', () => { ... })
  it('getProposal returns undefined for unknown id', () => { ... })
  it('updateProposal sets status and updates updated_at', () => { ... })
  it('updateProposal sets session_id', () => { ... })
  it('updateProposal sets result_markdown', () => { ... })
  it('updateProposal sets issue_url', () => { ... })
  it('listProposals returns rows ordered by created_at DESC', () => { ... })
  it('listProposals respects limit and offset', () => { ... })
  it('deleteProposal removes the row', () => { ... })
  it('orphan sweep marks exploring/refining proposals as cancelled on initDb', () => {
    // Create DB, insert exploring and refining proposals manually,
    // call initDb again (simulating restart), verify status = 'cancelled'
  })
})
```

**Acceptance criteria:**
- All test cases pass via `npm test`
- Orphan sweep test covers both `exploring` and `refining` statuses
- No test imports anything from outside `./db`

**Dependencies:** T2

---

## T12 — Tests: `resolveCommand` utility [tests]

**Layer:** `[tests]`

**Description:**
Create a focused unit test file for the `resolveCommand` utility.

**Files:**
- Create: `/Users/javi/repos/specrails-manager/server/command-resolver.test.ts`

**Test cases:**
```typescript
describe('resolveCommand', () => {
  it('returns command as-is for non-slash commands', () => { ... })
  it('returns command as-is when command file does not exist', () => { ... })
  it('reads command file, strips frontmatter, substitutes $ARGUMENTS', () => {
    // Create a temp dir with a .claude/commands/sr/test.md file
    // Call resolveCommand('/sr:test hello world', tempDir)
    // Verify frontmatter is stripped and 'hello world' is substituted
  })
  it('falls back to skills directory if commands file not found', () => { ... })
  it('substitutes all occurrences of $ARGUMENTS', () => { ... })
})
```

Use `fs.mkdtempSync` + `fs.writeFileSync` for temp directory setup. Clean up in `afterEach`.

**Acceptance criteria:**
- All tests pass via `npm test`
- Tests exercise both the happy path and fallback path

**Dependencies:** T3

---

## T13 — Tests: `ProposalManager` [tests]

**Layer:** `[tests]`

**Description:**
Create `server/proposal-manager.test.ts`. Follow the mock pattern from `chat-manager.test.ts` — mock `child_process` and `tree-kill`.

**Files:**
- Create: `/Users/javi/repos/specrails-manager/server/proposal-manager.test.ts`

**Test cases:**

```typescript
describe('ProposalManager', () => {
  describe('startExploration', () => {
    it('spawns claude with correct args', () => { ... })
    it('broadcasts proposal_stream deltas as text arrives', () => { ... })
    it('captures session_id from result event', () => { ... })
    it('broadcasts proposal_ready with full markdown on close(0)', () => { ... })
    it('updates proposal status to review on success', () => { ... })
    it('broadcasts proposal_error and resets status to input on close(non-0)', () => { ... })
    it('does nothing if proposal not found in DB', () => { ... })
  })

  describe('sendRefinement', () => {
    it('spawns with --resume <session_id>', () => { ... })
    it('broadcasts proposal_refined on success', () => { ... })
    it('returns early and broadcasts error if session_id is null', () => { ... })
  })

  describe('createIssue', () => {
    it('extracts GitHub URL from response and broadcasts proposal_issue_created', () => { ... })
    it('broadcasts proposal_error if no GitHub URL found in response', () => { ... })
    it('updates proposal status to created when URL found', () => { ... })
  })

  describe('cancel', () => {
    it('calls treeKill with SIGTERM on active process', () => { ... })
    it('updates proposal status to cancelled', () => { ... })
    it('broadcasts proposal_error with error: cancelled', () => { ... })
    it('does nothing if no active process', () => { ... })
  })

  describe('isActive', () => {
    it('returns false before exploration starts', () => { ... })
    it('returns true while exploration is running', () => { ... })
    it('returns false after exploration completes', () => { ... })
  })
})
```

**Setup helpers (mirroring chat-manager.test.ts):**
- `createMockChildProcess()` — EventEmitter with `stdout` Readable
- `pushLine(child, line)` — push a JSON line to stdout
- `finishProcess(child, code)` — push EOF + emit close
- `assistantEvent(text)`, `resultEvent(sessionId)` — JSON event factories

**Acceptance criteria:**
- All test cases pass via `npm test`
- Tests use `:memory:` DB (no filesystem I/O)
- `child_process` and `tree-kill` are fully mocked (no real subprocesses)
- All status transitions are verified in DB after each operation

**Dependencies:** T5

---

## T14 — Tests: Proposal API routes [tests]

**Layer:** `[tests]`

**Description:**
Add integration tests for the new proposal routes. Follow the pattern from `server/index.test.ts` — use supertest against a real Express app with an in-memory DB. Mock `ProposalManager` at the class level.

**Files:**
- Create: `/Users/javi/repos/specrails-manager/server/proposal-routes.test.ts`

**Test cases:**

```typescript
describe('Proposal API routes', () => {
  describe('POST /:projectId/propose', () => {
    it('returns 202 with proposalId', () => { ... })
    it('returns 400 when idea is missing', () => { ... })
    it('returns 400 when idea is empty string', () => { ... })
    it('creates a proposal row in DB', () => { ... })
    it('calls proposalManager.startExploration', () => { ... })
  })

  describe('GET /:projectId/propose/:id', () => {
    it('returns 200 with proposal row', () => { ... })
    it('returns 404 for unknown id', () => { ... })
  })

  describe('GET /:projectId/propose', () => {
    it('returns list of proposals', () => { ... })
    it('respects limit and offset params', () => { ... })
  })

  describe('POST /:projectId/propose/:id/refine', () => {
    it('returns 202 when proposal is in review status', () => { ... })
    it('returns 404 for unknown proposal', () => { ... })
    it('returns 409 when proposal is busy', () => { ... })
    it('returns 409 when proposal is not in review status', () => { ... })
    it('returns 400 when feedback is empty', () => { ... })
  })

  describe('POST /:projectId/propose/:id/create-issue', () => {
    it('returns 202 when proposal is in review status', () => { ... })
    it('returns 409 when proposal is busy', () => { ... })
    it('returns 409 when not in review status', () => { ... })
  })

  describe('DELETE /:projectId/propose/:id', () => {
    it('returns 200 ok', () => { ... })
    it('returns 404 for unknown proposal', () => { ... })
    it('calls proposalManager.cancel', () => { ... })
  })
})
```

**Acceptance criteria:**
- All tests pass via `npm test`
- `ProposalManager` is mocked — no real Claude processes spawned
- Tests cover all documented error cases (400, 404, 409)

**Dependencies:** T5, T7

---

## Summary Table

| ID | Title | Layer | Deps |
|----|-------|-------|------|
| T1 | propose-feature command template | [specrails] | — |
| T2 | DB migration (proposals table) | [manager-server] | — |
| T3 | Extract resolveCommand utility | [manager-server] | — |
| T4 | WebSocket message types | [manager-server] | — |
| T5 | ProposalManager class | [manager-server] | T2, T3, T4 |
| T6 | ProjectContext extension | [manager-server] | T5 |
| T7 | Proposal API routes | [manager-server] | T5, T6 |
| T8 | useProposal hook | [manager-client] | T4, T7 |
| T9 | FeatureProposalModal component | [manager-client] | T8 |
| T10 | DashboardPage integration | [manager-client] | T9 |
| T11 | Tests: DB migration + CRUD | [tests] | T2 |
| T12 | Tests: resolveCommand | [tests] | T3 |
| T13 | Tests: ProposalManager | [tests] | T5 |
| T14 | Tests: Proposal API routes | [tests] | T5, T7 |

**Parallel execution waves:**
- Wave 1 (no deps): T1, T2, T3, T4
- Wave 2: T5 (needs T2+T3+T4)
- Wave 3: T6, T11, T12, T13 (T6 needs T5; T11 needs T2; T12 needs T3; T13 needs T5)
- Wave 4: T7 (needs T5+T6)
- Wave 5: T8, T14 (T8 needs T4+T7; T14 needs T5+T7)
- Wave 6: T9 (needs T8)
- Wave 7: T10 (needs T9)
