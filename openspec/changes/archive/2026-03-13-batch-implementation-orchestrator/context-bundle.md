---
change: batch-implementation-orchestrator
type: context-bundle
---

# Context Bundle: Batch Implementation Orchestrator

This document is a self-contained developer briefing. You do not need to read any other file to execute these tasks.

---

## What You Are Building

You are creating a new `/batch-implement` command that acts as a macro-orchestrator above the existing `/implement` pipeline. It allows a product lead to implement 5–10+ features with dependency ordering, concurrency caps, and a live progress dashboard — without managing multiple `/implement` invocations manually.

**Critical constraint: do not touch `/implement`'s internals.** The batch orchestrator drives `/implement` from the outside by calling it per wave. It does not reach into implement's phases, does not duplicate pipeline logic, and does not modify `templates/commands/implement.md` or `.claude/commands/implement.md` in any meaningful way.

You will:
1. Create `templates/commands/batch-implement.md` — the new command template
2. Create `.claude/commands/batch-implement.md` — the generated specrails-adapted copy
3. Create `openspec/specs/batch-implement.md` — the normative spec
4. Add a one-line informational note to `openspec/specs/implement.md`

---

## Files to Change

| File | Change Type | Notes |
|------|-------------|-------|
| `templates/commands/batch-implement.md` | Create | New command template; uses `{{PLACEHOLDER}}` syntax |
| `.claude/commands/batch-implement.md` | Create | Generated copy; all `{{...}}` resolved; no new placeholders |
| `openspec/specs/batch-implement.md` | Create | Normative spec; SHALL/MUST/SHOULD language |
| `openspec/specs/implement.md` | Modify | Add one blockquote note before `## Flags`; no other changes |

**Do NOT modify:**
- `templates/commands/implement.md`
- `.claude/commands/implement.md`
- Any file in `templates/agents/` or `.claude/agents/`
- `install.sh`
- Any existing spec file except `openspec/specs/implement.md` (one-line addition only)
- Any OpenSpec change artifact file (proposal.md, design.md, delta-spec.md, tasks.md — the files you are reading right now)

---

## Structural Reference: How `implement.md` is Organized

Before writing the batch-implement template, understand the structure of `templates/commands/implement.md` at `/Users/javi/repos/specrails/templates/commands/implement.md`:

- The file opens with a title and a **MANDATORY** enforcement block (bold, uppercase instruction to never skip phases)
- Then `**Input:** $ARGUMENTS` documenting accepted input modes
- Then phases numbered from -1 through 4e
- Each phase has a `##` heading and uses `###` for sub-phases
- Condition guards use `**If `FLAG=true`:**` pattern
- Code blocks use triple-backtick with `bash` tag for commands, no tag for output templates
- `{{PLACEHOLDER}}` strings are used for install-time substitutions only

The batch-implement template should follow the same structural conventions.

---

## Phase Structure for `batch-implement.md`

Here is the complete phase map to implement:

### Phase 0: Parse input and detect flags

**Scan `$ARGUMENTS` for:**

- Feature references: `#N` (GitHub) or `PROJ-N` (JIRA) — collect into `FEATURE_LIST`
- Area names: bare words like `Analytics`, `UI` — collect into `AREA_LIST` (resolve via `/implement` Phase 1–2 before wave planning)
- `--deps "<spec>"`: parse into `DEPS_MAP = {dependant: [prerequisites]}`
- `--concurrency N`: set `CONCURRENCY = N` (default: 4)
- `--wave-size N`: set `WAVE_SIZE = N` (default: unlimited)
- `--dry-run` / `--preview`: set `DRY_RUN = true`

**Validate:**
- If any feature in `DEPS_MAP` is not in `FEATURE_LIST`: print error and stop
- If `FEATURE_LIST` has < 2 features and no `AREA_LIST`: print a hint to use `/implement` directly instead

---

### Phase 1: Wave planning

**Step 1: Build dependency graph**

Nodes = all features in `FEATURE_LIST`. For each `(B depends-on A)` pair in `DEPS_MAP`, add directed edge A → B.

