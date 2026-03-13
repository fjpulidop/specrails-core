# Technical Design: JIRA Integration — Project Labels and Epic Grouping

## Overview

This feature is a pure prose-and-configuration change to two Markdown command files and the `backlog-config.json` schema. No new agents, no new tools, no shell script changes. The JIRA path is additive: it adds conditional branches inside existing sync phases, gated on `provider: jira` in `.claude/backlog-config.json`. Every existing GitHub Issues branch is untouched.

The guiding principle is: read the config, branch on provider, keep both paths explicit and readable.

---

## Architecture

```
/setup Phase 3.2 (JIRA selected)
     |
     v
Prompt: "What project label should we apply to all generated tickets?"
  e.g., PROJECT-specrails
     |
     v
Write to .claude/backlog-config.json:
  {
    "provider": "jira",
    "project_label": "PROJECT-specrails",
    "jira_base_url": "...",
    "jira_project_key": "PROJ",
    "issue_type": "Story",
    "auth_method": "api_token",
    "cli_installed": true,
    "epic_mapping": {}       <-- starts empty, populated by /update-product-driven-backlog
  }
     |
     v
/update-product-driven-backlog — Backlog Sync phase
     |
     v
Read .claude/backlog-config.json
  If provider=github: existing path (unchanged)
  If provider=jira:
     |
     v
  Group features by area
     |
     v
  For each unique area:
    - Search JIRA for epic: project=PROJ AND issuetype=Epic AND summary~"area"
    - If found: use existing epic key
    - If not found: create epic, store key in epic_mapping
     |
     v
  For each feature in area:
    - Create JIRA Story with:
        - summary: feature name
        - description: VPC body (same markdown format)
        - labels: ["product-backlog", PROJECT_LABEL]
        - parent/Epic Link: epic key for this area
     |
     v
  Update epic_mapping in .claude/backlog-config.json
```

---

## Config Schema Extension

### Current schema (`.claude/backlog-config.json` when provider=jira)

```json
{
  "provider": "jira",
  "write_access": true,
  "jira_base_url": "https://your-company.atlassian.net",
  "jira_project_key": "PROJ",
  "issue_type": "Story",
  "auth_method": "api_token",
  "cli_installed": true
}
```

### Extended schema (after this change)

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
  "epic_mapping": {
    "core": "PROJ-12",
    "agents": "PROJ-13",
    "commands": "PROJ-14"
  }
}
```

**New fields:**

| Field | Type | Source | Purpose |
|-------|------|--------|---------|
| `project_label` | string | User input at `/setup` time | Applied as a JIRA label to every created ticket |
| `epic_mapping` | object | Written by `/update-product-driven-backlog` | Maps area name → JIRA epic key; avoids duplicate epic creation across runs |

The `epic_mapping` field persists across runs. On each `/update-product-driven-backlog` run, the command reads this mapping to decide which epics already exist before querying JIRA. This is a local cache; if an epic is deleted in JIRA, the next run will try to link to a non-existent key and fall back to creating a new epic.

---

## File Changes

### 1. `commands/setup.md` — Phase 3.2: Backlog Provider, JIRA branch

**Location:** Inside the `#### If JIRA` section, after the access mode prompt and before the `Store the full configuration` block.

**What to add:** A new "Project Label" prompt step.

**Prose to insert:**

```
After collecting JIRA access mode, ask:

> **Project Label (optional but recommended)**
>
> JIRA teams often tag all tickets from a product area with a project label
> (e.g., `PROJECT-specrails`, `PLATFORM`, `MOBILE`). This label is added to
> every ticket the backlog pipeline creates, making it easy to filter all
> AI-generated backlog items in JIRA.
>
> Enter a project label, or press Enter to skip:

If the user enters a label: store as `PROJECT_LABEL`.
If the user skips: `PROJECT_LABEL=""`.

Include `project_label` and `epic_mapping: {}` in the `.claude/backlog-config.json` output.
```

**Updated `Store the full configuration` block:**

