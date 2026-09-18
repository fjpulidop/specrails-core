## Context

The observed job stopped an active developer at 900 seconds. Explicit continuation opened a different Codex session and repeated setup. A 219KB CLAUDE.md was read wholesale. Vite caches pointed outside the writable worktree and native tests lacked their generated sidecar. The solution must preserve provider independence, official OpenSpec and frozen scope.

## Goals / Non-Goals

Goals: preserve recoverable work and provider continuity, bound time/context, expose accurate limits, and make isolated test setup predictable.
Non-goals: automatic paid retry loops, broader permissions, manufactured test evidence, weakening acceptance criteria, replacing OpenSpec or replaying a completed phase.

## Decisions

- Separate total `limits.timeoutMs` from `limits.idleTimeoutMs`. Defaults for new runtime calls are 60 and 15 minutes respectively. Explicit total limits retain their meaning. Stream activity resets idle only; total never extends. Timer diagnostics identify which deadline fired.
- Persist validated provider session metadata while streaming, bound to provider/model/effort/workspace identity. Codex continuation requires verified transport support. Explicit recovery resumes that identity; unsupported/unavailable sessions use a bounded full-context fallback and never pretend to resume.
- Both timeout and cancellation during writes require explicit recovery after the process tree closes. Neither is acceptance or permission to rerun automatically.
- A small atomic progress journal records completed work, next actions, useful test commands and blockers through the scoped OpenSpec bridge. It is returned by load_skill and remains advisory. Official task status and fresh verification remain authoritative.
- Large instruction documents yield bounded indexes with section/line references. Prompts request relevant sections and reference patterns instead of whole documentation trees.
- Worktrees reuse installed packages but keep writeable caches inside their own root. Native prerequisites are inspected before agent work; actual reusable generated artifacts can be reused, otherwise report the missing prerequisite and existing preparation command without fake binaries or fabricated success.

## Risks / Trade-offs

- Provider resume support varies → verify capability, retain identity guards and bounded cold fallback.
- Longer active calls can consume more → finite total, existing cost/turn limits and visible configuration remain enforced; no automatic retry.
- Progress can be stale → advisory record, read actual worktree/task state and independently verify.
- Warm dependencies are shared → package targets stay protected; only local caches are writable and cleanup recognizes host-owned entries.
- Old retained runtime behavior differs → retain frozen version; new semantics apply to newly created runs using this runtime.

## Migration Plan

Ship paired Core/Desktop changes, with focused cross-boundary tests and build validation. Preserve existing explicit timeout settings and original run identities. Roll back by selecting the previous package; do not rewrite existing checkpoints. No npm publication in this task.
