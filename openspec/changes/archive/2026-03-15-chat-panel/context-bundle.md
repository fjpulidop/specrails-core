# Context Bundle: Chat Panel

This document provides the exact per-file changes, dependency graph, and risk notes needed to implement the chat panel feature.

---

## File Change Map

### `server/db.ts` (modify)

**Location in both:** `templates/web-manager/server/db.ts` and `specrails/web-manager/server/db.ts`

**Change:** Append to `MIGRATIONS` array as index 3 (Migration 4):

```typescript
// Migration 4: chat conversations and messages
(db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id           TEXT PRIMARY KEY,
      title        TEXT,
      model        TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
      session_id   TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id);
  `)
},
```

**New exported functions to add at the bottom of `db.ts`:**

```typescript
export function createConversation(db: DbInstance, opts: { id: string; model: string }): void {
  db.prepare(
    'INSERT INTO chat_conversations (id, model) VALUES (?, ?)'
  ).run(opts.id, opts.model)
}

export function listConversations(db: DbInstance): ChatConversationRow[] {
  return db.prepare(
    'SELECT * FROM chat_conversations ORDER BY updated_at DESC'
  ).all() as ChatConversationRow[]
}

export function getConversation(db: DbInstance, id: string): ChatConversationRow | undefined {
  return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) as ChatConversationRow | undefined
}

export function deleteConversation(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id)
}

