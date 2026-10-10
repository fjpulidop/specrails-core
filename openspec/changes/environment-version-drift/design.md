## Context

`plannedInstalls(root)` plans a node install when `node_modules` is absent, or when `missingNodeDependencies(root)` finds a declared package directory missing. `prepareEnvironment` runs that plan before the first role turn. The verify piece re-runs it once when a failure looks environmental (`isEnvironmentFailure`).

None of these paths look at versions. A tree installed for other inputs is therefore accepted as healthy. Hosts can produce such trees: Desktop's warm links come from the user's base checkout. Developers can too, by editing a manifest after installing.

## Goals / Non-Goals

**Goals:**
- Repair a drifted direct dependency with the same single install the host already performs for missing ones.
- Name the drifted packages in progress lines and in the evidence.

**Non-Goals:**
- Transitive drift, and lockfile-versus-tree integrity. The package manager's install handles those once it runs.
- Repairing a lockfile that itself pins an old version. That is a code change and belongs to the developer or the operator.
- Non-node ecosystems.

## Decisions

1. **Check direct dependencies only.**
   - Their manifests are one file read each, and the cost is bounded at the declared count.
   - Direct dependencies are what application code imports, so they are where drift fails builds.
   - Alternative: `npm ls` / `yarn check`. Rejected, because they are slow, vary by package manager and print noisily.

2. **Use `semver` for range matching.**
   - It gives the exact npm semantics for `^`, `~`, `x` ranges, hyphen ranges and `||`.
   - Alternative: a hand-rolled subset. Rejected, because it would be subtly wrong on edge ranges and would cause spurious installs.
   - `includePrerelease: false` matches npm resolution.

3. **Ignore non-semver specifiers.**
   - Workspace, file, link, git, URL, alias and tag specifiers have no installed-version contract that can be checked locally.
   - Reporting them would cause install loops.

4. **Reuse the existing install plan and single re-run.**
   - Drift is one more reason to run the same command.
   - The re-run budget and the precondition classification stay unchanged: registry credential and network failures still become blockers.

5. **Classify drift at verify time without parsing output.**
   - The failure that drift causes is arbitrary, for example a lint `no-unsafe-call` caused by a missing export.
   - Attaching environment classification to observed drift in the failing command's root is reliable. Pattern-matching the output is not.

## Risks / Trade-offs

- [Spurious installs for unusual ranges] → Anything that `semver.validRange` rejects is skipped.
- [An install over a warm-linked tree could write through links into the base checkout] → Package managers replace the symlinked package entries instead of writing through them, and Desktop's `warm-dependency-freshness` avoids linking when the inputs differ. Task 3.3 adds an integration test with a symlinked package entry, asserting that the link target is unchanged after the install.
- [Install time on large repos] → It runs only when drift exists, at most once up front and once per verify step.
- [`semver` adds a dependency] → It is small, with no transitive dependencies, and it is already present in virtually every Node toolchain.

## Migration Plan

The change is additive. The new dependency requires regenerating the bundled lockfile. Rollback is a revert, or disabling `environment-repair`.

## Open Questions

- Should drift at prepare time also be reported to Desktop as a structured event, so the UI can explain the slower start? Proposal: no. The progress line is enough for now.
