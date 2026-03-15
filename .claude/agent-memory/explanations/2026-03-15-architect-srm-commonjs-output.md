---
agent: architect
feature: cli-wrapper-srm
tags: [cli, typescript, distribution, node]
date: 2026-03-15
---

## Decision

Compile `cli/srm.ts` to CommonJS (`"module": "commonjs"` in `tsconfig.cli.json`) rather than ESM.

## Why This Approach

`srm` is designed to be installed globally via `npm install -g` or `npm link`. ESM binaries invoked via a `bin` shebang require Node.js 12.17+ with no flags, but the behaviour of `import` in a globally-installed `.js` file varies by Node version and package type. CommonJS works uniformly across all supported Node versions without `--experimental-vm-modules` or `"type": "module"` concerns in the package.json. The CLI does not use any ESM-only APIs; there is no forcing function to switch.

## Alternatives Considered

- ESM output: cleaner long-term but introduces compatibility risk for users on older Node.js versions who may have the web-manager installed globally.
- Bundling with `esbuild`: would produce a single self-contained file, but adds a build-time dependency to a project that currently has none.

## See Also

- `design.md` § `package.json` Changes
- `delta-spec.md` § New: tsconfig.cli.json
