---
name: "Agent Telemetry & Cost Tracker"
description: "Inspect per-agent execution metrics: token usage (input/output/cache), estimated API cost, run count, average duration, and success/failure rate. Reads Claude CLI JSONL session logs and agent-memory files. Outputs a cost dashboard with trend indicators and optimization recommendations."
category: Workflow
tags: [workflow, telemetry, cost, metrics, analytics, agents]
---

Analyze **specrails-core** agent execution telemetry — token usage, API cost estimates, run throughput, and performance trends across all `sr-*` agents.

**Input:** `$ARGUMENTS` — optional flags:

- `--period <filter>` — time window for analysis. Values: `today`, `week`, `all`. Default: `week`.
- `--agent <name>` — focus on a single agent (e.g. `sr-developer`). Default: all agents.
- `--format <fmt>` — output format: `markdown` or `json`. Default: `markdown`.
- `--save` — write a snapshot to `.claude/telemetry/` after display.

---

## Phase 0: Argument Parsing

Parse `$ARGUMENTS` to set runtime variables.

**Variables to set:**

- `PERIOD` — `"today"`, `"week"`, or `"all"`. Default: `"week"`.
- `AGENT_FILTER` — string or empty string. Default: `""` (all agents).
- `FORMAT` — `"markdown"` or `"json"`. Default: `"markdown"`.
- `SAVE_SNAPSHOT` — boolean. Default: `false`.
- `PERIOD_START` — ISO datetime lower bound derived from `PERIOD` and the current date/time. Set to `null` for `"all"`.

**Parsing rules:**

1. Scan `$ARGUMENTS` for `--period <value>`. Valid values: `today`, `week`, `all`. If an unknown value is found: print `Error: unknown period "<value>". Valid: today, week, all` and stop. Strip from arguments.
2. Scan for `--agent <name>`. If found, set `AGENT_FILTER=<name>` (lowercase, strip leading `sr-` if the user omitted it — always normalize to `sr-<name>` form internally). Strip from arguments.
3. Scan for `--format <value>`. Valid: `markdown`, `json`. Unknown value: print `Error: unknown format "<value>". Valid: markdown, json` and stop. Strip from arguments.
4. Scan for `--save`. If found, set `SAVE_SNAPSHOT=true`. Strip from arguments.

**Derive `PERIOD_START`:**

- `today` → start of today (00:00:00 UTC of the current date)
- `week` → 7 days ago at 00:00:00 UTC
- `all` → `null` (no lower bound)

**Print active configuration:**

```
Period: <today | last 7 days | all time>  Agent: <AGENT_FILTER or "all">  Format: <markdown|json>  Save: <yes|no>
```

---

## Phase 1: Log Discovery

Collect JSONL session log files that may contain Claude CLI usage data. Search the following locations in order; collect all matching files (do not stop at the first hit):

### 1a. Project-scoped logs

Check for `.jsonl` files under the project `.claude/` directory (excluding `.claude/agent-memory/` and `.claude/health-history/`):

```bash
find .claude/ -name "*.jsonl" \
  -not -path ".claude/agent-memory/*" \
  -not -path ".claude/health-history/*" \
  -not -path ".claude/telemetry/*" 2>/dev/null
```

### 1b. Global Claude CLI logs

Claude CLI stores project sessions under `~/.claude/projects/`. Derive the project hash from the current working directory's absolute path (Claude uses a URL-encoded or base64 path as the directory name). Try:

```bash
# Attempt 1: match by cwd
PROJECT_HASH=$(ls ~/.claude/projects/ 2>/dev/null | while read d; do
  cwd_file="$HOME/.claude/projects/$d/.cwd"
  [ -f "$cwd_file" ] && grep -qF "$(pwd)" "$cwd_file" && echo "$d" && break
done)

# Attempt 2: glob all projects and filter by recent mtime if Attempt 1 fails
```

If a matching project directory is found, glob for JSONL files:

```bash
find "$HOME/.claude/projects/$PROJECT_HASH/" -name "*.jsonl" 2>/dev/null
```

### 1c. Explicit log paths

Also check these well-known paths:

