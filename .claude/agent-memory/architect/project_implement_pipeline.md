---
name: implement command pipeline
description: Phase structure, variable conventions, and insertion points for the /implement command
type: project
---

The `/implement` command pipeline phases in order:

```
Phase -1  Environment Setup (cloud pre-flight)
Phase 0   Parse input and determine mode
Phase 1   Explore (parallel, product-manager agents) — only if area names passed with no backlog
Phase 2   Select — only if Phase 1 ran
Phase 3a  Architect (parallel) — creates openspec/changes/<name>/
  3a.1  Identify shared file conflicts
  3a.2  Pre-validate architect output
Phase 3b  Implement (developer agents)
Phase 4   Merge & Review
  4a. Merge worktree changes to main repo
  4b. Launch Reviewer agent
  4c. Ship — Git & backlog updates
      [GIT_AUTO=true section]
      [GIT_AUTO=false section]
      [Backlog updates — BACKLOG_WRITE gated]
  4d. Monitor CI
  4e. Report
Error Handling
```

**Key variables:**
- `SINGLE_MODE` — true when only one feature, disables worktrees
- `GIT_AUTO` — controls automatic git ops in 4c
- `BACKLOG_WRITE` — controls issue commenting in 4c
- `GH_AVAILABLE` — set in Phase -1 from gh auth status
- `SHARED_FILES` — map of `{path: {features, risk}}`, set by Phase 3a.1 in multi-feature mode
- `MERGE_ORDER` — ordered feature list for Phase 4a, derived in Phase 3a.1
- `MERGE_REPORT` — merge outcome accumulator: `cleanly_merged`, `auto_resolved`, `requires_resolution`

**Architect output:** always goes to `openspec/changes/<name>/` (not cached in dry-run)
**Developer output:** written to working tree (or cache in dry-run mode)

**Input modes:**
1. Issue numbers: `#85, #71` — fetched via `gh issue view`, skips Phase 1+2
2. Text description: single-feature mode, skips Phase 1+2
3. Area names: triggers Phase 1+2 exploration

**Change name derivation:** kebab-case from issue title or text description.

---

## Pending pipeline change: specialized-layer-reviewers (Issue #40)

OpenSpec artifacts created at `openspec/changes/specialized-layer-reviewers/`.

The planned Phase 4 structure after this change ships:
```
4b.     Layer Dispatch and Review
  Step 1: Layer Classification (orchestrator, no agent launch)
  Step 2: Launch layer reviewers in parallel (run_in_background: true)
          - frontend-reviewer (if FRONTEND_FILES non-empty)
          - backend-reviewer  (if BACKEND_FILES non-empty)
          - security-reviewer (always)
  Step 3: Launch generalist reviewer (foreground) with layer reports injected
[4b-sec removed — security-reviewer moves to 4b Step 2]
4c.     Ship — SECURITY_BLOCKED gate stays here, unchanged
4d.     Monitor CI
4e.     Report (Frontend and Backend columns added to table)
```

Status line protocols:
- `FRONTEND_REVIEW_STATUS: ISSUES_FOUND | CLEAN` (last line)
- `BACKEND_REVIEW_STATUS: ISSUES_FOUND | CLEAN` (last line)
- `SECURITY_STATUS: BLOCKED | WARNINGS | CLEAN` (unchanged)

Runtime injection notation for reviewer.md: use `[injected]` placeholder blocks, NOT `{{...}}` — avoids `/setup` mishandling.

Layer classification: heuristic-based, matches on file extension + directory path segments. Files can be classified as both frontend and backend.
