# PHASE_LOG.md — what was actually built, in order

Append-only journal. Each phase gets one section. Read this when starting a new phase so you know the current state of the world.

For the plan, see [BUILD_PLAN.md](BUILD_PLAN.md). For invariants, see [CLAUDE.md](CLAUDE.md).

---

<!-- Phase entries are appended below as work completes. Newest at bottom. -->

## Phase 0 — Foundation reset (completed 2026-05-21)

**Scope**: governance files, Output Files content viewer fix + syntax highlighting, wipe stale data per user permission, graceful shutdown, double-run debounce, tighter reaper.

**Built**:

1. **Governance scaffold**
   - `CLAUDE.md` — product vision, architecture, conventions, "do not" list, key file map. Auto-loaded every session.
   - `BUILD_PLAN.md` — 12-phase plan with ✓/🔄/⏳ status markers. Source of truth for "what's next."
   - `PHASE_LOG.md` — this file. Append-only journal, one section per phase.
   - 5 auto-memory entries at `~/.claude/projects/.../memory/`: enterprise-polish, plan-before-code, ask-before-destructive, qaai-product-vision, phase-protocol.

2. **Output Files content viewer fixed** ([src/pages/OutputFiles.jsx](src/pages/OutputFiles.jsx))
   - Root cause: frontend called `/output-files/${name}` which URL-encoded slashes (`tests%2Fqaai-ui/...`) and hit the legacy `/:name` route whose regex `^[a-zA-Z0-9_.-]+\.spec\.ts$` rejected the path → 400 → silent fallback to empty.
   - Fix: route through the existing `/file/*` viewer with per-segment URL encoding that preserves the slash structure.
   - Added: tiny in-house TypeScript syntax highlighter at [src/lib/highlightTs.js](src/lib/highlightTs.js) using the project's token palette. No new dependency.

3. **DB wipe** (per explicit user permission "you can clean all the runs, I will re-upload")
   - Deleted: 5 Runs (+ cascaded RunResults), 7 AgentRuns, 4 GovernancePRs, 47 BlockedItems, 12 Scenarios, 21 TestCases, 3 Documents, 3 Requirements.
   - Kept: Project, KnowledgeBaseLocators, integrations, AuditLog.

4. **Graceful shutdown** ([server/index.js](server/index.js), [server/services/sessionRegistry.js](server/services/sessionRegistry.js))
   - SIGTERM / SIGINT handler aborts in-flight Claude calls (via cancelRegistry), tears down MCP browser sessions (new `sessionRegistry.closeAll`), closes WS connections, disconnects Prisma, exits.
   - Prevents Chromium child-process orphans after Ctrl-C on the dev server.

5. **Stale-run reaper tightened**
   - Interval: 10 min → 30 s (configurable via `QAAI_REAPER_INTERVAL_SEC`).
   - Status flip: `failed` → `cancelled` so the recommendation engine + Reports distinguish "user/system stopped" from "test failed".

6. **Double-run debounce** ([server/routes/agents.js](server/routes/agents.js))
   - New `blockIfRunInProgress(req, project)` helper checks for a `running` Run row OR a live cancel token.
   - Applied to `/agents/start`, `/agents/execute`, `/agents/rerun-failed`.
   - Returns 409 `RUN_IN_PROGRESS` with a useful message. ApiError already propagates this to the toast in the frontend, so the user sees "A pipeline is already running…" on a double-click.

**Decisions** (recorded here so future phases respect them):

- **Wipe scope included documents/requirements**, not just runs, because user said "I will re-upload" — they expected a clean slate. Future regenerations will be fresh as a result.
- **Reaper interval = 30 s, cutoff = 30 min**. Cutoff stays generous so legitimate long-running Conductor pipelines aren't killed mid-flight; interval is fast so stuck-RUNNING badges clear within the next refresh.
- **Double-run check is server-side**, not a client debounce, because it must survive two browser tabs and two users in the same project.
- **In-house syntax highlighter (no Prism/Shiki dep)** — bundle stays at ~1 MB and the colour palette stays consistent with the rest of the design.

**Open items**: nothing — phase clean.

**Files touched**:
- `CLAUDE.md` (new)
- `BUILD_PLAN.md` (new)
- `PHASE_LOG.md` (new)
- 5 memory files (new)
- `src/pages/OutputFiles.jsx`
- `src/lib/highlightTs.js` (new)
- `server/index.js`
- `server/services/sessionRegistry.js`
- `server/routes/agents.js`
- `prisma/dev.db` (wipe via prisma client — no migration, data only)

**Verification**:
- `npx vite build` clean (1627 modules, 6.79 s).
- `node --check` clean on index.js, agents.js, outputFiles.js, sessionRegistry.js, cancelRegistry.js.
- Manual: dev server restarted, Output Files page now loads file content with TS-coloured tokens.

**Phase 0 follow-up (2026-05-21)**: user flagged that Output Files still showed leftover specs after the DB wipe — the disk side wasn't cleaned. Wiped `playwright/{tests,pages,fixtures,utils,test-results,results}/*` to match the DB state. Configs (`playwright.config.js`, `playwright.config.ts`, `package.json`, `tsconfig.json`) kept. Phase 6 scope updated to add an in-UI "Clear all output files" action AND auto-clear on regenerate so the desync never recurs.

## Phase 1 — Run Suite (upload + first AI call) (completed 2026-05-21)

**Scope**: redesign Run Suite as the user's first-touchpoint after Project Setup. Category-aware buckets, cost preview, inline streaming Architect view, no floating widget noise.

**Built**:

1. **Cost estimator helper** ([src/lib/costEstimate.js](src/lib/costEstimate.js))
   - `estimateArchitectCost(texts)` returns `{ inputTokens, outputTokensMax, costUsd, costDisplay, secondsEstimate }`.
   - Pricing: $3/M input, $15/M output (Claude Sonnet 4.6 list price).
   - 4-chars/token rule for English; system-prompt overhead modeled as +1500 tokens.
   - Duration estimate: `20 + inputTokens/2000` seconds, capped at 120.

