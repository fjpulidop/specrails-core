---
agent: architect
feature: chat-panel
tags: [layout, react, RootLayout, flex, navigation]
date: 2026-03-15
---

## Decision

Mount `ChatPanel` inside a `flex flex-row` wrapper in `RootLayout` (alongside `<main>`) rather than as a fixed-position overlay.

## Why This Approach

The requirement is that the chat panel persists across page navigation without losing state. Both approaches (flex sibling vs. fixed overlay) achieve this when mounted in `RootLayout`. The flex-sibling approach is preferred because: (1) it naturally pushes main content left when the panel expands — no z-index management or absolute positioning needed; (2) the `StatusBar` at the bottom spans the full width cleanly; (3) it avoids potential issues with modals and overlays in the main content area.

## Alternatives Considered

- Fixed right sidebar: requires `main` to have padding-right when panel is open; state-synchronized CSS is fiddly.
- Modal/drawer overlay: would cover main content during chat — unacceptable for a panel intended to be used alongside the pipeline dashboard.

## See Also

- `client/src/components/RootLayout.tsx` — the target file
- `design.md` — Layout Integration section
