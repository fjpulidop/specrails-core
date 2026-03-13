# Spec: /implement Command

The `/implement` command runs the full OpenSpec pipeline: product-manager explores, architect designs, developer implements, reviewer validates, and the result is shipped via git. This spec documents the command's flags, cache structure, and behavior matrix.

---

## Flags

### `--dry-run` / `--preview`

Activates preview mode. All pipeline phases run as normal, except:

- Developer file output is redirected to `.claude/.dry-run/<feature-name>/` instead of real paths.
- Phase 4a (merge) writes to the cache directory instead of the main repo.
- Phase 4b (reviewer) reads from and writes to the cache directory.
- Phase 4c (git, PR creation, backlog updates) is entirely skipped.
- Phase 4e displays the Dry-Run Preview Report instead of the standard pipeline table.

Both flags are equivalent aliases. Neither modifies git state, creates branches, pushes commits, opens PRs, or comments on backlog issues.

### `--apply <feature-name>`

Applies a previously cached dry-run to the real repo and then runs Phase 4c (git + backlog).

Behavior:
1. Reads `.cache-manifest.json` from `.claude/.dry-run/<feature-name>/`.
2. Copies each `cached_path` to its `real_path`, creating parent directories as needed.
3. Runs Phase 4c (branch creation, commits, push, PR, backlog updates) against the real files.
4. On success: deletes the cache directory and prints `[apply] Cache cleaned up.`
5. On failure: preserves the cache directory for re-run.

Skips Phases 1 through 4b entirely — the cached artifacts from the prior dry-run are used directly.

If no cache exists at `.claude/.dry-run/<feature-name>/`, the command stops with:
```
[apply] Error: no cached dry-run found at .claude/.dry-run/<feature-name>/
```

---

## Behavior Matrix

| Flag | Phases Run | Git ops | PR | Backlog | Output |
|------|-----------|---------|----|---------|---------:|
| (none) | All | Yes | Yes (if GH_AVAILABLE) | Yes (if BACKLOG_WRITE) | Standard pipeline table |
| `--dry-run` | All | No | No | No | Dry-Run Preview Report |
| `--preview` | All | No | No | No | Dry-Run Preview Report |
| `--apply <name>` | 4c only | Yes | Yes (if GH_AVAILABLE) | Yes (if BACKLOG_WRITE) | Standard pipeline table |

---

## Cache Directory Structure

```
.claude/.dry-run/<feature-name>/
├── .cache-manifest.json        # Manifest tracking all cached files and skipped operations
└── <mirrored file paths>       # Developer output files at mirrored real paths
    └── src/
        └── utils/
            └── parser.ts       # Example: mirrors real path src/utils/parser.ts
```

The cache directory is excluded from git via `.gitignore` (`.claude/.dry-run/`).

---

## `.cache-manifest.json` Schema

```json
{
  "feature": "<feature-name>",
  "created_at": "<ISO 8601 timestamp>",
  "dry_run": true,
  "files": [
    {
      "cached_path": ".claude/.dry-run/<feature-name>/src/utils/parser.ts",
      "real_path": "src/utils/parser.ts",
      "operation": "create | modify"
    }
  ],
  "openspec_changes": "<feature-name>",
  "skipped_operations": [
    "git: branch creation (feat/<feature-name>)",
    "git: commit",
    "git: push",
    "github: pr creation",
    "github: issue comment #N"
  ]
}
```

### Field descriptions

| Field | Type | Description |
|-------|------|-------------|
| `feature` | string | Kebab-case feature name, matches directory name |
| `created_at` | string | ISO 8601 timestamp of dry-run execution |
| `dry_run` | boolean | Always `true` in cache manifests |
| `files` | array | List of all files written by the developer agent |
| `files[].cached_path` | string | Path where the file was written (under `.dry-run/`) |
| `files[].real_path` | string | Path where the file would go in the real repo |
| `files[].operation` | string | `"create"` for new files, `"modify"` for existing files |
| `openspec_changes` | string | OpenSpec change name, matches `openspec/changes/<name>/` |
| `skipped_operations` | array | List of git/GitHub/backlog operations that were skipped |

---

## Variable Reference

Variables set during flag detection (Phase 0):

| Variable | Type | Set when | Description |
|----------|------|----------|-------------|
| `DRY_RUN` | boolean | `--dry-run` or `--preview` present | Activates preview mode |
| `APPLY_MODE` | boolean | `--apply` present | Activates apply-from-cache mode |
| `APPLY_TARGET` | string | `APPLY_MODE=true` | Feature name argument following `--apply` |
| `CACHE_DIR` | string | Either flag present | Absolute or relative path to the cache directory |

`CACHE_DIR` for `--dry-run` is finalized after the feature name is derived from the remaining input. All phases from 3a onward can reference it.

---

## Edge Cases

- **Stale cache on re-run**: Running `--dry-run` twice with the same feature name overwrites the prior cache. A warning is printed: `[dry-run] Overwriting existing cache at CACHE_DIR`.
- **CI gap in dry-run**: The reviewer runs CI against the real repo (developer changes not yet applied). CI results may not reflect the final state. The reviewer prompt explicitly notes this caveat.
- **Developer path discipline**: Dry-run correctness depends on the developer agent writing to the cache path. The developer prompt includes an explicit prohibition: "Do NOT write to real file paths."
- **Apply after failure**: If `--apply` fails during Phase 4c, the cache is preserved so the user can retry without re-running the full pipeline.
