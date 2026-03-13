---
change: batch-implementation-orchestrator
type: tasks
---

# Tasks: Batch Implementation Orchestrator

Tasks are ordered by dependency. Each task has a layer tag, description, files involved, and acceptance criteria.

---

## Task 1 — Create `templates/commands/batch-implement.md` [templates]

**Description:** Write the new `/batch-implement` command template. This is the primary deliverable — a Markdown command file in the same format as `templates/commands/implement.md`. It uses `{{PLACEHOLDER}}` syntax only for variables that `install.sh` resolves at setup time (e.g., `{{LAYER_TAGS}}`, `{{BACKLOG_VIEW_CMD}}`). All orchestrator logic is written in plain prose.

The command covers these phases:
- Phase 0: Parse input, flags, and dependency annotations. Detect circular deps. Set `WAVES`, `CONCURRENCY`, `DRY_RUN`.
- Phase 1: Wave planning. Build dependency graph, topological sort, print execution plan, wait for confirmation.
- Phase 2: Wave execution loop. For each wave: invoke the `/implement` pipeline with the wave's feature list, wait for completion, update progress dashboard, apply failure isolation logic.
- Phase 3: Emit batch report.

**Files:**
- Create: `templates/commands/batch-implement.md`

**Acceptance criteria:**
- File exists with correct frontmatter (YAML: no frontmatter needed — same as implement.md which has none)
- Phase 0 parses `--deps`, `--concurrency`, `--wave-size`, `--dry-run`/`--preview` flags
- Circular dependency detection is specified: detect before execution, print the cycle, stop
- Dependency annotation format is documented: `"#B depends-on #A"` pairs, comma-separated
- Wave planning (Phase 1) describes Kahn's algorithm explicitly with step-by-step instructions
- Execution plan table format matches design.md specification
- User confirmation prompt is present before execution begins
- Phase 2 execution loop iterates waves sequentially, invokes `/implement` per wave
- Concurrency cap instruction is present (passed through to `/implement` Phase 3b)
- Progress dashboard table is defined with correct columns: Feature, Wave, Architect, Developer, Tests, Reviewer, Security, CI, Status
- Failure isolation rules are stated: failed feature blocks dependents only, not full batch
- Phase 3 batch report format matches design.md specification (summary table + per-feature table + conflicts + next steps)
- `--dry-run` pass-through behavior is documented
- `{{PLACEHOLDER}}` strings that exist in `implement.md` (e.g., `{{BACKLOG_VIEW_CMD}}`) are reused where applicable
- No pipeline phase logic is duplicated from `implement.md` — the command delegates to `/implement` for all per-feature work

**Dependencies:** None (can start immediately; requires reading `templates/commands/implement.md` for structural reference)

---

## Task 2 — Create `.claude/commands/batch-implement.md` [cli]

**Description:** Write the generated (specrails-adapted) copy of the batch-implement command. This file is the instance that Claude Code actually executes when a user runs `/batch-implement`. It is structurally identical to the template but with all `{{PLACEHOLDER}}` strings resolved to their specrails-specific values.

For specrails, the relevant placeholder resolutions are:
- `{{BACKLOG_VIEW_CMD}}` → `gh issue view {number}` (GitHub)
- `{{LAYER_TAGS}}` → `[core]`, `[templates]`, `[cli]`
- Any other placeholders from `templates/commands/implement.md` that appear in the batch template

If the batch-implement template introduces no new placeholders (beyond those inherited from implement.md), this file is a direct copy with the same placeholder resolutions applied.

**Files:**
- Create: `.claude/commands/batch-implement.md`

**Acceptance criteria:**
- File exists and contains no unresolved `{{PLACEHOLDER}}` strings
- Content is logically identical to `templates/commands/batch-implement.md` with placeholders resolved
- No template placeholders are introduced — this is a fully resolved file
- The command is runnable as a Claude Code slash command (`/batch-implement`)
- All phases from Task 1 are present

**Dependencies:** Task 1 (template must exist first)

---

## Task 3 — Create `openspec/specs/batch-implement.md` [core]

