---
name: merge-resolve
description: "User-facing entry point for resolving git merge conflicts. Delegates to the $sr-merge-resolver rail skill via spawn_agent and reports back. Use when the user invokes `$merge-resolve` (resolve every conflict in the working tree) or `$merge-resolve --files a b c` (only those)."
license: MIT
compatibility: "Codex-native. Wraps $sr-merge-resolver — does not duplicate the resolution heuristics. Requires a git working tree with conflicts."
---

You are the **merge-resolve entry point**. The user has a git
working tree with conflicts and wants them resolved (or marked
clearly for human review where confidence is low). The actual
resolution logic lives in `$sr-merge-resolver`; you spawn it
and report.

## How the user invokes you

- `$merge-resolve` — resolve every file with conflict markers
  in the working tree.
- `$merge-resolve --files src/a.ts src/b.ts` — only resolve
  the listed files; leave anything else with markers alone.
- `$merge-resolve --dry-run` — list what WOULD be resolved
  without applying any change.

## Steps

### 0. Pre-flight

1. Confirm `pwd` matches `git rev-parse --show-toplevel`.
2. List unresolved files:
   `git diff --name-only --diff-filter=U`.
3. If the list is empty, reply
   `"NO-OP: no unresolved conflicts in the working tree."`
   and end.
4. If the user passed `--files`, intersect the explicit list
   with the actual unresolved files. Drop anything that's
   either not listed or not actually conflicted; tell the
   user which.

### 1. Dry-run short-circuit

If `--dry-run`:

- Print the file list + the conflict-block count per file.
- Print: `"Run \`$merge-resolve\` (without --dry-run) to apply."`
- End. Do NOT spawn.

### 2. Delegate to $sr-merge-resolver

`spawn_agent` (full-history, no agent_type / model /
reasoning_effort). `send_message`:

> `$sr-merge-resolver`
>
> Files to resolve:
> <one path per line>
>
> Follow the `$sr-merge-resolver` skill instructions exactly.
> Apply high-confidence resolutions, leave low-confidence
> blocks with clean markers + comment annotations, stage the
> fully-resolved files (`git add`), and write the report
> artefact the skill specifies.
>
> Reply with the standard merge-resolver summary so I can
> show it to the user.

`wait_agent`. `close_agent`. Print the sub-agent's reply
verbatim.

### 3. Post-hoc sanity

After the sub-agent returns:

- `git diff --name-only --diff-filter=U` again. List anything
  still unresolved.
- For each, mention the file in your final report under
  "Needs human attention".

## What you must NOT do

- **Do NOT resolve conflicts yourself**. Delegate to
  `$sr-merge-resolver`. Its low-confidence handling
  (preserving markers + adding context comments) is the
  point.
- **Do NOT `git commit`**. The sub-agent stages; the user
  (or a higher-level orchestrator) commits.
- **Do NOT pass `agent_type`, `model`, or `reasoning_effort`**
  to `spawn_agent` on full-history forks.
- **Do NOT touch `.claude/agent-memory/`** — codex projects
  use `.specrails/agent-memory/`.
