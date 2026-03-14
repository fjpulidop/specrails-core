---
name: implement-command-structure
description: Phase ordering and key insertion points in the implement pipeline command
type: project
---

The implement pipeline lives in two files that must always be kept in sync:
- `templates/commands/implement.md` — the template (has `{{PLACEHOLDER}}` strings)
- `.claude/commands/implement.md` — the generated specrails instance (no placeholders)

**Why:** The template is installed into target repos. The .claude/ copy drives the pipeline when using specrails itself.

### Phase order (as of automated-test-writer change)

```
Phase -1: Environment Setup
Phase 0:  Parse input and determine mode
Phase 1:  Explore (parallel)
Phase 2:  Select
Phase 3a: Architect (parallel, in main repo)
Phase 3b: Implement
Phase 3c: Write Tests   ← NEW (after 3b "Wait for all developers to complete.")
Phase 4:  Merge & Review
  4a. Merge worktree changes
  4b. Launch Reviewer agent
  4b-sec. Launch Security Reviewer agent
  4c. Ship
  4d. Monitor CI
  4e. Report
```

### Phase 4e report table column order

```
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
```

Tests column is between Developer and Reviewer, reflecting pipeline execution order.

### Key insertion anchor lines

- Phase 3c is inserted AFTER: "Wait for all developers to complete."
- Phase 3c is inserted BEFORE: "## Phase 4: Merge & Review"
