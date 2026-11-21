# Core definition engine

Core executes immutable workflow definitions through LangGraph with a SQLite run ledger. Desktop owns workflow recipes, editable loop agents, project selection, worktrees, scheduling and delivery; Core owns graph execution, checkpoints, verification and provider accounting.

- [Architecture and ownership](architecture.md)
- [Definition format and reference workflows](definition-format.md)
- [Piece catalog](pieces.md)
- [Extending the engine](extending.md)
- [Recovery, forks and steering](recovery.md)
- [Observation and trace correlation](observation.md)
- [Desktop integration contract](desktop-integration.md)
- [Legacy runtime and configuration](../agent-runtime.md)
- [Measured platform experiments](spikes/README.md)

Core advertises engine 2 with node catalog 9 (`nodeKindsVersion`), including `workflowAgentSteps: 1` and legacy `implementationSteps: 1`; hosts gate on the capabilities `runtime api` reports, not on the package version. Engine 1, the built-in workflow 7 pipeline, remains available for saved runs. Continue old executions with their retained original package.
