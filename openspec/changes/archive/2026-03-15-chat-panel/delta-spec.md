# Delta Spec: Chat Panel

This document describes changes to existing spec files in `openspec/specs/`.

---

## Spec: web-manager-dashboard.md

### Addition: Chat Panel Section

Append a new top-level section `## Chat Panel` to the existing web-manager-dashboard spec:

---

### Chat Panel

The web-manager includes a persistent conversational chat panel accessible from all pages.

#### Requirement: Global persistence
The chat panel SHALL be mounted in `RootLayout` so that it persists across all page navigations (Dashboard, Settings). Navigating between pages SHALL NOT reset, close, or interrupt any conversation or active stream.

##### Scenario: Navigation during streaming
- **GIVEN** an active streaming response in the chat panel
- **WHEN** the user navigates from Dashboard to Settings
- **THEN** the stream continues uninterrupted and text continues to appear in the chat panel

#### Requirement: Collapsible panel
The chat panel SHALL be collapsible. Its open/closed state SHALL be persisted to `localStorage` under the key `specrails.chatPanelOpen`. The default state SHALL be collapsed.

#### Requirement: Tab limit
The chat panel SHALL support a maximum of 3 simultaneous conversation tabs. When 3 tabs are open, the "New conversation" button SHALL be disabled.

#### Requirement: Model selector
Each conversation SHALL have a model selector. The selector SHALL be editable only before the first message is sent. After the first message, the model is locked for that conversation.

Supported model values:
- `claude-opus-4-5`
- `claude-sonnet-4-5` (default)
- `claude-haiku-4-5`

#### Requirement: Command proposals
When the assistant response contains a `:::command\n<content>\n:::` block, the UI SHALL render a `CommandProposal` component with a "Run" and "Dismiss" button. Clicking "Run" SHALL POST to `/api/spawn` with the extracted command string. Clicking "Dismiss" SHALL remove the proposal from the UI without running the command.

#### Requirement: Auto-title
After the first completed assistant turn in a new conversation, a title SHALL be generated automatically using a fast `claude -p` call. The generated title SHALL be displayed in the conversation tab.

---

## Spec: web-manager-settings.md (if it exists)

No changes required to the settings spec in this release. Model selection is per-conversation, not a global setting.

---

## New Types in server/types.ts

The following WS message types are formally added to the system:

| Type | Direction | Purpose |
|------|-----------|---------|
| `chat_stream` | Server → Client | Incremental text delta from active Claude response |
| `chat_done` | Server → Client | Signals completion of a response turn |
| `chat_error` | Server → Client | Signals a stream failure or abort |
| `chat_command_proposal` | Server → Client | A `:::command` block was detected in the response |
| `chat_title_update` | Server → Client | Auto-generated title is ready |

No existing WS message types are modified.

---

## New DB Tables

Migration 4 adds two tables to the existing SQLite schema:

| Table | Purpose |
|-------|---------|
| `chat_conversations` | One row per conversation; stores model, session_id (for --resume), title |
| `chat_messages` | All user and assistant messages; FK to chat_conversations with ON DELETE CASCADE |

No existing tables are modified. The migration is additive.

---

## New REST Endpoints

8 new endpoints under `/api/chat/...` are added to `server/index.ts`. No existing endpoints are modified or removed.
