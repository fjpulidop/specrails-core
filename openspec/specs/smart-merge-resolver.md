# Spec: Smart Merge Conflict Resolver

The Smart Merge Conflict Resolver adds AI-powered conflict resolution to the `/sr:implement` pipeline. When the Phase 4a worktree merge produces conflict markers, instead of stopping and requiring manual intervention, the system launches a `sr-merge-resolver` agent that uses context from both features' OpenSpec artifacts to intelligently resolve each conflicting hunk. Unresolvable conflicts fall back to clean marker format for manual resolution.

A standalone `/sr:merge-resolve` command is also provided so users can invoke the resolver on any file with git conflict markers, independent of the implement pipeline.

---

## Motivation

The `/sr:implement` pipeline supports parallel multi-feature development via worktrees. When two features modify the same file, Phase 4a produces conflict markers in the output. Currently, the pipeline logs these as `requires_resolution` and asks the user to fix them manually before the reviewer can run CI.

This creates a bottleneck: the pipeline cannot proceed autonomously, and the user must understand both features' changes well enough to resolve conflicts correctly. The Smart Merge Conflict Resolver eliminates this bottleneck by:

1. Parsing conflict markers automatically
2. Using each feature's `context-bundle.md` to understand the _intent_ behind each side
3. Applying a confidence-gated resolution strategy: accept the AI resolution if confidence ≥ threshold, else keep clean conflict markers
4. Reporting every decision (auto-resolved, low-confidence, kept) in a structured table

---

## Components

### 1. `sr-merge-resolver` agent

A sub-agent launched by the `/sr:implement` orchestrator (and by `/sr:merge-resolve`) after Phase 4a conflict detection.

**Inputs (passed via prompt):**
- `CONFLICTED_FILES`: list of file paths containing conflict markers
- `CONTEXT_BUNDLES`: map of `{ feature_name -> openspec/changes/<name>/context-bundle.md path }` — may contain 1 or 2 entries
- `RESOLUTION_MODE`: `auto` (default) or `manual-fallback-only` (skip AI resolution, just clean up markers)
- `CONFIDENCE_THRESHOLD`: numeric 0–100 (default: 70) — minimum confidence to accept an AI resolution

