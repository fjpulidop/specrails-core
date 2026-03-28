# Migration Guide: Switching to Local Tickets

This guide is for teams currently using GitHub Issues or JIRA as their specrails backlog provider who want to switch to the built-in local ticket system.

Switching is optional. GitHub Issues and JIRA remain fully supported. Local tickets are the recommended default for new projects.

---

## Should you switch?

**Switch to local tickets if:**
- Your team prefers a simple, zero-dependency setup
- You want tickets version-controlled alongside your code
- You don't need GitHub/JIRA for other workflows (project boards, external stakeholders)

**Stay on GitHub Issues / JIRA if:**
- Other teams or stakeholders manage tickets in those tools
- You rely on GitHub Projects, Milestones, or JIRA sprints
- You want PR auto-close on issue merge (requires GitHub Issues)

---

## Step 1: Switch the provider

Edit `.claude/backlog-config.json` in your project root:

```json
{
  "provider": "local",
  "write_access": true,
  "git_auto": true
}
```

Then initialize the ticket store if it doesn't exist yet:

```bash
# Inside Claude Code or Codex
/specrails:implement --setup-local-tickets
```

Or create the file manually:

```bash
cat > .claude/local-tickets.json << 'EOF'
{
  "schema_version": "1.0",
  "revision": 0,
  "last_updated": null,
  "next_id": 1,
  "tickets": {}
}
EOF
```

---

## Step 2: Import existing issues (one-time migration)

### From GitHub Issues

Use the `sr:migrate-from-github` command (requires `gh` CLI):

```bash
# Inside Claude Code
/specrails:migrate-from-github
```

This command:
1. Fetches all open issues labeled `product-driven-backlog` (the label specrails uses)
2. Maps GitHub issue fields to local ticket schema:
   - `number` → `id` (uses next available local ID)
   - `title` → `title`
   - `body` → `description`
   - `labels` → `labels`
   - `state: open` → `status: todo`
3. Writes each ticket to `local-tickets.json`
4. Prints a summary: `Imported 14 tickets from GitHub Issues`

To import all open issues regardless of label:

```bash
/specrails:migrate-from-github --all
```

To do a dry run (preview without writing):

```bash
/specrails:migrate-from-github --dry-run
```

**After import:** Your GitHub Issues are unchanged. The migration is additive — it only creates local tickets. You can continue using GitHub Issues in parallel until you're ready to stop.

### From JIRA

Use the `sr:migrate-from-jira` command (requires `jira` CLI or REST API credentials in `.claude/backlog-config.json`):

```bash
# Inside Claude Code
/specrails:migrate-from-jira
```

This command:
1. Fetches all open issues from the configured JIRA project
2. Maps JIRA fields to local ticket schema:
   - Issue key (`PROJECT-123`) → stored in `metadata.jira_key`
   - `summary` → `title`
   - `description` → `description`
   - `priority` → `priority` (Critical/High/Medium/Low mapped directly)
   - `status: To Do / Backlog` → `status: todo`
   - `status: In Progress` → `status: in_progress`
   - `labels` → `labels`
3. Writes each ticket to `local-tickets.json`

The original JIRA key is preserved in `metadata.jira_key` so you can cross-reference during the transition.

---

## Step 3: Regenerate commands (optional but recommended)

Command templates are generated at `/specrails:setup` time with provider-specific instructions baked in. After switching providers, regenerate them so commands use the local file operations instead of GitHub/JIRA CLI calls:

```bash
npx specrails-core@latest init --root-dir .
> /specrails:setup --update
```

The `--update` flag regenerates only the backlog commands (`product-backlog`, `update-product-driven-backlog`, `implement`) without re-running the full stack analysis.

---

## Rollback

To revert to GitHub Issues:

1. Edit `.specrails/config.yaml` (or `.claude/backlog-config.json` for scaffold installs) and set `provider: github`
2. Re-run `/specrails:setup --update` to regenerate commands
3. Your `local-tickets.json` is preserved — switch back any time

Local tickets and external provider data are independent. Switching providers does not delete tickets from either system.
