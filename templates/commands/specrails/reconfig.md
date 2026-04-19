# Reconfig: Apply Agent Config to Generated Files

Reads `.specrails/agents.yaml` and updates the `model:` frontmatter field in all generated `{{SPECRAILS_DIR}}/agents/sr-*.md` files to match. No full re-setup needed — only model frontmatter is changed.

---

## Step 1: Locate generated agents directory

Determine `$SPECRAILS_DIR`:

1. Read `.specrails/setup-templates/.provider-detection.json` to get `cli_provider` and `specrails_dir`.
2. If the file does not exist, default to `cli_provider = "claude"` and `specrails_dir = ".claude"`.
3. Set `$AGENTS_DIR = $SPECRAILS_DIR/agents`

## Step 2: Read agent config

Read `.specrails/agents.yaml`.

If the file does not exist, stop and display:

```
No .specrails/agents.yaml found.

Run {{COMMAND_PREFIX}}enrich to generate the config file, then edit it before running {{COMMAND_PREFIX}}reconfig.
```

If the file exists, parse it. Validate all `model:` values — only `opus`, `sonnet`, and `haiku` are accepted. If an invalid value is found, display a warning and skip that agent:

```
Warning: unknown model "gpt-4" for sr-developer — skipping (valid values: opus, sonnet, haiku)
```

## Step 3: Resolve model for each agent

For each agent file found in `$AGENTS_DIR/sr-*.md`:

1. Extract the agent name from the filename (e.g., `sr-developer.md` → `sr-developer`)
2. Resolve the target model:
   - Check `agents.<agent-name>.model` in config (per-agent override)
   - If not present, check `defaults.model` in config (global default)
   - If neither is present, skip this agent
3. Read the current `model:` value from the file's YAML frontmatter
4. If the current model matches the target model, mark as **unchanged**
5. If they differ, record the change: `sr-<name>: <current> → <target>`

## Step 4: Apply changes

For each agent with a recorded change:

1. Read the file
2. Replace the `model:` line in the YAML frontmatter with the resolved value
3. Write the file back

The `model:` line is always in the frontmatter block (between the first `---` and second `---`). Replace only that specific line — do not modify any other content.

**Codex format:** If `cli_provider == "codex"`, apply the same logic to `.codex/agents/sr-*.toml` files. Replace the `model = "..."` line with the mapped Codex model:
- `sonnet` → `gpt-5.4`
- `opus` → `gpt-5.3-codex`
- `haiku` → `gpt-5.4-mini`

## Step 5: Report results

Display a summary of what changed:

```
## Reconfig complete

Updated 2 agent(s):
  sr-developer:       sonnet → opus
  sr-product-analyst: haiku  → sonnet

Unchanged (3):
  sr-architect, sr-reviewer, sr-product-manager

Skipped (1):
  sr-custom-agent (not in config)
```

If nothing changed:

```
All agents already match .specrails/agents.yaml — nothing to update.
```

If all agents were skipped due to validation errors, display:

```
No agents updated. Fix the validation errors in .specrails/agents.yaml and retry.
```