- `~/.claude/logs/*.jsonl`
- `.claude/runs/*.jsonl`

### 1d. Collect results

Set `LOG_FILES` = deduplicated list of all discovered `.jsonl` paths, sorted by modification time descending.

Apply time filter: if `PERIOD_START` is not null, exclude files whose last modification time is before `PERIOD_START`.

**Print discovery summary:**

```
Log files discovered: N  (project-scoped: N | global: N | other: N)
```

If `LOG_FILES` is empty:
```
No JSONL session logs found. Telemetry will be derived from agent-memory metadata only.
Log locations searched:
  - .claude/**/*.jsonl
  - ~/.claude/projects/<hash>/**/*.jsonl
  - ~/.claude/logs/*.jsonl
  - .claude/runs/*.jsonl

To enable richer telemetry, configure Claude CLI to persist session logs.
```

Set `LOGS_AVAILABLE=false` and continue (the command falls back to agent-memory in Phase 3).

---

## Phase 2: Parse Session Logs

Skip this phase if `LOGS_AVAILABLE=false`.

For each file in `LOG_FILES`, read line-by-line and parse each valid JSON object. Extract records that match the Claude CLI session result schema.

### 2a. Record schema

A valid telemetry record has the following structure (fields may be absent — treat missing as null/zero):

```json
{
  "type":            "result" | "assistant" | "tool_result" | ...,
  "session_id":      "<uuid>",
  "agent":           "<agent-name>",
  "model":           "<model-id>",
  "duration_ms":     12345,
  "is_error":        false,
  "usage": {
    "input_tokens":                 1000,
    "output_tokens":                500,
    "cache_read_input_tokens":      200,
    "cache_creation_input_tokens":  50
  },
  "timestamp":       "<ISO 8601>"
}
```

**Extraction rules:**

- Include records where `type` is `"result"` or where `usage` is present with at least one non-zero token count.
- Infer `agent` name from:
  1. The `agent` field directly (if present).
  2. The source log file path (if the path contains `sr-<name>`, extract it).
  3. A `system_prompt` field snippet (if present): match against known agent persona names (`sr-architect`, `sr-developer`, `sr-test-writer`, `sr-reviewer`, `sr-security-reviewer`, `sr-doc-sync`, `sr-product-analyst`, `sr-product-manager`).
  4. If agent cannot be determined: assign to the bucket `"unknown"`.
- Apply time filter: if `PERIOD_START` is not null, skip records where `timestamp < PERIOD_START`.
- If `AGENT_FILTER` is set, skip records where the resolved agent name does not match.

### 2b. Build RAW_RECORDS

`RAW_RECORDS` = list of parsed records, each normalized to:

```
{ session_id, agent, model, timestamp, duration_ms, is_error, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }
```

Where `is_error` defaults to `false` and missing token counts default to `0`.

**Print:**

```
Parsed N records from N log files.
```

---

## Phase 3: Agent-Memory Inventory

Regardless of `LOGS_AVAILABLE`, collect metadata from `.claude/agent-memory/sr-*/`.

For each directory:

- `AGENT_NAME` — directory name (e.g. `sr-developer`)
- `FILE_COUNT` — total files in the directory
- `LAST_MODIFIED` — ISO date of the most recently modified file

If `AGENT_FILTER` is set, collect only the matching directory.

Set `MEMORY_AGENTS` = list of `{ agent_name, file_count, last_modified }`.

**If `LOGS_AVAILABLE=false`**, synthesize a minimal telemetry record per agent from agent-memory presence only:

```
{ agent: <agent_name>, run_count: "unknown", last_active: <last_modified>, tokens: null, cost: null }
```

This allows the dashboard to at least list known agents and their last activity.

---

## Phase 4: Aggregate Per-Agent Metrics

Group `RAW_RECORDS` by `agent`. For each agent, compute:

