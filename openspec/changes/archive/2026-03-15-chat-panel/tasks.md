# Tasks: Chat Panel

Tasks are ordered sequentially. Each task depends on all tasks that precede it unless noted. Layer tags: `[core]` = server-side, `[templates]` = template sync, `[cli]` = CLI changes.

---

## Task 1 — DB migration: add chat tables `[core]`

**Files:**
- `templates/web-manager/server/db.ts`
- `specrails/web-manager/server/db.ts`

**Description:**
Append Migration 4 to the `MIGRATIONS` array. Create `chat_conversations` and `chat_messages` tables as specified in `design.md`. Add the two new TypeScript row types (`ChatConversationRow`, `ChatMessageRow`) and a `ChatDbRow` union to `server/types.ts`.

**DB functions to add in `db.ts`:**
- `createConversation(db, { id, model }): void`
- `listConversations(db): ChatConversationRow[]`
- `getConversation(db, id): ChatConversationRow | undefined`
- `deleteConversation(db, id): void`
- `updateConversation(db, id, patch: { title?: string; session_id?: string; model?: string }): void`
- `addMessage(db, { conversation_id, role, content }): ChatMessageRow`
- `getMessages(db, conversationId): ChatMessageRow[]`

**Acceptance criteria:**
- `initDb(':memory:')` applies migration 4 without error
- Both tables exist after migration
- All 7 DB functions exist and return correctly typed values
- Existing migration tests still pass

---

## Task 2 — WS types: add 5 chat message types `[core]`

**Files:**
- `templates/web-manager/server/types.ts`
- `specrails/web-manager/server/types.ts`

**Description:**
Add the 5 new WS message interfaces (`ChatStreamMessage`, `ChatDoneMessage`, `ChatErrorMessage`, `ChatCommandProposalMessage`, `ChatTitleUpdateMessage`) and expand the `WsMessage` union to include them. Also add `ChatConversationRow` and `ChatMessageRow` types here.

**Acceptance criteria:**
- `WsMessage` union includes all 5 new types
- TypeScript compiles without error (`npm run typecheck`)

**Note:** This task can be done alongside Task 1.

---

## Task 3 — Server: ChatManager class `[core]`

**Files:**
- `templates/web-manager/server/chat-manager.ts` (new)
- `specrails/web-manager/server/chat-manager.ts` (new)

**Description:**
Implement the `ChatManager` class as specified in `design.md`. Key behaviors:

1. Constructor: `(broadcast: (msg: WsMessage) => void, db: DbInstance)`
2. `sendMessage(conversationId, userText)`:
   - Persist user message to `chat_messages` via `addMessage`
   - Fetch conversation to get `model` and `session_id`
   - Build spawn args: `['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '-p', userText]`, prepend `['--model', model]`, append `['--resume', session_id]` if session_id is non-null
   - spawn `claude` with those args
   - Store `ChildProcess` in `_activeProcesses` map keyed by `conversationId`
   - readline stdout: parse JSON, extract text from `assistant` events, accumulate into `_buffers` map
   - On each chunk: broadcast `chat_stream { conversationId, delta: newText }`
   - Check for `:::command` blocks in accumulated buffer; track emitted proposals in `_emittedProposals` map; broadcast `chat_command_proposal` for new ones
   - On `result` event: capture `session_id`, `model`
   - On process close code 0: persist assistant message, update conversation (`session_id`, `updated_at`), broadcast `chat_done { conversationId, fullText }`, trigger auto-title if this was the first turn
   - On process close non-zero (and not aborted): broadcast `chat_error`
   - Clean up `_activeProcesses`, `_buffers`, `_emittedProposals` entries on close
3. `abort(conversationId)`: treeKill SIGTERM, mark as aborted in `_abortingConversations` set, broadcast `chat_error { reason: 'aborted' }`
4. `isActive(conversationId)`: return `_activeProcesses.has(conversationId)`
5. Private `_autoTitle(conversationId, firstUserMessage, firstAssistantResponse)`: spawn throwaway `claude -p`, parse text from `assistant` event, call `updateConversation` with title, broadcast `chat_title_update`

