## Why

The web-manager uses a generic dark theme (deep blue `hsl(222 84% 5%)`, white primary, DM Mono font) that looks disconnected from the specrails brand. The official website at specrails.dev uses a Dracula-inspired design system with purple/pink gradients, glassmorphic cards, Inter + JetBrains Mono typography, and vibrant accent colors. Aligning the web-manager to the same design language creates a cohesive product experience and makes the web-manager feel like a first-class part of specrails rather than a generic dashboard.

## What Changes

- **Theme migration**: Replace the current color palette with the Dracula-based palette from specrails-web (purple primary, cyan accent, pink secondary, glass-bg/glass-border tokens)
- **Typography**: Switch from DM Mono to Inter (body) + JetBrains Mono (code/logs), matching the website
- **Glass cards**: Replace solid-background cards with glassmorphic cards (`backdrop-filter: blur(12px)`, semi-transparent backgrounds, subtle borders)
- **Gradient accents**: Add purple→pink gradient for primary actions and branded elements (gradient buttons, gradient text for headings)
- **Glow effects**: Add subtle box-shadow glows on interactive elements (command cards, active job, pipeline phases)
- **Component restyling**: Update Navbar, command grid, active job card, job detail, log viewer, badges, and status indicators to match the website's visual language
- **Border radius**: Increase from 0.5rem to 0.75rem (matching the website's rounder corners)
- **Scrollbar styling**: Match the website's custom scrollbar colors
- **IMPORTANT**: All changes must be applied to BOTH `templates/web-manager/` (source for new installs) and `specrails/web-manager/` (local dev copy), kept in sync

## Capabilities

### New Capabilities
- `web-manager-theme`: CSS theme variables, font imports, glass/gradient/glow utility classes, and scrollbar styling aligned with specrails-web design system

### Modified Capabilities
- `web-manager-design-system`: Update all component styling references to use new theme tokens, glass cards, gradient accents, and Inter typography
- `web-manager-dashboard`: Restyle dashboard with glass cards, gradient command grid, glow effects on hover
- `web-manager-job-detail`: Restyle job detail with glass card header, themed pipeline progress, terminal-style log viewer

## Impact

- **CSS**: `globals.css` rewritten with Dracula palette, font imports, glass/gradient/glow utility classes
- **Components**: Every component file gets className updates (no logic changes, purely visual)
- **Dependencies**: Add `@fontsource/inter` and `@fontsource/jetbrains-mono` (or Google Fonts import) to client
- **Both copies**: `templates/web-manager/` and `specrails/web-manager/` must stay in sync
- **No breaking changes**: No API, type, or behavioral changes — purely visual/CSS
