# Design: Integrated Conversational Chat Panel

## Architecture Overview

The chat panel reuses three existing patterns without modification:

1. **spawn + readline loop** (from `queue-manager.ts`): `claude --dangerously-skip-permissions --output-format stream-json --verbose -p <prompt>` + `--resume <session_id>` for continuity
2. **WebSocket broadcast bus** (from `index.ts`): `broadcast(msg)` fan-out to all connected clients; chat messages are new WS message types on the same connection
3. **Migration-based SQLite schema** (from `db.ts`): new migration 4 adds two tables; the existing `applyMigrations` runner handles it automatically

The chat panel does **not** use the `QueueManager`. Chat conversations are interactive, low-latency, and single-process per conversation — not queued batch jobs. They have their own lifecycle manager: `ChatManager`.

---

## Data Model

### Migration 4 (appended to `MIGRATIONS` array in `db.ts`)

```sql
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
```

**Field notes:**
- `model`: stored per-conversation; changing the model mid-conversation is not supported (create a new conversation)
- `session_id`: the Claude Code `--resume` token; populated from the `result` event's `session_id` field after the first turn completes; `NULL` until then
- `title`: `NULL` initially; set after the first assistant response via a cheap auto-title call

### TypeScript types (added to `server/types.ts`)

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

---

## Server: ChatManager

`server/chat-manager.ts` — analogous to `queue-manager.ts` but for interactive chat.

### Responsibilities

- Spawn `claude -p <prompt> --dangerously-skip-permissions --output-format stream-json --verbose [--resume <session_id>] [--model <model>]`
- Stream stdout lines via readline; emit `chat_stream` WS messages as text accumulates
- On process close: emit `chat_done` or `chat_error`; persist complete assistant message to DB; update `session_id` in `chat_conversations`
- Detect `:::command` blocks in the accumulated assistant text; emit `chat_command_proposal` WS message
- Auto-title: after the first completed assistant response (when `session_id` was previously NULL), spawn a second `claude -p` call with a compact prompt to generate a 4–6 word title; update `chat_conversations.title`; emit a `chat_title_update` WS message

### Active process tracking

`ChatManager` maintains a `Map<string, ChildProcess>` keyed by `conversation_id`. At most one active process per conversation. A second `sendMessage` call while a process is active returns `{ error: 'CONVERSATION_BUSY' }`.

### Abort

`ChatManager.abort(conversationId)` sends SIGTERM via `treeKill` to the conversation's active process. Emits `chat_error` with `{ reason: 'aborted' }`.

### Class interface

```typescript
class ChatManager {
  constructor(broadcast: (msg: WsMessage) => void, db: DbInstance)

  sendMessage(conversationId: string, userText: string): Promise<void>
  abort(conversationId: string): void
  isActive(conversationId: string): boolean
}
```

---

## REST API Endpoints

All under `/api/chat/...`:

| Method | Path | Purpose | Response |
|--------|------|---------|---------|
| `GET` | `/api/chat/conversations` | List all conversations, newest first | `{ conversations: ChatConversationRow[] }` |
| `POST` | `/api/chat/conversations` | Create a new conversation | `201 { conversation: ChatConversationRow }` |
| `GET` | `/api/chat/conversations/:id` | Get single conversation + messages | `{ conversation, messages: ChatMessageRow[] }` |
| `DELETE` | `/api/chat/conversations/:id` | Delete conversation + messages | `{ ok: true }` |
| `POST` | `/api/chat/conversations/:id/messages` | Send a user message (triggers Claude) | `202 { ok: true }` |
| `DELETE` | `/api/chat/conversations/:id/messages/stream` | Abort active stream | `{ ok: true }` or `404` |
| `PATCH` | `/api/chat/conversations/:id` | Update title or model | `{ ok: true, conversation }` |
| `GET` | `/api/chat/conversations/:id/messages` | List messages for a conversation | `{ messages: ChatMessageRow[] }` |

**Key behaviors:**
- `POST .../messages` returns 202 immediately; streaming data arrives via WebSocket
- `POST .../messages` returns 409 if `conversationId` has an active stream
- `DELETE .../conversations` cascades to `chat_messages` via FK ON DELETE CASCADE

---

## WebSocket Message Types

New message types added to the `WsMessage` union in `server/types.ts`:

```typescript
export interface ChatStreamMessage {
  type: 'chat_stream'
  conversationId: string
  delta: string          // incremental text chunk
  timestamp: string
}

export interface ChatDoneMessage {
  type: 'chat_done'
  conversationId: string
  fullText: string       // complete assistant response
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
  command: string        // the raw command string extracted from :::command block
  timestamp: string
}

export interface ChatTitleUpdateMessage {
  type: 'chat_title_update'
  conversationId: string
  title: string
  timestamp: string
}
```

Updated `WsMessage` union:
```typescript
export type WsMessage =
  | LogMessage | PhaseMessage | InitMessage | QueueMessage | EventMessage
  | ChatStreamMessage | ChatDoneMessage | ChatErrorMessage
  | ChatCommandProposalMessage | ChatTitleUpdateMessage
```

---

## Command Block Detection

Pattern: look for `:::command\n<content>\n:::` in the accumulated text buffer after each chunk.

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

Proposals already emitted for a conversation are tracked in a `Set<string>` per active process to avoid duplicate emissions on each new chunk.

---

## System Prompt

Injected via `--system-prompt` flag or as initial context. The system prompt for chat is a single paragraph:

> You are a project assistant with full access to this repository via Claude Code. You can help answer questions about the codebase, explain SpecRails concepts, and suggest commands to run. When you want to suggest a SpecRails command for the user to execute, wrap it in a command block like this: :::command\n/sr:implement #42\n::: The user will be prompted to confirm before the command runs.

---

## Client Architecture

### Layout Integration

`RootLayout.tsx` changes from:
```
<div class="flex flex-col h-screen">
  <Navbar />
  <main class="flex-1 overflow-auto"><Outlet /></main>
  <StatusBar />
</div>
```

to:
```
<div class="flex flex-col h-screen">
  <Navbar />
  <div class="flex flex-1 overflow-hidden">
    <main class="flex-1 overflow-auto"><Outlet /></main>
    <ChatPanel />
  </div>
  <StatusBar />
</div>
```

`ChatPanel` is always mounted. Its collapsed/expanded state lives in a `useChatPanel` hook stored at the `RootLayout` level (or a small React context). This ensures state survives navigation. `ChatPanel` width when expanded: `w-80` (320px) with a resize handle for future extensibility.

### Component Tree

```
ChatPanel
├── ChatHeader          (title, collapse button, new-chat button)
├── TabBar              (up to 3 tabs, each showing conversation title or "New chat N")
├── ConversationView    (renders one conversation — shown/hidden by active tab)
│   ├── MessageList     (scrollable, auto-scrolls to bottom on new message)
│   │   └── MessageBubble (role: user | assistant, with markdown rendering via react-markdown)
│   │       └── CommandProposal  (rendered inside assistant bubble when :::command detected)
│   ├── StreamingIndicator  (visible when isStreaming=true)
│   └── ChatInput       (textarea + send button + abort button + model selector)
└── (collapsed state: only a narrow toggle strip is visible)
```

### `useChat` Hook

`client/src/hooks/useChat.ts` — manages all chat state.

```typescript
interface ChatConversation {
  id: string
  title: string | null
  model: string
  messages: ChatMessage[]
  isStreaming: boolean
  streamingText: string  // accumulated delta text while streaming
  commandProposals: string[]  // proposals pending confirmation
}

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

interface UseChatReturn {
  conversations: ChatConversation[]
  activeTabIndex: number
  isPanelOpen: boolean
  setActiveTabIndex: (i: number) => void
  togglePanel: () => void
  createConversation: (model?: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  sendMessage: (conversationId: string, text: string) => Promise<void>
  abortStream: (conversationId: string) => Promise<void>
  confirmCommand: (command: string) => Promise<void>  // POSTs to /api/spawn
  dismissCommandProposal: (conversationId: string, command: string) => void
}
```

The hook subscribes to the **existing** `usePipeline` WebSocket stream by accepting a `wsMessages` prop or being wired through a shared message dispatcher. The cleanest approach: `usePipeline` is refactored to expose an `onMessage` callback registration pattern, or `useChat` establishes its own WebSocket connection to the same URL. Given simplicity constraints, `useChat` reuses the single WebSocket by accepting `incomingMessage: unknown` as a prop updated by the parent (`RootLayout` already calls `usePipeline`).

**Preferred approach**: extract a `useSharedWebSocket` hook that distributes messages to multiple subscribers, allowing both `usePipeline` and `useChat` to subscribe without two separate WS connections.

