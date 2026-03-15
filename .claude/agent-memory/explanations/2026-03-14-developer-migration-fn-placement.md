---
agent: developer
feature: sr-prefix-namespace
tags: [update, migration, shell]
date: 2026-03-14
---

## Decision

`do_migrate_sr_prefix()` is called first within every update component that touches agents or commands (`all`, `commands`, `agents`, `core`) but not for `web-manager`.

## Why This Approach

The migration must run before `do_core()` copies new template files, because `do_core()` writes setup-templates but doesn't directly rename agent files in `.claude/agents/`. Running migration first ensures that if a subsequent phase reads the agents directory, it sees the sr-prefixed layout rather than a mix of old and new names.

`web-manager` is excluded because it is an independent sub-product (the Pipeline Monitor UI) that has no dependency on agent naming and doesn't touch `.claude/agents/` or `.claude/commands/`.
