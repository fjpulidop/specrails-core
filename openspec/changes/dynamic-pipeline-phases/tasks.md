## 1. Command frontmatter — phase declarations

- [x] 1.1 Add YAML frontmatter with `phases` to `implement.md` (architect, developer, reviewer, ship)
- [x] 1.2 Add YAML frontmatter with `phases` to `batch-implement.md` (architect, developer, reviewer, ship)
- [x] 1.3 Add `phases` field to `product-backlog.md` frontmatter (analyst)
- [x] 1.4 Add `phases` field to `health-check.md` frontmatter (empty — no phases)
- [x] 1.5 Add `phases` field to remaining commands (compat-check, refactor-recommender, update-product-driven-backlog, why) — empty or appropriate phases

## 2. Server — config and types

- [x] 2.1 Add `phases` array to `CommandInfo` interface in `config.ts` with `{ key, label, description }` entries
- [x] 2.2 Update `parseFrontmatter()` in `config.ts` to parse the `phases` YAML array into structured objects
- [x] 2.3 Update `PhaseName` and `PhaseState` types in `types.ts` to support dynamic phase keys (string instead of union)
- [x] 2.4 Update `WsMessage` init type to include `phaseDefinitions` array

## 3. Server — dynamic phase hooks

- [x] 3.1 Refactor `hooks.ts` to accept a dynamic phase set per job instead of hardcoded `PHASE_NAMES`
- [x] 3.2 Add `setActivePhases(phases)` function that hooks uses to validate incoming events
- [x] 3.3 Update `resetPhases()` to reset only the active command's declared phases
- [x] 3.4 Update `getPhaseStates()` to return states for the active phase set only

## 4. Server — structured event broadcasting

- [x] 4.1 In `queue-manager.ts`, broadcast a `type: 'event'` WebSocket message for each parsed JSON stdout event (alongside existing `emitLine` for log buffer)
- [x] 4.2 Include `jobId`, `event_type`, `source`, `payload`, `timestamp`, and `seq` in the event message
- [x] 4.3 Update the WebSocket init message to include `phaseDefinitions` from the active command

## 5. Client — dynamic pipeline component

- [x] 5.1 Update `PhaseMap` type in `usePipeline.ts` to `Record<string, PhaseState>` instead of fixed keys
- [x] 5.2 Update `PipelineProgress.tsx` to accept a `phaseDefinitions` prop and render dynamically
- [x] 5.3 Hide the pipeline bar entirely when `phaseDefinitions` is empty
- [x] 5.4 Update `usePipeline.ts` to initialize phases from `phaseDefinitions` in the init message

## 6. Client — structured live events and WebSocket URL

- [x] 6.1 In `JobDetailPage.tsx`, handle `type: 'event'` WebSocket messages by creating proper `EventRow` objects with correct `event_type` and `payload`
- [x] 6.2 Replace hardcoded `ws://localhost:4200` in `JobDetailPage.tsx` with origin-derived URL
- [x] 6.3 Replace hardcoded WebSocket URL in any other client files (check `usePipeline.ts`, `DashboardPage.tsx`)
- [x] 6.4 Update `JobDetailPage.tsx` to receive and use `phaseDefinitions` from WebSocket init or API

## 7. Verification

- [ ] 7.1 Run `/sr:implement` and verify 4-phase pipeline renders and transitions correctly
- [ ] 7.2 Run `/sr:product-backlog` and verify single-phase (analyst) pipeline renders or no pipeline if no hooks
- [ ] 7.3 Run `/sr:health-check` and verify no pipeline bar appears
- [ ] 7.4 Verify live log viewer shows assistant messages, tool calls, and result summaries during execution
- [ ] 7.5 Verify historical log view matches live log view for the same job
