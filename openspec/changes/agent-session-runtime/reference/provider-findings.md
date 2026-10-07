# Provider sub-agent findings (spike, 2026-10-07)

Captured with real CLIs against an empty temporary workspace. Raw, sanitized
transcripts live in [`fixtures/`](fixtures/). Each line is
`{t, dir: in|out|ctl, json}`, where `t` is milliseconds since spawn. Paths, host and
installation ids are replaced by `<TMP>`, `<HOME>`, `<HOST>` and `<ID>`.

| Fixture | Provider / version | Scenario |
| --- | --- | --- |
| `claude-bg-complete` | Claude Code 2.1.285, haiku | One background sub-agent, which itself backgrounds a shell; stdin kept open |
| `claude-fg` | same | One foreground sub-agent |
| `claude-parallel-and-user-turn` | same | Two background sub-agents and a user message while they run |
| `claude-disallowed` | same | `--disallowedTools Agent Task` |
| `claude-kill-bg` | same | SIGTERM to the process group while a background sub-agent runs |
| `claude-resume-after-kill` | same | `--resume` of the killed session |
| `codex-multi-wait` | codex-cli 0.153.4, gpt-5.6-luna low | `app-server`, two parallel sub-agents plus `wait` |
| `codex-spawn-nowait` | same | Spawn without `wait`, end the turn, collect in the next turn |
| `codex-disabled` | same | `-c features.multi_agent=false` |

## Claude Code (`-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`)

**Input receipts.** Every user frame written with a `uuid` yields
`command_lifecycle {command_uuid, state: queued|started|completed}`. The CLI
**serializes turns itself**. A message written during another turn stays `queued`
until that turn's `result`, then becomes `started`. This is a native, per-input
delivery receipt.

**Turn delimitation.** A turn runs from `system/init` to `result`. Turns the CLI
starts on its own after a background task finishes look the same (`init` …
assistant … `result`), but their `result.origin` is
`{kind:"task-notification", producer:"session-task"}`. They carry real text and
usage. The process stays alive after `result` while stdin is open.

**Sub-agent lifecycle.** All of these are `type:"system"` frames:

- `task_started {task_id, tool_use_id, description, subagent_type, is_backgrounded, spawn_depth, task_type: local_agent|local_bash, prompt, owned_by_subagent?}`
- `task_progress {task_id, tool_use_id, description, usage:{total_tokens, tool_uses, duration_ms}, last_tool_name}`
- `task_updated {task_id, patch:{status, end_time}}`, where status is `completed` or `killed`
- `task_notification {task_id, tool_use_id, status: completed|stopped, output_file, summary, usage}`
- `background_tasks_changed {tasks:[{task_id, task_type, description}]}`, the full live roster
- `task_summary`, `post_turn_summary {status_category, status_detail}`: human-readable status lines

Foreground sub-agents emit the same `task_*` frames. Their result returns to the
parent as a normal `tool_result`.

**Attribution.** Sub-agent assistant, user and tool frames carry
`parent_tool_use_id` = the launching `Agent` tool use id. The sub-agent's
initial prompt appears as a user frame with that parent id.

**Non-monotonic status (important).** A sub-agent that backgrounds its own
shell and ends its turn is reported `completed` (`task_updated` + `task_notification`).
That triggers a parent continuation turn. When the shell finishes, the **same
`task_id` is restarted** (`task_started` again, with a `<task-notification>` prompt) and
later completes again. The roster can briefly be `[]` between these events.
Consequences:

- Sub-agent status must allow `completed → running` re-entry.
- "Roster empty" alone is not a reliable "all done" signal; it needs settling.
- The parent may tell the user something has finished when it has not. The UI must show provider state, not parent prose.

Sub-agent shells appear as `local_bash` tasks with `owned_by_subagent: true`.

**Cost.** `result.total_cost_usd` is cumulative **per session, across `--resume`**:
0.0535 → 0.0637 in one process, then 0.0698 on the first turn of a resumed process.
`result.usage` token fields are per turn. Per-turn cost = delta against the last
known cumulative value of that session, persisted across processes. Sub-agent
`usage` reports tokens, tool uses and duration, with no USD.

