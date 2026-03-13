# Tasks: JIRA Integration — Project Labels and Epic Grouping

Tasks are ordered sequentially. Each task depends on the one(s) before it unless noted otherwise.

---

## T1 — Add project label prompt to `/setup` Phase 3.2 (JIRA branch) [commands]

**Description:**
In `commands/setup.md`, inside the `#### If JIRA` section, insert a "Project Label" prompt after the access mode selection block and before the `Store the full configuration` block. The prompt asks the user to optionally enter a project label string (e.g., `PROJECT-specrails`). Also insert an "Epic Link Field" prompt so users can specify `parent` (Next-Gen default) or `customfield_10014` (Classic). Set variables `PROJECT_LABEL` and `EPIC_LINK_FIELD`.

**Files involved:**
- `commands/setup.md`

**Acceptance criteria:**
- The `#### If JIRA` section contains a "Project Label" prompt block between the access mode block and the `Store the full configuration` block
- `PROJECT_LABEL` is set to user input or empty string if skipped
- The "Epic Link Field" prompt appears immediately after the Project Label prompt
- `EPIC_LINK_FIELD` defaults to `parent` if the user skips
- Both prompts are skippable (no required input)

**Dependencies:** none

---

## T2 — Extend the `backlog-config.json` write in `/setup` Phase 3.2 [commands]

**Description:**
Update the JSON example in the `Store the full configuration in .claude/backlog-config.json` block (inside `#### If JIRA`) to include the three new fields: `project_label`, `epic_link_field`, and `epic_mapping: {}`. The values of `project_label` and `epic_link_field` come from `PROJECT_LABEL` and `EPIC_LINK_FIELD` set in T1.

**Files involved:**
- `commands/setup.md`

**Acceptance criteria:**
- The JSON example block includes `"project_label": "<PROJECT_LABEL or empty string>"`
- The JSON example includes `"epic_link_field": "parent"` (or the value from `EPIC_LINK_FIELD`)
- The JSON example includes `"epic_mapping": {}`
- The GitHub Issues config block (`#### If GitHub Issues`) is unchanged
- The new fields appear after `"cli_installed"` in field order

**Dependencies:** T1

---

## T3 — Add project label and epic link field rows to Configuration Summary [commands]

**Description:**
In `commands/setup.md`, update the Configuration Summary table in Phase 3.5 to include two new rows that are only displayed when `BACKLOG_PROVIDER=jira`: `Project label (JIRA)` and `Epic link field (JIRA)`. The values shown are the `PROJECT_LABEL` and `EPIC_LINK_FIELD` collected in Phase 3.2.

**Files involved:**
- `commands/setup.md`

**Acceptance criteria:**
- The Configuration Summary table has a `Project label (JIRA)` row below `Backlog access`
- The `Epic link field (JIRA)` row appears immediately after it
- Both rows are conditionally shown only when `BACKLOG_PROVIDER=jira` (indicated by a comment or conditional note in the prose)
- Row values display the actual collected values or "(none)" when `PROJECT_LABEL` is empty

**Dependencies:** T1

---

## T4 — Restructure the Assembly section in the template command [templates]

**Description:**
In `templates/commands/update-product-driven-backlog.md`, restructure the `## Assembly — Backlog Sync` section to support multiple providers. Add a new step 2 that reads `.claude/backlog-config.json` and extracts `BACKLOG_PROVIDER` and `BACKLOG_WRITE`. Rename the existing `### Sync to GitHub Issues (BACKLOG_WRITE=true)` section header to `### If provider=github and BACKLOG_WRITE=true — Sync to GitHub Issues`. Move the display-only section so it appears before the provider-specific sections. The GitHub Issues content is unchanged.

**Files involved:**
- `templates/commands/update-product-driven-backlog.md`

**Acceptance criteria:**
- Step 2 in the Assembly section reads `backlog-config.json` and sets `BACKLOG_PROVIDER`
- The GitHub Issues section header is updated to include the `provider=github` condition
- The display-only section header reads `### If BACKLOG_WRITE=false — Display only` (already correct or update if needed)
- All existing GitHub Issues step content is preserved verbatim
- The `{{BACKLOG_FETCH_ALL_CMD}}`, `{{BACKLOG_INIT_LABELS_CMD}}`, `{{BACKLOG_CREATE_CMD}}` placeholders remain inside the GitHub section

**Dependencies:** none

---

## T5 — Add JIRA sync section to the template command [templates]

**Description:**
In `templates/commands/update-product-driven-backlog.md`, add the full `### If provider=jira and BACKLOG_WRITE=true — Sync to JIRA` section after the GitHub Issues section. This section contains Steps A through F as defined in `delta-spec.md`: authentication check, duplicate fetch, area grouping, epic ensure logic (check cache → search JIRA → create), story creation with project label and epic link, and the results report.

**Files involved:**
- `templates/commands/update-product-driven-backlog.md`

