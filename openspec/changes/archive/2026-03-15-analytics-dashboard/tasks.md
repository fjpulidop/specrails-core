---
id: analytics-dashboard
type: tasks
status: draft
created: 2026-03-15
---

# Implementation Tasks — Analytics Dashboard

Tasks are ordered to respect dependencies. Each task is atomic and independently verifiable.

---

## Phase 1: Backend foundation

### Task 1 — Add `AnalyticsResponse` types to server types [core]

**Files:** `templates/web-manager/server/types.ts`, then sync to `specrails/web-manager/server/types.ts`

**Description:** Add the `AnalyticsOpts` interface and the full `AnalyticsResponse` interface (with all nested array and object types) to the server types module. No runtime code changes.

**Acceptance criteria:**
- `AnalyticsOpts` type exported with `period`, `from`, `to` fields
- `AnalyticsResponse` type exported with all sub-types: `kpi`, `costTimeline`, `statusBreakdown`, `durationHistogram`, `durationPercentiles`, `tokenEfficiency`, `commandPerformance`, `dailyThroughput`, `costPerCommand`, `bonusMetrics`
- `tsc --noEmit` passes

**Dependencies:** none

---

### Task 2 — Create `server/analytics.ts` with all SQLite queries [core]

**Files:** `templates/web-manager/server/analytics.ts` (new), then sync to `specrails/web-manager/server/analytics.ts`

**Description:** Implement `getAnalytics(db: DbInstance, opts: AnalyticsOpts): AnalyticsResponse`. The function must:

1. Resolve the ISO date bounds for the current period and (if not `'all'`) the previous comparison period
2. Run the following queries using `db.prepare(...).all(...)` / `.get(...)`:
   - KPI aggregate: `COUNT(*)`, `SUM(total_cost_usd)`, `AVG(duration_ms)` for current + previous period
   - Success rate: `COUNT(*) WHERE status = 'completed'` / total for each period
   - Cost timeline: daily `SUM(total_cost_usd)` grouped by `strftime('%Y-%m-%d', started_at)` for current period, zero-fill missing dates in JS
   - Status breakdown: `COUNT(*) GROUP BY status` for current period
   - Duration histogram: `CASE WHEN ... END AS bucket, COUNT(*)` with NULL guard and status='completed'
   - Duration raw values: `SELECT duration_ms FROM jobs WHERE ... ORDER BY duration_ms` for JS percentile computation
   - Token efficiency: `SUM(tokens_out)`, `SUM(tokens_cache_read)` grouped by `command`, top 10 by total tokens
   - Command performance: per-command `COUNT(*)`, success count, avg cost, avg duration, total cost
   - Daily throughput: `strftime('%Y-%m-%d', started_at)` with `SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END)` pattern
   - Cost per command: `SUM(total_cost_usd) GROUP BY command`
   - Bonus: cost per success (total cost / success count), API efficiency (avg(duration_api_ms)/avg(duration_ms)), failure cost, model breakdown
3. Compute p50/p75/p95 in JS from sorted duration array
4. Return `AnalyticsResponse` — all `null` for zero-denominator ratios

**Acceptance criteria:**
- All `db.prepare` calls are synchronous (no async)
- COALESCE wraps all nullable SUM aggregations
- Missing date zero-fill is tested by a unit test that inserts 3 days of data with a gap on day 2
- `tsc --noEmit` passes

**Dependencies:** Task 1

---

### Task 3 — Add `GET /api/analytics` route to `server/index.ts` [core]

**Files:** `templates/web-manager/server/index.ts`, then sync to `specrails/web-manager/server/index.ts`

**Description:** Import `getAnalytics` from `./analytics`. Register the route after the existing `/api/stats` route:
- Parse `period`, `from`, `to` from `req.query`
- Validate `period` is one of `['7d', '30d', '90d', 'all', 'custom']`
- Validate `from` and `to` are present when `period === 'custom'`
- Return 400 with descriptive error messages for invalid input
- Wrap `getAnalytics` call in try/catch, return 500 on error

