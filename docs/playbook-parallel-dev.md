# Parallel Development

> For maintainers shipping multiple features in a sprint who want to maximize throughput without introducing merge conflicts.

## How specrails parallelizes work

When you pass multiple issue numbers to `/specrails:batch-implement`, specrails spawns one git worktree per feature. Each worktree has its own branch, its own isolated copy of the working tree, and its own full agent pipeline running concurrently. Features do not queue — they run in parallel from Phase 3a (Architecture) through Phase 5 (PR creation).

This is not a simulation of parallelism. Each pipeline is a separate Claude Code session with no shared state. The Architect for issue #71 has no visibility into the Architect for issue #63. Each Developer commits to its own branch. Each Reviewer runs CI independently. The worktrees are merged into the base branch at the end of the batch run.

The speed advantage over sequential implementation is significant. For a batch of three medium-effort features, sequential implementation might take 90 minutes. Parallel implementation takes roughly as long as the slowest single feature — often 30–40 minutes. The constraint is wall-clock time, not the number of features.

## What's safe to parallelize

Not every combination of features is safe to run in parallel. A feature is safe to include in a parallel batch when all four conditions hold:

1. **File isolation**: the feature touches different files from the other features in the batch. Two features that both modify `src/api/middleware.ts` will produce a merge conflict.

2. **No shared data model changes**: the feature does not depend on a schema migration, new database table, or new shared utility introduced by another feature in the same batch. If feature A adds a `users.rate_limit_tier` column and feature B reads that column, B depends on A.

3. **Spec is complete**: the feature's OpenSpec change is fully approved before the batch runs. Specs that are still being revised during implementation produce inconsistent results.

4. **Wave 1 in the dependency DAG**: the feature has no unimplemented prerequisites. A feature with `Prerequisites: #71` cannot run in the same batch as #71 — it must wait for #71 to ship first.

When in doubt, run `/specrails:get-backlog-specs` to see the dependency ordering before composing your batch.

## What's not safe

Some combinations look independent but are not:

**Two features that both modify the same schema file.** Even if the migrations are logically independent (adding different columns to different tables), they both touch `db/schema.sql` or the migration directory. The merge will conflict or produce an incorrect combined schema.

**A feature that requires a utility extracted by another feature in the same batch.** If issue #71 refactors authentication middleware into a shared utility, and issue #85 uses that utility, #85 cannot run in the same batch as #71. At the time #85's Developer runs, the shared utility doesn't exist yet.

**Features with a `Prerequisites:` relationship to each other.** If issue #85 has `Prerequisites: #71` in its issue body, the Product Analyst's dependency DAG already captures this. Running them together ignores the declared ordering.

**Features where the spec says "depends on the outcome of X".** This phrasing signals a runtime dependency that may not be captured in the `Prerequisites:` field. Treat it as an explicit exclusion from the current batch.

## Reading the dependency DAG

Run `/specrails:get-backlog-specs` before composing any parallel batch. The output includes a prioritized backlog table with dependency metadata. Wave 1 features — those with no unimplemented prerequisites — are your safe parallel batch candidates.

```
/specrails:get-backlog-specs

┌─ API ──────────────────────────────────────────┐
│ #  Issue   Score  Effort  Description           │
│ 1  #85     12/15  Medium  Health check endpoint │
│ 2  #71     10/15  Low     Rate limiting          │
│ 3  #63      8/15  High    GraphQL migration      │
└─────────────────────────────────────────────────┘

Top 3 for next sprint:
1. #71 — Rate limiting (score/effort: 3.33)
2. #85 — Health check (score/effort: 2.40)
3. #63 — GraphQL (score/effort: 0.53)
```

The backlog output shows effort and score, but it does not explicitly label Wave 1 vs. Wave 2. You determine Wave 1 by reading the `Prerequisites:` field on each issue. Any issue whose prerequisites are all already merged is a Wave 1 candidate.

Use the Product Analyst's reasoning section (shown when running with verbose output) to confirm the dependency ordering before batching.

## Practical example

Three issues are in your sprint: #85 (health check endpoint), #71 (rate limiting middleware), and #63 (GraphQL migration).

Reading the issue bodies:
- #85 has `Prerequisites: #71` — the health check reads the rate limit status, so it needs the middleware to exist first.
- #71 has no prerequisites.
- #63 has no prerequisites.

#71 and #63 are independent of each other and have no prerequisites. They are Wave 1. Run them in parallel:

```
/specrails:batch-implement #71, #63
```

Both pipelines run concurrently. Each produces a PR. After both PRs are merged, #85 is unblocked. Run it alone:

```
/specrails:implement #85
```

Attempting to include #85 in the first batch would have caused the Developer for #85 to run without the rate limiting middleware in place, producing code that imports a module that doesn't exist yet.

## When auto-merge fails

After all worktree pipelines complete, specrails attempts to merge each feature branch into the base. When the merge succeeds automatically, each feature gets its own PR. When it fails, specrails surfaces the conflict and stops.

**Symptom**: merge conflict reported in the worktree merge step, pipeline exits before PR creation for one or more features.

**Cause**: two features edited the same region of the same file. This happens most often in configuration files, shared utilities, or index files that aggregate exports.

**Recovery**:
1. Note which features conflicted.
2. Pick one feature's branch as the base. Merge it into the base branch first (it will succeed — the conflict is between the two feature branches, not between either and base).
3. For the conflicting feature branch, manually resolve the conflict by merging the base branch into it.
4. Once the conflict is resolved, the Developer can rerun from Phase 5 (PR creation) to create the PR with the resolved branch.

**Prevention**: run the safe parallelization criteria before batching. Index files and configuration files are common conflict sources — if two features both register something in the same registry or config object, consider whether they should be sequenced instead.

## Patterns & Anti-patterns

| Pattern | Why it works |
|---------|-------------|
| Run `/specrails:get-backlog-specs` before composing a batch | Surfaces the dependency DAG so you batch only Wave 1 features |
| Keep batches to 2–4 features | Smaller batches reduce conflict surface area and keep the merge step fast |
| Ensure all specs are approved before starting the batch | Prevents mid-batch spec revisions that invalidate a running pipeline |
| Sequence database migration features before features that consume the schema | Eliminates the most common class of parallel dev failures |

| Anti-pattern | Why it fails |
|-------------|-------------|
| Batching features that share a configuration or registry file | Almost guarantees a merge conflict in a file that both features modified |
| Including a feature whose prerequisite is also in the batch | The dependent feature's Developer runs before the prerequisite exists, producing broken imports and missing types |
| Running a batch before all specs are written | An incomplete spec causes the Architect to make assumptions; you may get a PR for a feature that was redefined mid-run |
| Treating all "unrelated" features as parallelizable | "Unrelated" at the product level can still mean "touching the same file" at the code level — verify file isolation, not just feature isolation |

## What's next?

- [Workflows & Commands](workflows.md) — full reference for `/specrails:batch-implement`, `/specrails:implement`, and `/specrails:get-backlog-specs`

---

[← Product Discovery](playbook-product-discovery.md) · [OSS Maintainer Workflow →](playbook-oss-maintainer.md)
