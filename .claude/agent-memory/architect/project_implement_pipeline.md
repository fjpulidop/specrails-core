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

**Architect output:** always goes to `openspec/changes/<name>/` (not cached in dry-run)
**Developer output:** written to working tree (or cache in dry-run mode)

**Input modes:**
1. Issue numbers: `#85, #71` — fetched via `gh issue view`, skips Phase 1+2
2. Text description: single-feature mode, skips Phase 1+2
3. Area names: triggers Phase 1+2 exploration

**Change name derivation:** kebab-case from issue title or text description.

---

## Pending pipeline change: security-reviewer agent (Issue #4)

OpenSpec artifacts created at `openspec/changes/security-reviewer-agent/`.

The planned Phase 4 structure after this change ships:
```
4b.     Launch Reviewer agent (CI/quality gate)
4b-sec. Launch Security Reviewer agent (security gate)
4c.     Ship — blocked if SECURITY_BLOCKED=true
4d.     Monitor CI
4e.     Report (Security column added to table)
```

`SECURITY_STATUS:` (last line of security-reviewer output): `BLOCKED | WARNINGS | CLEAN`

New variable: `SECURITY_BLOCKED` — set from security-reviewer output, gates Phase 4c.