**Outputs:**
- Resolved files written in place (conflict markers removed or replaced with clean resolution)
- `RESOLUTION_REPORT` written to `openspec/changes/<name>/merge-resolution-report.md` (one per conflict run; if multiple features, written to the first feature's directory)
- Exit line: `MERGE_RESOLUTION_STATUS: CLEAN | PARTIAL | UNRESOLVED`

**Resolution algorithm (per conflict block):**

For each `<<<<<<< ... >>>>>>> ` block in each file:

1. Extract `OURS` (content between `<<<<<<< ` and `=======`) and `THEIRS` (between `=======` and `>>>>>>> `).
2. Load context from `CONTEXT_BUNDLES` — match `OURS` feature name to the left-hand context bundle, `THEIRS` to the right-hand context bundle (by matching the label after `<<<<<<< `).
3. Read the surrounding file context (±30 lines around the conflict block) to understand the code region.
4. Produce a candidate resolution:
   - If the conflict is purely additive (no line in OURS modifies any line in THEIRS): concatenate in dependency order (THEIRS first if it adds a dependency that OURS uses; otherwise OURS first).
   - If structural (both sides modify the same lines): use context-bundle "Exact Changes" sections to determine the canonical form that satisfies both features' stated goals.
   - If ambiguous or contradictory: skip AI resolution for this block (low confidence).
5. Assign a confidence score (0–100) to the candidate:
   - `>= CONFIDENCE_THRESHOLD`: apply the resolution, log as `AUTO_RESOLVED`
   - `< CONFIDENCE_THRESHOLD`: keep conflict markers as-is (clean standard format), log as `LOW_CONFIDENCE`
6. If `RESOLUTION_MODE=manual-fallback-only`: skip steps 3–5, keep all markers as-is, log all as `MANUAL`.

**Standard conflict marker format (for kept conflicts):**

Ensure all kept markers follow this exact format (no leading whitespace, no trailing spaces on marker lines):

```
<<<<<<< <feature-name-or-label>
<OURS content>
=======
<THEIRS content>
>>>>>>> <base-label>
```

**`RESOLUTION_REPORT` format:**

```markdown
# Merge Resolution Report

**Run:** <ISO 8601 timestamp>
**Files processed:** N
**Conflicts found:** N
**Auto-resolved:** N
**Low-confidence (kept):** N
**Manual:** N

## Resolution Table

| File | Line | Block | Strategy | Confidence | Status |
|------|------|-------|----------|------------|--------|
| path/to/file.ts | 42 | "export const foo" | additive-concat | 95 | AUTO_RESOLVED |
| path/to/file.ts | 87 | "function bar()" | structural-ambiguous | 45 | LOW_CONFIDENCE |

## Kept Conflict Markers

The following conflicts require manual resolution. Search for `<<<<<<<` in each file.

| File | Line | Reason |
|------|------|--------|
| path/to/file.ts | 87 | Low confidence (45 < 70): both sides modify the same function signature with incompatible parameter changes |
```

---

### 2. `/sr:merge-resolve` command

Standalone command. Can be invoked outside the implement pipeline to resolve conflicts in any file.

**Syntax:**

```
/sr:merge-resolve [--files <glob-or-paths>] [--context <bundle-dir>] [--threshold N] [--mode auto|manual-fallback-only]
```

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--files` | glob or space-separated paths | auto-detect | Files to process. If omitted: scan entire working tree for files containing `<<<<<<<` |
| `--context` | directory path | `openspec/changes/` | Directory containing context bundles. The command scans for `*/context-bundle.md` within this directory |
| `--threshold N` | integer 0–100 | 70 | Minimum confidence to accept AI resolution |
| `--mode` | `auto` \| `manual-fallback-only` | `auto` | `auto`: attempt AI resolution; `manual-fallback-only`: only normalize marker format |

**Behavior:**

1. **Detect conflicts**: scan `--files` (or entire working tree) for files containing `<<<<<<<`. Print count of conflicted files found.
2. **Load context bundles**: glob `--context/*/context-bundle.md`. Build `CONTEXT_BUNDLES` map from directory name → bundle path.
3. **Launch `sr-merge-resolver` agent** (foreground) with `CONFLICTED_FILES`, `CONTEXT_BUNDLES`, `CONFIDENCE_THRESHOLD`, and `RESOLUTION_MODE`.
4. **Print resolution report** inline after agent completes.
5. **Exit status**: `0` if `MERGE_RESOLUTION_STATUS=CLEAN`; `1` if `PARTIAL` or `UNRESOLVED`.

---

### 3. Integration with `/sr:implement` Phase 4a

After Phase 4a's merge step, if `MERGE_REPORT.requires_resolution` is non-empty:

**Step: Invoke smart resolver**

```
[smart-merge] N file(s) have conflict markers. Launching sr-merge-resolver…
```

Build `CONTEXT_BUNDLES` from the features in `MERGE_ORDER`:

```
{ "<feature-a>": "openspec/changes/<feature-a>/context-bundle.md", "<feature-b>": "openspec/changes/<feature-b>/context-bundle.md" }
```

Launch `sr-merge-resolver` (foreground). Wait for completion.

**Post-resolution update:**

- Re-scan `requires_resolution` files for remaining `<<<<<<<` markers.
- Files with no remaining markers: move from `requires_resolution` → `auto_resolved`.
- Files still containing markers: keep in `requires_resolution`.

**Updated Phase 4a report:**

Add a `Smart Resolver` column to the merge report:

```
## Phase 4a Merge Report

### Auto-Resolved (Smart Resolver)
- path/to/file.ts (conflict at line 42: additive-concat, confidence 95)

### Still Requires Manual Resolution
- path/to/file.ts (line 87: low-confidence — see merge-resolution-report.md)
```

If all conflicts are resolved: `MERGE_REPORT.requires_resolution = []`. The reviewer in Phase 4b proceeds without the manual-resolution caveat.

---

## Confidence Threshold Configuration

The default threshold (70) can be overridden via `.claude/merge-resolver-config.json`:

```json
{
  "confidence_threshold": 70,
  "mode": "auto",
  "report_path": "openspec/changes/{feature}/merge-resolution-report.md"
}
```

If the config file is absent: use built-in defaults silently (no warning printed).

---

## Limitations

- The resolver operates on text content only. It does not execute or typecheck the resolved code — that is the reviewer's job in Phase 4b.
- Conflicts in binary files are always logged as `MANUAL` and skipped.
- Shell scripts (`.sh`, `.bash`) and lock files (`package-lock.json`, `yarn.lock`, `Gemfile.lock`) are always logged as `MANUAL` and skipped.
- If `context-bundle.md` files are missing for both features, the resolver falls back to `manual-fallback-only` mode automatically and prints: `[smart-merge] Warning: no context bundles found — falling back to marker normalization only.`

---

## Non-Goals

- The resolver does not create commits. Committing resolved files is the orchestrator's responsibility (Phase 4c).
- The resolver does not open a UI or interactive editor.
- The resolver does not replace `git mergetool` for general-purpose repo management — it is purpose-built for the OpenSpec/implement pipeline.
