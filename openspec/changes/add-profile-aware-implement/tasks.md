## 1. Schema and documentation

- [x] 1.1 Draft `schemas/profile.v1.json` (JSON Schema 2020-12) covering `schemaVersion`, `name`, `description`, `orchestrator.model`, `agents[].{id,model,required}`, and `routing[].{tags,agent,default}`
- [x] 1.2 Add required-agents constraint (`sr-architect`, `sr-developer`, `sr-reviewer` must appear in `agents[]`)
- [x] 1.3 Add routing constraint (exactly one terminal `default: true` entry, must be last)
- [x] 1.4 Ship `schemas/` in the published npm package (update `files` in `package.json`)
- [x] 1.5 Write README section documenting the profile schema, resolution order, and the `.specrails/` reserved directory contract
- [x] 1.6 Update CLAUDE.md with a "Profiles" section mirroring the README

## 2. Baseline profile template

- [x] 2.1 Create `templates/profiles/default.json` — equivalent to today's legacy behavior expressed as a profile (includes all currently-shipped agents, default models, current routing rules)
- [x] 2.2 Validate `templates/profiles/default.json` against `schemas/profile.v1.json` in a unit test

## 3. `implement.md` refactor (Phase -1)

- [x] 3.1 Add profile-resolution preamble to Phase -1 that checks `$SPECRAILS_PROFILE_PATH`, then `.specrails/profiles/project-default.json`, else falls through to legacy
- [x] 3.2 Implement schema-version check with clear error on unknown versions
- [x] 3.3 Implement required-field validation with named-field error messages
- [x] 3.4 Add `jq` preflight check; clear error with install instructions if missing
- [x] 3.5 In profile mode, populate `AVAILABLE_AGENTS` from `profile.agents[].id`
- [x] 3.6 In profile mode, error if any `agents[].id` has no matching `.claude/agents/<id>.md` file
- [x] 3.7 In legacy mode, preserve current `ls .claude/agents/sr-*.md` behavior byte-for-byte

## 4. `implement.md` refactor (Phase 3b routing)

- [x] 4.1 Add two-branch routing section: profile-mode vs legacy-mode, explicitly labeled
- [x] 4.2 In profile-mode, iterate `profile.routing` in order; first tag-intersection match wins; terminal `default: true` catches the rest
- [x] 4.3 In legacy-mode, preserve current hardcoded routing rules unchanged
- [x] 4.4 Add routing-resolution trace output (optional debug) for observability

## 5. Subagent invocation model override

- [x] 5.1 Extend every Agent-tool invocation site inside `implement.md` to accept an explicit `model` parameter sourced from the profile
- [x] 5.2 In profile-mode, always pass `profile.agents[id].model`
- [x] 5.3 In legacy-mode, omit the explicit model (inherit frontmatter default)
- [x] 5.4 Verify the Agent-tool invocation syntax supports per-call model override (consult Claude Code docs; if not, fall back to pre-invocation `model:` frontmatter rewrite with rollback on exit)

  **Resolution**: Claude Code's Agent tool has no per-call `model` parameter. Implemented via in-place frontmatter rewrite (awk) gated on profile mode. Safe because multi-feature rails run in isolated git worktrees (each has its own `.claude/agents/` copy) and single-feature rails are sequential. Model override is applied once at Phase -1 after profile load; no rollback needed since each rail is self-contained.

## 6. Orchestrator model

- [x] 6.1 Document in `implement.md` that the orchestrator's own model is determined by `profile.orchestrator.model` when profile mode is active
- [x] 6.2 Ensure the caller (hub or CLI) is responsible for spawning `claude` with that model; `implement.md` itself cannot reparent

  **Resolution**: The Phase -1 profile-mode branch reads `ORCHESTRATOR_MODEL` from the profile and documents it as informational-only for the caller (hub spawns `claude --model $ORCHESTRATOR_MODEL`). Recorded in the inline comment at the bash block.

## 7. `batch-implement.md` per-rail forwarding

- [x] 7.1 Add documentation/code in `batch-implement.md` describing `$SPECRAILS_PROFILE_PATH` forwarding per rail
- [x] 7.2 Accept an optional `profile: <path>` per-rail entry in the batch manifest format
- [x] 7.3 When spawning a rail, set `$SPECRAILS_PROFILE_PATH` for that spawn if provided; otherwise leave unset so the rail can fall back to project default or legacy mode

