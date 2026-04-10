# Updating

SpecRails includes an update system that pulls new templates while preserving your customizations.

## How updates work

The update system uses a **manifest-based approach**:

1. During installation, SpecRails generates `.specrails/specrails-manifest.json` — a checksum of every installed file
2. On update, it compares the manifest against current files to detect what you've customized
3. Customized files are preserved; unchanged files are updated to the latest version

## Running an update

```bash
curl -sL https://raw.githubusercontent.com/fjpulidop/specrails/main/update.sh | bash
```

Or from a local clone:

```bash
bash /path/to/specrails/update.sh
```

### What happens

1. **Backup** — creates `.claude.specrails.backup/` with your current files
2. **Version check** — compares installed version (`.specrails/specrails-version`) with latest
3. **Update files** — replaces unchanged files, preserves customized ones
4. **Merge settings** — additively merges `settings.json` (your permissions are kept)
5. **Update version** — writes new version and manifest

If anything fails, the backup is restored automatically.

## Selective updates

Update only specific components with the `--only` flag:

```bash
# Update core files (setup command, templates, prompts, skills)
bash update.sh --only core

# Update Pipeline Monitor dashboard
bash update.sh --only web-manager

# Regenerate agents (prompts for confirmation if templates changed)
bash update.sh --only agents

# Full update (default)
bash update.sh --only all
```

## What gets preserved

| File type | Behavior |
|-----------|----------|
| **Agent prompts** (`.claude/agents/`) | Preserved if customized; updated if unchanged |
| **Commands** (`.claude/commands/`) | Updated (commands are orchestration, not customized) |
| **Rules** (`.claude/rules/`) | Preserved if customized |
| **Settings** (`settings.json`) | Merged additively (your permissions kept, new ones added) |
| **Agent memory** (`.claude/agent-memory/`) | Always preserved |
| **Personas** (`.claude/agents/*.md`) | Always preserved |
| **Security exemptions** | Always preserved |

## Legacy installations

If you installed SpecRails before the versioning system (pre-v0.1.0):

- The updater detects missing `.specrails/specrails-version` and treats it as a legacy install
- It migrates your installation to the versioned system
- A manifest is generated from your current files
- Future updates use the standard manifest comparison

## Rolling back

If something goes wrong, restore from the automatic backup:

```bash
# Backups are at .claude.specrails.backup/
cp -r .claude.specrails.backup/.claude .claude
cp .claude.specrails.backup/.specrails/specrails-version .specrails/specrails-version
```

---

## What's next?

That's the end of the docs. Here are some useful starting points:

- [Getting Started](getting-started.md) — if you haven't installed yet
- [Workflows & Commands](workflows.md) — to start using the pipeline
- [Customization](customization.md) — to make SpecRails yours

---

[← Customization](customization.md) · [Back to Docs](README.md)
