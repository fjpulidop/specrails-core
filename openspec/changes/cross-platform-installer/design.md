## Context

The current installer is a two-layer stack: `bin/specrails-core.js` (CommonJS, ~260 LOC) is a thin dispatcher that `spawnSync("bash", ...)` the appropriate script, and `install.sh` / `update.sh` / `bin/doctor.sh` / `bin/perf-check.sh` carry the real logic (~2,250 LOC of bash with embedded `python3 -c "…"` heredocs for JSON munging and `jq` pipelines for YAML reshaping). This design worked fine for macOS + Linux and kept dependencies at zero, but it hard-blocks Windows where `bash`, `python3`, and `jq` are not part of the base system.

The `bin/tui-installer.mjs` is already ESM Node and cross-platform-friendly; it's called from `install.sh` for the full-tier TUI flow and does its own prerequisite detection. That file is a useful proof that the project can ship meaningful installer logic in pure Node — this change generalises that pattern to the whole surface.

Consumers to keep working:
- `npx specrails-core init [flags]` — default entry, scaffolds a new install
- `npx specrails-core update [flags]` — preserves user state, re-runs template layer
- `npx specrails-core doctor` — diagnostics on an existing install
- `npx specrails-core perf-check` — micro-benchmark (21 LOC, trivial)
- specrails-hub's `spawnCoreInit` — spawns `npx … specrails-core init`; its contract is the exit code + stdout/stderr stream, both preserved verbatim

## Goals / Non-Goals

**Goals:**
- Every specrails-core subcommand runs identically on macOS, Linux, and Windows (x64 + ARM64 via Node emulation).
- Zero dependency on `bash`, `python3`, `jq`, or GNU-specific tool flags.
- Exit codes, stdout/stderr format (including colored prefixes and step headers), and persisted artefacts (`.specrails/install-config.yaml`, `specrails-version`, `specrails-manifest.json`) stay byte-compatible with the current bash implementation so specrails-hub and downstream tests see no change.
- The reserved-paths contract (`.specrails/profiles/**`, `.claude/agents/custom-*.md` never touched) is preserved and covered by a vitest spec.
- CI runs the installer end-to-end on a fresh repo on all three OSes.

**Non-Goals:**
- UX redesign: no new prompts, no new flags beyond flag parity.
- Rewriting user-facing content in `commands/*.md` or `templates/**` — those ship unchanged.
- Replacing specrails-hub's own bash invocation (hub already Node-spawns `specrails-core`; no hub changes beyond benefitting from this port).
- Migrating the doctor command's content (diagnostics it emits) — only the delivery mechanism changes.

## Decisions

### Decision 1: TypeScript as implementation language

**Choice:** Rewrite installer modules in TypeScript (`src/installer/**/*.ts`), compile to ESM JavaScript published under `dist/installer/**` via `tsc`. `package.json` `bin` entry points to `dist/installer/cli.js`.

**Rationale:** ~1,500 LOC of complex filesystem + git + provider-detection logic is where typed interfaces pay for themselves. The project already runs TypeScript elsewhere in the ecosystem (specrails-hub is full TS; specrails-web is TS). Having two languages in one repo for the sake of a build-step-less `bin/` is not the right trade-off at this size. `tsc --noEmit` in CI catches regressions before they ship.

**Alternatives considered:**
- ESM JavaScript with JSDoc type annotations + `tsc --checkJs` — rejected: lower ergonomics, IDE support spotty on JSDoc generics, maintainability regresses as code grows.
- CommonJS JavaScript (match current `bin/specrails-core.js`) — rejected: ESM is the modern default; the existing `tui-installer.mjs` is already ESM, CJS would fight Node's module resolution rules and force `require()` wrapping of every dep.

**Implications:** `prepack` script compiles TS → JS. `package.json` `files` whitelist includes `dist/installer/**` and excludes `src/**`. Published tarball stays runnable with `node dist/installer/cli.js` — no runtime TS.

### Decision 2: Module layout

