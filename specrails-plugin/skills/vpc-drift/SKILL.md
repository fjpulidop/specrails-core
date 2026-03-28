---
name: vpc-drift
description: "Detect when user personas defined in the VPC are drifting from actual usage patterns. Compares persona Jobs/Pains/Gains against the product backlog, implemented features, and agent memory to surface alignment gaps and recommend VPC updates."
license: MIT
compatibility: "Requires git."
metadata:
  author: specrails
  version: "1.0"
---

Analyze **this project** (read name from CLAUDE.md or package.json) for VPC persona drift — gaps between what persona definitions promise and what the product actually delivers. Produces a per-persona alignment score, drifted attributes, and concrete VPC update recommendations.

**Input:** $ARGUMENTS — optional flags:
- `--persona <names>` — comma-separated persona names to analyze. Default: all personas.
- `--verbose` — show full attribute lists in output (default: summarized).
- `--format json` — emit the drift report as JSON instead of Markdown.

---

## Phase 0: Argument Parsing

Parse `$ARGUMENTS` to set runtime variables.

**Variables to set:**

- `PERSONA_FILTER` — array of lowercased persona names, or `"all"`. Default: `"all"`.
- `VERBOSE` — boolean. Default: `false`.
- `FORMAT` — `"markdown"` or `"json"`. Default: `"markdown"`.

**Parsing rules:**

1. Scan `$ARGUMENTS` for `--persona <names>`. If found, split `<names>` on commas, lowercase each, set `PERSONA_FILTER=<array>`. Strip from arguments.
2. Scan for `--verbose`. If found, set `VERBOSE=true`. Strip from arguments.
3. Scan for `--format <value>`. If found and value is `json`, set `FORMAT="json"`. Any other value: print `Error: unknown format "<value>". Valid: markdown, json` and stop.

**Print active configuration:**

```
Analyzing personas: <all | comma-separated list>
Format: <markdown|json>
Verbose: <yes|no>
```

---

## Phase 1: Load VPC Personas

Read the persona files to extract the VPC attribute definitions.

### Step 1a: Discover persona files

Glob for persona files using these paths in order (use the first that yields results):

1. `.claude/agents/` — look for `.md` files whose content includes a `## Value Proposition Canvas` section.
2. `{{PERSONA_DIR}}/` — project-level persona directory (set by installer).

If no persona files are found in either location:

