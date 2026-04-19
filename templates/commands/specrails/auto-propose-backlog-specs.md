---
name: "Update Product-Driven Backlog"
description: "Generate new feature ideas through product discovery, create GitHub Issues"
category: Workflow
tags: [workflow, explore, priorities, backlog, product-discovery]
model: opus
---

Analyze the project from a **product perspective** to generate new feature ideas. Syncs results to GitHub Issues labeled `product-driven-backlog`. Use `{{COMMAND_PREFIX}}get-backlog-specs` to view current ideas.

**Input:** $ARGUMENTS (optional: comma-separated areas to focus on. If empty, analyze all areas.)

**IMPORTANT: This command only creates GitHub Issues.** You may read files and search code to understand current capabilities, but you must NEVER write application code.

---

## Areas

{{AREA_TABLE}}

---

## Execution

Launch a **single** explorer subagent (`subagent_type: Explore`, `run_in_background: true`) for product discovery.

The Explore agent receives this prompt:

> You are a product strategist analyzing the {{PROJECT_NAME}} project to generate new feature ideas using the **Value Proposition Canvas** framework.
>
> **Your goal:** For each area, propose 2-4 new features that would significantly improve the user experience. Every feature MUST be evaluated against the project's personas.
>
> **Areas to analyze:** {all areas or filtered by user input}
>
> ### Step 0: Read Personas
>
> **Before anything else**, read all persona files:
> {{PERSONA_FILE_READ_LIST}}
>
> These contain full Value Proposition Canvas profiles (jobs, pains, gains).
>
> ### Research steps
>
> 1. **Understand current capabilities** — Read codebase structure
> 2. **Check existing backlog** — Avoid duplicating existing issues
> 3. **Think through each persona's day** — For each area:
>    - What does each persona need here?
>    - What would a competitive tool offer?
>    - What data is available but not surfaced?
>
> 4. **For each idea, produce a VPC evaluation:**
>    - **Feature name** (short, descriptive)
>    - **User story** ("As a [user type], I want to [action] so that [benefit]")
>    - **Feature description** (2-3 sentences)
>    - **VPC Fit** per persona: Jobs, Pains relieved, Gains created, Score (0-5)
>    - **Total Persona Score**: sum of all persona scores / max possible
>    - **Effort** (High/Medium/Low)
>    - **Inspiration** (competitor or product pattern)
>    - **Prerequisites**
>    - **Area**

---

## Assembly — Backlog Sync

After the Explore agent completes:

1. **Display** results to the user.

2. Read `.specrails/backlog-config.json` and extract:
   - `BACKLOG_PROVIDER` (`local`, `github`, `jira`, or `none`)
   - `BACKLOG_WRITE` (from `write_access`)

### If `BACKLOG_WRITE=false` — Display only (no sync)

3. **Display all proposed features** in a structured format so the user can manually create tickets:

   ```
   ## Product Discovery Results (not synced)

   Backlog access is set to **read-only**. The following features were discovered
   but NOT created in {{BACKLOG_PROVIDER_NAME}}. Create them manually if desired.

   ### Feature 1: {name}
   - **Area:** {area}
   - **Persona Fit:** {{PERSONA_FIT_FORMAT}}
   - **Effort:** {level}
   - **User Story:** As a {user}, I want to {action} so that {benefit}
   - **Description:** {2-3 sentences}

   (repeat for each feature)

   ### Summary
   | # | Feature | {{PERSONA_SCORE_HEADERS}} | Total | Effort |
   |---|---------|{{PERSONA_SCORE_SEPARATORS}}|-------|--------|
   | 1 | ... | ... | ... | ... |
   ```

4. **Do NOT** create, modify, or comment on any issues/tickets.

### If provider=local — Sync to Local Tickets

Local tickets are always read-write. Sync directly to `.specrails/local-tickets.json`.

3. **Fetch existing local tickets** to avoid duplicates:
   ```
   {{BACKLOG_FETCH_ALL_CMD}}
   ```
   Collect all ticket titles into a duplicate-check set.

4. **Initialize labels** (idempotent):
   ```
   {{BACKLOG_INIT_LABELS_CMD}}
   ```

5. **For each proposed feature, create a local ticket** (skip if title matches an existing ticket):
   ```
   {{BACKLOG_CREATE_CMD}}
   ```
   Set the following fields on each new ticket:
   - `title`: Feature name
   - `description`: Full VPC body markdown (same format as the GitHub/JIRA issue body above)
   - `status`: `"todo"`
   - `priority`: Map effort to priority — Low effort → `"high"` priority, Medium → `"medium"`, High → `"low"`
   - `labels`: `["product-driven-backlog", "area:{area}"]`
   - `metadata.vpc_scores`: Object with per-persona scores from the VPC evaluation
   - `metadata.effort_level`: `"High"`, `"Medium"`, or `"Low"`
   - `metadata.user_story`: The user story text
   - `metadata.area`: The area name (without `area:` prefix)
   - `prerequisites`: Array of ticket IDs for any features this depends on (empty if none)
   - `source`: `"get-backlog-specs"`
   - `created_by`: `"sr-product-manager"`

6. **Report** sync results:
   ```
   Product discovery complete:
   - Created: {N} new feature ideas as local tickets
   - Skipped: {N} duplicates (already exist)
   ```

### If provider=github and BACKLOG_WRITE=true — Sync to GitHub Issues

3. **Fetch existing product-driven backlog items** to avoid duplicates:
   ```bash
   {{BACKLOG_FETCH_ALL_CMD}}
   ```

4. **Initialize backlog labels/tags** (idempotent):
   ```bash
   {{BACKLOG_INIT_LABELS_CMD}}
   ```

5. **For each proposed feature, create a backlog item** (skip duplicates):
   ```bash
   {{BACKLOG_CREATE_CMD}}
   > **This is a product feature idea.** Generated through VPC-based product discovery.

   ## Overview

   | Field | Value |
   |-------|-------|
   | **Area** | {Area} |
   | **Persona Fit** | {{PERSONA_FIT_FORMAT}} |
   | **Effort** | {High/Medium/Low} — {justification} |
   | **Inspiration** | {source or "Original idea"} |
   | **Prerequisites** | {list or "None"} |

   ## User Story

   As a **{user type}**, I want to **{action}** so that **{benefit}**.

   ## Feature Description

   {2-3 sentence description}

   ## Value Proposition Canvas

   {{PERSONA_VPC_SECTIONS}}

   ## Implementation Notes

   {Brief notes on existing infrastructure and what needs to be built}

   ---
   _Auto-generated by `{{COMMAND_PREFIX}}auto-propose-backlog-specs` on {DATE}_
   EOF
   )"
   ```

6. **Report** sync results:
   ```
   Product discovery complete:
   - Created: {N} new feature ideas in GitHub Issues
   - Skipped: {N} duplicates (already exist)
   ```

### If provider=jira and BACKLOG_WRITE=true — Sync to JIRA

Read from `.specrails/backlog-config.json`:
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
  "${JIRA_BASE_URL}/rest/api/3/search?jql=project%3D${JIRA_PROJECT_KEY}+AND+labels%3Dget-backlog-specs+AND+issuetype%3DStory&fields=summary&maxResults=200"
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
         "labels": ["get-backlog-specs"]
       }
     }'
   ```
   If `PROJECT_LABEL` is non-empty, add it to the `labels` array.
   Set `EPIC_MAPPING[area] = <returned key>`.

After all areas are processed: write the updated `EPIC_MAPPING` back to `.specrails/backlog-config.json`.

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
      "labels": ["get-backlog-specs"],
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
