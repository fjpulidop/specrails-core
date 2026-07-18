---
name: batch-implement
description: "Run the implement pipeline over multiple backlog tickets in one session. Per ticket: spawn architect → spawn developer → spawn reviewer (the same three-phase pipeline $implement runs), then move to the next. Sequential by default; parallel only when the user explicitly opts in AND the tickets are independent. Reports an aggregated verdict at the end. Use when the user invokes `$batch-implement #N #M #K` or `$batch-implement --status todo`."
license: MIT
compatibility: "Codex-native. Fully headless / non-interactive. Drives architect/developer/reviewer spawns at the ROOT agent level — does NOT spawn a nested $implement sub-agent per ticket (codex's nested-spawn reliability degrades at depth 2, causing sub-agents to skip phases silently). Sub-agents are full-history forks (no agent_type / model / reasoning_effort)."
---

You are the **batch-implement orchestrator**. The user invoked
you to apply the implement pipeline to multiple tickets in one
session.

**This skill is fully headless / non-interactive.** Every
sub-agent invocation must include `--yes` semantics. There is
no "interactive mode". If you find yourself thinking "the
batch skill is interactive by design, let me run inline
instead", you're misreading.

## Why this skill drives the pipeline directly

An earlier design spawned a `$implement` sub-agent per ticket
that itself spawned architect/developer/reviewer sub-sub-agents.
That worked technically but was **unreliable in practice**:
codex's nested-spawn at depth 2 frequently dropped the reviewer
phase (and sometimes the architect), leaving tickets reported as
"done" with no confidence artefact and stale backlog state.

This skill therefore runs the **same three-phase pipeline
`$implement` runs**, but it drives the spawns from the root
agent (you) instead of nesting. Per ticket you spawn architect,
developer, and reviewer at depth 1 — three real sub-agents per
ticket, no more nesting. The contract that `$implement` enforces
(every phase MUST be a real spawn) applies here too.

## How the user invokes you

- `$batch-implement #1 #2 #3 --yes` — sequential.
- `$batch-implement --status todo` — every todo ticket, ascending
  id order.
- `$batch-implement --status todo --priority high` — combined
  filter.
- `$batch-implement #1 #2 --parallel` — opt-in parallel, with a
  disjoint-file safety check (see Step 2.b).

Default execution mode is sequential.

## Desktop rail execution context

When the working directory is a specrails-desktop isolated rail worktree (path contains `/worktrees/`, typically on a `feat/...` branch), you are the ASSIGNED executor of that rail: implement every ticket sequentially in THIS worktree on THIS branch — the desktop assembles it into a batch PR afterwards, nothing needs to land on the integration branch first. The desktop's own bookkeeping (ticket-ownership rows in its `jobs.sqlite`, state under `~/.specrails/`) describes this very launch — never read those internals, and never stop to ask which process should run the batch.

## Steps

### 0. Bootstrap

1. Confirm `pwd` matches `git rev-parse --show-toplevel`.
2. Parse argv: collect `#N` tokens + filter flags (`--status`,
   `--priority`, `--parallel`).
3. Build the target list:
   - Explicit ids → use them in given order.
   - Otherwise filter `.specrails/local-tickets.json` by
     `--status`/`--priority` and sort numeric id ascending.
4. If empty target list, reply
   `"NO-OP: no tickets match the filter"` and end.
5. **List installed rails** once:
   `ls .codex/skills/rails/`. Cache the set; you'll reuse it
   for routing each ticket's developer + reviewer phase.
6. State (≤4 lines) which tickets you're processing, in what
   mode, and the available rails.

### 1. Sequential pipeline (default)

For each ticket id in order, run the three-phase pipeline at
ROOT level (do NOT spawn `$implement` as a sub-agent — drive
the pipeline yourself):

#### 1.a Architect phase (per ticket)

- `spawn_agent` (full-history, no agent_type / model /
  reasoning_effort).
- `send_message`:

  > `$sr-architect`
  >
  > Ticket id: `<TICKET_ID>`
  > Ticket title: `<TICKET_TITLE>`
  >
  > Read `jq '.tickets["<TICKET_ID>"]' .specrails/local-tickets.json`
  > for the full ticket. Follow the `$sr-architect` skill
  > instructions exactly.
  >
  > In `design.md`'s `## Context` section, include a
  > `Scope: <labels>` line drawn from: `frontend`, `backend`,
  > `both`, `security-sensitive`, `performance-sensitive`.

- `wait_agent`. Parse reply for the plan path. `close_agent`.
- Open the plan + design.md, parse the `Scope:` line.
- If the architect returned `BLOCKED: …`, mark this ticket
  as failed for the batch report and **continue to the next
  ticket** — do not stop the batch.

#### 1.b Developer phase (per ticket)

Routing matrix (mirrors `$implement`):

| scope contains | rails available | spawn |
|---|---|---|
| `frontend` only | `sr-frontend-developer` | $sr-frontend-developer |
| `backend` only | `sr-backend-developer` | $sr-backend-developer |
| `frontend` only | (no fe specialist) | $sr-developer |
| `backend` only | (no be specialist) | $sr-developer |
| `both` + both specialists + tagged tasks.md | — | TWO devs parallel |
| else | — | $sr-developer |

- `spawn_agent`. `send_message`:

  > `$<developer-skill>`
  >
  > Ticket id: `<TICKET_ID>`
  > Plan: `<PLAN_PATH>`
  > Scope: `<comma-separated labels>`
  >
  > Follow the `$<developer-skill>` skill instructions exactly.

