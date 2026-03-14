# Parallel Implementation Session — 2026-03-07

## Overview

Full parallel implementation pipeline run: backlog analysis → explore → architect → develop → review → PR.

**PR:** https://github.com/fjpulidop/deckdex_mtg/pull/59
**CI:** All green (502 backend tests, 36 frontend tests)
**Branch:** `feat/analytics-tests-deck-batch-avatar-fix`

---

## Phase 0: Backlog Analysis (`/opsx:backlog`)

Launched an analyst subagent to scan all specs, archived changes, and actual code across 8 areas. Full results:

### UI/UX

| # | Item | Description | Value | Effort | Status |
|---|------|-------------|-------|--------|--------|
| 1 | Collection Insights autocomplete/suggestions | Implement search autocomplete and suggestion chips for insights widget with API integration | High | Medium | Partial |
| 2 | Card gallery view sorting & A11y | Add sort controls to gallery view, semantic roles (role="list"), and image error fallback UI | High | Low | Partial |
| 3 | Animated backgrounds performance | Optimize AetherParticles and CardMatrix for smooth 30 FPS, with reduced-motion support | Medium | Medium | Mostly done |
| 4 | Accessible modal wrapper component | Create reusable `AccessibleModal` with focus trapping, keyboard handling, and ARIA attributes | High | Medium | Done |
| 5 | Mana symbol icons in color filter buttons | Display Scryfall mana symbol SVGs instead of plain letters in filter toggles | Medium | Low | Mostly done |
| 6 | Import list modal with file/text tabs | Create file/text input modal for card list imports with resolve integration | High | Medium | Partial |
| 7 | Theme persistence cross-tab sync | Add `StorageEvent` listener for real-time theme sync across browser tabs | High | Low | Done |
| 8 | Login page dark mode styling | Apply `dark:` Tailwind variants to login page for consistency with app theme | High | Low | Done |
| 9 | I18n coverage and language switcher | Replace all hardcoded UI strings with translation keys and add language switcher to navbar | High | Medium | Partial |
| 10 | Global jobs bar restoration on app mount | Restore running/completed jobs from GET /api/jobs on app load and re-sync on window focus | High | Medium | Done |
| 11 | Update Prices button in CardTable toolbar | Add tertiary-styled "Update Prices" button triggering price update jobs | Medium | Low | Done |
| 12 | Error message role="alert" attributes | Add role="alert" to all error divs in modals and form components | Medium | Low | Mostly done |
| 13 | Icon-only button aria-label attributes | Ensure all icon buttons (close, photo upload, etc.) have descriptive aria-labels | Medium | Low | Mostly done |
| 14 | Form label/input htmlFor associations | Associate all form labels with inputs via htmlFor/id pairs throughout app | Medium | Low | Mostly done |
| 15 | CardTable sortable header keyboard access | Make column headers keyboard-navigable with aria-sort attribute | Medium | Medium | Mostly done |
| 16 | QuantityCell keyboard accessibility | Allow keyboard users to enter quantity edit mode via Enter/Space | Low | Low | Partial |

### Cards & Collection

| # | Item | Description | Value | Effort | Status |
|---|------|-------------|-------|--------|--------|
| 1 | Import review step in wizard | Create 6-step import wizard with review step showing matched/unresolved cards and user corrections | High | High | Partial |
| 2 | Card detail lightbox/zoom modal | Add image lightbox overlay on detail modal with zoom-in/zoom-out cursor feedback | High | Medium | Partial |
| 3 | Card name autocomplete hybrid resolver | Implement collection + Scryfall autocomplete with format detection and full card resolution on selection | High | Medium | Partial |
| 4 | scryfall_id column population on first image fetch | Lazily populate `cards.scryfall_id` when image is first requested | Medium | Low | Mostly done |
| 5-12 | Various completed items | Import resolve, price update, image cache, catalog, ImageStore, BYTEA migration, cache headers, cross-user images | Various | Various | Done |

### Decks