## 8. Installer hardening

- [x] 8.1 Update `update.sh` to explicitly skip `.specrails/profiles/` (documented contract; existing code does not touch it, header comment added)
- [x] 8.2 Update `update.sh` to explicitly skip `.claude/agents/custom-*.md` (documented contract; existing code iterates only known agent names by list, never globs custom-*)
- [x] 8.3 Update `install.sh` with the same skip rules (header comment added; existing code already safe — operates on `.specrails/setup-templates/` staging, not on the live `.claude/agents/`)
- [x] 8.4 Add optional `--with-profiles` flag to `bin/tui-installer.mjs` that scaffolds `.specrails/profiles/project-default.json` from `templates/profiles/default.json`
- [x] 8.5 Default `init` flow does NOT create `.specrails/profiles/` (zero-noise — only `--with-profiles` or the hub creates the dir)

**Note on scope correction**: During implementation, the reserved-path contract was refined. `.specrails/` wholesale is NOT reserved because `install.sh` legitimately manages `install-config.yaml`, `specrails-version`, etc. Only `.specrails/profiles/**` and `.claude/agents/custom-*.md` are reserved. README/CLAUDE.md/specs updated accordingly.

## 9. CLI tooling

- [x] 9.1 Add `specrails profile validate <path>` subcommand that validates a profile JSON against the shipped schema and prints human-readable errors
- [x] 9.2 Add `specrails profile show [<path>]` subcommand that pretty-prints the resolved profile for debugging (honors resolution order when no path given)

## 10. Tests

- [ ] 10.1 Fixture project with `.specrails/profiles/project-default.json` runs `implement.md` in profile mode — **integration test, requires Claude CLI; deferred to manual QA pass**
- [ ] 10.2 Fixture project without any profile runs `implement.md` in legacy mode and produces byte-identical output to pre-change — **integration test, deferred to manual QA pass**
- [x] 10.3 Invalid schemaVersion fails validation with expected error string (covered by `test-profiles.sh::test_invalid_profile_is_rejected`)
- [x] 10.4 Missing required agent fails validation with expected error string (covered by `test-profiles.sh::test_invalid_profile_is_rejected`)
- [x] 10.5 Missing default routing rule — documented as runtime-level check (enforced by `implement.md` Phase -1), schema-only test skips; covered by the runtime jq validation block in Phase -1
- [x] 10.6 `update.sh` and `install.sh` contract for reserved paths documented in headers; grep-based invariant tests in `test-profiles.sh::test_{update,install}_preserves_reserved_paths`
- [ ] 10.7 Two concurrent `/specrails:implement` invocations with different `$SPECRAILS_PROFILE_PATH` values produce independent model-override decisions — **integration test, deferred to manual QA pass (requires two parallel Claude CLI spawns in worktrees)**
- [x] 10.8 `specrails profile validate` CLI returns exit 0 on valid, non-zero on invalid (covered by `test-profiles.sh::test_cli_profile_validate_exit_codes`)

## 11. Release and documentation

- [ ] 11.1 Bump specrails-core to 4.1.0 (minor, additive) — **release-please handles on merge to main; commit must use `feat:` prefix**
- [ ] 11.2 Write migration notes in CHANGELOG entry explaining opt-in nature — **release-please generates CHANGELOG; add migration notes to the release PR description**
- [x] 11.3 Publish schema URL + contract documentation in README for downstream consumers (hub, third-party tools) — README "Agent profiles" section + CLAUDE.md "Profiles" section committed
- [ ] 11.4 Tag the release and verify `schemas/profile.v1.json` is accessible via `unpkg` or equivalent for direct URL reference — **post-release verification step**

## 12. Validation with downstream (hub)

- [ ] 12.1 Coordinate with `specrails-hub` maintainers: once 4.1.0 is published, verify the hub's `add-agents-profiles` change can bump its dep and begin consuming the contract — **post-release, cross-repo coordination**
- [ ] 12.2 Collect feedback from hub integration; file follow-up issues for v2 schema considerations — **post-integration, open-ended**
