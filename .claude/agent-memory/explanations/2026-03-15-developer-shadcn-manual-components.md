---
agent: developer
feature: web-manager-ui-redesign
tags: [shadcn, radix-ui, components, architecture]
date: 2026-03-15
---

## Decision

Created shadcn/ui components manually (Button, Card, Badge, Dialog, Input, Select, Separator, Tooltip) rather than running `npx shadcn@latest init`.

## Why This Approach

The `npx shadcn@latest init` CLI cannot run in non-interactive environments and requires a configured `components.json` + a `tailwind.config.js` or specific project setup. Since we're in a template directory that will be copied to target repos, the components need to exist as source files. Manual creation gives full control over the component code and ensures no CLI side-effects or interactive prompts block the build.

## See Also

- `client/src/components/ui/` — all manually created shadcn components
- `client/src/lib/utils.ts` — `cn()` utility combining clsx + tailwind-merge
