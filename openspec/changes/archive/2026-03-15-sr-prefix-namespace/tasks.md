## 1. Rename Template Agent Files [templates]

- [x] 1.1 Rename all 12 files in `templates/agents/` from `<name>.md` to `sr-<name>.md`: architect, developer, reviewer, product-manager, product-analyst, test-writer, doc-sync, frontend-developer, backend-developer, frontend-reviewer, backend-reviewer, security-reviewer
- [x] 1.2 Update YAML frontmatter `name:` field in each renamed agent file to include `sr-` prefix
- [x] 1.3 Rename persona templates in `templates/personas/` with `sr-` prefix (if template personas exist)
- [x] 1.4 Update any cross-agent references within agent prompt bodies (e.g., architect referencing developer by name)

## 2. Move Template Command Files [templates]

- [x] 2.1 Create `templates/commands/sr/` directory
- [x] 2.2 Move all 8 workflow command files into `templates/commands/sr/`: implement.md, batch-implement.md, product-backlog.md, update-product-driven-backlog.md, health-check.md, compat-check.md, refactor-recommender.md, why.md
- [x] 2.3 Keep `setup.md` at `commands/setup.md` (not in templates, not moved)

## 3. Update implement.md Internal References [templates]

- [x] 3.1 Update all `subagent_type:` values to sr-prefixed names (product-manager → sr-product-manager, architect → sr-architect, etc.)
- [x] 3.2 Update agent memory path references (`.claude/agent-memory/reviewer/` → `.claude/agent-memory/sr-reviewer/`)
- [x] 3.3 Update all prose references to agent names (e.g., "Launch a **test-writer** agent" → "Launch a **sr-test-writer** agent")
- [x] 3.4 Update layer reviewer launch references (frontend-reviewer, backend-reviewer, security-reviewer → sr- prefixed)

## 4. Update Other Command Templates [templates]

- [x] 4.1 Update `batch-implement.md`: all `/implement` refs → `/sr:implement`, agent name refs → sr-prefixed
- [x] 4.2 Update `product-backlog.md`: `subagent_type: product-analyst` → `sr-product-analyst`, command refs → `/sr:*`
- [x] 4.3 Update `update-product-driven-backlog.md`: command refs → `/sr:*`
- [x] 4.4 Update `why.md`: agent name refs (architect, developer, reviewer) → sr-prefixed, `/implement` → `/sr:implement`
- [x] 4.5 Update `refactor-recommender.md`: self-reference → `/sr:refactor-recommender`
- [x] 4.6 Update `compat-check.md`: agent name surface examples → sr-prefixed

## 5. Update setup.md [core]

- [x] 5.1 Update all agent template path references (e.g., `setup-templates/agents/architect.md` → `setup-templates/agents/sr-architect.md`)
- [x] 5.2 Update agent name references in description tables and summaries
- [x] 5.3 Update command template path references to use `sr/` subdirectory
- [x] 5.4 Update command name references (e.g., `/implement` → `/sr:implement`)
- [x] 5.5 Update agent memory path references in setup instructions

## 6. Add Migration Function to update.sh [core]

- [x] 6.1 Implement `do_migrate_sr_prefix()` function with legacy detection logic (check for `.claude/agents/architect.md`)
- [x] 6.2 Add agent file renaming loop (skip missing files gracefully)
- [x] 6.3 Add persona file renaming loop
- [x] 6.4 Add command directory migration (create `sr/`, move workflow commands, preserve non-specrails commands and `setup.md`)
- [x] 6.5 Add agent memory directory renaming loop (skip non-agent dirs like `failures/`, `explanations/`)
- [x] 6.6 Add manifest regeneration after migration
- [x] 6.7 Add migration summary output
- [x] 6.8 Call `do_migrate_sr_prefix()` early in the update flow, before other update functions

## 7. Update OpenSpec Specs [core]

- [x] 7.1 Update `openspec/specs/implement.md`: all agent refs → sr-prefixed, command refs → `/sr:implement`
- [x] 7.2 Update `openspec/specs/batch-implement.md`: `/implement` → `/sr:implement` references
- [x] 7.3 Update `openspec/specs/confidence-scoring.md`: reviewer → sr-reviewer, developer → sr-developer, architect → sr-architect, `/implement` → `/sr:implement`
- [x] 7.4 Update `openspec/specs/compat-check.md`: agent name examples → sr-prefixed, command examples → sr-prefixed
- [x] 7.5 Update `openspec/specs/setup-update-mode/spec.md`: all agent and command refs → sr-prefixed