```
src/installer/
  cli.ts                          # bin entry: arg parsing, dispatch, exit code bridge
  commands/
    init.ts                       # npx specrails-core init
    update.ts                     # npx specrails-core update
    doctor.ts                     # npx specrails-core doctor
    perf-check.ts                 # npx specrails-core perf-check
  phases/                         # init pipeline, reusable by update where applicable
    prereqs.ts                    # git / provider / npm / openspec / gh / jira / jq replacement
    provider-detect.ts            # Claude Code vs Codex detection, env resolution
    scaffold.ts                   # .specrails/, .claude/, agents, commands, templates
    manifest.ts                   # specrails-manifest.json generation + hashing
    install-config.ts             # .specrails/install-config.yaml read/merge/write
  util/
    fs.ts                         # mkdirp, copyDir, copyFile, ensureLf
    git.ts                        # init, add, commit, isRepo, rootDir, ensureBranch
    logger.ts                     # ok/warn/fail/info/step (coloured, matches current prefixes)
    prompts.ts                    # interactive prompts (text / confirm / select) with non-TTY skip
    paths.ts                      # reserved paths, platform-safe path ops, normaliseToPosix
    exec.ts                       # cross-platform spawn wrapper (handles .cmd/.bat on Windows)
    errors.ts                     # PrerequisiteError, FilesystemError, GitError, ProviderError
  __tests__/                      # vitest specs co-located per module under each dir's *.test.ts
```

**Rationale:** `commands/` matches CLI surface 1:1 so adding a subcommand means adding a file. `phases/` isolates reusable init steps that `update` partially reuses. `util/` is ruthlessly generic — nothing in `util/` may import from `commands/` or `phases/`. This DAG prevents cycles and keeps unit tests small.

### Decision 3: Runtime dependencies (relax "zero deps")

**Choice:** Add a deliberately short list of runtime deps:

- `js-yaml` — YAML parse/write for `install-config.yaml`. ~15 KB unpacked, de-facto standard, maintained by nodeca.
- `@inquirer/prompts` — interactive prompts (text, confirm, select). Replaces `read -p` in bash. Breaks up into tree-shakeable per-prompt imports.
- `picocolors` — ANSI colour output. ~1 KB, chosen over `chalk` (30 KB) because we only need the four colours (green/yellow/red/blue) already used by the bash `ok/warn/fail/info` helpers.

Devdeps: `typescript`, `vitest`, `@types/node`, `@types/js-yaml`.

**Rationale:** Writing a YAML parser or TTY prompt library in-house is not a good use of engineering time and introduces bugs we'd own forever. The three runtime deps chosen are single-purpose, small, popular (all >10M weekly downloads), and have been stable for years.

**Alternatives considered:**
- Keep zero runtime deps and hand-roll YAML + prompts — rejected: effort + bug surface outweighs the dep savings.
- `prompts` (2M downloads/wk) instead of `@inquirer/prompts` — reasonable alternative, but `@inquirer/prompts` has better TypeScript support and modular per-prompt imports.
- `chalk` instead of `picocolors` — rejected on install size; we don't need `chalk`'s level detection or nested styles.

**Constraint updated in `npm-distribution` spec:** the "zero runtime dependencies" requirement relaxes to "runtime dependencies SHALL be limited to a vetted allowlist and the total unpacked dep footprint SHALL not exceed 200 KB."

### Decision 4: Template rendering

**Choice:** Simple `${VAR}` substitution + conditional block support via a tiny in-house renderer (~50 LOC, tested). No external templating engine (mustache, handlebars).

**Rationale:** The current heredocs are either pure copies of static text or use variable interpolation for `${PROJECT_NAME}`-style tokens. A 50-LOC renderer covers every case we observed in `install.sh`. Bringing in mustache (~20 KB) for this is overkill and leaks another dep.

**Format:**
```
Token interpolation:   ${VAR_NAME}
Conditional block:     {{#if PROVIDER_CLAUDE}}...{{/if}}
```

### Decision 5: Git operations — shell out, don't package

**Choice:** Wrap `git` binary via `child_process.spawn` in `util/git.ts`. Do NOT add `simple-git` as a dep.

