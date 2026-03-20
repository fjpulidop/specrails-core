# Spec: Integration Contract

**File:** `integration-contract.json`
**Owner:** specrails-core
**Consumers:** specrails-hub

---

## Purpose

`integration-contract.json` is the machine-readable single source of truth for the interface between specrails-core and specrails-hub. It prevents silent drift by making the contract explicit and inspectable at both CI time and runtime.

---

## Schema

### Top-level fields

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | `string` | Contract schema version. Currently `"1.0"`. Bump only on structural changes to the contract file itself. |
| `coreVersion` | `string` | The specrails-core npm package version that produced this contract. Must match `version` in `package.json`. |
| `minimumHubVersion` | `string` | The minimum specrails-hub version required to operate against this core version. |
| `cli` | `object` | CLI invocation signatures (see below). |
| `checkpoints` | `string[]` | Ordered list of setup checkpoint keys. Hub uses this to detect installation completion. |
| `commands` | `string[]` | List of top-level specrails commands. Hub uses this to decide which verbs get the `/sr:` prefix injection. |

### `cli` object

| Field | Type | Description |
|---|---|---|
| `initArgs` | `string[]` | Arguments passed to `npx specrails-core` for initial setup. Currently `["init", "--yes"]`. |
| `updateArgs` | `string[]` | Arguments passed to `npx specrails-core` for updates. Currently `["update"]`. |

---

## Evolution Rules

These rules define what constitutes a breaking change and how version fields must be updated.

### Non-breaking changes (bump `coreVersion` minor)

- Adding a new checkpoint to `checkpoints`
- Adding a new command to `commands`
- Adding a new optional field to the contract

### Breaking changes (bump `minimumHubVersion`)

- Removing a checkpoint from `checkpoints`
- Removing a command from `commands`
- Renaming an existing checkpoint or command key

### Coordinated changes (require cross-repo PR)

- Any change to `cli.initArgs` or `cli.updateArgs` — Hub spawns these directly; a mismatch causes silent failure
- Bumping `schemaVersion` — consumers must update their parsing logic first

---

## Invariants

```
GIVEN integration-contract.json exists in the npm package
WHEN specrails-hub reads it after install
THEN hub.checkpoints must be a subset of contract.checkpoints
  AND contract.commands must equal the set of verbs hub expects to prefix-inject

GIVEN a new specrails-core version is released
WHEN coreVersion changes
THEN integration-contract.json must be updated to reflect the new version

GIVEN cli.initArgs changes
WHEN hub spawns the core initializer
THEN the new args must already be deployed to hub before core is released
```

---

## Compatibility Check

Hub validates the contract at two points:

1. **CI time** — via `scripts/check-core-compat.ts` triggered by the `specrails-core-released` GitHub Actions event
2. **Runtime** — in `SetupManager` after `npx specrails-core init --yes` completes

Mismatches are reported as warnings and surfaced via `GET /api/hub/core-compat`.

---

## References

- RFC-003: `specrails-hub/docs/engineering/rfcs/RFC-003-core-hub-sync.md`
- Hub consumer: `specrails-hub/server/setup-manager.ts`
- Hub CLI: `specrails-hub/cli/specrails-hub.ts`