export function updateConversation(
  db: DbInstance,
  id: string,
  patch: { title?: string; session_id?: string; model?: string }
): void {
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [new Date().toISOString()]
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
  if (patch.session_id !== undefined) { sets.push('session_id = ?'); params.push(patch.session_id) }
  if (patch.model !== undefined) { sets.push('model = ?'); params.push(patch.model) }
  params.push(id)
  db.prepare(`UPDATE chat_conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function addMessage(
  db: DbInstance,
  msg: { conversation_id: string; role: 'user' | 'assistant'; content: string }
): ChatMessageRow {
  const result = db.prepare(
    'INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)'
  ).run(msg.conversation_id, msg.role, msg.content)
  return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(result.lastInsertRowid) as ChatMessageRow
}

export function getMessages(db: DbInstance, conversationId: string): ChatMessageRow[] {
  return db.prepare(
    'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(conversationId) as ChatMessageRow[]
}
```

**Import needed:** `ChatConversationRow` and `ChatMessageRow` from `./types` (will be added in types.ts change).

---

### `server/types.ts` (modify)

**Location in both:** `templates/web-manager/server/types.ts` and `specrails/web-manager/server/types.ts`

**Change 1 — Add row types** (after `StatsRow`):

```typescript
export interface ChatConversationRow {
  id: string
  title: string | null
  model: string
  session_id: string | null
  created_at: string
  updated_at: string
}

export interface ChatMessageRow {
  id: number
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}
```

**Change 2 — Add WS message types** (after `EventMessage`):

```typescript
export interface ChatStreamMessage {
  type: 'chat_stream'
  conversationId: string
  delta: string
  timestamp: string
}

export interface ChatDoneMessage {
  type: 'chat_done'
  conversationId: string
  fullText: string
  timestamp: string
}

export interface ChatErrorMessage {
  type: 'chat_error'
  conversationId: string
  error: string
  timestamp: string
}

export interface ChatCommandProposalMessage {
  type: 'chat_command_proposal'
  conversationId: string
  command: string
  timestamp: string
}

export interface ChatTitleUpdateMessage {
  type: 'chat_title_update'
  conversationId: string
  title: string
  timestamp: string
}
```

**Change 3 — Expand WsMessage union:**

```typescript
export type WsMessage =
  | LogMessage | PhaseMessage | InitMessage | QueueMessage | EventMessage
  | ChatStreamMessage | ChatDoneMessage | ChatErrorMessage
  | ChatCommandProposalMessage | ChatTitleUpdateMessage
```

---

### `server/chat-manager.ts` (new)

**Location in both:** `templates/web-manager/server/chat-manager.ts` and `specrails/web-manager/server/chat-manager.ts`

**Key imports:**
```typescript
import { spawn, execSync, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import type { WsMessage } from './types'
import type { DbInstance } from './db'
import { getConversation, addMessage, updateConversation } from './db'
```

**Command block extraction:**
```typescript
function extractCommandProposals(text: string): string[] {
  const regex = /:::command\s*\n([\s\S]*?):::/g
  const results: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    results.push(match[1].trim())
  }
  return results
}
```

**Auto-title logic:**
The auto-title spawn must handle the case where the `claude` binary is not found. Wrap in try/catch; failure is silent. Only trigger when the conversation's `session_id` was `null` before the turn completed (i.e., this was turn 1).

Track whether it is turn 1 by checking `conversation.session_id === null` before sending the message.

```typescript
// Auto-title prompt (passed as -p argument)
const titlePrompt = `Generate a 4-6 word title for this conversation. Output ONLY the title text, no quotes or punctuation.\n\nUser: ${firstUserMsg.slice(0, 200)}\nAssistant: ${firstResponse.slice(0, 300)}`
```

Parse the auto-title output: use the `assistant` event type from stream-json to extract text. Take only the first assistant event's text.

---

### `server/index.ts` (modify)

**Location in both:** `templates/web-manager/server/index.ts` and `specrails/web-manager/server/index.ts`

**New imports to add:**
```typescript
import { ChatManager } from './chat-manager'
import {
  createConversation, listConversations, getConversation,
  deleteConversation, updateConversation, addMessage, getMessages
} from './db'
import type { ChatConversationRow } from './types'
```

**Add after queueManager instantiation:**
```typescript
const chatManager = new ChatManager(broadcast, db)
```

**8 routes to add** (add before the `server.listen` call):

Exact error response field names must be consistent:
- Missing param → `{ error: '<field> is required' }`
- Not found → `{ error: 'Conversation not found' }`
- Busy → `{ error: 'CONVERSATION_BUSY' }`
- Not active → `{ error: 'No active stream for this conversation' }`

---

### `client/src/hooks/useSharedWebSocket.tsx` (new)

**Location in both:** `templates/web-manager/client/src/hooks/useSharedWebSocket.tsx` and `specrails/web-manager/client/src/hooks/useSharedWebSocket.tsx`

**Pattern:**
```tsx
const SharedWebSocketContext = createContext<SharedWebSocketContextValue | null>(null)

interface SharedWebSocketContextValue {
  registerHandler: (id: string, fn: (msg: unknown) => void) => void
  unregisterHandler: (id: string) => void
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
}

export function SharedWebSocketProvider({ url, children }: { url: string; children: ReactNode }) {
  const handlers = useRef(new Map<string, (msg: unknown) => void>())
  // ... owns the WebSocket, distributes messages to all registered handlers
}

export function useSharedWebSocket(): SharedWebSocketContextValue {
  const ctx = useContext(SharedWebSocketContext)
  if (!ctx) throw new Error('useSharedWebSocket must be used within SharedWebSocketProvider')
  return ctx
}
```

The internal WebSocket lifecycle (connect, reconnect with backoff) moves from `useWebSocket.ts` to this provider. `useWebSocket.ts` can remain for non-shared use cases or be deprecated.

---

### `client/src/hooks/usePipeline.ts` (modify)

**Change:** Replace `useWebSocket(WS_URL, handleMessage)` with:
```typescript
const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
useEffect(() => {
  registerHandler('pipeline', handleMessage)
  return () => unregisterHandler('pipeline')
}, [handleMessage, registerHandler, unregisterHandler])
```

Remove the `WS_URL` import from this file (no longer needed here).

---

### `client/src/App.tsx` (modify)

**Change:** Wrap `<Routes>` in `<SharedWebSocketProvider url={WS_URL}>`:
```tsx
import { SharedWebSocketProvider } from './hooks/useSharedWebSocket'
import { WS_URL } from './lib/ws-url'

export default function App() {
  return (
    <SharedWebSocketProvider url={WS_URL}>
      <Routes>
        <Route element={<RootLayout />}>
          ...
        </Route>
      </Routes>
    </SharedWebSocketProvider>
  )
}
```

---

### `client/src/hooks/useChat.ts` (new)

Registers handler with ID `'chat'` via `useSharedWebSocket`. Handles message types: `chat_stream`, `chat_done`, `chat_error`, `chat_command_proposal`, `chat_title_update`.

**localStorage key:** `specrails.chatPanelOpen` (boolean string `'true'` / `'false'`).

**Initial fetch on mount:** `GET /api/chat/conversations` → for each conversation, `GET /api/chat/conversations/:id/messages`.

---

### `client/src/components/RootLayout.tsx` (modify)

**Before:**
```tsx
<div className="flex flex-col h-screen overflow-hidden bg-background font-sans">
  <Navbar />
  <main className="flex-1 overflow-auto">
    <Outlet />
  </main>
  <StatusBar connectionStatus={connectionStatus} />
</div>
```

**After:**
```tsx
<div className="flex flex-col h-screen overflow-hidden bg-background font-sans">
  <Navbar />
  <div className="flex flex-1 overflow-hidden">
    <main className="flex-1 overflow-auto">
      <Outlet />
    </main>
    <ChatPanel chat={chat} />
  </div>
  <StatusBar connectionStatus={connectionStatus} />
</div>
```

Where `chat = useChat()` is called at this level.

---

### `client/src/types.ts` (modify)

Add `ChatConversationSummary` and `ChatMessage` interfaces as specified in Task 11.

---

### New client component files (all new)

- `ChatPanel.tsx` — root container, collapsed/expanded, tab bar
- `ChatHeader.tsx` — title, buttons
- `MessageList.tsx` — scroll container, streaming indicator
- `MessageBubble.tsx` — per-message display, markdown for assistant
- `CommandProposal.tsx` — command block with Run/Dismiss
- `ChatInput.tsx` — textarea, send, abort, model selector

All follow Dracula theme conventions already established in the codebase: `bg-background`, `border-border/30`, `text-dracula-*` color tokens, `glass-card` class for panel surfaces.

---

## Dependency Graph

```
Task 1 (db migration + db functions)
Task 2 (types)
    └── Task 3 (ChatManager) → depends on 1, 2
        └── Task 4 (REST routes) → depends on 3
Task 5 (shared WS context)
    └── Task 6 (useChat hook) → depends on 2, 5
        ├── Task 11 (client types) → depends on 2
        └── Task 7 (chat components) → depends on 6, 11
            └── Task 8 (RootLayout) → depends on 7
Task 9 (server tests) → depends on 1, 2, 3
Task 10 (template sync) → depends on all other tasks
```

Tasks 1 and 2 can be done in parallel. Task 11 can be done in parallel with Task 5.

---

## Risks

### Risk 1: WebSocket refactor regression
**Description:** Moving WebSocket ownership from `usePipeline` to `SharedWebSocketProvider` is the highest-risk change. If the handler registration timing is wrong (handler registered after `init` message arrives), the pipeline init state is missed.

**Mitigation:** In `SharedWebSocketProvider`, buffer the last received message. New subscribers immediately receive the buffered message on registration. This ensures `usePipeline` catches the `init` message even if it registers slightly after connection.

**Alternatively:** Send the `init` message again when a new client connects (already done server-side for new WS connections). Since this is a single-page app with one WS connection, the timing risk is: provider connects before `usePipeline` registers its handler in the same render cycle. Using `useLayoutEffect` for registration in `usePipeline` (instead of `useEffect`) eliminates any frame gap.

### Risk 2: Auto-title spawn cost
**Description:** Every first turn in a new conversation triggers a second Claude API call for auto-title generation. This adds latency and cost.

**Mitigation:** Auto-title is fire-and-forget (non-blocking). The user sees the conversation immediately. Title appears when ready. Cost is negligible (tiny prompt, fast model). This is acceptable.

### Risk 3: `:::command` block leaking into markdown
**Description:** If `MessageBubble` renders assistant content with `react-markdown` before stripping `:::command` blocks, the blocks may render as raw text inside the markdown output.

**Mitigation:** In `MessageBubble`, pre-process the content string: split on `:::command...:::` regex, render non-command segments as markdown, and render each command block as `<CommandProposal>`. This requires careful regex split logic. Test with edge cases: command at start, command at end, multiple commands, nested backticks inside command.

### Risk 4: Stream-json parsing for chat vs queue
**Description:** Both `QueueManager` and `ChatManager` parse Claude's stream-json output. They must handle the same event structure. Any future changes to the event format affect both.

**Mitigation:** Extract `extractDisplayText` (currently private in queue-manager) into a shared utility function in a new `server/claude-parse.ts`. Both managers import from there. This is a nice-to-have refactor; for the initial implementation, duplicating the extraction logic is acceptable to keep the PR focused.

### Risk 5: Template/instance divergence
**Description:** The codebase has two parallel directories. Post-implementation drift is the most common bug class for this project (per reviewer learnings).

**Mitigation:** Task 10 is a mandatory sync check before marking the feature done. The developer must run a diff between `specrails/web-manager/` and `templates/web-manager/` and resolve all divergences. This must be part of the PR checklist.

### Risk 6: `better-sqlite3` and the `addMessage` return
**Description:** `db.prepare(...).run(...)` returns a `RunResult` with `lastInsertRowid`. For `chat_messages` (AUTOINCREMENT), this is the new row's `id`. The `addMessage` function must immediately `SELECT` the newly inserted row. This is synchronous and safe with `better-sqlite3`, but care must be taken to use the correct type for `lastInsertRowid` (it is `number | bigint` — cast to `number` for the query).

**Mitigation:** `db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(result.lastInsertRowid))` — explicit cast to `Number`.

---

## External Dependencies

No new npm packages are required:
- `react-markdown` and `remark-gfm` are already in `client/package.json`
- `uuid` is already in `server/package.json` (for conversation IDs)
- `tree-kill` is already in `server/package.json`
- `better-sqlite3` is already in `server/package.json`
- All UI primitives (`button`, `select`, `input`) already exist in `client/src/components/ui/`

---

## API Field Name Reference

This table is the authoritative cross-reference between server response fields and client expectations. Use it to prevent field name mismatches (a known recurring bug class per reviewer learnings).

| Endpoint | Server sends | Client reads |
|----------|-------------|-------------|
| `GET /api/chat/conversations` | `{ conversations: ChatConversationRow[] }` | `res.conversations` |
| `POST /api/chat/conversations` | `{ conversation: ChatConversationRow }` | `res.conversation` |
| `GET /api/chat/conversations/:id` | `{ conversation, messages }` | `res.conversation`, `res.messages` |
| `GET /api/chat/conversations/:id/messages` | `{ messages: ChatMessageRow[] }` | `res.messages` |
| `POST /api/chat/conversations/:id/messages` | `{ ok: true }` | check `res.ok` |
| `PATCH /api/chat/conversations/:id` | `{ ok: true, conversation }` | `res.conversation` |
| `DELETE /api/chat/conversations/:id/messages/stream` | `{ ok: true }` | check `res.ok` |
| `DELETE /api/chat/conversations/:id` | `{ ok: true }` | check `res.ok` |

WS message field names (server must match exactly):

| WS type | Fields |
|---------|--------|
| `chat_stream` | `type`, `conversationId`, `delta`, `timestamp` |
| `chat_done` | `type`, `conversationId`, `fullText`, `timestamp` |
| `chat_error` | `type`, `conversationId`, `error`, `timestamp` |
| `chat_command_proposal` | `type`, `conversationId`, `command`, `timestamp` |
| `chat_title_update` | `type`, `conversationId`, `title`, `timestamp` |

Note: `conversationId` is camelCase in WS messages (matching JS convention) but `conversation_id` is snake_case in DB row types (matching SQLite convention). The `useChat` hook must handle both.
