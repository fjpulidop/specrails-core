# Context Bundle: JIRA Integration — Project Labels and Epic Grouping

Everything a developer needs to implement this feature without reading additional files.

---

## What You Are Building

Two additive changes to the backlog pipeline, activated only when `provider: jira` is set in `.claude/backlog-config.json`:

1. **`/setup` Phase 3.2 (JIRA branch):** Prompt for a project label and epic link field. Store both in `.claude/backlog-config.json`. GitHub Issues path is unchanged.

2. **`/update-product-driven-backlog` Assembly phase:** When `provider=jira`, group discovered features by area, ensure a JIRA epic exists per area (creating it if absent), and create each Story ticket linked to its epic with the configured project label.

The entire feature is prose changes to Markdown command files and a JSON schema extension. No new agents, no shell script changes, no new tools.

---

## Files to Change

| File | Change type | Notes |
|------|-------------|-------|
| `commands/setup.md` | Modify | Active setup command in this repo — source of truth until a template is extracted |
| `templates/commands/update-product-driven-backlog.md` | Modify | Source template — authoritative for target repos |
| `.claude/commands/update-product-driven-backlog.md` | Modify | Active generated command — must mirror template content |
| `templates/commands/setup.md` | Create (if needed) | Only if `install.sh` copies from this path — verify in T7 |

Do NOT modify:
- `install.sh`
- `.claude/backlog-config.json` (runtime-generated, not checked in)
- Any agent files
- Any persona files

---

## Current State of Relevant Files

### `commands/setup.md` — Phase 3.2 JIRA branch (current)

The JIRA branch currently:
1. Checks for `jira` CLI, offers install options
2. Prompts for JIRA base URL, project key, auth method, issue type
3. Prompts for access mode (Read & Write / Read only)
4. Writes `.claude/backlog-config.json` with these fields:
   ```json
   {
     "provider": "jira",
     "write_access": true,
     "jira_base_url": "...",
     "jira_project_key": "...",
     "issue_type": "Story",
     "auth_method": "api_token",
     "cli_installed": true
   }
   ```

**Where to insert new prompts:** Between the `## JIRA — Access Mode` block (which ends with setting `BACKLOG_WRITE`) and the `Store the full configuration in .claude/backlog-config.json:` block.

### `.claude/commands/update-product-driven-backlog.md` — Assembly section (current)

The Assembly section currently has one sync path: GitHub Issues. It looks like:

```
## Assembly — Backlog Sync

After the Explore agent completes:

1. Display results to the user.

### Sync to GitHub Issues (BACKLOG_WRITE=true)

2. Fetch existing product-driven backlog items...
   gh issue list --label "product-driven-backlog" ...

3. Initialize backlog labels (idempotent):
   gh label create "product-driven-backlog" ...

4. For each proposed feature, create a GitHub Issue (skip duplicates):
   gh issue create ...

5. Report sync results.

### If BACKLOG_WRITE=false — Display only

2. Display all proposed features...
3. Do NOT create, modify, or comment on any issues/tickets.
```

### `templates/commands/update-product-driven-backlog.md` — Assembly section (current)

Same structure as above but with `{{BACKLOG_FETCH_ALL_CMD}}`, `{{BACKLOG_INIT_LABELS_CMD}}`, `{{BACKLOG_CREATE_CMD}}`, `{{BACKLOG_PROVIDER_NAME}}` placeholders instead of hardcoded `gh` commands.

---

## Exact Changes — Where Each Task Inserts Content

### In `commands/setup.md` — Phase 3.2 JIRA branch

**Insert after the `## JIRA — Access Mode` block, before `Store the full configuration`:**

