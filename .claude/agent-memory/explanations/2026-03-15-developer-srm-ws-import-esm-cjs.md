---
agent: developer
feature: cli-wrapper-srm
tags: [websocket, esm, commonjs, testing, vitest]
date: 2026-03-15
---

## Decision

In `cli/srm.test.ts`, WebSocket client is imported as `{ WebSocket as WsClient }` (named import from `'ws'`) rather than using the default import or a global.

## Why This Approach

Vitest runs tests in an environment where `WebSocket` is not a Node.js global (Node 18/20 do not expose it globally without experimental flags). The `ws` package exports its class as both the default export and as `WebSocket` named export. Using the named export `{ WebSocket as WsClient }` avoids the ESM default-import resolution issue where the constructor form (`new WebSocket(url)`) fails because the default export object from `ws` is not a callable constructor in vitest's module resolution.

## Alternatives Considered

- Default import `import WebSocket from 'ws'` — works in production code compiled to CJS, but in vitest's ESM-first environment the default export was not a constructor function.
- `global.WebSocket` — not available in Node 18/20 without polyfill.
- Dynamic `await import('ws').then(m => m.WebSocket)` — unnecessarily complex.

## See Also

- `cli/srm.ts` uses `import WebSocket from 'ws'` (default import) which works because it's compiled to CJS by `tsconfig.cli.json` — different context from vitest.
