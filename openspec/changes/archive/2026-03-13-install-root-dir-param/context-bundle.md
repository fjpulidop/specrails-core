# Context Bundle: --root-dir parameter

Self-contained implementation guide. A developer can execute this without reading any other
artifact.

---

## What to change and where

Single file: `install.sh`

Three surgical edits, described in order from top to bottom.

---

## Edit 1 — Initialize CUSTOM_ROOT_DIR and parse arguments

**Location**: after line 18 (`NC='\033[0m'`), before the `print_header` call on line 39.

Insert this block:

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

---

## Edit 2 — Override REPO_ROOT when --root-dir is provided

**Location**: after line 9 (the existing `REPO_ROOT="$(git rev-parse ...)"` line).

Replace:
```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
```

With:
```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"

if [[ -n "$CUSTOM_ROOT_DIR" ]]; then
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

Note: Edit 1 must be applied first because `CUSTOM_ROOT_DIR` must be defined before the
`REPO_ROOT` override block runs. However, since `REPO_ROOT` is set near the top of the
file (line 9) and Edit 1 is inserted after line 18, the file will need Edit 1's block to
be placed before the `print_header` call but after the color constants. The `REPO_ROOT`
override should be placed immediately after the existing `REPO_ROOT` assignment on line 9
as a second block — but since `CUSTOM_ROOT_DIR` is defined in the arg-parsing block which
comes after line 9, we need to restructure slightly.

### Correct final order in the file

```
line 1-8:   shebang, set -euo pipefail, script comment, SCRIPT_DIR
line 9:     REPO_ROOT="$(git rev-parse ...)"         ← keep as-is
lines 11-18: color constants
             ← INSERT Edit 1 here (arg parsing block, sets CUSTOM_ROOT_DIR)
             ← INSERT REPO_ROOT override block here (uses CUSTOM_ROOT_DIR)
line 39+:   print_header, Phase 1, ...
```

So in practice, both the argument parsing and the REPO_ROOT override live together after
the color constants, not after line 9. The `REPO_ROOT` initial assignment on line 9 stays
where it is and serves as the default; the override block after the arg parser conditionally
replaces it.

The working sequence is:

```bash
# line 9 — default detection
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"

# lines 11-18 — color constants (unchanged)
RED='\033[0;31m'
...
NC='\033[0m'

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

# Override REPO_ROOT if --root-dir was provided
if [[ -n "$CUSTOM_ROOT_DIR" ]]; then
    REPO_ROOT="$(cd "$CUSTOM_ROOT_DIR" 2>/dev/null && pwd)" || {
        echo "Error: --root-dir path does not exist or is not accessible: $CUSTOM_ROOT_DIR" >&2
        exit 1
    }
    if [[ ! -d "$REPO_ROOT" ]]; then
        echo "Error: --root-dir path is not a directory: $CUSTOM_ROOT_DIR" >&2
        exit 1
    fi
fi

# print_header and Phase 1 follow...
```

---

## Edit 3 — Update Phase 1 confirmation message

**Location**: current line 48.

Replace:
```bash
ok "Git repository: $REPO_ROOT"
```

With:
```bash
if [[ -n "$CUSTOM_ROOT_DIR" ]]; then
    ok "Install root (--root-dir): $REPO_ROOT"
else
    ok "Git repository root: $REPO_ROOT"
fi
```

---

## Verification checklist

Run these manually before committing (no CI exists):

```bash
# 1. shellcheck — must produce no new warnings
shellcheck install.sh

# 2. Default behavior unchanged
./install.sh

# 3. Valid relative path
./install.sh --root-dir ./openspec

# 4. Valid absolute path
./install.sh --root-dir "$(pwd)/openspec"

# 5. Non-existent path — expect: error message + exit 1
./install.sh --root-dir /tmp/does-not-exist-xyz 2>&1; echo "exit: $?"

# 6. Path is a file, not a directory — expect: error message + exit 1
./install.sh --root-dir ./install.sh 2>&1; echo "exit: $?"

# 7. --root-dir with no value — expect: error + exit 1
./install.sh --root-dir 2>&1; echo "exit: $?"

# 8. Unknown flag — expect: Unknown argument + usage + exit 1
./install.sh --foo 2>&1; echo "exit: $?"
```

---

## Key design decisions

**Why `cd && pwd` instead of `realpath`**: `realpath` is not available on macOS without
Homebrew. `cd && pwd` is POSIX-portable and has no dependencies.

**Why parse args after color constants, not at line 1**: The arg-parsing block uses `echo`
for errors (no color functions yet) which is fine. Placing it right before `print_header`
groups all setup logic together and keeps the diff minimal.

**Why allow paths outside the git repo**: Monorepos with git submodules or sparse checkouts
may legitimately have project roots that are not subdirectories of the detected git root.
Restricting to inside the git root would break these cases with no benefit.
