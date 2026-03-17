---
id: feature-proposal-modal
title: Feature Proposal Modal — Context Bundle
---

# Context Bundle: Feature Proposal Modal

This document is the complete reference for a developer implementing this feature. It contains everything needed without requiring re-reading of design.md or delta-spec.md.

---

## What You Are Building

A conversational modal on the specrails-manager dashboard that lets non-technical users propose GitHub Issues via Claude. The flow:

1. User opens modal, types a feature idea
2. Server spawns Claude with `/sr:propose-feature <idea>`, streams result back
3. User reviews structured proposal (7 sections), optionally refines via chat (`--resume <session_id>`)
4. User clicks "Create GitHub Issue" — Claude creates it via `gh issue create` with label `user-proposed`
5. Issue URL appears in modal as confirmation

---

## Two Repositories Involved

| Repo | Path | Changes |
|------|------|---------|
| specrails | `/Users/javi/repos/specrails` | 1 new file: `templates/commands/propose-feature.md` |
| specrails-manager | `/Users/javi/repos/specrails-manager` | DB migration, server class, routes, client hook + component |

---

## Files to Create

| File | Size estimate | Layer |
|------|---------------|-------|
| `/Users/javi/repos/specrails/templates/commands/propose-feature.md` | ~40 lines | [specrails] |
| `/Users/javi/repos/specrails-manager/server/command-resolver.ts` | ~35 lines | [manager-server] |
| `/Users/javi/repos/specrails-manager/server/proposal-manager.ts` | ~200 lines | [manager-server] |
| `/Users/javi/repos/specrails-manager/client/src/hooks/useProposal.ts` | ~120 lines | [manager-client] |
| `/Users/javi/repos/specrails-manager/client/src/components/FeatureProposalModal.tsx` | ~250 lines | [manager-client] |
| `/Users/javi/repos/specrails-manager/server/command-resolver.test.ts` | ~60 lines | [tests] |
| `/Users/javi/repos/specrails-manager/server/proposal-manager.test.ts` | ~200 lines | [tests] |
| `/Users/javi/repos/specrails-manager/server/proposal-routes.test.ts` | ~150 lines | [tests] |

## Files to Modify

| File | Changes |
|------|---------|
| `/Users/javi/repos/specrails-manager/server/db.ts` | + Migration 5, + ProposalRow interface, + 5 CRUD functions, + orphan sweep |
| `/Users/javi/repos/specrails-manager/server/types.ts` | + 5 WS message interfaces + union entries |
| `/Users/javi/repos/specrails-manager/server/project-registry.ts` | + proposalManager to ProjectContext interface + instantiation |
| `/Users/javi/repos/specrails-manager/server/project-router.ts` | + 6 proposal routes |
| `/Users/javi/repos/specrails-manager/server/queue-manager.ts` | Refactor _resolveCommand to use resolveCommand utility |
| `/Users/javi/repos/specrails-manager/server/db.test.ts` | + proposals describe block |
| `/Users/javi/repos/specrails-manager/client/src/pages/DashboardPage.tsx` | + FeatureProposalModal + propose button |

---

## Key Patterns to Follow

### 1. Claude spawn pattern (from `chat-manager.ts` lines 100–120)

```typescript
const args: string[] = [
  '--dangerously-skip-permissions',
  '--output-format', 'stream-json',
  '--verbose',
  '-p', promptText,
]
// For resume turns, add:
// '--resume', sessionId,

const child = spawn('claude', args, {
  env: process.env,
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: this._cwd,
})
```

### 2. Streaming stdout parse pattern (from `chat-manager.ts` lines 127–170)

```typescript
const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

stdoutReader.on('line', (line) => {
  let parsed: Record<string, unknown> | null = null
  try { parsed = JSON.parse(line) } catch { /* skip non-JSON */ }
  if (!parsed) return

  const eventType = parsed.type as string

  if (eventType === 'result') {
    const sid = parsed.session_id as string | undefined
    if (sid) capturedSessionId = sid
  }

  // Extract text from assistant events
  if (eventType === 'assistant') {
    const content = parsed.message as { content?: Array<{ type: string; text?: string }> } | undefined
    const texts = (content?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
    const newText = texts.join('')
    if (newText) {
      buffer += newText
      broadcast({ type: 'proposal_stream', proposalId, delta: newText, ... })
    }
  }
})
```