The existing JSON in the setup command must be extended to include the two new fields:

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
  "epic_mapping": {}
}
```

**Configuration Summary table** (Phase 3.5) must gain a row:

```
| Project label (JIRA) | PROJECT-specrails / (none) |
```

This row is shown only when `BACKLOG_PROVIDER=jira`.

---

### 2. `templates/commands/setup.md` — same changes as `commands/setup.md`

The template does not currently exist as a separate file (setup lives only in `commands/setup.md` for now — specrails installs the setup command directly from `commands/setup.md`). When a template is later extracted, it will receive these same changes. For now, only `commands/setup.md` is updated.

**Note to developer:** Verify this assumption by checking `install.sh` — if setup.md is copied from `templates/commands/setup.md` during install, that template must also be updated.

---

### 3. `.claude/commands/update-product-driven-backlog.md` — Backlog Sync phase

This is the active command in the specrails repo. The "Assembly — Backlog Sync" section currently has a single path: GitHub Issues. It must be extended with a JIRA branch.

**Location:** In the `### Sync to GitHub Issues (BACKLOG_WRITE=true)` section, add a sibling section below it.

**Current structure:**

```
## Assembly — Backlog Sync

After the Explore agent completes:

1. Display results to the user.

### Sync to GitHub Issues (BACKLOG_WRITE=true)

2. Fetch existing...
3. Initialize labels...
4. For each feature, create a GitHub Issue...
5. Report sync results.
```

**New structure:**

```
## Assembly — Backlog Sync

After the Explore agent completes:

1. Display results to the user.

2. Read `.claude/backlog-config.json` to determine provider and write access.

### If provider=github and BACKLOG_WRITE=true — Sync to GitHub Issues

[existing GitHub Issues steps, unchanged]

### If provider=jira and BACKLOG_WRITE=true — Sync to JIRA

[new JIRA steps — see below]

### If BACKLOG_WRITE=false — Display only

[existing display-only section, unchanged]
```

---

### JIRA Sync Steps (the new branch)

**Step 2a: Read config**

```bash
cat .claude/backlog-config.json
```

Extract: `JIRA_BASE_URL`, `JIRA_PROJECT_KEY`, `AUTH_METHOD`, `PROJECT_LABEL`, `EPIC_MAPPING`, `CLI_INSTALLED`.

**Step 2b: Determine authentication headers**

If `AUTH_METHOD=api_token`:
- Headers come from env: `JIRA_USER_EMAIL` and `JIRA_API_TOKEN`
- Base64-encode for Basic Auth: `$(echo -n "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)`

If `CLI_INSTALLED=true`:
- Use `jira` CLI commands instead of `curl`

The command must handle both paths. Use `AUTH_METHOD` to select.

**Step 2c: Fetch existing JIRA stories to avoid duplicates**

REST API path:
```bash
curl -s \
  -H "Authorization: Basic $(echo -n "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)" \
  -H "Content-Type: application/json" \
  "${JIRA_BASE_URL}/rest/api/3/search?jql=project=${JIRA_PROJECT_KEY}+AND+labels=product-backlog+AND+issuetype=Story&fields=summary,labels,parent&maxResults=200"
```

Store summary titles to check for duplicates before creating.

**Step 2d: Group features by area**

From the Explore agent output, each feature has an `area` field. Group the features list into a map of `area -> [feature, ...]`.

The areas correspond to the `area:*` labels used in GitHub Issues mode. Extract the area name by stripping the `area:` prefix (e.g., `area:core` → `core`).

**Step 2e: Ensure epics exist for each area**

For each unique area:

1. Check `EPIC_MAPPING` (from config) for an existing key. If found, skip to step 3.

2. Search JIRA for an existing epic matching this area:
   ```bash
   curl -s \
     -H "Authorization: Basic $(echo -n "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)" \
     -H "Content-Type: application/json" \
     "${JIRA_BASE_URL}/rest/api/3/search?jql=project=${JIRA_PROJECT_KEY}+AND+issuetype=Epic+AND+summary+%7E+%22${AREA_NAME}%22&fields=summary,key"
   ```
   If an epic is found (exact or close match): store its key in `EPIC_MAPPING[area]`.

