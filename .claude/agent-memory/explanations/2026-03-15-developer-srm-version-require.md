---
agent: developer
feature: cli-wrapper-srm
tags: [server, version, package-json, task-11]
date: 2026-03-15
---

## Decision

`server/index.ts` reads the package version using an IIFE with `require('../package.json')` at module load time rather than passing it as a CLI arg or reading it on each request.

## Why This Approach

The server is always started from the `templates/web-manager/` directory (or its deployed copy), so `../package.json` relative to the compiled server output (`dist/server/`) correctly resolves to the package root. Reading it once at startup avoids repeated I/O on every `/api/state` request.

## Alternatives Considered

- Injecting version via `--version` CLI flag: requires the startup script to read package.json anyway.
- Reading `package.json` per-request: unnecessary overhead.
- Hardcoding the version: would diverge from `package.json` version on updates.
