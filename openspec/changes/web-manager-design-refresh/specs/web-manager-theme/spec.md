## ADDED Requirements

### Requirement: Dracula color palette as theme foundation
The `globals.css` SHALL define CSS custom properties matching the specrails-web Dracula palette, mapped to Tailwind v4 `@theme inline` color tokens.

#### Scenario: Theme variables defined
- **WHEN** the globals.css is loaded
- **THEN** the following Tailwind color tokens SHALL be defined with their exact HSL values:
  - `--color-background`: hsl(231 15% 18%)
  - `--color-foreground`: hsl(60 30% 96%)
  - `--color-card`: hsl(232 14% 31%)
  - `--color-primary`: hsl(265 89% 78%) (purple)
  - `--color-primary-foreground`: hsl(231 15% 18%)
  - `--color-secondary`: hsl(326 100% 74%) (pink)
  - `--color-accent`: hsl(191 97% 77%) (cyan)
  - `--color-muted`: hsl(232 14% 31%)
  - `--color-muted-foreground`: hsl(225 27% 51%)
  - `--color-destructive`: hsl(0 100% 67%)
  - `--color-border`: hsl(225 27% 51%)
  - `--color-ring`: hsl(265 89% 78%)

#### Scenario: Dracula semantic tokens available
- **WHEN** components reference Dracula colors
- **THEN** CSS custom properties SHALL be available: `--dracula-purple`, `--dracula-cyan`, `--dracula-green`, `--dracula-pink`, `--dracula-orange`, `--dracula-red`, `--dracula-yellow`, `--dracula-comment`, `--dracula-current`, `--dracula-darker`

### Requirement: Inter and JetBrains Mono as typography stack
The client SHALL load Inter for body text and JetBrains Mono for monospace/code via Google Fonts import.

#### Scenario: Font loading
- **WHEN** the CSS is loaded
- **THEN** Inter (weights 300-700) and JetBrains Mono (weights 400-700) SHALL be imported from Google Fonts

#### Scenario: Body text uses Inter
- **WHEN** body text is rendered
- **THEN** it SHALL use `font-family: 'Inter', sans-serif` with 14px base size

#### Scenario: Monospace uses JetBrains Mono
- **WHEN** code, logs, or terminal content is rendered
- **THEN** it SHALL use `font-family: 'JetBrains Mono', monospace`

### Requirement: Glass card utility class
A `.glass-card` CSS class SHALL provide the glassmorphic card effect used throughout the UI.

#### Scenario: Glass card appearance
- **WHEN** an element has the `glass-card` class
- **THEN** it SHALL have: semi-transparent background (`hsl(232 14% 31% / 0.3)`), 12px backdrop blur, 1px border at 30% opacity, 0.75rem border radius, and 300ms transition

#### Scenario: Glass card hover
- **WHEN** a glass-card element is hovered
- **THEN** the border opacity SHALL increase to 60%

### Requirement: Gradient utility classes
The CSS SHALL provide `.gradient-text` and `.gradient-btn` utility classes matching the specrails-web purple-to-pink gradient.

#### Scenario: Gradient text
- **WHEN** an element has the `gradient-text` class
- **THEN** it SHALL display text with a 135deg gradient from purple to pink using background-clip

#### Scenario: Gradient button
- **WHEN** an element has the `gradient-btn` class
- **THEN** it SHALL have a purple-to-pink gradient background with a purple glow on hover

### Requirement: Glow utility classes
The CSS SHALL provide `.glow-purple`, `.glow-cyan`, `.glow-green`, `.glow-pink`, `.glow-orange`, `.glow-red` classes with subtle box-shadow effects.

#### Scenario: Glow on hover
- **WHEN** an element has a glow class
- **THEN** it SHALL have a `box-shadow: 0 0 20px` with the respective Dracula color at 20% opacity

### Requirement: Border radius increased to 0.75rem
The base border radius SHALL be 0.75rem (12px) matching the specrails website.

#### Scenario: Radius token
- **WHEN** Tailwind's `rounded-*` classes are used
- **THEN** the base `--radius` SHALL be 0.75rem

### Requirement: Scrollbar styling matches website
Custom scrollbar styling SHALL use Dracula comment color for thumb.

#### Scenario: Scrollbar appearance
- **WHEN** scrollable content is displayed
- **THEN** the scrollbar thumb SHALL use `hsl(225 27% 51% / 0.4)` with 3px border radius
