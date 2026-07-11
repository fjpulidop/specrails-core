# Delta Spec: smart-merge-resolver

## REMOVED Requirements

### Requirement: Dedicated smart merge conflict resolver agent
**Reason**: `sr-merge-resolver` is removed in v5 (zero OpenSpec integration; only consumer was batch-implement's multi-worktree mode). The built-in merge algorithm (section-aware Markdown merge + `patch --forward --fuzz=3`, with conflict markers and the merge report) — which was already the fallback when the agent was absent — becomes the only conflict path, owned by the orchestrator (see the `batch-implement` delta).
**Migration**: No action for most users — the fallback behavior is identical to running v4 without the agent installed. Teams that relied on agent-driven resolution can copy the v4 `sr-merge-resolver.md` body to `.claude/agents/custom-merge-resolver.md` and declare it in a profile. The legacy prose spec file `openspec/specs/smart-merge-resolver.md`, the `merge-resolve.md` command template, and the codex `merge-resolve` skill are deleted.
