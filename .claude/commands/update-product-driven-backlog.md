---
name: "Update Product-Driven Backlog"
description: "Generate new feature ideas through product discovery, create GitHub Issues"
category: Workflow
tags: [workflow, explore, priorities, backlog, product-discovery]
model: opus
---

Analyze the project from a **product perspective** to generate new feature ideas. Syncs results to GitHub Issues labeled `product-driven-backlog`. Use `/product-backlog` to view current ideas.

**Input:** $ARGUMENTS (optional: comma-separated areas to focus on. If empty, analyze all areas.)

**IMPORTANT: This command only creates GitHub Issues.** You may read files and search code to understand current capabilities, but you must NEVER write application code.

---

## Areas

| Area | Description | Key Paths |
|------|-------------|-----------|
| Core | Installer, template engine, distribution | `install.sh`, `templates/` |
| Agents | Agent prompt design, multi-agent orchestration | `.claude/agents/`, `templates/agents/` |
| Commands | Workflow commands, pipeline orchestration | `.claude/commands/`, `templates/commands/` |
| Product | VPC personas, product discovery, backlog | `.claude/agents/personas/`, `templates/personas/` |
| DX | Developer experience, setup, onboarding | `commands/setup.md`, `prompts/` |

---

## Execution

Launch a **single** explorer subagent (`subagent_type: Explore`, `run_in_background: true`) for product discovery.

The Explore agent receives this prompt:

> You are a product strategist analyzing the specrails project to generate new feature ideas using the **Value Proposition Canvas** framework.
>
> **Your goal:** For each area, propose 2-4 new features that would significantly improve the user experience. Every feature MUST be evaluated against the project's personas.
>
> **Areas to analyze:** {all areas or filtered by user input}
>
> ### Step 0: Read Personas
>
> **Before anything else**, read all persona files:
> - Read `.claude/agents/personas/the-lead-dev.md`
> - Read `.claude/agents/personas/the-product-founder.md`
> - Read `.claude/agents/personas/the-maintainer.md`
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

2. Read `.claude/backlog-config.json` and extract:
   - `BACKLOG_PROVIDER` (`github`, `jira`, or `none`)
   - `BACKLOG_WRITE` (from `write_access`)

### If `BACKLOG_WRITE=false` — Display only (no sync)

3. **Display all proposed features** in a structured format so the user can manually create tickets:

   ```
   ## Product Discovery Results (not synced)

   Backlog access is set to **read-only**. The following features were discovered
   but NOT created in the backlog provider. Create them manually if desired.

   ### Feature 1: {name}
   - **Area:** {area}
   - **Persona Fit:** Alex: X/5, Sara: X/5, Kai: X/5
   - **Effort:** {level}
   - **User Story:** As a {user}, I want to {action} so that {benefit}
   - **Description:** {2-3 sentences}

   (repeat for each feature)

   ### Summary
   | # | Feature | Alex | Sara | Kai | Total | Effort |
   |---|---------|------|------|-----|-------|--------|
   | 1 | ... | ... | ... | ... | ... | ... |
   ```

4. **Do NOT** create, modify, or comment on any issues/tickets.

### If provider=github and BACKLOG_WRITE=true — Sync to GitHub Issues

3. **Fetch existing product-driven backlog items** to avoid duplicates:
   ```bash
   gh issue list --label "product-driven-backlog" --state open --limit 100 --json number,title,labels,body
   ```

4. **Initialize backlog labels** (idempotent):
   ```bash
   gh label create "product-driven-backlog" --color "7B68EE" --description "Product feature ideas from VPC discovery" --force 2>/dev/null || true
   ```

5. **For each proposed feature, create a GitHub Issue** (skip duplicates):
   ```bash
   gh issue create --title "{Feature Name}" --label "product-driven-backlog,area:{area}" --body "$(cat <<'EOF'
   > **This is a product feature idea.** Generated through VPC-based product discovery.

   ## Overview

   | Field | Value |
   |-------|-------|
   | **Area** | {Area} |
   | **Persona Fit** | Alex: X/5, Sara: X/5, Kai: X/5 |
   | **Effort** | {High/Medium/Low} — {justification} |
   | **Inspiration** | {source or "Original idea"} |
   | **Prerequisites** | {list or "None"} |

   ## User Story

   As a **{user type}**, I want to **{action}** so that **{benefit}**.

   ## Feature Description

   {2-3 sentence description}

   ## Value Proposition Canvas

   ### "Alex" — The Lead Dev (X/5)
   - **Jobs addressed**: {list}
   - **Pains relieved**: {list with severity}
   - **Gains created**: {list with impact}

   ### "Sara" — The Product Founder (X/5)
   - **Jobs addressed**: {list}
   - **Pains relieved**: {list with severity}
   - **Gains created**: {list with impact}

   ### "Kai" — The Maintainer (X/5)
   - **Jobs addressed**: {list}
   - **Pains relieved**: {list with severity}
   - **Gains created**: {list with impact}

   ## Implementation Notes

   {Brief notes on existing infrastructure and what needs to be built}

   ---
   _Auto-generated by `/update-product-driven-backlog` on {DATE}_
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
