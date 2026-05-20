---
name: batch-implement
description: "Run the implement pipeline over multiple backlog tickets in one invocation. Spawns one $implement sub-agent per ticket (sequential by default; parallel only when the user explicitly opts in AND the tickets are independent). Reports an aggregated verdict at the end. Use when the user invokes `$batch-implement #N #M #K` or `$batch-implement --status todo` (implement every todo ticket)."
license: MIT
compatibility: "Codex-native. Wraps `$implement` — does not duplicate its architect/developer/reviewer pipeline. Sub-agents are full-history forks (no agent_type / model / reasoning_effort)."
---

You are the **batch-implement orchestrator**. The user invoked
you to apply the implement pipeline to multiple tickets in one
session. You delegate each ticket to a `$implement` sub-agent,
collect verdicts, and produce a single aggregated report.

You do NOT re-implement the architect / developer / reviewer
fan-out — that lives in `$implement`. You're the outer loop.

**This skill is fully headless / non-interactive.** Do NOT
interpret any line of this skill as requiring user input. Every
sub-agent invocation must include the equivalent of `--yes`.
There is no "interactive mode" — if you find yourself thinking
"the batch skill is interactive by design, let me run inline
instead", you're misreading. The `(non-interactive)` phrase
inside the send_message body is INSTRUCTING the sub-agent to
behave that way, not a hint about how this skill itself works.

## How the user invokes you

- `$batch-implement #1 #2 #3 --yes` — implement these three
  tickets in sequence.
- `$batch-implement --status todo` — implement every ticket in
  `.specrails/local-tickets.json` whose status is `todo`, in
  ascending id order.
- `$batch-implement --status todo --priority high` — same but
  filtered to high-priority todos only.
- `$batch-implement #1 #2 --parallel` — opt-in parallel mode.
  Only legal when the architect's `Files to touch` lists for
  the tickets are **disjoint**. The orchestrator validates this
  before going parallel (see Step 2.b).

Default execution mode is **sequential**.

## Steps (in order)

### 0. Bootstrap

1. Confirm `pwd` matches `git rev-parse --show-toplevel`.
2. Parse the argv: collect the explicit ticket ids (`#N`
   tokens) AND any filter flags (`--status`, `--priority`,
   `--parallel`).
3. Build the target list:
   - If the user passed explicit ids → use them in the given
     order.
   - Otherwise filter `.specrails/local-tickets.json`'s
     `tickets` map by `--status` / `--priority` and sort by
     numeric id ascending.
4. If the target list is empty, reply
   `"NO-OP: no tickets match the filter"` and end.
5. State (≤4 lines) which tickets you're about to process and
   in what mode (sequential vs parallel).

### 1. Sequential mode (default)

For each ticket id in order:

a. `spawn_agent` (full-history, no agent_type / model /
   reasoning_effort).
b. `send_message`:

   > `$implement`
   >
   > Ticket id: `<TICKET_ID>`
   >
   > Follow the `$implement` skill instructions exactly. Treat
   > this invocation as `--yes` (non-interactive). Reply with
   > the standard implement summary so the orchestrator can
   > aggregate.

c. `wait_agent`. Capture the reply. Parse the verdict:
   - `#<N> → done` → success
   - `#<N> → todo` → fix-needed / blocked (still counts as
     attempted)
   - `BLOCKED: …` → never made it past bootstrap
d. `close_agent`.

Move to the next ticket regardless of the previous outcome.
A ticket that ends in `todo` doesn't stop the batch — the
final report surfaces it.

### 2. Parallel mode (opt-in)

Only when the user passed `--parallel`. Before fanning out:

a. **Pre-spawn architect-only pass** to validate disjoint file
   sets. For each ticket id:
   - Spawn a temporary `$sr-architect` invocation (one per
     ticket, in parallel via `spawn_agents_on_csv` if your
     codex supports it).
   - Wait for each to produce its `tasks.md` + the
     `Files to touch` list in its plan artefact.
   - Collect every file path mentioned across all tickets.
b. If ANY file appears in more than one ticket's list, abort
   the parallel mode for the OVERLAPPING tickets and process
   them sequentially after the non-overlapping batch. State
   in your reply which tickets you re-routed and why.
c. For the non-overlapping tickets, spawn a `$implement`
   sub-agent each in parallel. Wait on all. Aggregate.

The parallel-mode safety net exists because two implement
pipelines editing the same file would race. If you're not
sure two tickets are disjoint, fall back to sequential.

### 3. Aggregate

For each completed sub-agent, collect:

- `ticket_id`
- `verdict`: `done` | `todo` | `blocked`
- `score`: the overall confidence score from the reviewer
- `plan_path`, `confidence_path`
- `files_changed`: list
- `tests_summary`, `build_summary`
- Any `Follow-up` bullets

### 4. Report

Print ONE consolidated summary (≤30 lines for typical
batches):

```
batch-implement — <N> tickets attempted

Outcomes:
  done:    #<id> #<id> ...
  todo:    #<id> (reason: …) #<id> (reason: …)
  blocked: #<id> (reason: …) ...

Per-ticket details:
  #<id> → <verdict> (score <N>/100)
    plan:       <path>
    confidence: <path>
    files:      <count> (<one path>, <one path>, +N more)
    tests:      <pass/fail summary>

Aggregate stats:
  Files touched: <total unique count>
  Tests run:     <total>, pass <count>, fail <count>
  Build:         <count where ran, count ok, count failed>

Follow-up across batch:
  - <bullet> (#<id>)
  - ...
```

If every ticket ended in `done`, also print a single line:

```
✓ Batch complete: <N>/<N> tickets done.
```

If some ended in `todo` or `blocked`, finish with the
re-launch hint:

```
Re-run with: $batch-implement #<id-of-todo> [#<id> ...] --yes
```

## What you must NOT do

- **Do NOT re-implement the architect / developer / reviewer
  fan-out.** That's `$implement`'s job. You are strictly the
  outer loop.
- **Do NOT close tickets yourself**. Each `$implement`
  sub-agent owns its own ticket-update step. Your orchestrator
  never writes to `.specrails/local-tickets.json` directly.
- **Do NOT pass `agent_type`, `model`, or `reasoning_effort`**
  to `spawn_agent` on full-history forks.
- **Do NOT proceed in parallel mode** without the disjoint-file
  check. The user opting in doesn't override the safety
  invariant.
- **Do NOT exceed 10 parallel sub-agents in one fan-out** even
  if the user passes 20 ticket ids. Cap and process the
  overflow in a second batch.
- **Do NOT touch `.claude/agent-memory/`** — codex projects use
  `.specrails/agent-memory/`.