### Model Selector

Rendered inside `ChatInput`. Options:
- `claude-opus-4-5` (label: "Opus 4.5")
- `claude-sonnet-4-5` (label: "Sonnet 4.5") — default
- `claude-haiku-4-5` (label: "Haiku 4.5")

Model is stored per-conversation in DB. Selector is only editable before the first message is sent; after that it becomes read-only (locked to the conversation's model).

### Markdown Rendering

`react-markdown` and `remark-gfm` are already in `client/package.json`. `MessageBubble` uses them for assistant messages. Code blocks render with a monospace font and subtle background. User messages render as plain text (no markdown parsing).

### Auto-scroll

`MessageList` uses a `useEffect` with a `ref` pointing to a sentinel `div` at the bottom. On every new message or delta chunk, scroll the sentinel into view with `{ behavior: 'smooth' }`. Smooth scroll is suppressed when the user has manually scrolled up (detected via scroll position).

---

## Auto-Title Generation

After the first `chat_done` event for a conversation where `session_id` was NULL (i.e., first turn), `ChatManager` spawns a second throwaway `claude -p` call:

```
claude --dangerously-skip-permissions -p "Summarize this conversation in 4-6 words as a title. Output only the title, no punctuation.\n\nUser: <first user message>\nAssistant: <first 200 chars of response>"
```

This is fire-and-forget. On completion, update `chat_conversations.title` and broadcast `chat_title_update`.

---

## Data Flow: Sending a Message

```
User types message → ChatInput.onSubmit
  → POST /api/chat/conversations/:id/messages { text }
  → Server: persist user ChatMessageRow to DB
  → Server: ChatManager.sendMessage(id, text)
    → spawn: claude -p <text> [--resume <session_id>] [--model <model>]
    → readline stdout:
        per line:
          parse JSON
          if type=assistant: extract text delta → broadcast chat_stream
          if :::command in accumulated text: broadcast chat_command_proposal
          if type=result: store session_id, persist assistant message → broadcast chat_done
    → on error: broadcast chat_error
  → Client receives chat_stream → update streamingText
  → Client receives chat_done → finalize message, clear streamingText
  → Client receives chat_command_proposal → show CommandProposal UI
```

---

## WebSocket Shared Connection Strategy

Current: `usePipeline` owns the single WebSocket via `useWebSocket(WS_URL, handleMessage)`.

New: introduce `useSharedWebSocket` context (a React context + provider):

```typescript
// client/src/hooks/useSharedWebSocket.tsx
const SharedWebSocketContext = createContext<{
  registerHandler: (id: string, fn: (msg: unknown) => void) => void
  unregisterHandler: (id: string) => void
} | null>(null)
```

`App.tsx` wraps `<Routes>` in `<SharedWebSocketProvider url={WS_URL}>`. Both `usePipeline` and `useChat` register handlers. This keeps a single TCP connection while allowing fan-out.

**Alternative**: pass `latestMessage` from `usePipeline` down via props. Rejected: it couples unrelated components through the pipeline hook, and requires `usePipeline` to expose raw messages rather than structured state.

---

## Collapsed State

When collapsed, `ChatPanel` renders as a narrow `w-10` strip with:
- A vertical "Chat" label
- A badge showing the count of active streaming conversations
- Click to expand

The collapsed/expanded state is `localStorage`-persisted (`specrails.chatPanelOpen`). Default: collapsed.

---

## Concurrency Constraints

- At most 3 conversations can exist (enforced client-side at tab creation; server returns 409 if >3 conversations exist and `POST /api/chat/conversations` is called — optional hardening)
- At most 1 active stream per conversation (server enforces 409)
- Auto-title spawns are not tracked in `_activeProcesses` — they are fire-and-forget; failure is silent

---

## Error Handling

| Scenario | Server behavior | Client behavior |
|----------|----------------|-----------------|
| Claude not on PATH | Return 400 `{ error: 'CLAUDE_NOT_FOUND' }` from POST | Show inline error in ChatInput |
| Stream error (non-zero exit) | Broadcast `chat_error` | Show error bubble in MessageList |
| Conversation not found | Return 404 | Show toast |
| Conversation busy | Return 409 `{ error: 'CONVERSATION_BUSY' }` | Disable send button while streaming |
| Network disconnect | Existing WS reconnect logic handles | streamingText frozen; show reconnect indicator |