| Metric | Derivation |
|--------|-----------|
| `run_count` | Count of records for this agent |
| `success_count` | Count where `is_error=false` |
| `failure_count` | Count where `is_error=true` |
| `success_rate` | `success_count / run_count * 100` (%) |
| `total_input_tokens` | Sum of `input_tokens` |
| `total_output_tokens` | Sum of `output_tokens` |
| `total_cache_read_tokens` | Sum of `cache_read_tokens` |
| `total_cache_write_tokens` | Sum of `cache_write_tokens` |
| `total_tokens` | Sum of all token types |
| `avg_input_tokens` | `total_input_tokens / run_count` |
| `avg_output_tokens` | `total_output_tokens / run_count` |
| `avg_duration_ms` | Mean of non-null `duration_ms` values |
| `p50_duration_ms` | Median of non-null `duration_ms` values |
| `p95_duration_ms` | 95th percentile of non-null `duration_ms` values |
| `last_active` | Max `timestamp` across all records |
| `models_used` | Deduplicated list of `model` values observed |

Set `AGENT_METRICS` = map of agent name → aggregated metrics object.

Also compute `TOTALS`:

| Field | Derivation |
|-------|-----------|
| `total_runs` | Sum of `run_count` across all agents |
| `total_successes` | Sum of `success_count` |
| `total_failures` | Sum of `failure_count` |
| `overall_success_rate` | `total_successes / total_runs * 100` (%) |
| `grand_total_input_tokens` | Sum across all agents |
| `grand_total_output_tokens` | Sum across all agents |
| `grand_total_cache_read_tokens` | Sum across all agents |
| `grand_total_cache_write_tokens` | Sum across all agents |
| `grand_total_tokens` | Sum across all agents |

---

## Phase 5: Cost Estimation

Compute estimated API cost per agent using published Claude pricing (per million tokens). Use the `models_used` field to select the correct rate card. If multiple models were used, compute cost per-model and sum.

**Default rate cards (USD per million tokens):**

| Model family | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| `claude-opus-4*` | $15.00 | $75.00 | $1.50 | $3.75 |
| `claude-sonnet-4*` | $3.00 | $15.00 | $0.30 | $0.75 |
| `claude-haiku-4*` | $0.25 | $1.25 | $0.025 | $0.0625 |
| `unknown` | $3.00 | $15.00 | $0.30 | $0.75 |

Match model IDs by prefix (e.g. `claude-sonnet-4-6` → `claude-sonnet-4*`). If a model cannot be matched, use the `unknown` rate card and flag it in output.

**Per-agent cost formula:**

```
cost = (input_tokens / 1_000_000 * input_rate)
     + (output_tokens / 1_000_000 * output_rate)
     + (cache_read_tokens / 1_000_000 * cache_read_rate)
     + (cache_write_tokens / 1_000_000 * cache_write_rate)
```

Compute:

- `agent_cost` — total cost for the agent across all records in the current period
- `avg_cost_per_run` — `agent_cost / run_count`
- `cache_savings` — tokens saved by cache reads, expressed as cost equivalent:
  `cache_read_tokens / 1_000_000 * (input_rate - cache_read_rate)`

Add `agent_cost`, `avg_cost_per_run`, and `cache_savings` to each agent's metrics object.

Also compute:

- `TOTAL_COST` — sum of `agent_cost` across all agents
- `TOTAL_CACHE_SAVINGS` — sum of `cache_savings` across all agents

---

## Phase 6: Trend Analysis

Compare the current period's per-agent metrics against the previous equivalent period (loaded from `.claude/telemetry/` snapshots, if available).

### 6a. Load Previous Snapshot

Check `.claude/telemetry/` for JSON files matching `<YYYY-MM-DD>-<period>.json`. Select the snapshot from the previous equivalent period:

- `today` → yesterday's `today` snapshot
- `week` → the `week` snapshot from 7 days ago
- `all` → skip trend analysis (no meaningful comparison baseline for "all time")

Set `PREV_SNAPSHOT` = parsed JSON or `null` if not found / period is `"all"`.

### 6b. Compute Trend Indicators

If `PREV_SNAPSHOT` is not null, for each agent compute deltas for these metrics vs. the previous snapshot:

| Metric | Direction where higher is better |
|--------|----------------------------------|
| `run_count` | higher ↑ |
| `success_rate` | higher ↑ |
| `avg_duration_ms` | lower ↓ |
| `total_tokens` | lower ↓ (efficiency) |
| `agent_cost` | lower ↓ |
| `cache_savings` | higher ↑ |