**Acceptance criteria:**
- `GET /api/analytics?period=7d` returns 200 with valid JSON
- `GET /api/analytics?period=bad` returns 400
- `GET /api/analytics?period=custom` (no from/to) returns 400
- Existing routes are unaffected
- `index.test.ts` integration test added for the 200 and 400 cases

**Dependencies:** Task 2

---

### Task 4 — Write unit tests for `analytics.ts` [core]

**Files:** `templates/web-manager/server/analytics.test.ts` (new), then sync to `specrails/web-manager/server/analytics.test.ts`

**Description:** Use vitest with an in-memory SQLite database (`:memory:` path via `initDb`). Tests:
1. Empty DB → all zero aggregates, empty arrays, null deltas
2. Single completed job → KPI counts 1, cost matches, duration histogram bucket correct
3. Gap in date series → zero-filled dates appear in `costTimeline`
4. Two periods → delta calculation correct (previous period has double cost → costDelta is negative)
5. NULL cost job (canceled) → treated as 0 in aggregations

**Acceptance criteria:**
- `npm test` passes with all 5 test cases
- No DB file left on disk after tests (`:memory:`)

**Dependencies:** Task 2

---

## Phase 2: Client types and data hook

### Task 5 — Add `AnalyticsResponse` type to client types [templates]

**Files:** `templates/web-manager/client/src/types.ts`, then sync to `specrails/web-manager/client/src/types.ts`

