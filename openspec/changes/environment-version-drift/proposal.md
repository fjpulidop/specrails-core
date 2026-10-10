## Why

Environment preparation and repair (`plannedInstalls` / `missingNodeDependencies` in `src/agent-runtime/compact/environment.ts`) reinstall only when a declared dependency is absent from `node_modules`. They cannot tell when an installed version fails to satisfy its declared range.

That happens when a host reuses an install made for other inputs, or when the manifest moved ahead of the install. In a busuu-courses run (Skills #207, 2026-10-09), `node_modules/@busuu/experiments` was 5.23.0 while `package.json` required `^5.24.0`. Lint then failed on an untouched file. The fixer had to diagnose the cause by hand and report a setup blocker, which ended the run. The host could have repaired it with one install.

## What Changes

- **Detect version drift.** Add `driftedNodeDependencies(root)`. For each direct dependency declared in `dependencies`, `devDependencies` or `optionalDependencies` with a plain semver range, it reads the installed `node_modules/<name>/package.json` version. It returns the packages whose installed version does not satisfy the range, bounded at 20.
  - Non-semver specifiers are ignored: `workspace:`, `file:`, `link:`, `git`/URL, `npm:` aliases and dist-tags.
- **Plan an install on drift.** `plannedInstalls` plans the existing runner install (`npm install` / `yarn install` / `pnpm install`) when a dependency is missing **or** has drifted. This also covers the up-front `prepareEnvironment`, so a drifted tree is repaired before the first role turn.
- **Classify drift as an environment failure.** The verify-time repair treats a failing verification as an environment failure when drift exists in a root it verifies. It installs once and verifies again, through the same single re-run path as today.
- **Report drift.** Environment progress lines and `environmentRepair` name the drifted packages, for example `@busuu/experiments 5.23.0 does not satisfy ^5.24.0`.
- **Guardrail.** The behaviour stays under the existing `environment-repair` guardrail. No new guardrail is added.

## Capabilities

### New Capabilities
- `environment-version-drift`: detects installed direct dependencies whose versions do not satisfy their declared ranges, and repairs them through the existing install path, both up front and at verification.

### Modified Capabilities
<!-- None in a canonical tree: Core has no openspec/specs/ yet; the in-flight change engine-environment-repair-and-host-blockers owns verification-environment-repair, which this complements without changing its requirements. -->

## Impact

- **Code:**
  - `src/agent-runtime/compact/environment.ts`: adds the drift detector and its use in `plannedInstalls`.
  - `src/agent-runtime/verification-repair.ts` and `engine/pieces/verify.ts`: add drift-based environment classification.
- **Dependency:** adds `semver` as a runtime dependency (small, ubiquitous), so ranges are matched exactly like npm does. The bundled Core lockfile must be regenerated, and `scripts/assemble-bundled-core.mjs` in Desktop picks it up on the next pin.
- **Behaviour:** extra installs happen only when drift exists. Repositories with a healthy install see no change.
- **Companion change:** Desktop `warm-dependency-freshness` stops the most common source of drift, which is warm links from a base checkout whose lockfile differs.