**Acceptance criteria:**
- `ChatManager` class is exported from `chat-manager.ts`
- Sending a message spawns `claude` with correct args
- `chat_stream` WS messages arrive with non-empty `delta`
- `chat_done` WS message includes `fullText`
- `chat_error` is emitted on non-zero exit
- `abort()` stops an active stream and emits `chat_error { reason: 'aborted' }`
- `:::command\n/sr:implement #5\n:::` in response triggers `chat_command_proposal`
- Second `sendMessage` call while active returns without spawning (log warning, return early)
- `session_id` is stored in DB after first turn completes

---

## Task 4 — Server: REST API routes `[core]`

**Files:**
- `templates/web-manager/server/index.ts`
- `specrails/web-manager/server/index.ts`

**Description:**
Instantiate `ChatManager` in `index.ts` (after `queueManager`): `const chatManager = new ChatManager(broadcast, db)`.

Add 8 REST endpoints as specified in `design.md`:

```
GET    /api/chat/conversations
POST   /api/chat/conversations
GET    /api/chat/conversations/:id
DELETE /api/chat/conversations/:id
PATCH  /api/chat/conversations/:id
GET    /api/chat/conversations/:id/messages
POST   /api/chat/conversations/:id/messages
DELETE /api/chat/conversations/:id/messages/stream
```

Each endpoint must:
- Validate required fields (return 400 on missing params)
- Use the `db.*` functions from Task 1
- Use `chatManager` for send and abort operations
- Return appropriate HTTP status codes (201 for create, 202 for message send, 404 for missing, 409 for busy)

**Acceptance criteria:**
- All 8 routes return correct status codes for happy path
- `POST .../messages` returns 409 when conversation has active stream
- `DELETE .../messages/stream` calls `chatManager.abort()` and returns 404 when conversation is not active
- `DELETE .../conversations/:id` cascades; conversation is gone from DB after call
- No existing routes are modified

---

## Task 5 — Client: shared WebSocket context `[core]`

**Files:**
- `templates/web-manager/client/src/hooks/useSharedWebSocket.tsx` (new)
- `specrails/web-manager/client/src/hooks/useSharedWebSocket.tsx` (new)
- `templates/web-manager/client/src/App.tsx` (modify)
- `specrails/web-manager/client/src/App.tsx` (modify)
- `templates/web-manager/client/src/hooks/usePipeline.ts` (modify)
- `specrails/web-manager/client/src/hooks/usePipeline.ts` (modify)

**Description:**
Create a `SharedWebSocketProvider` React context that:
1. Owns the single `WebSocket` instance (moving it out of `usePipeline`)
2. Exposes `registerHandler(id, fn)` and `unregisterHandler(id)` to distribute messages to multiple subscribers
3. Exposes `connectionStatus` for display in `StatusBar`

Refactor `usePipeline` to call `useSharedWebSocket()` from context (register a handler) instead of calling `useWebSocket` directly.

Wrap `<Routes>` in `App.tsx` with `<SharedWebSocketProvider url={WS_URL}>`.

**Acceptance criteria:**
- Single WebSocket connection is established (verified via browser Network tab)
- `usePipeline` behavior is identical to before (all existing pipeline features work)
- `connectionStatus` is still surfaced correctly in `StatusBar`
- TypeScript compiles without error

---

## Task 6 — Client: `useChat` hook `[core]`

**Files:**
- `templates/web-manager/client/src/hooks/useChat.ts` (new)
- `specrails/web-manager/client/src/hooks/useChat.ts` (new)

**Description:**
Implement the `useChat` hook as specified in `design.md`. The hook:

1. Registers a handler with `SharedWebSocketContext` to receive `chat_stream`, `chat_done`, `chat_error`, `chat_command_proposal`, `chat_title_update` messages
2. Maintains local state: `conversations: ChatConversation[]`, `activeTabIndex: number`, `isPanelOpen: boolean`
3. On mount: fetches existing conversations from `GET /api/chat/conversations`; for each, fetches messages from `GET /api/chat/conversations/:id/messages` if <= 3 conversations exist
4. `createConversation(model?)`: POST to `/api/chat/conversations`, append to local state, switch active tab to new conversation
5. `deleteConversation(id)`: DELETE to `/api/chat/conversations/:id`, remove from local state, adjust `activeTabIndex`
6. `sendMessage(conversationId, text)`: POST to `/api/chat/conversations/:id/messages`, set `isStreaming: true`; delta arrives via WS
7. `abortStream(conversationId)`: DELETE to `/api/chat/conversations/:id/messages/stream`
8. `confirmCommand(command)`: POST to `/api/spawn { command }` — reuses existing spawn API
9. Persists `isPanelOpen` to `localStorage`

**Acceptance criteria:**
- Hook returns all documented fields
- Sending a message shows streaming text in `conversations[i].streamingText`
- `chat_done` replaces `streamingText` with a final message appended to `conversations[i].messages`
- `chat_error` sets `isStreaming: false` and appends an error indicator
- `chat_title_update` updates the conversation title in local state
- `isPanelOpen` is restored from `localStorage` on mount

---

## Task 7 — Client: chat UI components `[core]`

**Files:**
- `templates/web-manager/client/src/components/ChatPanel.tsx` (new)
- `specrails/web-manager/client/src/components/ChatPanel.tsx` (new)
- `templates/web-manager/client/src/components/ChatHeader.tsx` (new)
- `specrails/web-manager/client/src/components/ChatHeader.tsx` (new)
- `templates/web-manager/client/src/components/MessageList.tsx` (new)
- `specrails/web-manager/client/src/components/MessageList.tsx` (new)
- `templates/web-manager/client/src/components/MessageBubble.tsx` (new)
- `specrails/web-manager/client/src/components/MessageBubble.tsx` (new)
- `templates/web-manager/client/src/components/CommandProposal.tsx` (new)
- `specrails/web-manager/client/src/components/CommandProposal.tsx` (new)
- `templates/web-manager/client/src/components/ChatInput.tsx` (new)
- `specrails/web-manager/client/src/components/ChatInput.tsx` (new)

**Description:**

**ChatPanel**: Top-level container. When `isPanelOpen=false`, render a `w-10` collapsed strip with a vertical "Chat" label and a badge for active streams. When `isPanelOpen=true`, render the full `w-80` panel (flex column, height 100%) with `ChatHeader`, tab bar, and `ConversationView` for the active tab.

Styling follows Dracula theme: `bg-background/80 border-l border-border/30 backdrop-blur-sm`.

**ChatHeader**: Shows the current conversation title (or "New chat" placeholder), a collapse `X` button, a `+` new-conversation button (disabled when 3 tabs exist), and a trash icon for deleting the current conversation.

**MessageList**: Scrollable list of `MessageBubble` components plus a streaming indicator (`<span class="animate-pulse">...</span>`) when `isStreaming=true`. Auto-scrolls to bottom sentinel ref on message append or delta update. Scroll position is tracked; auto-scroll is suppressed when user has scrolled up more than 100px from bottom.

**MessageBubble**:
- User messages: right-aligned, `bg-dracula-purple/20` background, plain text
- Assistant messages: left-aligned, `bg-dracula-current/30` background, rendered with `react-markdown` + `remark-gfm`. If the message contains `:::command` blocks, strip them from the markdown render and render each as a `CommandProposal` instead.

**CommandProposal**: Renders a code block showing the command, a "Run" button (calls `confirmCommand`), and a "Dismiss" button. After "Run" is clicked, show a "Queued" badge and disable both buttons.

**ChatInput**: Controlled `<textarea>` (auto-grows up to 4 lines), send button, abort button (visible only when `isStreaming=true`), and model selector `<select>` (disabled after first message). Send on Enter (without Shift). Textarea is cleared on send.

