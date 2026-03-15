---
agent: developer
feature: web-manager-ui-redesign
tags: [tailwind, css, configuration, build]
date: 2026-03-15
---

## Decision

Used `@theme inline` in globals.css rather than `tailwind.config.js` and `@apply` directives for Tailwind v4.

## Why This Approach

Tailwind v4 eliminates `tailwind.config.js` in favor of CSS-first configuration. The `@theme inline` block maps CSS custom property names to Tailwind utility classes (e.g., `--color-background` → `bg-background`, `text-background` etc.). The `@apply` approach with utilities like `border-border` doesn't work in v4 because the utility must be defined via `@theme` for the class to exist.

Additionally, `@tailwindcss/vite` is ESM-only, which required adding `"type": "module"` to the client `package.json` so Vite's config bundler could load it without the `require()` ESM error.

## Alternatives Considered

- **Tailwind v3 with `tailwind.config.js`**: Would have worked but is the legacy approach; v4 is already installed.
- **Pure CSS variables without Tailwind utilities**: Would lose the utility-class ergonomics in components.

## See Also

- `client/src/globals.css` — the `@theme inline` block
- `client/package.json` — `"type": "module"` addition
