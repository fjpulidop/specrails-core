## Context

Engine v2 composes reviewed pieces. Planning (`architect`) and implementation (`developer`) roles exist; `openspec-validate` already runs strict validation and the archive preflight; `artifact-contract` counts tasks; `change-scope.ts` measures the run's diff from `repositories[].baseSha` to the working tree, excluding `.specrails/` and the change directory. Flow reserves a worktree at a known SHA and commits the explored work before launch.

## Goals / Non-Goals

**Goals:**
- One piece that turns an existing diff into a complete, valid, archivable OpenSpec change with every task checked.
- Coverage decided by Core, not by the model, and visible to the reviewer and Desktop.
- Reuse the role-turn path (routing, budgets, accounting, single structured repair, OpenSpec participation checks).

**Non-Goals:**
- No change to the legacy implementation graph or to `roleIds(config)`.
- No new `PipelineContext` field and no `headRef`: the diff is base to working tree.
- `write_artifact` keeps its four artifact kinds; the deriver never writes `derivation.json`.

## Decisions

- **Engine role instead of a fourth built-in.** Adding `deriver` to `BUILTIN_ROLES` would make `agents.deriver` mandatory in every configuration and add a role to legacy summaries and capability probes. A separate `ENGINE_ROLES` list keeps the fixed policy (`read`/`all`/`openspec-ff-change`) and Core-owned text, reuses the architect's assignment, and is admitted only by engine definitions (`configuredRoles`). The id is reserved for custom roles.
- **Deriver text through the custom-role path.** `roleInstructions` renders engine roles like declared roles, with Core's instructions instead of a configured prompt; the version is `ROLE_INSTRUCTIONS_VERSION` 15.
- **Verification plan binding.** The legacy architect node writes `verification/plan.json` and binds it in `state.json`; engine v2 pieces never create `state.json`. The engine equivalent is `verify.additionalCommandsFrom`, which admits a committed output's `structured.verification`. The piece always returns that array (bounded to 20, the `verify` limit).
- **Coverage parser.** `## Blast radius` is found by heading (numbered or bold accepted, fenced blocks ignored) and ends at the next heading of the same or higher level. A path matches only as a whole path (no prefix/suffix/parent confusion), after NFC normalization and markdown unescaping; `./path`, Windows separators, and with several repositories `<id>/<path>` or `<id>:<path>` also match. Multi-repository labels are `<id>:<path>`.
- **Repair loop.** The node returns `fail` with a history note and `output.repair`; the next visit appends that note to the deriver's task in the same session. Coverage gaps never fail the node; they reach the reviewer.
- **OpenSpec scaffolding.** `openspec new change` scaffolds `openspec/config.yaml` (`schema: spec-driven`) in a repository without one. On a repair visit that file is the deriver's own side effect, so an added file with exactly that content is not part of the derived change set.
- **Summary file.** Relative to `.specrails/pipeline/<runId>/`, resolved with `artifactPath` (no `..`, no absolute paths, no symlinks), at most 32 KB. Absent parameter, missing file or empty file means "derive from the diff alone". Optional front matter `transcriptTurns: <n>` feeds `transcriptTurnsUsed`.

## Risks / Trade-offs

- [Untracked files present at the first change-set measurement count as pre-existing] → Desktop commits the Flow work before launch (documented in the contract and desktop integration guide).
- [A model may describe a file without the exact path] → the deriver is told the check is mechanical; the reviewer receives every gap as an issue.
- [Reserved `deriver` id] → a configuration that already declared a custom `deriver` role is now rejected; no such configuration is known.