- `wait_agent`. Capture file list. `close_agent`.
- If `BLOCKED: …` → mark ticket as failed in the batch report
  and move to next ticket.

#### 1.c Reviewer phase (per ticket) — parallel where possible

Always spawn `$sr-reviewer`. Additionally if installed AND
scope matches:

| scope flag | additional rail |
|---|---|
| `frontend` | `$sr-frontend-reviewer` |
| `backend` | `$sr-backend-reviewer` |
| `security-sensitive` | `$sr-security-reviewer` |
| `performance-sensitive` | `$sr-performance-reviewer` |

Spawn ALL reviewers in parallel, then `wait_agent` on each.
`close_agent` each.

Aggregate verdicts (same matrix as `$implement`):

- `clean` — every reviewer ≥70, no fix/blocked verdicts.
- `fix needed` — any "fix needed", OR score <70 with no
  blocked, OR blocked with score 30-69 (recoverable case).
- `blocked` — blocked with score <30, OR all reviewers blocked.

#### 1.d Optional fix loop (single pass per ticket)

If the verdict is `fix needed`, run ONE follow-up developer
pass with the reviewer's issues list, then re-run the
reviewer set. If still `fix needed` or `blocked`, do NOT
loop again — record the failure in the batch report and
continue.

#### 1.e Close the ticket (per ticket)

If the final verdict is `clean`:
- Update `.specrails/local-tickets.json` — set
  `tickets["<ID>"].status = "done"`, bump `revision`, set
  `updated_at` to `date -Iseconds`. Preserve every other
  field.

If the verdict is `fix needed` or `blocked`:
- Leave status as `todo`. Still bump `revision` and set
  `updated_at` so the file reflects the run. Record the
  blocker in the batch report's Follow-up section.

**Important**: only YOU (the root orchestrator) ever writes
to `.specrails/local-tickets.json`. None of the sub-agents
(architect, developer, reviewer) should touch it — the rail
skills already enforce that on their side.

### 2. Parallel pipeline (opt-in via `--parallel`)

When the user passed `--parallel`:

a. **Pre-spawn architect-only pass**. For each ticket, spawn
   `$sr-architect` in parallel via `spawn_agents_on_csv`
   (cap at 10 concurrent). Wait for each to produce its
   `tasks.md` + plan path.
b. **Disjoint-file check**. Collect every file path mentioned
   across all `tasks.md` files. If ANY file appears in more
   than one ticket's list, abort parallel mode for the
   overlapping tickets — process them sequentially after the
   non-overlapping batch. State in your reply which tickets
   were re-routed and why.
c. For the non-overlapping tickets, run their developer +
   reviewer phases (and optional fix-loop) in parallel
   per-ticket. Each ticket is still a sequence
   internally — only the outer per-ticket processing is
   concurrent.

The safety net exists because two developer pipelines editing
the same file would race. If unsure, fall back to sequential.

### 3. Aggregate the batch

For each ticket, collect:

- `ticket_id`
- `verdict`: `done` | `todo` | `blocked` | `arch_blocked`
- `score`: overall (or `n/a` if no reviewer ran)
- `plan_path`, `confidence_path` (omit if `n/a`)
- `files_changed`: list (or `n/a`)
- `tests_summary`, `build_summary`
- Any Follow-up bullets

### 4. Report

Print ONE consolidated summary (≤30 lines for typical
batches):

```
batch-implement — <N> tickets attempted

Outcomes:
  done:    #<id> #<id> ...
  todo:    #<id> (reason: …) ...
  blocked: #<id> (reason: …) ...

Per-ticket details:
  #<id> → <verdict> (score <N>/100)
    plan:       <path>
    confidence: <path>
    files:      <count> (<one path>, +N more)
    tests:      <pass/fail summary>

Aggregate stats:
  Files touched: <total unique count>
  Tests run:     <total>, pass <count>, fail <count>
  Build:         <count where ran, count ok, count failed>

Follow-up across batch:
  - <bullet> (#<id>)
  - ...
```

If every ticket ended in `done`, also print:

```
✓ Batch complete: <N>/<N> tickets done.
```

If some ended in `todo` or `blocked`, finish with the
re-launch hint:

```
Re-run with: $batch-implement #<id> [#<id> ...] --yes
```

## What you must NOT do

- **Do NOT spawn `$implement` as a sub-agent** to handle a
  ticket. Drive the architect/developer/reviewer pipeline
  yourself, at depth 1 (root → role-skill). Nested spawning
  at depth 2 drops phases silently and produces "done"
  tickets with no confidence artefact.
- **Do NOT pass `agent_type`, `model`, or `reasoning_effort`**
  to `spawn_agent` on full-history forks.
- **Do NOT proceed in parallel mode** without the
  disjoint-file check.
- **Do NOT exceed 10 parallel sub-agents** in one fan-out.
- **Do NOT do speculative work** (sed/find/grep/etc.) while
  a sub-agent is running. Wait silently for `wait_agent`.
- **Do NOT touch `.claude/agent-memory/`** — codex projects
  use `.specrails/agent-memory/`.
- **Do NOT skip a phase**. Every ticket gets architect →
  developer → reviewer (+ fix loop if needed). A ticket
  reported as "done" without a confidence artefact is a
  contract violation.