### 3. Process close handling (from `chat-manager.ts` lines 173–222)

```typescript
return new Promise<void>((resolve) => {
  child.on('close', (code) => {
    const fullText = buffer
    // clean up maps
    if (code === 0) {
      // persist + broadcast success
    } else {
      // broadcast error
    }
    resolve()
  })
})
```

### 4. DB migration pattern (from `db.ts` lines 49–143)

Migrations are append-only. Add as the next entry in the `MIGRATIONS` array. The version number is `index + 1` automatically. Do NOT renumber existing migrations.

### 5. Streaming markdown render (from `SetupChat.tsx` lines 8–19)

```typescript
const MD_CLASSES = `prose prose-invert prose-xs max-w-none
  prose-p:my-1 prose-p:leading-relaxed
  prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-semibold
  prose-ul:my-1 prose-ol:my-1 prose-li:my-0
  prose-code:text-cyan-300 prose-code:text-[10px] prose-code:bg-muted/40 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
  prose-pre:my-1 prose-pre:bg-muted/30 prose-pre:rounded-md prose-pre:p-2 prose-pre:text-[10px]
  prose-strong:text-foreground prose-em:text-foreground/70
  prose-table:my-2 prose-table:text-[10px]
  prose-thead:border-border prose-thead:bg-muted/30
  prose-th:px-2 prose-th:py-1 prose-th:text-left prose-th:font-semibold
  prose-td:px-2 prose-td:py-1 prose-td:border-border
  text-foreground/80`
```

```tsx
<div className={MD_CLASSES}>
  <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
</div>
{/* Cursor */}
<span className="inline-block w-1.5 h-3 bg-dracula-purple ml-0.5 animate-pulse" />
```

Bouncing dots when no text yet:
```tsx
<div className="rounded-lg px-3 py-2 bg-muted/40 flex items-center gap-1.5">
  <span className="w-1.5 h-1.5 rounded-full bg-dracula-purple animate-bounce [animation-delay:0ms]" />
  <span className="w-1.5 h-1.5 rounded-full bg-dracula-purple animate-bounce [animation-delay:150ms]" />
  <span className="w-1.5 h-1.5 rounded-full bg-dracula-purple animate-bounce [animation-delay:300ms]" />
</div>
```

### 6. useSharedWebSocket subscription pattern

```typescript
const { registerHandler, unregisterHandler } = useSharedWebSocket()

useEffect(() => {
  const handlerId = `proposal-${proposalIdRef.current ?? 'pending'}`
  registerHandler(handlerId, (msg) => {
    const m = msg as Record<string, unknown>
    if (m.projectId !== projectId) return
    if (m.proposalId !== proposalIdRef.current) return
    // handle message types
  })
  return () => unregisterHandler(handlerId)
}, [projectId, registerHandler, unregisterHandler])
```

Note: the handler ID must be stable to avoid double-registration. Use a fixed string per hook instance.

### 7. Route pattern (from `project-router.ts` lines 63–80)

```typescript
router.post('/:projectId/propose', (req: Request, res: Response) => {
  const { idea } = req.body ?? {}
  if (!idea || typeof idea !== 'string' || !idea.trim()) {
    res.status(400).json({ error: 'idea is required' })
    return
  }
  const id = uuidv4()
  createProposal(ctx(req).db, { id, idea: idea.trim() })
  res.status(202).json({ proposalId: id })
  ctx(req).proposalManager.startExploration(id, idea.trim()).catch((err) => {
    console.error('[project-router] proposal error:', err)
  })
})
```

---

## Critical Implementation Details

### Command file resolution path

`ProposalManager.startExploration` resolves `/sr:propose-feature` using `resolveCommand`. The resolution checks:
1. `<cwd>/.claude/commands/sr/propose-feature.md` (from commands dir)
2. `<cwd>/.claude/skills/sr/propose-feature.md` (from skills dir, fallback)