Assign a trend label per metric:

- `improving` — delta moves in the "better" direction by ≥ 5%
- `degrading` — delta moves in the "worse" direction by ≥ 5%
- `stable` — delta within ±5%
- `new` — agent did not exist in the previous snapshot

Set `TRENDS` = map of agent name → map of metric → `{ delta, direction, label }`.

---

## Phase 7: Display Dashboard

Render output according to `FORMAT`.

### FORMAT = "markdown"

```
## Agent Telemetry Dashboard — specrails-core
Period: <today | last 7 days | all time>  |  As of: <ISO date>  |  Data source: <logs + memory | memory only>

---

### Summary

| Metric | Value |
|--------|-------|
| Total runs | N |
| Success rate | N% |
| Total tokens consumed | N (input: N, output: N, cached: N) |
| Estimated total cost | $N.NN |
| Cache savings | $N.NN |
| Active agents | N |

---

### Per-Agent Breakdown

<For each agent, sorted by agent_cost descending:>

#### <agent-name>  <trend badge: 🟢 improving | 🔴 degrading | 🟡 stable | 🆕 new>

| Metric | Value | vs. Previous |
|--------|-------|-------------|
| Runs | N | <+N / -N / N/A> |
| Success rate | N% | <trend indicator> |
| Avg duration | Ns | <trend indicator> |
| Total tokens | N | <trend indicator> |
| — Input | N | |
| — Output | N | |
| — Cache reads | N | |
| — Cache writes | N | |
| Estimated cost | $N.NN | <trend indicator> |
| Avg cost / run | $N.NN | |
| Cache savings | $N.NN | <trend indicator> |
| Models used | <model-id, ...> | |
| Last active | <ISO date> | |

<if success_rate < 80%:>
⚠️  Low success rate detected. Check agent logs for recurring failures.

<if avg_duration_ms > 120_000:>
⚠️  Average run exceeds 2 minutes. Consider prompt optimization or task decomposition.

---

### Cost Distribution

| Agent | Cost | % of Total | Trend |
|-------|------|------------|-------|
| sr-developer | $N.NN | N% | 🟢 improving |
| ...          | ...   | ...| ...         |
| **TOTAL**    | **$N.NN** | 100% | |

---

### Cache Efficiency

Cache reads reduce cost compared to re-sending the same tokens as new input.

| Agent | Cache Read Tokens | Savings | Hit Rate |
|-------|------------------|---------|---------|
| sr-developer | N | $N.NN | N% |
| ... | ... | ... | ... |
| **TOTAL** | N | **$N.NN** | |

Cache hit rate = `cache_read_tokens / (input_tokens + cache_read_tokens) * 100`.

---

### Trend Summary

<if PREV_SNAPSHOT is null:>
No previous snapshot available for comparison (period: <PERIOD>).
Run with `--save` to persist a baseline for future trend analysis.

<if PREV_SNAPSHOT is not null:>

| Agent | Runs Δ | Success Δ | Duration Δ | Cost Δ | Overall |
|-------|--------|----------|-----------|--------|---------|
| sr-developer | +N | +N% | -Ns | -$N.NN | 🟢 improving |
| ...          | ...  | ...  | ...   | ...    | ...          |

---

### Recommendations

<render only applicable items, in priority order:>

1. **High failure rate** — if any agent has `success_rate < 80%`:
   ```
   ⚠️  <agent-name> has a N% success rate (N failures out of N runs).
   Action: Review `.claude/agent-memory/<agent-name>/failure-patterns.md` for recurring errors.
   ```

2. **Cost outlier** — if any agent accounts for > 50% of total cost:
   ```
   💰  <agent-name> accounts for N% of total cost ($N.NN / $N.NN).
   Action: Review average token consumption per run (avg input: N, avg output: N).
            Consider shorter prompts, tighter context windows, or caching more aggressively.
   ```

3. **Cache underutilization** — if any agent's cache hit rate < 20% and run count ≥ 5:
   ```
   💡  <agent-name> cache hit rate is N% (N cache reads / N total input tokens).
   Action: Ensure system prompts and static context are positioned where Claude can cache them.
            Use the `--cache` flag if available in your Claude CLI version.
   ```

4. **Slow average duration** — if any agent's `avg_duration_ms > 120_000`:
   ```
   🐢  <agent-name> average run duration is Ns (target: <120s).
   Action: Profile the longest phases. Consider breaking large tasks into smaller subtasks.
   ```

5. **Degrading trend** — if any agent's overall trend is "degrading":
   ```
   📉  <agent-name> metrics are degrading vs. the previous period.
   Check: success rate, token usage, and cost deltas in the Per-Agent Breakdown above.
   ```

6. **Memory not cleared** — if any agent has > 50 memory files:
   ```
   🗂️  <agent-name> has N memory files. Large memory stores may slow context loading.
   Action: Run `/sr:memory-inspect --prune` to clean stale entries.
   ```

7. **Data gap warning** — if `LOGS_AVAILABLE=false`:
   ```
   ℹ️  Telemetry is based on agent-memory metadata only (no JSONL logs found).
   Token and cost data are unavailable. To enable full telemetry:
     - Run /sr:implement with Claude CLI configured to persist session logs.
     - Check your Claude CLI version for `--output-format` or `--log` options.
   ```

8. **No issues found** — if none of the above apply:
   ```
   ✅  All agents are operating within healthy parameters.
   ```
```

