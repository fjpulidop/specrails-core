## Why

Core is a batch workflow engine: every provider call is one short-lived process, and nested agents are blocked on purpose. Conversational agent work (Desktop missions, explore, refinements, blueprint, interactive jobs) is implemented separately inside Desktop. That makes six transports with their own stream parsing on top of a provider layer that duplicates Core's executors. Desktop missions now need provider-native sub-agents (Claude background agents, Codex multi-agent threads); Desktop currently kills them at turn end and the agent relaunches them silently. Core should be the single engine for agent execution, with one provider layer, one session model and one durable journal. Desktop becomes a host that applies product rules and renders state, as it already does for implementation runs.

## What Changes

- New **agent session runtime** subsystem in `src/agent-runtime/session/`:
  - a provider-neutral session model: sessions, turns with origin, inputs with receipts, a sub-agent tree, usage and policy;
  - an append-only, sequenced event journal;
  - pure translators from each provider protocol to that model.
- New long-lived **host process**: `specrails-core runtime host --stdio`, speaking versioned JSON-RPC 2.0 over NDJSON stdio. One host serves many sessions of one project, or the global scope.
- **Provider drivers**, selected through a registry:
  - Claude: resident stream-json process; sub-agents from `task_*` frames and `parent_tool_use_id`.
  - Codex: resident `app-server`; sub-agents from `collabAgentToolCall` and child threads.
  - Gemini, Kimi and OpenAI-compatible: an adapter over the existing executors; non-resident, sub-agents declared unsupported until verified.
- **Session policy** enforced by Core and translated by each driver:
  - sub-agents enabled or disabled (Claude `--disallowedTools Agent Task`; Codex `features.multi_agent=false`);
  - reaction to sub-agent completion;
  - tools and permissions, MCP server set, and limits (idle, stall, background maximum, resident cap).
- **Durable journal** per project in `~/.specrails/sessions/<projectKey>/` (global scope in `~/.specrails/sessions/global/`), never inside a repository:
  - private permissions, `PRAGMA user_version`, WAL;
  - epoch-fenced ownership;
  - cursor replay for host reconnection;
  - interruption recording without automatic relaunch.
- **Usage semantics** verified against real CLIs:
  - per-turn deltas of session-cumulative provider totals, with the baseline persisted across `--resume`;
  - per-sub-agent token attribution;
  - billed and estimated values stay distinct; a missing value is never zero.
- A **driver conformance kit**: real sanitized provider fixtures plus shared contract tests every driver must pass.
- **Contract**:
  - `runtime api` gains capability `sessions: 1`;
  - `integration-contract.json` gains an `agentRuntime.sessions` block (protocol version, CLI operation `host`, journal location);
  - a paired Desktop change (`core-agent-sessions-host`) consumes it.
- A shared `specrailsHome()` helper in `src/shared/` honouring `SPECRAILS_REGISTRY_HOME`, adopted by the installer registry.
- Existing batch execution (`runtime run/resume`, engine v1/v2, executors) is **unchanged** in this change. Moving role turns onto session drivers is a later change.

## Capabilities

### New Capabilities
- `agent-session-protocol`: host process, JSON-RPC methods and notifications, version and capability negotiation, error model, framing limits.
- `agent-session-lifecycle`: session and turn state machines, input delivery and receipts, continuation turns, resident process supervision and limits, interruption and recovery semantics.
- `agent-session-subagents`: normalized sub-agent tree, re-entrant status, policy enforcement (enable/disable), completion reaction, per-sub-agent usage and output.
- `agent-session-journal`: per-project durable journal, ownership fencing, cursor replay, projections/snapshots, bounded storage, usage baselines.
- `agent-session-drivers`: driver contract, capability declaration, registry, Claude and Codex drivers, executor-backed non-resident driver, conformance kit.

### Modified Capabilities
<!-- Core has no canonical openspec/specs yet; runtime contract changes are captured in the new capabilities above. -->

## Impact

- **Code**:
  - new `src/agent-runtime/session/**`;
  - `src/agent-runtime/cli.ts` (`host` operation, `api` capability);
  - `src/shared/specrails-home.ts`;
  - `src/installer/util/registry.ts` (uses the shared helper);
  - `src/architecture.test.ts` (session-internal layering rules);
  - `integration-contract.json` and its contract test;
  - package exports (`./agent-runtime/session`).
- **Docs**: `docs/agent-runtime.md` (capability table, host section), new `docs/agent-sessions/` (architecture, protocol, drivers, journal, extending), and READMEs per session subsystem.
- **Dependencies**: none new. It uses `node:sqlite`, the existing `cross-spawn`/`cli-process` helpers and the existing schema validation libraries.
- **Compatibility**: additive. Hosts that do not negotiate `sessions` are unaffected. The batch runtime and its contract versions are untouched.
- **Release**: Core must be released before Desktop enables the session host; Desktop keeps its legacy transports when the capability is absent.
