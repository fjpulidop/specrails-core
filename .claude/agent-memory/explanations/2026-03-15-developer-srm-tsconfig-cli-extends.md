---
agent: developer
feature: cli-wrapper-srm
tags: [typescript, tsconfig, commonjs, cli]
date: 2026-03-15
---

## Decision

`tsconfig.cli.json` extends `./tsconfig.json` and overrides `outDir`, `rootDir`, and `module` to target CommonJS with output into `cli/dist/`.

## Why This Approach

The root `tsconfig.json` already has `"module": "commonjs"` for the server, so extending it is correct. Overriding `rootDir` to `"cli"` ensures the compiled output is flat in `cli/dist/srm.js` rather than nested under a `cli/` subdirectory. This is required by the `package.json` bin entry `"./cli/dist/srm.js"`.

## Alternatives Considered

- A completely standalone tsconfig — more boilerplate and risks diverging from the project's `target`, `strict`, `esModuleInterop` settings.
- Compiling CLI via the root tsconfig — would require mixing `cli/` and `server/` under the same `rootDir`, which breaks the existing server output structure.