```markdown
#### Project Label

After the access mode selection, ask:

> **Project Label (optional but recommended)**
>
> JIRA teams often tag all tickets for a product with a project label
> (e.g., `PROJECT-specrails`, `PLATFORM`, `MOBILE`). This label is applied
> to every ticket the backlog pipeline creates — making it easy to filter all
> AI-generated backlog items across JIRA.
>
> Enter a project label, or press Enter to skip:

If the user enters a label: set `PROJECT_LABEL=<value>`.
If the user skips: set `PROJECT_LABEL=""`.

#### Epic Link Field

Ask:

> **Epic Link Field (optional — advanced)**
>
> JIRA Next-Gen (team-managed) projects link stories to epics using the `parent`
> field. JIRA Classic (company-managed) projects use `Epic Link` (customfield_10014).
>
> Which does your project use?
> 1. `parent` — Next-Gen / team-managed **(default)**
> 2. `customfield_10014` — Classic / company-managed

Set `EPIC_LINK_FIELD` to `parent` or `customfield_10014`. Default: `parent`.
```

**Replace the JSON example** in `Store the full configuration in .claude/backlog-config.json:`:

```json
{
  "provider": "jira",
  "write_access": true,
  "jira_base_url": "https://your-company.atlassian.net",
  "jira_project_key": "PROJ",
  "issue_type": "Story",
  "auth_method": "api_token",
  "cli_installed": true,
  "project_label": "<PROJECT_LABEL or empty string>",
  "epic_link_field": "parent",
  "epic_mapping": {}
}
```

**Add to Phase 3.5 Configuration Summary table** (after `Backlog access` row, only shown when `BACKLOG_PROVIDER=jira`):

```
| Project label (JIRA)   | PROJECT-specrails / (none) |
| Epic link field (JIRA) | parent / customfield_10014 |
```

---

### In `templates/commands/update-product-driven-backlog.md` and `.claude/commands/update-product-driven-backlog.md`

**In the Assembly section, add step 2 before the first sync section:**

```markdown
2. Read `.claude/backlog-config.json` and extract:
   - `BACKLOG_PROVIDER` (`github`, `jira`, or `none`)
   - `BACKLOG_WRITE` (from `write_access`)
```

**Update the GitHub section header** from:
```
### Sync to GitHub Issues (BACKLOG_WRITE=true)
```
to:
```
### If provider=github and BACKLOG_WRITE=true — Sync to GitHub Issues
```

**Add the full JIRA section** (after the GitHub section):

```markdown
### If provider=jira and BACKLOG_WRITE=true — Sync to JIRA

Read from `.claude/backlog-config.json`:
- `JIRA_BASE_URL`, `JIRA_PROJECT_KEY`, `AUTH_METHOD`
- `PROJECT_LABEL` (may be empty string)
- `EPIC_MAPPING` (object mapping area name → JIRA epic key)
- `EPIC_LINK_FIELD` (default: `"parent"`)
- `CLI_INSTALLED`

#### Step A: Authenticate

If `AUTH_METHOD=api_token`: require env vars `JIRA_USER_EMAIL` and `JIRA_API_TOKEN`.
If either is missing:
```
Error: JIRA_USER_EMAIL and JIRA_API_TOKEN must be set in your environment.
See: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
```
Stop and do not proceed with sync.

#### Step B: Fetch existing JIRA stories (duplicate check)

```bash
curl -s \
  -H "Authorization: Basic $(printf '%s' "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)" \
  -H "Content-Type: application/json" \
  "${JIRA_BASE_URL}/rest/api/3/search?jql=project%3D${JIRA_PROJECT_KEY}+AND+labels%3Dproduct-backlog+AND+issuetype%3DStory&fields=summary&maxResults=200"
