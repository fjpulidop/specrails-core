## 1. Remove the templates and the inventory that pins them

- [ ] 1.1 Delete `templates/agents/sr-architect.md`, `sr-developer.md`, `sr-reviewer.md` and `templates/codex-skills/` (the three `rails/sr-*/SKILL.md`); update `src/agent-runtime/engine/package-surface.test.ts` (template directory list and agents assertions) and `src/installer/__tests__/template-inventory.test.ts` (no agents, no rails).
- [ ] 1.2 Delete `.claude/rules/agents.md`; update `CLAUDE.md` (layout line about `templates/` and the reserved-path note) and `README.md` (role wording) so the repository describes roles as runtime-defined. Rewrite the stale comment in `scaffold.ts` ("launches `.claude/agents/sr-*.md` via subagent_type") while it still exists.

## 2. Installer scaffold: stop placing roles, prune stale ones

- [ ] 2.1 In `src/installer/phases/scaffold.ts` remove `CORE_AGENTS`, `GEMINI_AGENT_TOOLS`, `OPSX_TO_GEMINI_SKILL`, `translateOpsxSkillCallsForGemini`, `GEMINI_MODEL_BY_AGENT`, `geminiAgentLimitMetadata`, `placeGeminiAgents`, `writeGeminiAgentFromTemplate`, `writeGeminiAgentAcknowledgments`, `writeKimiRoleSkill`, the Claude agents loop in `placeArtefacts` (and its `agents` count), the codex rails placement in `placeSkills`, the Kimi role-skill placement, role agent-memory seeding in `seedProjectLayer` and the `selectedAgents` / `materializeAllAgents` fields of `ScaffoldInput`, the framework input and the assemble input. Keep `translateClaudeTextForKimi` for workflow skills and `migrateLegacyKimiRoleLayout` for `custom-*` rescue. Tests: `src/installer/phases/scaffold.test.ts`, `src/installer/__tests__/scaffold.test.ts`, `src/installer/phases/provider-pipeline.test.ts`, `src/installer/phases/framework.test.ts`.
- [ ] 2.2 Drop `agents` from `LINKED_PROVIDER_SUBTREES` (claude, gemini) and the `agents/` mkdir calls; `detectExistingSetup` probes commands instead of `agents`. Replace `linkAgentFiles` with `pruneStaleRoleArtifacts(workspaceProviderDir, provider)` run by `assembleProjectWorkspace` for every provider: remove `agents/sr-*.md` symlinks and regular files (claude, gemini), `skills/rails/sr-*` and an emptied `rails/` (codex), `skills/sr-*` (kimi); never touch `custom-*` or unknown names. `linkKimiSkillDirectories` links every framework skill and prunes `specrails-*`/`sr-*` strays without a selection set. Tests: stale-link and `custom-*` preservation cases in `src/installer/phases/framework.test.ts`, `src/installer/phases/scaffold.test.ts` and `src/installer/__tests__/reserved-paths.test.ts`.
- [ ] 2.3 Keep `RESERVED_PATHS` in `src/installer/util/paths.ts` unchanged; add a test in `src/installer/util/paths.test.ts` proving `.claude/agents/custom-x.md` is still reserved after the change.

## 3. init, install configuration and framework command

- [ ] 3.1 In `src/installer/commands/init.ts` remove the `CORE_AGENTS` import, `hasCopiedCoreRoles` and `warnUnknownSelectedAgents`; `hasCopiedCoreArtifacts` keeps only the commands/runtime probe; `snapshotWorkspaceProviderSelections` reports no agents; `workspaceHasManagedProviderLink` uses `commands`/`skills` links; stop passing `selectedAgents` to scaffold, `ensureFramework` and `installFramework`; log the "Agents, commands, and rules" line as "Commands and skills". Tests: `src/installer/commands/init.test.ts`, `src/installer/commands/lifecycle-admission.test.ts`.
- [ ] 3.2 In `src/installer/phases/install-config.ts` make the `agents` section optional: when present keep `validateAgentIdList` for `selected`/`excluded`, the overlap check and the preset check; when `selected` is non-empty emit one `warn` that agent selection is ignored since Core 6.3. Keep `models.overrides` validation. Tests: `src/installer/phases/install-config.test.ts` (missing section accepted, legacy selection warns, malformed still rejected, contract consistency).
- [ ] 3.3 In `src/installer/commands/framework.ts` keep parsing `assemble --selected-agents` but ignore it with a deprecation warning. Tests: `src/installer/commands/framework.test.ts`.

## 4. Integration contract and documentation

- [ ] 4.1 Update `integration-contract.json`: `schemaVersion` 5.2, `configSchema.agents` optional with a deprecation note, remove the `agent_generation` checkpoint, set `modelPresets.max.overrides` to `{}`, rewrite the tier description that mentions core agents. Keep `agentRuntime.instructionsVersion` at 13. Tests: `src/agent-runtime/integration-contract.test.ts`, `src/installer/phases/install-config.test.ts` contract consistency.
- [ ] 4.2 Add a repository guard test (for example in `src/installer/__tests__/template-inventory.test.ts`) that fails when any tracked file outside `CHANGELOG.md` and `openspec/` contains `sr-architect`, `sr-developer` or `sr-reviewer`.

## 5. Verification

- [ ] 5.1 Run `npm test` (build, typecheck, vitest) and `npm run check:package`; fix every regression inside the files above. Confirm `templates/` in the packed tarball contains only `commands`, `kimi` and `settings`.