3. If no epic found, create one:
   ```bash
   curl -s -X POST \
     -H "Authorization: Basic $(echo -n "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)" \
     -H "Content-Type: application/json" \
     "${JIRA_BASE_URL}/rest/api/3/issue" \
     --data "{
       \"fields\": {
         \"project\": {\"key\": \"${JIRA_PROJECT_KEY}\"},
         \"issuetype\": {\"name\": \"Epic\"},
         \"summary\": \"${AREA_DISPLAY_NAME}\",
         \"labels\": [\"product-backlog\", \"${PROJECT_LABEL}\"]
       }
     }"
   ```
   Store the returned `key` in `EPIC_MAPPING[area]`.

4. After processing all areas, write the updated `EPIC_MAPPING` back to `.claude/backlog-config.json`.

**Step 2f: Create Story tickets**

For each feature (skip if duplicate title exists):

```bash
curl -s -X POST \
  -H "Authorization: Basic $(echo -n "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64)" \
  -H "Content-Type: application/json" \
  "${JIRA_BASE_URL}/rest/api/3/issue" \
  --data "{
    \"fields\": {
      \"project\": {\"key\": \"${JIRA_PROJECT_KEY}\"},
      \"issuetype\": {\"name\": \"Story\"},
      \"summary\": \"${FEATURE_NAME}\",
      \"description\": {
        \"type\": \"doc\",
        \"version\": 1,
        \"content\": [{
          \"type\": \"paragraph\",
          \"content\": [{\"type\": \"text\", \"text\": \"${DESCRIPTION_TEXT}\"}]
        }]
      },
      \"labels\": [\"product-backlog\", \"${PROJECT_LABEL}\"],
      \"parent\": {\"key\": \"${EPIC_KEY}\"}
    }
  }"
```

**JIRA API note on description format:** JIRA Cloud REST API v3 requires description in Atlassian Document Format (ADF), not plain markdown. The simplest approach: embed the full VPC markdown body as a single `codeBlock` node, or use a single `paragraph` text node for the summary and append a `## Full Description` section with a code block. This avoids implementing a full markdown-to-ADF converter.

**JIRA API note on epic linkage:** Atlassian Cloud uses `parent` field (since JIRA Next-Gen / Team-managed projects) or the `customfield_10014` Epic Link field (classic projects). The command should attempt `parent` first. If the project uses classic epic linking, fall back to `customfield_10014`. Include a note in the config about this: `"epic_link_field": "parent"` (default) or `"epic_link_field": "customfield_10014"`.

**Step 2g: Report results**

```
JIRA sync complete:
- Epics created: {N} ({names})
- Epics reused: {N} ({names})
- Stories created: {N}
- Stories skipped (duplicates): {N}
- Project label applied: {PROJECT_LABEL or "(none)"}
```

---

### JIRA CLI alternative path

When `CLI_INSTALLED=true` and `AUTH_METHOD=cli`, use `jira` commands instead of `curl`:

**Fetch existing stories:**
```bash
jira issue list --project "${JIRA_PROJECT_KEY}" --type Story --label product-backlog --plain --columns key,summary
```

**Search for epic:**
```bash
jira issue list --project "${JIRA_PROJECT_KEY}" --type Epic --plain --columns key,summary | grep -i "${AREA_NAME}"
```

**Create epic:**
```bash
jira issue create --project "${JIRA_PROJECT_KEY}" \
  --type Epic \
  --summary "${AREA_DISPLAY_NAME}" \
  --label "product-backlog,${PROJECT_LABEL}" \
  --no-input
```

**Create story:**
```bash
jira issue create --project "${JIRA_PROJECT_KEY}" \
  --type Story \
  --summary "${FEATURE_NAME}" \
  --body "${DESCRIPTION_BODY}" \
  --label "product-backlog,${PROJECT_LABEL}" \
  --parent "${EPIC_KEY}" \
  --no-input
```

Note: `--parent` flag availability depends on the `jira` CLI version. If not supported, use the REST API fallback for epic linkage even when CLI is installed.

---

### 4. `templates/commands/update-product-driven-backlog.md` — same changes as above

The template uses `{{PLACEHOLDER}}` tokens for project-specific values. The JIRA sync section uses the same `{{BACKLOG_FETCH_ALL_CMD}}`, `{{BACKLOG_CREATE_CMD}}` placeholder slots — but these were designed for a single-provider scenario. With two providers, the template approach needs adjustment.

