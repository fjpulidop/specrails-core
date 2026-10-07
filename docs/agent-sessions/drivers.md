# Session drivers

A driver connects one provider to the [session model](architecture.md). Hosts
discover drivers in the `initialize` response and choose one with
`session.open { driver }`. The application never branches on a provider name.
It adapts to each driver's declared capabilities.

## Capability matrix

| Capability | `claude` | `codex` | `gemini`, `kimi` (executor-backed) |
| --- | --- | --- | --- |
| Resident process across turns | yes | yes | no; the provider session is resumed per input |
| Native input queue and receipts | yes | no; Core holds input while a turn runs | no |
| Sub-agents | yes (`Agent`/`Task`, background tasks and their shells) | yes (child threads: `spawnAgent` on 0.153, `subAgentActivity` on 0.160) | no |
| Disable sub-agents (`policy.subagents: 'disabled'`) | `--disallowedTools Agent,Task` | `features.multi_agent=false`; Core also stops any sub-agent the model starts anyway | always off |
| Reaction when sub-agents finish | the provider continues on its own (`provider-native`) | Core asks the agent to collect results (`resume-agent`, bounded) | — |
| Steer into a running turn | yes | yes (`turn/steer`) | no |
| Tool filtering (`policy.tools`) | yes | no (refused) | no (refused) |
| Billed USD | per session, cumulative; Core records per-turn deltas | none (estimated only with a host rate card) | as reported |
| Tokens | per turn | cumulative per thread (deltas) | per turn |
| MCP isolation (`inheritUserScope: false`) | `--strict-mcp-config` | user servers disabled one by one | provider default |

A policy a driver cannot enforce fails `session.open` with
`policy_unenforceable`. It is never silently ignored. The provider switch is
the first line of defence. If a provider starts a sub-agent anyway, Core stops
it, marks it `stopped` with reason `policy` and journals a
`policy.subagent_blocked` diagnostic. This happens on codex-cli 0.160.1 with
`gpt-6.1-sol`, whose multi-agent tools ignore `features.multi_agent=false`.

## Behaviour verified against real CLIs

The drivers are pinned by recorded transcripts of Claude Code 2.1.285 and
codex-cli 0.153.4 and 0.160.1. The ones that matter most:

- **Claude:**
  - A sub-agent's status is re-entrant: it reports completion, then restarts when a shell it backgrounded finishes.
  - The parent agent may say a sub-agent is done before it is. Hosts should show the sub-agent's state, not the parent's prose.
- **Codex:**
  - A sub-agent keeps running after the parent's turn completes, as long as the resident process lives.
  - The parent only reacts when it calls `wait` or receives new input.
  - 0.160 announces a sub-agent with a `subAgentActivity` item (`started`, `interacted`, `interrupted`, `completed`). The item has a path name (`/root/run_tests`) and no prompt, and it arrives before the child's first turn.
- **Both:** on Stop, Claude reports stopped tasks before it exits. Codex sub-agents stop individually by interrupting their own thread.

## Tests and fixtures

Every driver passes the shared conformance kit
(`specrails-core/agent-runtime/session/testing` → `DRIVER_CONFORMANCE`).
Claude and Codex are tested by replaying the recorded transcripts through
their real transport and translator. Re-capture them with:

```sh
SPECRAILS_LIVE_PROVIDER_SMOKE=1 node scripts/capture-session-fixtures.mjs all
```

This calls paid providers with cheap models and never runs in CI. Source-level
details, including the driver contract and process ownership, are in
[`src/agent-runtime/session/drivers/README.md`](../../src/agent-runtime/session/drivers/README.md).
