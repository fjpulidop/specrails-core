# Updating

SpecRails includes an update system that pulls new templates while preserving your customizations.

## How updates work

The update system uses a **manifest-based approach**:

1. During installation, SpecRails generates `.specrails/specrails-manifest.json` — a checksum of every installed file
2. On update, the new templates from the latest specrails-core release are re-applied
3. Reserved paths (`.specrails/profiles/**`, `.claude/agents/custom-*.md`) are preserved by construction — the installer never touches them

## Running an update

```bash
npx specrails-core@latest update
```

Cross-platform (macOS, Linux, Windows). No bash, no python required — the installer is native Node since v4.2.0.

### What happens

1. **Version check** — reads existing `.specrails/specrails-version`; aborts if no specrails install is detected
2. **Provider resolution** — detects whether the project uses Claude (`.claude/`) or Codex (`.codex/`)
3. **Re-scaffold** — re-applies templates from the latest specrails-core into `.specrails/setup-templates/` and the provider directory
4. **Reserved paths** — `.specrails/profiles/**` and `.claude/agents/custom-*.md` are skipped; your team profiles and custom agents survive untouched
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