**Approach:** Replace the single `{{BACKLOG_CREATE_CMD}}` block with a conditional structure that branches on `BACKLOG_PROVIDER`. Both branches are present in the template; the setup command fills in provider-specific details via the existing placeholder slots but both conditional blocks remain in the generated output.

This is consistent with how Phase 4c in `implement.md` handles `GIT_AUTO` — both branches are present as prose, no template erasure.

**New placeholder introduced:** None. The existing `{{BACKLOG_PROVIDER_NAME}}` is already used for reporting. The JIRA-specific curl commands reference env vars (`$JIRA_USER_EMAIL`, `$JIRA_API_TOKEN`) and config values read at runtime — no new compile-time placeholders needed.

---

## Key Design Decisions

**Why store `epic_mapping` in `backlog-config.json` rather than querying JIRA every time?**
JIRA search is a network call with latency. Caching the mapping locally reduces API calls per run from O(areas) to 0 for known areas. The tradeoff is stale cache on manual epic deletion — acceptable because epic deletion is rare, and the fallback (create a new epic) is harmless.

**Why use the `parent` field for epic linkage by default?**
Atlassian's REST API v3 on Cloud instances uses `parent` for Next-Gen projects, which represents the majority of new JIRA setups. Classic projects use `customfield_10014`. Defaulting to `parent` with a fallback config field (`epic_link_field`) covers both without requiring user research upfront.

**Why ADF for description rather than markdown?**
JIRA Cloud REST API v3 requires ADF. Sending raw markdown results in a string blob that displays unformatted. The simplest ADF encoding that preserves readability is a single `codeBlock` node wrapping the markdown — users can read it as-is and JIRA treats it as structured content.

**Why not a dedicated JIRA agent?**
The JIRA sync logic is a small set of deterministic API calls, not a reasoning task. Putting it in the orchestrating command (as prose instructions) is simpler, more transparent, and consistent with how GitHub Issues sync already works in this repo.

**Why keep `PROJECT_LABEL` optional?**
Some teams do not use project labels. Making it optional avoids forcing an artificial label onto their JIRA instance. When empty, the field is simply omitted from ticket labels.

---

## Integration Points

| Component | Interaction |
|-----------|-------------|
| `/setup` Phase 3.2 | New project label prompt; extended `backlog-config.json` write |
| `/setup` Phase 3.5 summary | New table row for project label (JIRA only) |
| `backlog-config.json` schema | Two new fields: `project_label`, `epic_mapping` |
| `/update-product-driven-backlog` Assembly | New `provider=jira` branch; epic ensure logic; story creation with parent link |
| `.claude/backlog-config.json` (runtime) | Read on every run; `epic_mapping` updated in place after epic creation |
| JIRA REST API v3 | Used for all JIRA operations when `auth_method=api_token` |
| `jira` CLI | Alternative path when `cli_installed=true` and `auth_method=cli` |

---

## Risks

1. **ADF encoding complexity:** Generating valid ADF for complex VPC markdown bodies is non-trivial. Mitigation: use the simplest valid ADF structure (codeBlock wrapping the markdown text). Ticket bodies will not render with JIRA-native formatting, but will be readable and searchable. A richer ADF conversion can be added later.

2. **Epic link field variance:** Classic JIRA projects use `customfield_10014`; Next-Gen uses `parent`. If the wrong field is used, stories are created without epic linkage (silently). Mitigation: document both options in config, default to `parent`, include a note in the setup flow prompting users to check their project type.

3. **`jira` CLI `--parent` flag availability:** The `go-jira` CLI's `--parent` flag for epic linking may not exist in all versions. Mitigation: when CLI is used, fall back to REST API for epic assignment if `--parent` is not supported.

4. **`epic_mapping` cache invalidation:** If a mapped epic key is deleted in JIRA, subsequent runs will attempt to link stories to a dead key, causing API errors. Mitigation: on API error during story creation, attempt to re-create the epic and retry. If the retry fails, skip epic linkage for that story and report the failure.

5. **Base64 encoding portability:** `echo -n | base64` behavior varies across macOS and Linux. Mitigation: use `printf '%s' "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" | base64` which is more portable.