```

Store all `summary` values. Skip any feature whose title matches an existing summary.

#### Step C: Group features by area

From the Explore agent output, group features into `area -> [features]`.
Area names: strip the `area:` prefix (e.g., `area:core` → `core`).

#### Step D: Ensure epics exist per area

For each unique area:

1. **Cache hit:** If `EPIC_MAPPING[area]` is set: use that key. Proceed to Step E.

2. **JIRA search:** Search for existing epic:
   ```bash
   curl -s \
     -H "Authorization: Basic $(printf '%s' "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)" \
     -H "Content-Type: application/json" \
     "${JIRA_BASE_URL}/rest/api/3/search?jql=project%3D${JIRA_PROJECT_KEY}+AND+issuetype%3DEpic+AND+summary+%7E+%22${AREA_NAME}%22&fields=summary,key"
   ```
   If found: set `EPIC_MAPPING[area] = <key>`. Proceed to Step E.

3. **Create epic:**
   ```bash
   curl -s -X POST \
     -H "Authorization: Basic $(printf '%s' "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)" \
     -H "Content-Type: application/json" \
     "${JIRA_BASE_URL}/rest/api/3/issue" \
     --data '{
       "fields": {
         "project": {"key": "'"${JIRA_PROJECT_KEY}"'"},
         "issuetype": {"name": "Epic"},
         "summary": "'"${AREA_DISPLAY_NAME}"'",
         "labels": ["product-backlog"]
       }
     }'
   ```
   If `PROJECT_LABEL` is non-empty, add it to the `labels` array.
   Set `EPIC_MAPPING[area] = <returned key>`.

After all areas are processed: write the updated `EPIC_MAPPING` back to `.claude/backlog-config.json`.

#### Step E: Create Story tickets

For each feature not in the duplicate list:

```bash
curl -s -X POST \
  -H "Authorization: Basic $(printf '%s' "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)" \
  -H "Content-Type: application/json" \
  "${JIRA_BASE_URL}/rest/api/3/issue" \
  --data '{
    "fields": {
      "project": {"key": "'"${JIRA_PROJECT_KEY}"'"},
      "issuetype": {"name": "Story"},
      "summary": "'"${FEATURE_NAME}"'",
      "description": {
        "type": "doc",
        "version": 1,
        "content": [{
          "type": "codeBlock",
          "content": [{"type": "text", "text": "'"${VPC_BODY_ESCAPED}"'"}]
        }]
      },
      "labels": ["product-backlog"],
      "'"${EPIC_LINK_FIELD}"'": {"key": "'"${EPIC_KEY}"'"}
    }
  }'
```

If `PROJECT_LABEL` is non-empty: add it to the `labels` array.
`VPC_BODY_ESCAPED`: the full VPC markdown body with double quotes escaped (`"`→`\"`).

**Error handling:**
- If the API returns an error about the epic key (dead key): log a warning, create the story without epic linkage, continue.
- Any other API error: log the error message and story name, continue to next story.

#### Step F: Report results

```
JIRA sync complete:
- Epics created: {N} (area names)
- Epics reused: {N} (area names)
- Stories created: {N}
- Stories skipped (duplicates): {N}
- Stories without epic (errors): {N}
- Project label applied: {PROJECT_LABEL} / (none — label was empty)
```
```

---

## Config Schema — Full Reference

Fields in `.claude/backlog-config.json` when `provider=jira`:

| Field | Type | When set | Purpose |
|-------|------|----------|---------|
| `provider` | `"jira"` | `/setup` | Identifies JIRA mode |
| `write_access` | boolean | `/setup` | Enables ticket creation |
| `jira_base_url` | string | `/setup` | e.g., `https://co.atlassian.net` |
| `jira_project_key` | string | `/setup` | e.g., `PROJ` |
| `issue_type` | string | `/setup` | Defaults to `"Story"` |
| `auth_method` | `"api_token"` or `"cli"` | `/setup` | How to authenticate |
| `cli_installed` | boolean | `/setup` | Whether `jira` CLI was installed |
| `project_label` | string | `/setup` (NEW) | Applied as label to every ticket |
| `epic_link_field` | string | `/setup` (NEW) | `"parent"` or `"customfield_10014"` |
| `epic_mapping` | object | Runtime-updated (NEW) | `{area: epicKey}` cache |

---

## Existing Patterns to Follow

**How GitHub Issues branch is structured today (in the active command):**

