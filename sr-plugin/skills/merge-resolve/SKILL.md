---
name: merge-resolve
description: "Resolve git merge conflicts using AI-powered context analysis and OpenSpec context bundles."
license: MIT
compatibility: "Requires git."
metadata:
  author: specrails
  version: "1.0"
---

# Smart Merge Conflict Resolver

Resolves git conflict markers in working tree files using AI-powered context analysis. For each conflict block, reads OpenSpec context bundles from the features that produced the conflict, infers the correct resolution, and writes it in place — or preserves clean markers for conflicts it cannot safely resolve.

**IMPORTANT: Always follow this procedure exactly as written. Launch the sr-merge-resolver agent as specified. Do NOT attempt to resolve conflicts yourself in the main conversation.**

**Input:** `$ARGUMENTS` — flags controlling which files to process, where to find context, and resolution behavior.

---

## Step 1: Parse flags

Scan `$ARGUMENTS` for the following flags:

### `--files <paths>`

**Type:** space-separated file paths or glob patterns
**Default:** auto-detect (scan working tree)

Explicit list of files to process. If a path contains `*` or `?`, treat it as a glob and expand it. Strip this flag and its value from `$ARGUMENTS` before further processing.

### `--context <directory>`

**Type:** directory path
**Default:** `openspec/changes/`

Directory to scan for context bundles. The command globs `<directory>/*/context-bundle.md`. Strip this flag and its value from `$ARGUMENTS` before further processing.

### `--threshold N`

**Type:** integer 0–100
**Default:** 70

Minimum confidence score for the resolver to apply an AI resolution. Below this threshold, the resolver preserves conflict markers in normalized format. Strip this flag and its value from `$ARGUMENTS` before further processing.

### `--mode auto|manual-fallback-only`

**Type:** enum
**Default:** `auto`

- `auto`: attempt AI resolution for each conflict block
- `manual-fallback-only`: only normalize conflict marker format; do not attempt AI resolution

Strip this flag and its value from `$ARGUMENTS` before further processing.

After parsing, if any unrecognized flags remain in `$ARGUMENTS`: print a warning:
```
[merge-resolve] Warning: unrecognized flags ignored: <remaining>
```

---

## Step 2: Detect conflicted files

### If `--files` was provided:

For each path (or expanded glob): check that the file exists. If a path does not exist: print `[merge-resolve] Warning: <path> not found — skipped.` and remove it from the list.

Filter to only files containing `<<<<<<<`. For any file in the provided list that does NOT contain `<<<<<<<`: print `[merge-resolve] <path>: no conflict markers found — skipped.`

### If `--files` was NOT provided:

Scan the entire working tree for files containing `<<<<<<<`:

```bash
grep -rl "<<<<<<< " . --include="*" 2>/dev/null
```

Exclude `.git/` directory from results.

If no conflicted files are found (either from explicit list or auto-detect):

```
[merge-resolve] No conflict markers found in the working tree.
Nothing to do.
```

Exit cleanly.

Otherwise, print:
```
[merge-resolve] Found N conflicted file(s):
  - path/to/file.ts
  - path/to/other.md
```

---

## Step 3: Load context bundles

Glob `<context-directory>/*/context-bundle.md`.

Build `CONTEXT_BUNDLES` map: for each matched path, the key is the subdirectory name (the feature name), the value is the file path.

Example:
```
openspec/changes/feature-a/context-bundle.md  →  { "feature-a": "openspec/changes/feature-a/context-bundle.md" }
openspec/changes/feature-b/context-bundle.md  →  { "feature-b": "openspec/changes/feature-b/context-bundle.md" }
```

If no context bundles are found:
```
[merge-resolve] No context bundles found at <context-directory>.
The resolver will use structural analysis only (no feature-intent context).
```

Set `CONTEXT_BUNDLES = {}`.

---

## Step 4: Launch sr-merge-resolver agent

Construct the agent prompt with:

- `CONFLICTED_FILES`: the list of conflicted file paths
- `CONTEXT_BUNDLES`: the map built in Step 3
- `CONFIDENCE_THRESHOLD`: the `--threshold` value (default 70)
- `RESOLUTION_MODE`: the `--mode` value (default `auto`)
- `REPORT_PATH`: `openspec/changes/<first-feature>/merge-resolution-report.md` if CONTEXT_BUNDLES has entries; otherwise `merge-resolution-report.md` in the working directory root

Launch the **sr-merge-resolver** agent (`subagent_type: sr:merge-resolver`, foreground, `run_in_background: false`). Wait for it to complete.

Read the final `MERGE_RESOLUTION_STATUS` line from the agent's output.

---

## Step 5: Print summary

After the agent completes, print:

```
## Merge Resolution Complete

| Metric | Count |
|--------|-------|
| Files processed | N |
| Conflicts found | N |
| Auto-resolved | N |
| Low-confidence (kept) | N |
| Skipped | N |

Resolution report: <REPORT_PATH>
```

If `MERGE_RESOLUTION_STATUS = PARTIAL` or `UNRESOLVED`:

```
## Remaining Conflicts

The following files still contain conflict markers that require manual resolution:

  - path/to/file.ts (N block(s))

Search for `<<<<<<<` in each file to locate the markers.
Run `/specrails:merge-resolve` again after addressing the low-confidence conflicts,
or resolve them manually and commit.
```

If `MERGE_RESOLUTION_STATUS = CLEAN`:

```
All conflict markers resolved. Working tree is clean.
You can now stage and commit the resolved files.
```

---

## Error Handling

- If the agent fails or times out: print `[merge-resolve] Error: sr-merge-resolver did not complete. Files may be partially modified — check for remaining conflict markers before committing.` Exit with a non-zero status.
- If a file becomes unreadable mid-run (e.g. deleted): log `[merge-resolve] Warning: <path> disappeared during processing — skipped.`
- Never abort silently. Always print a final status.
