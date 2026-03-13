# Technical Design: --root-dir parameter

## Current state

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
```

`REPO_ROOT` is set once at the top of the script. All subsequent file operations
(`mkdir -p "$REPO_ROOT/.claude/..."`, `cp ... "$REPO_ROOT/..."`, `cd "$REPO_ROOT"`) use
this value unchanged.

## Proposed change

### Argument parsing block

Insert an argument-parsing block immediately after the color constants and before
`print_header`. Placing it before `print_header` keeps the header out of `--help`-style
error messages but after it is also fine given the script structure — the chosen placement
is just after the `NC` color constant definition for minimal diff.

```bash
# ─────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────

CUSTOM_ROOT_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --root-dir)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --root-dir requires a path argument." >&2
                exit 1
            fi
            CUSTOM_ROOT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "Usage: install.sh [--root-dir <path>]" >&2
            exit 1
            ;;
    esac
done
```

### REPO_ROOT override

Replace the current single-line `REPO_ROOT` assignment with a block that:
1. Detects git root as before.
2. If `--root-dir` was given, validates it and overrides `REPO_ROOT`.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"

if [[ -n "$CUSTOM_ROOT_DIR" ]]; then
    # Resolve to absolute path
    REPO_ROOT="$(cd "$CUSTOM_ROOT_DIR" 2>/dev/null && pwd)" || {
        echo "Error: --root-dir path does not exist or is not accessible: $CUSTOM_ROOT_DIR" >&2
        exit 1
    }
    if [[ ! -d "$REPO_ROOT" ]]; then
        echo "Error: --root-dir path is not a directory: $CUSTOM_ROOT_DIR" >&2
        exit 1
    fi
fi
```

The `cd ... && pwd` idiom is the POSIX-safe way to resolve a path to absolute form without
requiring `realpath` (which is not available on macOS by default). The `-d` guard after the
`cd` is technically redundant but provides a clear error message if the path resolves to a
non-directory (e.g., a symlink to a file).

### Output — Phase 1 git check

The existing Phase 1 check at line 44 prints the effective `REPO_ROOT`:

```bash
ok "Git repository: $REPO_ROOT"
```

When `--root-dir` is used, this line should clarify the origin of the value. Change to:

```bash
if [[ -n "$CUSTOM_ROOT_DIR" ]]; then
    ok "Install root (--root-dir): $REPO_ROOT"
else
    ok "Git repository root: $REPO_ROOT"
fi
```

### No other changes needed

All subsequent `$REPO_ROOT` references (`mkdir`, `cp`, `cd`, `ls`) work correctly once the
variable is set to the right absolute path. No other lines need modification.

## Edge cases

| Scenario | Behavior |
|---|---|
| `--root-dir` not provided | Identical to current behavior |
| Relative path (`./apps/backend`) | Resolved to absolute via `cd && pwd` |
| Absolute path | Accepted as-is after `cd && pwd` normalization |
| Path does not exist | Error message + exit 1 before `print_header` |
| Path is a file, not a directory | Error message + exit 1 |
| Empty `--root-dir` value (`--root-dir ""`) | Caught by `-z "${2:-}"` guard |
| `--root-dir` with no argument at end of arg list | Caught by `-z "${2:-}"` guard |
| Path outside git repo | Allowed — advanced monorepo/submodule use cases |
| Unknown flags | Error + usage hint + exit 1 |

## Why not `realpath`?

`realpath` is part of GNU coreutils. On macOS it requires `brew install coreutils` or is
absent entirely. The `cd && pwd` idiom works on all POSIX systems without dependencies.

## Compatibility

The change is fully backward-compatible. No existing call site of `install.sh` is affected.