**Description:** Write the normative spec for the `/batch-implement` command. This is the source of truth for flags, execution model, failure isolation rules, and the behavior matrix. Follow the delta-spec.md exactly. Use SHALL/MUST/SHOULD language consistently.

The spec covers:
- Flags: `--deps`, `--concurrency`, `--wave-size`, `--dry-run`/`--preview`
- Wave planning algorithm (normative description, not implementation steps)
- Execution model: per-wave invocation of `/implement`, sequential waves, failure isolation
- Progress dashboard columns
- Batch report required sections
- Behavior matrix table

**Files:**
- Create: `openspec/specs/batch-implement.md`

**Acceptance criteria:**
- File exists at `openspec/specs/batch-implement.md`
- All four flags are documented with types, defaults, and normative behavior
- Dependency annotation format is specified (`"<dependant> depends-on <prerequisite>"`)
- Circular dependency detection is a MUST
- Wave planning section references Kahn's algorithm and specifies deterministic tie-breaking
- Failure isolation rules are normative (MUST/SHALL language)
- Progress dashboard columns table matches design.md
- Batch report required sections are listed
- Behavior matrix table covers all major scenarios from the design
- Language is consistently normative (no imperative prose)

**Dependencies:** None (can run in parallel with Tasks 1 and 2)

---

## Task 4 — Add recommendation note to `openspec/specs/implement.md` [core]

**Description:** Insert a single informational note into `openspec/specs/implement.md` directing users with 5+ features to `/batch-implement`. This is a minor additive change — one paragraph inserted after the existing introductory content, before the "Flags" section.

**Files:**
- Modify: `openspec/specs/implement.md`

**Specific change:**

Insert after the introductory paragraph (before the `## Flags` heading):

```markdown
> **For batches of 5+ features**, consider using `/batch-implement` instead. It adds dependency ordering, concurrency caps, and a batch-level progress dashboard on top of this pipeline.
```

**Acceptance criteria:**
- The blockquote note exists in `openspec/specs/implement.md` before the `## Flags` section
- No existing content in `openspec/specs/implement.md` is modified or removed
- The note uses informational language — no SHALL/MUST added

**Dependencies:** Task 3 (batch-implement spec should exist before referencing it)

---

## Task 5 — Verify placeholder consistency between template and generated command [cli]

**Description:** After Tasks 1 and 2 are complete, verify that all `{{PLACEHOLDER}}` strings in `templates/commands/batch-implement.md` are resolved in `.claude/commands/batch-implement.md`. This is a correctness check task, not a code change — but it may produce small edits if any placeholders were missed.

Run:
```bash
grep -n '{{[A-Z_]*}}' /Users/javi/repos/specrails/.claude/commands/batch-implement.md
```

Expected: no output (zero unresolved placeholders in the generated file).

Also run:
```bash
grep -n '{{[A-Z_]*}}' /Users/javi/repos/specrails/templates/commands/batch-implement.md
```

Expected: only valid template placeholders that correspond to known `install.sh` substitutions.

**Files:**
- Modify: `.claude/commands/batch-implement.md` (if any placeholder fixes are needed)

**Acceptance criteria:**
- Zero unresolved `{{...}}` strings in `.claude/commands/batch-implement.md`
- All `{{...}}` strings in `templates/commands/batch-implement.md` are documented in the template's placeholder list
- Any fixes applied are minimal and surgical

**Dependencies:** Tasks 1, 2

---

## Execution Order

```
Task 1 (template)  ──────────────────────────────────────────────────> Task 5 (verify)
                    \                                                  /
                     Task 2 (generated cli copy)  ───────────────────

Task 3 (spec)  ─────────────────────────────> Task 4 (implement.md note)

Tasks 1, 2, 3 can all start in parallel.
Task 4 depends on Task 3.
Task 5 depends on Tasks 1 and 2.
```

### Minimum critical path

Task 1 → Task 2 → Task 5

### Execution note

Tasks 1 and 3 are the largest and most independently completable — start both in parallel. Task 2 is a direct derivative of Task 1; it should be written immediately after Task 1 in the same editing session to avoid re-reading. Task 4 is a one-line insertion that can be done last.