**Termination.** On SIGTERM the CLI emits `task_notification status:stopped` and
`task_updated status:killed` for live tasks before it exits (code 143). A later
`--resume` produced no orphan notification. The parent believed the work had
completed, so the runtime must tell it explicitly.

**Disable.** `--disallowedTools Agent Task` removes the tool. The agent reports
having no agent tool and continues normally.

## Codex (`codex app-server --listen stdio://`, JSON-RPC)

**Sub-agents are threads.** The parent emits `item/*` with
`item.type:"collabAgentToolCall"`:
`{tool: spawnAgent|wait|…, status, senderThreadId, receiverThreadIds[], prompt, model, reasoningEffort, agentsStates:{<threadId>:{status: pendingInit|…|completed, message}}}`.

- Child threads emit their own `turn/started`, `item/*`, `item/agentMessage/delta`, `turn/completed` and `thread/status/changed` notifications, with their `threadId`, on the same connection.
- No `thread/started` is emitted for children. Parentage is known only from `receiverThreadIds` of `spawnAgent`.
- Several threads stream interleaved; demultiplex by `threadId`.

**Lifetime.** A child keeps working after the parent's turn completes (parent
turn finished at 7.5 s, child at 48 s) as long as the `app-server` process lives. A
later parent turn collects it with `wait`. Unlike Claude, there is no automatic
parent continuation turn. The parent reacts only when it calls `wait` or the
user writes.

**Usage.** `thread/tokenUsage/updated {threadId, tokenUsage:{total, last}}` is
emitted per thread, children included. `total` is cumulative per thread and `last`
is the latest request. There is no USD; cost is an estimate from the rate card.

**Disable.** `-c features.multi_agent=false` removes the agent tools (tool list
shows only `exec`, `wait`, `apply_patch`, …).

**Other.** `item.phase` distinguishes `commentary` from `final_answer` messages.
The user's global MCP servers and hooks are loaded into every thread, so the
runtime must control the MCP set explicitly.

**MCP isolation (probe without model calls).** `-c mcp_servers={}` does *not*
remove the user's servers, because `-c` overrides are merged into the config. What
works:

- adding a server with `-c mcp_servers.<name>.url=…` (or `.command`/`.args`);
- disabling one with `-c mcp_servers.<name>.enabled=false`.

The driver therefore disables every server declared in the user's
`config.toml`. The built-in `codex_apps` and `cua_repl` servers are not
declared there and stay. Codex has no `--tools` equivalent, so tool filtering
is declared unsupported. With a ChatGPT login some models
are rejected (`gpt-5.4-mini`): model availability is account-dependent.

## Normalization implications

| Concept | Claude | Codex | Normalized |
| --- | --- | --- | --- |
| Sub-agent identity | `task_id` (+ `tool_use_id`) | child `threadId` | `subagentId` + provider ref |
| Parentage | `parent_tool_use_id` → `task_started.tool_use_id`; `spawn_depth` | `senderThreadId` → `receiverThreadIds` | `parentId` (agent or sub-agent) |
| Start | `task_started` | `spawnAgent` completed + child `turn/started` | `subagent.started` |
| Progress / output | `task_progress`, frames with `parent_tool_use_id` | child-thread items and deltas | `subagent.progress`, `subagent.output` |
| Finish | `task_updated` / `task_notification` (re-entrant) | child `turn/completed`, `agentsStates` | `subagent.status` (re-entrant) |
| Background roster | `background_tasks_changed` | threads with an in-progress turn | derived `liveSubagents` |
| Parent reaction | automatic continuation turn | only via `wait` / next user turn | `turn.started {origin}` when it happens |
| Turn boundary | `init` … `result` | `turn/started` … `turn/completed` | `turn.started` / `turn.completed` |
| Input receipt | `command_lifecycle` | `turn/start` / `turn/steer` responses | `input.accepted` / `input.started` / `input.completed` |
| Usage | per-turn tokens; session-cumulative USD | per-thread cumulative tokens; no USD | per-turn delta, billed or estimated, per sub-agent tokens |
| Disable sub-agents | `--disallowedTools Agent Task` | `-c features.multi_agent=false` | `policy.subagents = "disabled"` |

Not verified: Gemini and Kimi (out of scope for this spike by decision). Their
drivers declare `subagents: unsupported` until verified.
