## 1. Reproduce before fixing

- [x] 1.1 Add a failing test in `src/installer/util/install-transaction.test.ts` (new file) that stubs `fs.symlinkSync` to throw `EPERM` for every `type` except `'junction'`, builds a surface list containing a directory link, and drives `withInstallRollback` — assert it currently throws from the snapshot phase. This is the regression witness; it must fail on `origin/main`.
- [x] 1.2 Add a second failing case: the same stub, a surface directory whose CHILD is a link, asserting the nested traversal is reached (covers the assembled-workspace `.claude` shape, not just `current`).

## 2. Link-preserving snapshot primitive

- [x] 2.1 Decide and document how link records are carried (design Open Question). Resolved: `snapshotTree` RETURNS them and the transaction keeps them in memory; nothing extra is written into the backup tree, so the collision question disappears. They reach disk only inside `recovery.json` when a restore fails.
- [x] 2.2 Implement the snapshot traversal in `src/installer/util/fs.ts`: for each entry, `lstat` → link records its `readlinkSync` target as a sidecar; directory recurses; file uses the existing `copyFile`. It MUST create no links.
- [x] 2.3 Implement the matching restore: a recorded link is recreated through `atomicSymlinkSwap` / `symlinkOrCopy` (junction on Windows, symlink elsewhere, copy fallback); directories and files restore as today.
- [x] 2.4 Unit-test the primitive directly in `src/installer/util/fs.test.ts`: round-trip of a link, a nested link, a plain tree, and the copy-fallback branch (stub every link mechanism to fail and assert the contents land).
- [ ] 2.5 Verify long-path behaviour on Windows is no worse than the `cpSync` baseline (design risk) — a deep provider tree under `%TEMP%` still snapshots and restores.

## 3. Wire the transaction to the primitive

- [x] 3.1 Replace the snapshot `cpSync` in `withInstallRollback` (`src/installer/util/install-transaction.ts`) with the new traversal.
- [x] 3.2 Replace the restore `cpSync` with the matching restore, preserving the existing `isReservedPath` filter semantics exactly (reserved paths are neither removed nor overwritten from backup).
- [x] 3.3 Confirm the retained-backup path still holds: a restore failure keeps the backup, writes `recovery.json`, and raises an `InstallerError` naming the failing surface and the backup location.
- [x] 3.4 Make tasks 1.1 and 1.2 pass without weakening them.

## 4. Narrow the protected surface set

- [x] 4.1 Mark `path.join(fwDir, version)` as `{ snapshotContents: false }` in `src/installer/commands/init.ts` (keep `path.join(fwDir, 'current')`). Chosen over deleting the entry so a rollback still removes a version dir the failed install CREATED.
- [x] 4.2 Audit the other `withInstallRollback` callers. Only `init.ts` and `update.ts` call it, with identical surface lists; both updated the same way. `framework.ts` does not open a transaction.
- [x] 4.3 Add a test asserting a failed install leaves `<frameworkDir>/<version>` on disk and restores `current` to its previous target.
- [x] 4.4 Add a test asserting no copy of the version tree is made during a transaction (e.g. the backup holds only the pointer record and the workspace surfaces).

## 5. Regression coverage that CI can see

- [x] 5.1 Keep `src/installer/commands/lifecycle-admission.test.ts` real-junction coverage intact — it remains the privileged-path check on `windows-latest`.
- [x] 5.2 Ensure the privilege-denial tests from group 1 run on every matrix OS (they must not be `describe.skipIf(win32)`) so the Linux jobs carry the guarantee.
- [x] 5.3 Add a comment at the `cpSync` call sites that survive, stating the invariant they rely on (the copied tree contains no links) so the next author does not reintroduce the trap.

## 6. Verify and ship

- [ ] 6.1 `npm run build && npx vitest run` green locally.
- [ ] 6.2 Manual check on a Windows machine WITHOUT Developer Mode: `npx specrails-core init` twice in a row over the same repo, both succeed; and a full specrails-desktop project add against a locally staged build.
- [x] 6.3 Resolve the `scaffold.ts:692` open question. Left as `cpSync` (the framework store holds real files only) with an explicit invariant comment naming the EPERM trap and pointing at `snapshotTree`/`restoreTree`.
- [ ] 6.4 Release Core as a patch; open the paired specrails-desktop PR bumping `CORE_BUNDLE_VERSION` in `.github/workflows/desktop-release.yml` and `scripts/assemble-bundled-core.lock.json` together.
- [ ] 6.5 Note in the desktop PR that the two desktop-side defects this incident exposed (stderr tail discarding the error message in `server/offline-assemble.ts`, and a failed assemble degrading silently to the legacy cwd so rails report `Unknown command`) are tracked separately — they are not fixed by the Core bump.