### FORMAT = "json"

Emit a single JSON object to stdout:

```json
{
  "schema_version": "1",
  "project": "specrails-core",
  "period": "<today|week|all>",
  "period_start": "<ISO datetime or null>",
  "generated_at": "<ISO datetime>",
  "data_source": "<logs+memory|memory-only>",
  "totals": {
    "run_count": 0,
    "success_rate": 0.0,
    "total_input_tokens": 0,
    "total_output_tokens": 0,
    "total_cache_read_tokens": 0,
    "total_cache_write_tokens": 0,
    "grand_total_tokens": 0,
    "total_cost_usd": 0.0,
    "total_cache_savings_usd": 0.0,
    "active_agents": 0
  },
  "agents": {
    "<agent-name>": {
      "run_count": 0,
      "success_count": 0,
      "failure_count": 0,
      "success_rate": 0.0,
      "total_input_tokens": 0,
      "total_output_tokens": 0,
      "total_cache_read_tokens": 0,
      "total_cache_write_tokens": 0,
      "total_tokens": 0,
      "avg_input_tokens": 0,
      "avg_output_tokens": 0,
      "avg_duration_ms": 0,
      "p50_duration_ms": 0,
      "p95_duration_ms": 0,
      "agent_cost_usd": 0.0,
      "avg_cost_per_run_usd": 0.0,
      "cache_savings_usd": 0.0,
      "cache_hit_rate": 0.0,
      "models_used": [],
      "last_active": "<ISO datetime>",
      "trend": {
        "run_count": "stable",
        "success_rate": "stable",
        "avg_duration_ms": "stable",
        "agent_cost_usd": "stable"
      }
    }
  }
}
```

---

## Phase 8: Store Snapshot (if --save)

Skip if `SAVE_SNAPSHOT=false`.

1. Determine filename: `<YYYY-MM-DD>-<period>.json` using today's ISO date and the `PERIOD` value.
2. Create `.claude/telemetry/` if it does not exist.
3. Write the JSON telemetry object (same schema as `FORMAT=json` output) to `.claude/telemetry/<filename>`.
4. Print: `Stored: .claude/telemetry/<filename>`

**Housekeeping:** If `.claude/telemetry/` contains more than 60 files, print:

```
Note: .claude/telemetry/ has N snapshots. Consider pruning old ones:
  ls -t .claude/telemetry/ | tail -n +61 | xargs -I{} rm .claude/telemetry/{}
```

**Gitignore advisory:** Check whether `.claude/telemetry` appears in `.gitignore`. If not:

```
Tip: Telemetry snapshots are local artifacts. Add to .gitignore:
  echo '.claude/telemetry/' >> .gitignore
```
