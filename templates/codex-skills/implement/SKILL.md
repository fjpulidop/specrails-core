---
name: implement
description: "Implement a single backlog ticket end-to-end. Reads .specrails/local-tickets.json, plans the change, edits the relevant files, runs any available tests/build, updates the ticket's status, and reports a concise summary. Use when the user invokes `$implement #N` or `$implement <free-form>`."
license: MIT
compatibility: "Requires the specrails-core installation in this repository. Reads .specrails/local-tickets.json. Codex-native — uses a single agent loop (no claude-style sub-agents)."
---

You are implementing a single backlog ticket end-to-end in this
repository. You are the only agent on this task. Do not try to
spawn sub-agents — codex does not have the same `subagent_type`
mechanic as claude, and the upstream skills that mention sub-agents
are claude-flavoured holdovers.

## How the user invokes you

- `$implement #N` — implement the ticket with id `N` from
  `.specrails/local-tickets.json`.
- `$implement #N --yes` — same, skip the "ready to apply?" prompt
  (default in non-interactive runs).
- `$implement <free-form description>` — implement the free-form
  description without a ticket id (only persist the result if the
  user later asks).

If the argument starts with `#`, treat everything after the `#` and
before the first space (or end of string) as the ticket id. The
ticket id is the JSON key in `.specrails/local-tickets.json`'s
`tickets` map.

## What you MUST do every run

Follow these steps in order. Do not skip steps even if the repo
looks "trivial" — a clean run leaves trazabilidad.

### 1. Locate the work

1. Confirm the working directory is the repo root (`git
   rev-parse --show-toplevel` matches your `pwd`). If it doesn't,
   `cd` to the root before doing anything else.
2. Read the ticket from `.specrails/local-tickets.json`:
   - `jq '.tickets["<ID>"]' .specrails/local-tickets.json`
   - If `jq` is missing, read the file with `cat` and parse the
     JSON yourself.
   - If the ticket doesn't exist, stop and tell the user. Do
     **not** invent a ticket.
3. Read the ticket's full `description` field. The description is
   the source of truth for what to build.

### 2. Plan briefly

In one short message (≤6 lines), state:
- What the ticket asks for, in your own words.
- The 1–5 files you intend to touch.
- Any decision you're making that the ticket leaves implicit.
- Whether tests / build steps exist in the repo, and which you plan
  to run after editing.

Do **not** ask the user to confirm the plan. Just state it and
proceed — the user already invoked you with `--yes` semantics by
launching the rail.

### 3. Implement

Edit / create the files needed. Honour these constraints:

- **Stay inside the repo.** Never write outside the repo root.
- **Don't touch `.specrails/`, `.codex/`, `.claude/`, `openspec/`
  unless the ticket explicitly asks for it.** Those are
  hub-managed.
- **Match the stack.** If the repo has a `package.json`, prefer
  the existing build / test scripts. If it's empty, pick the
  simplest stack that satisfies the ticket (a single static
  `index.html` for a browser game; a single Python file for a
  script; etc.).
- **Idempotence.** Re-running you on the same ticket should be
  safe: detect existing files and overwrite only when the
  content actually changes.
- **No invented work.** If the ticket asks for X, do X. Do not
  add unrelated files (no `PEPE.md`, no scaffolding the user
  didn't ask for).

### 4. Validate

After editing:

- If a `package.json` with a `test` script exists, run it.
- If a `package.json` with a `build` script exists and the change
  touches built-source, run the build.
- If `pytest.ini` / `pyproject.toml` with tests exist, run them.
- If `Cargo.toml` exists, run `cargo check`.
- If none of the above apply, do at least a basic syntax check
  appropriate for the file you wrote (`node --check file.js`,
  `python -m py_compile file.py`, etc.).

If validation fails, fix the issue and re-validate. Do not give up
after one attempt — debug like a developer would.

### 5. Close the ticket

After validation passes:

- Update `.specrails/local-tickets.json` in place: set the
  ticket's `status` from `todo` to `done` (or `in-progress` if
  you're explicitly leaving more work).
- Bump the file's top-level `revision` field by 1.
- Update the ticket's `updated_at` to the current ISO timestamp
  (`date -Iseconds`).

Use `jq` if available for the JSON edit; otherwise read the file,
parse, modify, re-serialize, and write back. **Preserve every
other field.** A naive overwrite that drops fields is a bug.

### 6. Report

Output a single concise summary at the end of your turn:

- Files created or changed (paths, no diffs).
- Validation results: what you ran, what passed, what (if anything)
  was skipped and why.
- Ticket status: `#<N> → done` (or whatever you set).
- Any follow-up the user should know about, in one bullet each.

Keep it under 12 lines total. The user can read the diff for
details.

## What you must NOT do

- **Do not** invoke `spawn_agent` / sub-agents. The repo has rail
  skill files (`sr-architect`, `sr-developer`, `sr-reviewer`)
  that mention them — those are reference material from claude.
  You are running a single-agent flow on purpose.
- **Do not** write `.claude/agent-memory/…` files. That's
  claude's memory layout. Codex doesn't read it back.
- **Do not** create OpenSpec change packages (`openspec/changes/…`)
  unless the user explicitly asked for one. Implement directly.
- **Do not** ask the user clarifying questions for trivial
  ambiguities. Make a reasonable choice, document it in step 2,
  and move on. Escalate only if the ticket is genuinely
  ambiguous in a way that would change the architecture.

## Examples

### Minimal example

```
User: $implement #1 --yes
Ticket #1 description: "Add a /healthz endpoint to the Express
  server that returns {status:'ok'}."
```

Your turn:

```
Plan: ticket asks for GET /healthz. Will edit
server/index.js and add tests/healthz.test.js if a test runner
is present. Repo has jest in package.json, so I'll run npm test
afterwards.

[edits server/index.js — adds app.get('/healthz', ...)]
[edits tests/healthz.test.js — asserts 200 + body shape]
[runs npm test — 14 passing]

Updated .specrails/local-tickets.json — ticket #1 → done,
revision 5 → 6.

#1 → done
Files: server/index.js (+5), tests/healthz.test.js (new).
Tests: npm test, 14 pass.
```

### Empty-repo example

```
User: $implement #1 --yes
Ticket #1 description: "Build a playable Tetris game accessible
  via a single index.html in the browser."
Repo: no package.json, no source files.
```

Your turn:

```
Plan: ticket asks for a self-contained browser Tetris. Will
write a single index.html with inline CSS + JS implementing the
classic 10x20 board, tetrominoes, line clears, score, level,
next-piece preview, pause, restart. No build step needed; no
test framework present. I'll run a basic node --check on the
extracted JS and an HTML lint pass.

[writes index.html — ~400 lines]
[runs node --check on extracted JS block — passes]

Updated ticket #1 → done.

#1 → done
Files: index.html (new, 412 lines).
Validation: node --check passed; no test runner in repo.
Open the file in a browser to play.
```
