## Why

SpecRails Core supports Claude Code, Codex, and Gemini CLI, but cannot install or run its complete workflow with Kimi Code even though Kimi provides a headless agentic CLI, project skills, MCP, sessions, and model selection. Adding Kimi as a first-class provider gives users another independent coding runtime without requiring Claude Code or a bundled daemon.

## What Changes

- Add `kimi` to provider detection, explicit selection, configuration validation, prerequisite reporting, and provider-aware diagnostics.
- Target the current TypeScript Kimi Code CLI and execute unattended work
  through a Core-managed, self-contained skill materializer which safely
  launches external `kimi -p --output-format stream-json`.
- Generate Kimi-native project artifacts under `.kimi-code/`, including `AGENTS.md`, SpecRails workflow skills, direct-child rail-role skills, rules, memory/state directories, and MCP-compatible layout.
- Expose `/skill:<name>` only as interactive Kimi TUI syntax. Materialize the
  initial skill for headless prompt mode, where slash text is otherwise
  literal, and translate nested SpecRails/OpenSpec invocations to Kimi's native
  `Skill` tool with explicit `skill` and `args` fields.
- Compensate for Kimi subagents inheriting their parent model by allowing SpecRails-managed role invocations to select a Kimi model per headless process.
- Make init, update, framework materialization, relocated workspaces, manifests, reserved paths, and cleanup aware of Kimi without changing other provider trees.
- Install and manage `.kimi-code/specrails/run-skill.mjs` together with a
  vendored `js-yaml` ESM distribution, license, and provenance notice so the
  helper never depends on the consumer project's `node_modules`.
- Safely migrate the pre-release nested `.kimi-code/skills/rails` role layout,
  preserving user-authored custom roles and surfacing collisions instead of
  overwriting either copy.
- Normalize the current published OpenSpec Kimi output from legacy `.kimi/skills` into `.kimi-code/skills` until the corrected upstream layout is released.
- Preserve a CLI-only integration: Core neither bundles Kimi nor installs or supervises `kimi server`.

## Capabilities

### New Capabilities

- `kimi-provider`: First-class installation, rendering, headless execution contract, update behavior, and diagnostics for Kimi Code CLI.

### Modified Capabilities

None.

## Impact

- Installer provider types, detection, authentication, configuration, scaffold, framework, update, doctor, manifests, paths, and tests.
- New Kimi templates and generated `.kimi-code` artifacts.
- OpenSpec initialization/post-processing for the Kimi tool target.
- Profile/model validation and role invocation semantics.
- Documentation, CLI help, integration contract, and cross-platform prerequisite guidance.