**Rationale:** `git` is already a prerequisite (the installer refuses to run without a git repo). Shelling out costs a process-fork but keeps the dep tree clean. `simple-git` is 100+ KB and wraps the same shell-out we'd do ourselves. Our git surface is small: `init`, `add`, `commit`, `rev-parse --show-toplevel`, `status --porcelain` — six commands total.

### Decision 6: Interactive prompts respect non-TTY and headless flags

**Choice:** Every prompt checks `process.stdin.isTTY`. If non-TTY, the prompt throws a typed `PromptAbortError` unless a CLI flag provides the value explicitly. The `--yes` flag accepts all defaults non-interactively (parity with current bash `SPECRAILS_SKIP_PREREQS=1` pattern).

**Rationale:** specrails-hub pipes stdin and cannot respond to interactive prompts; the current bash path handles this with `--from-config` produced by the hub's TUI. The Node installer preserves that contract: hub writes `install-config.yaml` first, then runs `init --from-config`, which skips prompts.

### Decision 7: Line-ending hygiene via `.gitattributes`

**Choice:** Add a repo-root `.gitattributes` that marks all text types as `text eol=lf`. This prevents Windows `core.autocrlf=true` from injecting `\r` into published `.ts` sources, template files, or `.json` artefacts.

**Rationale:** Even after porting to Node, template files under `templates/**` must be written with LF on user repos (users frequently run hub projects through Docker/Linux CI and CR bytes corrupt those pipelines). Enforcing LF at the source silences a class of platform-specific bugs forever.

### Decision 8: Cross-platform `spawn` wrapper

**Choice:** `util/exec.ts` exports `runCommand(cmd, args, opts)` that:

- Sets `shell: true` on `process.platform === 'win32'` (CVE-2024-27980 requirement for `.cmd`/`.bat` shims like `claude.cmd`, `npm.cmd`).
- Sets `shell: false` on POSIX (keeps argv boundaries clean, no shell injection surface).
- Throws a typed `ExecError` on non-zero exit with captured stdout/stderr — consumers can catch and decide whether to surface to the user or recover.
- Streams stdio by default so long-running commands (like `npx create-claude-code-project`) show progress.

**Rationale:** Every Windows-related child-process bug in the hub that just shipped traces back to not having this wrapper. Centralising the spawn boilerplate means platform quirks are fixed once.

### Decision 9: CI matrix

**Choice:** Expand `.github/workflows/ci.yml` to a matrix of `[macos-latest, ubuntu-latest, windows-latest]` × `[node-20, node-22]`. The vitest suite runs on every combination.

**Rationale:** Windows is the whole reason this change exists; Linux sneaks in for free and catches containerised deployment regressions. Node 20 (current LTS) + Node 22 (next LTS) covers the supported range per `package.json#engines`.

### Decision 10: Phased delivery with in-place coexistence

**Choice:** Phases proceed additively — the Node installer ships alongside the shell scripts, and `bin/specrails-core.js` keeps shelling out until the Node path is proven. Only the final phase deletes the shell scripts.

**Rationale:** We ship fewer broken increments. Each phase is shippable: if Phase 2 lands and Phase 3 regresses, we revert Phase 3 without losing Phase 2's work. The last phase is a controlled "delete + pivot dispatch" in one commit.

Phase map:

| Phase | Output | Risk |
|-------|--------|------|
| 1 | `util/**`, `cli.ts` skeleton, TS build pipeline, CI matrix, `.gitattributes`. Dispatcher still shells out to bash. | Low (infra only) |
| 2 | `commands/init.ts` + `phases/**` full port. `init` handled by Node; `update` still bash. | High (bulk of logic) |
| 3 | `commands/update.ts` port. Shared phase modules reused. | Medium |
| 4 | `commands/doctor.ts` + `commands/perf-check.ts` ports. | Low (small surface) |
| 5 | Delete `install.sh`, `update.sh`, `bin/doctor.sh`, `bin/perf-check.sh`. Dispatcher simplified to direct Node import. | Low — deletion only, logic already proven |
| 6 | Vitest ports for `tests/test-profiles.sh` and any surviving shell tests; CI gate flips to require vitest green. | Low |

