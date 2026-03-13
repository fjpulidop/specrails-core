---
name: web-manager-architecture
description: Structure, key patterns, and decisions for the web/ subtree (Pipeline Monitor MVP)
type: project
---

The `web/` directory is a self-contained Node.js + React app added in the web-manager-mvp change.
It has two separate npm workspaces: `web/` (server) and `web/client/` (Vite React frontend).

## Layout

```
web/
├── package.json          # Server deps: express, ws, uuid, tsx, concurrently
├── tsconfig.json         # Server TS: commonjs, rootDir=server
├── server/
│   ├── types.ts          # Source of truth for all shared interfaces
│   ├── hooks.ts          # Pipeline state machine + Express router for POST /hooks/events
│   ├── spawner.ts        # Claude CLI process spawner, circular log buffer (5000 lines)
│   └── index.ts          # Entry point: Express + WebSocketServer (noServer mode)
├── client/
│   ├── package.json      # React + Vite deps
│   ├── tsconfig.json     # ESNext, bundler moduleResolution, jsx=react-jsx
│   ├── tsconfig.node.json # Covers vite.config.ts only
│   ├── vite.config.ts    # Proxies /api and /hooks to localhost:3001
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx       # CSS grid layout: header / sidebar / activity
│       ├── hooks/
│       │   ├── useWebSocket.ts  # WS with 5-attempt exponential backoff
│       │   └── usePipeline.ts   # Derives phases + logLines from WS messages
│       └── components/
│           ├── PipelineSidebar.tsx
│           ├── AgentActivity.tsx
│           ├── LogStream.tsx
│           ├── SearchBox.tsx
│           └── CommandInput.tsx
└── README.md
```

## Key architectural decisions

- `WebSocketServer({ noServer: true })` + manual `server.on('upgrade')` to share one HTTP port
- Client types are local duplicates of server types — no cross-boundary imports
- `tsconfig.node.json` required alongside `tsconfig.json` in client when `references` field is present
- Log buffer: module-level array, max 5000 lines, splice oldest 1000 when full
- One active spawn at a time enforced in `spawner.ts`; 409 returned by `index.ts` on `SpawnBusyError`

**Why:** `npm run typecheck` runs `tsc --noEmit && cd client && tsc --noEmit` sequentially from `web/`
