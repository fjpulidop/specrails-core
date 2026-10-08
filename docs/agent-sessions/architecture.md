# Agent session runtime architecture

The agent session runtime makes Core the single engine for interactive agent
work: missions, explore chats, refinements and any future conversational
surface. A host application, such as Specrails Desktop, starts one long-lived
session host per scope and drives it over the [session protocol](protocol.md).
The host owns product rules and presentation; Core owns provider processes,
sub-agents, usage semantics and durable session state.

The batch runtime (`runtime run|resume`, engine v1/v2, `ExecutorRegistry`) is
a separate subsystem and is unchanged by this one.

## Layers

```
src/agent-runtime/session/
  domain/        pure model: events, state machines, reducers, policy, usage, interruption notice
  application/   use cases and supervision; depends only on domain + ports
  ports.ts       narrow interfaces owned by the application
  drivers/       one folder per provider (+ common/), registry.ts wires them
  journal/       SQLite implementation of the SessionJournal port
  host/          JSON-RPC stdio server
  testing/       fixture replayer and driver conformance kit
  index.ts       composition root: createSessionRuntime()
```

Dependencies point inward:

```
domain ← application ← { drivers | journal | host } ← index.ts ← cli.ts (runtime host)
```

`src/architecture.test.ts` enforces this:

- `domain/` imports only `domain/` and `src/shared/`, with no package or `node:` imports;
- `application/` imports only `domain/`, `application/`, `ports.ts` and `src/shared/`;
- `drivers/`, `journal/` and `host/` never import each other, and drivers and journal never import `application/`;
- a driver folder never imports another driver folder (`common/` is shared);
- only `agent-runtime/cli.ts` imports `host/`;
- no code outside `drivers/` compares an id with a provider name.

## Design principles

| Principle | How it is applied |
| --- | --- |
| Single responsibility | Translators interpret provider frames; transports move bytes; the session service applies use cases; the supervisor owns timers; the journal persists; handlers map protocol to use cases. |
| Open/closed | A new provider is a new `drivers/<id>/` folder, a registry entry and a passing conformance run. A new policy field is a domain value plus per-driver mapping. Existing code does not change. |
| Liskov substitution | Every driver passes the same [conformance kit](drivers.md#conformance). Capabilities are declared in the descriptor and never faked. The application adapts to declarations, not to provider ids. |
| Interface segregation | `DriverSession` exposes send, interrupt, stop sub-agents and close; the journal port exposes append, read and baseline operations. Batch `AgentExecutor` is not widened. An adapter connects it instead. |
| Dependency inversion | Application code depends on `ports.ts`. Processes, SQLite, clocks and ids are injected at the composition root. |

Patterns, used where they solve a real problem:

- **Strategy + Registry:** drivers in a closed, frozen registry, like `PieceRegistry`.
- **Adapter / anti-corruption layer:** a pure translator per provider, `(state, frame) → {state, events}`.
- **Event sourcing:** an append-only, gap-free event sequence per session; every read model is a fold over it.
- **State machines:** transition tables for session, turn, input and sub-agent; illegal transitions are typed errors.
- **Command:** one validated handler per protocol method.
- **Observer:** notifications fan out committed events only.
- **Facade:** `createSessionRuntime()` is the single wiring point.

Not used: DI containers, service locators, base-class hierarchies, plugins.
Extension is a reviewed Core change.

## Ownership split with the host

| Core (this subsystem) | Host (e.g. Desktop) |
| --- | --- |
| Provider processes, argv/config, tree-kill | When to open, update and close sessions |
| Turn delimitation, continuation turns, input receipts | Queue UX, steer/edit/delete before delivery, read receipts |
| Sub-agent tree, policy enforcement | Whether sub-agents are allowed (product setting) |
| Usage deltas, billed vs estimated | Accounting projection, budgets, dashboards |
| Journal under `~/.specrails/sessions/<scope>/` | Rebuildable projection in its own database |
| Interruption notice, never auto-relaunch | Relaunch affordances that only draft user input |
| MCP server set as given by policy | Which MCP servers and capabilities to grant |

## Durability and crash semantics

- Events are committed before any notification. A provider write happens only after its input is committed, so a crash in between yields `input.interrupted`, never a replay.
- A restarted host marks running turns, inputs and sub-agents `interrupted` (reason `restart`). It starts no provider process until a client opens the session.
- One host owns a scope's journal through an epoch-fenced lease. Stale owners are fenced.

See [journal.md](journal.md) for storage details, [drivers.md](drivers.md) for
the driver contract and [extending.md](extending.md) for adding providers or
policies. Provider wire behaviour behind these decisions is recorded in the
`agent-session-runtime` OpenSpec change (`reference/provider-findings.md`).