**Description:** Add the `AnalyticsResponse` TypeScript interface (matching the server's response shape exactly) and `AnalyticsPeriod` type alias (`'7d' | '30d' | '90d' | 'all' | 'custom'`) to the client types file.

**Acceptance criteria:**
- Field names match server response exactly (snake_case for timeline arrays, camelCase for KPI fields — follow server convention)
- `cd client && tsc --noEmit` passes

**Dependencies:** Task 1

---

### Task 6 — Add recharts to client dependencies [templates]

**Files:** `templates/web-manager/client/package.json`, then sync to `specrails/web-manager/client/package.json`

**Description:** Add `"recharts": "^2.12.0"` to `dependencies`. Run `npm install` in `specrails/web-manager/client/` to update the lock file.

**Acceptance criteria:**
- `recharts` appears in `package.json` dependencies
- `npm install` completes without errors
- `import { LineChart } from 'recharts'` compiles without type errors

**Dependencies:** none (can run in parallel with Task 1-4)

---

## Phase 3: Analytics page and components

### Task 7 — Create Dracula color constants file [templates]

**Files:** `templates/web-manager/client/src/lib/dracula-colors.ts` (new), then sync to `specrails/web-manager/client/src/lib/dracula-colors.ts`

**Description:** Create a constants file exporting a `DRACULA` object with HSL string values for all palette colors (purple, cyan, green, pink, orange, red, yellow, comment). Also export `STATUS_COLORS` mapping `JobStatus` values to Dracula colors.

```ts
export const DRACULA = { purple, cyan, green, pink, orange, red, yellow, comment }
export const STATUS_COLORS: Record<string, string> = {
  completed: DRACULA.green,
  failed:    DRACULA.red,
  canceled:  DRACULA.orange,
  running:   DRACULA.cyan,
  queued:    DRACULA.comment,
}
```

**Acceptance criteria:**
- File created and exported correctly
- No magic color strings in chart components (all reference this file)

**Dependencies:** Task 6

---

### Task 8 — Create `PeriodSelector` component [templates]

**Files:** `templates/web-manager/client/src/components/analytics/PeriodSelector.tsx` (new), then sync to `specrails/web-manager/client/src/components/analytics/PeriodSelector.tsx`

**Description:** Controlled component accepting `period`, `from`, `to`, `onChange` props. Renders a row of pill buttons for `7d / 30d / 90d / All / Custom`. When "Custom" is active, renders two `<input type="date">` fields. Calls `onChange` only when a valid period is selected or (for custom) both dates are filled.

Props interface:
```ts
interface PeriodSelectorProps {
  period: AnalyticsPeriod
  from: string
  to: string
  onChange: (period: AnalyticsPeriod, from?: string, to?: string) => void
}
```

**Acceptance criteria:**
- Preset buttons apply active style matching existing navbar NavLink active pattern
- Custom date inputs are hidden unless period === 'custom'
- onChange is not called with period='custom' unless both from and to are non-empty
- Accessible: date inputs have `aria-label`

**Dependencies:** Task 5

---

### Task 9 — Create `KpiCards` component [templates]

**Files:** `templates/web-manager/client/src/components/analytics/KpiCards.tsx` (new), then sync to `specrails/web-manager/client/src/components/analytics/KpiCards.tsx`

**Description:** Renders a 4-column responsive grid (2-col on mobile) of stat cards. Each card shows: label, value (formatted), and if `kpi.*Delta !== null`, a trend badge (green up arrow for improvement, red down arrow for degradation). Cost formatted as `$0.0000` (4 decimal places). Duration formatted as `Xm Ys`. Success rate as percentage.

**Improvement direction logic:**
- Cost: lower is better (down delta → green)
- Jobs: higher is better (up delta → green)
- Success rate: higher is better (up delta → green)
- Duration: lower is better (down delta → green)

**Acceptance criteria:**
- All four cards render with correct labels
- Delta badges show correct color and arrow direction
- null delta → no badge rendered

**Dependencies:** Task 5

---

### Task 10 — Create `CostTimeline` component [templates]

**Files:** `templates/web-manager/client/src/components/analytics/CostTimeline.tsx` (new), then sync to `specrails/web-manager/client/src/components/analytics/CostTimeline.tsx`

**Description:** `LineChart` with `ResponsiveContainer` (height 220). Single `Line` for `costUsd` in `DRACULA.purple`. XAxis shows date labels in `MMM d` format (use `date-fns/format`). YAxis formats values as `$0.00`. Custom tooltip component styled as Dracula glass card. If all values are zero, renders an empty state message.

**Acceptance criteria:**
- ResponsiveContainer uses `width="100%"`
- Tooltip shows date and cost formatted to 4 decimal places
- Renders empty state "No cost data for this period" when array is empty or all zeros

**Dependencies:** Task 7

---

### Task 11 — Create `StatusBreakdown` component [templates]

**Files:** `templates/web-manager/client/src/components/analytics/StatusBreakdown.tsx` (new), then sync to `specrails/web-manager/client/src/components/analytics/StatusBreakdown.tsx`

**Description:** `PieChart` rendered as a donut (`innerRadius={60} outerRadius={90}`). Each `Cell` uses `STATUS_COLORS`. `Legend` below the chart with count + percentage per status. Custom tooltip.

**Acceptance criteria:**
- Donut hole is visible (innerRadius > 0)
- Colors match `STATUS_COLORS` for each status value
- Shows "No jobs in this period" empty state when array is empty

**Dependencies:** Task 7

---

### Task 12 — Create `DurationHistogram` component [templates]

**Files:** `templates/web-manager/client/src/components/analytics/DurationHistogram.tsx` (new), then sync to `specrails/web-manager/client/src/components/analytics/DurationHistogram.tsx`

**Description:** `BarChart` with 5 bars (one per bucket). Bars colored in `DRACULA.cyan`. Below the chart, render three inline badges showing `p50`, `p75`, `p95` formatted as duration strings. Fixed bucket order: `['<1m', '1-3m', '3-5m', '5-10m', '>10m']`.

Bucket order must be enforced client-side by sorting the array against this fixed order before rendering (SQL `GROUP BY` does not guarantee order).

**Acceptance criteria:**
- Buckets appear in fixed order regardless of SQL return order
- Percentile values render below chart; "—" shown when null
- Empty state: "No duration data available"

**Dependencies:** Task 7

---

### Task 13 — Create `TokenEfficiency` component [templates]

**Files:** `templates/web-manager/client/src/components/analytics/TokenEfficiency.tsx` (new), then sync to `specrails/web-manager/client/src/components/analytics/TokenEfficiency.tsx`

**Description:** Horizontal `BarChart` with `layout="vertical"`. Two bars per command: `tokensOut` (purple) and `tokensCacheRead` (cyan). YAxis shows command names, XAxis shows token counts. Commands sorted descending by `totalTokens`.

**Acceptance criteria:**
- Bars are horizontal (layout="vertical")
- Legend identifies purple=Output tokens, cyan=Cached tokens
- Empty state: "No token data for this period"

**Dependencies:** Task 7

---

### Task 14 — Create `CommandPerformance` component [templates]

**Files:** `templates/web-manager/client/src/components/analytics/CommandPerformance.tsx` (new), then sync to `specrails/web-manager/client/src/components/analytics/CommandPerformance.tsx`

**Description:** Plain HTML table (styled with Tailwind, matching the glass-card/border pattern from existing UI). Columns: Command, Runs, Success Rate, Avg Cost, Avg Duration, Total Cost. Clicking a column header sorts by that column (asc/desc toggle). Rows sorted by total cost descending by default.

**Acceptance criteria:**
- Sort state is local to the component
- Null values display as "—"
- Success rate uses colored badge (green ≥80%, orange 50-79%, red <50%)
- Empty state: "No command data for this period"

**Dependencies:** Task 5

---

### Task 15 — Create `DailyThroughput` component [templates]

**Files:** `templates/web-manager/client/src/components/analytics/DailyThroughput.tsx` (new), then sync to `specrails/web-manager/client/src/components/analytics/DailyThroughput.tsx`

**Description:** Stacked `BarChart`. Three stacked `Bar` elements: `completed` (green), `failed` (red), `canceled` (orange). XAxis shows date in `MMM d` format. `stackId="a"` on all three bars.

**Acceptance criteria:**
- Stacking visually correct (no gap between segments)
- Legend shows all three statuses with matching colors
- Empty state: "No throughput data for this period"

**Dependencies:** Task 7

---

### Task 16 — Create `CostTreemap` component [templates]

**Files:** `templates/web-manager/client/src/components/analytics/CostTreemap.tsx` (new), then sync to `specrails/web-manager/client/src/components/analytics/CostTreemap.tsx`

**Description:** Recharts `Treemap` with `ResponsiveContainer`. Each tile represents one command. Size = `totalCostUsd`. Color cycles through `[DRACULA.purple, DRACULA.cyan, DRACULA.green, DRACULA.pink, DRACULA.orange]` by index. Custom `content` prop renders command name + cost inside each tile. Filter out entries with `totalCostUsd === 0`.

**Acceptance criteria:**
- Tiles are sized proportionally to cost
- Zero-cost commands excluded
- Tile labels truncated with ellipsis if too small
- Empty state: "No cost data for this period"

**Dependencies:** Task 7

---

### Task 17 — Create `BonusMetrics` component [templates]

**Files:** `templates/web-manager/client/src/components/analytics/BonusMetrics.tsx` (new), then sync to `specrails/web-manager/client/src/components/analytics/BonusMetrics.tsx`

**Description:** Two sub-sections:
1. Stat row: Cost per Success, API Efficiency %, Failure Cost (3 cards)
2. Model Breakdown table: model name, job count, total cost

**Acceptance criteria:**
- null values shown as "—"
- API Efficiency formatted as percentage (e.g., "73%")
- Model breakdown table is not sortable (display-only)
- Empty model breakdown: "No model data for this period"

**Dependencies:** Task 5

---

### Task 18 — Create `AnalyticsPage` [templates]

**Files:** `templates/web-manager/client/src/pages/AnalyticsPage.tsx` (new), then sync to `specrails/web-manager/client/src/pages/AnalyticsPage.tsx`

**Description:** Top-level page component. Owns `period`, `from`, `to`, `data`, `loading`, `error` state. On mount and on period change, fetches `/api/analytics?period=...&from=...&to=...`. Renders:

```
<h1>Analytics</h1>
<PeriodSelector ... />
{loading && <SkeletonGrid />}
{error && <ErrorBanner />}
{data && (
  <div className="space-y-6">
    <KpiCards kpi={data.kpi} />
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <CostTimeline data={data.costTimeline} />
      <StatusBreakdown data={data.statusBreakdown} />
      <DurationHistogram
        data={data.durationHistogram}
        percentiles={data.durationPercentiles}
      />
      <TokenEfficiency data={data.tokenEfficiency} />
    </div>
    <CommandPerformance data={data.commandPerformance} />
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <DailyThroughput data={data.dailyThroughput} />
      <CostTreemap data={data.costPerCommand} />
    </div>
    <BonusMetrics data={data.bonusMetrics} />
  </div>
)}
```

`SkeletonGrid`: 6 pulse-animated `div` elements mimicking card heights.
`ErrorBanner`: red bordered card with error message and a "Retry" button.

**Acceptance criteria:**
- Default period is `'7d'` on mount
- On period change, previous fetch is not double-counted (use AbortController or ignore stale results with a local request ID)
- Skeleton shown while loading
- Error banner shown on network failure

**Dependencies:** Tasks 8–17

---

## Phase 4: Routing and navigation

### Task 19 — Add `/analytics` route to `App.tsx` [templates]

**Files:** `templates/web-manager/client/src/App.tsx`, then sync to `specrails/web-manager/client/src/App.tsx`

**Description:** Import `AnalyticsPage` and add `<Route path="/analytics" element={<AnalyticsPage />} />` between the `/jobs/:id` route and the `/settings` route. The catch-all `<Navigate to="/" replace />` already handles unknown paths.

**Acceptance criteria:**
- Navigating to `/analytics` renders `AnalyticsPage`
- All existing routes unaffected
- `tsc --noEmit` passes

**Dependencies:** Task 18

---

### Task 20 — Update `Navbar.tsx` with Analytics nav link [templates]

**Files:** `templates/web-manager/client/src/components/Navbar.tsx`, then sync to `specrails/web-manager/client/src/components/Navbar.tsx`

**Description:** Add a center navigation group between the wordmark and the right-side actions. The center group contains:
- **Home** NavLink to `/` (exact match) with `LayoutDashboard` icon from lucide-react
- **Analytics** NavLink to `/analytics` with `BarChart3` icon

Both use the same active/inactive `cn(...)` pattern as the existing Settings NavLink. The `end` prop must be set on the Home NavLink to prevent it matching on every route.

Layout change: the navbar flex container becomes `justify-between` with three groups: wordmark (left), nav links (center), actions (right).

**Acceptance criteria:**
- Home and Analytics links appear in navbar
- Active link highlighted when on corresponding route
- Home link does not highlight when on `/analytics` or `/settings` (`end` prop set)
- Settings icon remains on the right side
- All existing navbar elements (Docs, GitHub, Settings) preserved

**Dependencies:** Task 19

---

## Phase 5: Spec and template sync

### Task 21 — Create `openspec/specs/web-manager-analytics/spec.md` [core]

**Files:** `openspec/specs/web-manager-analytics/spec.md` (new)

**Description:** Copy the "New spec" section from `delta-spec.md` into its own file. Add the spec directory.

**Acceptance criteria:**
- File exists at correct path
- Follows the same Requirement/Scenario format as existing specs
- No references to implementation details (specs describe behavior, not code)

**Dependencies:** none (can be done at any time)

---

### Task 22 — Update `openspec/specs/web-manager-dashboard/spec.md` [core]

**Files:** `openspec/specs/web-manager-dashboard/spec.md`

**Description:** Append the "Modified spec" section from `delta-spec.md`: add the requirement and scenario describing the three-item navbar navigation.

**Acceptance criteria:**
- Existing spec content is unmodified
- New scenario appended with correct heading level

**Dependencies:** none

---

## Sync checklist (applies after each task)

For every file modified or created under `templates/web-manager/`:
- [ ] Apply identical change to `specrails/web-manager/`
- [ ] Verify no `{{PLACEHOLDER}}` variables left unreplaced in `specrails/web-manager/`
- [ ] Run `npm run typecheck` in `specrails/web-manager/` after each sync

For server changes, additionally:
- [ ] Run `npm test` in `specrails/web-manager/`

---

## Task ordering summary

```
1 (types) → 2 (analytics.ts) → 3 (route) → 4 (tests)
                                               ↑
6 (recharts) → 7 (colors) → 8..17 (components) → 18 (page) → 19 (route) → 20 (navbar)
                    ↑
               5 (client types)

21, 22 — independent, can run any time
```
