# Core definition engine

Core executes immutable workflow definitions through LangGraph with a SQLite run ledger. Desktop owns project selection, worktrees, scheduling and delivery; Core owns graph execution, checkpoints, verification and provider accounting.

- [Architecture and ownership](architecture.md)
- [Definition format and reference workflows](definition-format.md)
- [Piece catalog](pieces.md)
- [Extending the engine](extending.md)
- [Recovery, forks and steering](recovery.md)
- [Desktop integration contract](desktop-integration.md)
- [Legacy runtime and configuration](../agent-runtime.md)
- [Measured platform experiments](spikes/README.md)

This branch advertises engine 2 and node catalog 1. Publication requires the paired integration and platform gates; capability metadata is not rollout evidence. Engine 1 retains its frozen workflow 7, instructions 10 and API 1 contracts. Run old executions through their retained original package.
