## 1. Theme foundation — globals.css

- [x] 1.1 Rewrite `globals.css` with Dracula color palette in `@theme inline` block (all HSL values from specrails-web)
- [x] 1.2 Add `:root` block with Dracula semantic tokens (`--dracula-purple`, `--dracula-cyan`, etc.) and glass/gradient variables
- [x] 1.3 Add Google Fonts import for Inter (300-700) and JetBrains Mono (400-700)
- [x] 1.4 Update body styles to use Inter as primary font, 14px base size
- [x] 1.5 Add `.glass-card`, `.gradient-text`, `.gradient-btn` component classes
- [x] 1.6 Add `.glow-purple`, `.glow-cyan`, `.glow-green`, `.glow-pink`, `.glow-orange`, `.glow-red` utility classes
- [x] 1.7 Add `.terminal` styling class for log viewer
- [x] 1.8 Update scrollbar styling to use Dracula comment color
- [x] 1.9 Update prose/markdown table styles to use Dracula colors
- [x] 1.10 Set `--radius` to 0.75rem

## 2. Badge component — Dracula variants

- [x] 2.1 Update Badge component variants to use Dracula colors (running=cyan, success/completed=green, failed=red, canceled=orange, queued=purple)

## 3. Navbar — glassmorphic

- [x] 3.1 Restyle Navbar with glass-card background, gradient-text for brand, Dracula-colored nav links

## 4. Dashboard components

- [x] 4.1 Restyle `ActiveJobCard.tsx` with glass-card, purple glow when running, Dracula-colored phase indicators
- [x] 4.2 Restyle `CommandGrid.tsx` with glass-card tiles, glow-on-hover effects
- [x] 4.3 Restyle `RecentJobs.tsx` with glass-card container, Dracula status badges, alternating row opacity
- [x] 4.4 Restyle `DashboardPage.tsx` layout with proper spacing and glass-card sections
- [x] 4.5 Restyle `StatusBar.tsx` with glass background, Dracula green/red connection indicators

## 5. Job detail components

- [x] 5.1 Restyle `JobDetailPage.tsx` header with glass-card, gradient-text job ID, Dracula status badge
- [x] 5.2 Restyle `PipelineProgress.tsx` with Dracula colors (purple=running, green=done, red=error, comment=idle)
- [x] 5.3 Restyle `LogViewer.tsx` container with terminal class, Dracula log type colors (cyan=tool, orange=stderr, green=result)

## 6. Wizard and settings components

- [x] 6.1 Restyle `ImplementWizard.tsx` dialog with glass-card styling, Dracula accent colors
- [x] 6.2 Restyle `BatchImplementWizard.tsx` dialog similarly
- [x] 6.3 Restyle `IssuePickerStep.tsx` with Dracula-colored issue items
- [x] 6.4 Restyle `SettingsPage.tsx` with glass-card sections, Dracula form controls

## 7. Layout

- [x] 7.1 Update `RootLayout.tsx` with font-sans class and glass-card toast styling

## 8. Sync and verify

- [x] 8.1 Copy all changed files from `templates/web-manager/` to `specrails/web-manager/`
- [x] 8.2 Verify TypeScript compiles clean (client)
- [x] 8.3 Verify full build succeeds (`npm run build`)
- [x] 8.4 Verify diff between templates/ and specrails/ is zero for all changed files