If neither exists (e.g., specrails not installed on the target project), it passes the raw command string through. This gracefully degrades — Claude will see the raw command text and may still attempt to respond.

### GitHub issue URL extraction

In `createIssue`, extract the URL with:
```typescript
const match = fullText.match(/https:\/\/github\.com\/[^\s]+\/issues\/\d+/)
const issueUrl = match ? match[0] : null
```

If `issueUrl` is null: transition back to `review` status and broadcast `proposal_error` with a helpful message.

### Orphan sweep location

The orphan sweep (`UPDATE proposals SET status = 'cancelled' WHERE status IN ('exploring', 'refining')`) is added **inside `initDb`** after the existing jobs orphan sweep (around line 186 of `db.ts`). This ensures it runs on every DB initialization, including on server restart.

### ProposalManager in ProjectContext

`ProposalManager` is constructed with `boundBroadcast` (not the raw `this._broadcast`) so all broadcast messages automatically carry `projectId`. This is the same pattern used for `chatManager` and `queueManager`.

### TypeScript strict null checks

The existing codebase is TypeScript with standard strict settings. Pay attention to:
- `proposal.session_id` is `string | null` — guard before using as `--resume` arg
- `child.pid` may be `undefined` — guard before `treeKill`
- `getProposal` returns `ProposalRow | undefined` — always null-check

### Test file for DB

Tests for the proposals table go in the **existing** `server/db.test.ts`, not a new file. Add a new top-level `describe('proposals', ...)` block at the end of the file.

---

## Test Framework

The project uses **Vitest** (`npm test` runs `vitest run`). Test files follow the `*.test.ts` naming convention and sit in `server/`. Imports use:
```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
```

For mocking modules:
```typescript
vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn() }))
vi.mock('tree-kill', () => ({ default: vi.fn() }))
```

For a mock child process:
```typescript
function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 42000
  child.kill = vi.fn()
  return child
}
```

---

## Compatibility and Compatibility Notes

### New command template does not affect existing commands

`templates/commands/propose-feature.md` is a new file. No existing template files are modified. No breaking change to existing installed repos.

### QueueManager refactor is non-breaking

`QueueManager._resolveCommand` is replaced with a call to the extracted `resolveCommand` utility. The external behavior is identical. No tests need updating.

### DB migration is append-only

Migration 5 adds a new table. It does not modify existing tables. All existing databases automatically receive the new table on next server start.

### WsMessage union is additive

Adding five new message types to the `WsMessage` union is backward-compatible. Existing handlers that do not match the new types are unaffected.

---

## Anti-Patterns to Avoid

- Do NOT instantiate a global `ProposalManager` — it must be per-project (in `ProjectRegistry._loadProjectContext`)
- Do NOT use the job queue (`QueueManager.enqueue`) for proposals — proposals have their own lifecycle separate from the job queue
- Do NOT share a `ProposalManager` instance between projects — project isolation is strict
- Do NOT poll for proposal status — the client uses WebSocket events exclusively for state updates
- Do NOT close the GitHub issue in `createIssue` — `gh issue create` creates a new issue; the existing issue (if any) is separate
- Do NOT add streaming to the `POST /propose` HTTP response — use WebSocket exclusively
- Do NOT block the Express route handler waiting for Claude — always respond 202 and run async

---

## Verification Checklist

Before marking this feature complete, verify:

- [ ] `npm test` passes in specrails-manager (all existing + new tests)
- [ ] `npx tsc --noEmit` passes in specrails-manager root
- [ ] `cd client && npx tsc --noEmit` passes
- [ ] Modal opens from Dashboard and textarea auto-focuses
- [ ] Streaming renders in real-time (test with a real Claude run)
- [ ] Refinement loop works (second turn uses `--resume`)
- [ ] "Create GitHub Issue" creates an issue with label `user-proposed`
- [ ] Cancel during exploration kills the process (verify with `ps aux`)
- [ ] Server restart with in-flight proposal: proposal shows as `cancelled` after restart
- [ ] Hub mode: proposals from Project A are not visible in Project B's modal
- [ ] `templates/commands/propose-feature.md` is present in specrails repo
