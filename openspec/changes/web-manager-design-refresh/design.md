## Context

The web-manager currently uses Tailwind CSS v4 with a custom dark theme defined in `globals.css` via `@theme inline`. The specrails website uses Tailwind CSS v3 with CSS variables in `:root`. The migration must adapt the website's design tokens to the Tailwind v4 `@theme inline` format while preserving the visual identity.

Key difference: Tailwind v4 uses `--color-*` naming in `@theme inline` blocks, while Tailwind v3 uses bare CSS variables with `hsl()` function calls. The web-manager's theme must use v4 syntax but produce the same visual output as the website.

## Goals / Non-Goals

**Goals:**
- Match the specrails-web Dracula color palette exactly (same HSL values)
- Use Inter for body text, JetBrains Mono for code/logs/monospace
- Implement glass-card, gradient-text, gradient-btn, and glow utility classes
- Restyle all components to use new theme tokens
- Keep both `templates/web-manager/` and `specrails/web-manager/` in sync
- Preserve all existing functionality — no logic, API, or behavioral changes

**Non-Goals:**
- Adding particle effects or complex animations (website-only features)
- Changing page layout or component structure
- Adding new pages or features
- Matching the website's responsive breakpoints (web-manager is desktop-focused)
- Implementing the website's section navigation arrows or animated logo

## Decisions

### D1: Font loading via Google Fonts CSS import

Use `@import url(...)` in globals.css for Inter and JetBrains Mono, same approach as specrails-web. This avoids adding npm font packages and keeps the template lightweight.

**Why not @fontsource**: Adds ~8 packages to package.json for something a single CSS import handles.

### D2: Dracula tokens as CSS custom properties alongside @theme inline

Define Dracula semantic tokens (`--dracula-purple`, `--dracula-cyan`, etc.) as standalone CSS variables in a `:root` block, alongside the Tailwind v4 `@theme inline` block that maps them to Tailwind color names. This gives us both:
- Tailwind classes like `bg-primary`, `text-muted-foreground` (from @theme inline)
- Direct variable references in utility classes like `.glass-card` and `.glow-purple` (from :root)

### D3: Glass card as a CSS component class, not a Tailwind component

Define `.glass-card` in the CSS `@layer components` block rather than as a Tailwind plugin. This matches how specrails-web does it and keeps the implementation simple.

```css
.glass-card {
  background: hsl(var(--glass-bg));
  backdrop-filter: blur(12px);
  border: 1px solid hsl(var(--glass-border));
  border-radius: 0.75rem;
  transition: all 300ms;
}
.glass-card:hover {
  border-color: hsl(var(--dracula-comment) / 0.6);
}
```

### D4: Component restyling via className changes only

No structural changes to components. Replace existing Tailwind classes and inline styles with new theme-aligned classes. For example:
- `bg-card` → `glass-card` class
- `text-blue-400` → `text-dracula-cyan`
- `text-emerald-400` → `text-dracula-green`
- `border-border` → `border-border/30`
- Status badges get Dracula colors (running=cyan, completed=green, failed=red, canceled=orange)

### D5: Sync strategy — edit templates/ first, then copy to specrails/

Edit `templates/web-manager/` as the source of truth, then copy changed files to `specrails/web-manager/`. This ensures the template (which is what gets published via npm) is always correct.

## Risks / Trade-offs

**[Risk] Tailwind v4 @theme inline vs v3 CSS variables** → The Dracula color values use HSL without the `hsl()` wrapper in specrails-web (e.g., `--primary: 265 89% 78%`). In Tailwind v4 @theme inline, we use `--color-primary: hsl(265 89% 78%)`. The raw HSL values are still needed for `.glass-card` and glow utilities, so we define them both ways.

**[Risk] Google Fonts network dependency** → If fonts fail to load, the UI falls back to system fonts. Acceptable for a local dev tool.

**[Trade-off] No component library migration** → The web-manager already uses shadcn/ui components (Button, Badge, Tooltip, Dialog, etc.) which auto-adapt to theme changes via CSS variables. This means most restyling happens at the CSS level, not in component code.
