## Context

Core 6 is a thin Desktop-only engine. Roles run through `src/agent-runtime` with prompts composed in `prompts.ts`; Desktop launches them with `claude -p` / `codex exec` and never through provider-native subagents. The installer (`src/installer/phases/scaffold.ts`) predates that and still renders `templates/agents/sr-*.md` into every provider layout, seeds per-role agent-memory, pre-acknowledges Gemini agents and filters by `selectedAgents`. `src/installer/commands/init.ts` uses the trio of role files to recognise an installed workspace (`hasCopiedCoreRoles`), and `install-config.ts` rejects a configuration without `agents.selected`.

Desktop (paired change `retire-installed-role-agents`) currently counts `sr-*` files to mark setup complete and to seed profiles. Both sides move together; Core must stay tolerant of the install configuration Desktop still writes today.

## Goals / Non-Goals

**Goals:**
- One source of truth for role definitions: the runtime. No role file leaves `node_modules`.
- A fresh workspace for claude, codex, gemini and kimi contains no `sr-*` artifact; an upgraded workspace loses the ones an older Core linked or copied.
- Reserved `custom-*` roles and user files are byte-identical before and after assemble.
- Older install configurations (with `agents.selected`) and the `--selected-agents` flag keep working, with a visible deprecation warning.
- Contract 5.2 carries no role identifiers; Desktop negotiates by capability, not by version.

**Non-Goals:**
- Changing the runtime prompts, the OpenSpec binding or workflow identity.
- Removing Desktop's profiles or custom-role features (Desktop decides; Core only stops shipping baseline roles).
- Renumbering or rewriting shipped checkpoints beyond removing `agent_generation`.

## Decisions

- **Delete the templates instead of leaving empty directories.** The package `files` list keeps `templates/`; `package-surface.test.ts` asserts the exact template inventory, so the inventory becomes `commands`, `kimi`, `settings` (codex-skills is removed entirely since rails were its only content). Alternative: keep `templates/agents` empty for layout stability. Rejected: an empty directory is not shipped by npm and only hides the removal.
- **Prune stale role artifacts inside assemble, keyed by name, never by content.** `linkAgentFiles` already removes stale symlinks and framework-shaped copies but is skipped when the framework has no `agents/`. Assemble now runs the prune for every provider even when the framework subtree is absent: `agents/sr-*.md` symlinks or regular files (claude, gemini), `skills/rails/sr-*` and the empty `rails/` container (codex), `skills/sr-*` (kimi). `custom-*` and unknown names are skipped. Alternative: a one-off migration command. Rejected: assemble runs on every swap and Desktop drives it; a separate command would need a Desktop flow.
- **Keep `agents/` as a reserved, user-owned subtree.** `LINKED_PROVIDER_SUBTREES` drops `agents` for claude and gemini (nothing to link). The reserved path `<provider>/agents/custom-*.md` stays in `RESERVED_PATHS`; the installer never creates the directory anymore.
- **Install configuration: optional and ignored, not rejected.** Desktop still serialises `agents.selected`/`agents.excluded`. Rejecting it would break every existing Desktop until the paired release ships. When present the lists are validated as before (safe ids, no overlap, known preset) and a non-empty selection logs one warning: "agent selection is ignored since Core 6.3; roles are runtime-defined". `models.overrides` keys stay free-form safe ids (Desktop may still map custom roles).
- **Contract 5.2 (minor).** Removing `agent_generation` is safe because Desktop requires contract checkpoints to be a subset of its own. `configSchema.agents` is marked optional with a deprecation note; `modelPresets.max.overrides` becomes `{}`.
- **Kimi keeps `translateClaudeTextForKimi` and the workflow-skill writer**; only `writeKimiRoleSkill`, the role filter in `linkKimiSkillDirectories` (now a plain prune of `sr-*`) and role agent-memory go. `migrateLegacyKimiRoleLayout` stays because it still rescues `custom-*` from the legacy `rails/` layout.
- **Gemini:** `GEMINI_AGENT_TOOLS`, `GEMINI_MODEL_BY_AGENT`, `geminiAgentLimitMetadata`, `OPSX_TO_GEMINI_SKILL`/`translateOpsxSkillCallsForGemini`, `placeGeminiAgents`, `writeGeminiAgentFromTemplate` and `writeGeminiAgentAcknowledgments` are deleted with their tests. Gemini commands (TOML) and settings are unchanged.

## Risks / Trade-offs

- [Desktop built against contract 5.1 reads `agent_generation` from the contract] → Desktop treats contract checkpoints as a subset of its list; the paired Desktop change also stops deriving completion from agents.
- [A user kept a hand-edited `sr-*.md` in `.claude/agents`] → It was always a framework-owned name and older Core already replaced it on every swap; the prune keeps that contract. Documented in the CHANGELOG entry.
- [Package and framework hashes change] → Expected: a new framework version is materialised; retained runs keep their frozen package.
- [Kimi smoke in Desktop CI asserts `skills/sr-architect/SKILL.md`] → Updated in the paired Desktop change; Core's own `check:package` asserts the runtime only.

## Migration Plan

1. Release Core with this change (6.3.0).
2. Desktop bumps Core and ships `retire-installed-role-agents` (setup completion by commands, profiles without baseline files, smoke script updated). Either order works: Core 6.3 tolerates the old install config, and Desktop's new detection tolerates old Core output.
3. No user action: the next assemble (project open, Core swap) prunes stale role artifacts.

## Open Questions

- None. Desktop's reserved paths and custom roles are unchanged.
