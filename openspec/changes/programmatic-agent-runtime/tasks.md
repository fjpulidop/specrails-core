## 1. Runtime engine

- [x] 1.1 Pin MIT LangGraph dependencies compatible with Node 20.
- [x] 1.2 Implement typed workflow callbacks, durable state, locking, recovery, approvals and bounded graph execution.
- [x] 1.3 Verify engine with offline cancellation, recovery, version, budget and transition tests.

## 2. Providers and tools

- [x] 2.1 Implement validated provider/role configuration and executor registry.
- [x] 2.2 Implement portable Claude, Codex, Gemini and Kimi executors with capability validation.
- [x] 2.3 Implement OpenAI-compatible API tool loop with scoped file tools, bounds and no mandatory key.
- [x] 2.4 Verify provider and tool contracts, including Windows argv and local HTTP fixtures.

## 3. Core integration

- [x] 3.1 Implement central role instructions and structured outputs, Core gate host and deterministic verification/archive.
- [x] 3.2 Expose run/status/resume/config validation CLI and packaged programmatic exports.
- [x] 3.3 Verify complete offline workflow, invalid receipts, CLI packaging and existing Core regression suite.
- [x] 3.4 Document configuration, custom provider registration, local model setup, migration and recovery.