**Step 2: Circular dependency detection (Kahn's algorithm)**

```
in_degree = {feature: 0 for each feature}
for each edge A → B: in_degree[B] += 1

queue = [features where in_degree == 0]  # sorted alphabetically
processed = []

while queue is not empty:
  node = queue.pop_front()
  processed.append(node)
  for each B where edge node → B exists:
    in_degree[B] -= 1
    if in_degree[B] == 0: queue.append(B); sort queue alphabetically

if len(processed) < len(FEATURE_LIST):
  # Cycle detected
  cycle_members = [features not in processed]
  print "Error: circular dependency detected: <cycle_members>"
  STOP
```

**Step 3: Assign wave numbers**

Wave assignment falls out of Kahn's algorithm: features processed in the first batch (initial zero-in-degree nodes) = Wave 1; their dependants = Wave 2; etc. Re-run with wave tracking:

```
wave = 1
WAVES = []
current_wave_nodes = [features where in_degree == 0, sorted alphabetically]

while current_wave_nodes is not empty:
  WAVES.append({wave_number: wave, features: current_wave_nodes})

  # Find next wave
  next_wave_nodes = []
  for each feature in current_wave_nodes:
    for each B where edge feature → B:
      in_degree[B] -= 1
      if in_degree[B] == 0: next_wave_nodes.append(B)

  sort next_wave_nodes alphabetically
  current_wave_nodes = next_wave_nodes
  wave += 1
```

**Step 4: Apply concurrency cap**

For each wave where `len(features) > CONCURRENCY`:
- Split into sub-batches of size `CONCURRENCY`
- Sub-batches execute sequentially within the wave
- Record sub-batches in `WAVES[wave].sub_batches`

**Step 5: Apply wave-size constraint**

If `WAVE_SIZE` is set and any wave exceeds `WAVE_SIZE`:
- Check if splitting would separate a feature from its prerequisite (prerequisite and dependant in the same wave would be split into different sub-batches)
- If conflict: print warning `[warn] --wave-size would violate dependency ordering for <features>. Ignoring wave-size for this wave.`
- If no conflict: apply the split

**Step 6: Print execution plan and confirm**

```
## Batch Execution Plan

Batch: N features across K waves, concurrency cap: M

Wave 1 (N features — run in parallel):
  - #ID: Feature title

Wave 2 (N features — max M concurrent):
  - #ID: Feature title  [depends-on #X]

...

Proceed? (y/n)
```

Wait for user confirmation. If user types `n` or `no`: stop.

---

### Phase 2: Wave execution loop

Initialize `BATCH_STATUS = {}` with one entry per feature: `{status: "queued", phase_statuses: {}}`.

For each wave in `WAVES` (in order):

**Step 1: Collect the wave's features**

If the wave has sub-batches: process sub-batches sequentially. Each sub-batch is a list of features.

If no sub-batches: the whole wave is one batch.

**Step 2: Remove blocked features from this wave's batch**

For each feature in this wave's batch, check `BATCH_STATUS[feature].status`. If `blocked`, remove it from the batch for this run. If all features are blocked, skip this wave.

**Step 3: Invoke `/implement` for this batch**

Launch `/implement` with:
- The feature list for this sub-batch (issue numbers or text descriptions)
- `--dry-run` if `DRY_RUN=true`

Pass `--concurrency` through to `/implement` Phase 3b (developer launch).

Wait for the `/implement` invocation to complete. Read its final report table to extract per-feature phase statuses.

**Step 4: Update BATCH_STATUS**

For each feature in the batch, update its status from the `/implement` report:
- Phase columns: `done`, `failed`, `skipped`
- Overall status: `shipped`, `failed`

**Step 5: Apply failure isolation**

For each feature with status `failed`:
- Find all features that directly or transitively depend on it (traverse `DEPS_MAP` forward)
- Set their `BATCH_STATUS.status = "blocked"`
- Print: `Feature #N failed. Blocking dependents: #M, #P.`

**Step 6: Print progress dashboard**

Print the full batch status table (all features, current state):

```
## Batch Progress — Wave W of K complete

| Feature | Wave | Architect | Developer | Tests | Reviewer | Security | CI | Status |
|---------|------|-----------|-----------|-------|----------|----------|----|--------|
| #12: Auth middleware | 1 | done | done | done | done | clean | pass | shipped |
| #15: User profile API | 2 | done | done | done | done | clean | pass | shipped |
| #18: Session mgmt | 2 | — | — | — | — | — | — | queued |
...
```

Status key: `queued` | `in-progress` | `shipped` | `failed` | `blocked`

**Step 7: Early termination check**

If all remaining features across all remaining waves are `blocked`: print summary and go to Phase 3.

---

### Phase 3: Batch report

After all waves complete (or early termination):

```
## Batch Implementation Report

Batch completed: <timestamp>
Duration: <elapsed time>

### Summary

| Metric | Value |
|--------|-------|
| Features requested | N |
| Features shipped | N |
| Features failed | N |
| Features blocked | N |
| PRs created | N |
| Unresolved merge conflicts | N files |
| CI status | N passing, N failing, N pending |

### Per-Feature Results

| # | Feature | Status | PR | CI | Notes |
|---|---------|--------|----|----|-------|
| #ID | Title | shipped/failed/blocked | #PR | pass/fail/— | — |

### Merge Conflicts Requiring Resolution

(Only if conflicts exist)

| File | Features | Conflict Region |
|------|----------|----------------|
| path/to/file | #A, #B | ## Section name |

### Next Steps

- Retry failed features: `/implement #ID`
- Resolve merge conflicts in: <file list>
- Review pending CI for PR #N
```

---

## Placeholder Reference

These `{{PLACEHOLDER}}` strings are used in `templates/commands/batch-implement.md` and must be resolved in `.claude/commands/batch-implement.md`:

| Placeholder | Resolved value (specrails) | Used in |
|-------------|---------------------------|---------|
| `{{BACKLOG_VIEW_CMD}}` | `gh issue view {number}` | Phase 0, when resolving issue titles |
| `{{LAYER_TAGS}}` | `[core]`, `[templates]`, `[cli]` | Not used in batch-implement directly — omit if not needed |

If no new placeholders are needed beyond what `/implement` already uses, and those don't appear in the batch-implement template, the generated `.claude/commands/batch-implement.md` is a verbatim copy with no substitutions.

---

## Exact Change: `openspec/specs/implement.md`

**Location:** After the opening paragraph (before the `## Flags` heading).

Find this exact line in `/Users/javi/repos/specrails/openspec/specs/implement.md`:

```markdown
## Flags
```

Insert this block immediately before it:

```markdown
> **For batches of 5+ features**, consider using `/batch-implement` instead. It adds dependency ordering, concurrency caps, and a batch-level progress dashboard on top of this pipeline.

```

(One blank line after the blockquote, before `## Flags`.)

**Verification:** After the edit, the file should contain `batch-implement` and the `## Flags` heading should immediately follow the blockquote.

---

## Existing Patterns to Follow

- **Command file header**: Open with a title (H1), then a bold MANDATORY enforcement block (see `templates/commands/implement.md` lines 1–5 for the exact pattern). Adapt for batch-implement: "MANDATORY: Execute all waves. NEVER skip the execution plan confirmation."
- **Input documentation**: Use the same `**Input:** $ARGUMENTS — accepts three modes:` format as implement.md.
- **Phase heading style**: `## Phase N: Title`. Sub-phases use `### N.N Sub-title`.
- **Condition guards**: `**If `FLAG=true`:**` followed by bullet list.
- **Algorithm steps**: Use numbered steps in plain prose or within a fenced code block for pseudocode. The Kahn's algorithm steps above use a pseudocode block — keep this style.
- **Report formats**: Fenced code blocks without language tag for output templates (same as Phase 4e in implement.md).
- **Non-blocking failure**: A failed feature NEVER blocks the full batch. Only its dependents are blocked. This mirrors the pipeline's own non-blocking failure pattern.

---

## Conventions Checklist

Before marking any task done:

- [ ] `templates/commands/batch-implement.md` exists and has no broken `{{PLACEHOLDER}}` strings
- [ ] `.claude/commands/batch-implement.md` exists and has zero unresolved `{{...}}` strings (verify with: `grep -n '{{' .claude/commands/batch-implement.md`)
- [ ] `openspec/specs/batch-implement.md` exists and uses SHALL/MUST/SHOULD language throughout
- [ ] `openspec/specs/implement.md` has the blockquote note before `## Flags`; no other lines changed
- [ ] Circular dependency detection is present in Phase 1 of the command
- [ ] User confirmation prompt is present in Phase 1 before any execution
- [ ] Failure isolation logic is present in Phase 2 (only dependents blocked, not full batch)
- [ ] Progress dashboard is printed after each wave (not just at end)
- [ ] Batch report includes all four required sections (summary, per-feature, conflicts, next steps)
- [ ] The command does NOT duplicate any phase logic from `implement.md`; it delegates to `/implement` per wave
- [ ] `--dry-run` pass-through is documented (passed to each `/implement` invocation)

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Template grows very long and becomes hard to read | Medium | Structure with clear phase headings and use pseudocode blocks for algorithms. Keep prose concise. |
| Placeholder inventory gets out of sync (new placeholder in template not resolved in generated copy) | Medium | Task 5 is an explicit verification step: run `grep '{{' .claude/commands/batch-implement.md` and confirm zero output |
| Batch report parsing of `/implement` output is fragile | Medium | The implementation note in Phase 2 Step 3 says to read the final report table. Document the exact column names and values to parse so the implementation is unambiguous |
| `openspec/specs/implement.md` edit accidentally removes surrounding content | Low | The change is a one-line blockquote insertion. Verify line count before and after: `wc -l openspec/specs/implement.md` |
| Wave planning algorithm is mis-stated in the template (wrong pseudocode produces wrong waves) | Low | Kahn's algorithm is well-known; the pseudocode in this bundle matches the standard formulation. Review step 3 carefully — the wave assignment loop is the most subtle part |