```
Error: No VPC persona files found.
Expected locations (check both): `.specrails/personas/*.md` and `.claude/agents/personas/*.md`
Each persona file must contain a ## Value Proposition Canvas section.
Run /setup to generate persona files from templates.
```

Stop.

### Step 1b: Parse each persona

For each discovered file, extract:

- `PERSONA_NAME` — from the `# Persona:` heading or frontmatter `name:` field.
- `PERSONA_ROLE` — from the profile table row `**Name**` (the role portion after "— The ").
- `JOBS` — rows from the `### Customer Jobs` table. Each row: `{ type, job }`.
- `PAINS` — rows from the `### Pains` table. Each row: `{ severity, pain }`.
- `GAINS` — rows from the `### Gains` table. Each row: `{ impact, gain }`.

If `PERSONA_FILTER` is not `"all"`, skip any persona whose lowercased name is not in `PERSONA_FILTER`.

Store parsed personas in `PERSONAS` (array of objects).

**Print after discovery:**

```
Found <N> persona(s): <Name1> (<Role1>), <Name2> (<Role2>), ...
```

If `PERSONA_FILTER` was applied and yielded 0 matches:

```
Error: No personas matched filter: <PERSONA_FILTER>. Check spelling and try again.
```

Stop.

---

## Phase 2: Load Product Signals

Gather the three signal sources: backlog, implemented features, and agent memory.

### Step 2a: Backlog (requested features)

Load open/pending feature requests — these represent what the product *intends* to deliver.

1. **Cache:** Check whether `.claude/backlog-cache.json` exists and is valid JSON. If so, read all issues from it (`issues` map). Set `BACKLOG_SOURCE="cache"`.
2. **Live:** If no cache, run:
   ```bash
   If BACKLOG_PROVIDER=github: `gh issue list --label "product-driven-backlog" --json number,title,body,labels --limit 200`
If BACKLOG_PROVIDER=local: read `.specrails/local-tickets.json`
   ```
   If the backlog provider is unavailable, set `BACKLOG_ITEMS=[]` and print:
   ```
   Warning: backlog provider unavailable. Backlog signal will be skipped.
   ```
3. Parse each backlog item to extract:
   - `title` — feature name.
   - `description` — feature description (first 300 chars).
   - `persona_scores` — per-persona scores from the Overview table (if present). Format: `{ "Alex": 3, "Sara": 5, "Kai": 0 }`.
   - `area` — from the `area:*` label.

Store in `BACKLOG_ITEMS`. Print: `Backlog loaded: <N> items (source: <cache|live>)`.

### Step 2b: Implemented features

Gather signals about what has *actually been built*.

Run the following in sequence (each is best-effort — continue even if any fails):

**i. Git log (last 90 days):**
```bash
git log --oneline --since="90 days ago" --no-merges 2>/dev/null
```
Extract commit subjects. Filter out pure chore/docs/test/ci commits (those whose subject starts with `chore:`, `docs:`, `test:`, `ci:`). Store in `COMMIT_MESSAGES`.

**ii. CHANGELOG.md / CHANGELOG:**
Check whether `CHANGELOG.md` or `CHANGELOG` exists at the repo root. If found, read the last 500 lines. Extract headings and bullet points as feature descriptions. Store in `CHANGELOG_ENTRIES`.

**iii. Closed backlog issues (if GH available):**
```bash
If BACKLOG_PROVIDER=github: `gh issue list --label "product-driven-backlog" --state closed --json number,title,body,labels --limit 200`
If BACKLOG_PROVIDER=local: read closed tickets from `.specrails/local-tickets.json`
```
Parse closed items the same way as open backlog items. Store in `CLOSED_ITEMS`.

Build `IMPLEMENTED_FEATURES` = array of strings combining `COMMIT_MESSAGES` + `CHANGELOG_ENTRIES` + closed item titles. Deduplicate by lowercased text.

Print: `Implemented signals: <N commits> commits, <N> changelog entries, <N> closed items`.

### Step 2c: Agent memory usage patterns

Check whether `.claude/agent-memory/` exists. If it does, glob all `.md` files within it. For each file:
- Read the filename and first 200 chars of content.
- Extract any feature names, tool names, or workflow keywords mentioned.

Store extracted terms in `MEMORY_SIGNALS` (flat string array).

If the directory does not exist or is empty: set `MEMORY_SIGNALS=[]`. Print: `Agent memory: no signals found.`

Otherwise: Print: `Agent memory: <N> signals from <N> files.`

---

## Phase 3: Drift Analysis — Per Persona

For each persona in `PERSONAS`, perform a full alignment analysis.

### Step 3a: Build a feature corpus

Create a combined text corpus:
```
CORPUS = BACKLOG_ITEMS titles + descriptions
       + IMPLEMENTED_FEATURES
       + MEMORY_SIGNALS
```

### Step 3b: Attribute matching

For each VPC attribute (Job, Pain, Gain), determine whether it is *addressed* by the corpus.

**Matching rule:** An attribute is considered addressed if at least one corpus entry contains 2+ meaningful keyword matches from the attribute text. Use semantic matching (synonyms count — e.g., "slow" matches "latency", "performance"). If exact matching is insufficient, use AI-assisted reasoning to determine relevance.

For each attribute, record:
- `addressed` — boolean: is this attribute addressed?
- `matched_by` — array of corpus items (up to 3) that most strongly address it.
- `match_confidence` — `"strong"` (3+ keywords or explicit mention), `"weak"` (2 keywords, indirect), `"none"`.

### Step 3c: Compute alignment scores

```
JOBS_ADDRESSED   = count(jobs where addressed=true)
PAINS_RELIEVED   = count(pains where addressed=true)
GAINS_CREATED    = count(gains where addressed=true)

JOBS_SCORE       = JOBS_ADDRESSED / total_jobs  (0.0–1.0)
PAINS_SCORE      = PAINS_RELIEVED / total_pains (0.0–1.0)
GAINS_SCORE      = GAINS_CREATED / total_gains  (0.0–1.0)

OVERALL_SCORE    = (JOBS_SCORE + PAINS_SCORE + GAINS_SCORE) / 3
```

If a category has 0 attributes (e.g., no pains defined): exclude it from the OVERALL_SCORE denominator.

### Step 3d: Classify drift level

| Overall Score | Drift Level |
|---------------|-------------|
| ≥ 0.80        | Low         |
| 0.60–0.79     | Medium      |
| 0.40–0.59     | High        |
| < 0.40        | Critical    |

### Step 3e: Identify drifted attributes

A VPC attribute is **drifted** when `addressed=false`.

Rank drifted attributes by severity/impact weight:
- Pains with severity `critical` → weight 3
- Pains with severity `high` or Jobs/Gains with impact `high` → weight 2
- All others → weight 1

Sort drifted attributes by weight descending.

### Step 3f: Identify misaligned backlog items

A backlog item is **misaligned** for this persona when:
1. The item's `persona_scores` gives this persona a score of 0, AND
2. The item's description does not match any of this persona's VPC attributes (by the same matching rule as Step 3b).

OR when the item has no persona score data at all and its description does not semantically relate to any of this persona's Jobs/Pains/Gains.

### Step 3g: Generate VPC update recommendations

For each drifted attribute (weight ≥ 2), produce a concrete recommendation:

- If many features address a *different* pain than what's defined: "Consider updating the `<Pain>` attribute to reflect the observed pattern: [observed pattern]."
- If a Job is completely unaddressed across the product: "Either prioritize features addressing `<Job>`, or remove it from the VPC if no longer relevant."
- If a Gain is partially addressed: "Strengthen the `<Gain>` attribute description to capture the nuance being delivered by [feature(s)]."

Limit to top 5 recommendations per persona, sorted by weight descending.

Store per-persona results in `PERSONA_DRIFT` array.

---

## Phase 4: Detect Cross-Persona Patterns

After all per-persona analyses are complete, look for systemic patterns.

**Over-represented persona:** If one persona's backlog items make up > 60% of total items, flag it:
```
⚠️  Over-representation detected: <PersonaName> drives <N>% of backlog items.
    This may indicate under-investment in other personas' pain points.
```

**Under-served persona:** If a persona's OVERALL_SCORE < 0.40:
```
🚨  Critical drift for <PersonaName>: only <N>% of their VPC attributes are being addressed.
```

**Orphan backlog items:** Items with no persona scores at all (neither from score data nor semantic matching). Count them. If > 20% of total backlog, flag:
```
⚠️  <N> backlog items (<N>%) have no clear persona linkage.
    Consider running /specrails:update-product-driven-backlog to re-evaluate them.
```

Store in `CROSS_PERSONA_FINDINGS`.

---

## Phase 5: Build and Render Drift Report

### If FORMAT = "json"

Emit a single JSON object:

```json
{
  "schema_version": "1",
  "project": "<project name from CLAUDE.md or package.json>",
  "generated_at": "<ISO 8601 timestamp>",
  "personas": [
    {
      "name": "<PersonaName>",
      "role": "<Role>",
      "drift_level": "<Low|Medium|High|Critical>",
      "scores": {
        "jobs": <0.0–1.0>,
        "pains": <0.0–1.0>,
        "gains": <0.0–1.0>,
        "overall": <0.0–1.0>
      },
      "drifted_attributes": [
        { "category": "<job|pain|gain>", "text": "...", "weight": <1|2|3> }
      ],
      "misaligned_items": ["<title>", ...],
      "recommendations": ["..."]
    }
  ],
  "cross_persona_findings": ["..."],
  "summary": {
    "total_personas": <N>,
    "critical": <N>,
    "high": <N>,
    "medium": <N>,
    "low": <N>
  }
}
```

Stop after emitting JSON.

### If FORMAT = "markdown"

Render the full drift report:

```
## VPC Persona Drift Report — this project
Generated: <YYYY-MM-DD HH:MM> | Backlog: <N> items | Implemented signals: <N>

### Summary

| Persona | Role | Jobs | Pains | Gains | Overall | Drift Level |
|---------|------|------|-------|-------|---------|-------------|
| <Name>  | <Role> | <N%> | <N%> | <N%> | <N%>  | 🟢 Low / 🟡 Medium / 🟠 High / 🔴 Critical |

<for each CROSS_PERSONA_FINDING: render the warning/flag block>

---
```

Then for each persona:

```
### Persona: <Name> — <Role>

**Drift Level:** 🟢/🟡/🟠/🔴 <Level> | **Alignment: <N>%** (Jobs: <N>%, Pains: <N>%, Gains: <N>%)

#### ✅ Addressed Attributes (<N> of <total>)

<if VERBOSE=true:>
| Category | Attribute | Confidence | Matched by |
|----------|-----------|------------|------------|
| Job      | <text>    | Strong     | <feature1>, <feature2> |
| Pain     | <text>    | Weak       | <feature1> |

<if VERBOSE=false:>
- **Jobs**: <N> of <total> addressed
- **Pains**: <N> of <total> relieved
- **Gains**: <N> of <total> created

#### ⚠️ Drifted Attributes (<N> unaddressed)

| Category | Attribute | Severity/Impact | Weight |
|----------|-----------|-----------------|--------|
| Pain     | <text>    | critical        | ●●●    |
| Job      | <text>    | high            | ●●     |
| Gain     | <text>    | medium          | ●      |

<if no drifted attributes:>
_No drifted attributes — all VPC definitions are reflected in the product._

#### ❌ Misaligned Backlog Items (<N> items)

<if items exist:>
| # | Title | Persona Score | Why Misaligned |
|---|-------|---------------|----------------|
| <number> | <title> | 0/5 | No matching VPC attribute |

<if no items:>
_All backlog items have clear VPC alignment for this persona._

#### 💡 Recommended VPC Updates

<numbered list of up to 5 recommendations>

---
```

After all personas:

```
### Next Steps

1. Review drifted attributes and decide: **update VPC** (if the product has legitimately evolved) or **add backlog items** (if the persona's needs are being neglected).
2. Run `/specrails:update-product-driven-backlog` after updating personas to regenerate aligned feature ideas.
3. Re-run `/specrails:vpc-drift` after one sprint to measure improvement.

_Generated by `/specrails:vpc-drift` on <ISO date>_
```

---

## Phase 6: Save Snapshot (optional)

After rendering, write a drift snapshot to `.claude/health-history/`:

1. Filename: `vpc-drift-<YYYY-MM-DD>.json`
2. Directory: `.claude/vpc-drift-history/` (create if absent, idempotent).
3. Content: the same JSON object described in Phase 5 (regardless of FORMAT setting).

Print: `Snapshot saved: .claude/vpc-drift-history/vpc-drift-<YYYY-MM-DD>.json`

If the write fails: print `Warning: could not write drift snapshot. Continuing.` Do not abort.

**Housekeeping:** If `.claude/vpc-drift-history/` has more than 30 `.json` files, print:
```
Note: .claude/vpc-drift-history/ has <N> snapshots. Prune old ones with:
  ls -t .claude/vpc-drift-history/ | tail -n +31 | xargs -I{} rm .claude/vpc-drift-history/{}
```
