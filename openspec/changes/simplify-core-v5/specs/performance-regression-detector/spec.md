# Delta Spec: performance-regression-detector

## REMOVED Requirements

### Requirement: Performance regression detector agent
**Reason**: `sr-performance-reviewer` is removed in v5 (zero OpenSpec integration; an optional Phase 4b pass). Performance review consolidates into the single `sr-reviewer` pass, whose checklist covers regressions at review depth appropriate to the change.
**Migration**: Teams needing a dedicated performance gate copy the v4 `sr-performance-reviewer.md` body to `.claude/agents/custom-performance-reviewer.md` and declare it in a profile. The `templates/settings/perf-thresholds.yml` settings template and the main spec directory `openspec/specs/performance-regression-detector/` are deleted.