## Risks / Trade-offs

- **Template-render edge cases we don't know about yet** → Mitigation: diff the Node-generated artefacts against bash-generated artefacts in CI using a deterministic-repo fixture. Any byte delta fails the build.
- **`git` CLI output format drift across git versions** → Mitigation: only parse `--porcelain` and `rev-parse` outputs, which are stable. Pin behaviour to git ≥ 2.25 (ships with macOS 10.15+; same as current bash implicit requirement).
- **Prompts UX regression** vs current coloured bash prompts → Mitigation: `@inquirer/prompts` output is well-reviewed; `logger.ts` keeps the same emoji prefixes (`✓ ⚠ ✗ →`) for consistency with historical stdout captured by users in bug reports.
- **Published package size grows** from compiled TS + deps → Mitigation: tree-shake `@inquirer/prompts` to only imported prompt types; `files` whitelist stays strict. Target: published tarball ≤ 500 KB (current is ~300 KB).
- **Contributor ergonomics — mandatory build step** → Mitigation: `npm run dev` runs `tsc --watch` in the background; `npm test` auto-builds first. README gets a short "contributing" section.
- **specrails-hub might break if stdout format changes** → Mitigation: the hub only reads exit codes and passes stdout to the user via the setup wizard log. Any cosmetic stdout change is user-visible but not hub-breaking. Sanity-check the hub's wizard test fixtures.
- **Phase 5 deletion in one commit** could leave a bad bisect window → Mitigation: Phase 5 lands on a green CI matrix, only after Phases 2–4 have been dogfooded against a real `npx specrails-core init` run on all three OSes.

## Migration Plan

1. Merge Phase 1 to `main` (infra-only, no user-visible change). Verify CI matrix green on all three OSes.
2. Phases 2–4 land incrementally over subsequent PRs on the same branch or via stacked PRs (author's choice). Each PR gated on the full CI matrix + the byte-diff fixture check.
3. Once all four command ports land and the byte-diff fixture produces identical output to the bash reference, open the Phase 5 PR that deletes the shell scripts. This PR MUST include a canary: a fresh `macos-14`, `ubuntu-22`, and `windows-11` VM (or CI ephemeral runner) running `npx specrails-core init` on a scratch repo to completion.
4. Release via release-please's normal flow. The next `feat(installer): port to node` commit triggers a minor bump.
5. specrails-hub consumes the new version via `npx specrails-core@latest init` (already the hub's invocation). No hub release needed for the happy path; the hub's Windows build gains setup-wizard support the moment the specrails-core minor ships.

**Rollback:** if a serious regression surfaces post-release, `npm deprecate` the affected version and revert the Phase 5 commit — the shell scripts are still in git history and the prior dispatcher is a 15-line revert away. specrails-hub users pinned to the previous core version are unaffected.

## Open Questions

- **Template fixture format** for the byte-diff CI check: the bash-generated artefacts differ across providers (Claude vs Codex) and install tiers (quick vs full). How many fixtures do we need? Proposal: one fixture per (provider, tier) combination = 4 fixtures; regenerate fixtures via a CI job that runs the bash scripts on a Linux runner and pushes the result as an artefact.
- **`--dry-run` flag** — worth adding? Current bash has none, but it's cheap to add once modules exist. Decision deferred to post-Phase-1.
- **Should `perf-check` stay as a separate subcommand** or move inside `doctor`? It's 21 lines of bash. Could be `doctor --perf`. Out-of-scope nitpick; preserving the current surface keeps this PR small.
- **Python3 heredoc replacement** — `install.sh` has `python3 -c "import json, sys; …"` blocks for JSON reshaping. Node's built-in `JSON.parse`/`JSON.stringify` covers 100% of these cases trivially.
- **Slash-command scripts in `commands/*.md`** — those files are published to user projects and contain bash snippets (`!`-prefix executions). They are out of scope for this change and will need a separate Windows-compatibility pass. Flag this explicitly in the Phase 5 PR so users know the limit of Windows support.
