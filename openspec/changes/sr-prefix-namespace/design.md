## Context

specrails installs agents and commands into `.claude/agents/` and `.claude/commands/` using generic names like `architect.md`, `developer.md`, `/implement`. Community agent collections (VoltAgent's awesome-claude-code-subagents) use the same directory and often the same filenames. When both are installed, files silently overwrite each other, breaking the `/implement` pipeline without any error message.

The rename adds an `sr-` prefix to all specrails agents and moves commands under an `sr/` subdirectory (producing `/sr:*` slash commands), creating a clean namespace boundary.

## Goals / Non-Goals

**Goals:**
- Namespace all specrails agents with `sr-` prefix to avoid filename collisions
- Namespace all specrails commands under `/sr:` to avoid command name collisions
- Auto-migrate existing installations via `update.sh`
- Update all documentation (specrails and specrails-web)

**Non-Goals:**
- Renaming OpenSpec skills (`opsx:*`) — already namespaciable, no collision detected
- Providing backwards-compatible aliases (clean break, not a gradual migration)
- Changing the internal agent prompt content — only filenames, frontmatter `name:`, and cross-references change

## Decisions

### D1: Prefix choice — `sr-` for agents, `sr/` directory for commands

**Rationale:** Claude Code resolves `subagent_type` to `.claude/agents/<name>.md`. Adding `sr-` to the filename means `subagent_type: sr-architect` resolves to `sr-architect.md`. For commands, Claude Code uses directory structure as namespace: `.claude/commands/sr/implement.md` becomes `/sr:implement`.

**Alternatives considered:**
- `specrails-` prefix: too verbose (`specrails-architect.md`)
- Subdirectory for agents too (`agents/sr/architect.md`): Claude Code doesn't support subdirectories for agent resolution

### D2: Personas also get `sr-` prefix

**Rationale:** Consistency. Even though VoltAgent doesn't have personas today, other collections might. The cost is minimal.

### D3: Agent memory directories renamed to match

**Rationale:** Agent memory paths in commands reference the agent name (e.g., `.claude/agent-memory/reviewer/common-fixes.md`). These must match the new `sr-` prefixed agent names.

### D4: OpenSpec skills (`opsx:*`) NOT renamed

**Rationale:** These are already under a unique namespace (`opsx:`). No collision with any known community skill collection. Renaming would break existing workflow muscle memory for no defensive benefit.

### D5: Clean break migration, no aliases

**Rationale:** specrails is pre-1.0 with a small user base. Maintaining dual names (old + new) adds complexity for little value. The `update.sh` migration handles existing installations automatically.

### D6: Migration in `update.sh`, not `install.sh`

**Rationale:** `install.sh` always creates fresh installations — it will use the new names from its templates. Only `update.sh` encounters existing installations that need migration. The migration function runs once, before the normal update flow.

### D7: Command directory structure

Commands move from flat to nested:
```
BEFORE:                          AFTER:
.claude/commands/                .claude/commands/
├── implement.md                 ├── sr/
├── batch-implement.md           │   ├── implement.md        → /sr:implement
├── product-backlog.md           │   ├── batch-implement.md  → /sr:batch-implement
├── health-check.md              │   ├── product-backlog.md  → /sr:product-backlog
├── why.md                       │   ├── update-product-driven-backlog.md
├── ...                          │   ├── health-check.md
└── setup.md  (stays)            │   ├── compat-check.md
                                 │   ├── refactor-recommender.md
                                 │   └── why.md
                                 ├── opsx/  (stays)
                                 └── setup.md  (stays — installer, not a workflow cmd)
```

`setup.md` stays at root — it's the installer entry point, not a workflow command. `opsx/` stays as-is per D4.

## Risks / Trade-offs

**[User muscle memory]** → Users who memorized `/implement` need to relearn `/sr:implement`. Mitigated by: clear update message during migration, updated docs.

**[subagent_type resolution]** → We assume Claude Code maps `subagent_type: sr-architect` to `sr-architect.md`. This follows documented behavior but hasn't been explicitly tested with prefixed names. → Mitigation: test manually before release. If it fails, fall back to D1 alternative (subdirectory).

**[specrails-web embedded copy]** → specrails-web contains a full copy of the installed system at `specrails-web/specrails/`. This is a separate repo that must be updated in the same change. → Mitigation: include in task plan.

**[Manifest breakage]** → `.specrails-manifest.json` keys are template paths. Renames break checksums. → Mitigation: `do_migrate_sr_prefix()` regenerates the manifest after renaming files.

**[Historical docs]** → `docs/2026-03-07-parallel-implement-session.md` is a historical session log. → Decision: leave as-is. It's a record of what happened at that time, not reference documentation.

## Migration Plan

### `do_migrate_sr_prefix()` in update.sh

```
1. DETECT: Check if .claude/agents/architect.md exists (old naming)
2. RENAME AGENTS: For each agent in the known list, mv <name>.md → sr-<name>.md
3. RENAME PERSONAS: For each persona, mv <name>.md → sr-<name>.md
4. MOVE COMMANDS: mkdir -p .claude/commands/sr/; mv .claude/commands/{implement,batch-implement,...}.md .claude/commands/sr/
5. RENAME AGENT MEMORY: For each directory in agent-memory/, mv <name>/ → sr-<name>/
6. UPDATE SETTINGS: Replace agent/command references in settings.json
7. REGENERATE MANIFEST: Rebuild .specrails-manifest.json with new paths
8. PRINT SUMMARY: "Migrated to sr- namespace: N agents, N commands, N memory dirs"
```

### Rollback

No automated rollback. Since specrails manages its own files (not user code), a failed migration can be fixed by re-running `/setup` which regenerates everything from templates.

## Open Questions

None — all decisions resolved during explore phase.