```markdown
### Sync to GitHub Issues (BACKLOG_WRITE=true)

2. Fetch existing product-driven backlog items to avoid duplicates:
   ```bash
   gh issue list ...
   ```

3. Initialize backlog labels (idempotent):
   ```bash
   gh label create ...
   ```

4. For each proposed feature, create a GitHub Issue (skip duplicates):
   ```bash
   gh issue create ...
   ```

5. Report sync results:
   ```
   Product discovery complete:
   - Created: {N} new feature ideas in GitHub Issues
   - Skipped: {N} duplicates (already exist)
   ```
```

The JIRA section follows the same numbered-step + bash-block pattern.

**How `GIT_AUTO` conditionals work in `implement.md`** (the model for provider conditionals):
Both branches (`GIT_AUTO=true` and `GIT_AUTO=false`) are present as full prose sections. No erasure, no template placeholder that swaps out sections. The same approach applies here: both `provider=github` and `provider=jira` branches are fully present in the generated command — the runtime config selects which branch executes.

---

## JIRA API Reference (what you need)

**Base URL pattern:** `${JIRA_BASE_URL}/rest/api/3/<resource>`

**Authentication:** `Authorization: Basic <base64(email:token)>`
- Use `printf '%s' "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64` (not `echo -n` — more portable)

**Search issues:**
- `GET /rest/api/3/search?jql=<JQL>&fields=<fields>&maxResults=<n>`
- JQL for stories: `project=PROJ AND issuetype=Story AND labels=product-backlog`
- JQL for epics: `project=PROJ AND issuetype=Epic AND summary ~ "area-name"`

**Create issue:**
- `POST /rest/api/3/issue`
- Body: `{"fields": {"project": {"key": "..."}, "issuetype": {"name": "..."}, "summary": "...", ...}}`
- Description must use ADF format (not markdown) on Cloud instances

**ADF codeBlock for description (simplest valid ADF):**
```json
{
  "type": "doc",
  "version": 1,
  "content": [{
    "type": "codeBlock",
    "content": [{"type": "text", "text": "<markdown content here>"}]
  }]
}
```

**Epic linkage fields:**
- Next-Gen: `"parent": {"key": "EPIC-KEY"}`
- Classic: `"customfield_10014": "EPIC-KEY"` (string value, not object)

---

## Conventions Checklist

- No new `{{PLACEHOLDER}}` tokens — JIRA config values are read at runtime from `backlog-config.json`
- All variable names: `UPPER_SNAKE_CASE` (`PROJECT_LABEL`, `EPIC_MAPPING`, `EPIC_LINK_FIELD`, `AREA_NAME`)
- Heading levels: new sections use `###` (matching `### Sync to GitHub Issues` level)
- File naming: `backlog-config.json` unchanged (kebab-case)
- Both `templates/commands/update-product-driven-backlog.md` and `.claude/commands/update-product-driven-backlog.md` updated in the same commit
- After editing, verify: `grep -r '{{[A-Z_]*}}' .claude/commands/update-product-driven-backlog.md` returns nothing

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| ADF description encoding: complex markdown may break JSON when embedded as a string | Escape double quotes in `VPC_BODY_ESCAPED` before embedding; use codeBlock ADF node which treats content as opaque text |
| Epic linkage field variance (Next-Gen vs Classic) | Configurable `epic_link_field`; default `parent`; prompt in `/setup` explains the choice |
| `epic_mapping` stale cache (epic deleted in JIRA) | On story creation API error, attempt story creation without epic linkage and report the failure; do not halt the run |
| `jira` CLI `--parent` flag not universally supported | Design uses REST API `curl` as primary path; CLI is an alternative but the epic linkage step always prefers REST API |
| `base64` encoding portability (macOS vs Linux) | Use `printf '%s' "..." \| base64` instead of `echo -n "..." \| base64` |
| Large VPC body in JSON string (special characters) | Note that the command prose instructs escaping quotes; in practice, the AI agent writing the curl command must handle this — add a note in Step E |
