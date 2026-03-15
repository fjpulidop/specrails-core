# /sr:why — In-Context Help

Searches explanation records written by sr-architect, sr-developer, and sr-reviewer agents
during the OpenSpec implementation pipeline.

Records are stored in `.claude/agent-memory/explanations/` as Markdown files with
YAML frontmatter (agent, feature, tags, date).

**Usage:**
- `/sr:why` — list the 20 most recent explanation records
- `/sr:why <query>` — search records by keyword or tag

---

## Step 1: Find explanation records

Glob all files matching `.claude/agent-memory/explanations/*.md`.

If the directory does not exist or contains no files:
Print:
```
No explanation records found yet.

Explanation records are written by the sr-architect, sr-developer, and sr-reviewer agents
when they make significant decisions during feature implementation.

Run `/sr:implement` on a feature to generate your first explanation records.
```
Then stop.

## Step 2: Handle no-argument mode (listing)

If `$ARGUMENTS` is empty:

Read each explanation record file. Extract from frontmatter: `date`, `agent`, `feature`, `tags`.
Extract the first sentence of the `## Decision` section as the decision summary.

Sort records by `date` descending. Print the 20 most recent as a Markdown table:

```
## Recent Explanation Records

| Date | Agent | Feature | Tags | Decision |
|------|-------|---------|------|----------|
| 2026-03-14 | sr-architect | in-context-help | [templates, commands] | Chose flat directory over per-agent subdirectories. |
| ...  | ...   | ...     | ...  | ...      |
```

Then stop.

## Step 3: Handle query mode (search)

If `$ARGUMENTS` is non-empty, treat the full string as the search query.

For each explanation record file:
1. Read the full file content
2. Score the record against the query:
   - Filename contains a query word: +3 points per matching word
   - Frontmatter `tags` array contains an exact query word: +3 points per matching tag
   - Frontmatter `feature` contains a query word: +2 points
   - Body text contains a query word: +1 point per occurrence (case-insensitive)
3. Sum the score

Sort records by score descending. Take the top 5 records with score > 0.

If no records score > 0:
Print:
```
No explanation records match "<query>".
```
Then list all unique tags from existing records:
```
## Available Tags

[sorted list of all unique tags from all explanation records]

Try `/sr:why <tag>` with one of the tags above, or `/sr:why` to browse all records.
```

If records match, print each matching record in full, separated by `---`:

```
## Results for "<query>" (N matches)

---

**[date] [agent] — [feature]**
Tags: [tag1, tag2]

[full record body]

---

**[date] [agent] — [feature]**
...
```