**Tab bar**: Up to 3 tabs, each showing a truncated conversation title or "Chat N" fallback. Active tab highlighted with `border-b-2 border-dracula-purple`. Close `x` button on each tab.

**Acceptance criteria:**
- Panel collapses and expands via toggle button
- 3 tabs are supported simultaneously
- Markdown renders correctly in assistant messages
- Command proposals appear in assistant bubbles and can be run or dismissed
- Auto-scroll works on new messages and streaming deltas
- Send on Enter works; Shift+Enter inserts newline
- Model selector is locked after first message
- "New conversation" button disabled when 3 tabs exist

---

## Task 8 — Client: integrate ChatPanel in RootLayout `[core]`

**Files:**
- `templates/web-manager/client/src/components/RootLayout.tsx` (modify)
- `specrails/web-manager/client/src/components/RootLayout.tsx` (modify)

**Description:**
Restructure `RootLayout` to use a horizontal flex row for the main content area:

```tsx
<div className="flex flex-col h-screen overflow-hidden bg-background font-sans">
  <Navbar />
  <div className="flex flex-1 overflow-hidden">
    <main className="flex-1 overflow-auto">
      <Outlet />
    </main>
    <ChatPanel />
  </div>
  <StatusBar connectionStatus={connectionStatus} />
</div>
```

`ChatPanel` receives `useChat()` return value as props (or uses context — prefer props to avoid deep context nesting). `usePipeline` and `useChat` are both called at this level.

**Acceptance criteria:**
- Chat panel appears to the right of main content
- Panel toggle does not affect main content layout (flex-1 on main expands to fill)
- Navigating between routes does not unmount `ChatPanel`
- `StatusBar` remains pinned at bottom

---

## Task 9 — Server tests `[core]`

**Files:**
- `templates/web-manager/server/chat-manager.test.ts` (new)
- `specrails/web-manager/server/chat-manager.test.ts` (new)

**Description:**
Unit tests for `ChatManager` using vitest. Mock `spawn` (or use a test double that simulates streaming JSON lines). Tests to include:

1. `sendMessage` persists user message and triggers `chat_stream` + `chat_done` broadcasts
2. `abort` triggers `chat_error { reason: 'aborted' }`
3. `:::command` block triggers `chat_command_proposal` broadcast
4. Duplicate `:::command` blocks in same response are not emitted twice
5. `session_id` is stored in DB after first turn
6. `isActive` returns true while process is running, false after close

**Acceptance criteria:**
- All 6 test cases pass via `npm test`
- No real `claude` binary is invoked

---

## Task 10 — Template sync verification `[templates]`

**Files:**
- All files listed in tasks 1–9 under `templates/web-manager/`

**Description:**
Verify that every file change in `specrails/web-manager/` has an exact counterpart in `templates/web-manager/`. Apply any missing changes to the template directory. This is a manual diff and sync step.

**Acceptance criteria:**
- `diff -r specrails/web-manager/server templates/web-manager/server` shows no meaningful divergence (excluding `node_modules`, `data/`, generated files)
- `diff -r specrails/web-manager/client/src templates/web-manager/client/src` shows no meaningful divergence

**Note:** This task has no code deliverable — it is a sync check. The developer should run the diff and apply any missing changes before marking done.

---

## Task 11 — Client types: add chat types to `client/src/types.ts` `[core]`

**Files:**
- `templates/web-manager/client/src/types.ts` (modify)
- `specrails/web-manager/client/src/types.ts` (modify)

**Description:**
Add the client-side chat types:

```typescript
export interface ChatConversationSummary {
  id: string
  title: string | null
  model: string
  created_at: string
  updated_at: string
}

export interface ChatMessage {
  id: number
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}
```

**Note:** This task can be done alongside Task 2. Ordering here reflects typical dependency (hooks in Task 6 need these types).

**Acceptance criteria:**
- `client/src/types.ts` exports both types
- `useChat.ts` imports from `../types` (not redefines inline)