## 8. Update Root Documentation [core]

- [x] 8.1 Update `README.md`: agent names, command names, pipeline diagram, template list
- [x] 8.2 Update `CLAUDE.md`: pipeline diagram agent names

## 9. Regenerate .claude/ from Templates [core]

- [x] 9.1 Rename agent files in `.claude/agents/` to match new template names (sr-prefixed)
- [x] 9.2 Update YAML frontmatter `name:` in each `.claude/agents/sr-*.md`
- [x] 9.3 Move command files to `.claude/commands/sr/` directory
- [x] 9.4 Update all internal references in `.claude/commands/sr/implement.md` (mirror template changes)
- [x] 9.5 Update all internal references in other `.claude/commands/sr/*.md` files
- [x] 9.6 Rename agent memory directories in `.claude/agent-memory/` to sr-prefixed
- [x] 9.7 Rename persona files in `.claude/agents/personas/` to sr-prefixed

## 10. Update specrails docs/ [core]

- [x] 10.1 Update `docs/2026-03-07-parallel-implement-session.md` — leave as-is (historical record, per design decision)

## 11. Update specrails-web Documentation [cli]

- [x] 11.1 Update `specrails-web/docs/agents.md`: all agent names → sr-prefixed, trigger commands → `/sr:*`
- [x] 11.2 Update `specrails-web/docs/workflows.md`: all command names → `/sr:*`, agent names → sr-prefixed, opsx references unchanged
- [x] 11.3 Update `specrails-web/docs/installation.md`: agent file structure → sr-prefixed, command structure → sr/ subdirectory
- [x] 11.4 Update `specrails-web/docs/getting-started.md`: command examples → `/sr:*`, agent count description
- [x] 11.5 Update `specrails-web/docs/concepts.md`: agent name references → sr-prefixed
- [x] 11.6 Update `specrails-web/docs/customization.md`: command references → `/sr:*`

## 12. Update specrails-web Components [cli]

- [x] 12.1 Update `specrails-web/src/components/CommandsSection.tsx`: all command names → `/sr:*`
- [x] 12.2 Update `specrails-web/src/components/DemoSection.tsx`: agent names → sr-prefixed, command names → `/sr:*`
- [x] 12.3 Update `specrails-web/src/components/FeaturesSection.tsx`: command references → `/sr:*`
- [x] 12.4 Update `specrails-web/src/components/AgentsSection.tsx`: agent names → sr-prefixed (if referenced)
- [x] 12.5 Update `specrails-web/src/lib/docs-registry.ts`: command name references → `/sr:*`

## 13. Update specrails-web Embedded Copy [cli]

- [x] 13.1 Rename agent files in `specrails-web/specrails/.claude/agents/` to sr-prefixed
- [x] 13.2 Update frontmatter in renamed agent files
- [x] 13.3 Move command files to `specrails-web/specrails/.claude/commands/sr/`
- [x] 13.4 Update internal references in moved command files
- [x] 13.5 Rename agent template files in `specrails-web/specrails/templates/agents/` to sr-prefixed
- [x] 13.6 Move command templates to `specrails-web/specrails/templates/commands/sr/`
- [x] 13.7 Update `specrails-web/.specrails-manifest.json` with sr-prefixed paths
- [x] 13.8 Rename agent memory directories in `specrails-web/specrails/.claude/agent-memory/`

## 14. Update specrails-web Other Files [cli]

- [x] 14.1 Update `specrails-web/.claude/web-manager/README.md`: command examples → `/sr:*`
- [x] 14.2 Update `specrails-web/.claude/web-manager/server/spawner.test.ts`: `/implement` → `/sr:implement` in test cases
- [x] 14.3 Update `specrails-web/.claude/web-manager/server/index.test.ts`: command references
- [x] 14.4 Update `specrails-web/.claude/web-manager/client/src/components/CommandInput.tsx`: placeholder text
- [x] 14.5 Update `specrails-web/specrails/README.md`: agent names and command names
- [x] 14.6 Update `specrails-web/CLAUDE.md`: command references → `/sr:*`

## 15. Update Test Suite [core]

- [x] 15.1 Update `tests/test-install.sh`: any agent/command name references → sr-prefixed
- [x] 15.2 Update `tests/test-update.sh`: any agent/command name references → sr-prefixed, add migration test cases
- [x] 15.3 Run full test suite to verify no regressions
