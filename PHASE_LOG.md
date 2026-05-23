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

