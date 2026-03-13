# Tasks: --root-dir parameter

## T1 [core] Add argument-parsing block to install.sh

**File**: `install.sh`

**Description**: Insert a `while [[ $# -gt 0 ]]` argument-parsing loop immediately after
the color constant definitions (after line 18, before `print_header`). The loop handles
`--root-dir <path>` and rejects unknown arguments with a usage hint.

**Acceptance criteria**:
- `--root-dir ./some/path` sets `CUSTOM_ROOT_DIR="./some/path"`
- `--root-dir` with no following argument prints an error to stderr and exits 1
- An unrecognized flag prints `Unknown argument: <flag>` and the usage line to stderr, exits 1
- No argument at all: loop body never executes, `CUSTOM_ROOT_DIR` remains `""`

**Dependencies**: none

---

## T2 [core] Override REPO_ROOT when --root-dir is provided

**File**: `install.sh`

**Description**: After the existing `REPO_ROOT="$(git rev-parse ...)"` line (line 9), add
a conditional block that — when `CUSTOM_ROOT_DIR` is non-empty — resolves the given path
to absolute form using `cd "$CUSTOM_ROOT_DIR" && pwd` and assigns the result to `REPO_ROOT`.
Exit 1 with a descriptive error if the path is unresolvable or not a directory.

**Acceptance criteria**:
- Relative path `./apps/backend` is resolved to its absolute form
- Absolute path is accepted and normalized
- Non-existent path exits 1 with message referencing the original value
- Non-directory path exits 1 with message referencing the original value
- When `CUSTOM_ROOT_DIR` is empty, this block is a no-op

**Dependencies**: T1 (CUSTOM_ROOT_DIR variable must exist)

---

## T3 [core] Update Phase 1 confirmation message

**File**: `install.sh`

**Description**: Replace the single `ok "Git repository: $REPO_ROOT"` line (line 48) with
a conditional that prints `Install root (--root-dir): $REPO_ROOT` when `--root-dir` was
used, and `Git repository root: $REPO_ROOT` otherwise.

**Acceptance criteria**:
- Default invocation prints `Git repository root: <path>`
- `--root-dir` invocation prints `Install root (--root-dir): <path>`

**Dependencies**: T1, T2

---

## T4 [core] Manual verification

**File**: `install.sh`

**Description**: Manually test the following scenarios since there is no CI yet.

Test matrix:
1. `./install.sh` — default behavior unchanged, installs at git root
2. `./install.sh --root-dir ./openspec` — valid relative path, installs into `openspec/`
3. `./install.sh --root-dir /tmp/nonexistent` — exits 1 with path error
4. `./install.sh --root-dir install.sh` — exits 1 with "not a directory" error
5. `./install.sh --root-dir` (no value) — exits 1 with "requires a path argument" error
6. `./install.sh --unknown-flag` — exits 1 with "Unknown argument" error
7. `shellcheck install.sh` — no new warnings

**Acceptance criteria**: All 7 test cases behave as described. `shellcheck` passes clean.

**Dependencies**: T1, T2, T3
