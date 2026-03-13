# Delta Spec: --root-dir parameter

## Affected spec area

`install.sh` CLI interface — no existing formal spec file covers this. This delta is
self-contained.

## New behavior specification

### CLI interface

```
install.sh [--root-dir <path>]
```

| Parameter | Type | Required | Default |
|---|---|---|---|
| `--root-dir` | path (relative or absolute) | No | git repo root |

### Validation rules

1. If `--root-dir` is given, the value must be a non-empty string.
2. The path must be resolvable (exist and be accessible).
3. The resolved path must be a directory.
4. Any other unrecognized argument causes an error with a usage hint.

### Error messages

| Condition | Message | Exit code |
|---|---|---|
| `--root-dir` given with no value | `Error: --root-dir requires a path argument.` | 1 |
| Path does not exist | `Error: --root-dir path does not exist or is not accessible: <value>` | 1 |
| Path is not a directory | `Error: --root-dir path is not a directory: <value>` | 1 |
| Unknown argument | `Unknown argument: <value>\nUsage: install.sh [--root-dir <path>]` | 1 |

### Output change

Phase 1 confirmation line changes based on source of root:

- Default: `Git repository root: <path>`
- Override: `Install root (--root-dir): <path>`

### Invariants preserved

- `REPO_ROOT` is always an absolute path when the script proceeds.
- Default behavior (no `--root-dir`) is byte-for-byte equivalent to the current script.
- The git repository check (empty `REPO_ROOT` guard) still runs before any file operations.