| # | Item | Description | Value | Effort | Status |
|---|------|-------------|-------|--------|--------|
| 1 | Deck CRUD API endpoints | Implement POST/GET/PATCH/DELETE /api/decks with card management endpoints | High | High | Mostly done |
| 2 | Deck card management (add/remove/commander) | Implement card-in-deck operations with quantity and commander flag support | High | Medium | Mostly done |
| 3 | Deck import from text format | Implement POST /api/decks/{id}/import parsing MTGO-style text with commander section | High | Medium | Partial |
| 4 | Deck builder UI with grid & modal | Create grid of deck tiles, add tile, and detail modal layout | High | High | Partial |
| 5 | Deck card picker from collection | Implement modal allowing filter by type/color and sort by mana cost | High | High | Partial |
| 6-10 | Various deck UI items | Card detail from deck, list rows, hover preview, export, import modal | Various | Various | Partial |

### Analytics & Prices

| # | Item | Description | Value | Effort | Status |
|---|------|-------------|-------|--------|--------|
| 1 | Analytics dashboard with charts | Implement rarity, color identity, CMC, sets, type charts with drill-down | High | High | Partial |
| 2-13 | Various analytics items | Type distribution, radar chart, mana curve, price history, KPIs, drill-down, buffered updates | Various | Various | Partial-Done |

### Backend & API

| # | Item | Description | Value | Effort | Status |
|---|------|-------------|-------|--------|--------|
| 1 | Filter options endpoint | Add GET /api/cards/filter-options | High | Low | Mostly done |
| 2-12 | Various backend items | Analytics endpoints, insights, WebSocket, auth, SQL filtering, import tests, admin | Various | Various | Partial-Done |

### Infra & DevOps — Mostly Done
### Auth & Users — Mostly Done (profile modal partial)
### Core/CLI — All Complete

### Quick Wins
1. Mana symbol icons in color filter buttons (UI/UX)
2. Filter options endpoint (Backend)
3. Deck list row: quantity, name, mana cost icons (Decks)
4. Mythic rares count KPI (Analytics)
5. Average price KPI card (Analytics)

### Recommended Next Sprint
1. Analytics dashboard with charts
2. Deck builder UI with grid & modal
3. User profile modal & avatar crop

---

## Phase 1: Explore (parallel)

Three explorer agents launched in parallel to investigate each area.

### Analytics Explorer Findings
- **Analytics dashboard is substantially complete** — all 5 chart types, KPIs, drill-down, price history working
- `/api/analytics/type` violates architecture: raw SQL in route layer
- Test coverage gaps: only rarity and sets have tests (7 total), zero for cmc, color-identity, type, price history
- Recharts ^3.7.0 installed and used throughout
- Competitive advantage: no major platform offers interactive collection-level analytics with cross-filtering

### Deck Builder Explorer Findings
- **Feature-complete against spec** — all CRUD, card management, import/export, commander support working
- N+1 bug: DeckCardPickerModal fires N sequential HTTP requests when adding multiple cards
- Hardcoded EUR currency in DeckDetailModal
- Zero import endpoint tests
- Unique differentiator: DeckDex is the only platform where decks reference cards from YOUR actual collection

### User Profile Explorer Findings
- **Avatar upload is completely broken** — critical bug chain:
  1. User crops image → canvas produces `data:image/jpeg;base64,...`
  2. Backend `_validate_avatar_url()` rejects it: scheme="data" ≠ "https" → 400
- ProfileModal uses raw `fetch()` instead of API client (convention violation)
- No avatar cache invalidation, no display name length validation
- 40+ auth tests exist but none cover the data URI path

---

## Phase 2: Select

**Key pivot from original plan:** Instead of building new features (already done), we focused on critical bugs and quality gaps.

| Area | Idea | Rationale | Estimated Complexity |
|------|------|-----------|---------------------|
| **Analytics** | Analytics test coverage + `/type` endpoint architecture fix | 5 of 7 endpoints have zero tests; `/type` route executes raw SQL violating layer conventions | Medium (~3hr) |
| **Decks** | Batch card add endpoint + N+1 fix | Adding 10 cards fires 10 sequential HTTP requests. New batch endpoint + frontend wiring | Medium (~2hr) |
| **User Profile** | Fix broken avatar upload + API client compliance | Avatar crop feature completely non-functional — backend rejects data URIs. Raw fetch violates conventions | Medium (~3hr) |

