# Updating

SpecRails includes an update system that pulls new templates while preserving your customizations.

## How updates work

The update system uses a **manifest-based approach**:

1. During installation, SpecRails generates `.specrails/specrails-manifest.json` — a checksum of every installed file
2. On update, the new templates from the latest specrails-core release are re-applied
3. Reserved paths (`.specrails/profiles/**`, provider-specific `custom-*`
   roles, OpenSpec skills, and user MCP entries) are preserved by construction

## Running an update

```bash
npx specrails-core@latest update
```

Cross-platform (macOS, Linux, Windows). No bash, no python required — the installer is native Node since v4.2.0.

### What happens

1. **Version check** — reads existing `.specrails/specrails-version`; aborts if no specrails install is detected
2. **Provider resolution** — detects Claude (`.claude/`), Codex (`.codex/`),
   Gemini (`.gemini/`), or Kimi (`.kimi-code/`). In a multi-provider workspace,
   pass `--provider` to select the tree being refreshed.
3. **Re-scaffold** — re-applies templates from the latest specrails-core into `.specrails/setup-templates/` and the provider directory
4. **Reserved paths** — profiles and provider-specific custom roles are skipped;
   Kimi also preserves `openspec-*`, unknown skill directories, and existing
   `.kimi-code/mcp.json` entries
5. **Manifest refresh** — rewrites `specrails-manifest.json` and `specrails-version` to the new core version

## Selective updates (`--only`)

The `--only <component>` flag is recognised but currently warns and applies the full scaffold. Granular component selection is tracked as a follow-up — the Node installer's transactional behaviour makes a targeted re-apply almost equivalent to a full one for the common case (core version bump).

## Dry run

```bash
npx specrails-core@latest update --dry-run
```

Prints what the update would do without writing any files. Useful for inspecting `previousVersion → currentVersion` before committing.

## What gets preserved

| File type | Behavior |
|-----------|----------|
| **Agent prompts** (`.claude/agents/sr-*.md`) | Re-written from latest templates |
| **Custom agents** (`.claude/agents/custom-*.md`) | **Always preserved** (reserved path) |
| **Profile JSON** (`.specrails/profiles/**`) | **Always preserved** (reserved path) |
| **Commands** (`.claude/commands/specrails/`) | Re-written |
| **Rules** (`.claude/rules/`) | Re-written from latest templates |
| **Agent memory** (`.claude/agent-memory/`) | Untouched (created on first install only) |
| **install-config.yaml** | Untouched |
| **Kimi workflows** (`.kimi-code/skills/specrails-*`) | Re-written from latest templates |
| **Kimi roles** (`.kimi-code/skills/sr-*`) | Re-written according to the selected agent set |
| **Kimi custom roles** (`.kimi-code/skills/custom-*`) | **Always preserved** |
| **Kimi OpenSpec skills** (`.kimi-code/skills/openspec-*`) | Preserved and normalized from legacy `.kimi/skills` when needed |
| **Kimi MCP config** (`.kimi-code/mcp.json`) | Existing entries preserved; SpecRails-owned entries merged additively |
| **Kimi headless runner** (`.kimi-code/specrails/`) | Runner, vendored YAML parser, MIT license, and provenance notice are re-written together from the latest trusted Core template; they are managed code, not user skills |

Kimi discovers only immediate child directories of `.kimi-code/skills`.
Updates therefore migrate the pre-release
`.kimi-code/skills/rails/custom-*` layout to direct `custom-*` children when
the destination is free, and regenerate managed `sr-*` roles at the direct
level. If both legacy and direct versions of a custom role exist, neither is
overwritten or deleted: `doctor` reports the conflict for manual resolution.

## Rolling back

The Node installer is idempotent: re-running `init` (or pinning an older version with `npx specrails-core@<version> update`) restores the prior layout. Profile and custom-agent files are reserved, so nothing critical is destroyed by a forward-then-backward sequence.

If you need a true point-in-time rollback, the recommended path is git: commit before updating, `git checkout` to revert.

---

## What's next?

That's the end of the docs. Here are some useful starting points:

- [Getting Started](getting-started.md) — if you haven't installed yet
- [Workflows & Commands](workflows.md) — to start using the pipeline
- [Customization](customization.md) — to make SpecRails yours

---

[← Customization](customization.md) · [Back to Docs](README.md)
