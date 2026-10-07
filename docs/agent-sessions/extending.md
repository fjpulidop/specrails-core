# Extending the session runtime

Extension is a reviewed Core change. There is no plugin loading. The seams
below are the only places that need new code.

## Add a provider

1. **Observe it.** Capture real transcripts for one plain turn, foreground and
   background sub-agents (if any), a stop and a resume. Record what you find
   in the change's `reference/provider-findings.md`.
2. **Declare it.** Create `src/agent-runtime/session/drivers/<id>/` with a
   frozen `DriverDescriptor`. Declare only capabilities the provider really
   has; `validateDescriptor` rejects incoherent combinations.
3. **Translate it.** Write a pure translator from wire frames to `DriverEvent`s.
   Unknown frames become one `provider.unknown` diagnostic. Provider vocabulary
   stays in the folder; the architecture test enforces this.
4. **Transport it.** Use `drivers/common/process.ts` for resident processes,
   or adapt an existing `AgentExecutor` with `drivers/executor/`.
5. **Register it** in `drivers/registry.ts`.
6. **Prove it.** Add a conformance harness and fixture-based scenarios. The
   shared `DRIVER_CONFORMANCE` checks must pass unchanged.

## Add a policy field

1. Add the field to `SessionPolicy`/`SessionPolicyInput` and its protocol
   schema, with a backwards-compatible default.
2. Validate it against driver capabilities in `domain/policy.ts`. If some
   drivers cannot enforce it, add a capability and refuse with
   `policy_unenforceable`.
3. Map it in each driver's argv/config builder and test the mapping.

## Add an event type

1. Add it to `SessionEventBody` and `SESSION_EVENT_TYPES`, and fold it in
   `domain/snapshot.ts`.
2. Update `integration-contract.json` (`agentRuntime.sessions.eventTypes`).
   The contract test fails until both match.
3. Hosts ignore unknown event types, so a new type is not a breaking change.
   Changing the meaning of an existing payload requires a new protocol version.

## Change the journal schema

Append a migration to `journal/schema.ts`. Never edit or reorder a shipped
one. Cover it with a test that opens a journal written by the previous version.
