## Why

Specrails needs explicit programmatic agent execution, durable recovery and provider configuration without duplicating orchestration in platform prompts. Existing Core gates and all four supported coding providers must remain authoritative and usable on macOS and Windows.

## What Changes

- Add an embeddable TypeScript workflow runtime using MIT-licensed LangGraph, with durable state, structured phase events, bounded execution and cancellation.
- Add a provider registry with Claude, Codex, Gemini and Kimi CLI executors and an OpenAI-compatible tool executor for local or remote endpoints; credentials are environment references.
- Add validated configuration, programmatic registration and a standalone runtime CLI integrated with Core verification gates.
- Preserve legacy commands and profile v1; configured runtime execution uses individual roles, never nested implement orchestration.
- Add offline regression tests, packaged runtime exports and cross-platform documentation.

## Capabilities

### New Capabilities
- `programmatic-agent-runtime`: explicit, recoverable workflows and extensible coding executors.

### Modified Capabilities

None. Existing legacy pipeline contracts remain supported.

## Impact

Core runtime modules, CLI dispatch, package dependencies and packaging, documentation and tests. Desktop consumes the same packaged runtime through its host integration. No paid orchestration service or proprietary new framework is required.
