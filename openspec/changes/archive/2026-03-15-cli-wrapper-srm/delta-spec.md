# Delta Spec: CLI Wrapper (srm)

This document records every contract surface change introduced by the cli-wrapper-srm feature. It is the authoritative reference for what is new, what changes, and what is deprecated.

---

## New: `srm` CLI Binary

**Location:** `templates/web-manager/cli/srm.ts` → compiled to `cli/dist/srm.js`
**Registered as:** `bin.srm` in `templates/web-manager/package.json`

### Command surface

```
srm [--port <n>] <verb> [args...]
srm [--port <n>] "<raw prompt>"
srm --status [--port <n>]
srm --jobs [--port <n>]
srm --help
```

### Known verbs (map to `/sr:<verb>`)

- `implement`
- `batch-implement`
- `why`

Additional verbs may be added in future changes. The verb list lives in a const array in `cli/srm.ts`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | srm-level error (no server, bad args, claude not found) |
| N | Propagated from claude child process |

---

## New: `GET /api/jobs` Endpoint

**Server file:** `templates/web-manager/server/index.ts` (route registration) + new `templates/web-manager/server/jobs.ts` (handler)

**Note:** This endpoint returns empty results or 501 until #57 (SQLite persistence) lands. The route exists; persistence is a dependency.

### Request

```
GET /api/jobs
```

Query parameters: none for MVP.

### Response 200

```json
[
  {
    "processId": "a1b2c3d4-...",
    "command": "/sr:implement #42",
    "startedAt": "2026-03-15T14:22:00.000Z",
    "finishedAt": "2026-03-15T14:26:32.000Z",
    "exitCode": 0,
    "durationMs": 272000
  }
]
```

When SQLite is unavailable, responds with:
```json
{ "error": "job history not available", "code": "NO_PERSISTENCE" }
```
HTTP status 501.

---

## New: `GET /api/jobs/:processId` Endpoint

**Server file:** same as above.

### Request

```
GET /api/jobs/<uuid>
```

### Response 200

Single job object (same schema as array element above).

### Response 404

```json
{ "error": "job not found" }
```

### Response 501

Same as `GET /api/jobs` when persistence unavailable.

---

## Modified: `templates/web-manager/package.json`

### Additive changes

- Added `"bin": { "srm": "./cli/dist/srm.js" }`
- Added script `"build:cli": "tsc --project tsconfig.cli.json"`
- Modified script `"build"`: appends `&& npm run build:cli`

No existing scripts, dependencies, or devDependencies are removed or renamed.

---

## New: `templates/web-manager/tsconfig.cli.json`

Minimal TypeScript config targeting `cli/srm.ts`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "cli/dist",
    "module": "commonjs",
    "rootDir": "cli"
  },
  "include": ["cli/**/*.ts"],
  "exclude": ["cli/**/*.test.ts"]
}
```

---

## No Changes To

- `install.sh` — no new flags
- `templates/agents/*.md` — no agent prompt changes
- `templates/commands/*.md` — no command template changes
- `openspec/specs/` — no existing spec files modified
- `.claude/` generated files — not affected by template-layer changes