User confirmed with "yes".

---

## Phase 3a: Architect (parallel)

Three architect agents launched in parallel, each creating OpenSpec artifacts.

### Analytics: `analytics-test-coverage-and-type-fix`
- Added `get_type_line_data()` to CollectionRepository ABC
- Implemented in PostgresCollectionRepository with proper SQL delegation
- Designed 20 new tests across 4 test classes
- All tests use established double-mock pattern with cache clearing in setUp

### Decks: `batch-card-add-deck`
- New `add_cards_batch()` in DeckRepository: validates all card IDs in single SELECT, inserts in one transaction
- New `POST /api/decks/{id}/cards/batch`: accepts `{card_ids: [int]}`, returns `{added, not_found, deck}`
- Frontend: replace N+1 loop with single `api.addCardsToDeckBatch()` call
- DeckDetailModal: deduplicate formatCurrency using shared function
- 4 batch tests + 3 import endpoint tests

### Avatar: `fix-avatar-upload-and-profile-api`
- Regex-based data URI validation: `_DATA_URI_RE` matching `data:image/(jpeg|png|gif|webp);base64,...`
- Avatar cache invalidation via `Path.glob(f"{user_id}_*")` after successful update
- Pydantic v2 `Field(max_length=100)` for display name
- `api.updateProfile()` following existing pattern of `updateDeck`
- 6 atomic tasks with 8 new test methods

---

## Phase 3b: Implement (parallel, isolated worktrees)

Three developer agents launched in isolated git worktrees.

### Results

| Feature | Tasks | CI Verified | Notes |
|---------|-------|-------------|-------|
| Analytics tests | All complete | Yes (473 tests pass) | Only developer that could run Bash |
| Deck batch add | 7/7 complete | No (Bash blocked) | Code complete, needs reviewer verification |
| Avatar fix | 6/6 complete | No (Bash blocked) | Code complete, needs reviewer verification |

**Issue:** Two developers couldn't run Bash in worktree context — all CI verification deferred to reviewer.

---

## Phase 4: Merge & Review

### 4a. Merge Strategy

Identified feature-specific files per worktree via `git diff --name-only`:

**Analytics:** `analytics.py`, `repository.py`, `test_api_extended.py`
**Deck batch:** `decks.py`, `deck_repository.py`, `DeckCardPickerModal.tsx`, `DeckDetailModal.tsx`, `test_decks.py`
**Avatar fix:** `auth.py`, `ProfileModal.tsx`, `test_auth_e2e.py`

**Shared files requiring manual merge:**
- `client.ts` — deck added `BatchAddResult` + `addCardsToDeckBatch`; avatar added `ProfileUpdateBody` + `ProfileResponse` + `updateProfile`. Used deck version as base, spliced avatar additions.
- `en.json` / `es.json` — avatar added `nameTooLong` key. Added to main repo's version.

### 4b. Reviewer

Single reviewer agent ran full CI suite:

| Check | Status | Notes |
|-------|--------|-------|
| ruff check | pass | No issues |
| ruff format | pass (after fix) | `test_auth_e2e.py` had formatting issues |
| pytest | pass — 502 tests | 4 failures fixed |
| npm run lint | pass | No ESLint issues |
| tsc --noEmit | pass | No TypeScript errors |
| vitest | pass — 36 tests | No failures |

**Issues Fixed by Reviewer:**
1. `ruff format` failure in `test_auth_e2e.py` — multi-line `with` statements
2. `test_profile_update_display_name_too_long` expected 422 but project returns 400 — fixed assertion
3. Two cache tests had assertions outside `with tempfile.TemporaryDirectory()` block — indented inside
4. `test_batch_add_empty_card_ids` — `deck_client` fixture used `scope="module"`, mock accumulated calls — changed to `scope="function"`

### 4c. Git & PR

