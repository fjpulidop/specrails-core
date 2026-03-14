---
change: smart-feature-ordering
type: feature
status: proposed
github_issue: 38
vpc_fit: 82%
---

# Smart Feature Ordering & Dependency Detection

## Problem Statement

The product-driven backlog today is a flat list ranked by VPC persona score and effort. This ranking is blind to prerequisite relationships between features. A founder using `/product-backlog` might see "Subscription Billing" ranked #1 and attempt to implement it — only to discover mid-implementation that the "Payment System" it depends on does not exist yet. This breaks sprint planning, wastes implementation cycles, and erodes trust in the backlog as an actionable artifact.

The issue is that prerequisite information is already present (the `Prerequisites` field in each GitHub Issue body) but is never used. It is captured during product discovery, written into every issue, and then ignored by every downstream command.

## Proposed Solution

Extend `/product-backlog` to read the `Prerequisites` field from each issue body, build a directed acyclic graph (DAG) of feature dependencies, and produce two new outputs:

1. **Dependency-aware rendering**: Each issue in the backlog table gains a `Prereqs` column that lists its prerequisite issue numbers. Features with unmet prerequisites are marked with a warning indicator.

2. **Safe implementation order**: After the main backlog table, a new section shows topologically sorted implementation order — which features can start immediately (no unmet prerequisites) and which must wait.

No new commands are added. No new config keys are added. No schema changes to GitHub Issues are required — the `Prerequisites` field already exists. This is a pure enhancement to the reading and rendering logic in `/product-backlog`.

## Success Criteria

- `/product-backlog` displays a `Prereqs` column in backlog tables showing prerequisite issue numbers (or "—" if none).
- Features with unmet prerequisites (the prerequisite issue is still open and unimplemented) are marked with `[blocked]` in the table.
- A new "Safe Implementation Order" section appears at the end of the backlog output showing wave-grouped ordering.
- If a circular dependency is detected in the backlog data, a clear warning is displayed and the circular chain is named.
- The "Recommended Next Sprint (Top 3)" section only selects features that have all prerequisites met (i.e., prerequisite issues are closed or do not exist in the backlog).
- No changes are needed to how issues are written or to the install.sh installer.

## Out of Scope

- Automatic prerequisite inference from feature descriptions (NLP/AI analysis). The field is already written by the Explore agent.
- Modifying `/update-product-driven-backlog` to validate prerequisites at creation time.
- Adding Mermaid diagram rendering (ASCII is sufficient for this phase; Mermaid can be a follow-up).
- JIRA provider support for dependency graph (GitHub Issues only in this change).