2. **Run Suite redesign** ([src/pages/RunSuite.jsx](src/pages/RunSuite.jsx))
   - `CATEGORY_META` map drives a single source of truth for icon / label / blurb / colour per category. Mirrors the server's `guessCategory()` enum.
   - Requirements now grouped into category buckets (BRD / Release Notes / User Stories / API Spec / Other) — each bucket shows its own header + count + blurb + per-item rows.
   - Each upload-source requirement gets an **inline category dropdown** — re-tag without leaving the page. Calls existing `PUT /api/projects/:p/documents/:id/category`. Optimistic UI; rolls back on error. Hidden for ADO/Jira items (server endpoint doesn't support pulled items).
   - **Cost preview card** (`CostPreviewCard`) appears whenever there are requirements: shows input tokens, output max, Claude cost in USD, duration estimate. Inline reason hint when Claude not configured or no BRD detected.
   - **Inline streaming Architect banner** (`ArchitectBanner`): replaces toast.info noise. Subscribes to `agent.phase.*` WS events scoped to current project. Shows last log line + elapsed time + mini scrollable log tail (last 8 lines). Real Terminate button (uses cancelRegistry abort, ships in Phase 0).
   - Generate button now disables and titles informatively: "Configure Claude…" / "Upload at least one…" / "Architect is already running" / "Generate scenarios from N…"

3. **Global indicator suppression on /run-suite** ([src/components/AgentRunningIndicator.jsx](src/components/AgentRunningIndicator.jsx))
   - Existing `ownedByPage` check extended: when phase is architect/analyst AND route is `/run-suite` or `/test-cases`, the page itself owns the banner; the global widget hides. Across-page persistence preserved when the user navigates away.

4. **Convention added to CLAUDE.md**: "Inline phase banners over floating widgets" — the page that owns an action surfaces phase progress inline; the global indicator only handles cross-page persistence. Pattern reference points at `ArchitectBanner`.

**Decisions** (recorded for future phases):

- **Cost model uses list price.** When prompt caching / batch discounts are introduced, the helper should expose a `discount` parameter — but for now the displayed price is the worst case the user pays, which is the honest signal.
- **Category re-tagging is upload-only.** ADO/Jira items can't be re-categorised yet because the server endpoint only mirrors onto `Document` rows. If/when we want category override for pulled items, we'd add a Requirement-level PUT — but the Architect doesn't read category at requirement-fetch time anyway, so it's low priority.
- **No floating widget on /run-suite during architect.** Consistent with /test-cases. The global indicator is now exclusively "I have run in another tab; here's where it's at."
- **Generate copy changed**: "Generate scenarios & test cases" → "Generate scenarios". The Architect produces both, but "scenarios" is the user-facing primitive — the Test Cases page is where the cases become tangible.

**Open items**: nothing scoped to Phase 1. Token estimate is approximate by ~10% (4-chars-per-token rule); good enough for pre-flight, real usage is logged from `resp.usage` after the call lands (Phase 4 / cost tile).

**Files touched**:
- `src/lib/costEstimate.js` (new)
- `src/pages/RunSuite.jsx` (full redesign — kept ADO/Jira pull paths, dropzone, discrepancy panel)
- `src/components/AgentRunningIndicator.jsx` (extended `ownedByPage` to /run-suite)
- `CLAUDE.md` (added "Inline phase banners over floating widgets" convention)

**Verification**:
- `npx vite build` clean (1628 modules, 10.38 s).
- Manual smoke deferred to user — pending fresh document upload to exercise the full path.

## Phase 2 — Test Cases hardening (completed 2026-05-21)

**Scope**: layer real-world workflow on top of the Phase 0/visual redesign — clickable stat pills that scroll, a confidence axis, bulk operations, per-scenario regenerate, Cmd+K search, run cost preview, and a non-misleading smart-select fallback.

**Built**:

1. **Smart-select fallback fixed** ([server/services/agents/analyst.js](server/services/agents/analyst.js), [server/routes/analyst.js](server/routes/analyst.js))
   - Empty release notes used to mark ALL scenarios as impacted ("20 of 20 impacted") which was a UI cliff — the user couldn't tell signal from noise.
   - Service now returns `{ impacted: [], code: 'NO_RELEASE_NOTES' }`; route surfaces HTTP 400 with a clear message.
   - Client catches the specific code and shows an actionable toast pointing back to Run Suite.

2. **Per-scenario regenerate endpoint** ([server/routes/scenarios.js](server/routes/scenarios.js))
   - `POST /api/projects/:p/scenarios/:id/regenerate` — Architect call scoped to one scenario's module.
   - Filters requirements by module-name substring; falls back to full set if no match.
   - Calls existing architect.run with cancel-token wired (cancellation respected).
   - Replaces only scenarios whose `module` matches the target so 12 unrelated scenarios don't get clobbered.
   - Rate-limited (10/min/user).

3. **Stat pill scroll-to-match** ([src/pages/TestCases.jsx](src/pages/TestCases.jsx))
   - Each scenario card registers a DOM ref via `scenarioRefs.current.set(id, node)`.
   - On `statusFilter` / `confidenceMin` change, RAF scrolls the first matching card into view.
   - `skipScrollRef` guards the initial mount so the page doesn't jump on load.

4. **Confidence filter chips** — third filter axis (≥80% / ≥90%), combines with priority + type + status. Counts reflect what's left after the other filters apply.

5. **Bulk-select mode** — toggled via "Select" in the toolbar; adds a checkbox column to every CaseRow, lights up a sticky info-tinted bar with `N selected · Select all visible · Clear · Approve / Reject / Remove / Done`. Backed by the existing `POST /test-cases/bulk-update` endpoint (Remove = mark rejected — there's no hard-delete endpoint yet; that's Phase 12).

6. **Per-scenario kebab + regenerate** — `<MoreVertical>` button positioned absolutely on each card, outside the scenario toggle button (click-stop-propagation so it doesn't expand). Menu currently houses "Regenerate this scenario"; designed to grow. While regenerating, an info-tinted strip appears at the top of the card with a spinner + "the Architect is running…"

7. **Cmd+K search modal** — global keydown listener on `⌘K` / `⌥K`; opens a Spotlight-style palette. Flattens all cases, filters by name + assertions, supports ↑↓ keyboard nav, Enter to pick. Picking a result expands its parent scenario and scrolls it into view.

8. **Run cost preview** — small two-tone "~$0.04–$0.12 · ~3 min" line under the primary Run button. Range covers 1× to 3× Conductor attempts (MAX_CONDUCTOR_ATTEMPTS). Reuses `estimateArchitectCost` helper from Phase 1.

**Decisions** (recorded for future phases):

- **Bulk "Remove" is currently a status flip to 'rejected'**, not a hard delete. Rejected cases stay out of Run scope (only `approved` cases run) and remain visible under the Rejected pill if the user wants to undo. True hard-delete deferred to Phase 12 (retention policies).
- **Per-scenario regenerate filters requirements by module-name substring.** Simple and predictable; misses some edge cases (e.g. a requirement that mentions the feature without using the module name verbatim). Good enough for v1; can graduate to embedding-based matching later if needed.
- **Cmd+K search is name+assertions only.** Step text isn't searched — would 10× the index size and step text is rarely what users remember. Easy to extend if users ask.
- **Confidence chips use ≥80% and ≥90%** — not a continuous slider. Two snap-points is faster to reason about ("the high-confidence subset" vs "the very-high-confidence subset") than a free-form value.
- **No new test-case DELETE endpoint** in this phase — deliberate. Keeping the lifecycle simple (pending → approved/rejected; regenerate wipes the whole project's TCs) until Phase 12 retention work.

**Open items**: nothing scoped to Phase 2. The kebab menu shell is in place; future additions (rename, duplicate, copy steps as JSON) are one menu-item each.

**Files touched**:
- `server/services/agents/analyst.js` (NO_RELEASE_NOTES code)
- `server/routes/analyst.js` (surface NO_RELEASE_NOTES as 400)
- `server/routes/scenarios.js` (new POST /:id/regenerate)
- `src/pages/TestCases.jsx` (full hardening pass — state, handlers, header, filter card, kebab, checkbox column, search modal)

**Verification**:
- `npx vite build` clean (1628 modules, 8.34 s).
- `node --check` clean on scenarios.js, analyst.js, agents/analyst.js.
- Manual smoke deferred to user — pending fresh scenarios to exercise filters, bulk, regenerate, search.

**Phase 2 hotfix (2026-05-23)**: post-ship the user reported `Cannot access 'scrollToFirstVisible' before initialization` blocking the entire `/test-cases` route (ErrorBoundary then poisoned other routes too — known boundary-doesn't-reset-on-route-change issue, deferred). Root cause: the `useEffect` that scrolls on filter change was declared **above** the `useCallback` it referenced in its deps array, hitting JavaScript's temporal dead zone on every render. One-block swap in [src/pages/TestCases.jsx:409-428](src/pages/TestCases.jsx#L409) put the `useCallback` first. Build clean afterwards. No other change.

## Phase 3 — Live Pipeline (completed 2026-05-23)

**Scope**: redesign Theater from a vertical phase-card waterfall into a three-pane execution view with proper browser controls, polished picker, and an idle-state summary of the last completed run.

**Built**:

1. **Three-pane CSS grid** ([src/pages/Theater.jsx](src/pages/Theater.jsx))
   - `lg:grid-cols-[280px_1fr_340px]` — PhaseTimeline (left) · BrowserFrame (centre) · ActionTrail (right). Below `lg` the grid collapses to a single column in reading order so phones / narrow viewports still work.
   - Each pane is its own card with `rounded-card border shadow-card` — visually distinct, easy to skim.
   - The grid replaces the old `ol` of expandable PhaseCards entirely. No "classic view" fallback (per user preference — kept the maintenance surface small).

2. **PhaseTimeline** (in-file sub-component)
   - Vertical list of 5 phases (architect / planner / conductor / critic / supervisor) with a connector line between status dots — the dependency reading order is now visual, not implied.
   - Status dots driven by new `PHASE_STATUS_META` in [src/lib/statusMeta.js](src/lib/statusMeta.js) — `idle / running / complete / failed / cancelled`, each with dot/text/bg/border/ring tokens from the design palette. Running phases pulse with `ring-4 ring-opacity-30 animate-pulse`.
   - Click any phase → expand its dark log panel inline (auto-scrolls on new log lines). Only one phase expanded at a time so the timeline doesn't grow into 5×log monsters.
   - Attempt badge ("try 2") next to phases when conductor retries.
   - Output summary line (e.g. "12 scenarios · 38 cases", "3 waves · ~120s · 0 risks") below the status pill — uses extracted `summariseOutput` from the previous file.

3. **BrowserFrame** with full control strip (in-file sub-component)
   - **Pause / Resume**: freezes the displayed frame locally (`frozenFrame`) so subsequent WS frames don't overwrite what the user is studying. Agent keeps running — viewer-only freeze.
   - **Zoom slider 0.5–2×** with mono tabular-nums readout. Applies `transform: scale()` to the `<img>`.
   - **Fullscreen toggle** (new) — CSS expand to `fixed inset-0 z-50`, dark chrome, Esc key listener exits, top-right `Esc` chip for mouse users. Did NOT use `element.requestFullscreen()` because cross-browser quirks + cursor lock surprises beat the cleanliness savings.
   - **Pick element** — disabled until a frame exists; pressed state when armed.
   - **Reports** button surfaces when there's a `runSummary` — gives the user the option to leave for the full report, but the inline `LastRunSummary` covers the common case.

4. **PickerCandidates** ranked rendering (in-file sub-component)
   - Per-candidate row: strategy chip (testid / role / label / css / xpath) + stability bar + percentage + click-to-copy on the expression.
   - Bar colour tracks score: `success ≥ 80`, `warn ≥ 50`, `danger < 50`. Background of the chip matches the bar tone so the row is at-a-glance.
   - Copy fires a toast via the existing `useToast` so the action is acknowledged.
   - Lives at the top of the right pane (ActionTrail container) — when candidates arrive they push the action list down so they're impossible to miss.

5. **ActionTrail** sticky-to-bottom (in-file sub-component)
   - Auto-scrolls to bottom on new actions BY DEFAULT, but tracks the user's scroll position via `onScroll`. If they scroll up more than 20 px from the bottom, auto-scroll pauses so they can read history. Returning within 20 px resumes the auto-scroll.
   - Empty-state messaging branches on `conductorActive` — "Waiting for the Conductor's first action…" while running vs "Tool calls and narration will appear here once the Conductor starts." when idle.

6. **LastRunSummary** with inline expansion (in-file sub-component)
   - Idle-state card: pass / fail / blocked / skipped counts + pass-rate stacked bar + relative time.
   - "Show details" toggles an inline expansion (not a navigation) — fetches `GET /api/projects/:projectId/runs/:runId` via the existing `runs.getRun` service, renders:
     - **Top 5 failures** with status icon + TC name + module + error preview (uses `RunResult.error` or falls back to `BlockedItem.message` for blocked rows).
     - **Per-scenario breakdown** sorted by `fail + blocked` desc so the worst scenarios surface first; each row shows pass/fail/blocked/skipped counts in tabular-nums.
   - Only renders when there's a most-recent run AND no failed-cases banner is showing (the existing `RerunFailedBanner` already carries the failure-recovery context — duplicating that here would be noise).

7. **Helper extractions**
   - [src/lib/timeAgo.js](src/lib/timeAgo.js) (new) — extracted from Theater; added "just now" for < 5 s and graceful NaN handling for invalid inputs. Now also reachable from RerunFailedBanner and any future timestamp surface.
   - [src/lib/statusMeta.js](src/lib/statusMeta.js) — new `PHASE_STATUS_META` map + `phaseStatusMeta(s)` helper. Imports `Loader2 / Circle / StopCircle` from lucide for the new states.

8. **Server-side**: one-field addition to [server/routes/agents.js](server/routes/agents.js) — `lastRun.blocked` now surfaces in `GET /agents/failed-cases` so the idle card's blocked count is accurate (the Run row already had the column; the response was just dropping it).

**Decisions** (recorded for future phases):

- **No `useReducer` consolidation** — the senior-review plan owns that refactor (T2.10). Kept the 14 `useState` calls intact so this phase ships pure-layout risk only. State will get consolidated in a separate maintenance pass.
- **Fullscreen via CSS, not Fullscreen API** — predictable, Esc-to-exit, no cursor lock surprises, no permission prompts on Safari, no `:fullscreen` selector edge cases. Loses true-fullscreen rendering performance but the screencast is ~2 fps anyway.
- **Three-pane only at `lg+`** — phones and tablets get the single-column stack. Watching a live run on a phone isn't the primary use case; degraded but functional is the right tradeoff.
- **Picker panel lives in the right pane, not as a floating overlay** — overlays would obstruct the live browser exactly when the user is trying to compare candidates against the screen. Right-pane placement keeps both visible.
- **"View report" CTA stays as a small button**, but the primary detail discovery is the inline expansion — per user choice. Reports navigation is a secondary affordance now, not the primary one.

**Open items**:
- ErrorBoundary state persists across route changes — a single page crash poisons other routes until Reload. Tracked separately (would land in the senior-review Tier 1 list).
- 17 `useState` consolidation into `useReducer` — tracked as T2.10.

**Files touched**:
- `src/pages/Theater.jsx` (full rewrite — preserved all WS handlers + effects + handlers; restructured JSX into three panes, extracted PhaseTimeline / BrowserFrame / ActionTrail / PickerCandidates / LastRunSummary)
- `src/lib/statusMeta.js` (added PHASE_STATUS_META + phaseStatusMeta + 3 new lucide imports)
- `src/lib/timeAgo.js` (new)
- `server/routes/agents.js` (one-field addition: `lastRun.blocked` in /failed-cases response)
- `BUILD_PLAN.md` (Phase 3 marked ✓)

**Verification**:
- `npx vite build` clean (1629 modules, 7.19 s).
- `node --check` clean on `server/routes/agents.js`.
- Manual smoke deferred to user — needs a live run to exercise the three panes, the picker arming, fullscreen, the inline LastRunSummary expansion.

## Phase 3.5 — Quality sweep (completed 2026-05-23)

**Scope**: knock down the Tier 1 shipping defects from the senior-review document — `<ConfirmDialog>` migration, Theater palette typo, WS reconnect, Toast memoization, indicator placement, sign-out hardening, stale URL params, ErrorBoundary route-reset.

**The honest summary**: 7 of the 8 items were **already fixed** in prior sessions I wasn't aware of. The senior-review document I worked from described an older state of the code. Only the **ErrorBoundary route-reset** required new work — but that one was important: it's the bug that bit us yesterday during the Phase 2 hotfix, where the boundary's stuck "Something broke" state poisoned unrelated pages until the user reloaded.

**Built (the only new change)**:

1. **ErrorBoundary route-reset** ([src/components/ErrorBoundary.jsx](src/components/ErrorBoundary.jsx) + [src/App.jsx](src/App.jsx))
   - Added a `resetKey` prop to the class boundary. On `componentDidUpdate`, if an error is captured and `resetKey` has changed, clear the error state. Doesn't touch children — only forgets the error.
   - Added a small `RouteAwareBoundary` wrapper inside `MainLayout`'s router context that reads `useLocation()` and passes `location.pathname` as `resetKey`. Wraps just the per-page `<Routes>` block so a single page's crash doesn't poison unrelated pages.
   - Kept the outermost ErrorBoundary in [src/main.jsx](src/main.jsx) untouched — it still catches catastrophic crashes before BrowserRouter mounts.
   - While I was in the file, replaced raw Tailwind colours (`bg-slate-50`, `border-rose-200`, `text-rose-700`, `text-slate-600`, `text-slate-700`) with the design tokens (`bg-ink-50`, `border-danger-200`, `text-danger-700`, `text-ink-600`, `text-ink-700`). Also added the `shadow-card` + `rounded-card` so the fallback matches the rest of the app.

**Pre-shipped verification** (with file:line evidence, so future-me trusts the audit):
- `<ConfirmDialog>` + `useConfirm`: [src/lib/useConfirm.jsx](src/lib/useConfirm.jsx) implements the promise-based hook with typed-name guard + async confirm + loading; [src/components/ui/ConfirmDialog.jsx](src/components/ui/ConfirmDialog.jsx) is the modal. All 9 callsites grep-clean of `window.confirm` (ProjectSetup:175, KnowledgeBase:60, AdoSettings:122, ClaudeSettings:138, JiraSettings:131, NotificationsSettings:106, WebhookSettings:301, WebhookSettings:324 — that's the 8 distinct + 1 typed-name variant for project delete = 9 counting WebhookSettings as one entity).
- Theater palette: grep `warning-50|warning-100|warning-200|...` in src/ returns nothing. Phase 3 rewrite eliminated the typo.
- WS URL: [src/store/runStream.jsx:16-23](src/store/runStream.jsx#L16) `resolveWsUrl()` honours `VITE_WS_URL` then derives `${ws|wss}://${location.host}/ws` from `window.location`. The `'ws://localhost:5000'` literal is only reachable in non-browser contexts (SSR / tests).
- WS backoff: [src/store/runStream.jsx:27-31](src/store/runStream.jsx#L27) `nextBackoff(attempt)` is `min(30000, 1000 * 2^attempt) + jitter`. Reconnect path at L74-79 uses it; `attempt` resets to 0 on successful `onopen`.
- Toast memo: [src/lib/useToast.jsx:41-49](src/lib/useToast.jsx#L41) value wrapped in `useMemo([push, dismiss])`. Both deps are themselves `useCallback`-stable.
- AgentRunningIndicator placement: [src/App.jsx:74](src/App.jsx#L74) — sibling of the grid, not a child. Comment on L68-69 explains why.
- Sidebar sign-out: [src/components/Sidebar.jsx:144-157](src/components/Sidebar.jsx#L144) — try/catch around `logout()`, toast.error on failure, `navigate('/login')` only on success.
- Reports stale `?runId`: [src/pages/Reports.jsx:76-87](src/pages/Reports.jsx#L76) — checks `runIdParam` against the loaded list; replaces or clears via `setSearchParams(next, { replace: true })`.

**Decisions** (for future phases):

- **Verify before fix.** This phase saved ~5 hours by checking each item's current state before touching code. Going forward: read first, edit second. The plan-before-code memory feedback was right — but the corollary is "verify before code" too.
- **Outer ErrorBoundary stays.** Don't move the main.jsx ErrorBoundary inside BrowserRouter — it needs to catch errors thrown by BrowserRouter itself (e.g. malformed history state). Two-layer boundary is correct.
- **`resetKey` instead of `key`.** Passing `key={location.pathname}` would unmount and remount the entire route subtree on every navigation, throwing away in-flight effects, scroll positions, and any "joined mid-run" state on Theater. `componentDidUpdate` + `resetKey` only resets the boundary's own error state — far less invasive.

**Open items**: none for Phase 3.5. The remaining senior-review items are Tier 2 (foundation refactors — best slotted opportunistically into feature phases) and Tier 3 (polish — defer).

**Files touched**:
- `src/components/ErrorBoundary.jsx` (added `resetKey` + `componentDidUpdate`; replaced raw Tailwind colours with tokens)
- `src/App.jsx` (imported `ErrorBoundary`; added `RouteAwareBoundary` wrapper; wrapped per-page `<Routes>` with it)
- `BUILD_PLAN.md` (Phase 3.5 marked ✓)

**Verification**:
- `npx vite build` clean (1629 modules, 7.24 s).
- Manual smoke deferred: navigate to a page that crashes (e.g. force-throw in TestCases) → see fallback → navigate to /output-files → fallback should clear and the new page should render.

## Phase 4 — Overview dashboard (completed 2026-05-23)

**Scope**: dashboard polish — Coverage tile, clickable stat tiles, Module Health empty state with Run-module CTA, hide all-zero Recent Runs, teach TestCases to honour `?module=` URL param. The AI cost tile was deferred to Phase 5 per user direction (it belongs on the Run detail page as a per-Run cap %, not the dashboard).

**Built**:

1. **Coverage tile** ([src/pages/Overview.jsx](src/pages/Overview.jsx))
   - New 5th `Stat` in the strip — shows `{coveragePercent}%` with sublabel `{executed} of {total} executed`. Falls back to `—` + `awaiting first run` before the first run lands.
   - Stat strip regridded from `grid-cols-2 md:grid-cols-4` to `grid-cols-2 md:grid-cols-3 lg:grid-cols-5` so the 5 tiles flow cleanly across breakpoints (2 mobile / 3 tablet / 5 desktop).
   - Coverage uses the `info` tone (blue) — distinct from success/danger/warn/accent so it reads as its own metric category rather than competing with pass/fail.

2. **Every stat tile clickable** ([src/pages/Overview.jsx](src/pages/Overview.jsx))
   - `Stat` component now accepts `onClick` + `hoverTitle`. When provided, the tile renders as a `<button>` with `hover:shadow-card-hover hover:border-ink-300 hover:-translate-y-0.5` micro-animation and `focus-visible:shadow-ring`. Without `onClick` it stays a plain `<div>`.
   - Navigation map: Passed → `/reports?runId=<latestRunId>&status=pass`; Failed → same with `status=fail`; Blocked → `/blocked-items` (scope=latest is the page default); Coverage → `/reports?runId=<latestRunId>`; PRs pending → `/governance`.
   - All tiles clickable even when value = 0 — the destination renders an empty list (verifiable absence is more useful than a dead-end).
   - OverviewSkeleton matched: 5-tile placeholder grid with same `grid-cols-2 md:grid-cols-3 lg:grid-cols-5` shape so the layout doesn't jump when data arrives.

3. **Module Health "Not yet measured"** ([src/pages/Overview.jsx](src/pages/Overview.jsx))
   - Inline IIFE splits `data.modules` into `measured` (`pass + fail + blocked > 0`) and `unmeasured` (everything still pending or skipped).
   - Measured modules render in the existing `StackedBar`.
   - Unmeasured modules render below as a `<ul>` with a per-row "Run module" button that deep-links to `/test-cases?module=<encoded>`. Encodes the module name with `encodeURIComponent` so modules with spaces / unicode survive the URL round-trip.
   - The "Not yet measured" header only renders when there's actually unmeasured data; the `Legend` only renders when there's measured data. Mixed projects show both stacked vertically with a divider.

4. **All-zero Recent Runs hidden** ([server/routes/dashboard.js](server/routes/dashboard.js))
   - The `recentRunRows.map(...)` now starts with a `.filter()` that drops rows where `passed + failed + blocked + skipped === 0`. **Exception**: rows with `status === 'running'` stay even when counts are 0 — they legitimately have no results yet but are the most navigable thing in flight.
   - No change to the underlying `take: 10` query — the filter happens client-side in Node so we still pull the same 10 rows; we just hide the noise after enrichment.

5. **TestCases honours `?module=<name>`** ([src/pages/TestCases.jsx](src/pages/TestCases.jsx))
   - Read once-per-render via `searchParams.get('module')`. Stored as `moduleParam` (no separate `useState` — URL is the source of truth).
   - Wired into the `visibleScenarios` memo as the FIRST filter axis (applied before priority/category/status/confidence/search), so the secondary filters narrow within the requested module.
   - New banner above the priority/type filter card: `Filtered to module {X} · {N} scenarios · [Clear module filter]`. Uses `info` palette (consistent with the route-aware filter UX in Reports.jsx).
   - "Clear module filter" copies the URLSearchParams, deletes `module`, calls `setSearchParams(next, { replace: true })` — the URL-mutation idiom the senior-review T2.8 flagged and that the rest of the codebase already uses.

**Decisions** (for future phases):

- **Coverage uses `info` tone, not `success`.** Coverage is a measurement quality signal ("how much have we measured?"), not an outcome signal ("did we pass?"). Using `success` would imply "more coverage = pass". `info` (blue) keeps it neutral.
- **Stat tiles clickable at value=0 too.** Decided NOT to disable zero-value tiles. Letting the user click "0 Blocked" and see a clean Blocked Items page is informative — it confirms there's nothing to triage. Disabling would force a separate verification path.
- **Module filter is URL-driven, not state-driven.** Putting `moduleParam` in component state would mean URL and UI could diverge (URL says one thing, state says another). Reading directly from `searchParams.get(...)` ties them together — and "Clear filter" simply rewrites the URL.
- **No new endpoint for module-scoped execution.** "Run module" navigates to TestCases pre-filtered to the module rather than triggering a server-side module-scoped run. Keeps the server surface small and reuses the existing approve-then-execute flow. If we ever want one-click "approve + run module" we can layer it on top.
- **All-zero filter has a `running` escape hatch.** Without it, a brand-new run that's just started (status=running, counts=0) would silently disappear from the dashboard. The whole point of Recent Runs is "what's happening lately" — a fresh run absolutely belongs.

**Open items**: none for Phase 4. The AI cost / per-Run usage display moves to Phase 5 (Reports) where it has a natural home on Run detail.

**Files touched**:
- `src/pages/Overview.jsx` (Coverage tile + clickable stats + Module Health empty state + skeleton updated)
- `server/routes/dashboard.js` (all-zero recent runs filter)
- `src/pages/TestCases.jsx` (module URL-param + banner + integrated into visibleScenarios)
- `BUILD_PLAN.md` (Phase 4 marked ✓; cost-tile descope noted)

**Verification**:
- `npx vite build` clean (1629 modules, 6.99 s).
- `node --check server/routes/dashboard.js` clean.
- Manual smoke deferred to user: open `/overview` with a project that has both run + unrun modules → see StackedBar for run modules and Not-yet-measured list for unrun ones; click "Run module" → land on `/test-cases?module=X` filtered to that module with the dismissable banner.

## Phase 5 — Reports (completed 2026-05-23)

**Scope**: hide all-zero runs from the Reports list, show counts on the status filter chips, add a sprint dropdown, ship PDF export via print-to-PDF, and surface a live Anthropic rate-limit chip in the page header (the latter replaces Phase 4's deferred AI cost tile — per user choice, no dollar amounts and no artificial cap).

**The pivot mid-phase**: I initially planned a per-Run token cap with schema additions + Run-attribution wiring. The user pushed back ("just when they enter their API key can't we fetch the details of their plan usage through their API key?"). Honest answer: Anthropic doesn't expose plan-level usage via the API. But it DOES emit `anthropic-ratelimit-*` headers on every response. The user chose "Real-time rate limit (TPM snapshot)" — so the schema migration was dropped and the agent wiring became a header-extraction helper instead.

**Built**:

1. **Anthropic rate-limit pipeline** (new throughout the server)
   - [server/lib/anthropicHeaders.js](server/lib/anthropicHeaders.js) — `extractRateLimitInfo(headers)` reads the six `anthropic-ratelimit-{tokens,requests}-{remaining,limit,reset}` headers from a fetch `Response` (or a plain object, for tests / mocks). Returns `{ tokens: {…}, requests: {…}, capturedAt }` or `null` if no headers present.
   - `callWithRateLimit(promise, onRateLimit)` wraps any `client.messages.create(...)` in-flight promise with `.withResponse()` (Anthropic SDK v0.30+), extracts the rate-limit info, fires the optional callback, and returns the original data. Falls back to bare-promise behaviour when `.withResponse()` isn't available (older SDKs, mocks).
   - Wired into every agent that calls Claude (7 files, 9 distinct call sites):
     - [architect.js](server/services/agents/architect.js), [planner.js](server/services/agents/planner.js), [conductor.js](server/services/agents/conductor.js), [critic.js](server/services/agents/critic.js) (×2: post-hoc + inline), [supervisor.js](server/services/agents/supervisor.js), [analyst.js](server/services/agents/analyst.js) (×2: detect + impact), [reporter.js](server/services/agents/reporter.js).
     - Each `run()` (and `runInline`, `detectDiscrepancies`, `selectImpactedScenarios`) gained an optional `onRateLimit` parameter. Defaults to undefined; when supplied, fires with the parsed rate-limit info after every Claude call.
   - Each ROUTE that invokes an agent defines `onRateLimit` from the existing `send` broadcaster and passes it down: [agents.js](server/routes/agents.js) (3 invocations + runConductorWithRetries internal callback), [analyst.js](server/routes/analyst.js) (2), [scenarios.js](server/routes/scenarios.js) (1), [reporter.js](server/routes/reporter.js) (1).
   - WS event shape: `{ type: 'claude.rate-limit', tokens: { remaining, limit, resetAt }, requests: { remaining, limit, resetAt }, capturedAt }`.

2. **Client rate-limit subscription** ([src/store/runStream.jsx](src/store/runStream.jsx))
   - New `claudeRateLimit` state, populated by the `claude.rate-limit` WS handler. Resets to `null` on project switch (cosmetic — the snapshot is per-API-key, not per-project, but stale "0 remaining" framing on a new project would mislead).
   - Surfaced in the context value alongside `running`, `latestRunId`, etc. — any page can read it via `useRunStream()`.

3. **ClaudeRateLimitChip** ([src/pages/Reports.jsx](src/pages/Reports.jsx))
   - Small chip in the Reports page header: `[zap] TPM [bar] {percent}% {remaining}/{limit} · {resetIn}`.
   - Bar tone driven by usage: success (<60%), warn (60-89%), danger (≥90%).
   - Tabular-nums on every number; `title` attribute has the full text for accessibility.
   - Hides when `info?.tokens?.limit` is missing — no flicker on first paint before the first Claude call lands.
   - Compact form on `md` (just percent + bar); full form on `lg+` (adds remaining/limit + reset countdown).

4. **Hide all-zero runs** ([server/services/runs.js#listRuns](server/services/runs.js))
   - Filter added between the prisma `findMany` and the per-row enrichment map. Drops rows where `passed + failed + blocked + skipped === 0` UNLESS `status === 'running'` (running runs legitimately have zero counts but are the most navigable thing on the list).
   - Mirrors the Phase 4 dashboard filter, so the Recent Runs (Overview) and Runs list (Reports) agree on what counts as a "real" run.

5. **Filter chip counts** ([src/pages/Reports.jsx](src/pages/Reports.jsx))
   - New `statusCounts` memo computed against the search-narrowed result set (so the count for "Failed" drops when a search hides failures — chips stay honest).
   - Each chip renders `{label} {count}` inline. Active chip's count text fades to `text-white/70`; inactive uses `opacity-60` to keep it from competing with the label.

6. **Sprint dropdown** ([src/pages/Reports.jsx](src/pages/Reports.jsx))
   - `sprintOptions` memo derives distinct `sprintName` values from the loaded runs list, ordered by most-recent run first.
   - `<select>` rendered only when there are ≥2 sprints (otherwise the dropdown is a one-option dead-end).
   - URL param `?sprint=` for shareability. `visibleRuns` applies it as the first filter axis, then layers the `?q=` search on top.
   - Default option is "All sprints" (empty string → no filter).

7. **PDF export** ([src/pages/Reports.jsx](src/pages/Reports.jsx) + [src/index.css](src/index.css))
   - "Print / PDF" button in the page header (renders only when there's an active run — otherwise the print output would be blank).
   - Fires `window.print()` directly. No new dependency. Users hit "Save as PDF" in their browser's print dialog.
   - `@media print` block in `src/index.css` hides `aside`, `nav`, anything with `data-no-print="true"` or `.print:hidden`. The filter bar and the mobile pane tabs are both marked `data-no-print`. Flattens scroll containers (`overflow: visible !important`), drops shadows, forces black-on-white type, adds `@page { margin: 14mm }`, avoids breaking inside `<section>` elements (RCA / error / trace blocks stay together on a page when they fit).

**Already done — verified, no work needed**:
- Three-pane layout, URL params (`?q=`, `?status=`, `?runId=`, `?resultId=`), status filter chips (the 4 chip set), RCA panel + Reporter agent + RcaPanel + "Analyse N failures with AI" button, TestHistoryPanel, CompareView, ErrorBlock + NetworkLogPanel + TraceSection + Screenshots + Video + SpecCodeSection — all pre-shipped from prior sessions and audited via the Phase 5 survey.

**Decisions** (for future phases):

- **Rate-limit signal lives in `useRunStream` context**, not a new dedicated context. The chip will only live on Reports for now, but if Theater / Overview ever want to surface it, they can read the same state.
- **Reset countdown is recomputed from `resetAt` ISO timestamp on every render** rather than a ticking interval. Cheaper, and acceptably accurate because every Claude call refreshes the info anyway.
- **Print fires `window.print()` directly** — no preview modal, no "are you sure?" gate. The browser's print dialog IS the preview. Saves us building a print-mode toggle.
- **All `aside` elements hidden in print** is a broad rule (set in `@media print` globally). Future pages that use `<aside>` and want their content to print must opt in — but `<aside>` is for tangentially-related content by definition, so this is the right default.
- **Sprint dropdown is single-select, not multi.** Multi-select would need a different UI (chips, popover) and Reports filtering is rarely "show me sprints A + C but not B" in practice.
- **No artificial token caps anywhere.** This was the user's strongest signal: "don't show me invented numbers". The rate-limit chip shows ONLY what Anthropic actually reports.

**Open items**: none for Phase 5. RCA was already done; sprint, chip counts, print, all-zero filter, rate-limit chip all shipped.

**Files touched**:
- `server/lib/anthropicHeaders.js` (new)
- `server/services/agents/architect.js`, `planner.js`, `conductor.js`, `critic.js`, `supervisor.js`, `analyst.js`, `reporter.js` (onRateLimit param + `callWithRateLimit` wrap)
- `server/routes/agents.js`, `analyst.js`, `scenarios.js`, `reporter.js` (define + pass `onRateLimit`)
- `server/services/runs.js#listRuns` (all-zero filter, running exempt)
- `src/store/runStream.jsx` (claudeRateLimit state + WS handler + context value)
- `src/pages/Reports.jsx` (sprint dropdown, chip counts, Print button, ClaudeRateLimitChip + helper, data-no-print markers)
- `src/index.css` (@media print block)
- `BUILD_PLAN.md` (Phase 5 marked ✓; AI cost descope confirmed)

**Verification**:
- `node --check` clean on all 13 touched server files.
- `npx vite build` clean (1629 modules, 8.28 s).
- Manual smoke deferred to user: trigger any Claude call (e.g. Generate scenarios in Run Suite) → Reports header should show a TPM chip with real numbers. Run a small suite → "Print / PDF" button → browser print dialog → preview shows the detail pane only, no sidebar/filter bar/test list.

## Phase 5.5 — Conversational RCA + User guidance (completed 2026-05-23)

**Scope**: close the human-in-the-loop feedback channel that the existing one-shot RCA didn't cover. Two distinct features bundled:
  1. **Conversational RCA chat** per failed test — talk to Claude about a specific failure with full context (error, trace, network log, prior RCA). History persists.
  2. **User guidance** — free-form notes the user wants every future agent run to honour, at two scopes (project + per-case).

**Built**:

1. **Schema additions** ([prisma/schema.prisma](prisma/schema.prisma) + migration `20260523083954_add_chat_and_guidance`)
   - `Project.aiGuidance String?` — project-wide notes (8,000-char cap).
   - `TestCase.userGuidance String?` — per-case notes (4,000-char cap).
   - `RunResult.chatHistory String?` — JSON-encoded array of `{role, content, ts}`.
   - All three are additive nullable columns. Migration applied cleanly.

2. **promptCompose helper** ([server/lib/promptCompose.js](server/lib/promptCompose.js))
   - `composeSystemPrompt(base, guidance)` prepends operator guidance in an "OPERATOR GUIDANCE" fenced block above the agent's base SYSTEM_PROMPT. No-op if guidance is null/empty/whitespace.
   - `joinGuidance({ projectGuidance, caseGuidance })` joins project + per-case notes with labeled sub-headers so Claude sees the source.

3. **rcaChat agent** ([server/services/agents/rcaChat.js](server/services/agents/rcaChat.js))
   - New agent: non-tool-use, conversational follow-up on a specific failure. Builds a "primer" user turn with TC + error + trace + network log + prior RCA, appends existing chat history, appends new user message. Calls Claude.
   - Uses the same `callWithRateLimit` wrapper as every other agent so chat traffic feeds the Reports rate-limit chip.
   - Honours `extraGuidance` through `composeSystemPrompt`.

4. **Endpoint: `POST /api/runs/:runId/results/:resultId/chat`** ([server/routes/reporter.js](server/routes/reporter.js))
   - Rate-limited 20/min. CSRF-protected.
   - Loads result + testCase + project (for guidance), pulls chatHistory, calls `rcaChat.chat`, persists user message + assistant reply, caps history at 40 turns (drop oldest), returns the full updated history.
   - 400 on empty/over-long messages; 502 on Claude returning empty reply.
   - Audit-log entry per call.

5. **Endpoint: `PUT /api/projects/:id/guidance`** ([server/routes/projects.js](server/routes/projects.js))
   - Accepts `{ aiGuidance: string }`. 8,000-char cap. Empty string clears the field.
   - Audit-log entry on update.

6. **Per-case guidance via existing `PUT /api/projects/:p/test-cases/:tc`** ([server/routes/testCases.js](server/routes/testCases.js))
   - Added `userGuidance` to the body schema. 4,000-char cap. Empty string clears.
   - Reuses the existing endpoint instead of adding a dedicated route — keeps the surface area small and matches how name/status/type updates already work.

7. **Agent wiring** — all 7 agent services accept `extraGuidance` and apply via `composeSystemPrompt`:
   - [architect.js](server/services/agents/architect.js), [planner.js](server/services/agents/planner.js), [conductor.js](server/services/agents/conductor.js), [critic.js](server/services/agents/critic.js) (×2 — `run` post-hoc + `runInline`), [supervisor.js](server/services/agents/supervisor.js), [analyst.js](server/services/agents/analyst.js) (×2 — discrepancies + impact), [reporter.js](server/services/agents/reporter.js).
   - For Conductor specifically, the layering is: `composeSystemPrompt(SYSTEM_PROMPT_LOOP + Supervisor guidance prefix, operator extraGuidance)` — Supervisor's case-specific instructions stay close to the agent's domain rules, operator notes sit above as the outermost authority.

8. **Route plumbing** — each route loads guidance and passes it:
   - [server/routes/agents.js](server/routes/agents.js): `joinGuidance({ projectGuidance: project.aiGuidance, caseGuidance: buildCaseGuidanceBlock(scenarios) })` for Conductor/Critic/Supervisor (which see per-case context). New helper `buildCaseGuidanceBlock(scenarios)` formats each TC's `userGuidance` as a bullet list. Architect/Planner get only `project.aiGuidance`.
   - [server/routes/scenarios.js](server/routes/scenarios.js): project-only (Architect for regenerate).
   - [server/routes/analyst.js](server/routes/analyst.js): project-only (both discrepancies + impact analysis).
   - [server/routes/reporter.js](server/routes/reporter.js): project-only (RCA generation + chat).

9. **`getRun` enriches the response** ([server/services/runs.js](server/services/runs.js))
   - Includes `testCase.userGuidance` in the select clause so the Reports detail pane can populate the editor without a second fetch.
   - Decodes `chatHistory` JSON into an array so the client gets a usable shape immediately.

10. **Client — Settings → Claude** ([src/pages/settings/ClaudeSettings.jsx](src/pages/settings/ClaudeSettings.jsx))
    - New `ProjectGuidanceSection` at the bottom of the page. Loads `project.aiGuidance` on mount via `GET /projects/:id`. Textarea (6 rows) + Save button. Char counter at < 500 chars remaining, over-limit warning.

11. **Client — Reports detail pane** ([src/pages/Reports.jsx](src/pages/Reports.jsx))
    - New `RcaChatPanel` — sticky-scroll chat history (max-h 320px), text input with ⌘↵ to send, char counter, optimistic UI on send with rollback on error. Hidden empty-state message when no messages yet.
    - New `ChatBubble` — distinct bubbles for user vs AI: dark ink-900 right-aligned for user, accent-bordered left-aligned for AI; timestamp under each.
    - New `CaseGuidanceEditor` — textarea (3 rows) bound to `TestCase.userGuidance`. Saves via `PUT /projects/:p/test-cases/:tc`. Sync on TC switch (parent passes new `initialValue`). Toast on save: "The AI will honour this on the next run of this case."

**Decisions** (recorded for future phases):

- **Per-case guidance is a system-prompt block, not a per-message injection.** Conductor processes multiple cases in one Claude conversation. Injecting per-case guidance mid-conversation is awkward (system prompt is set at conversation start). The route builds the case-guidance block at run start and the model is smart enough to apply the right note per case.
- **Chat is per-RunResult, not per-TestCase.** Each failure is its own context — a flaky locator that fails on run A may pass on run B; tying chat to RunResult preserves the conversation specific to that failure's evidence.
- **Operator guidance is fenced as "OPERATOR GUIDANCE" with explicit "applies when they conflict with general rules"** — gives the model a clear precedence signal. Without that label, the model can't tell project notes from agent domain rules.
- **40-turn cap on chat history.** Cheap insurance against runaway context bloat. The primer re-injects the failure context on every turn so the agent never loses the core facts.
- **No streaming chat in Phase 5.5.** Simpler. Send → wait → render. Streaming is a polish item we can layer on without rewriting the protocol.
- **Per-case guidance is ONLY wired into Conductor for now.** Critic/Supervisor see the user guidance because they receive the TC object from the DB (and `getRun` returns `userGuidance` in their per-case data), but they don't get a structured per-case block in their system prompt the way Conductor does. If this proves insufficient, layer it in later — Critic/Supervisor see the same TC data and can read `userGuidance` from it directly.
- **Reuse `PUT /test-cases/:tc` for per-case guidance** instead of a dedicated endpoint. Less route surface; matches the existing pattern for other TC fields.

**Open items**:
- Prisma Client regen — the `npx prisma migrate dev` step applied the SQL but the post-migrate `prisma generate` failed with `EPERM: operation not permitted, rename query_engine-windows.dll.node.tmp...`. Stale node processes from May 21 are holding the DLL. User must run `taskkill /F /IM node.exe` (or just close their dev server) then `npx prisma generate` — until then, the new fields exist in the DB but aren't accessible from `prisma.runResult.update({ data: { chatHistory: ... } })` because the JS client has stale typings. Server will throw at runtime when trying to write to the new columns.

**Files touched**:
- `prisma/schema.prisma` (3 new nullable columns)
- `prisma/migrations/20260523083954_add_chat_and_guidance/migration.sql` (new)
- `server/lib/promptCompose.js` (new)
- `server/services/agents/rcaChat.js` (new)
- `server/services/agents/{architect,planner,conductor,critic,supervisor,analyst,reporter}.js` (extraGuidance + composeSystemPrompt wrapping)
- `server/services/runs.js` (`getRun` decodes chatHistory + includes userGuidance)
- `server/routes/agents.js` (joinGuidance + buildCaseGuidanceBlock; passes extraGuidance through every agent call)
- `server/routes/{analyst,scenarios,reporter}.js` (passes extraGuidance)
- `server/routes/reporter.js` (new POST chat endpoint)
- `server/routes/projects.js` (new PUT /:id/guidance endpoint)
- `server/routes/testCases.js` (existing PUT /:tcId now accepts userGuidance)
- `src/pages/settings/ClaudeSettings.jsx` (ProjectGuidanceSection)
- `src/pages/Reports.jsx` (RcaChatPanel + ChatBubble + CaseGuidanceEditor + Save import)
- `BUILD_PLAN.md` (Phase 5.5 marked ✓)

**Verification**:
- `node --check` clean on all touched server files.
- `npx vite build` clean (1629 modules, 7.74 s).
- Manual smoke deferred to user: AFTER running `npx prisma generate` (see open items): open `/settings/claude`, write project-wide guidance ("use aria-label selectors"), save → next time any agent runs, that string appears in its system prompt. Open `/reports`, select a failed test → write per-case guidance, save → next Conductor run that includes this case sees a "Per-test-case guidance" block. Send a chat message in the same pane → Claude responds with context-aware analysis.

## Phase A — Multi-provider AI: Claude + Gemini (completed 2026-05-23)

**Scope**: Add Gemini as a peer provider to Claude. Per-project provider choice. All 7 agents + codegen + RCA chat call through a provider abstraction so the user can flip between Anthropic and Google without code changes per agent.

**Built**:

1. **Schema** ([prisma/schema.prisma](prisma/schema.prisma) + migration `20260523095538_add_ai_provider`)
   - `Project.aiProvider String @default("claude")` — only new column. Gemini key + model piggyback on the existing generic `Secret` and `Integration` tables (name-keyed).

2. **Provider abstraction** ([server/lib/llmProvider.js](server/lib/llmProvider.js) + [server/lib/providers/anthropic.js](server/lib/providers/anthropic.js) + [server/lib/providers/gemini.js](server/lib/providers/gemini.js))
   - `getProvider(name)` returns `{ complete({apiKey, model, system, messages, tools, maxTokens, signal, onRateLimit}) → {content, stop_reason, usage} }`.
   - Anthropic-shape `messages`/`tools` is **canonical**. Anthropic provider is a passthrough using the existing `callWithRateLimit` helper.
   - Gemini provider translates: `tool_use ↔ functionCall`, `tool_result ↔ functionResponse`, `text ↔ text`, `image ↔ inlineData`. Builds an id-to-name map by walking the messages forward to resolve Gemini's required `functionResponse.name` field. Disables Gemini's safety filters (`HARM_CATEGORY_*` → `BLOCK_NONE`) so legitimate QA content (form errors, login pages) isn't blocked.
   - `name` property on each provider lets agent logs print "Calling claude" vs "Calling gemini" without the agent caring how.

3. **Per-project credentials helper** ([server/lib/resolveAiCredentials.js](server/lib/resolveAiCredentials.js))
   - `resolveAiCredentials(userId, project) → {provider, apiKey, model, integration}`. Centralises the "look up secret `<provider>.apiKey`, look up integration of type `<provider>`, default the model" logic so each route doesn't reimplement it.
   - Default model per provider: `claude-sonnet-4-6` / `gemini-2.5-pro`.

4. **Gemini key validation** ([server/services/gemini.js](server/services/gemini.js) + [server/routes/settings.gemini.js](server/routes/settings.gemini.js))
   - `validateApiKey(key)` calls `GET https://generativelanguage.googleapis.com/v1beta/models?key=...`, filters models that support `generateContent`. 10 s timeout, structured error codes (`AUTH_FAILED` / `RATE_LIMITED` / `UPSTREAM_ERROR` / `TIMEOUT` / `NETWORK`).
   - Routes: `GET /api/settings/gemini`, `POST /validate`, `POST /save`, `DELETE /`. Mirror of `settings.claude.js`.
   - Format check is **deliberately lenient** — `^AIza[0-9A-Za-z_-]+$` with a 20-char minimum. Real Google key length varies; we catch the obvious "wrong provider's key" mistake but let Google decide everything else.

5. **MCP tool catalog stays unchanged** ([server/services/mcp.js](server/services/mcp.js))
   - Added `listProviderTools(session)` peer to `listAnthropicTools` (currently delegates to the same — Gemini provider re-shapes Anthropic-format tool defs at the boundary). Conductor calls `listAnthropicTools` and the provider does the rest. **Playwright MCP server is provider-agnostic.**

6. **Agent + codegen refactor** — all 7 services + 3 codegen modules + RCA chat now call `provider.complete({...})`:
   - [architect.js](server/services/agents/architect.js), [planner.js](server/services/agents/planner.js), [conductor.js](server/services/agents/conductor.js), [critic.js](server/services/agents/critic.js) (×2 — `run` + `runInline`), [supervisor.js](server/services/agents/supervisor.js), [analyst.js](server/services/agents/analyst.js) (×2), [reporter.js](server/services/agents/reporter.js), [rcaChat.js](server/services/agents/rcaChat.js).
   - Codegen: [pom.js](server/services/codegen/pom.js), [cucumber.js](server/services/codegen/cucumber.js), [selenium.js](server/services/codegen/selenium.js) — all take `{provider, apiKey, model}` instead of `{client, model}`.
   - Conductor's tool-use loop is unchanged. Messages stay in Anthropic shape internally; provider translates at SDK call.

7. **Route plumbing** — every route that fires an agent now loads `resolveAiCredentials(req.user.id, project)` first and passes `provider` through to the agent call. Error message changes from "Claude API key not configured" to "{provider} API key not configured. Visit Settings → {provider} API." Updated: [agents.js](server/routes/agents.js), [scenarios.js](server/routes/scenarios.js), [analyst.js](server/routes/analyst.js), [reporter.js](server/routes/reporter.js).

8. **PUT /:id/provider endpoint** ([server/routes/projects.js](server/routes/projects.js))
   - Body: `{ aiProvider: 'claude' | 'gemini' }`. Validates via `isValidProvider`. Audit-logged.

9. **Frontend — Settings → AI Provider** ([src/pages/settings/AiProviderSettings.jsx](src/pages/settings/AiProviderSettings.jsx) + [src/pages/settings/ProjectProviderSection.jsx](src/pages/settings/ProjectProviderSection.jsx))
   - **Standalone settings tab**, FIRST in the nav, default landing. Originally I inlined the provider picker on the Claude AND Gemini pages — user found that confusing ("why is there a Claude option on the Gemini page?"). Lifted to its own tab.
   - Reads/writes via `GET /projects/:id` + `PUT /projects/:id/provider`.

10. **Frontend — Settings → Gemini API** ([src/pages/settings/GeminiSettings.jsx](src/pages/settings/GeminiSettings.jsx))
    - Mirror of `ClaudeSettings.jsx`. SecretInput with `AIza…` placeholder, validate, save, delete, model dropdown populated from validation response. Info box pointing users to AI Provider tab to actually switch the project's provider (configuring the key here just stores it).

11. **Frontend — Reports rate-limit chip hides on Gemini** ([src/pages/Reports.jsx](src/pages/Reports.jsx))
    - `ClaudeRateLimitChip` checks `aiProvider` prop; returns null when `!== 'claude'`. Google's API doesn't return per-request remaining-tokens headers, so the chip would be silent anyway — but explicit hide avoids showing stale Anthropic numbers carried over from a previous run.
    - Project list endpoint now returns `aiProvider` so `useProject().current.aiProvider` is populated.

**Decisions** (recorded for future phases):

- **Anthropic shape is canonical, Gemini translates at the boundary.** Tried two approaches; this one keeps Conductor's tool-use loop body unchanged. The agents have no provider-specific code.
- **Per-project provider granularity** (not per-run, not per-agent). User explicitly chose this. Switching mid-run would orphan tool-use history between providers — Conductor refuses by design (`provider` resolved once at run start).
- **Default to 'claude' for legacy projects.** The migration sets the default; existing projects keep working with zero config change.
- **Rate-limit chip is provider-aware**, not Claude-only. The infrastructure (`useRunStream.claudeRateLimit`) stays but the chip suppresses itself on Gemini. If Google adds remaining-tokens headers later we just toggle the suppress.
- **Gemini key validation is lenient.** Pre-release Google keys, Workspace keys, and rotated formats are all valid but vary in length. Server only checks the `AIza` prefix; Google's `/v1beta/models` does the real validation.
- **AI Provider lives on its own tab, NOT inline on Claude/Gemini pages.** First attempt put it on both → users were confused. Decoupled tab is cleaner: pick provider once, configure each provider's key on its own page.
- **`@google/generative-ai` SDK is loaded lazily** in the Gemini provider (require-on-first-use). Keeps the server import time fast and means a missing package only blows up the Gemini path, not the whole server.
- **No streaming yet for Gemini.** Both providers use one-shot `complete()`. Streaming is a polish item.

**Open items**:
- Auto-failover (Claude → Gemini on rate limit) deferred to **Phase C**. Phase A is "user picks one provider, agents route through it." Phase C will translate in-flight tool-use history and surface the failover as a Theater event.
- Conductor will FAIL the run if `provider.complete` rejects mid-tool-use loop. That's correct for Phase A — partial-failover would silently degrade output quality.

**Files touched**:
- `prisma/schema.prisma` + migration `20260523095538_add_ai_provider`
- `package.json` (+ `@google/generative-ai@0.24.1`)
- `server/lib/llmProvider.js`, `server/lib/providers/anthropic.js`, `server/lib/providers/gemini.js`, `server/lib/resolveAiCredentials.js` (new)
- `server/services/gemini.js`, `server/routes/settings.gemini.js` (new)
- `server/services/mcp.js` (added `listProviderTools`)
- `server/services/agents/*.js` (all 7 + rcaChat — provider.complete refactor)
- `server/services/codegen/{pom,cucumber,selenium}.js` (provider.complete refactor)
- `server/routes/{agents,scenarios,analyst,reporter,projects}.js` (resolveAiCredentials + provider plumbing)
- `server/index.js` (mount gemini routes)
- `src/pages/settings/{AiProviderSettings,GeminiSettings,ProjectProviderSection}.jsx` (new) + `ClaudeSettings.jsx` (ProjectProviderSection slot — later removed) + `Settings.jsx` (nav) + `App.jsx` (route)
- `src/pages/Reports.jsx` (chip provider-awareness)
- `BUILD_PLAN.md` (Phase A added + Phase B/C proposals + handoff notes)

**Verification**:
- `node --check` clean on 24 server files.
- `npx vite build` clean (1631 modules, 11.16 s).
- Manual test: Gemini key validates against Google `/v1beta/models`. Project provider toggle persists. Architect runs to completion on Gemini. Rate-limit chip hidden when project is on Gemini.

## Phase A.5 — Project deletion hygiene + multi-provider bug fixes (completed 2026-05-23)

**Scope**: Production-test fallout from Phase A. The user shipped Phase A, ran with Gemini, found three real issues plus a leftover from Phase 5.5. All fixed in one sweep.

**Built**:

1. **OutputFiles filters by project content** ([server/routes/outputFiles.js](server/routes/outputFiles.js))
   - Previously the route walked `playwright/tests`, `pages`, `fixtures`, `utils` globally and returned ALL files. Files from a deleted project leaked into other projects' OutputFiles listings.
   - Now: only return disk files whose UUID (in filename or path) matches THIS project's TestCase ids OR whose path matches a GovernancePR.filename for this project. Shell scaffolding (`playwright.config.ts`, `package.json`, `tsconfig.json`) only surfaces when the project has ≥1 PR — empty project = empty file list.

2. **DELETE project cleans disk** ([server/routes/projects.js](server/routes/projects.js))
   - Before `prisma.project.delete()` (which cascades the DB rows), collect every disk path the project wrote: `GovernancePR.filename` + every `RunResult.screenshots/video/trace`. After the DB delete succeeds, `fs.unlinkSync` each path (best-effort — ENOENT is fine), then `removeEmptyChildDirs` on `tests/`, `pages/`, `test-results/` so empty per-module dirs don't stick around.
   - Audit log now records `filesDeleted/filesAttempted` for traceability.

3. **One-shot orphan cleanup script** ([server/scripts/cleanup-orphans.js](server/scripts/cleanup-orphans.js))
   - `node server/scripts/cleanup-orphans.js` (dry-run by default; `--apply` to delete). Walks `playwright/tests`, `pages`, `test-results/live`, identifies files whose embedded UUID doesn't match any current TestCase id or whose path isn't in any current GovernancePR. Useful if someone manually edited the DB or a future bug orphans files.

4. **Robust JSON extraction for all agents** ([server/lib/parseJsonResponse.js](server/lib/parseJsonResponse.js) — new helper)
   - Production-tested cause: Gemini Planner returned `Here's the plan:\n\n{...}\n\nLet me know if you need adjustments.` — the planner's strict `JSON.parse` rejected it, run failed.
   - New helper has 4 recovery strategies: direct parse, fenced-block extraction, first-opener-to-last-closer extraction, truncation recovery (walk depth, slice at last safe top-level close, append closer). `{type: 'object'|'array'}` constrains to expected shape.
   - Replaced strict parsing in: [planner.js](server/services/agents/planner.js), [critic.js](server/services/agents/critic.js) (×2), [supervisor.js](server/services/agents/supervisor.js), [reporter.js](server/services/agents/reporter.js), [analyst.js](server/services/agents/analyst.js) (×2).
   - Architect still uses its bespoke `parseScenarioJson` because it has a complex per-scenario truncation recovery — could be refactored to share later, no rush.

5. **Live Pipeline layout rebalance** ([src/pages/Theater.jsx](src/pages/Theater.jsx))
   - User complaint: three-pane layout from Phase 3 makes the browser too small. "Previous live pipeline UI only looked good with full scenario architect, dependency planner one by one stacked, with big live browser screen."
   - New: two-row layout. Row 1 = `lg:grid-cols-[240px_1fr]` (PhaseTimeline narrower, BrowserFrame takes the rest). Row 2 = full-width ActionTrail below (max-h 420px, scrolls internally).
   - BrowserFrame: `aspect-[16/9] min-h-[520px]` (was `aspect-[16/10]`) — browser is now roughly 40% wider and noticeably taller.

6. **Gemini key validation loosened** ([server/services/gemini.js](server/services/gemini.js))
   - Was: `^AIza[0-9A-Za-z_-]{35,}$` → required ≥39 chars total. Real Google keys vary; user pasted a 38-char key and was rejected at the format gate.
   - Now: `^AIza[0-9A-Za-z_-]+$` with a 20-char minimum. Catches "wrong provider's key" (most common error) without rejecting real keys. Let Google's `/v1beta/models` be the source of truth.

7. **AI Provider lifted to its own settings tab** ([src/pages/settings/AiProviderSettings.jsx](src/pages/settings/AiProviderSettings.jsx))
   - Phase A initially inlined `ProjectProviderSection` on both Claude AND Gemini settings pages so users could switch from either side. User found the dropdown showing both options on a page already labeled with one provider confusing.
   - Lifted to a standalone tab "AI Provider", now the FIRST tab and the default settings landing. Both Claude and Gemini key pages now have a small info box pointing to the AI Provider tab. Updated `App.jsx` route + `Settings.jsx` TABS.

8. **Bottom padding on settings main** ([src/pages/settings/Settings.jsx](src/pages/settings/Settings.jsx))
   - Added `pb-24` to the settings content area so dropdowns near the page bottom don't crowd the Save button.

**Decisions** (recorded for future phases):

- **Disk delete happens AFTER the DB delete succeeds**, not before. If the DB delete fails, we never touch disk — keeps disk and DB in lockstep. Failed unlinks (e.g. file already removed) are logged but don't fail the request — the project IS already deleted, and missing files aren't worth a 500.
- **OutputFiles uses GovernancePR.filename as the source of truth for "this project owns this file"**, not a separate `Project.outputFiles` table. PRs are written per-pass anyway; rebuilding a separate index would be redundant.
- **Robust JSON extraction lives in a shared helper.** Every JSON-parsing agent goes through it. Architect's bespoke parser stays for now (it has scenario-specific truncation logic), but new agents should use the shared one.
- **Live Pipeline went from three-pane to two-row** based on real-user feedback. Phase 3 spec called for three-pane; production use revealed the browser was the focal point and side panels were stealing width. The two-row layout serves that better. Phase 3 plan stays as the historical record; this entry overrides the layout decision.

**Open items**: none — phase clean.

**Files touched**:
- `server/lib/parseJsonResponse.js` (new)
- `server/services/agents/{planner,critic,supervisor,reporter,analyst}.js` (parser swap-in)
- `server/services/gemini.js` (lenient regex)
- `server/routes/{projects,outputFiles}.js` (cleanup + filter)
- `server/scripts/cleanup-orphans.js` (new), `server/scripts/inspect-state.js` (new debug tool)
- `src/pages/Theater.jsx` (two-row layout, bigger browser)
- `src/pages/settings/{AiProviderSettings,GeminiSettings,ClaudeSettings,Settings}.jsx` (tab restructure, info box, scroll padding)
- `src/App.jsx` (new route)
- `BUILD_PLAN.md` + this file

**Verification**:
- `node --check` clean on all touched server files.
- HMR + nodemon picked up frontend + server changes live; no rebuild needed.
- Manual smoke deferred to user.

## Phase D + Phase 6 — M1 "Honest runs work" (completed 2026-05-25)

**Scope**: Pick up the project on a new laptop and ship Milestone 1 of the next-phase plan: Phase D (Conductor reasoning hardening) D1–D5 + Phase 6 (Output Files cleanup actions). Goal: an honest run on a login-required site either succeeds or stops cleanly with "BLOCKED: no credentials provided" — no fabrication, no infinite loops.

**Built**:

1. **D1 — Pre-action page-state read** ([server/services/agents/conductor.js](server/services/agents/conductor.js))
   - New `extractPageErrors(snapshot)` helper walks the Playwright-MCP accessibility tree for `role=alert` / `role=status` lines AND a fallback pass for any quoted string containing common error vocabulary (`incorrect`, `invalid`, `required`, `denied`, `not found`, `failed`, `unauthorized`, `please enter/provide/use/...`).
   - At the end of every turn the conductor scans `lastSnapshotText` (the post-tool snapshot) and prepends `Page error visible: "<text>". Read this — the page is telling you what is wrong. Do NOT submit the same inputs again.` to the next turn's messages. Per-case `surfacedErrors` Set dedupes so repeated alerts aren't injected twice.

2. **D2 — Soft repetition warning before hard-stop**
   - Hard-stop at `MAX_IDENTICAL_TOOL_CALLS` (default 3) was already in place. Added a soft warning that fires once per `${tool}|${argsHash}` key when `count >= 2 && < hard-stop` and the prior call errored: appended as a `[context guidance]` user message instructing the agent to pivot or end the turn.
   - Emits `agent.phase.warn` over WS for the same condition so the UI can surface it.

3. **D3 — Credential discipline** (schema + migration + UI + prompt)
   - Added `Project.testCredentials String?` (JSON-encoded array) in [prisma/schema.prisma](prisma/schema.prisma) + migration `20260525120000_add_test_credentials` (SQLite `RedefineTables` form so `aiProvider` survives).
   - New endpoint `PUT /api/projects/:id/credentials` in [server/routes/projects.js](server/routes/projects.js): validates each entry has `email` + `password`, caps at 20 users, normalises fields, returns the parsed array for client convenience.
   - New helper `buildTestCredentialsBlock(rawJson)` in [server/routes/agents.js](server/routes/agents.js) formats the array into a `## Available test users (use ONLY these — do not invent credentials)` block; passed through both `conductor.run` call sites (main retry loop + supervised final attempt) as `testCredentialsBlock`.
   - Conductor injects the block between SYSTEM_PROMPT_LOOP and Supervisor guidance. SYSTEM_PROMPT_LOOP updated: agent must use ONLY the listed users; if the section is absent/empty and the case needs a login, end with `BLOCKED: no credentials provided`.
   - Frontend: new collapsible `TestUsersEditor` block inside `ProjectCard` ([src/pages/ProjectSetup.jsx](src/pages/ProjectSetup.jsx)). Lazy-loads on first expand, uses `SecretInput` for passwords, save dirty-tracking, optional label + notes per user.

4. **D4 — Critic re-reads final snapshot** ([server/services/agents/conductor.js](server/services/agents/conductor.js) + [server/services/agents/critic.js](server/services/agents/critic.js))
   - After the per-case loop ends and the final screenshot is captured, conductor takes one more `browser_snapshot` and attaches the text to the case's `history` entry as `finalSnapshot`.
   - Critic's compact-history now carries `finalSnapshot` (truncated to 3000 chars). System prompt instructs the Critic to verify "pass" claims against the snapshot — if the page still shows an error banner / doesn't show the expected element, emit a rewrite flipping the case to fail with reasoning quoting the snapshot.
   - Dry-run path also pushes a `finalSnapshot: ''` so the history shape stays consistent.

5. **D5 — Amber loop-warning banner in Theater** ([src/pages/Theater.jsx](src/pages/Theater.jsx))
   - New `agentWarning` state + listener for `agent.phase.warn` WS events (emitted by D2). Renders a warn-token banner with the offending phase name, message, and a dismiss button near the top of the Live Pipeline view.
   - Cleared on new `agent.phase.start` and on matching `agent.phase.complete` to avoid stale banners after the agent recovers.

6. **Phase 6 — Output Files cleanup**
   - New shared service [server/services/outputFilesCleanup.js](server/services/outputFilesCleanup.js): `collectProjectFiles(projectId)` enumerates the GovernancePR + RunResult paths for a project; `unlinkAndReap(files)` deletes them best-effort and prunes empty per-module subdirs.
   - New endpoint `DELETE /api/projects/:projectId/output-files` in [server/routes/outputFiles.js](server/routes/outputFiles.js): wipes disk artifacts, clears `TestCase.specCode`, deletes every `GovernancePR` row for the project. Scenarios + test cases survive so the user can re-run from the same case list.
   - Regenerate auto-clear: [server/routes/scenarios.js](server/routes/scenarios.js) `POST /` with `replace: true` now collects file paths BEFORE the `deleteMany`, runs the deletes, then unlinks the orphaned files. Fixes the "DB wiped but disk survived" desync that Phase 0 carried as a known gap.
   - Frontend: "Clear all" button in `OutputFiles` page header next to "Download project.zip", with `useConfirm` dialog and success toast reporting deleted file + PR counts.

**Decisions** (recorded for future phases):

- **D1 alerts are deduped per-case, not per-turn.** Repeated occurrences of the same error text don't re-inject — the agent already saw it. This matters because Playwright MCP's snapshot includes the alert on every subsequent action until the page reloads.
- **D2 soft-warn fires once per `{tool, argsHash}` key**, not on every retry. Spamming the same warning every turn drowns out the inline-critic's hints; once is sufficient because the agent's context already carries the earlier messages.
- **D3 stores passwords in plaintext on `Project.testCredentials`**, not in the encrypted `Secret` vault. Rationale: the agent runs server-side and needs these in the prompt anyway; routing them through the vault adds friction (manual decrypt per run, separate UI flow) without changing the threat model meaningfully. They're scoped per-project, per-user, and the column is `@db.Text`-style SQLite without indexes. Re-evaluate if/when this ships to a multi-tenant deployment.
- **D4 final snapshot is captured even when the agent claims pass.** Costs one extra MCP call per case but is the only way to catch hallucinated successes. Truncated to 3000 chars in the Critic input to bound prompt size.
- **D5 banner shows only the most recent warning** (not a list). When the conductor moves on to a different stuck pattern the older banner is stale; one banner avoids vertical bloat and keeps the cancel button reachable without scrolling.
- **Phase 6 DELETE keeps test cases but wipes PR rows.** PRs are tied to specific spec files on disk — once those are gone, the PR is meaningless and `OutputFiles` would still surface scaffolding (gated on `prs.size > 0`). Wiping the PRs in the same call keeps the list honest.
- **`destructive: true` on confirm is currently a no-op** (the ConfirmDialog component doesn't accept it). Left in the call-site for future styling without breaking anything.

**Open items**:
- The `pdf-parse` / `mammoth` deps that `server/package.json` lists are only used by document upload — first POST to that path on a fresh clone may need `cd server && npm install` if a future migration adds new deps; this clone already had them.
- The user is responsible for actually putting test users into Project Setup. The agent will block (correctly) on login-required cases until they do.
- Two warnings on `prisma generate`: Update available 5.22.0 → 7.8.0. Not blocking; following the existing major-version pin until next housekeeping pass.

**Files touched**:
- `prisma/schema.prisma` (+`Project.testCredentials`)
- `prisma/migrations/20260525120000_add_test_credentials/migration.sql` (new)
- `server/services/agents/conductor.js` (D1 helper + D2 soft-warn + D4 final-snapshot capture + D3 prompt-block injection + SYSTEM_PROMPT_LOOP wording)
- `server/services/agents/critic.js` (compactHistory.finalSnapshot + prompt to verify pass claims)
- `server/routes/projects.js` (PUT /:id/credentials)
- `server/routes/agents.js` (buildTestCredentialsBlock + plumbing to both conductor.run sites)
- `server/routes/outputFiles.js` (DELETE / endpoint)
- `server/routes/scenarios.js` (collect+unlinkAndReap on regenerate)
- `server/services/outputFilesCleanup.js` (new shared helper)
- `src/pages/ProjectSetup.jsx` (TestUsersEditor)
- `src/pages/Theater.jsx` (D5 amber banner)
- `src/pages/OutputFiles.jsx` (Clear all button)
- `PHASE_LOG.md`, `BUILD_PLAN.md` (status markers)

**Verification**:
- `node --check` clean on every touched server file.
- `npx prisma migrate dev` applied the new migration; client regenerated after killing only QAAI-owned node processes (left user's other `ups-qa-portal` Vite untouched).
- Backend boots to `{ok: true, db: up}` on :5000; frontend on :5174; CORS aligned to :5174 via `.env`.
- Manual smoke deferred to user — open Project Setup → expand "Test users" → add one → run a login-required suite from Theater → confirm the system prompt picks up the block and the agent uses listed creds rather than fabricating. Also: Output Files → "Clear all" wipes disk + clears spec code.

## Phase 7 — M2 "Triage gets smart" (completed 2026-05-25)

**Scope**: AI blockage reasoning + triage UX. Every BlockedItem gets a Claude/Gemini-produced summary explaining WHY it blocked, with category, upstream root-cause TC link, and a one-line suggested fix. Severity sort, assignee, resolve-with-note round out the triage page.

**Built**:

1. **Schema additions** ([prisma/schema.prisma](prisma/schema.prisma) + migration `20260525130000_add_blocker_ai_fields`)
   - Eight new nullable columns on `BlockedItem`: `severity` (default `normal`), `assignee`, `resolveNote`, `aiSummary`, `aiCategory`, `aiRootCauseTcId`, `aiSuggestedFix`, `aiAnalyzedAt`. SQLite `ALTER TABLE ADD COLUMN` form so existing rows survive untouched.

2. **Blockage Analyzer agent** ([server/services/agents/blockageAnalyzer.js](server/services/agents/blockageAnalyzer.js) — new)
   - Canonical pattern (provider abstraction, cancel-token via signal, `parseJsonResponse`, `composeSystemPrompt`).
   - Takes `{ blockers, runCases, dependencies }`. Dependency map is scenario-level (Architect's `dependencyOn`) projected to per-TC upstream lists by the route.
   - Output enum-bounded: `category ∈ {dependency_failure | environment | data_unavailable | selector_drift | flake | unknown}`, `severity ∈ {low | normal | high}`. `rootCauseTcId` validated against the runCases set so we never persist a dangling pointer.

3. **New endpoint `POST /api/projects/:projectId/blocked/analyze`** ([server/routes/blocked.js](server/routes/blocked.js))
   - Scopes to a `runId` (defaults to the latest run) or `?all=true` for cross-history sweep.
   - Streams `agent.phase.{start,log,complete}` over WS so the global indicator + Theater banner show progress.
   - Rate-limited at 6/min. Audit-logged.

4. **Auto-trigger on Run complete** ([server/routes/agents.js](server/routes/agents.js))
   - New `autoAnalyseBlockersForRun()` invoked at the end of `runConductorWithRetries` (after the Supervisor's final attempt). Skipped on user cancellation and on runs with zero blockers.
   - Reuses the same agent input the explicit endpoint builds; failures are swallowed (the run already completed — a bad analysis shouldn't surface as a failed pipeline).
   - Emits `blocked.analyzed` WS event so the UI can refresh if open.

5. **Severity / assignee / resolve-note plumbing** ([server/routes/blocked.js](server/routes/blocked.js))
   - New `PATCH /api/projects/:projectId/blocked/:id` accepts `{ severity?, assignee? }`. Validated against `VALID_SEVERITIES`. Empty/null assignee clears.
   - `POST /:id/resolve` and `POST /:id/skip` both accept an optional `note` (≤600 chars) stored on `resolveNote` for triage history.
   - `GET /` returns the new fields enriched + pre-joins the root-cause TC (`aiRootCauseTc`) so the UI doesn't need a second hop. Server-side sort: `high > normal > low`, then `createdAt desc`.

6. **BlockedItems UI** ([src/pages/BlockedItems.jsx](src/pages/BlockedItems.jsx))
   - **"Why blocked?" panel** — accent-tinted block rendered when `aiSummary` is present. Shows category chip, narrative, root-cause TC pill, and a wrench-icon "Suggested fix" line.
   - **Severity badge + dropdown** on every row. Inline edit via `PATCH`. Optimistic UI, resyncs on failure.
   - **Assignee input** — free-form, commits on Enter or blur. Stays in sync if Re-analyse changes the value via a `useEffect`.
   - **Resolve note** — extra `Input` under the locator field (for locator reasons) or above the action buttons (otherwise). Passed through to `/resolve` and `/skip` so triage history captures *why*, not just *that*.
   - **Re-analyse button** in the page header — calls `POST /analyze` with the current scope (`latest` vs `all`). Disabled when there are zero blockers.

**Decisions** (recorded for future phases):

- **Dependency map at the route, not the agent.** Architect stores `TestScenario.dependencyOn` as a JSON-encoded array of scenario ids. Projecting scenario-level deps down to per-TC upstream lists is a route concern; the agent receives a flat `tcId -> tcId[]` so its prompt stays simple. If/when Architect emits TC-level deps directly, the route layer becomes a pass-through.
- **Severity is editable in the UI.** AI sets a default, but a human can override. The override sticks (next Re-analyse may shift it back — that's by design; the analyser is opinionated, not authoritative).
- **Auto-analysis runs even on user-cancelled runs?** No — `cancelToken?.cancelled` short-circuits. A cancelled run is one where the user explicitly didn't want more Claude calls.
- **Auto-trigger failures are silent.** The run already completed; surfacing "analyser failed" as a hard pipeline failure would be misleading. `agent.phase.complete` with `error` still fires so the UI knows the analyser tried.
- **`resolveNote` is captured at resolve/skip time, not as a separate journal.** Keeps the schema tight; if we later want a multi-comment thread we'll add a `BlockerComment` table — overkill for now.
- **The "Re-analyse" button reuses the existing rate limiter** (6/min). A user spamming it isn't free for us — each click is one Claude call per batch.

**Open items**:
- The auto-trigger fires AFTER the supervisor's final attempt completes. If a user cancels mid-Conductor, blockers from earlier attempts don't get analysed. The manual "Re-analyse" covers this; not worth wiring a partial auto-trigger.
- The "Latest run" scope on `GET /blocked` filters to the latest Run row. If the user has been navigating and a fresh run started but produced zero blockers, "Latest run" will show "clean" even when the previous run had unanalysed blockers in it. They can switch to "All time" or wait for the auto-analyse on the new run. Not a regression — preserves existing semantics.
- Severity badge palette is fixed at danger/ink/ink — could be elevated to a custom token if we eventually have a "very high" or P0-only severity.

**Files touched**:
- `prisma/schema.prisma` (+8 columns on BlockedItem)
- `prisma/migrations/20260525130000_add_blocker_ai_fields/migration.sql` (new)
- `server/services/agents/blockageAnalyzer.js` (new)
- `server/routes/blocked.js` (severity sort, PATCH, POST /analyze, note plumbing, AI fields in GET)
- `server/routes/agents.js` (auto-trigger helper + invocation in `runConductorWithRetries`)
- `src/pages/BlockedItems.jsx` (Why blocked panel, severity/assignee/note, Re-analyse button)
- `PHASE_LOG.md`, `BUILD_PLAN.md` (status markers)

**Verification**:
- `node --check` clean on `blockageAnalyzer.js`, `blocked.js`, `agents.js`.
- `npx prisma migrate dev` applied `20260525130000_add_blocker_ai_fields`; client regenerated cleanly.
- Backend boots to `{ok: true, db: up}` on :5000 with the new agent loaded.
- Manual smoke deferred to user — open Blocked Items → "Re-analyse" with a real run that has blockers → confirm each row gets an accent-tinted panel with category chip, narrative, root-cause link (when applicable), and suggested fix.

## Phase B / B3 — M3 "Sprint isolation (hybrid)" (completed 2026-05-25)

**Scope**: Treat sprint as a first-class container. Docs / Requirements / Runs / Blockers / PRs gain a `sprintId`; TestCases stay project-level and reference sprints via a new `SprintTestCase` join (populated when a Run starts). Sprint switcher pill in the page header. Sprints CRUD lives inside ProjectSetup.

User chose option **B3 hybrid** from the three documented paths (rejected B1 light = too thin and B2 full container = too invasive).

**Built**:

1. **Schema additions** ([prisma/schema.prisma](prisma/schema.prisma) + migration `20260525140000_add_sprints`)
   - New `Sprint` model: id, projectId (FK Cascade), name, lifecycle (`planning|in_progress|completed|archived`, default `in_progress`), timestamps. Indexed on projectId.
   - New `SprintTestCase` join: sprintId + testCaseId, both FK with Cascade. Unique pair, indexed on testCaseId.
   - Nullable `sprintId String?` columns added (plain TEXT, no enforced FK — application validates) on `Document`, `Requirement`, `Run`, `BlockedItem`, `GovernancePR`. Indexed.
   - Back-relations: `Project.sprints`, `TestCase.sprintTestCases`.

2. **Sprint CRUD route** ([server/routes/sprints.js](server/routes/sprints.js) — new, mounted under `/api/projects/:projectId/sprints`)
   - `GET /` lists sprints newest first with per-sprint counts for cases, documents, requirements, runs, blockers, PRs (5 batched COUNT queries, tallied in JS).
   - `POST /` create — validates name ≥ 2 / ≤ 80 chars; lifecycle defaults to `in_progress`.
   - `PATCH /:id` updates name and/or lifecycle. **Archived sprints reject writes** with `SPRINT_LOCKED` (409).
   - `DELETE /:id` clears `sprintId` to NULL on tagged artefacts BEFORE deleting the sprint row (SetNull semantics implemented at app layer because the columns are plain TEXT, not real FKs). `SprintTestCase` cascades automatically via the actual FK on that join table. Audit-logged with cleared counts.

3. **`?sprintId=` filter on list endpoints**
   - Added to [server/services/runs.js](server/services/runs.js) `listRuns` + the `/api/runs` GET route.
   - Added to [server/routes/blocked.js](server/routes/blocked.js) — sprint filter takes precedence over `?scope=latest` so flipping the sprint pill shows ALL the sprint's blockers, not just the latest run within it.
   - Added to [server/routes/requirements.js](server/routes/requirements.js) GET, [server/routes/governance.js](server/routes/governance.js) GET.

4. **Tag-on-create**
   - [server/routes/requirements.js](server/routes/requirements.js) `POST /upload` and `POST /pull/:source` accept `sprintId` in body; both the new `Document` and the synthesised `Requirement` row get the tag. Re-pull DOES re-tag with the current sprint (intent: "this is the latest state of this requirement for THIS release").
   - [server/routes/agents.js](server/routes/agents.js) `/start`, `/execute`, `/rerun-failed` accept `sprintId` in body; `runConductorWithRetries` plumbs it through both `conductor.run` call sites. `/rerun-failed` inherits the failing run's `sprintId` so the rerun lands in the same container.
   - [server/services/runs.js](server/services/runs.js) `startRun` (legacy `POST /api/runs` path) accepts sprintId; persists on Run and populates SprintTestCase membership rows via `createMany skipDuplicates`.
   - [server/services/agents/conductor.js](server/services/agents/conductor.js) accepts `sprintId` in opts and persists it on every Run / BlockedItem / GovernancePR it creates. The agent-pipeline Run also populates SprintTestCase membership BEFORE the loop starts (so a cancelled or partially-failed run still records its TC membership for sprint-comparison queries later).
   - Supervisor's `blockedItem.create` in [server/routes/agents.js](server/routes/agents.js) also stamps `sprintId`.

5. **Project store extension** ([src/store/project.jsx](src/store/project.jsx))
   - New state: `sprints`, `currentSprintId`, derived `currentSprint`. Exposes `switchSprint(id|null)` and `refreshSprints()`.
   - Persisted per-project under `qaai.currentSprintId:<projectId>` in localStorage — switching projects restores each project's last-chosen sprint independently.
   - Default selection on load: persisted choice if still valid → most recently-updated `in_progress` sprint → `null` (legacy project-wide view).
   - Sprints list resets on project switch and re-fetches via the `refreshSprints` effect.

6. **Sprint switcher pill** ([src/components/SprintPicker.jsx](src/components/SprintPicker.jsx) — new, slotted into [src/components/PageHeader.jsx](src/components/PageHeader.jsx) next to ProjectPicker)
   - Renders only when the active project has ≥1 sprint (no clutter on greenfield projects).
   - Pill shows current sprint name + lifecycle chip; opens a listbox with every sprint plus "All sprints (legacy view)" that clears the filter. Each sprint row shows counts inline. Outside-click / Escape dismisses.

7. **Sprints CRUD in ProjectSetup** ([src/pages/ProjectSetup.jsx](src/pages/ProjectSetup.jsx))
   - New `SprintsEditor` block inside `ProjectCard`, alongside `TestUsersEditor` from M1.
   - Lists each sprint with inline-editable name + lifecycle dropdown; counts strip; delete-with-confirm that warns about how many items lose their sprint tag.
   - "New sprint" button reveals an inline create form.
   - Non-active projects render a hint to activate first (avoids the cost of N parallel fetches per project card).

8. **Page wiring** — pages that fetch artifact lists now pass `currentSprintId` through:
   - [src/pages/Reports.jsx](src/pages/Reports.jsx) — `/runs?sprintId=` in the list fetch; sprint added to the effect's dep array so flipping the pill re-narrows the run list.
   - [src/pages/BlockedItems.jsx](src/pages/BlockedItems.jsx) — `/blocked?scope=&sprintId=`.
   - [src/pages/Governance.jsx](src/pages/Governance.jsx) — `/governance?sprintId=`.
   - [src/pages/RunSuite.jsx](src/pages/RunSuite.jsx) — `/requirements?sprintId=` on load; sprintId passed in upload + pull bodies.
   - [src/pages/TestCases.jsx](src/pages/TestCases.jsx), [src/pages/Theater.jsx](src/pages/Theater.jsx) — sprintId passed to `/agents/execute` and `/agents/rerun-failed`.

**Decisions** (recorded for future phases):

- **B3 hybrid over B2 full container**: TestCases stay project-level because smoke tests are reused across sprints. The `SprintTestCase` join captures which cases ran in which sprint — that's enough to support sprint comparison and carry-forward features in Phase B+ without rewriting the TC ownership model.
- **`sprintId` columns on artefact tables are plain TEXT, not FKs**: avoids the SQLite RedefineTables rewrite pattern for 5 existing tables (massive migration). Integrity is enforced at the Prisma application layer (the Sprint table itself does have a real FK to Project). The Sprint and SprintTestCase tables are new, so they can use real FK constraints from the start.
- **SetNull on sprint delete is application-layer**: because the artefact `sprintId` columns aren't real FKs, the route explicitly runs `updateMany({ sprintId: null })` on each tagged table before deleting the sprint. Audit-logged with the per-table counts so we can verify nothing leaked.
- **Archived sprints reject writes**: PATCH + DELETE return `SPRINT_LOCKED` (409). UI mirrors this by disabling the inputs/dropdown on archived rows. Why: archived = "historical record"; mutating it would lie about what shipped in that release.
- **`?sprintId=` query param + tagged-on-create body field is opt-in**: legacy clients that don't send the field get the project-wide view (status quo). No backfill — pre-Sprint artefacts stay with `sprintId = NULL` forever and surface in the "All sprints (legacy view)" option of the picker.
- **Sprint pill is hidden on projects with zero sprints**: keeps the header clean for greenfield projects. The first sprint a user creates via Project Setup makes the pill appear.
- **Default sprint selection on load**: persisted choice → in-progress sprint → null. Why not "always pick the most recent in-progress"? Because users with multiple in-progress sprints (rare but possible — e.g. parallel feature branches) need their last selection respected.
- **SprintTestCase populated at Run start, not at completion**: even a cancelled run leaves the membership trail intact, which matters for "which cases were attempted in Sprint N" queries (a cancellation is still a sprint event).
- **No comparison view, lifecycle gates, or carry-forward yet**: explicitly deferred to Phase B+ per the BUILD_PLAN. M3 ships the substrate; B+ ships the QA-lead-facing features that ride on it.

**Open items**:
- Discrepancy model does NOT yet have a `sprintId` column (intentional — discrepancies are a side feature on RunSuite and the user hasn't asked for sprint-scoping there).
- Overview dashboard doesn't yet narrow by sprint. Lower priority — the dashboard already aggregates by project; sprint narrowing is a Phase B+ "Sprint health tile" feature.
- ExecutionLog page list fetch (`/runs?projectId=...`) doesn't pass `sprintId` yet — it's a debug surface, not a primary user view; can add later.
- Tests for the new endpoints would be valuable. None of the existing suites cover Sprint CRUD or the new filters yet.
- The cancellation pattern on `runConductorWithRetries` doesn't yet pass an AbortSignal to the autoAnalyseBlockersForRun (M2) when a sprint switch happens mid-run. Edge case; the analyser is best-effort anyway.

**Files touched**:
- `prisma/schema.prisma` (Sprint, SprintTestCase + sprintId on 5 tables)
- `prisma/migrations/20260525140000_add_sprints/migration.sql` (new)
- `server/routes/sprints.js` (new)
- `server/index.js` (mount + require)
- `server/routes/{runs,blocked,requirements,governance,agents}.js` (filters + tagging + sprintId plumbing)
- `server/services/runs.js` (`startRun` accepts sprintId + populates join)
- `server/services/agents/conductor.js` (sprintId in Run + SprintTestCase + BlockedItem + PR)
- `src/store/project.jsx` (sprints/currentSprintId state + switchSprint + refreshSprints)
- `src/components/SprintPicker.jsx` (new), `src/components/PageHeader.jsx` (slot)
- `src/pages/ProjectSetup.jsx` (SprintsEditor)
- `src/pages/{Reports,BlockedItems,Governance,RunSuite,TestCases,Theater}.jsx` (sprintId in fetches + create payloads)
- `PHASE_LOG.md`, `BUILD_PLAN.md`

**Verification**:
- `node --check` clean on every touched server file.
- `npx prisma migrate dev` applied `20260525140000_add_sprints`; client regenerated cleanly after killing only QAAI backend node processes (Vite for QAAI and the user's other ups-qa-portal Vite left running).
- Backend boots to `{ok: true, db: up}` on :5000.
- Frontend HMR picks up store + page changes live.
- Manual smoke deferred to user — open Project Setup → expand "Sprints" → create one → header pill should appear → switch the pill → run a suite → confirm the new Run / BlockedItem / GovernancePR rows carry the new sprint's id (verify via Prisma Studio or `npx prisma studio` on :5555).

## Phase 8 — M4 "Governance gets real" (completed 2026-05-25)

**Scope**: Replace the single-pane Governance view with a real review UX. Side-by-side diff vs the last merged PR for the same TC; approve / reject / merge with confirm dialogs; comments thread per PR; lint findings clickable to jump + pulse-highlight the matching line in both code and diff views. Also a token-palette pass through the page (replaced raw amber/sky/emerald/rose).

**Built**:

1. **PRComment schema** ([prisma/schema.prisma](prisma/schema.prisma) + migration `20260525150000_add_pr_comments`)
   - Single new table: id, prId (FK Cascade), author (email — display-only, no User FK), body, createdAt. Indexed on `(prId, createdAt)` for thread fetch.
   - Back-relation `GovernancePR.comments`.

2. **Line-diff helper** ([server/lib/lineDiff.js](server/lib/lineDiff.js) — new)
   - LCS-based O(M·N) line diff over two strings. Flat `Uint32Array` for the table so the inner loop stays cache-friendly. Sufficient for spec files up to a few thousand lines — we'd swap to Myers only if needed.
   - `diffLines(left, right)` returns side-by-side row stream: `{ kind: 'equal' | 'remove' | 'add', leftNo, leftText, rightNo, rightText }`. `summarise(rows)` returns the header chip counts.

3. **Governance route additions** ([server/routes/governance.js](server/routes/governance.js))
   - `GET /:id/diff` — picks the BASE as the most recent merged PR for the same `testCaseId` on the same project (excludes the active PR). Greenfield case (no prior merge or no testCaseId) renders the current code as 100% additions. Returns `{ baseRef, rows, summary }`.
   - `GET /:id/comments` — chronological thread for a PR.
   - `POST /:id/comments` — validates body (non-empty, ≤4000 chars); author = `req.user.email`. Audit-logged.
   - `DELETE /:id/comments/:cid` — only the comment's own author can delete (403 otherwise). Audit-logged.

4. **Governance UI rewrite** ([src/pages/Governance.jsx](src/pages/Governance.jsx))
   - **View tabs**: "Code" (line-numbered current spec) and "Diff vs main" (side-by-side, +N/-N chip in the header). Diff fetches lazily on first switch and caches per active PR.
   - **Side-by-side renderer**: two-column grid; removes tinted `danger-900/40`, adds tinted `success-900/40`, empty cells `ink-800/30`. Line numbers per side.
   - **Lint click-to-jump**: every finding with a `line` now has a "Line N" pill on the right. Clicking it scrolls the active view to that row and pulses it (`bg-warn-700/40` for 2 s on the code view, amber ring-inset on the diff right-side). 2 s timeout is cleaned up on unmount.
   - **Comments thread** below the action footer: list (author / timestamp / body), "delete" pill only on your own entries (server enforces 403 too), a 3-row composer with `⌘↵` submit and a 4000-char counter.
   - **Approve / Reject / Merge** routed through `useConfirm`. Merge dialog calls out that "the spec becomes the new baseline" so diff base behaviour is non-surprising.
   - **Palette pass**: replaced every `bg-amber-*`, `bg-sky-*`, `bg-emerald-*`, `bg-rose-*`, `text-rose-*` with `warn` / `info` / `success` / `danger` tokens per CLAUDE.md.

**Decisions** (recorded for future phases):

- **Base for diff = "most recent merged PR for same TC"**, not "current file on disk" or "first ever PR". Reason: matches the user's mental model ("what's changed since last release of THIS test"). If we'd diffed against disk, regenerating a TC would compare against the NEW file already on disk → diff always empty.
- **Greenfield renders 100% adds**: keeps the diff view useful for first-time PRs. The header chip explicitly says "New file (no prior merge)" so the user isn't confused.
- **Comments are flat, not threaded.** A nested-reply tree would force a `parentId` schema + more route surface for no demonstrated need. Flat list is what GitHub started with too; we can layer threading later if signal emerges.
- **Author = email, not userId.** Display-only; cross-project PRs already exist, and forcing a User FK would couple comment surface to user identity in a way that fights the "lightweight review" model.
- **Only the original author can delete their comments.** No admin override path. If the comment is wrong-but-uncorrectable, the right move is to post a follow-up, not silently delete history.
- **Diff is computed at request time**, not cached. Spec files are small (KB) and the LCS table is sub-millisecond; caching adds invalidation complexity. If a PR's specCode gets re-lint'd or otherwise mutated, the next diff fetch reflects it automatically.
- **Lint findings with no `line` field still render** — they get no "Line N" pill but show the rule + message. Reasonable default since some rules (e.g. "no console.log anywhere") are file-scope.
- **Approve/Reject are NOT destructive in the dialog UX** (no `destructive: true`); merge IS, because it's the irreversible state transition. Aligns with how teams actually think about review.

**Open items**:
- The `destructive: true` confirm prop is still a no-op (ConfirmDialog doesn't read it). Cosmetic; left in for when we eventually add a destructive-button variant.
- No PR push to GitHub/GitLab/ADO Repos. Same scope-limit from earlier phases — "Merge" remains a DB state machine. The diff substrate makes a future external-PR-push integration easier (we already have the rows; just need a `git` push handler).
- Comments aren't WebSocket-streamed. A second reviewer would need to refresh the page to see new posts. Low priority; nobody's reviewing two people on the same PR at the same second.

**Files touched**:
- `prisma/schema.prisma` (+ PRComment model + comments back-relation on GovernancePR)
- `prisma/migrations/20260525150000_add_pr_comments/migration.sql` (new)
- `server/lib/lineDiff.js` (new)
- `server/routes/governance.js` (+ /diff, +/comments, + /comments/:cid)
- `src/pages/Governance.jsx` (full rewrite — DiffView + CommentsThread + lint-click + confirm + token palette)
- `PHASE_LOG.md`, `BUILD_PLAN.md`

**Verification**:
- `node --check` clean on `server/routes/governance.js` and `server/lib/lineDiff.js`.
- `npx prisma migrate dev` applied `20260525150000_add_pr_comments`; client regenerated cleanly.
- Backend boots to `{ok: true, db: up}` on :5000.
- Frontend HMR picks up the page rewrite live.
- Manual smoke deferred to user — open Governance → pick a PR → switch to "Diff vs main" → confirm side-by-side render → click a lint finding's "Line N" pill → confirm the right-side row pulses and scrolls into view → post a comment → confirm it appears with your email + timestamp → Approve → Merge — confirm dialogs fire and PR moves through the state machine.


## M5 — Phase 10 + 11 quick wins (completed 2026-05-25)

**Scope**: Two small, high-leverage polish bundles that turn pages that were already correct-but-flat into pages a user can actually live in. Phase 10 makes the Execution Log searchable + filterable + copyable. Phase 11 makes the AI Provider settings pages do something useful on visit (Test connection primary CTA) and gives the sidebar a permanent at-a-glance signal for "is my provider key still healthy?".

**Built (Phase 10 — Execution Log)**:
- Level classification of every line via a small client-side heuristic (no server schema change): `phase | pass | warn | error | info`. Driven by leading-glyph + vocabulary patterns the server already emits (▶, 🚀, 📝, ✅, ❌, ⚠, ERROR, CRITICAL, SUITE COMPLETE). Keeps the WS protocol a single string field — historic log lines still classify cleanly.
- Four filter chips with live counts (Phases / Passes / Warnings / Errors). Multi-select; empty selection = show all. Clears on project switch so stale filters don't hide new-project output.
- Search input that does a case-insensitive `includes()` across the visible (filtered) lines.
- Copy button copies the *filtered* set when filters are active, otherwise the full log. Falls back to `document.execCommand('copy')` for browsers without `navigator.clipboard`.
- Auto-scroll is now smart: pins to bottom by default; pauses the moment the user scrolls up; surfaces a "Jump to latest" floating button + "Scroll paused" amber chip so the pause state is discoverable.
- Color tones moved to the token palette (`text-success-300` / `text-warn-300` / `text-danger-300` / `text-info-200`) — old code used raw `text-emerald-300`. Connection dot moved off `bg-emerald-500` / `bg-rose-500` to `bg-success-500` / `bg-danger-500`.
- "Recent runs" panel now honours the active sprint (passes `?sprintId=` so the list matches what Reports/Theater would show).

**Built (Phase 11 — Settings polish)**:
- New backend endpoints `POST /api/settings/claude/test` and `POST /api/settings/gemini/test`. Pull the stored key from the vault server-side, call the same `validateApiKey()` path `/validate` uses, persist `lastValidatedAt` / `lastError`, audit-log the result. Behind the existing 10/min rate limit so a stolen session cookie can't oracle-spam the upstream provider.
- "Test connection" primary CTA on both Claude and Gemini settings. When the form is clean and a key is stored, the right-hand primary button transforms from "No changes" (disabled, useless) into "Test connection" (live API check). When the user types a new key, the primary slot flips back to "Save changes" and Validate returns as secondary.
- New `<ClaudeUsageTile>` tile on ClaudeSettings. Reuses the existing `claudeRateLimit` from `useRunStream()` (no extra server load, no per-user-key cost): renders TPM tokens-used bar + percentage + reset countdown + optional requests-per-minute row + "Last sampled Ns ago" footer. Idle state when configured but no agent calls yet — explains what's expected rather than rendering broken.
- Sidebar provider status row under the Settings nav entry: `Claude · OK` / `Claude · Missing key` / `Gemini · Invalid`, color-coded via tokens. Links straight to `/settings/<provider>` so the bad path is one click. Collapses to a tiny status dot on the Settings icon in icon-only sidebar mode. Fetches on auth + on every exit from a `/settings/*` route so save/delete actions reflect within one navigation.

**Decisions**:
- **Filter heuristic stays client-side**. Pushing structured `{level: 'error'}` over WS would force a wire-protocol change AND leave the entire backlog of pre-change runs un-categorisable. The leading-glyph convention is already a de-facto contract the server uses; encoding it as a parser is honest and forward-compatible.
- **Copy copies the filtered view, not the raw log**. When a user filters down to errors and clicks Copy, they want just the errors — that's the explicit narrowing they did. Surface what's visible.
- **`/test` lives next to `/validate`, not as `/validate?stored=1`**. Same shape, but two endpoints keep the audit trail clean (`settings.claude.validate` vs `settings.claude.test`) and make the rate-limit story self-documenting.
- **Sidebar status row only fetches when the user changes auth or leaves /settings/***. Polling every N seconds would burn cycles for a value that almost never changes; the after-save fetch on settings-exit captures 100% of the cases where it would have changed.
- **The usage tile reuses the WS rate-limit feed** rather than introducing a new `/settings/claude/usage` endpoint. Adding an endpoint that hits Anthropic just to display a usage tile would cost the user a request every page load — the WS path already provides this data for free as a side effect of real work.

**Open items**:
- The provider status row won't auto-refresh if the user has the sidebar open and an API key elsewhere gets revoked mid-session. The Settings page reflects truth on visit; only the sidebar chip lags. Acceptable for a single-tenant dev tool.
- Phase 9 (Knowledge Base flaky-locator timeline) is deferred — the local DB has <20 locators, so the page would render empty for me and a chart would be misleading. Will land when there's enough signal.

**Files touched**:
- `src/pages/ExecutionLog.jsx` (full rewrite — classification, filters, search, copy, auto-scroll pause, palette)
- `server/routes/settings.claude.js` (+ POST /test)
- `server/routes/settings.gemini.js` (+ POST /test)
- `src/pages/settings/ClaudeSettings.jsx` (Test-connection CTA, /test path, ClaudeUsageTile)
- `src/pages/settings/GeminiSettings.jsx` (Test-connection CTA, /test path)
- `src/components/Sidebar.jsx` (useProviderStatus hook + ProviderStatusRow component)
- `PHASE_LOG.md`, `BUILD_PLAN.md`

**Verification**:
- `node --check` clean on `server/routes/settings.claude.js` and `server/routes/settings.gemini.js`.
- `npx vite build` succeeds (1633 modules, ~37s).
- Backend boots to `{ok: true, db: up}` on :5000; nodemon auto-reloaded on the route changes.
- Manual smoke deferred to user — open Execution Log → click level chips → confirm counts match what is visible; type in search; click Copy and confirm clipboard payload matches filtered view. Then Settings → Claude → confirm "Test connection" is the right-side primary when key is configured + clean; click it → confirm toast + lastValidatedAt updates. Sidebar should show `Claude · OK` in green; delete the key → row flips to `Claude · Missing key` after one navigation.

---

## Phase B+ / M6 — sprint enhancements (completed 2026-05-25)

### Scope
Phase B+ "full bundle" per the M6 plan: lifecycle gate, comparison view, carry-forward failures, sprint-scoped AI guidance, and a sprint health tile on Overview. Everything sits on top of the B3 hybrid sprint container that landed in M3.

### Built
- **Schema**: added `Sprint.aiGuidance String?` (operator guidance per release cycle) and `Sprint.expectedEndAt DateTime?` (drives "days to cut"). Migration `20260525160000_sprint_guidance_and_endat` — pure additive ALTER TABLE, no data backfill needed since both nullable.
- **promptCompose**: extended `joinGuidance` to accept `sprintGuidance` between `projectGuidance` and `caseGuidance`. Composer wraps each in its own labelled section so the model can tell the layers apart.
- **agents.js**: new `loadSprintGuidance(sprintId)` helper. Each of `/start`, `/execute`, `/rerun-failed` resolves the sprint guidance once and threads it through Architect/Planner extraGuidance and into `runConductorWithRetries` (which already received `sprintId`). Conductor/Critic/Supervisor pick it up via the existing `extraGuidance` plumbing.
- **Sprints route — lifecycle gate**: `PATCH /:id` with `lifecycle: 'completed'` runs `uncoveredP0Cases(projectId, sprintId)` — all approved cases whose scenario is P0 minus any case with a `RunResult` row in any run of this sprint. Non-empty list returns `409 SPRINT_INCOMPLETE` plus a `missing` array (id/name/module). Operator escape hatch: `?force=1` skips the check.
- **Sprints route — new fields**: `aiGuidance` (trimmed; empty clears) and `expectedEndAt` (ISO date) are accepted on PATCH and surfaced on GET.
- **Sprints route — carry-forward**: `POST /:id/carry-forward-failures` finds the most recent completed sprint (other than this one) for this project, takes the latest `RunResult` per `testCaseId` in its runs, filters to `fail|blocked`, and inserts `SprintTestCase` rows for any not already linked. Returns `{ carried, skipped, fromSprint }`. Idempotent — re-clicking after a partial carry is harmless.
- **Sprints route — health**: `GET /:id/health` builds latest-result-per-case maps for both this sprint and the previous one in a single shot, then computes pass/fail/blocked/skipped counts, pass-rate (executed denominator), regressions (was pass, now bad), recoveries (was bad, now pass), and new cases. Also returns `daysOpen` (since createdAt) and `daysToCut` (relative to expectedEndAt) for the Overview tile.
- **Sprints route — compare**: `GET /compare?a=&b=` diffs two sprints. Per testCaseId, classifies as `newFailures` / `newPasses` / `stillFailing` / `stillPassing` / `onlyInA` / `onlyInB`. Returns slim records (id/name/module/a-status/b-status/short error) plus a summary count block.
- **ProjectSetup SprintCard**: rewrote the per-sprint card body. Default state shows name/lifecycle/counts; "More options" expander reveals the guidance textarea (4000-char cap), planned-end date input, and three action buttons: Mark complete, Carry forward failures, Compare. Lifecycle drop-down still flips directly between states; the SPRINT_INCOMPLETE response is intercepted in the React layer and surfaced via a confirm dialog ("Force complete" with the unrun-P0 preview).
- **Overview SprintHealthTile**: new section above the recommendation hero row, renders when `currentSprint?.id` is set. Four sub-tiles: pass rate (tone by threshold), regressions vs prev, recoveries vs prev, days-open / days-to-cut. Optional "vs <prev>" CTA in the tile header navigates to the compare view pre-populated with A=prev, B=current.
- **SprintCompare page**: new route `/sprints/compare?a=&b=`. Top-row Select pickers let the operator retarget A/B without leaving the page. Below: four summary tiles (new failures / new passes / still failing / still passing), then four ordered sections: Regressions, Recoveries, Still failing, and a final two-column "Only in A / Only in B" row. Each case row shows `<status A> → <status B>` pills plus error preview where available. URL is the source of truth — links from Overview and ProjectSetup deep-link cleanly.

### Decisions
- **P0 gate uses scenario.priority, not case.priority** — cases don't carry a priority field; the scenario does. Approved + scenario.priority='P0' is the right bound. "Has run" = any RunResult row (regardless of pass/fail/blocked); pass-rate gating is a separate concern best left to the recommendation engine.
- **Carry-forward populates `SprintTestCase`, not test-case status** — the operator may want to skim the carried list before running. Setting cases back to `approved` would override the user's explicit reject/regenerate decisions on those cases since the failing sprint. The join row is enough to drive the new "carried" count badge and to feed the compare view; the operator triggers the actual rerun through the normal /run-suite or /rerun-failed flow.
- **Sprint guidance loaded once per pipeline, not per agent call** — fetched at route entry, snapshotted on the cancel-token scope. Editing the sprint's guidance mid-pipeline doesn't retroactively change the current run, which matches how `Project.aiGuidance` already behaves. Avoids "did the agent see my edit?" ambiguity.
- **Compare endpoint is project-scoped (`/sprints/compare`), not nested under one sprint** — both sides are equally first-class; nesting it under `/sprints/:id/compare?other=...` would imply directionality. The route handler still enforces both sprints belong to the requesting project.
- **Lifecycle gate is a refusal, not a warning** — soft gates get ignored. The 409 + force-flag pattern matches how every other dangerous transition in the app behaves (PR merge, project delete) and gives the operator an explicit "I know what I'm doing" affordance.

### Open items
- Health tile compares against the chronologically-previous sprint only — no "compare against sprint named X" option from the tile. Use the compare page for that.
- Carry-forward doesn't auto-rerun; it just populates membership. Documenting in a tooltip — power-user paths will add a "Run carried cases" deep-link once we see whether the operator wants single-click reruns.
- Days-to-cut treats `expectedEndAt` as a wall-clock date with no timezone; on the boundary day this can read as off-by-one for non-UTC operators. Fine for v1.

### Files touched
- `prisma/schema.prisma`
- `prisma/migrations/20260525160000_sprint_guidance_and_endat/migration.sql`
- `server/lib/promptCompose.js`
- `server/routes/agents.js`
- `server/routes/sprints.js`
- `src/pages/ProjectSetup.jsx`
- `src/pages/Overview.jsx`
- `src/pages/SprintCompare.jsx` (new)
- `src/App.jsx`
- `BUILD_PLAN.md`

### Verification
- `node --check` clean on `server/routes/agents.js`, `server/routes/sprints.js`, `server/lib/promptCompose.js`.
- `npx prisma migrate dev --name sprint_guidance_and_endat` applies the migration (Sprint table gains `aiGuidance` + `expectedEndAt` columns) and regenerates the Prisma client in ~190 ms.
- `npx vite build` succeeds — 1634 modules, ~4.5 s (one more module than M5 = new SprintCompare page).
- Backend restarts to `{ok: true, db: up}` on :5000 with the new sprint endpoints mounted.
- Manual smoke deferred to user: open Project Setup → expand a Sprint card's "More options" → set guidance and a planned end date → switch the sprint pill in the header to that sprint → trigger a run → confirm guidance flows into the agent prompt (check the Architect/Conductor log preamble). Then attempt to mark complete with an approved P0 case unrun → confirm the dialog lists it and "Force complete" closes the gate. Then go to Overview → confirm the sprint health tile renders with the right counts. Click "vs <prev>" → land on /sprints/compare → confirm A/B summary + regressions section.

---

## Phase E1.1-E1.3 — self-healing locator engine, server-side substrate (completed 2026-05-25)

### Scope
First half of BUILD_PLAN_V2 E1. Ships the schema, the healer agent, the Conductor interceptor that swaps in a healed locator transparently mid-run, and the first-sighting capture that builds the locator corpus over time. **UI surface (E1.4 DOM-snapshot pane in Theater, E1.5 KnowledgeBase health timeline + top-flaky + search) deferred to the next session** per V2's hard rule: do not surface the snapshot pane until the infrastructure heals correctly end-to-end.

### Built
- **Schema (E1.1)**: extended `KnowledgeBaseLocator` with `intent`, `accessibleName`, `role`, `pageUrl`, `domAnchor`, `failureCount`, `lastFailedAt`, `healHistory`, `parentProjectId`. Added `@@index([projectId, healthScore])` for the quarantine-scan query. Migration `20260526100000_locator_intent_model` — pure additive ALTER TABLE, no row rewrite. Applied via `npx prisma migrate dev` in 241 ms.
- **Healer agent (E1.2a)** at [server/services/agents/healer.js](server/services/agents/healer.js): provider-agnostic LLM call. Reads the fresh Playwright-MCP accessibility-tree snapshot, the intent, the broken-locator string, and the history of past heals (last 5). Emits strict JSON `{ strategy, selector, confidence: 0-99, reasoning }`. Strategy preference is encoded in the prompt: role > testid > label > text > css. CSS is explicitly de-prioritised; generated class names with numeric tails are flagged as anti-patterns. Cancellation-aware (accepts `AbortSignal`). Confidence below 30 is treated as "snapshot doesn't contain the intended element".
- **Conductor interceptor (E1.2b)** in [server/services/agents/conductor.js](server/services/agents/conductor.js): two hooks layered into the tool-use loop.
  1. **Pre-call quarantine check**: before every `mcp.callTool`, look up the targeted element's KB row. If `healthScore < QUARANTINE_HEALTH` (default 30), refuse to invoke the tool. Synthesise a `BLOCKED: locator quarantined` tool result and emit a `BlockedItem` (category `selector_drift`, severity `high`). Prevents the agent from burning more attempts on a genuinely-deleted element.
  2. **Post-failure heal-on-error**: when a tool errors with a locator-class message (regex matrix on `element not found` / `locator timeout` / `ref expired` / etc.), take a fresh `browser_snapshot`, invoke the healer, and try to map the healer's role-name proposal to a `ref` in the fresh snapshot using the existing `parseMcpSnapshotToCandidates`. If a ref matches AND confidence ≥ `HEAL_MIN_CONFIDENCE` (default 70), re-issue the original tool with the new ref. On retry success: `result` is replaced wholesale so the agent loop sees a clean success; KB row gets `healthScore += 5`, `failureCount -= 1`, `selector` updated, `healHistory` appended with `outcome:'success'`. On retry failure or low confidence: `healthScore -= 20`, `failureCount += 1`, `healHistory` appended with `outcome:'failed'`, and a `selector_drift` BlockedItem is emitted with the healer's `reasoning` as `aiSuggestedFix`.
- **First-sighting capture (E1.3)** in [server/services/agents/conductor.js](server/services/agents/conductor.js#recordSuccessfulLocator): on every successful tool call against an element, fire-and-forget upsert into KB capturing `intent` (the human label from `tu.input.element`), `accessibleName` + `role` from the snapshot match, and a ±2-line `domAnchor` slice around the match. Idempotent — only fills in NULL fields, bumps `occurrences`. Best-effort; never blocks the run on a KB write hiccup. Pre-existing rows (e.g. a row promoted by a successful heal) are not clobbered.
- **Healing observability**: every heal attempt emits structured `agent.phase.log` events under the `healer` phase (existing log-classification picks these up via the same heuristic). The Theater action trail still surfaces the original tool result that won (either the first successful call or the healed retry).

### Decisions
- **Refs, not selectors, are what get re-issued.** V2 said "re-issue the tool with the new selector", but `@playwright/mcp` tools (`browser_click`, `browser_type`, `browser_fill_form`) are ref-based, not selector-based. The bridge: the healer returns a strategy + selector (used as KB-stored recipe for FUTURE runs), and the Conductor maps that proposal to a ref in the CURRENT snapshot via `findRefForHealedProposal` (CSS strategies can't be ref-resolved — we record the heal in KB but fall through to Claude on the current attempt).
- **Healer is provider-agnostic but stays on the project's flagship model in E1.** Phase E5 will route it to Haiku 4.5 (cheap, sufficient for DOM-reading). For now it inherits whatever the project's primary provider is so we can stabilise the JSON parsing path before introducing model routing.
- **Quarantine is a pre-call refusal, not a soft warning.** Matches the V2 rule and the way every other dangerous transition behaves (SPRINT_LOCKED, project-delete confirm). The agent is told via the synthetic tool result that the locator is dead so it pivots instead of guessing alternative refs for the same intent.
- **Heal succeed/fail is invisible to Claude when it works.** No synthetic user message, no retried-tool-result block. Claude's context stays clean — fewer tokens, less context churn, no second-guessing. The win is reflected only in the KB row + the structured log events the UI surfaces in E1.4.
- **First-sighting capture is best-effort.** Wrapped in try/catch that swallows everything. Reasoning: KB rows are derived data; missing one is fine — a future successful call upserts again. NEVER block the run.
- **The healer's history input is capped at the last 5 attempts.** The full healHistory keeps the last 50 (size guard), but the healer's prompt only needs recent failures to know what NOT to repeat. 5 is enough; more is just token cost.

### Open items (deferred to next session)
- **E1.4 — DOM snapshot viewer in Theater**: collapsible right-pane showing the latest accessibility-tree text via a new `mcp.snapshot.preview` WS event (truncated to 8 KB). Trivial UI, intentional deferral so we validate the heal-loop end-to-end first.
- **E1.5 — KnowledgeBase page upgrade**: per-locator health timeline (SVG line chart of `healthScore` over `healHistory` entries), top-10 flaky locators (sort by failureCount desc), search by element/selector. This is what closes the original Phase 9 — the data is now there, just needs surfacing.
- **`POST /api/projects/:p/locators/:id/heal-now`** endpoint: launches a fresh MCP session, navigates to `pageUrl`, calls the healer manually, persists result. Surfaced as a button on `selector_drift` BlockedItems. Holds for E1.4.
- **CSS-strategy heal proposals aren't ref-resolved.** If the healer returns `{strategy:'css', selector:'#new-id'}`, we record it for the next run but can't retry it this run (no ref lookup). Future improvement: invoke `browser_evaluate` with `document.querySelector(selector)` to resolve, or expose a custom MCP tool that resolves a CSS selector to a ref.

### Files touched
- `prisma/schema.prisma` (KnowledgeBaseLocator additions)
- `prisma/migrations/20260526100000_locator_intent_model/migration.sql` (new)
- `server/services/agents/healer.js` (new)
- `server/services/agents/conductor.js` (helpers + quarantine + heal-on-error + first-sighting)
- `BUILD_PLAN_V2.md` (status marker)

### Verification
- `node --check` clean on `server/services/agents/conductor.js` and `server/services/agents/healer.js`.
- `npx prisma migrate dev --name locator_intent_model` applies the migration cleanly (Prisma client regenerated in 241 ms).
- `npx vite build` succeeds — 1634 modules, ~5.1 s. (Same module count as M6; no new frontend modules in E1.1-E1.3.)
- Backend restarts to `{ok: true, db: up}` on :5000 with the new code loaded.
- Manual smoke deferred to user — needs a live run against a page where a known locator's data-testid has changed. Expected behaviour: tool errors with locator-class message → Conductor logs `🩺 Locator-class failure on "<label>" — invoking healer…` → fresh snapshot taken → healer logs proposal → `↻ Retrying ${tool} with healed ref=… (role, conf N)` → on success: `✅ Heal succeeded — locator KB updated for "<label>"`. The case should pass without Claude ever seeing the failure. A second run with the SAME stale KB selector should hit the cached healed selector on first attempt.

---

## Phase E1.4 — UI surfaces for the heal loop (completed 2026-05-25)

### Scope
Operator-facing UI for the self-healing infrastructure that landed in E1.1-E1.3. Two pieces: the **DOM snapshot pane in Theater** (so the operator can see exactly what the agent is reading) and the **Heal-now button on selector_drift blockers** (so a stuck locator can be manually healed without re-running the whole suite). Backed by a new `POST /api/projects/:p/knowledge-base/:id/heal-now` endpoint that spins up a fresh Chromium session, takes a snapshot, calls the healer, and persists the result.

### Built
- **`mcp.snapshot.preview` WS event** in [server/services/mcp.js](server/services/mcp.js#callTool): every tool call whose result carries snapshot text fires `{ type:'mcp.snapshot.preview', sessionId, tool, snapshot, truncated, length, ts }`. Preview is sliced to 8 KB (full snapshot still cached server-side on `session.lastSnapshot` for the healer). Best-effort — wrapped in try/catch so a dead WS never blocks the loop.
- **runStream subscriber** in [src/store/runStream.jsx](src/store/runStream.jsx): new `mcpSnapshot` field in context, reset on project switch. Latest preview overwrites prior — we keep one frame, not history.
- **Theater DOM snapshot pane** in [src/pages/Theater.jsx](src/pages/Theater.jsx) (`DomSnapshotPane`): collapsible card below the BrowserFrame+ActionTrail row. Header shows tool name, line count, byte length, and "time ago" relative stamp. Expanded body renders the accessibility-tree text in a max-height-420 mono pane with a "Copy" affordance. Truncated previews are labelled. Renders only when an MCP session has emitted at least one snapshot.
- **`POST /api/projects/:p/knowledge-base/:id/heal-now`** in [server/routes/knowledgeBase.js](server/routes/knowledgeBase.js): rate-limited (3/min/user — each call burns a Chromium boot + a Claude call). Validates ownership, resolves the project's AI credentials, requires either `locator.pageUrl` or `project.targetUrl` as the start URL, spawns a fresh MCP session (broadcast=noop — this is a standalone session, no Theater stream), takes a snapshot, invokes `healer.healLocator`, and persists. Selector + healthScore only auto-promote when confidence ≥ 70; lower-confidence proposals still get appended to `healHistory` for review. Returns `{ healed, locator }`. Audit-logged as `kb.heal_now` (or `kb.heal_now.no_proposal` when the healer returns nothing).
- **Heal-now button on BlockedItems** in [src/pages/BlockedItems.jsx](src/pages/BlockedItems.jsx): renders inside the "Why blocked?" panel, only when `aiCategory === 'selector_drift'` AND the server resolved a matching KB row. Button label: "Heal locator from current DOM" with a wand icon. Surfaces KB health score inline. On result: shows strategy + confidence + selector + reasoning; success state ("KB updated") vs low-confidence state ("KB unchanged, review") clearly distinguished. Triggers a `load()` on success so other blockers' KB chips refresh.
- **Blocker enrichment** in [server/routes/blocked.js](server/routes/blocked.js): GET response now includes `kbLocator: { id, element, selector, healthScore }` for selector_drift items. Batched single-query join against `KnowledgeBaseLocator` matching on either `element` OR `selector` field (because the conductor stores `locator = kb.selector || targetElement` depending on whether the KB row existed when the blocker was created).

### Decisions
- **Manual heal does NOT auto-retry the failing test case.** The button heals the *locator metadata*; the operator chooses when to re-run. Reason: a healed selector still needs human judgment ("yes that's the same element semantically") before becoming load-bearing. Auto-retrying would mask cases where the page genuinely changed function.
- **Snapshot preview is 8 KB cap.** Big enough for the visible viewport on typical SaaS pages; small enough to ship every tool call without spamming the WS. Healer + picker still read the untruncated `lastSnapshot` server-side.
- **Heal-now sessions are NOT broadcast to Theater.** A second Chromium window popping up while the user is reading a Reports page would be confusing. Standalone session with a noop broadcast.
- **The button only shows when `kbLocator` is resolved on the server.** Avoids dead buttons on legacy blockers whose locator string doesn't match any KB row. Operator never sees "click this button → it does nothing useful".
- **Low-confidence proposals (< 70) don't promote.** Same threshold as the in-loop heal. The healHistory entry tags `outcome: 'low_confidence'` so future analytics can surface "we keep suggesting bad locators on this page".

### Open items (deferred to E1.5)
- **KnowledgeBase page upgrade**: per-locator health timeline chart, top-10 flaky locators panel, search by element/selector. The data is in `healHistory` now — the UI just needs to render it. This is what closes the original Phase 9 entirely.
- **Heal-now session re-uses an existing MCP session when available.** Today it spawns a fresh Chromium every time. Optimisation: if `sessionRegistry.get(req.user.id)` returns a live session, reuse it. Held until the heal path has more bake time.
- **Manual "Promote to KB" button on low-confidence proposals.** Today low-confidence stays in healHistory only; the operator can't say "yes that one looked right" and force-promote. Easy follow-up.

### Files touched
- `server/services/mcp.js` (broadcast `mcp.snapshot.preview`)
- `server/routes/knowledgeBase.js` (heal-now endpoint + helpers)
- `server/routes/blocked.js` (kbLocator enrichment on selector_drift items)
- `src/store/runStream.jsx` (mcpSnapshot subscriber)
- `src/pages/Theater.jsx` (DomSnapshotPane component + wiring)
- `src/pages/BlockedItems.jsx` (Heal-now button + healResult panel + projectId/onLocatorHealed props)
- `BUILD_PLAN_V2.md` (status marker)

### Verification
- `node --check` clean on `server/routes/knowledgeBase.js`, `server/routes/blocked.js`, `server/services/mcp.js`.
- `npx vite build` succeeds — 1634 modules, ~9.5 s. Bundle grew by ~11 KB (DomSnapshotPane + heal-now wiring).
- Backend reloaded via nodemon; `GET /api/health` returns `{ok: true, db: up}` on :5000.
- Manual smoke deferred to user — needs a run that creates a `selector_drift` BlockedItem (rename a known data-testid mid-suite). Expected: open BlockedItems → "Heal locator from current DOM" button visible inside the AI panel → click it → toast "Heal succeeded (N% confidence)" → KB selector updates in place. Also: during any run, open Theater → expand "DOM snapshot · what the agent sees" → confirm the accessibility-tree text matches the live browser view.

---

## Phase E1.7 — sprint-aware KB priming (completed 2026-05-25)

### Scope
Direct answer to the manager-facing question: "Does Sprint 2 reuse what Sprint 1 learned?" Before E1.7, the KB was consulted only on failure (healer reads it). After E1.7, the KB is **proactively injected into the agent's system prompt at run start**, so the Conductor picks known locators on first try — Sprint 2 spends time on new surfaces, not on rediscovering the login button.

### Built
- **`loadKnownLocatorsBlock(projectId)`** in [server/routes/agents.js](server/routes/agents.js): queries `KnowledgeBaseLocator` rows with `healthScore >= 30` (skips quarantined entries), orders by `(healthScore desc, occurrences desc)`, takes 50, formats into a markdown bullet list with `{intent, role, accessibleName, last-known-selector, healthScore}` per row. Returns null when the KB is empty so a brand-new project doesn't get a misleading "no known locators" header.
- **Thread-through** in `runConductorWithRetries`: block loaded ONCE at the top of the retry loop (snapshot semantics — KB grows mid-run via first-sighting capture but the prompt stays stable). Threaded into both the normal-loop `runOneCase` call and the supervised final-attempt path. Emits an info log on injection: `🧠 KB primed: injecting N known locator(s) into the agent prompt`.
- **Conductor injection** in [server/services/agents/conductor.js](server/services/agents/conductor.js): `runOneCase` accepts a `knownLocatorsBlock` arg. The block is prepended to `baseSystem` between `testCredentialsBlock` and supervisor guidance — same priority layer as the existing operator-context blocks. Layer order is now: `SYSTEM_PROMPT_LOOP → testCredentials → knownLocators → supervisor → composeSystemPrompt(operator guidance)`.
- **Architect prior-runs preamble** in [server/services/agents/architect.js](server/services/agents/architect.js): new optional `priorContext` param. When the route passes it (i.e. there are ≥ 1 completed runs against this project), the string is prepended to `SYSTEM_PROMPT` before `composeSystemPrompt` wraps in operator guidance. Tells the Architect to bias scenarios toward continuity rather than always exploring.
- **Route-side prior-run count** in [server/routes/agents.js](server/routes/agents.js): one `prisma.run.count({ where: { projectId, status: 'completed' } })` before the Architect call. Cheap; runs once per pipeline.

### Decisions
- **KB snapshot at run start, not refreshed mid-run.** First-sighting capture still grows the KB during the run, but the prompt block reflects the pre-run state. Refreshing mid-run would churn the prompt cache for marginal benefit; the healer continues consulting the live KB on every failure regardless.
- **Cap at 50 locators.** Roughly 6 KB of system-prompt budget for the block. More than that and the signal-to-noise drops — locators with low occurrences / health rank below the cut. A truly large site (100+ surfaces) will surface the most-used 50 first, which is what the agent needs.
- **Quarantine threshold (30) applied in the loader, not the prompt.** The agent never sees a known-bad locator suggested — keeping the quarantine logic centralised in the loader is cleaner than asking the model to filter on `healthScore < 30` itself.
- **Architect preamble is unconditional once `priorRunCount > 0`.** No tunable. Reasoning: prior coverage is a fact, not a preference. The Architect can still generate new exploratory scenarios; it's just biased toward continuity when continuity exists.
- **No new schema.** All the data already exists from E1.1-E1.3; E1.7 is pure prompt engineering on top.
- **No frontend changes in E1.7.** The injection is invisible to the operator (other than the `🧠 KB primed` log line). The user-visible win shows up as faster runs and fewer failed attempts in Sprint 2+ — measurable from `AgentRun.log` turn counts.

### Open items
- **Module-aware filtering** — today the loader returns ALL non-quarantined KB rows. For very large projects, filtering by the test cases' modules (e.g. only inject "checkout" locators when running checkout cases) would tighten the prompt further. Held for E1.5 / future when the KB has enough data to justify it.
- **Per-page-URL filtering** — same idea using `KnowledgeBaseLocator.pageUrl`. Not needed yet.
- **Effectiveness measurement** — there's no automatic comparison of Sprint 1 vs Sprint 2 turn counts. Sprint comparison view (Phase B+) could surface "avg turns per case down N% in this sprint". Tracked separately.

### Files touched
- `server/routes/agents.js` — `loadKnownLocatorsBlock` helper + thread-through to `runConductorWithRetries` + prior-runs count to Architect
- `server/services/agents/conductor.js` — accept `knownLocatorsBlock`, inject into `baseSystem`
- `server/services/agents/architect.js` — accept `priorContext`, prepend to `SYSTEM_PROMPT`
- `BUILD_PLAN_V2.md` — status marker
- `PHASE_LOG.md` — this entry

### Verification
- `node --check` clean on `server/routes/agents.js`, `server/services/agents/conductor.js`, `server/services/agents/architect.js`.
- Backend reloaded via nodemon — `GET /api/health` returns `{ok: true, db: up}` on :5000.
- Manual smoke deferred to user: run the same suite twice in a row. First run logs `🧠 KB primed: injecting N known locator(s)` only after the KB has been seeded by the first run's first-sighting captures. Second run should log it on entry. Inspect the agent prompts (look for `## Known locators on this site` in the Conductor's system prompt) by tailing the server log. Compare `AgentRun.log` turn counts — Sprint 2 cases that touch known surfaces should resolve in fewer turns.

---

## Phase E1.5 — KnowledgeBase page upgrade (completed 2026-05-25)

### Scope
Frontend surface for everything E1.1-E1.4 has been quietly producing on the backend. Closes the original BUILD_PLAN.md Phase 9 (Knowledge Base) entirely. Operator can now: see every learned locator, watch a locator's health over time, search/filter the list, find the worst offenders at a glance, and manually trigger a heal from any row.

### Built
- **Full rewrite of [src/pages/KnowledgeBase.jsx](src/pages/KnowledgeBase.jsx)** — two-column layout: main locator list on the left, "Top flaky locators" + a "How this works" explainer panel on the right.
- **Search bar** — case-insensitive matching against `element`, `selector`, `accessibleName`, `role`, `intent`, `pageUrl`. Clear button. "N of M matches" hint when active.
- **Top-10 flaky locators panel** — sorted by `failureCount desc, healthScore asc`. Clicking an entry auto-expands the matching row and scrolls it into view (`scrollIntoView({behavior:'smooth', block:'center'})`).
- **Per-locator collapsible detail** — `LocatorRow` shows the row summary by default (name + strategy chip + quarantine badge + failure-count badge + health bar). Expanding reveals:
  - **Intent metadata grid**: intent, accessibleName, role, pageUrl (mono), occurrences, lastHealedAt.
  - **Health timeline** — SVG line chart (`HealthLine` component, 480×64 viewBox). Reconstructs healthScore trajectory by walking backwards through `healHistory` and inverting deltas (success = +5, fail = -20). Dashed quarantine line at 30. Trend badge shows "recovering" or "declining" when the trajectory has ≥ 2 points.
  - **Heal-now button** — same UX shape as the BlockedItems CTA. POSTs to the E1.4 `/knowledge-base/:id/heal-now` endpoint. Result panel shows the healer's proposal inline (strategy + confidence + selector + reasoning).
  - **Heal history list** — reverse-chronological, each entry colour-coded by outcome (green=success, amber=low_confidence, red=failed). Shows source (manual vs auto), confidence, new selector, reason, and ISO timestamp.
- **Subtitle counters** in `PageHeader` updated to surface the new health buckets: "N locators · X healthy · Y watching · Z quarantined".
- **Quarantine indicator** — rows with `healthScore < 30` get a `bg-danger-50/30` tint AND a red "Quarantined" pill in the summary.
- **Empty-state copy** updated — the original "auto-populated when you resolve blocked items" message was misleading; first-sighting capture (E1.3) is the real mechanism. Now reads: "Locators are auto-populated when the agent successfully interacts with elements during a run. Start a run from the Live Pipeline to seed the KB."

### Decisions
- **HealthLine reconstruction is approximate, not exact.** healHistory captures heal events but NOT first-sighting captures, so the line is missing the initial-100 baseline ramp. Acceptable trade-off: the trend direction is what operators care about, and the trajectory always ends at the current `healthScore` so the right side is anchored to reality. A future iteration could store every healthScore change in a dedicated time-series table — held until KB grows past a few hundred rows.
- **Quarantine line at 30 hard-coded** to match `server/services/agents/conductor.js QUARANTINE_HEALTH`. If that env var is overridden server-side, the UI line will be wrong — documented in the QUARANTINE_HEALTH constant at the top of the page file.
- **Top-flaky panel filters out failureCount=0 rows.** A locator that's never failed isn't "flaky" in any meaningful sense — putting it in the panel would dilute the signal. Empty panel = "no failures yet — every locator has held up", which is the right message.
- **Row expansion is single-row, not multi.** Expanding row B collapses row A. The detail panel is large (timeline + metadata + history list) and side-by-side comparisons aren't a common KB-page task — Reports is for that.
- **No fancy chart library.** `HealthLine` is hand-rolled SVG (same pattern as Phase 4's Sparkline). Bundle size matters more than a slightly nicer chart, and the existing pattern is already in the codebase.
- **Click-row-to-expand AND from top-flaky panel.** Two affordances to reach the same state — the side panel gets the operator to "what's broken right now" in one click without scrolling the main list.

### Open items
- **`pageUrl`-scoped filtering** — when the KB grows beyond ~50 rows, filtering by "locators on this page" would be useful. Easy follow-up: add a chip row above the search input. Held until the data justifies it.
- **Manual "Promote to KB" on low-confidence heal proposals** — today low-confidence proposals are appended to `healHistory` but the locator's `selector` field isn't updated; the operator has no UI to force-promote. Add a button on the heal-result panel.
- **Time-series healthScore log** — see the HealthLine reconstruction caveat. Worth doing once enough KB data exists to justify the extra storage.
- **Diff between heal-history entries** — click two entries to compare old/new selectors side-by-side. Marginal value at current data volumes.

### Files touched
- `src/pages/KnowledgeBase.jsx` — full rewrite (was a flat table; now a two-column layout with collapsible details + search + top-flaky panel + healthline + heal-now CTA + heal-history list)
- `BUILD_PLAN_V2.md` — E1 status marker updated to E1.1-E1.5+E1.7 complete, E1.6 still pending
- `PHASE_LOG.md` — this entry

### Verification
- `npx vite build` succeeds — 1634 modules, ~31 s. Bundle grew by ~22 KB (KB page is now the largest single page module after Reports).
- Backend untouched; no server-side changes in E1.5.
- Manual smoke deferred to user: open `/knowledge-base` — list renders sorted by healthScore asc (worst at top), search filters live, clicking a row expands the timeline + history, clicking a top-flaky entry scrolls + expands. Heal-now button works (mirrors BlockedItems flow). Empty project shows the new copy.

### What this closes
With E1.5 shipped, the original BUILD_PLAN.md **Phase 9 — Knowledge Base** is fully complete. The remaining items from the original 12-phase plan are:
- Phase 6 partial (Output Files polish — syntax highlight refinement, per-file actions, file-tree count badges) — NOT in V2.
- Phase 12 (audit log page + backup/restore + export-as-Playwright-repo + user roles) — partially folded into V2 (backup/restore obsoleted by E9 Postgres; user roles overlap with E8 multi-tenancy; audit log page + export-as-repo NOT in V2).
- Phase C (Claude ↔ Gemini auto-failover) — natural fit under V2 E10 (circuit breakers + cost guardrails) but not yet slotted.

---

## Phase E1.6 — on-page instruction reader (completed 2026-05-25)

### Scope
Closes the bug Sravan flagged: a real-world login page whose copy said "Click Register first to create an account" was ignored by the agent, which kept retrying the login form with fabricated credentials until the loop guard tripped. The MCP snapshot did contain the instructional text — the agent just didn't read it because D1's extractor only catches `role="alert"` and `role="status"` nodes. E1.6 adds two layers: a cheap snapshot-text scanner that runs every turn, and a vision fallback that fires once when the loop guard would otherwise abort.

### Built
- **Cheap snapshot reader** in [server/services/agents/conductor.js](server/services/agents/conductor.js) `extractPageInstructions`: sibling to D1's `extractPageErrors`. Regex-scans the MCP snapshot YAML for quoted strings containing actionable verbs (`register`, `sign up`, `create account`, `verify email`, `confirm`, `activate`, `complete setup`, `follow these steps`, `enable`, `check inbox`, `your account not yet`, `first create`, `use the … link/button`, etc.). Skip-pattern filter drops cookie banners, privacy-policy mentions, marketing copy, and newsletter prompts. Dedupes case-insensitively, caps at 5 lines per turn.
- **Per-turn injection** in the existing D1 guidanceLines block: a new "Page instructions visible (FOLLOW these — they tell you what the user must do)" section appended alongside D1's "Page error visible" injections. Deduped across turns via a parallel `surfacedInstructions` Set so sticky banners don't re-inject every turn. Emits `📜 Page instructions read: N actionable line(s) injected.` to the Execution Log when fresh lines appear.
- **Vision agent** at [server/services/agents/instructionReader.js](server/services/agents/instructionReader.js): provider-agnostic vision call. Accepts a base64 screenshot + media type + optional `stuckContext` string. Returns `{ instructions: string[], summary, confidence }`. Strict JSON output, cancellation-aware, capped at 5 imperative steps. Confidence guidance encoded in the prompt: 0 = no actionable copy, 30-60 = present but unrelated, 70-99 = clear and relevant.
- **Vision fallback in the loop guard** (the `newCount > MAX_IDENTICAL_TOOL_CALLS` branch in conductor.js): before aborting, take a fresh `browser_take_screenshot` and call the vision reader with `stuckContext: "Repeatedly calling <tool> with the same arguments (N× now)…"`. If vision returns `instructions.length > 0 && confidence >= 30`:
  - reset `toolCallCounts.set(callKey, 0)` once (per `visionFallbackTried` Set — never twice for the same key) so the agent gets one more shot,
  - inject a synthetic user message: `[page-instructions guidance — read these BEFORE retrying <tool>]…`,
  - log `📜 Vision read the page (conf N): "<summary>" — resetting loop counter for <tool> once.`
  Otherwise abort as before, with the abort reason annotated to say `vision-fallback found no actionable instructions`. Vision call errors fall through to the original abort path.

### Decisions
- **Cheap layer runs every turn; vision fires once per (tool, args) pair.** The regex pass is ~free; the vision call is a flagship-model image read and costs real money. Reserving it for the loop-guard moment hits the "useful when the agent is genuinely stuck" sweet spot without burning a vision call on every successful turn.
- **`visionFallbackTried` is a Set, not a counter.** Vision rescue can only happen ONCE for any (tool, args) pair within a case. If the agent re-triggers the same loop after the rescue, the next abort is unconditional — preserves the loop guard's safety contract.
- **Vision rescue resets the loop counter to 0, not just decrements it.** The injection gives the agent fundamentally new information (often the action it SHOULD take is different — register instead of login). Treating it as a clean slate is more honest than "you have 1 attempt left".
- **`stuckContext` is fed verbatim into the vision agent's user message.** Helps the model pick instructions relevant to what the agent has been failing at, instead of summarising the whole page. Capped at 300 chars.
- **Confidence threshold 30 (low).** A page with only mid-confidence instructions is still better than nothing when the alternative is hard-abort. The vision reader's own prompt is strict enough that a 30+ output means "something actionable was found"; we don't need to gate higher.
- **No new schema.** Pure agent-loop work; nothing to migrate.
- **No frontend changes.** The instruction injections surface in the Execution Log via the existing `📜 Page instructions read` and `📜 Vision read the page` log events. Theater's action trail picks them up automatically through the existing log-classification heuristic. A dedicated trail-icon for "instructions read" is a polish item, not blocking.

### Open items
- **Bulk-instruction sticky pages**: if the agent passes a long tutorial page, the regex extractor may inject the same 5 lines turn after turn until the agent navigates away. `surfacedInstructions` dedupes across turns within a case, but if a case re-enters the same page (e.g. after a failed login), the dedup Set is per-case — fine for now, but worth revisiting if it produces noise in practice.
- **Vision retry policy**: vision call errors (rate-limit, transient HTTP) currently fall through to the original abort. Could retry once with backoff. Held until we see real-world flake rates.
- **Per-agent log routing**: instructionReader logs land under `phase: 'instructionReader'` which the Execution Log's existing classifier groups under "Phases". A dedicated chip would tighten the UX. Deferred until the log-filter UI has more capacity.

### Files touched
- `server/services/agents/instructionReader.js` (new — vision agent)
- `server/services/agents/conductor.js` — import, `extractPageInstructions` helper, two new per-case Sets (`surfacedInstructions`, `visionFallbackTried`), wire snapshot extractor into D1 guidanceLines, wire vision fallback into loop-guard branch
- `BUILD_PLAN_V2.md` — E1.6 + E1 phase markers
- `PHASE_LOG.md` — this entry

### Verification
- `node --check` clean on both touched server files.
- Backend reloaded via nodemon; `GET /api/health` returns `{ok: true, db: up}` on :5000.
- Manual smoke deferred to user. Two scenarios to test:
  1. **Cheap layer**: drive the agent against a page whose copy says "Click Register first to create an account". After the first failed login attempt, the Execution Log should show `📜 Page instructions read: 1 actionable line(s) injected.` and the agent should pivot to the register flow on the next turn.
  2. **Vision fallback**: same page, but force a loop (e.g. by removing the snapshot text the cheap layer would catch — image-rendered notice). On the 4th identical tool call, the log should show `📸 Loop-guard would fire — taking a screenshot…` → `📜 Vision read the page (conf N): "…" — resetting loop counter for browser_click once.` The agent gets one more shot.

### What this closes for the larger plan
With E1.6 shipped, **Phase E1 — DOM-aware self-healing locator engine** is fully complete (E1.1 through E1.7). The agent now:
- Reads the DOM via MCP snapshots ✓
- Uses learned locators proactively (E1.7) ✓
- Heals on locator failure (E1.2) ✓
- Captures locator intent on first sighting (E1.3) ✓
- Surfaces the heal substrate in Theater + KnowledgeBase + BlockedItems (E1.4, E1.5) ✓
- Reads on-page instructional copy + vision fallback (E1.6) ✓

Next session: **Phase E2 — Critic in-loop ratification** (assertion_check synthetic tool + in-loop Critic abort).

---

## Phase E2 — Critic in-loop ratification (completed 2026-05-25)

### Scope
The biggest correctness gap in the agent loop: today's D4 takes a post-hoc snapshot AFTER Claude has ended its turn. If the snapshot contradicts the agent's "RESULT: pass" claim, the Critic rewrites the case to fail — but Claude never saw it. A hallucinated success couldn't self-correct mid-run. E2 closes that gap with two complementary mechanisms.

### Built
- **Synthetic `assertion_check` MCP tool** in [server/services/mcp.js](server/services/mcp.js): registered in `listAnthropicTools` alongside the real Playwright-MCP tools; intercepted in `callTool` so it never roundtrips to the subprocess. Server fabricates the response from `session.lastSnapshot` (the cached accessibility tree). Schema: `{ assertion, expectedRole?, expectedText?, expectedUrlPattern? }`; at least one criterion required. Returns `{ matched, reason?, evidence }`. Fast — sub-millisecond regex/substring scan, no Claude call, no browser cost.
- **Conductor SYSTEM_PROMPT_LOOP** updated in [server/services/agents/conductor.js](server/services/agents/conductor.js): explicit instruction that the agent MUST call `assertion_check` for each assertion BEFORE emitting `RESULT: pass`. Tells the model that the server uses these as the source of truth and will override hallucinated passes.
- **Server-side ratification gate** in `runOneCase`: per-case `assertionCheckResults` array captures every `assertion_check` call's parsed payload. After `assistantClaimedDone` and the existing fail-on-last-error check, a new block runs:
  - If `status === 'pass'` AND the case has declared assertions AND `assertionCheckResults.length === 0` → downgrade to `fail` with reason "Agent claimed pass without calling assertion_check on any declared assertion".
  - If `status === 'pass'` AND any `assertionCheckResults` row has `matched=false` → downgrade to `fail` with the first failed check's `evidence` (and a "+N more" suffix when multiple failed).
  Both downgrade paths emit a structured `agent.phase.log` warn so the Execution Log shows "Pass claim overridden".
- **In-loop Critic abort_pass_claim verdict** in [server/services/agents/critic.js](server/services/agents/critic.js): `INLINE_SYSTEM_PROMPT` extended with a new strongest-verdict shape. The Critic emits `{verdict: 'abort_pass_claim', reasoning}` when the snapshot contradicts the agent's pass claim (visible error banner, wrong page, no assertion_check call). In the Conductor's inline-critic block, the new verdict is intercepted BEFORE the existing hint path: a synthetic user message is pushed (`[Critic blocked your pass claim]…`) forcing the agent to re-verify with concrete `assertion_check` criteria, and the rest of the inline-critic logic for this turn is skipped (`continue`). Doesn't count against `MAX_HINTS_PER_CASE` — this is a correctness gate, not generic advice.
- **`stringifyAction` enhancement**: persisted trace lines for `assertion_check` now render as `ASSERTION: ✓ "claim" — evidence` (or `✗ "claim" — reason`). Parsed payload pulled from the trail entry's cached `pageSnippet` (the JSON the synthetic tool returned).
- **Reports trace pane** in [src/pages/Reports.jsx](src/pages/Reports.jsx): the trace parser detects the `ASSERTION:` prefix and produces a richer step object (`isAssertion`, `assertionMatched`, `assertionFailed`). `TraceStep` renders assertion rows with a 4-px coloured left border + brighter background + bold text so they pop out from the regular `▶ browser_*(…)` exploration trail. Green for matched, red for failed.
- **`lastSnapshotText` protected**: `assertion_check` returns JSON, not a snapshot. The post-tool trail-update block now skips updating `lastSnapshotText` for this tool so the D1 page-error / E1.6 page-instruction extractors don't accidentally regex-scan the JSON payload as if it were an accessibility tree.

### Decisions
- **Synthetic tool, not real Playwright assertion code.** Real Playwright `expect()` calls would need codegen + execution against the live page, which adds complexity and slows the loop. The synthetic tool reads the cached snapshot — same source of truth the agent already sees. Trade-off: assertions on visible text / role / URL work great; assertions on values that aren't in the accessibility tree (e.g. `localStorage` state, network response bodies) need separate strategies (network log tools, future E2 follow-up).
- **The agent's own claim is overridden, not consulted.** A hallucinating agent will sometimes emit `RESULT: pass` with confident bullets that don't match reality. The server treats `assertion_check` as the source of truth — if the gate says false, the result is fail, full stop. Removes the failure mode where polished prose passes the human-eye review.
- **No `assertion_check` calls = automatic fail (when assertions are declared).** Strict, by design. The alternative — treating "no calls" as "assume agent verified some other way" — defeats the purpose. If the case has no declared assertions in the first place, this gate doesn't fire (rare; usually means the test case is incomplete).
- **Critic's abort verdict skips the rest of the inline branch.** Once the Critic has blocked the pass claim, additional hint injection on the same turn would be noise. `continue` is the cleanest semantic.
- **Threshold for triggering Critic's abort verdict is the Critic's own judgement** — encoded in the prompt as "use it only when you have HARD evidence in the snapshot that the assertion failed". Soft-judgement cases stay in the existing hint path.

### Open items
- **Network / state assertions** — `expectedRole` / `expectedText` / `expectedUrlPattern` cover visible-page assertions. Things like "API returned 200" or "session token stored" require a different gate. Held until V2 picks up network-aware assertions in E10 (or a dedicated E2.5).
- **`assertion_check` accuracy is bounded by the accessibility tree quality.** A canvas-rendered "Welcome back" banner won't appear as text in the snapshot — the agent's claim would fail the gate even when visually correct. Could add a vision fallback for assertion_check (mirrors E1.6 pattern). Tracked.
- **The Critic's abort verdict is rare** because the inline Critic only runs every 5 turns or on tool error. A hallucinated pass on a clean run might still slip through the inline phase. Mitigation: the server-side ratification gate (above) catches it regardless. The Critic verdict is an early-warning mechanism layered on top.

### Files touched
- `server/services/mcp.js` — synthetic `assertion_check` tool registration + `checkAssertion` helper + `callTool` intercept
- `server/services/agents/conductor.js` — SYSTEM_PROMPT_LOOP rule, per-case `assertionCheckResults` tracking, ratification gate after `assistantClaimedDone`, `stringifyAction` enhancement, `lastSnapshotText` protection
- `server/services/agents/critic.js` — INLINE_SYSTEM_PROMPT updated with `abort_pass_claim` shape, parser handles the new verdict
- `src/pages/Reports.jsx` — trace parser detects `ASSERTION:` rows, `TraceStep` renders them with accent toning
- `BUILD_PLAN_V2.md` — E2 status marker
- `PHASE_LOG.md` — this entry

### Verification
- `node --check` clean on `server/services/mcp.js`, `server/services/agents/conductor.js`, `server/services/agents/critic.js`.
- `npx vite build` succeeds — 1634 modules, ~9.8 s.
- Backend reloaded via nodemon; `GET /api/health` returns `{ok: true, db: up}` on :5000.
- Manual smoke deferred to user. Three scenarios to test:
  1. **Clean pass** — run a passing test case where the agent calls `assertion_check` with concrete criteria. The Reports trace pane should show green-highlighted `ASSERTION: ✓ "<claim>" — <evidence>` rows alongside the browser_ tool calls.
  2. **Hallucinated pass override** — manually disconnect a backend so a login looks visually fine but the redirect doesn't happen. Agent might emit `RESULT: pass` with a ✓; the server should downgrade to `fail` and the Execution Log should show "Pass claim overridden — N assertion_check call(s) returned matched=false".
  3. **Missing-check override** — manipulate the agent prompt to skip `assertion_check`. The case must downgrade to fail with reason "Agent claimed pass without calling assertion_check".

### What this enables for the larger plan
With E2 shipped, the agent loop is now **honest end-to-end**: locators heal themselves (E1), known locators get reused proactively (E1.7), instructional copy is read (E1.6), and pass claims must be ratified against the live page (E2). Next steps per V2 sequencing: **E3 — code-diff awareness** (PR-driven test generation) and **E4 — visual diff with semantic reasoning**, both of which can run in parallel sessions.

## Phase E3 — Code-diff awareness (completed 2026-05-25)

### Scope
The Architect used to regenerate scenarios from BRDs each sprint without any knowledge of what the developers had actually changed. E3 wires QAAI to the source repo: connect a GitHub repo + PAT under Project Setup, paste a PR URL or branch into RunSuite, and the new Diff Analyzer agent reads the file list, abstracts it to a product-feature summary, and feeds an impacted-modules block into the Architect's `priorContext` on the next Generate.

Read-only by design — no `createBranch`/`commitFile`/`openPullRequest` yet (those land in E7 when QAAI starts pushing real PRs).

### Built
1. **Schema + migration `20260527100000_diff_context`**
   - `Project` gains `repoUrl`, `defaultBranch`, `gitProvider` (all nullable).
   - New `DiffContext` model: `{ projectId, sprintId?, ref, baseRef, changedFiles (JSON), changedModules (JSON), summary, fetchedAt }`.
   - Indices on `(projectId, sprintId)` and `(projectId, fetchedAt)` for the recent-first list query.

2. **GitHub provider client** — `server/services/git/github.js`
   - Single `fetchDiff({ token, repoUrl, prNumber?, branch?, baseBranch? })` entry point.
   - `parseRepoUrl` handles both `https://github.com/o/r[.git]` and `git@github.com:o/r.git`. `parsePrNumber` accepts a PR URL, `#42`, or `42`.
   - PR path paginates `/repos/{o}/{r}/pulls/{n}/files` (caps at 3 pages = 300 files). Branch path hits `/repos/{o}/{r}/compare/{base}...{head}`.
   - Status-coded errors: `GIT_AUTH` (401), `GIT_NOT_FOUND` (404), `GIT_RATE_LIMIT` (403 + rate-limit body), `GIT_API` (other).
   - No third-party dep — Node's built-in `fetch`.

3. **Diff Analyzer agent** — `server/services/agents/codeDiffAnalyzer.js`
   - Same shape as `blockageAnalyzer.js`: `SYSTEM_PROMPT` + `run({ apiKey, model, provider, ... })` + `parseJsonResponse` + `composeSystemPrompt(extraGuidance)`.
   - Output: `{ summary, impactedModules: [moduleName from existingModules only], suggestedScenarios: [{ name, module, why }] (cap 6) }`.
   - Caps the file list at the 150 most-churning entries before sending — beyond that, the diff stops being diagnostically useful and starts being prompt-cost noise.
   - Normaliser drops impactedModules that aren't in the project's existing module set; suggestedScenarios stay free-form because their job is to expand coverage.

4. **Routes** — extended `server/routes/projects.js`
   - `PUT/GET /api/projects/:id/repo` — repo metadata + vault PAT (`<provider>.pat`). Server only returns the PAT's last-4 + updatedAt.
   - `POST /api/projects/:id/diff-context` — fetches via github.js, validates `sprintId` belongs to project, runs the analyzer, persists a DiffContext row, broadcasts `agent.phase.start|log|complete` for phase=`diff-analyzer`. Rate-limited 8/min.
   - `GET /api/projects/:id/diff-context?sprintId=` — recent-first, capped at 20.
   - `DELETE /api/projects/:projectId/diff-context/:id` — clear.

5. **Architect `priorContext` extension** — `server/routes/agents.js`
   - Already had the "this project has N prior runs" block from E1.7. Now appends a `## Recent code changes (ref vs baseRef)` block when a DiffContext exists. Sprint-scoped when the run is tagged to a sprint; otherwise the most-recent project-wide diff.
   - The two blocks compose — the Architect sees both "you've tested this site before" and "here's what changed since."

6. **ProjectSetup → GitRepoEditor** — collapsible section, sits between TestUsers and Sprints. Repo URL + default branch + provider Select + SecretInput PAT. Connected pill when a repo is configured. Empty PAT field after save = preserve stored value; explicit empty string + Save = clear from vault.

7. **RunSuite → DiffContextCard** — sits between the cost-preview card and the source-ingestion strip.
   - Loads the most-recent DiffContext on mount (sprint-scoped when a sprint is active).
   - Free-form input parses PR URLs, `#N`, plain numbers, or a branch name. Base branch defaults to the project's `defaultBranch` (placeholder shown).
   - Displays summary + impacted-module pills + suggested-scenario list inline. Clear button drops the row.
   - "Connect a repo first" callout when `project.repoUrl` is empty.

### Decisions (why this, not that)
- **DiffContext is its own row, not a column on Run** — multiple Runs in a sprint should reuse the same fetched diff without re-paying the LLM cost. Run-level coupling would have forced one analysis per execution.
- **Read-only GitHub for E3** — push semantics (PR opening, commit creation) need their own auth-scope conversation with the operator. Splitting read vs write keeps "show me the diff" un-gated by a write-permission PAT.
- **Existing-modules constraint on impactedModules** — letting the LLM invent module names contaminates the Architect's downstream module set. Suggested-scenario names stay free-form because their job is to expand coverage, not to claim authority over the module taxonomy.
- **Free-form ref input in RunSuite** — operators don't want to pick "PR" vs "branch" from a radio; they want to paste whatever they have. The parser handles both and the form labels the second input "Base (for branch compare)" so the choice is self-documenting.
- **PAT stored under `<provider>.pat`, not `<project>.<provider>.pat`** — multi-project users have one PAT for their org. The shared-vault entry matches how `ado.pat` / `jira.pat` already work.

### Open items
- No webhook auto-trigger yet — operator pastes the PR URL manually. A `pull_request` webhook subscription would let "PR opened → diff analyzed → notification fired" run unattended; deferred until E5 (Notifications) lands.
- Files-changed pagination caps at 300 (3 × 100). A truly mega-PR will be analyzed on the top-300 most-churning files, which is probably the right behaviour but isn't surfaced in the UI.
- Suggested scenarios surface in the card but the operator still has to manually feed them to Generate; a "Append to next Generate" action would close that loop.
- Only GitHub for now. GitLab / Bitbucket / Azure Repos providers are a `services/git/<name>.js` away — the route already takes `gitProvider` and dispatches.

### Files touched
- `prisma/schema.prisma`
- `prisma/migrations/20260527100000_diff_context/migration.sql`
- `server/services/git/github.js` (new)
- `server/services/agents/codeDiffAnalyzer.js` (new)
- `server/routes/projects.js`
- `server/routes/agents.js`
- `src/pages/ProjectSetup.jsx`
- `src/pages/RunSuite.jsx`
- `BUILD_PLAN_V2.md`

### Verification
- `node --check` clean on `server/services/git/github.js`, `server/services/agents/codeDiffAnalyzer.js`, `server/routes/projects.js`, `server/routes/agents.js`.
- `npx prisma migrate dev` applies `20260527100000_diff_context` and regenerates the Prisma client (~360 ms).
- `npx vite build` succeeds — 1634 modules, 9.2 s.
- Backend restarted on :5000; `/api/health` returns `{ ok: true, db: 'up' }`.

## Phase E4 — Vision-based screenshot diff (completed 2026-05-25)

### Scope
Pixel-diff is noise — timestamps tick, scrollbars shimmer, ads rotate. E4 replaces that with semantic comparison: the AI looks at the baseline vs current screenshot of the same case and says, in QA-reviewer voice, "Primary CTA changed colour from green to amber" or "No visual regression detected." First pass writes the baseline; subsequent runs compare against it. Reports surfaces the verdict + side-by-side images in a quiet, collapsible section that stays out of the way until there is something worth saying.

### Built
1. **Schema + migration `20260527140000_visual_critic`**
   - `RunResult` gains `baselineScreenshot` (URL), `visualVerdict` (`'pass' | 'fail' | 'inconclusive'`), `visualDiffSummary`, `visualDiffs` (JSON array of `{region, before, after, severity}`). All nullable — historical results without visual data still render correctly.

2. **`server/services/agents/visualCritic.js`** (new)
   - Single `compare({ baselineBase64, currentBase64, expectedAssertion, ... })` entry.
   - System prompt teaches the verdict triad and the specific things that count as a regression (CTA copy/colour change, layout break, missing element, error-state banner introduced).
   - Cap diffs at 6, each clamped to ≤140 chars per before/after, severity ∈ low|medium|high.
   - Honest empty-array on identical screenshots (system prompt explicitly forbids fabricated diffs).
   - Provider-agnostic via the canonical Anthropic image block; gemini provider translates to `inlineData`.

3. **Conductor wiring** — [server/services/agents/conductor.js](server/services/agents/conductor.js)
   - New `analyseVisualRegression({ tc, status, screenshots, provider, apiKey, model, send })` helper sits between the case's final screenshot and `persistResultAndCodegen`.
   - Decision tree:
     - No current screenshot → no-op.
     - No prior baseline + status==='pass' → record this run's final screenshot URL as the baseline. No vision call.
     - No prior baseline + status==='fail' → no-op (we never baseline a failing run; that would freeze a broken look as canonical).
     - Prior baseline + no provider creds → carry the baseline forward unchanged.
     - Prior baseline + creds → load both images from disk, call `visualCritic.compare`, persist verdict + diffs.
   - Strict opt-out: any error (file read, vision call, JSON parse) is logged via WS phase log and swallowed — visual checks must never block a result row from being written.
   - WS phase markers: `agent.phase.start|log|complete` for phase `visual-critic`, tagged with `tcId` so the global indicator can show "Visual Critic" inline.
   - `persistResultAndCodegen` now takes a `visual` object and persists the four new fields alongside the usual screenshots/trace/error.
   - Static-route → disk mapping helpers (`artifactUrlToDiskPath` / `readArtifactAsBase64`) added at top of file so the agent can re-read its own saved screenshots without going through the HTTP layer.

4. **Runs service decoder** — [server/services/runs.js](server/services/runs.js)
   - `getRunDetail` decodes `visualDiffs` from JSON string to array before returning to clients.

5. **Reports `VisualDiffSection`** — [src/pages/Reports.jsx](src/pages/Reports.jsx)
   - Renders ONLY when the result has either a baseline OR a verdict — no empty card. Pass-with-no-diffs collapses by default; fail/inconclusive auto-expands.
   - Header: status pill (success/danger/warn tokens, not raw colours) + collapse caret.
   - Body (when open): narration block in verdict-toned background, then a clean diff list with severity dot + region label + baseline/current side-by-side text, then the baseline/current image pair as a 2-up.
   - First-pass empty state: "Baseline captured · awaiting next run for comparison" pill in the header + an italic hint line. No alarming colour.
   - Sits between Trace and Video sections — visually belongs with the artifact group, not the diagnostic group.

### Decisions (why this, not that)
- **First-pass-only baselining** — taking baseline on a failed run would freeze a broken look in. The agent waits for a confirmed pass before declaring a canonical visual state. If the first ever run fails, no baseline is written until a later pass.
- **Vision call runs on EVERY case that has a baseline (pass or fail), not just visual-class failures** — the V2 spec suggested guarding fail cases on "looks visual." That guard is fragile (defining "looks visual" from MCP error strings is brittle) and a failed-but-still-have-a-baseline case may show its real cause in the screenshot. The cost ceiling is one Sonnet vision call per case that has been verified before; tolerable for v1.
- **Vision verdict ≠ test verdict** — the underlying assertion remains source of truth. Visual verdict is advisory metadata; the result.status is unchanged. A "fail" visual on a passing test surfaces as a regression in Reports without changing run counters. Avoids "the screenshot AI overrode my assertion" complaints.
- **Reports section is collapsed-by-default on pass** — the user said "nothing should be forced". Passing the visual is the boring case; the section folds itself away. Fail/inconclusive auto-expands because that is the case the user came to look at.
- **No standalone Visual diff page** — the section sits inline in the result detail; the data is per-result, the user reads it in result context.
- **`/artifacts/` URL → disk-path mapping done in conductor.js, not behind an HTTP fetch** — same process, same filesystem. Round-tripping through HTTP would add auth/headers complexity for no gain.

### Open items
- Baseline is captured once and never re-rolled. A genuine UI redesign needs a "Set this run's screenshot as the new baseline" action — deferred until a user actually needs it (the data model supports it; just no UI yet).
- No baseline-management surface — the dropped baselineScreenshot URL points at `/artifacts/live/...`, which is in the project-delete cleanup path but is otherwise persistent. A future "expire baselines older than N days" job is a different conversation.
- No per-project disable. Operators who don't want the visual call (cost-conscious, no PAT, etc.) have to either not configure an AI provider or accept the no-op baseline-only behaviour. A `Project.visualCriticEnabled` boolean is a small follow-up.
- VisualCritic doesn't get the diff context yet — it sees the screenshots in isolation. Adding the `DiffContext.summary` to the user message would let it explain "this is expected because login.jsx was refactored" instead of flagging a layout change as a regression.

### Files touched
- `prisma/schema.prisma`
- `prisma/migrations/20260527140000_visual_critic/migration.sql`
- `server/services/agents/visualCritic.js` (new)
- `server/services/agents/conductor.js`
- `server/services/runs.js`
- `src/pages/Reports.jsx`
- `BUILD_PLAN_V2.md`

### Verification
- `node --check` clean on `server/services/agents/visualCritic.js`, `server/services/agents/conductor.js`, `server/services/runs.js`.
- `npx prisma migrate dev` applies `20260527140000_visual_critic` and regenerates the Prisma client (~520 ms).
- `npx vite build` succeeds — 1634 modules, ~35 s (one more module than E3 = VisualDiffSection in Reports).
- Backend back up on :5000; `/api/health` returns `{ ok: true, db: 'up' }`.

## Phase E5 — Cost routing (completed 2026-05-25)

### Scope
QAAI is BYOK — the user pays per their own Anthropic / Google API key. Every agent used to call the project's chosen flagship model (Sonnet 4.6 / Gemini 2.5 Pro), even for tasks that don't need flagship intelligence. E5 introduces a tier system: agents that just do classification, prose generation, or pattern recognition over already-structured input route to Haiku 4.5 / Gemini 2.5 Flash. Architect, Planner, Conductor, Critic, Supervisor, and VisualCritic stay on flagship. No UI surface, no operator action required — the savings happen on the next run.

### Built
1. **`server/lib/modelRouter.js`** (new) — single source of truth.
   - `TIERS = ['flagship', 'mid']`.
   - `MID_TIER_MODELS = { claude: 'claude-haiku-4-5-20251001', gemini: 'gemini-2.5-flash' }`.
   - `FLAGSHIP_FALLBACKS = { claude: 'claude-sonnet-4-6', gemini: 'gemini-2.5-pro' }` (only used if a caller forgot to pass a `requestedModel`).
   - `resolveModelForTier({ provider, requestedModel, tier })` — returns the mid-tier model directly when tier='mid' (ignoring user's flagship choice), or `requestedModel` when tier='flagship'.

2. **Each agent declares its own tier as a constant** — keeps the policy visible in the agent file:
   - `analyst.js`           → `mid` (document comparison, impact selection)
   - `reporter.js`          → `mid` (RCA prose: what/why/fix/classification)
   - `rcaChat.js`           → `mid` (follow-up Q&A over already-analysed failure)
   - `blockageAnalyzer.js`  → `mid` (structured classification of blockers)
   - `codeDiffAnalyzer.js`  → `mid` (mapping changed files to existing modules)
   - `healer.js`            → `mid` (locator proposal from fresh DOM snapshot)
   - `instructionReader.js` → `mid` (small vision task: extract instructional copy)

3. **Pattern at each call site** — `const routedModel = resolveModelForTier({ provider, requestedModel: model, tier: TIER })` computed inside `run()`, then `model: routedModel` passed to `provider.complete`. The route layer keeps passing the user's chosen model through unchanged — the agent decides.

### Policy decisions
- **Mid-tier IGNORES the user's flagship Settings choice** (operator picked from a two-option AskUserQuestion in this session). If a user chose Opus 4.7 for flagship, Reporter still runs on Haiku 4.5. The user's Settings choice only governs flagship-tier agents (Architect/Planner/Conductor/Critic/Supervisor/VisualCritic). Reason: maximum cost savings for BYOK users; the mid-tier task floor doesn't get more accurate on a bigger model.
- **VisualCritic stays flagship** even though it's a vision task. Semantic diffing across two images is qualitatively harder than reading instructions off one — anecdotal evidence in testing showed Haiku missing layout-shift regressions that Sonnet caught.
- **InstructionReader is mid despite being vision** — extracting imperative copy off a single screenshot is well within Haiku's capability. The call fires on every loop-guard fallback so high-volume cost matters.
- **No per-project override surface in v1.** If an operator wants Opus on Critic, they pick it in Settings — that covers all flagship agents. A mid-tier override slot would need its own UI (cost comparison, per-agent picker, model availability check) and is deferred until someone asks for it.
- **No cost-visibility panel in v1.** Operator picked "routing first" — savings happen on the next run; users will see them on their own API dashboards. Per-run cost reporting is a follow-up phase.

### Open items
- No `Project.modelOverrides` column or UI yet. When an operator needs Opus on Reporter, this is the missing piece. Schema would be a single nullable `String?` JSON-encoded `{agentName: model}`; UI under Settings → AI Provider.
- No `RunResult.modelUsed` column — verifying "this run actually ran Reporter on Haiku" requires checking the rate-limit chip totals against expected cost. A per-result model marker would make verification trivial; deferred.
- The `requestedModel` ignored-on-mid policy could surprise an operator who explicitly picked Haiku for flagship (the resolver would just return Haiku for mid too — no harm — but the dynamic is invisible). The first cost-visibility panel will make this transparent.
- Healer is a high-volume call. If real-world testing shows Haiku missing too many heals (healthScore drops on locators it proposes), demote it back to flagship. That's a single TIER constant change in `healer.js`.

### Files touched
- `server/lib/modelRouter.js` (new)
- `server/services/agents/analyst.js`
- `server/services/agents/reporter.js`
- `server/services/agents/rcaChat.js`
- `server/services/agents/blockageAnalyzer.js`
- `server/services/agents/codeDiffAnalyzer.js`
- `server/services/agents/healer.js`
- `server/services/agents/instructionReader.js`
- `BUILD_PLAN_V2.md`

### Verification
- `node --check` clean on all 7 agent files + the new modelRouter.
- Backend restarted on :5000; `/api/health` returns `{ ok: true, db: 'up' }`.
- No frontend changes — vite build untouched.
- Existing /api responses unchanged; agents accept the same `model` parameter from routes and ignore it for mid-tier internally. Backwards compatible.

## Phase E6 — AST-based lint engine (completed 2026-05-25, Option C)

### Scope
Existing `lintGates.js` did 11 regex rules — credentials, banned APIs, locator hygiene, hardcoded URLs. Regex is fine for string pattern matching but blind to scope. E6 adds a second engine, `server/lib/specAst.js`, that uses `@babel/parser` + `@babel/traverse` (both already in node_modules as Vite transitive deps — zero new packages) to run five scope-aware checks the regex engine can't do. Findings from both engines merge into a single array; if the AST parser chokes on malformed code, regex still contributes its findings (graceful fallback).

User picked **Option C** of three offered approaches (recap): "just add the 5 new rules" — keep all 11 regex rules unchanged, add AST as a separate file contributing genuinely new checks. Smallest blast radius, cleanest review.

### Built
1. **`server/lib/specAst.js`** (new)
   - Uses `@babel/parser` with plugins: typescript, jsx, objectRestSpread, optionalChaining, nullishCoalescingOperator, topLevelAwait. `errorRecovery: true` so partial/in-progress generated code doesn't blow up the lint pipeline.
   - Single public function: `lintAst(code) → { findings: [...], parseError: string|null }`. Parse failures return `findings: []` + the error message; the caller swallows the error and the regex engine still runs.
   - SHA-1 content-hash cache, Map-backed, cap 50 entries with insertion-order eviction. Re-linting the same spec costs ~0.1 ms.

2. **Five scope-aware rules** (all tagged `engine: 'ast'` on each finding):
   - `ast-missing-await-on-locator` (error) — page-interaction calls (click/fill/press/type/check/uncheck/selectOption/goto/hover/dragTo/dispatchEvent/screenshot/etc.) used as bare expression statements with no `await`, `return`, `.then()`, `.catch()`, `Promise.all([])`, or assignment. Walks up the parent chain via `isPromiseHandled` until a known handler or a statement boundary.
   - `ast-assertion-without-expect-per-test` (error) — for each `test(name, fn)` block, verifies the function body contains at least one `expect(...)` call. Implemented via stack-based context: enter-hook pushes a `{title, hasExpect: false}` frame on `test(...)`, every `expect(...)` encountered credits the innermost frame, exit-hook pops and decides. Already-existing regex check is global ("file has at least one expect"); this one is per-block, which is what a QA lead actually wants.
   - `ast-screenshot-on-failure-missing` (warning) — `test.afterEach(...)` blocks whose body has no conditional screenshot capture (`if (testInfo.status !== 'passed') await page.screenshot(...)`). Detection uses an `IfStatement` visitor that triggers when the surrounding stack has an afterEach: walks the `test` looking for `testInfo.status` reference, walks the `consequent` looking for a `.screenshot()` call; both must be present to count.
   - `ast-brittle-locator-css-with-dynamic-class` (warning) — fires on `.locator('selector')` where the selector contains a class with a tail matching the `isGeneratedSuffix` heuristic. Catches pure-hex tails of ≥ 4 chars (`btn-3a4f9b`), 3+ consecutive digits, AND mixed letters+digits in ≥ 5-char tails (`css-1q2w3e4`, `Header-xY8nZ`). Avoids false positives on `btn-primary`, `header-title`, etc.
   - `ast-unused-page-locator` (warning) — bare expression statements whose call is a locator-creator (`locator`/`getByRole`/`getByText`/`getByTestId`/`getByLabel`/`getByPlaceholder`/`getByAltText`/`getByTitle`/`frameLocator`) with no assignment, no chained action, no chained assertion. The classic "I created a locator but did nothing with it" LLM mistake.

3. **`server/services/lintGates.js`** — extended.
   - Imports `specAst`, calls `lintAst(code)` after the regex pass.
   - Merges findings into the same array. Returns `{ lintPassed, findings, errorCount, warningCount, astParseError }` — `lintPassed` now considers errors from BOTH engines.
   - No callsite changes — all three callers (`conductor.js:1663`, `governance.js:128`, `runs.js:242`) pick up AST findings automatically through the existing `lint()` entry point.

4. **`server/scripts/smoke-ast-lint.js`** (new) — small node script that feeds a deliberately-bad and a canonical-good Playwright spec through `lint()` and asserts the V2 acceptance criteria.

### Verification (smoke-test output)
- **BAD spec**: 6 AST findings + 1 regex finding (V2 required ≥ 4 AST). All 5 rules triggered: missing-await on `click(...)`, no expect in second test, two dynamic-class hits (`.btn-3a4f9b` and `.css-1q2w3e4`), unused `getByRole` locator, afterEach without failure screenshot.
- **GOOD spec**: 0 AST findings, 0 regex findings (V2 required 0).
- **Latency**: 47 ms for BAD (six findings), 12 ms for GOOD (no findings). V2 required < 500 ms; well under.
- `lintPassed === true` on GOOD, `false` on BAD (driven by two error-severity AST findings).
- Cache: re-linting the same spec returns the cached array without re-parsing (verified manually in the script's second run during debugging).

### Decisions (why this, not that)
- **Option C, not B (full rewrite)** — the existing 11 regex rules work. Rewriting credential detection as an AST visitor doesn't catch new credentials; it just risks regressions. AST is the surgical strike for rules that need scope; the regex stays as the broad safety net.
- **Stack-based context tracking instead of `traverse(node, ...)` recursion** — the first pass used bare `traverse(fnNode, {...})` and silently failed with a "scope and parentPath required" error swallowed by the catch. Refactored to push/pop frames during the main traversal — no nested traverse calls, no scope issues, single AST walk per spec.
- **Cache lives in-process, no disk persistence** — these specs are tiny and the cache is a hot-loop optimisation. Persisting it would add a cache-busting story (when does invalidation happen?) for no real gain.
- **No new dependencies** — `@babel/parser` and `@babel/traverse` are already in node_modules via Vite. Confirmed before writing the code. Adding them via package.json would be defensive but costs a re-lock and dependency review for zero behaviour change.
- **AST parse errors are swallowed at the caller, not surfaced as a lint finding** — malformed code already trips the regex rules (no test() block, no @playwright/test import, etc.). Surfacing "parser couldn't read your spec" alongside those would be noise.

### Open items
- The unused-locator rule only flags BARE expression statements. A locator stored in a variable that's never used afterwards is fine for now (would need scope tracking — defer to a future refinement).
- The dynamic-class heuristic could miss BEM-style generated names (`.Header__title_93fa9c` — actually caught because the tail is hex-of-4+) but also `.x-abc-1` — borderline, too short to be confident. The heuristic prefers under-flagging over false positives.
- No per-rule disable mechanism. A team that wants to opt out of `ast-screenshot-on-failure-missing` has to filter findings client-side. A future `// qaai-lint-disable: rule-id` inline comment is the standard escape hatch.
- The smoke script lives under `server/scripts/` — no Vitest integration. The existing test suite doesn't have lint-engine fixtures; adding them would belong with a broader testing pass.

### Files touched
- `server/lib/specAst.js` (new)
- `server/services/lintGates.js`
- `server/scripts/smoke-ast-lint.js` (new)
- `BUILD_PLAN_V2.md`

## Phase E7 — Real Git provider PR push (completed 2026-05-25, both-coexist UX)

### Scope
QAAI's "Merge" button has always been internal bookkeeping — it flips `GovernancePR.status` from `approved` to `merged` and the spec becomes the new diff baseline. It does NOT touch GitHub. E7 adds a fundamentally different action: **Push to Git** — create a real branch, commit the spec, open a real GitHub PR. Operator picked "Both coexist" UX (clarified via Q&A this session): the two actions sit side by side; teams choose which / both / neither.

Read-only `github.js` from E3 gains three write methods. New `POST /:id/push-to-git` route on Governance assembles the branch + commit + PR + audit. New `PushToGitModal` in Governance.jsx loads a preview, lets the operator edit branch name / commit message / PR title / spec path, confirms, posts. On success: a "GitHub PR #N" chip appears on the PR card linking out.

### Built
1. **Schema + migration `20260527160000_governance_provider`**
   - `GovernancePR` gains: `providerPrNumber`, `providerPrUrl`, `providerStatus` (`open|merged|closed|error`), `providerBranch`, `pushedAt`, `pushedBy`. All nullable.

2. **`server/services/git/github.js`** — extended.
   - `createBranch({ token, repoUrl, branchName, baseBranch })` — GET `/git/refs/heads/{base}` → POST `/git/refs` with `refs/heads/<name>`. Treats GitHub's 422 "Reference already exists" as non-fatal (returns `alreadyExisted: true` + the existing branch's head SHA) so a re-push after a flaky network mid-flow doesn't have to manually clean up.
   - `commitFile({ token, repoUrl, branch, path, content, message })` — base64-encodes content; GETs existing file SHA when one is present on the branch (GitHub requires it for PUT-as-update); PUTs `/contents/{path}` with the right body. 404 on the existence check is expected and swallowed.
   - `openPullRequest({ token, repoUrl, head, base, title, body })` — POST `/pulls`. Returns `{ number, url, state }`.
   - `pushSpec({ ... })` — convenience wrapper that drives create → commit → openPR in sequence. Single error surface for the route.
   - `ghFetch` extended to support method/body/allowedStatus arguments and emit new tagged error codes: `GIT_FORBIDDEN` (403 non-rate-limit), `GIT_CONFLICT` (409), `GIT_UNPROCESSABLE` (422). The original `GIT_AUTH/GIT_NOT_FOUND/GIT_RATE_LIMIT/GIT_API` codes from E3 still work unchanged.

3. **Routes** — extended [server/routes/governance.js](server/routes/governance.js).
   - `POST /:id/push-to-git` — rate-limited 6/min. Pre-flight: PR status === 'approved', lintPassed, not already pushed (`providerPrUrl` null), project has `repoUrl`, provider is GitHub (gitlab/ado deferred), PAT exists in vault under `<provider>.pat`. Composes branch name `qaai/<slug>-<slug>`, commit message `QAAI <num>: <req>`, PR title `[QAAI <num>] <req>`, spec path `tests/qaai/<filename>`. PR body assembled server-side: requirement, lint findings as markdown checklist, full spec code in fenced block. Operator can override any string via request body. On `github.pushSpec` failure: sets `providerStatus='error'`, returns the underlying error code/message so the toast is actionable. On success: updates the six provider columns, audits as `governance.push-to-git`.
   - `GET /:id/push-preview` — no-side-effects preview endpoint for the modal. Returns repo + base + computed branch/commit/title/path + `blockers[]` listing why the push would refuse. The modal reads this on open so the operator sees the exact payload before confirming.

4. **`src/pages/Governance.jsx`** — UI.
   - **GitHub PR chip** — new accent-toned pill under the PR header. Renders `GitHub PR #N` when `pr.providerPrUrl` exists; renders a danger-toned "Last push failed — retry below" chip when `providerStatus='error'` and `providerPrUrl` is still null. Both only render when their condition is true — no empty chip.
   - **Action footer** — when `pr.status === 'approved'`: now shows three buttons. `Push to Git` (secondary variant, GitPullRequest icon) sits LEFT of `Merge in QAAI` (renamed from `Merge`). Push to Git is disabled when (a) lint hasn't passed or (b) already pushed; the title attribute explains why. Merge label clarified to "Merge in QAAI" so it's obvious the two actions are different.
   - **PushToGitModal** — new component, modal-only (not mounted until opened). Fixed overlay, backdrop-blur, click-outside-to-close, Esc-to-close. Loads `/push-preview` on mount; populates four editable fields (branch / commit / PR title / spec path); shows repo + base + provider as read-only chips at top; "PR description preview" expander shows a peek of the body that the server will assemble. Cancel + "Open PR on GitHub" buttons in footer. Cancel is disabled while pushing; Open PR is disabled until preview loaded, no blockers, and all fields non-empty.
   - **Merge dialog copy** — updated to make the QAAI-internal nature explicit: "Merge finalises the PR inside QAAI. The spec becomes the new diff baseline for future regenerations of this case. (Does NOT push to GitHub — use Push to Git for that.)"
   - **`reviewAction('refresh-after-push')` sentinel** — bypasses the confirm dialog and reloads list + active PR. Modal calls this after a successful push so the chip appears immediately.

### Decisions (why this, not that)
- **Both buttons coexist instead of "Merge becomes Push to Git"** (V2 plan suggested the replacement). User Q&A confirmed: the two actions are genuinely independent — Merge is QAAI-internal baseline checkpoint, Push to Git creates a real PR for human review elsewhere. Hiding Merge when a repo is configured would couple QAAI's internal state machine to GitHub's, which needs polling / webhooks (deferred).
- **Server-side PR body assembly** — the modal preview only shows a peek of the body. Full body is composed in the route from `pr` + `project` + `lintFindings`. Keeps the canonical PR description deterministic; the client can't accidentally send a stripped-down version.
- **Branch-already-exists is NON-fatal** — re-pushing after a network hiccup mid-create-branch shouldn't require manual GitHub cleanup. GitHub's 422 "Reference already exists" is mapped to `alreadyExisted: true` and the pipeline continues. The commitFile call then targets the existing branch tip.
- **Spec path defaults to `tests/qaai/`** — keeps generated tests in a clearly-marked subdirectory so the team's own suite doesn't collide. Operator can override; we just don't default to `tests/` directly.
- **No gitlab/ado in v1** — V2 listed all three providers, but E3 only built GitHub. Route refuses with `PROVIDER_UNSUPPORTED` for anything else; UI shows the same provider field. Adding the other two is a copy-and-adapt of github.js — easy follow-up when there's actual demand.
- **PAT scope checked at push time, not at config time** — we can't probe scopes from a token alone (would need an extra API call). Instead, when push fails with `GIT_FORBIDDEN`, the error message + toast tells the operator the PAT needs `repo` scope.

### Open items
- No webhook listener for PR-merged state. Once pushed, `providerStatus` stays `'open'` until someone manually retriggers a sync. A future `POST /api/webhooks/github/pull_request` would let GitHub notify us; deferred to E5+ phase or whenever a customer asks.
- Branch name collisions across PRs aren't disambiguated beyond the slug + requirement. Two PRs for the same requirement would collide; the `alreadyExisted: true` path handles it (commit + open PR on the same branch) but the resulting GitHub PR could mix specs. Acceptable for v1; a uniqueness suffix is a small follow-up.
- No "delete the QAAI-side push" action. Once `providerPrUrl` is set, the only way to retry is to close the GitHub PR + delete the branch externally (or extend the schema with a `resetPush` action). Deferred — the common case is "PR opened and reviewed normally."
- GitLab + Azure Repos providers stubbed via the `gitProvider` field but not implemented. Route refuses cleanly with `PROVIDER_UNSUPPORTED`.
- Lint findings list cap in PR body is 20 (matches dashboard cap). A PR with 50 findings gets truncated; the operator still sees the count.

### Files touched
- `prisma/schema.prisma`
- `prisma/migrations/20260527160000_governance_provider/migration.sql`
- `server/services/git/github.js`
- `server/routes/governance.js`
- `src/pages/Governance.jsx`
- `BUILD_PLAN_V2.md`

### Verification
- `node --check` clean on `server/services/git/github.js` and `server/routes/governance.js`.
- `npx prisma migrate dev` applied `20260527160000_governance_provider`, regenerated Prisma client (~234 ms).
- `npx vite build` — 1634 modules, 5.15 s. New chunk size includes the modal.
- Backend back up on :5000; `/api/health` returns `{ ok: true, db: 'up' }`.
- End-to-end smoke not run (would require a real GitHub repo + PAT under a test account). Manual verification path documented for whoever wires the first real repo: create a project, set repoUrl + PAT, approve a passing PR, click Push to Git, verify the modal preview, click confirm, see the chip appear with a working external link.

## Phase E8 (Part 1 — substrate) — Multi-tenancy backend (completed 2026-05-25)

### Scope
QAAI was single-tenant per user — every signup created their own personal data island. E8 introduces the Organization tenancy boundary. Each existing user is auto-migrated into their own "Solo" org as owner; new signups likewise get an auto-created Solo org. Project, Secret, Integration, WebhookConfig, NotificationChannel, AuditLog all gain `orgId`. Every project-scoped route now filters by `orgId` instead of `userId` — meaning all org members will see the same projects, runs, and PRs (the foundation for the invite/role layer in Part 2).

User chose **substrate + invites + roles** scope, **explicit filtering** strategy (no Prisma magic auto-injection). To keep this session reviewable, I split the work: Part 1 ships the secure isolation layer; Part 2 (next session) adds invite flow, role enforcement on destructive endpoints, and the org-management UI.

### Acceptance test (V2 requirement: "User from Org A cannot see Project from Org B via forged URL")
**PASS.** Verified by [server/scripts/smoke-org-isolation.js](server/scripts/smoke-org-isolation.js) — picks a real project from the db, finds its owner (User A) and a non-member user (User B), runs the same `findFirst({ where: { id, orgId } })` query the route uses with each user's orgId. User A's lookup returns the project; User B's returns null.

### Built
1. **Schema** — three new models + orgId columns on six existing tables.
   - `Organization`: id, name, slug (unique), ownerId → User, plan, createdAt, updatedAt.
   - `OrgMembership`: id, orgId, userId, role (`owner` | `admin` | `member`), createdAt. Unique on (orgId, userId).
   - `OrgInvite`: id, orgId, email, role, token (unique), invitedBy, expiresAt, acceptedAt, createdAt. Schema is in place for Part 2 — route layer not wired yet.
   - `User.currentOrgId` — the active org for the current session. Each request reloads it via requireOrg.
   - `orgId` (all nullable for backfill compat) on: `Project`, `Secret`, `Integration`, `WebhookConfig`, `NotificationChannel`, `AuditLog`.

2. **Migration `20260527180000_orgs_substrate`** — single-pass backfill.
   - Creates one Organization per existing User. Org id derived as `'org-' || u.id` so re-running is idempotent and the relationship is traceable from any row in the system.
   - Name defaults to `<organisation || "FirstName LastName" || email>'s Workspace`.
   - Slug = `lowercase(email-localpart) + '-' + userId.slice(0,8)`.
   - Inserts an `OrgMembership` (role='owner') per user.
   - Sets `User.currentOrgId` to the user's new org.
   - Tags every existing row in the six tables: `UPDATE "T" SET orgId = 'org-' || userId WHERE userId IS NOT NULL`.
   - Adds the orgId indices.
   - All in one .sql file — no procedural code needed since the schema is uniform.

3. **`server/middleware/org.js`** (new) — `requireOrg` and `requireOrgRole(...roles)`.
   - `requireOrg` loads `User.currentOrgId` on each request, looks up the matching `OrgMembership`, and rejects with 412 NO_ORG when missing or 403 FORBIDDEN_ORG when membership was revoked. Attaches `req.org = { id, name, slug, role }` and mirrors onto `req.user.orgId` for compat.
   - `requireOrgRole('owner', 'admin')` is a second guard for destructive actions (used in Part 2).
   - One DB query per request — JWT embedding rejected because stale-org-after-switch would silently break tenancy until the 15-min JWT TTL.

4. **`server/services/audit.js`** — `log()` now accepts an explicit `orgId` and also pulls one from `req.org?.id`. Audit entries written before requireOrg ran (signup) supply orgId directly; entries written downstream pick it up automatically.

5. **`server/routes/auth.js`** — signup now auto-creates a Solo Organization, inserts an owner OrgMembership, and pins User.currentOrgId. Existing users were handled by the backfill; new ones get the same treatment at registration.

6. **Project-scoped routes — 12 files updated** to mount `requireOrg` and filter Project lookups by `orgId` instead of `userId`:
   - [server/routes/projects.js](server/routes/projects.js)
   - [server/routes/agents.js](server/routes/agents.js)
   - [server/routes/analyst.js](server/routes/analyst.js)
   - [server/routes/blocked.js](server/routes/blocked.js)
   - [server/routes/governance.js](server/routes/governance.js)
   - [server/routes/knowledgeBase.js](server/routes/knowledgeBase.js)
   - [server/routes/outputFiles.js](server/routes/outputFiles.js)
   - [server/routes/requirements.js](server/routes/requirements.js)
   - [server/routes/scenarios.js](server/routes/scenarios.js)
   - [server/routes/sprints.js](server/routes/sprints.js)
   - [server/routes/testCases.js](server/routes/testCases.js)
   - [server/routes/dashboard.js](server/routes/dashboard.js)
   - [server/routes/reporter.js](server/routes/reporter.js)
   - [server/routes/runs.js](server/routes/runs.js)

7. **`server/services/runs.js`** — `startRun`, `getRun`, `listRuns`, `compareRuns`, `getTestCaseHistory` now accept an optional `orgId` and prefer it as the auth gate (falling back to userId for any legacy callers). Run.userId is preserved as the "who triggered this" field; the org owns the run via its project.

8. **`server/routes/agents.js`** — three Run/AgentRun queries that filtered by `userId` (block-if-running, failed-cases, rerun-failed) now scope only by `projectId` (which is org-gated upstream via ownProject). This means a teammate's running pipeline correctly blocks a second user from starting another in the same project.

### Decisions (why this, not that)
- **Org id `'org-<userId>'` for backfilled rows, fresh UUIDs for new ones** — SQLite lacks a built-in UUID generator usable from a .sql migration. Deriving the id from the User id keeps the migration single-pass + idempotent, and downstream code doesn't care about the format (Prisma's `@default(uuid())` only fires for fresh inserts).
- **orgId nullable in schema, NOT NULL enforced in code** — making the column NOT NULL would require the SQLite create-new-table/copy/drop dance. Pragmatic compromise: every new write goes through a route guarded by `requireOrg`, so `req.org.id` is always set; legacy/orphan rows can stay null without invalidating the constraint.
- **Settings routes (claude/gemini/ado/jira/webhook/notifications) NOT migrated this session** — these are personal-to-user (a user's Claude API key is their own credential, not org-shared). The orgId column is stamped at backfill time but unused by the filter. Part 2 will revisit whether to share these org-wide or keep them per-user.
- **Vault service unchanged** — secrets stay keyed by (userId, name). Org sharing of API keys is a Part 2 conversation (or a never-conversation).
- **Run.userId kept as "who triggered"** — for audit/analytics. The org owns the run; the user gets credit for starting it. Same pattern as Push-to-Git's `pushedBy` (E7).
- **Run.orgId column NOT added** — Runs are tied to Projects; Project.orgId is the boundary. Adding Run.orgId would duplicate the truth and create drift if a project is ever moved between orgs (deferred concept).
- **Explicit filtering, not Prisma extension** — user picked this. The codebase is now easier to audit ("show me every query that touches Project") and easier to grep for "where is the orgId filter missing."

### Open items (Part 2 of E8 — next session)
- **Invite flow** — `OrgInvite` schema is in place but no route yet. Need POST /api/org/invite (sends email with signed token), GET /api/org/accept-invite/:token, validation + idempotency.
- **Role enforcement** — `requireOrgRole('owner', 'admin')` middleware is built; not yet attached to destructive endpoints (project delete, sprint archive, secret rotate, member remove). Member can currently still delete anything they can read.
- **Settings sharing** — Claude/Gemini/ADO/Jira API keys are still per-user. Open question: org-shared (everyone uses the same key) vs per-user (each member sets their own).
- **Org-management UI** — no UI surface at all yet. PageHeader needs an org name display; a Settings → Organization page for owners to rename, list members, invite, and remove.
- **Org switcher** — for users in multiple orgs (only happens after an invite is accepted), no UI to flip currentOrgId yet.
- **NOT NULL tightening** — when QAAI moves to Postgres (V2 E10), add the constraint at the migration layer.
- **Backfilled orgIds have the `org-` prefix** — pragmatic but mildly cosmetic. A future migration can rewrite them to fresh UUIDs if it ever matters.

### Files touched
- `prisma/schema.prisma`
- `prisma/migrations/20260527180000_orgs_substrate/migration.sql` (new)
- `server/middleware/org.js` (new)
- `server/services/audit.js`
- `server/services/runs.js`
- `server/routes/auth.js`
- `server/routes/projects.js`
- `server/routes/agents.js`
- `server/routes/analyst.js`
- `server/routes/blocked.js`
- `server/routes/governance.js`
- `server/routes/knowledgeBase.js`
- `server/routes/outputFiles.js`
- `server/routes/requirements.js`
- `server/routes/scenarios.js`
- `server/routes/sprints.js`
- `server/routes/testCases.js`
- `server/routes/dashboard.js`
- `server/routes/reporter.js`
- `server/routes/runs.js`
- `server/scripts/smoke-orgs.js` (new)
- `server/scripts/smoke-org-isolation.js` (new)
- `BUILD_PLAN_V2.md`

### Verification
- `node --check` clean on 18 touched server files.
- `npx prisma migrate dev` applied `20260527180000_orgs_substrate` and regenerated client (~237 ms). Backfill verified by `smoke-orgs.js`: 2 users → 2 orgs → 2 memberships, all existing projects tagged.
- Isolation acceptance verified by `smoke-org-isolation.js`: User B (foreign org) cannot see User A's project via direct `findFirst({ id, orgId })` query. PASS.
- Backend back up on :5000; `/api/health` returns `{ ok: true, db: 'up' }`. No frontend changes (Part 1 is purely backend substrate).


---

## Phase E10 (local-runnable subset) — Circuit breaker + per-user budget cap (completed 2026-05-25)

### Scope
The user chose to defer E9 (Postgres + KMS + object storage) entirely (no local infra to migrate to) and ship only the local-runnable parts of E10: a circuit breaker on `provider.complete` and a per-user daily token budget. The browser-pool (E10.1), observability (E10.2), and the full prod-ops surface stay deferred until real infra exists.

The wedge: BYOK users can today burn $50 of Anthropic credit in minutes if an agent loops. A sustained Anthropic 5xx storm hangs every in-flight run on 30-second retries. Both are operational hazards that already exist in the codebase; this phase adds protective primitives that work without any external infrastructure.

### Built

**Circuit breaker — E10.4**
- New `server/lib/circuitBreaker.js` — in-memory state machine keyed per provider (claude/gemini). closed → open after 5 consecutive upstream failures within a 60s window → half_open after a 30s cool-down → closed on probe success OR re-open with 1.5x backoff (capped at 5 min) on probe failure.
- Classification policy: 5xx, 503, or no-status (network) failures trip the breaker; 4xx, 429 (rate limit), 499 (cancelled), NO_API_KEY, GEMINI_INVALID_KEY do NOT.
- Wrapped at the `getProvider()` layer in `server/lib/llmProvider.js` so every agent benefits without touching agent code.
- `getRawProvider()` escape-hatch kept for connection-test routes (settings.claude/.gemini) — bypasses breaker so the user can diagnose during a real outage.

**Budget cap — E10.3**
- New `server/lib/userContext.js` — AsyncLocalStorage scope opened by `requireAuth(userId)` and mutated by `requireOrg(orgId)`. Provider wrapper reads `userId` from ALS at call time — no agent signature changes (~12 agents would otherwise have been touched).
- New `server/services/budget.js` — `assertWithinLimit(userId)` (pre-flight; throws BUDGET_EXCEEDED on hit), `recordUsage(userId, provider, usage)` (post-flight; only on successful complete()), `getStatus(userId)` (chip payload).
- New schema: `UserDailyUsage` (one row per user+UTC-date+provider, unique-keyed for atomic upserts), `User.dailyTokenLimit` (nullable; null = system default from `BUDGET_DEFAULT_DAILY_TOKENS` env, defaults to 5M tokens).
- Migration `20260528100000_budget_cap` applied cleanly.
- New `server/routes/budget.js`: `GET /api/budget/status`, `PUT /api/budget/limit`, `GET /api/budget/breaker`.
- New `src/components/BudgetChip.jsx` mounted in `PageHeader` — hidden when usage < 50% (no clutter), info chip at 50-80%, warn at 80-100%, danger at >= 100%. Click opens a popover with per-provider breakdown and UTC reset countdown. Polls every 30s.

**Hygiene pass**
- `CLAUDE.md` extended with 6 new "Conventions" sections codifying E1 (self-healing locators + KB priming), E2 (assertion_check before pass), E5 (model router tier rules; mid always routes regardless of Settings), E6 (AST + regex lint pipeline merge), E8 (requireOrg / explicit orgId filtering / Solo-org-on-signup), and E10 (provider wrapper, ALS user context, breaker classification).
- Cancellation audit: all 5 new V2 agents (healer, codeDiffAnalyzer, visualCritic, instructionReader, blockageAnalyzer) properly accept `signal`, pre-check `signal?.aborted`, propagate to `provider.complete`, and surface AbortError as CANCELLED.
- EmptyState audit: VisualDiffSection ("Baseline captured · awaiting next run"), DiffContextCard ("Configure repo first"), KnowledgeBase ("No locators match the current search"), BudgetChip (renders null when no data / unlimited / < 50%). All clean.

### Decisions

- **ALS over signature threading**: tying `userId` to AsyncLocalStorage in `requireAuth` keeps the agent layer (12 files) untouched. Trade-off: ALS context CAN be lost across non-await boundaries (`setTimeout`, EventEmitter). For fire-and-forget run pipelines that complete after `res.send()`, context still propagates because Node's async-hooks track promise chains. Verified by smoke; if observed lost in the wild for a specific path, fix with `userContext.runAsUser()` at the seam.
- **Breaker keyed per provider, not per API key**: outages are provider-wide. A noisy individual key doesn't deserve to trip the breaker for every user. Trade-off: a single bad key spamming 5xx contributes to global trips — acceptable because 5xx from one key usually means provider-side trouble, not key trouble.
- **Failure window of 60s**: failures must cluster within 60s to extend the streak. A single 5xx an hour later doesn't reset the day or trip prematurely.
- **Default daily limit of 5M tokens**: high enough that BYOK users in normal use never see the chip; low enough that a runaway loop hits it within minutes. Override per-user via PUT /api/budget/limit; 0 = unlimited escape hatch for ops.
- **No record on failure**: budget only debits successful `complete()` calls. Users shouldn't pay for upstream 5xx. Same instinct as the breaker — failures don't count against your day.
- **UTC date keying, not local TZ**: server-wide consistent date math. UI shows the reset countdown to UTC midnight; the chip is for awareness, not for the chrome.
- **Per-USER budget, not per-org**: BYOK API keys are per-user — a heavy day on org A's project still bills the individual user's Anthropic account. The chip stays in PageHeader (above org context), and the budget route deliberately omits `requireOrg`.

### Open items

- E10.1 (browser pool: Docker / BullMQ / Redis), E10.2 (OpenTelemetry traces), E9 (Postgres / KMS / object storage) all stay deferred until production infra exists. Marked explicitly infra-blocked in BUILD_PLAN_V2.md.
- E8 Part 2 (invite flow + role enforcement on destructive endpoints + Org-management UI) deferred at user's direction; substrate (Part 1) is enough for "outstanding without production hardening."
- Cost-visibility panel (per-agent breakdown) deferred — the per-provider chip is enough for now; BYOK users already see their own bills.
- No real-money cost conversion. Token counts are universal; pricing varies by provider/model and changes. If needed later, a tiny `tokensToUsd` table in the budget service would do it.

### Files

- `server/lib/circuitBreaker.js` (new)
- `server/lib/userContext.js` (new)
- `server/lib/llmProvider.js` (wrap getProvider; add getRawProvider escape hatch)
- `server/services/budget.js` (new)
- `server/routes/budget.js` (new)
- `server/middleware/auth.js` (open ALS scope around next())
- `server/middleware/org.js` (mutate ALS scope with orgId)
- `server/index.js` (mount /api/budget)
- `prisma/schema.prisma` (User.dailyTokenLimit, UserDailyUsage model + back-relation)
- `prisma/migrations/20260528100000_budget_cap/migration.sql` (new)
- `src/components/BudgetChip.jsx` (new)
- `src/components/PageHeader.jsx` (mount BudgetChip)
- `server/scripts/smoke-breaker-budget.js` (new)
- `CLAUDE.md` (six new Conventions sections codifying E1, E2, E5, E6, E8, E10)
- `BUILD_PLAN_V2.md` (E10 partial-complete; remaining infra-blocked items marked)

### Verification

- `node --check` clean on all 8 touched server files.
- `npx vite build` succeeds (only pre-existing 500 KB chunk-size warning).
- `npx prisma migrate dev --name budget_cap` applied cleanly; Prisma client regenerated.
- `node server/scripts/smoke-breaker-budget.js` — 15 / 15 PASS covering: breaker starts closed, doesn't trip on 4xx/429, trips on 5xx/503/network at threshold 5, BREAKER_OPEN throws; budget records, gates, multi-provider breakdown, unlimited escape hatch.
- Backend back up on :5000; `/api/health` returns `{ ok: true, db: 'up' }`. `/api/budget/status` returns 401 without auth (route mounted, gate applied).

---

## Architect + AST tightening pass (completed 2026-05-25)

Pulled three concrete enhancements from the AutomationWithNaveen Playwright AI-Agents guide. The guide itself is a beginner-level "paste prompts into ChatGPT" tutorial, but it surfaced three small wins QAAI didn't already have:

### Built

1. **Architect scenario-category diversity** — `server/services/agents/architect.js` SYSTEM_PROMPT gains three new CRITICAL RULES (7–9): demand at least one negative+security scenario when the feature has user-supplied input (SQLi / XSS / authz / path traversal / oversized payload), demand at least one UI-validation scenario per module with interactive elements (error / loading / disabled / toast), and ban returning a scenario list that is 100% category="positive". Prior prompt accepted that lazily.
2. **Healer prompt — audit only, no edit** — verified that `server/services/agents/healer.js` already encodes a strict role > testid > label > text > css preference, anti-loop history check, "never fabricate" floor, and explicit "no generated class names with numeric tails" rule. The PDF's "use get_by_label, more stable than placeholder" wisdom is already there and stronger.
3. **AST rule #6 — ast-low-assertion-density** — new rule in `server/lib/specAst.js`. Counts user-interaction calls (click / dblclick / fill / type / press / pressSequentially / check / uncheck / selectOption / setInputFiles / hover / focus / tap / dragTo) vs. expect() calls per test(). Fires `warning` when actionCount ≥ 4 AND expectCount ≤ 1. Catches the LLM-generated "5-step happy path with one terminal assertion" anti-pattern. Threshold of 4 picked so canonical short login tests (goto + 2 fills + click + 1 expect) don't false-fire. Excluded from the actionCount: navigation, waits, screenshots, evaluate — those are framework operations, not user actions.

### Verification

- `node --check` clean on `specAst.js` and `architect.js`.
- `node server/scripts/smoke-ast-lint.js` extended with a "5-action wizard, 1 terminal assert" test in the BAD spec; smoke now asserts BAD has 5+ AST findings (got 7), BAD explicitly triggers `ast-low-assertion-density`, GOOD has 0 (got 0), both under 500 ms (43 ms / 6 ms). PASS.
- Backend live on :5000, nodemon picked up changes, `/api/health` still OK.

### Decisions

- Architect rules 7–9 stop short of mandating specific category counts — over-prescription would degrade output on genuinely-small features. The rules read as "include X when applicable", letting the model exercise judgment on truly-trivial features.
- AST density threshold = 4 interactions, not 3. With threshold 3 the canonical login (fill, fill, click, assert) would fire — too noisy. Threshold 4 catches wizard / checkout chains where the smell is real.
- Healer prompt deliberately NOT modified — verified by reading the source. Adding more rules to an already-strict prompt would just inflate the token budget without changing behaviour.

### Files

- `server/services/agents/architect.js` (SYSTEM_PROMPT — rules 7, 8, 9 added)
- `server/lib/specAst.js` (USER_INTERACTIONS set + density thresholds + rule 6 in CallExpression exit)
- `server/scripts/smoke-ast-lint.js` (BAD spec gets a wizard test; acceptance bumped 4→5; explicit assertion that density rule fires)
- `CLAUDE.md` (E6 conventions section lists the 6 AST rules)

---

## Phase E10.5 — Browser context + downloads + tricky-page playbook (completed 2026-05-25)

### Scope

Closes the "~10% of UI scenarios our LLM-driven Conductor flakes on" gap that surfaced in the user's review of common test-app challenge surfaces (Basic Auth, Digest Auth, Geolocation, Notification/Camera prompts, File Download verification, unexpected dialogs, frames, shadow DOM, locale-sensitive UI, mobile UA). The goal — explicitly per the user's directive — was "reliably handles every scenario on this list, with explicit fallback when something genuinely fails." Not 100% guaranteed (that's a marketing number, not an engineering one); reliable.

Three workstreams shipped together so the surface lands coherent:
1. **WS1 — browser context configuration**: per-project knobs threaded into the MCP session at boot
2. **WS2 — downloads watcher + assertion_check.expectedDownload**: explicit file-download verification
3. **WS3 — tricky-page playbook**: prompt-level guidance + auto-dialog handler for the patterns LLMs flake on

### Built

**WS1 — browser context configuration**
- `Project` model gains 13 nullable fields: `contextViewport`, `contextDevice`, `contextLocale`, `contextUserAgent`, `contextColorScheme`, `contextPermissions`, `contextGeolocation`, `contextHttpCredentials`, `contextExtraHeaders`, `contextIgnoreHttpsErrors`, `contextProxyServer`, `contextProxyBypass`, `autoAcceptDialogs` (default true).
- New `server/services/mcpContextConfig.js` — `buildContextArgs(project, session)` translates the fields to @playwright/mcp CLI flags (`--device`, `--user-agent`, `--grant-permissions`, `--ignore-https-errors`, `--proxy-server`, `--proxy-bypass`, `--output-dir`, `--init-script`) AND emits a per-session init-script under a tmp dir with browser-side shims for the things the CLI doesn't expose (locale via `Object.defineProperty(navigator, 'language', ...)`, color-scheme via `matchMedia` patch, geolocation coords via `getCurrentPosition` override, extraHeaders + httpCredentials Basic-auth via `fetch` + `XMLHttpRequest` wrappers, dialog auto-accept via `window.alert/confirm/prompt = noop`).
- `mcp.startMcpSession({ project })` now reads context fields; conductor.js + knowledgeBase.js heal-now route both load the full Project row and pass it through.
- New `GET/PUT /api/projects/:id/browser-context` — read + replace the context config. PUT validates JSON shape of viewport / permissions / geolocation / credentials / headers fields client-side before save.
- New `BrowserContextEditor` component in `src/pages/ProjectSetup.jsx` — collapsible per-project section with a 2-column grid for viewport/device/locale/color-scheme, single-line inputs for the JSON fields, checkboxes for the two booleans. Closed by default, shows a "configured" badge when any field is non-default.

**WS2 — downloads watcher**
- New `Download` model: `(id, projectId, runResultId?, suggestedFilename, storedFilename, path, sizeBytes, mimeType, capturedAt)`. RunResult cascades on Project delete; SetNull when RunResult is deleted so download history survives.
- New `server/services/downloadWatcher.js` — 1.5s poller against the session's `downloadsDir`. Files stabilise across two polls (size + mtime unchanged) AND meet a minimum-size threshold before recording, to avoid capturing half-written downloads. Per-session state holds `caseStartTs` + `activeRunResultId` for attribution.
- Wired into `mcp.js` session boot (starts after session shell is built, before initial navigate) and `stopMcpSession` cleanup. Downloads dir is preserved on session close — the Download rows reference its files; reaper-based cleanup is a separate concern.
- Conductor calls `downloadWatcher.setCaseStart(session)` at the top of every case, and `attributeRecentDownloads(session, runResultId, projectId)` inside `persistResultAndCodegen` right after `runResult.create` returns its new id. Back-fills the runResultId on any Downloads captured in this case's window. Failure to attribute is logged but never breaks the run.
- `assertion_check` MCP tool gains `expectedDownload: { filenamePattern, minSize, mimeType }`. Switched to `async` to await the prisma query. Download-only assertions skip the "no snapshot cached" guard. Returns `matched: true` with rich evidence ("download \"report.pdf\" (245.3 KB, application/pdf) captured at ...") on success.
- New `GET /api/projects/:id/downloads?runResultId=` route — newest-first list, optional filter for Reports detail pane.

**WS3 — tricky-page playbook + dialog handler**
- Conductor SYSTEM_PROMPT_LOOP grows a "Tricky-page playbook (E10.5 — apply when the pattern fits)" section covering: iframe handling (use ref-based targeting, MCP handles frame switching), shadow DOM (Playwright auto-pierces open, end-turn-blocked on closed), unexpected modals (dismiss before continuing), downloads (call `assertion_check` with expectedDownload), AJAX/dynamic loading (one extra snapshot retry before declaring failure), geolocation (pre-configured, no permission prompt), Basic/Digest auth (pre-injected, no modal), dialogs (auto-accepted by default).
- The dialog auto-accept is also implemented as part of WS1's init-script (always-on unless `autoAcceptDialogs=false`) — belt-and-braces: the prompt tells the agent what to expect, the script enforces it.

### Verification

- `node --check` clean on all 8 touched server files.
- `npx vite build` succeeds.
- `npx prisma migrate dev --name browser_context_and_downloads` applied cleanly; client regenerated.
- `node server/scripts/smoke-browser-context.js` — **24 / 24 PASS** covering: empty-project defaults, output-dir always set, downloads dir created, dialog shim ON by default, full-config emits all expected CLI flags + grant-permissions space-tokenized correctly + init-script shims for geo/locale/colorScheme/extraHeaders/Basic auth + script is syntactically valid JS + autoAcceptDialogs=false suppresses dialog shim cleanly.
- Backend live on :5000, nodemon picked up changes, `/api/health` returns `{ ok: true, db: 'up' }`. `GET /api/projects/:id/browser-context` returns 401 without auth (route mounted, gate applied).

### Decisions

- **Init-script for non-CLI options vs writing a config file**: chose init-script. @playwright/mcp's `--config <path>` flag exists but its schema isn't documented, and a forward-only injection script gives us full control over the page-side shape. The script can also evolve independently — when @playwright/mcp adds a `--locale` CLI flag (it should), we delete the matchMedia shim and switch.
- **Fetch + XHR interceptor for HTTP credentials**: chose interceptor over `extraHTTPHeaders` browser context option (which @playwright/mcp doesn't expose). Trade-off: pages using Service Workers or websockets bypass the interceptor. Acceptable for v1 — Basic auth pages don't typically use SW. Future hardening: if a project flags "auth via SW", emit a separate SW-installer shim.
- **Auto-accept dialogs default ON**: per the user's "agent should not hang" directive. Tests that explicitly validate dialog copy opt out by setting `autoAcceptDialogs=false` — they get the dialog text in the snapshot because the SUT renders it. Trade-off: a SUT using `confirm()` for "Delete account?" is auto-confirmed; the test author must opt out for those.
- **Downloads attributed AFTER RunResult.create**, not before: avoids pre-creating shell RunResult rows. The `attributeRecentDownloads` query is bounded to `(projectId, runResultId IS NULL, capturedAt >= caseStartTs)` so cross-case bleed is impossible. Trade-off: if a download captures DURING the case and `assertion_check.expectedDownload` is called immediately, the activeRunResultId is still null — the check returns "no RunResult is active" and the agent retries on next turn (typical). Acceptable.
- **JSON fields as Strings on Project**: SQLite-compatible. Postgres swap (E9) is the right time to flip them to native Json columns. Until then, the backend validates by parse-or-warn at MCP boot, not at PUT-time, because the editor stores raw strings.
- **`expectedDownload` on `assertion_check`**: extended in place rather than a new MCP tool. Keeps the agent's mental model simple (one assertion tool) and lets a single call combine page + download checks (e.g. assertion="user downloaded the report and lands on confirmation", expectedText="Download started", expectedDownload={...}).
- **Playbook block in the prompt**: explicit per-scenario hints rather than detect-and-inject. Detect-and-inject (parse the snapshot, inject relevant hints) was tempting but adds latency on every turn for ambiguous wins. The static playbook lets the LLM apply judgment — it's better at "this looks like a frame situation" than our regex would be.

### Files

- `prisma/schema.prisma` (Project context fields + Download model + RunResult back-relation)
- `prisma/migrations/20260528160000_browser_context_and_downloads/migration.sql` (new)
- `server/services/mcpContextConfig.js` (new — builds CLI args + init-script)
- `server/services/downloadWatcher.js` (new — poller + attribution + checkDownloadExpectation)
- `server/services/mcp.js` (thread project through startMcpSession; wire watcher start/stop; assertion_check expectedDownload)
- `server/services/agents/conductor.js` (load Project before MCP boot; setCaseStart + attributeRecentDownloads; tricky-page playbook in SYSTEM_PROMPT_LOOP)
- `server/routes/projects.js` (GET/PUT /:id/browser-context + GET /:id/downloads)
- `server/routes/knowledgeBase.js` (heal-now passes project to startMcpSession)
- `src/pages/ProjectSetup.jsx` (new BrowserContextEditor + FieldRow helper)
- `server/scripts/smoke-browser-context.js` (new — 24 assertions)
- `CLAUDE.md` (new Conventions section E10.5)

### Open items

- File-download verification only covers downloads triggered by the page itself (via `<a download>` or programmatic `URL.createObjectURL` + click). Direct navigation to a binary URL (`window.location = '/file.pdf'`) goes through Chrome's default handler, which may or may not save to our `--output-dir`; verified pattern works on the-internet.herokuapp.com but not guaranteed for every SUT. Documented limitation; not blocking.
- Init-script's Basic-auth interceptor doesn't cover Service Worker requests or websocket upgrades. SUTs using SW for auth are rare; future hardening tracked.
- No UI yet for browsing captured Downloads per RunResult — `GET /api/projects/:id/downloads` exists, the Reports detail pane integration is the obvious next iteration but deferred.
- Browser pool (E10.1) still infra-blocked. With the init-script approach, each session gets its own dedicated subprocess + tmp script file — fine at 1-3 concurrent users, will need cleanup at scale.
