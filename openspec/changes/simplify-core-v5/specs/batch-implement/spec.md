# Delta Spec: batch-implement

## ADDED Requirements

### Requirement: Orchestrator-owned conflict resolution
Batch waves SHALL NOT delegate merge-conflict resolution to a dedicated agent. When integrating parallel feature branches/worktrees produces a conflict, the orchestrator SHALL first apply the built-in merge algorithm (section-aware for Markdown, `patch --forward --fuzz=3` for other files); if conflict markers remain that it cannot resolve confidently, it SHALL stop the affected wave and report the conflicting files in the final batch report instead of guessing.

#### Scenario: Auto-resolvable conflict
- **WHEN** two features in the same wave touch structurally distinct regions of the same file
- **THEN** the orchestrator merges them with the built-in algorithm and records the file under "Auto-Resolved" in the batch report

#### Scenario: Unresolvable conflict
- **WHEN** the built-in merge leaves conflict markers the orchestrator cannot resolve
- **THEN** the wave halts for the affected features, remaining independent features continue, and the batch report lists the conflicting files under "Requires Manual Resolution"

#### Scenario: No sr-merge-resolver references remain
- **WHEN** the batch-implement command template (all providers: claude md, gemini toml, codex skill) is searched for `sr-merge-resolver` or `merge-resolve`
- **THEN** zero matches are found
