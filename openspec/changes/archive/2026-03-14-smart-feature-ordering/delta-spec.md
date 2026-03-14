---
change: smart-feature-ordering
type: delta-spec
---

# Delta Spec: Smart Feature Ordering & Dependency Detection

## Scope

This change modifies the behavior of the `/product-backlog` command only. No other commands, templates, specs, or configuration files are changed.

---

## Behavioral Specifications (SHALL statements)

### Prerequisite Parsing

**BP-1.** The product-analyst agent SHALL parse the `Prerequisites` row from each GitHub Issue's Overview table when rendering the backlog.

**BP-2.** The agent SHALL extract all `#N` references from the Prerequisites cell and treat each as a prerequisite issue number.

**BP-3.** If the Prerequisites cell is `None`, `-`, or empty, the agent SHALL treat the feature as having no prerequisites.

**BP-4.** If a prerequisite issue number `#N` does not appear in the currently fetched open backlog issues, the agent SHALL treat that prerequisite as already satisfied (externally closed or out-of-scope).

### Dependency Graph

**BP-5.** The agent SHALL construct a directed acyclic graph where each edge `(A → B)` means "issue A must be completed before issue B can start."

**BP-6.** The agent SHALL detect circular dependencies using depth-first search before rendering any output.

**BP-7.** If one or more cycles are detected, the agent SHALL render a warning block before the backlog table naming the issues involved in each cycle.

**BP-8.** Cycle detection MUST NOT prevent the rest of the backlog from rendering. Cycle members are marked `[cycle]` in the table and excluded from the Safe Implementation Order section.

### Backlog Table

**BP-9.** The backlog table SHALL include a `Prereqs` column as the rightmost column in each area table.

**BP-10.** The `Prereqs` cell SHALL list prerequisite issue numbers as `#N, #M` or `—` if none.

**BP-11.** Issues that have at least one unmet prerequisite (a prerequisite that is itself an open backlog issue) SHALL be marked with `[blocked]` appended to the issue title cell.

**BP-12.** Issues that are members of a detected cycle SHALL be marked with `[cycle]` appended to the issue title cell instead of `[blocked]`.

### Top 3 Recommendations

**BP-13.** The "Recommended Next Sprint (Top 3)" section SHALL only include features whose in-degree in the dependency graph is zero (all prerequisites satisfied or external).

**BP-14.** If fewer than 3 unblocked features exist, the agent SHALL display as many as are available and print a note explaining that remaining features have unmet prerequisites.

### Safe Implementation Order

**BP-15.** The agent SHALL render a "Safe Implementation Order" section after the Top 3 recommendations.

**BP-16.** The section SHALL display features grouped into waves using Kahn's topological sort algorithm.

**BP-17.** Within each wave, features SHALL be sorted by Total Persona Score descending (highest-value first).

**BP-18.** The section SHALL include a ready-to-use `/batch-implement` command string with the `--deps` flag computed from the dependency graph edges.

**BP-19.** If no dependencies exist among any backlog items, the Safe Implementation Order section SHALL still render, showing all features in wave 1, and SHALL omit the `--deps` clause from the suggested command.

---

## Non-Changes (explicitly preserved)

- The fetch command, area grouping, persona score parsing, effort parsing, and sorting-within-area logic are unchanged.
- The `--deps` flag format in `/batch-implement` is unchanged.
- The `Prerequisites` field format in issue bodies written by `/update-product-driven-backlog` is unchanged.
- No new config keys are added to `backlog-config.json`.
- No new `{{PLACEHOLDER}}` template variables are introduced.
- No changes to `install.sh` or `openspec/config.yaml`.
