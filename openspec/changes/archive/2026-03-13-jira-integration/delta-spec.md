# Delta Spec: JIRA Integration — Project Labels and Epic Grouping

This document describes the exact changes to existing files and conventions introduced by this feature. Only deltas are recorded — unchanged behavior is not restated.

---

## 1. `.claude/backlog-config.json` — schema extension

**This is a runtime-generated file, not a checked-in file.** No file change required — the schema change is delivered by updating the commands that write and read this file.

**New fields added to the JIRA config object:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `project_label` | string | `""` | JIRA label applied to all generated tickets (e.g., `PROJECT-specrails`) |
| `epic_mapping` | object | `{}` | Maps area name → JIRA epic key. Persisted across runs to avoid duplicate epic creation |
| `epic_link_field` | string | `"parent"` | JIRA field used for epic linkage. Use `"parent"` for Next-Gen projects, `"customfield_10014"` for classic projects |

**Full JIRA config example after this change:**

```json
{
  "provider": "jira",
  "write_access": true,
  "jira_base_url": "https://your-company.atlassian.net",
  "jira_project_key": "PROJ",
  "issue_type": "Story",
  "auth_method": "api_token",
  "cli_installed": true,
  "project_label": "PROJECT-specrails",
  "epic_link_field": "parent",
  "epic_mapping": {
    "core": "PROJ-12",
    "agents": "PROJ-13",
    "commands": "PROJ-14"
  }
}
```

**GitHub config object is unchanged:**

```json
{
  "provider": "github",
  "write_access": true
}
```

---

## 2. `commands/setup.md` — Phase 3.2 JIRA branch

**Section:** `#### If JIRA`

**Location of change:** Insert after the access mode prompt block (the `## JIRA — Access Mode` block) and before the `Store the full configuration in .claude/backlog-config.json` block.

**Delta — new prose to insert:**

```
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
```

**Delta — update the JSON example** in the `Store the full configuration` block to add:

```json
"project_label": "<PROJECT_LABEL or empty string>",
"epic_link_field": "parent",
"epic_mapping": {}
```

Insert these three lines after `"cli_installed": true`.

**Delta — also ask about epic link field:**

```
> **Epic Link Field (optional — advanced)**
>
> JIRA Next-Gen (team-managed) projects link stories to epics using the `parent`
> field. JIRA Classic (company-managed) projects use `Epic Link` (customfield_10014).
>
> Which does your project use?
> 1. `parent` — Next-Gen / team-managed (default)
> 2. `customfield_10014` — Classic / company-managed

Set `EPIC_LINK_FIELD` to `parent` or `customfield_10014`.
Default: `parent`.
```

---

## 3. `commands/setup.md` — Phase 3.5 Configuration Summary

**Section:** `### 3.5 Confirm configuration`

**Delta:** Add a row to the Configuration Summary table, shown only when `BACKLOG_PROVIDER=jira`:

```
| Project label (JIRA)     | PROJECT-specrails / (none) |
| Epic link field (JIRA)   | parent / customfield_10014 |
```

Insert these rows after the `Backlog access` row.

---

## 4. `commands/setup.md` — Phase 4.3 Commands generation, JIRA path

**Section:** `#### JIRA (BACKLOG_PROVIDER=jira)` in Phase 4.3

**Delta:** Add to the existing JIRA config example that is written to `.claude/backlog-config.json`:

```json
"project_label": "{{PROJECT_LABEL}}",
"epic_link_field": "{{EPIC_LINK_FIELD}}",
"epic_mapping": {}
```

These values are substituted from `PROJECT_LABEL` and `EPIC_LINK_FIELD` collected in Phase 3.2.

---

## 5. `templates/commands/update-product-driven-backlog.md` — Assembly section restructure

**Section:** `## Assembly — Backlog Sync`

**Current structure:**

```
1. Display results.

### Sync to GitHub Issues (BACKLOG_WRITE=true)
2-5. [GitHub-specific steps]

### If BACKLOG_WRITE=false — Display only
2-3. [Display-only steps]
```

**New structure:**

```
1. Display results.

2. Read `.claude/backlog-config.json` and extract BACKLOG_PROVIDER and BACKLOG_WRITE.

### If BACKLOG_WRITE=false — Display only
[existing display-only section, unchanged]

### If provider=github and BACKLOG_WRITE=true — Sync to GitHub Issues
[existing GitHub Issues steps — content unchanged, header updated for clarity]

### If provider=jira and BACKLOG_WRITE=true — Sync to JIRA
[new JIRA steps — see below]
```

