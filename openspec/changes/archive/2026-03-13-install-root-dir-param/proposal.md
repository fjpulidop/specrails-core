# Proposal: --root-dir parameter for install.sh

## Problem

`install.sh` resolves `REPO_ROOT` by calling `git rev-parse --show-toplevel`, which always
returns the root of the git repository. In a monorepo where multiple projects live as
subdirectories of a single git repo, this causes specrails to install its artifacts at the
wrong level — the git root instead of the target project directory.

## Solution

Add an optional `--root-dir <path>` CLI parameter to `install.sh`. When provided, it
overrides the `git rev-parse`-derived `REPO_ROOT`. The value is validated (must exist, must
be a directory) and resolved to an absolute path before use.

Default behavior (no flag) is unchanged.

## Scope

- **File changed**: `install.sh` only.
- **No template changes**: the templates and commands installed are already relative to
  `REPO_ROOT`, so no downstream changes are needed.
- **No spec changes to existing specs**: this is additive-only.

## Non-goals

- Supporting multiple `--root-dir` values in one invocation.
- Changing what gets installed — only *where* it is installed changes.
- Validating that the path is inside the git repo (out of scope; advanced monorepos may use
  git submodules or worktrees where the project root legitimately diverges).
