# Programmatic implementation

## Requirement: One implementation engine
All new implementation requests SHALL use the programmatic agent runtime. The installed implement and batch-implement commands SHALL admit one immutable context and invoke the same workflow. Multiple tickets SHALL share one aggregate scope. Provider-native phase orchestration SHALL NOT run.

## Requirement: Durable execution
Core SHALL own architect, developer, verification, reviewer and archive phases. Resuming SHALL use the exact saved context and configuration. Host ownership of worktrees, Git and backlog SHALL remain enforced. Completion SHALL require current verification and acceptance evidence.

## Requirement: Configuration
Desktop SHALL resolve app-wide provider connections and project role assignments for new executions and freeze the resolved configuration. Standalone installs SHALL provide a runtime launcher and an initial configuration. Missing runtime tooling SHALL fail clearly without a legacy fallback.