---

## 6. `templates/commands/update-product-driven-backlog.md` — new JIRA sync section

**New section to add** after the GitHub Issues sync section:

```markdown
### If provider=jira and BACKLOG_WRITE=true — Sync to JIRA

Read from `.claude/backlog-config.json`:
- `JIRA_BASE_URL`
- `JIRA_PROJECT_KEY`
- `AUTH_METHOD`
- `PROJECT_LABEL` (may be empty)
- `EPIC_MAPPING` (object, may be empty)
- `EPIC_LINK_FIELD` (default: "parent")
- `CLI_INSTALLED`

#### Step A: Authenticate

If `AUTH_METHOD=api_token`:
- Require env vars `JIRA_USER_EMAIL` and `JIRA_API_TOKEN`
- If missing, print error and stop:
  ```
  Error: JIRA_USER_EMAIL and JIRA_API_TOKEN must be set in your environment.
  See: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
  ```

#### Step B: Fetch existing JIRA stories (duplicate check)

```bash
curl -s \
  -H "Authorization: Basic $(printf '%s' "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)" \
  -H "Content-Type: application/json" \
  "${JIRA_BASE_URL}/rest/api/3/search?jql=project%3D${JIRA_PROJECT_KEY}+AND+labels%3Dproduct-backlog+AND+issuetype%3DStory&fields=summary&maxResults=200"
```

Store the list of existing story summaries for duplicate detection.

#### Step C: Group features by area

From the Explore agent output, group features by their `area` value.
Area names match the `area:*` convention (e.g., area `core`, `agents`, `commands`).

#### Step D: Ensure epics exist per area

For each unique area (in the grouped features):

1. If `EPIC_MAPPING[area]` exists: use that key. Skip to Step E.

2. Search JIRA for an existing epic with this area's name:
   ```bash
   curl -s \
     -H "Authorization: Basic $(printf '%s' "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)" \
     -H "Content-Type: application/json" \
     "${JIRA_BASE_URL}/rest/api/3/search?jql=project%3D${JIRA_PROJECT_KEY}+AND+issuetype%3DEpic+AND+summary+%7E+%22${AREA_NAME}%22&fields=summary,key"
   ```
   If a matching epic is found: set `EPIC_MAPPING[area] = <key>`. Skip to Step E.

3. Create a new epic:
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
         "labels": ["product-backlog", "'"${PROJECT_LABEL}"'"]
       }
     }'
   ```
   Set `EPIC_MAPPING[area] = <returned key>`.

After processing all areas: write updated `EPIC_MAPPING` back into `.claude/backlog-config.json`.

#### Step E: Create Story tickets

For each feature (skip if its title already exists in the duplicate list):

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
      "labels": ["product-backlog", "'"${PROJECT_LABEL}"'"],
      "'"${EPIC_LINK_FIELD}"'": {"key": "'"${EPIC_KEY}"'"}
    }
  }'
```

If `PROJECT_LABEL` is empty, omit it from the `labels` array.

On API error during story creation:
- If error is "parent not found" or "Epic Link not found": log a warning, create the story without epic linkage, and continue.
- Any other error: log the error with the story name, continue to next story.

#### Step F: Report

```
JIRA sync complete:
- Epics created: {N} ({list of area names})
- Epics reused: {N} ({list of area names})
- Stories created: {N}
- Stories skipped (duplicates): {N}
- Project label applied: {PROJECT_LABEL or "(none — skipped)"}
```
```

---

## 7. `.claude/commands/update-product-driven-backlog.md` — identical changes

The active command in this repo receives the same changes as the template. It has no `{{PLACEHOLDER}}` tokens remaining, so the new JIRA prose is inserted verbatim (with actual values substituted for anything project-specific).

**Specific difference from the template:** The active command already has hardcoded persona names (Alex, Sara, Kai) and area paths. The JIRA sync section does not reference persona names, so no substitution is needed.

---

## Conventions Unchanged

- No new `{{PLACEHOLDER}}` tokens introduced in the JIRA sync prose. Config values are read at runtime from `.claude/backlog-config.json`; this is consistent with how JIRA config was already handled before this change.
- Heading levels in the new JIRA section match the `### Sync to GitHub Issues` level already present.
- `UPPER_SNAKE_CASE` for all variable names (`PROJECT_LABEL`, `EPIC_MAPPING`, `EPIC_LINK_FIELD`).
- File naming: `backlog-config.json` retains kebab-case.
- Both `templates/` and `.claude/` versions must be updated in the same commit.
