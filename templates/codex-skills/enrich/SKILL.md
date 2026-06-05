---
name: enrich
description: "Full-tier install ritual for an existing specrails project. Surveys the codebase, generates VPC personas, refreshes the rail skills with project-specific context, and updates AGENTS.md's managed block. Single-agent flow — does NOT spawn the implement pipeline. Use when the user invokes `$enrich` after a Quick install or after a major codebase shift."
license: MIT
compatibility: "Codex-native. Single-agent loop (no spawn_agent). Mutates `.codex/`, `.specrails/setup-templates/`, and the AGENTS.md managed block. Idempotent: re-running on the same codebase produces a stable result."
---

You are the **enrich** ritual. The user has a specrails
installation that was bootstrapped quickly (template defaults)
and wants the rail skills + agent personas adapted to THIS
codebase. You read the repo, infer the persona, customise the
shipped artefacts, and write the result back in place.

This is a **single-agent** flow. No `spawn_agent`, no
sub-agents — enrich is what gives the rail agents their flavour;
it doesn't run the rail pipeline.

## How the user invokes you

- `$enrich` — full enrichment (codebase analysis + persona
  generation + rail customisation + AGENTS.md refresh).
- `$enrich --from-config` — read parameters from
  `.specrails/install-config.yaml` instead of asking. Used by
  the hub during the install wizard's full-tier path.
- `$enrich --personas-only` — only regenerate personas; leave
  rail skills untouched.

## Steps

### 1. Survey the codebase

Read the repo without modifying anything:

- Top-level files: `ls -la`, `cat package.json` /
  `cat pyproject.toml` / `cat Cargo.toml` / etc.
- Major directories: identify the source tree shape
  (`src/`, `app/`, `pages/`, `lib/`, `tests/`, `docs/`).
- Stack inference: language(s), build tool, test runner,
  major frameworks (React, Next, FastAPI, Rails, etc.),
  major libraries.
- Recent activity: `git log --oneline -20` to see what the
  team has been working on lately.
- Existing docs: `README.md`, `docs/**/*.md` (skim, don't
  re-read every word).

State (≤8 lines) your codebase summary so the user sees what
you inferred BEFORE you start writing.

### 2. Generate VPC personas

Personas are documents describing TYPES of users this product
serves. Write each to:

`.specrails/personas/<slug>.md`

(create the dir if missing). 2-5 personas per project,
covering: name, role, goals, frustrations, context, success
criteria. Use the existing
`.specrails/setup-templates/personas/persona.md` (if present)
as a shape reference; if absent, use this skeleton:

```
# <Persona name>

## Role
<one paragraph>

## Goals
- <bullet>
- <bullet>

## Frustrations
- <bullet>

## Context
<one paragraph: what tools they use, when they engage the
product, what success looks like for THEM>

## Success criteria
- <observable signal>
```

Personas are read-only context for downstream agents. Don't
reference specific tickets — those churn; personas don't.

### 3. Customise the rail skills

For each installed rail skill in `.codex/skills/rails/`:

- Read the current SKILL.md.
- Identify any section that says "STACK / framework / test
  runner / etc." with a placeholder hint.
- Replace with the concrete value from your codebase survey.
  Example: a generic `sr-frontend-developer`'s test
  framework hint becomes `Vitest + React Testing Library`
  if that's what the project ships.

Do this conservatively — don't rewrite the prose. Only fill
in stack-specific details. If a rail's SKILL.md is already
fully concrete (no placeholders), leave it alone.

### 4. Refresh AGENTS.md managed block

Open `AGENTS.md` at the repo root. Locate the
`<!-- specrails-managed:start -->` … `<!-- specrails-managed:end -->`
block. Rewrite ONLY the content inside the sentinels with:

```
<!-- specrails-managed:start -->

# <project-name> — agent instructions

This project uses **specrails** with the **codex** provider.

## Project at a glance
- Stack: <inferred from step 1, one line>
- Build: <command>
- Tests: <command>
- Layout: <one-line tree summary>

## Conventions
- <one bullet per non-obvious project convention worth
  surfacing to every spawned sub-agent>
- ...

## Personas
- <persona name> — `.specrails/personas/<slug>.md`
- ...

## Rail skills installed
- `$implement`, `$batch-implement` — pipeline entry points
- `$sr-architect`, `$sr-developer`, `$sr-reviewer` — core rails
- <list any optional rails installed in
  .codex/skills/rails/ — e.g. `$sr-merge-resolver`, layer
  specialists>

<!-- specrails-managed:end -->
```

Content OUTSIDE the sentinel block is user-authored — leave
it intact.

### 5. Write a record

Path:

`.specrails/agent-memory/explanations/YYYY-MM-DD-enrich-{TIMESTAMP}.md`

Shape:

```
# Enrich — {DATE}

## Codebase
<your survey summary, copied from step 1>

## Personas written
- .specrails/personas/<slug>.md
- ...

## Rails customised
- .codex/skills/rails/<name>/SKILL.md — <what was filled in>
- ...

## AGENTS.md
- Updated managed block: yes / no (unchanged)
```

## What you must NOT do

- **Do not** spawn sub-agents. Enrich is a single-agent ritual.
- **Do not** modify the rail skills' core instructions —
  only fill stack placeholders.
- **Do not** touch content OUTSIDE the `<!-- specrails-managed
  -->` sentinels in `AGENTS.md`.
- **Do not** create or modify any backlog ticket.
- **Do not** write to `.claude/agent-memory/`. Codex projects
  use `.specrails/agent-memory/`.

## How you finish

Reply with:

```
Enriched. Stack: <one-line>. Personas: <N>. Rails
customised: <count>. AGENTS.md: <updated|unchanged>. Record:
<report-path>.
```

If you cannot enrich (repo is empty, AGENTS.md is missing,
etc.), reply `"BLOCKED: <one-sentence reason>"` and end.