Created branch `feat/analytics-tests-deck-batch-avatar-fix` with 4 commits:

1. `test: add analytics endpoint test coverage and fix /type architecture violation`
2. `feat: add batch card add endpoint for decks, fix N+1 request pattern`
3. `fix: repair broken avatar upload (data URI validation, API client migration)`
4. `chore: update agent memory from parallel implementation`

**PR #59:** https://github.com/fjpulidop/deckdex_mtg/pull/59

### 4d. CI

| Job | Status | Duration |
|-----|--------|----------|
| Backend (Python 3.11) | pass | 49s |
| Frontend (Node 20) | pass | 25s |

---

## Final Report

| Area | Feature | Change Name | Architect | Developer | Reviewer | Tests | CI | Status |
|------|---------|-------------|-----------|-----------|----------|-------|----|--------|
| Analytics | Test coverage + /type fix | analytics-test-coverage-and-type-fix | ✅ | ✅ | ✅ | 502 pass | ✅ | Complete |
| Decks | Batch card add + N+1 fix | batch-card-add-deck | ✅ | ✅ | ✅ | 502 pass | ✅ | Complete |
| Auth | Avatar upload fix + API client | fix-avatar-upload-and-profile-api | ✅ | ✅ | ✅ | 502 pass | ✅ | Complete |

### Files Changed

**Analytics:**
- `backend/api/routes/analytics.py` — /type endpoint refactored to use repository
- `deckdex/storage/repository.py` — new `get_type_line_data` method
- `tests/test_api_extended.py` — 20 new tests (color-identity, cmc, type, price-history)

**Decks:**
- `backend/api/routes/decks.py` — new `POST /{id}/cards/batch` endpoint
- `deckdex/storage/deck_repository.py` — new `add_cards_batch()` method
- `frontend/src/components/DeckCardPickerModal.tsx` — single batch call replaces N+1 loop
- `frontend/src/components/DeckDetailModal.tsx` — shared `formatCurrency` import
- `tests/test_decks.py` — 7 new tests (4 batch + 3 import)

**Avatar:**
- `backend/api/routes/auth.py` — data URI validation, max-length, cache invalidation
- `frontend/src/api/client.ts` — `ProfileUpdateBody`, `ProfileResponse`, `updateProfile()`
- `frontend/src/components/ProfileModal.tsx` — migrated from raw fetch to API client
- `frontend/src/locales/en.json` / `es.json` — `nameTooLong` key
- `tests/test_auth_e2e.py` — 7 new profile tests

---

## Retrospective: Pipeline Improvements

### Issues Encountered

1. **Developers in worktrees couldn't run Bash** — 2 of 3 developers completed code but couldn't verify or archive
2. **Shared file merging was manual** — client.ts, en.json, es.json modified by multiple developers
3. **Worktree changes were uncommitted** — no git commit = hard to identify feature-specific changes
4. **Recurring test quality issues** — fixture scope, temp dir assertions, HTTP 400 vs 422
5. **Backlog was stale** — original sprint features were already implemented

### Changes Made

**`parallel-implement.md`:**
- Added Bash permission warning for worktree agents
- New Phase 3a.1: shared file conflict prevention (ownership assignment before launching developers)
- Developer prompt: added `git commit` step, removed archive responsibility, added test quality rules
- Phase 4a: explicit merge strategy for shared vs feature-specific files

**`auto-implement.md`:**
- Added test quality rules (fixture scope, temp dir, HTTP 400)

**`developer.md` agent:**
- Fixed outdated "No auth" warning → documents actual auth system
- Added test quality warnings

**`CLAUDE.md`:**
- Updated auth warning from "No auth" to actual OAuth + JWT documentation
- Added test isolation warning

**`MEMORY.md` (persistent memory):**
- Created with parallel implementation lessons, test patterns, project conventions

### Future Considerations
- Skip explore phase when input is already specific (detect or `--skip-explore` flag)
- Use `git cherry-pick` instead of file copying when developers commit in worktrees
- Run lightweight pre-merge check per worktree before merging to main
