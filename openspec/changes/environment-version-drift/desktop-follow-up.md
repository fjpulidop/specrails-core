# Desktop follow-up: environment version drift

Core change `environment-version-drift` is additive. It needs no Desktop change to work, but the next Core pin has three items to pick up.

1. **Regenerate the bundled lockfile.**
   - Core now depends on `semver` (`^7.8.5`), and on `@types/semver` as a dev dependency.
   - `scripts/assemble-bundled-core.mjs` must regenerate the bundled Core lockfile on the next pin, so the packaged sidecar ships `semver`.
   - Check the Windows MSI path budget. `semver` is a flat package with no dependencies.
2. **Optional rendering.**
   - The engine `verify` output `environmentRepair` may carry `drift: [{ root, name, declared, installed }]`.
   - Job Detail can list these packages next to the installs, using the existing `environmentRepair` rendering.
   - Progress lines use the `[environment]` / `Environment:` prefixes as before, including `… the lockfile still resolves the drifted version …`.
3. **Companion change `warm-dependency-freshness`.** It keeps Desktop from warm-linking a base checkout whose lockfile differs. That is the most common source of drift. Core's repair replaces symlinked package entries and does not write through them; `compact/environment.test.ts` asserts this.
