---
agent: developer
feature: sqlite-job-persistence
tags: [better-sqlite3, node25, native-addon]
date: 2026-03-15
---

## Decision

Used `better-sqlite3@12.8.0` (instead of `^9.4.0` as specified) because Node.js 25 requires a newer version with C++20-compatible binaries.

## Why This Approach

`better-sqlite3@9.4.0` has no prebuilt binary for Node 25 and the source build fails because Node 25's V8 headers require C++20 but the system Clang (via Xcode) doesn't support the required features. `better-sqlite3@12.8.0` ships prebuilt binaries for Node 25 / darwin / arm64. The API surface is identical for all the functions used in this implementation.

## See Also

The spec's `^9.4.0` constraint was written for Node 18-22 environments. When installing specrails in a target repo, the installer should use the latest compatible version rather than a hardcoded one.