**Acceptance criteria:**
- Section header is exactly `### If provider=jira and BACKLOG_WRITE=true — Sync to JIRA`
- Step A: authentication check with env var validation and error message
- Step B: `curl` command to fetch existing stories for duplicate detection
- Step C: area grouping instruction (group features by `area` field)
- Step D: epic ensure logic covering all three sub-cases (cache hit, JIRA search hit, create new)
- Step D includes: write updated `EPIC_MAPPING` back to `.claude/backlog-config.json` after processing all areas
- Step E: story creation `curl` command with `description` in ADF codeBlock format, `labels` array including `PROJECT_LABEL`, and epic linkage via `EPIC_LINK_FIELD`
- Step E includes: error handling for API failures (dead epic key, unknown errors)
- Step E includes: `PROJECT_LABEL` omission logic when empty
- Step F: results report with counts of epics created/reused and stories created/skipped
- No `{{PLACEHOLDER}}` tokens used in the new section (all values are runtime-read from config)

**Dependencies:** T4

---

## T6 — Mirror changes to `.claude/commands/update-product-driven-backlog.md` [commands]

**Description:**
Apply the same structural and content changes from T4 and T5 to `.claude/commands/update-product-driven-backlog.md` — the active command in this repo. Since this file has no `{{PLACEHOLDER}}` tokens, insert the JIRA prose verbatim. The only difference from the template: this file has hardcoded persona names and area paths already filled in — do not disturb those.

**Files involved:**
- `.claude/commands/update-product-driven-backlog.md`

**Acceptance criteria:**
- The Assembly section structure mirrors the template: step 2 reads config, then display-only section, then GitHub section, then JIRA section
- The GitHub section header is updated to include the `provider=github` condition
- The full JIRA sync section (Steps A–F) is present and identical in structure to the template version
- No `{{PLACEHOLDER}}` tokens appear anywhere in the file
- The existing GitHub Issues content (persona names: Alex, Sara, Kai; area paths) is preserved exactly

**Dependencies:** T4, T5

---

## T7 — Verify install.sh does not copy `commands/setup.md` from a template [core]

**Description:**
The design notes that `templates/commands/setup.md` does not currently exist — setup is installed from `commands/setup.md` directly. Verify this by reading `install.sh` and confirming whether it copies from `templates/commands/setup.md` or from `commands/setup.md`. If it copies from a template, update `templates/commands/setup.md` with the same changes as T1–T3. Document the finding in a comment inside `commands/setup.md`.

**Files involved:**
- `install.sh` (read only)
- `templates/commands/setup.md` (create and update if needed)
- `commands/setup.md` (add a comment if template does not exist)

**Acceptance criteria:**
- `install.sh` is read and the copy path for `setup.md` is confirmed
- If `templates/commands/setup.md` exists and is the source: it receives the same T1–T3 changes as `commands/setup.md`
- If only `commands/setup.md` is used: a one-line comment is added near the Phase 3.2 JIRA section noting "no separate template — this file IS the source"

**Dependencies:** T1, T2, T3

---

## T8 — Manual verification: JIRA config writing [core]

**Description:**
After T1–T3 complete, manually trace through the `/setup` Phase 3.2 JIRA branch and confirm the output `backlog-config.json` structure is correct. Do not run `/setup` — read the command prose and verify by inspection that all three new fields are written.

**Verification steps:**
1. Read `commands/setup.md` Phase 3.2 JIRA branch
2. Confirm `PROJECT_LABEL` prompt is present and skippable
3. Confirm `EPIC_LINK_FIELD` prompt is present, defaults to `parent`
4. Confirm the JSON block includes `project_label`, `epic_link_field`, `epic_mapping: {}`
5. Confirm Phase 3.5 Configuration Summary table has the two new conditional rows
6. Confirm GitHub Issues section is unchanged

**Files involved:** none (verification by reading)

**Acceptance criteria:**
- All 6 verification steps pass by inspection

**Dependencies:** T1, T2, T3, T7

---

## T9 — Manual verification: JIRA sync section [core]

**Description:**
After T5 and T6 complete, verify the JIRA sync section in both the template and active command files by inspection.

**Verification steps:**
1. Read `templates/commands/update-product-driven-backlog.md` — confirm JIRA section is present after GitHub section
2. Read `.claude/commands/update-product-driven-backlog.md` — confirm same structure
3. Confirm Step D epic ensure logic covers all three cases (cache hit, JIRA search, create)
4. Confirm `epic_mapping` is written back to `backlog-config.json` after Step D
5. Confirm Step E story creation includes: ADF description, labels array, epic linkage field
6. Confirm Step E error handling covers dead epic key and generic API error
7. Confirm GitHub Issues section content is unchanged in both files
8. Run: `grep -r '{{[A-Z_]*}}' .claude/commands/update-product-driven-backlog.md` — confirm no broken placeholders

**Files involved:** none (verification by reading)

**Acceptance criteria:**
- All 8 verification steps pass
- No broken `{{PLACEHOLDER}}` tokens in the active command

**Dependencies:** T5, T6
