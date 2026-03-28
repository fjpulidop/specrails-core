---
name: common-fixes
description: Recurring CI failure patterns and their fixes found during code reviews
type: project
---

# Common Fixes

## Placeholder grep false positives

**Pattern:** `grep -r '{{[A-Z_]*}}' .claude/agents/` flags existing agent files (reviewer.md, architect.md, developer.md, rules/templates.md) that contain `{{PLACEHOLDER}}` in documentation prose — not as unresolved substitutions.

**Why:** These files use the `{{...}}` notation to document the convention itself ("use `{{UPPER_SNAKE_CASE}}` for placeholders"). They are not broken.

**How to apply:** When the placeholder check flags hits in existing (non-newly-generated) files, confirm the match is in a documentation context (backtick-quoted or descriptive sentence) rather than a bare value. Only flag bare `{{WORD}}` usages outside of documentation/example prose.

---

## Template vs instance placeholder count

**Pattern:** Template agent files should contain exactly the documented placeholders (e.g., `{{TECH_EXPERTISE}}`, `{{LAYER_CLAUDE_MD_PATHS}}`, `{{MEMORY_PATH}}`). The generated instance must contain zero `{{...}}` strings.

**Verification command:**
```bash
grep -c '{{' templates/agents/<name>.md   # should equal expected count
grep -c '{{' .claude/agents/<name>.md     # must be 0
```

---

## shellcheck not installed

**Pattern:** `shellcheck` is not in PATH on this machine. The check exits with "command not found" but is treated as non-fatal (`|| true`).

**How to apply:** Until shellcheck is installed, the shell validation check is advisory only. Manual review of `set -euo pipefail`, quoted variables, and `local` usage in shell scripts is required.

---

## Multi-file grep false positive — template vs instance

**Pattern:** When running `grep -n '{{[A-Z_]*}}'` across both template and instance directories in a single search, a hit in a template file (e.g., `templates/commands/auto-propose-backlog-specs.md`) can be mistakenly attributed to the adjacent instance file (`.claude/commands/auto-propose-backlog-specs.md`).

**Why:** The grep output shows the matching file path, but when mentally scanning multi-file results, it's easy to misread which file owns a given hit.

**How to apply:** Always run the placeholder check on the instance file in isolation:
```bash
grep -r '{{[A-Z_]*}}' .claude/commands/auto-propose-backlog-specs.md || echo "OK"
```
Never combine template and instance paths in a single grep for placeholder-clean assertions.

---

## Generated files not auto-synced with templates

**Pattern:** When a template is modified (e.g., `templates/agents/reviewer.md`, `templates/commands/implement.md`), the generated counterparts in `.claude/agents/` and `.claude/commands/` are NOT automatically updated. They only update on `/setup` re-run.

**Why:** specrails uses template substitution at `/setup` time, not continuously. Template edits must be manually propagated to the generated files in `.claude/` until a hot-reload mechanism exists.

**How to apply:** After any template change, always check whether the corresponding `.claude/` instance file needs the same edit applied. Read both files and apply the diff manually. This is standard reviewer responsibility for issues where the developer edited templates but not generated files.

---

## Template-instance wording drift

**Pattern:** When the same semantic point is expressed in two places within a template (e.g., Phase 6 instruction text and Output Format section), the two can drift to slightly different wording over time. During review, diff the template against the instance (to confirm placeholder substitution) AND compare each occurrence of the same concept within the template for consistency.

**Example found:** `templates/agents/architect.md` Phase 6 point 4 said "a Migration Guide" while the Output Format section said "a Migration Guide per change". The instance had already been written with the more precise wording, revealing the template inconsistency.

**How to apply:** When a diff shows a template-to-instance divergence in prose (not in placeholder substitution), first check whether the instance text is MORE correct (matches the spec) — and if so, fix the template to match the instance.

---

## API response field name mismatch between server and client (mock-masked bug)

**Pattern:** A server returns `{ jobId }` from an endpoint, but the client parses `{ processId }`. The unit test uses a hand-rolled mock that returns `{ processId }` to match the client's _expectation_, so all tests pass but the production integration is broken.

**Root cause (2026-03-15):** `/api/spawn` in `server/index.ts` returns `{ jobId, position }`. `cli/srm.ts` parsed `{ processId }` — undefined in production. Log filtering silently passed no lines, and `/api/jobs/undefined` returned 404.

**How to detect:** When reviewing CLI/client code that calls internal API endpoints, always cross-reference the exact field names used in both the server response (`res.json(...)`) and the client parse (`JSON.parse(...) as { field }`). The mock in tests should mirror the real server response exactly — if the mock returns different field names than the server, it is hiding an API contract bug.

**Fix pattern:** Accept both `jobId` and legacy `processId` during the transition, then remove the fallback once all callers are updated.

---

## find -name '*[A-Z]*' on macOS matches lowercase .md extensions

**Pattern:** On macOS with certain locale settings, `find -name '*[A-Z]*'` matches filenames like `reviewer.md` because the character range `[A-Z]` can match lowercase letters or punctuation under the default locale.

**Why:** macOS `find` uses locale-sensitive collation for character ranges. `[A-Z]` in some locales covers more than A–Z.

**How to apply:** File naming check results should be validated by inspecting the actual basenames. If all returned filenames are lowercase kebab-case, the check passes. Alternatively, use `grep -P '[A-Z]'` or `LC_ALL=C find` for strict ASCII range matching.

---

## Vitest spy variable typing — use `any` with eslint-disable

**Pattern:** `let spy: ReturnType<typeof vi.spyOn>` causes TS2322 in strict mode because `ReturnType<typeof vi.spyOn>` resolves to a loose base type that is incompatible with concrete `vi.spyOn(fs, 'existsSync')` results. Using `vi.spyOn<typeof fs, 'existsSync'>` fails with TS2344.

**Established pattern in this codebase:** Declare spy variables as `any` with an eslint-disable comment:
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let existsSyncSpy: any
```

**Why:** This is the accepted trade-off in the project. The 3 pre-existing errors in `config.test.ts` use the broken `ReturnType<typeof vi.spyOn>` pattern — new test files should use `any` instead to avoid adding new TS errors.

**How to apply:** Whenever writing Vitest tests that spy on `fs` (or other overloaded Node.js APIs), type the spy variables as `any`. Do NOT use `ReturnType<typeof vi.spyOn>` — it introduces new TS errors.
