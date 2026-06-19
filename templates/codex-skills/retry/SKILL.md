---
name: retry
description: "Resume a previously-attempted $implement pipeline for a ticket. Detects what's already on disk (OpenSpec change package, partial code, ticked tasks.md) and re-invokes $implement so the architect/developer/reviewer agents skip work that's already correct and pick up where the prior run left off. Use when the user invokes `$retry #N` after a $implement run that ended in `todo` or `blocked`."
license: MIT
compatibility: "Codex-native. Thin wrapper around $implement — relies on the implement pipeline's existing idempotence rather than tracking its own state."
---

You are the **retry orchestrator**. The user wants to continue a
prior `$implement` run for a single ticket without redoing work
that's already correct on disk.

You are NOT a separate pipeline. You inspect what `$implement`
left behind, summarise the current state, and re-invoke
`$implement` with a hint about what's already in place. The
implement skill is idempotent — architect reuses an existing
`${SPECRAILS_REPO_DIR:-.}/openspec/changes/<slug>/`, developer detects ticked tasks and
already-correct files, reviewer re-validates from scratch.

**Repository location.** `openspec/**` and `.git` live under
`${SPECRAILS_REPO_DIR:-.}` (unset ⇒ `.` ⇒ classic in-repo run); inspect change
artefacts there. The ticket store and `.specrails/agent-memory/` are run-state,
relative to the working directory.

## How the user invokes you

- `$retry #N` — retry the implement run for ticket `N`.
- `$retry #N --yes` — same, non-interactive.

## Steps

### 0. Locate the prior run's artefacts

1. Confirm the repo root with `git -C "${SPECRAILS_REPO_DIR:-.}" rev-parse --show-toplevel`.
2. Load the ticket (run-state, relative to the working directory):
   `jq '.tickets["<ID>"]' .specrails/local-tickets.json`. If
   the ticket doesn't exist, stop and report.
3. Inspect what's already on disk for this ticket:
   - **Architect artefacts**: any matching plan file under
     `.specrails/agent-memory/explanations/` named
     `*-architect-ticket-<ID>.md`. List the latest.
   - **OpenSpec change package**: any
     `${SPECRAILS_REPO_DIR:-.}/openspec/changes/<slug>/` whose proposal.md mentions
     the ticket title or whose tasks.md has tasks scoped to
     the ticket. Find the slug.
   - **tasks.md progress**: count `[x]` vs `[ ]` boxes in
     `${SPECRAILS_REPO_DIR:-.}/openspec/changes/<slug>/tasks.md`.
   - **Reviewer verdict**: latest matching
     `*-reviewer-ticket-<ID>.confidence-score.json`. Read
     the issues list and overall score.

### 1. Summarise (≤6 lines)

Print a concise state summary so the user sees what you
detected:

```
Prior run for #<ID>:
  Plan:        <path or "missing">
  Change pkg:  openspec/changes/<slug>/ (<found / missing>)
  Tasks:       <X>/<N> ticked
  Last review: <score>/100 — <verdict>
  Open issues: <count> (top: "<first issue note, truncated>")
```

If no prior artefacts exist, say so explicitly — `$retry` on a
ticket that was never attempted is just `$implement`, and you
fall through to step 2 anyway.

### 2. Re-invoke $implement

`spawn_agent` (full-history fork, no agent_type / model /
reasoning_effort). `send_message`:

> `$implement`
>
> Ticket id: `<TICKET_ID>`
> Mode: **retry**
>
> A prior run left:
>   - plan at `<plan-path-or-none>`
>   - change package at `openspec/changes/<slug>/` (<found|missing>)
>   - tasks.md progress: <X>/<N> ticked
>   - last reviewer score: <N>/100 with <K> open issues
>
> Open issues from the last review (verbatim):
> - <issue 1 from confidence-score.json>
> - <issue 2>
> - ...
>
> Honour these on this retry:
> 1. If the change package exists and proposal.md is sane,
>    REUSE it. The architect should refine design.md / tasks.md
>    if the issues call for it, not start from scratch.
> 2. The developer should pick up at the first un-ticked task
>    box. Already-ticked boxes whose files match the intended
>    state should NOT be redone.
> 3. The reviewer re-runs from scratch — no caching of prior
>    verdict.
>
> Follow the $implement skill instructions exactly. Reply
> with the standard implement summary.

`wait_agent`. `close_agent`. Print the sub-agent's reply
verbatim as your own final report.

## What you must NOT do

- **Do NOT re-implement the pipeline**. You only inspect +
  delegate. The implement skill owns the actual work.
- **Do NOT modify any file directly** — neither the OpenSpec
  package nor the ticket. The spawned `$implement` does that.
- **Do NOT skip the "open issues" passthrough**. If the last
  review listed fixes, the next pipeline needs to see them
  verbatim — that's what makes retry produce a different
  result than a fresh `$implement`.
- **Do NOT loop on retry**. If the user wants a second retry,
  they invoke `$retry #N` again themselves. One retry per
  invocation.
- **Do NOT pass `agent_type`, `model`, or `reasoning_effort`**
  to `spawn_agent` on full-history forks.
- **Do NOT touch `.claude/agent-memory/`** — codex projects
  use `.specrails/agent-memory/`.
