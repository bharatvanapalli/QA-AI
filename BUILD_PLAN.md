# BUILD_PLAN.md — QAAI Portal enterprise build

12-phase plan. Status: ✓ done · 🔄 in progress · ⏳ pending.

Read [CLAUDE.md](CLAUDE.md) for invariants. Read [PHASE_LOG.md](PHASE_LOG.md) for completed phase details.

---

## Phase 0 — Foundation reset ✓ (2026-05-21)
- ✓ Governance files: CLAUDE.md / BUILD_PLAN.md / PHASE_LOG.md + 5 memory entries.
- ✓ Output Files content viewer fixed (was URL-encoding slashes into the legacy `/:name` route).
- ✓ In-house TS syntax highlighter ([src/lib/highlightTs.js](src/lib/highlightTs.js)) — no new dep.
- ✓ Wiped runs / scenarios / docs per user permission. Project, KB, integrations, audit log kept.
- ✓ SIGTERM/SIGINT graceful shutdown — aborts Claude calls, tears down MCP sessions, exits clean.
- ✓ Double-run debounce via `blockIfRunInProgress` helper applied to `/start`, `/execute`, `/rerun-failed`.
- ✓ Reaper tightened to 30 s interval; status → `cancelled` not `failed`.

See [PHASE_LOG.md](PHASE_LOG.md#phase-0--foundation-reset-completed-2026-05-21) for details.

## Phase 1 — Run Suite (upload + first AI call) ✓ (2026-05-21)
- ✓ Category-aware buckets (BRD / Release Notes / User Stories / API spec / Other) — uploads auto-categorised, re-tag via inline dropdown.
- ✓ Cost preview card (input tokens, output max, USD cost, duration) before Generate.
- ✓ Inline streaming Architect banner with mini log tail + real Terminate. Toast.info noise removed.
- ✓ Auto-navigate to `/test-cases?just=generated` on completion (preserved).
- ✓ Global indicator hides on `/run-suite` for architect/analyst phases.
- ✓ CLAUDE.md convention added: inline phase banners over floating widgets.

See [PHASE_LOG.md](PHASE_LOG.md#phase-1--run-suite-upload--first-ai-call-completed-2026-05-21) for details.

## Phase 2 — Test Cases (logic + UX hardening) ✓ (2026-05-21)
- ✓ Status pills scroll the viewport to the first matching scenario card.
- ✓ Confidence filter chips (≥80% / ≥90%) — combines with priority + type + status.
- ✓ Regenerate just one scenario via per-card kebab → server endpoint `POST /scenarios/:id/regenerate` (module-scoped Architect).
- ✓ Cmd+K search modal across name + assertions, with ↑↓ keyboard nav and Enter to pick.
- ✓ Bulk-select mode with sticky action bar (approve / reject / remove / select all visible / clear / done).
- ✓ Inline cost+duration preview under the Run button.
- ✓ Smart-select fallback: empty release notes → 400 with `NO_RELEASE_NOTES` code + actionable toast (no more "everything impacted").

See [PHASE_LOG.md](PHASE_LOG.md#phase-2--test-cases-hardening-completed-2026-05-21) for details.

## Phase 3 — Live Pipeline (Theater) ✓ (2026-05-23)
- ✓ Three-pane CSS grid (`lg:grid-cols-[280px_1fr_340px]`): PhaseTimeline (left) · BrowserFrame (centre) · ActionTrail (right). Stacks single-column below `lg`.
- ✓ PhaseTimeline uses `PHASE_STATUS_META` from [src/lib/statusMeta.js](src/lib/statusMeta.js) — running phases pulse with a coloured ring; click any phase to expand its dark log panel inline.
- ✓ BrowserFrame controls: pause/resume (viewer freeze), zoom slider 0.5–2×, **fullscreen** (CSS `fixed inset-0 z-50` expand inside the app, Esc to exit, exit chip top-right). No native Fullscreen API.
- ✓ Picker mode with ranked candidates — `PickerCandidates` component renders per-candidate stability bar (success ≥80 / warn ≥50 / danger <50), strategy chip, mono expression, click-to-copy with toast.
- ✓ Action trail with sticky-to-bottom scroll behaviour (stops auto-scrolling when the user reads history; resumes when they scroll back within 20 px of the bottom).
- ✓ Idle-state `LastRunSummary` card — counts + pass-rate stacked bar + relative time. Inline "Show details" expansion fetches `GET /projects/:id/runs/:id` and renders: top 5 failures with error preview + per-scenario pass/fail/blocked/skipped breakdown. **No navigation** (per user preference — keeps Reports trip optional).
- ✓ Failed-cases endpoint now surfaces `blocked` alongside passed/failed/skipped so the idle card shows the real blocked count.
- ✓ Extracted `timeAgo` to [src/lib/timeAgo.js](src/lib/timeAgo.js); added "just now" branch for < 5 s.

See [PHASE_LOG.md](PHASE_LOG.md#phase-3--live-pipeline-completed-2026-05-23) for details.

## Phase 3.5 — Quality sweep (Tier 1 shipping defects) ✓ (2026-05-23)
- ✓ `<ConfirmDialog>` + `useConfirm()` hook (pre-shipped). All 9 callsites already use `confirm({...})` — no `window.confirm()` remains in src/.
- ✓ Theater palette typo eliminated by the Phase 3 rewrite (no `bg-warning-*` anywhere in src/).
- ✓ WS reconnect already derives URL from `window.location` with `VITE_WS_URL` override; exponential backoff with jitter caps at 30 s. ([src/store/runStream.jsx](src/store/runStream.jsx))
- ✓ Toast context value already memoized via `useMemo([push, dismiss])`. ([src/lib/useToast.jsx](src/lib/useToast.jsx))
- ✓ `AgentRunningIndicator` already a sibling of the grid (placed above the grid container in MainLayout). ([src/App.jsx](src/App.jsx))
- ✓ Sidebar sign-out already wrapped in try/catch with toast on failure and conditional navigate. ([src/components/Sidebar.jsx](src/components/Sidebar.jsx))
- ✓ Reports.jsx already drops stale `runIdParam` from previous project on project switch. ([src/pages/Reports.jsx](src/pages/Reports.jsx))
- ✓ **ErrorBoundary now resets on route change** (THIS is the only new work — `resetKey` prop + `RouteAwareBoundary` wrapper inside BrowserRouter). Also fixed raw `bg-slate-*` / `border-rose-*` / `text-rose-*` palette violations in the fallback UI to use `ink`/`danger` tokens.

See [PHASE_LOG.md](PHASE_LOG.md#phase-35--quality-sweep-completed-2026-05-23) for details.

## Phase 4 — Overview dashboard ✓ (2026-05-23)
- ✓ AI Release Recommendation with coverage gate visible (GO / HOLD / NO_GO / NO_DATA) — server engine already done in [server/routes/dashboard.js](server/routes/dashboard.js), no client change needed.
- ✓ **Coverage tile** — new 5th `Stat` in the strip showing `{coveragePercent}%` + `{executed} of {total} executed`. Clickable → `/reports?runId=<latestRunId>`.
- ✓ **Module Health "Not yet measured"** — modules are split into measured (≥1 pass/fail/blocked) and unmeasured. Measured render in the StackedBar; unmeasured render as a list with a "Run module" button that deep-links to `/test-cases?module=<encoded>`.
- ✓ **Recent Runs: all-zero runs hidden** — server filters out runs where `passed+failed+blocked+skipped === 0` (except `running` runs, which legitimately have no counts yet).
- ✓ **Every stat tile clickable**: Passed → `/reports?runId=<id>&status=pass`, Failed → `?status=fail`, Blocked → `/blocked-items`, Coverage → `/reports?runId=<id>`, PRs pending → `/governance`.
- ✓ **TestCases honors `?module=<name>`** — filters scenario list to the module, shows a dismissable info banner with case count and "Clear module filter" link.
- AI cost / usage display **deferred to Phase 5** per user choice (lives on Run detail as per-Run cap %, not on the dashboard).

See [PHASE_LOG.md](PHASE_LOG.md#phase-4--overview-dashboard-completed-2026-05-23) for details.

## Phase 5 — Reports ✓ (2026-05-23)
- ✓ Hide all-zero runs from `/runs` list — server-side filter in [server/services/runs.js#listRuns](server/services/runs.js), `running` rows exempt.
- ✓ Filter chips show counts — `(N)` per status against the search-narrowed result set.
- ✓ RCA panel — pre-shipped (Reporter agent + RcaPanel + RunResult RCA fields), no new work needed.
- ✓ Export PDF — `window.print()` button in the page header + `@media print` block in [src/index.css](src/index.css). Hides asides, filter bar, mobile tabs; flattens scroll containers; black-on-white text; `@page` margins; avoid-break headings.
- ✓ Sprint filter dropdown — derived from distinct sprintName values across the run list. URL param `?sprint=` for shareability. Renders only when there are ≥2 sprints.
- ✓ **Claude rate-limit chip** — captures `anthropic-ratelimit-tokens-*` headers from every Claude response via a new [server/lib/anthropicHeaders.js](server/lib/anthropicHeaders.js) helper. `onRateLimit` callback plumbed through all 7 agent services. Broadcasts `claude.rate-limit` over WS. Client renders a live TPM % chip in the Reports header (success / warn / danger by usage). Real signal, no artificial caps.

See [PHASE_LOG.md](PHASE_LOG.md#phase-5--reports-completed-2026-05-23) for details.

## Phase 5.5 — Conversational RCA + User guidance ✓ (2026-05-23)
- ✓ **Conversational RCA chat** per `RunResult` — `RcaChatPanel` in the Reports detail pane below the RCA panel. New [server/services/agents/rcaChat.js](server/services/agents/rcaChat.js) takes result context (TC + error + trace + network log + prior RCA) + history + new message → Claude reply. History persists as `RunResult.chatHistory` JSON.
- ✓ **Per-test-case user guidance** — `CaseGuidanceEditor` in Reports detail pane. Stored as `TestCase.userGuidance`. Conductor's system prompt prepends a "Per-test-case guidance" block built from cases in the current batch.
- ✓ **Per-project AI guidance** — `ProjectGuidanceSection` at the bottom of Settings → Claude. Stored as `Project.aiGuidance`. Every agent (Architect, Planner, Conductor, Critic, Supervisor, Analyst, Reporter, RcaChat) prepends it via the new composer.
- ✓ New helper [server/lib/promptCompose.js](server/lib/promptCompose.js) — `composeSystemPrompt(base, guidance)` + `joinGuidance({ projectGuidance, caseGuidance })`. Single composer so call sites stay short.
- ✓ New endpoints: `POST /runs/:r/results/:res/chat`, `PUT /projects/:p/guidance`. Per-case guidance flows through the existing `PUT /projects/:p/test-cases/:tc` (added `userGuidance` field).
- ✓ Migration: `20260523083954_add_chat_and_guidance` adds 3 nullable columns.

See [PHASE_LOG.md](PHASE_LOG.md#phase-55--conversational-rca--user-guidance-completed-2026-05-23) for details.

## Phase A — Multi-provider AI (Claude + Gemini) ✓ (2026-05-23)
- ✓ `Project.aiProvider` column (default `'claude'`) — migration `20260523095538_add_ai_provider`.
- ✓ Provider abstraction layer: [server/lib/llmProvider.js](server/lib/llmProvider.js) factory + `providers/anthropic.js` + `providers/gemini.js`. Anthropic-shape `messages`/`tools` is canonical; Gemini provider translates `tool_use`/`tool_result` ↔ `functionCall`/`functionResponse` on every call.
- ✓ Settings → **AI Provider** (new tab, default landing) — per-project provider picker via `ProjectProviderSection`. Decoupled from the per-provider key pages so the toggle isn't confusingly duplicated.
- ✓ Settings → **Gemini API** — `GeminiSettings.jsx` mirrors Claude page. Lenient key validation (`AIza` prefix + 20+ chars) — Google's actual `/v1beta/models` decides. Model dropdown populates from response.
- ✓ All 7 agents + codegen (`pom`/`cucumber`/`selenium`) + `rcaChat` refactored to call `provider.complete({apiKey, model, system, messages, tools, maxTokens, signal, onRateLimit})`.
- ✓ Route credential loader: [server/lib/resolveAiCredentials.js](server/lib/resolveAiCredentials.js) — `{provider, apiKey, model, integration}` from project's `aiProvider`. Used by agents/scenarios/analyst/reporter routes.
- ✓ Reports rate-limit chip hides on Gemini (Google API doesn't return per-request remaining-tokens headers).
- ✓ MCP tools translate at the provider boundary — Conductor's tool-use loop is unchanged; same Playwright MCP server drives both providers.

See [PHASE_LOG.md](PHASE_LOG.md#phase-a--multi-provider-ai-completed-2026-05-23) for details.

## Phase A.5 — Project deletion hygiene + bug fixes ✓ (2026-05-23)
- ✓ **DELETE project cleans disk artifacts** — [server/routes/projects.js](server/routes/projects.js) collects `GovernancePR.filename` + `RunResult.{screenshots,video,trace}` BEFORE the cascade, unlinks them after the DB delete, sweeps empty per-module subdirs. Audit log records `filesDeleted/filesAttempted`.
- ✓ **OutputFiles filters by project content** — [server/routes/outputFiles.js](server/routes/outputFiles.js) only returns disk files whose UUID matches one of this project's TestCase ids OR whose path matches a GovernancePR.filename for this project. Shell scaffolding (`playwright.config.ts`, `package.json`, `tsconfig.json`) only surfaces when the project has ≥1 PR. Empty project = empty list.
- ✓ One-shot orphan cleanup script: [server/scripts/cleanup-orphans.js](server/scripts/cleanup-orphans.js). Dry-run by default; `--apply` to delete.
- ✓ TestCases.jsx TDZ crash fix (useEffect/useCallback ordering — Phase 2 regression).
- ✓ ErrorBoundary route-reset via `resetKey` + `RouteAwareBoundary` wrapper.
- ✓ Settings tab restructure: **AI Provider** as standalone first tab (was inline-duplicated on Claude + Gemini pages and confused users).
- ✓ Bottom padding (`pb-24`) on settings main content so dropdowns at page end don't crowd the Save button.
- ✓ **Robust JSON extraction for all agents that parse model output** — new [server/lib/parseJsonResponse.js](server/lib/parseJsonResponse.js) with 4 recovery strategies (direct, markdown-fence, opener-to-closer, truncation). Used by Planner/Critic (run+runInline)/Supervisor/Reporter/Analyst (×2). Fixes Gemini Planner failures where the model adds preamble prose to its JSON.
- ✓ **Live Pipeline (Theater) layout rebalance** — two-row layout: `[PhaseTimeline 240px | BrowserFrame flex]` on top, full-width `ActionTrail` below. Browser frame is `aspect-[16/9] min-h-[520px]` — roughly 40% wider and significantly taller than the prior three-pane layout.

## Phase 6 — Output Files (richness) 🔄 (partial — 2026-05-25)
- (Content viewer fix lands in Phase 0; this phase polishes.)
- Syntax highlighting refinement. ⏳
- Per-file actions (copy / download / open in PR). ⏳
- File-tree count badges. ⏳
- ✓ **Clear all output files** action (button + confirm + `DELETE /api/projects/:id/output-files` endpoint that wipes disk + matching TestCase.specCode + GovernancePR rows).
- ✓ **Auto-clear on regenerate**: scenarios `POST` with `replace:true` now collects PR/RunResult paths before deleteMany, then unlinks them. Prevents the "DB wiped but disk files survive" desync.

## Phase 7 — Blocked Items ✓ (2026-05-25)
- ✓ **AI blockage reasoning** — `blockageAnalyzer` agent emits structured `{category, summary, rootCauseTcId, suggestedFix, severity}` per blocker. Dependency-graph aware via scenario.dependencyOn projected to per-TC upstream lists at the route layer. Schema columns + migration `20260525130000_add_blocker_ai_fields`. New `POST /api/projects/:projectId/blocked/analyze` endpoint (rate-limited 6/min, CSRF). Auto-runs at the end of `runConductorWithRetries` when blockedCount > 0; manual "Re-analyse" button in the UI for ad-hoc rerun. "Why blocked?" panel in BlockedItems renders category chip + narrative + clickable root-cause TC pill + suggested fix.
- ✓ Severity sort (server-side: high > normal > low, then createdAt desc).
- ✓ Assign to engineer (inline `Input`, PATCH on Enter/blur).
- ✓ Resolve with note (optional textarea on the resolve/skip footer, stored on `BlockedItem.resolveNote`).

See [PHASE_LOG.md](PHASE_LOG.md#phase-7--m2-triage-gets-smart-completed-2026-05-25) for details.

## Phase 8 — Governance PR ✓ (2026-05-25)
- ✓ Side-by-side diff via new `server/lib/lineDiff.js` (LCS) + `GET /:id/diff` route. Base = most recent merged PR for the same testCaseId; greenfield = empty base (100% adds).
- ✓ Approve / Reject / Merge confirm flow via `useConfirm`. Merge dialog calls out "this becomes the new baseline".
- ✓ Comments thread via new `PRComment` model + migration + 3 routes; flat list, author = email, only author can delete.
- ✓ Lint findings have a clickable "Line N" pill that scrolls + pulse-highlights the line in both Code and Diff views.
- ✓ Token-palette pass over the page (warn/info/success/danger replace raw amber/sky/emerald/rose).

See [PHASE_LOG.md](PHASE_LOG.md#phase-8--m4-governance-gets-real-completed-2026-05-25) for details.

## Phase 9 — Knowledge Base ✓ (delivered via [BUILD_PLAN_V2.md](BUILD_PLAN_V2.md) E1, 2026-05-25)
- ✓ Locator health timeline — SVG `HealthLine` reconstructed from `healHistory`, dashed quarantine threshold marker.
- ✓ Top flaky locators (top 10) — sorted by `failureCount desc`, side panel on the KB page.
- ✓ Heal-now button per locator — both on `selector_drift` BlockedItems and inline on each KB row. Routes through `POST /api/projects/:p/knowledge-base/:id/heal-now`.
- ✓ Search by element / selector / accessibleName / role / intent / pageUrl.

See [PHASE_LOG.md](PHASE_LOG.md#phase-e15--knowledgebase-page-upgrade-completed-2026-05-25) for the V2 delivery details. Phase 9 closes via the E1 self-healing engine.

## Phase 10 — Execution Log ✓ (M5, 2026-05-25)
- ✓ Level filter chips (phase / pass / warn / error) with live counts; multi-select; clears on project switch.
- ✓ Search (case-insensitive `includes` over the filtered view).
- ✓ Copy log button — copies the filtered subset when filters are active, otherwise the whole log.
- ✓ Smart auto-scroll: pauses on manual scroll-up; "Jump to latest" floating button to resume.
- Deferred: per-agent (architect / planner / conductor) phase filter — current heuristic groups them under "Phases"; if needed later add `[agent]` tagging on the server and a second filter row.

## Phase 11 — Settings ✓ (M5, 2026-05-25)
- ✓ Live Claude usage tile (TPM bar + reset countdown + RPM row + last-sampled stamp) sourcing from the `claude.rate-limit` WS feed.
- ✓ "Test connection" promoted to right-side primary CTA on both Claude and Gemini settings when a key is stored and the form is clean; backed by new `POST /settings/{claude,gemini}/test` (vault-pull + validate).
- ✓ Provider status row in the sidebar under Settings — Claude / Gemini, color-coded (success/warn/danger), refetches on auth + leaving `/settings/*`. Collapses to a status dot in icon-only sidebar mode.

## Phase 12 — Enterprise hardening ⏳
- Audit log page.
- Backup/restore for `dev.db`.
- Export project as Playwright repo.
- User roles enforcement.

---

## Phase B — Sprint isolation ✓ (B3 hybrid shipped 2026-05-25)

Sprint is now a first-class per-project container for Docs / Requirements / Runs / Blockers / PRs. TestCases stay project-level; `SprintTestCase` join captures which cases ran in each sprint. Header pill switches the active sprint, ProjectSetup has full CRUD, every artifact list endpoint accepts `?sprintId=` and every artifact-creating endpoint accepts a sprintId in the body. Archived sprints reject writes with `SPRINT_LOCKED`.

See [PHASE_LOG.md](PHASE_LOG.md#phase-b--b3--m3-sprint-isolation-hybrid-completed-2026-05-25) for details.

**Paths considered (B3 chosen):**

- **B1 — Light (~1 day)**: reuse `Run.sprintName` only. ❌ Rejected — too thin to support sprint comparison or carry-forward.
- **B2 — Full container (~3-5 days)**: sprintId on every model including TestCase. ❌ Rejected — invasive migration; doesn't match how smoke tests get reused across sprints.
- **B3 — Hybrid ✓**: Sprint container for Docs/Requirements/Runs/Blockers/PRs; TestCases stay project-level via `SprintTestCase` join. Best match to QA-team practice.

## Phase B+ — Sprint enhancements ✓ (M6, 2026-05-25)

- ✓ **Sprint lifecycle gate**: `planning|in_progress → completed` refuses with `409 SPRINT_INCOMPLETE` + the unrun P0 case list when any approved P0 case has no `RunResult` in any run of this sprint. `?force=1` is the operator escape hatch; ProjectSetup surfaces the missing-case preview in a confirm dialog before forcing.
- ✓ **Sprint comparison view** — new `/sprints/compare?a=&b=` page diffs two sprints by per-case outcome (new failures, new passes, still-failing, still-passing, only-in-A, only-in-B). Backed by `GET /api/projects/:p/sprints/compare` which builds the latest-RunResult-per-case map for both sprints.
- ✓ **Carry-forward failures**: `POST /api/projects/:p/sprints/:id/carry-forward-failures` copies the latest failing cases from the most recent completed sprint into this sprint's `SprintTestCase` join. Idempotent (existing rows skipped). Triggered by a "Carry forward failures" button on each sprint card.
- ✓ **Sprint-scoped AI guidance**: new `Sprint.aiGuidance` column, threaded through `promptCompose.joinGuidance` as a third layer between project-wide and per-case guidance. Every Architect / Planner / Conductor / Critic / Supervisor call in a sprint-tagged run sees it.
- ✓ **Sprint health tile on Overview**: pass rate, regressions vs prev sprint, recoveries, days-open / days-to-cut, open blockers, run + case counts. Renders only when a sprint is active. Backed by `GET /api/projects/:p/sprints/:id/health` with a single round-trip.
- ✓ **Planned end date** on Sprint — `expectedEndAt` column drives the "days to cut" indicator on the health tile.

Files touched:
- [prisma/schema.prisma](prisma/schema.prisma) + migration `20260525160000_sprint_guidance_and_endat`
- [server/lib/promptCompose.js](server/lib/promptCompose.js) — `joinGuidance` accepts `sprintGuidance`
- [server/routes/agents.js](server/routes/agents.js) — `loadSprintGuidance` helper + threaded into /start, /execute, /rerun-failed
- [server/routes/sprints.js](server/routes/sprints.js) — lifecycle gate, new fields, carry-forward, health, compare
- [src/pages/ProjectSetup.jsx](src/pages/ProjectSetup.jsx) — `SprintCard` component (guidance, end date, mark-complete, carry-forward, compare)
- [src/pages/Overview.jsx](src/pages/Overview.jsx) — `SprintHealthTile`
- [src/pages/SprintCompare.jsx](src/pages/SprintCompare.jsx) (new) + [src/App.jsx](src/App.jsx) route

See [PHASE_LOG.md](PHASE_LOG.md#phase-b--m6-sprint-enhancements-completed-2026-05-25) for details.

## Phase C — Claude ↔ Gemini auto-failover ⏳ (proposed in Phase A discussion)

Currently the user picks ONE provider per project (Phase A). Failover is
manual: if Claude hits rate-limit mid-run, the run fails — user has to
switch project to Gemini and re-run. Auto-failover would let the run
continue.

**Requirements**:
- Detect 429/rate-limit response, switch provider mid-run.
- Translate any in-flight tool-use history between providers (the canonical
  Anthropic shape from Phase A's provider abstraction already handles this).
- Re-validate each agent prompt against Gemini for output consistency before
  shipping — otherwise mid-run quality drift breaks reports.
- UI: surface the failover as a transparent event in the Theater log
  (`switched to gemini at turn 14 due to claude rate-limit`).

**Pre-requisite**: Phase A is in production and stable on each agent on
both providers.

---

## Handoff notes for the next Claude session

Read these BEFORE touching anything.

### Context preservation
1. **Read [CLAUDE.md](CLAUDE.md) first** — palette tokens, status semantics,
   cancellation pattern, regenerate semantics, project-scoped WS guard. Every
   rule in the `## Do not` section is non-negotiable.
2. **Read [PHASE_LOG.md](PHASE_LOG.md)** to know what was shipped per phase and
   the design decisions baked in.
3. **Glance at [MEMORY.md](../../../../.claude/projects/c--Users-2461908-Downloads-qaai-fixed--2--1-qaai-fixed/memory/MEMORY.md)** — user preference index.

### What's NEW since the original 12-phase plan
- Multi-provider AI (Phase A) — Claude + Gemini both supported. Provider
  is per-project. See [server/lib/llmProvider.js](server/lib/llmProvider.js)
  for the abstraction.
- Conversational RCA + per-test-case guidance (Phase 5.5) — chat about
  specific failures, user guidance honoured by every agent.
- Output file cleanup (Phase A.5) — DELETE project removes disk artifacts;
  OutputFiles filters by project content.
- Robust JSON extraction (Phase A.5) — every agent that parses model JSON
  goes through [server/lib/parseJsonResponse.js](server/lib/parseJsonResponse.js).

### What the user has already decided
- Per-project provider granularity (not per-run, not per-agent).
- Same key-storage pattern for both Claude and Gemini (user-level vault).
- Rate-limit chip hidden on Gemini (no per-request headroom available).
- AI Provider lives on its own settings tab (NOT duplicated on Claude/Gemini
  key pages — that was tested and confused users).
- Sprint isolation path is **NOT yet chosen** — user wanted to think about
  it. Don't pick B1/B2/B3 without explicit confirmation.

### Operational gotchas
- **Windows + Prisma**: stale `node.exe` processes hold a lock on Prisma's
  query-engine DLL. If `npx prisma generate` fails with EPERM, run
  `taskkill /F /IM node.exe` then retry. Don't try to bypass.
- **Path with spaces**: this project sits at
  `c:\Users\2461908\Downloads\qaai_fixed (2) 1\qaai_fixed\qaai_fixed` —
  parens and spaces break some `npm` runs. If `npm install @pkg` fails
  with no clear error, fall back to manual tarball install (see
  `package.json` history for `@google/generative-ai@0.24.1`).
- **dev:full** = nodemon (server) + Vite concurrently. Vite HMR + nodemon
  restart on save are reliable; no need to manually reload.
- **Live test on Windows PowerShell** writes warnings to stderr that
  PowerShell wraps as NativeCommandError. Exit code 0 + warning text =
  success; don't be misled by the error wrapping.

### Pending user actions
None blocking — Phase A and A.5 are fully shipped and runnable on both
providers. The user wants to evaluate sprints next; ask which path (B1/B2/B3)
before writing any code for Phase B.

### Sensitive files NOT in git
- `.env` (JWT_SECRET, vault encryption key)
- `prisma/dev.db` (SQLite — contains encrypted Claude/Gemini keys)
- `playwright/test-results/` (runtime browser artifacts)
- `node_modules/`

If you need to recreate the DB on a clean clone: `npx prisma migrate dev`
will apply all migrations in `prisma/migrations/`. The user must paste
fresh Claude / Gemini keys via Settings since the vault is encrypted with
the local server's key.

---

## Phase D — Conductor reasoning hardening ✓ (2026-05-25)

D1 + D2 + D3 + D4 + D5 all shipped — see [PHASE_LOG.md](PHASE_LOG.md#phase-d--phase-6--m1-honest-runs-work-completed-2026-05-25). Pending exit-criteria smoke: an honest end-to-end run on a login-required site (e.g. practice.expandtesting.com) either succeeds with configured creds or stops cleanly with `BLOCKED: no credentials provided`.

Original Phase D spec is preserved below for historical reference; what landed differs only in that the existing hard-stop at MAX_IDENTICAL_TOOL_CALLS was already present, so D2 added only the soft-warn that fires earlier.

---

## Phase D — Conductor reasoning hardening (original spec, 2026-05-23)

Real failure mode observed on a Gemini run against
`practice.expandtesting.com`. The Conductor (Playwright MCP loop) entered
a loop where it kept submitting login with fabricated credentials, never
read the visible "Incorrect email address or password" banner, never
pivoted to /register, and burned all 4 attempts (including the Supervisor
escalation) without ever realising it had no valid credentials to use.

A first cut already shipped in [server/services/agents/conductor.js](server/services/agents/conductor.js)
`SYSTEM_PROMPT_LOOP` — anti-loop discipline + strict end-of-turn output
format. This Phase D is the deeper structural fix that prompt rules alone
can't enforce.

### What the user said (verbatim, for context)

> "playwright mcp never fails to fetch the right locators but in our
> case it is failing … the real playwright mcp reads the DOM structure
> scans inspect tools and understands the locators, but ours is not
> doing that properly. … if it fails in reading DOM and understand the
> locators then AI continues with guessing the locators and stuck in
> loop, and also this is very critical that AI is not able to
> understand that it is kept on trying with an mail id and password
> that was registered by on its own, if the mcp fails as it takes
> screenshot it should be read by AI what the page is telling to do —
> it actually tells the user how to create the account but it failed to
> read the content in the page and just kept on creating account and
> logging in and the login failed"

### Diagnosis — MCP itself is fine, the agent's *use* of it is broken

QAAI is using the real `@playwright/mcp` subprocess. The agent calls
`browser_snapshot`, `browser_click`, `browser_fill_form`, `browser_navigate`
— all standard MCP tools. The snapshot Playwright MCP returns IS the full
accessibility tree with refs, names, roles. **The locator data is correct
in the response.** What the agent does with it is the issue.

Three concrete failure modes, all agent-side:

1. **Doesn't read error banners.** After a failed submit, the next
   snapshot contains the alert (e.g. `alert "Incorrect email address or
   password" [ref=eN]`). The current loop doesn't pre-process the
   snapshot to surface this. The model glosses past it and tries the
   same inputs again.

2. **No "I've tried this and it failed" memory.** Each turn receives the
   full history, but the agent doesn't reason "I just clicked Login with
   these creds and got 401 — clicking it again will produce the same
   result." No explicit anti-repetition guardrail at the loop level.

3. **Fabricates credentials.** If a case requires "log in as a valid
   user" but no fixture credentials are supplied, the agent invents
   `practice@expandtesting.com / RKT32e92k1` and burns the whole budget
   trying combinations. No "I need credentials and they weren't
   provided → block this case" path exists.

### Proposed fixes — concrete touchpoints

**D1. Pre-action page-state read** (low risk, high impact)
- In `runOneCase` of [server/services/agents/conductor.js](server/services/agents/conductor.js),
  BEFORE each agent turn, walk the latest snapshot for any node with
  `role=alert` / `role=status` / `aria-live` and prepend a synthetic user
  message: `"Page error visible: <text>"`. Forces the model to react.
- New helper: `extractPageErrors(snapshot)` returning `string[]`.

**D2. Action repetition guard** (low risk)
- Maintain `Map<string,count>` keyed on `${tool}:${JSON.stringify(args).slice(0,200)}`
  per case alongside `actionTrail`.
- Before each tool result, append `"You have called this tool with these
  args N time(s) this case. If it failed before, do NOT retry — pivot or
  end the turn."`
- Hard-stop after 3 identical calls: emit `BLOCKED: retry-loop` and break
  the loop server-side without burning more attempts.

**D3. Credential discipline** (medium — touches data model)
- New optional field on `Project` (Prisma): `testCredentials Json?` — a
  list of `{ name, email, password, notes }` the user pastes in Project
  Setup.
- Conductor injects them into the system prompt prefix as
  `## Available test users\n<JSON>`. The prompt explicitly says: "If a
  case requires a logged-in user and none are listed here, end the turn
  with `BLOCKED: no credentials provided` — do NOT register or fabricate."
- UI: small "Test users" editor on Project Setup.

**D4. Critic re-reads the final snapshot** (medium)
- After the conductor loop ends, take ONE more `browser_snapshot` and
  pass it to the Critic alongside the action trail. The Critic verifies
  the agent's self-reported "all assertions verified ✓" against the
  actual page (catches hallucinated success).

**D5. Surface looping in the UI** (low)
- New phase-event variant `agent.phase.warn` with messages like
  "Conductor is repeating browser_click(login) — likely stuck." Surface
  as an amber banner in the Live Pipeline. User can cancel before all
  attempts burn.

### Suggested order

D1 + D2 together — cheap, high leverage. D3 unblocks the credentials
class entirely. D4 makes the Critic catch hallucinated "all passed"
claims. D5 is polish.

### NOT in scope for Phase D

- Switching MCP implementation — the real `@playwright/mcp` is fine.
- Anything Gemini-specific — Claude shows the same failure mode on this
  site, just less often.
- A "smarter locator picker" — locators are correct; agent reasoning is
  what's broken.

### Files Phase D will touch (estimate)

- [server/services/agents/conductor.js](server/services/agents/conductor.js)
  — D1, D2, D5 hooks.
- [server/services/agents/critic.js](server/services/agents/critic.js)
  — D4 (accept final snapshot).
- [prisma/schema.prisma](prisma/schema.prisma) + new migration — D3
  (`Project.testCredentials Json?`).
- [server/routes/projects.js](server/routes/projects.js) — D3 save endpoint.
- [src/pages/ProjectSetup.jsx](src/pages/ProjectSetup.jsx) — D3 UI.
- [src/pages/Theater.jsx](src/pages/Theater.jsx) — D5 banner.

---

## Audit Sweep — IMPROVEMENTS_NEEDED.md execution

Source: [IMPROVEMENTS_NEEDED.md](IMPROVEMENTS_NEEDED.md). Sequenced 2026-05-29
with the structural-fix discipline from
[memory/structural-fixes-over-tactical.md](C:/Users/2461898/.claude/projects/c--Users-2461898-Downloads-qaai-fixed-qaai-fixed/memory/structural-fixes-over-tactical.md):
every PR must encode the generic rule the failure violated, not close the
immediate symptom. The rule sentence is the gate — if it's symptom-specific,
the fix is wrong-shaped.

### Already shipped 2026-05-29 (pre-audit-sweep)

- ✓ Rule 1 — *Every assertion type declares exactly one corpus. No type silently merges corpora.* Encoded in [server/services/mcp.js](server/services/mcp.js) `_checkAssertionOnce`.
- ✓ Rule 2 — *URL/page-state assertions evaluate against a temporal model. Three outcomes: current → matched, visited → transient_window_missed, never → agent_never_reached.* In-loop three-way disambiguation in [mcp.js](server/services/mcp.js) + [postLoopRatify.js](server/services/postLoopRatify.js) + [augmentWithOutcome](server/services/mcp.js).
- ✓ Rule 3 — *Architect-authored `expectedText` must be cited in source documents. Ungrounded text demotes to parseFailed + parseFailedReason='text_ungrounded'; never to fail.* In [architect.js](server/services/agents/architect.js) `markUngroundedText`, plumbed through [declaredAssertions.js](server/lib/declaredAssertions.js) → [postLoopRatify.js](server/services/postLoopRatify.js).
- ✓ Side fix — `normaliseCase` now preserves `declaredAssertions` through normalisation (was silently stripped; only Haiku backfill was filling the DB).
- ✓ UI hardening — Critic auto-flip cleanup on `run.complete`; floating indicator no longer silently no-ops on stale state; per-phase status doesn't blink between cases.

### Pre-step (blocks Batch 4+)

**Replay harness audit.** `scripts/replay/` has stubs (`corpus/`, `runner/`)
+ 4 ad-hoc check scripts hardcoded to specific runIds. CLAUDE.md cites
"replay harness" as the verification gate for cost claims; today it's not
runnable as a system. Three deliverables before Batch 4 starts:
1. Run each existing check script against current fixtures; report
   which still execute vs which broke on hardcoded runIds.
2. Implement `scripts/replay/runner/` — pure-Node CLI taking
   `{candidate, baseline, fixtures, scenario_filter}`, emitting per-scenario
   delta + aggregate. Standardise the 4 existing checks to consume it.
3. Capture the current 16-run / 109-case fixture set as `corpus/baseline/`.

### Batch 1 — Stop-the-bleeding (~1 day, no harness needed)

| Item | Generic rule encoded |
| --- | --- |
| P0-1 | *Verdict-mode observation reads from THAT mode's recording substrate. mechanical_v1 ignores legacy `assertionCheckResults`.* |
| P0-2 | *Org-scoped queries filter on `orgId` only. `userId` is for personal scopes, never within an org branch.* |
| P0-6 | *"Locator-class errors" cover element-found-but-action-failed, not only element-not-found.* |
| P0-12 | *Best-effort KB writes log on failure. Silence is for the operator, never for the engineer.* |
| P0-13 | *`parseFailed` is a boolean — coerce at write site. On invariant trip, persist offending `assertionId` to the row, not just stdout.* |

### Batch 2 — Verdict integrity (~1.5 days, no harness needed)

| Item | Generic rule encoded |
| --- | --- |
| P0-9 | *`Run` counters track every distinct verdict outcome. `needs_human` is a peer of pass/fail/blocked/skipped — own column, own headline card, own filter chip. Secondary compact surfaces MAY visually combine "blocked + needs_human → Other" with hover-tooltip breakdown.* (Decision: own bucket; folding loses the signal the verdict layer was built to expose.) |
| P0-4 | *Inline Critic triggers on negative-correctness signal, not only on tool-shape errors. `assertion_check matched=false` is correctness.* |
| P0-14 | *Architect-emitted URL patterns are validated against their declared `targetUrl` at output time. Unmatchable patterns demote to TEXT-against-landmark or `parseFailed: 'url_ungrounded'`.* (Same shape as Rule 3 already shipped for TEXT.) |

### Batch 3 — Replay harness Stage 2 (~1 day)

See Pre-step above. Build the `runner/`, port the existing checks. Gates all Batch 4 PRs per CLAUDE.md cost-claim discipline.

### Batch 4 — Cost wins (~2 days, harness-gated)

| Item | Generic rule encoded |
| --- | --- |
| P1-1 + P1-2 + P1-4 (bundle) | *Static prefixes of LLM prompts get `cache_control`. The cacheable prefix must be byte-stable across calls — per-call dynamic content lives AFTER the cache boundary.* |
| P1-3 split (per friend's tier-by-entry-point feedback) | *LLM tier matches entry-point job, not the agent module.* `runInlineOnError` stays flagship (strategic reasoning under failure). `runInlinePeriodic` is removed entirely — replaced by deterministic `evaluateAssertionGate` injection (subsumes P2-2). No A/B needed for the periodic branch (deterministic substitution is risk-free); error branch isn't touched. |
| P1-5 | *Snapshot truncation preserves the failure site. Default to last-N bytes, not first-N.* |
| P1-7 | *Per-case static context is per-case cached.* |
| P1-8 | *LLM output budget scales with payload, not a fixed ceiling.* |

### Batch 5 — KB integrity (~2 days)

| Item | Generic rule encoded |
| --- | --- |
| P0-3 | *Concurrent writers to the same KB row use optimistic concurrency. Fire-and-forget paths NEVER mutate selector / strategy — only the synchronous healer does.* (Ship the simple version first; add CAS guard later.) |
| P0-7 | *Failure attribution targets the failing element, not `fields[0]`. Parse Playwright's error for the field name.* |
| P0-8 | *Architect reads from the KB. Quarantined locators are surfaced as "avoid these elements" in the prompt.* (Same pattern Conductor already uses.) |
| P3-4 (per friend's empty-string + ghost-merge plan) | *KB unique constraint includes `pageUrl`. Legacy rows backfill to `''` (NEVER NULL — both SQLite and Postgres treat NULLs as distinct in unique constraints, which would re-permit the duplicates). First real-pageUrl write for an element with a `''` ghost copies heal history into the new row and deletes the ghost. ~10 LOC in `recordSuccessfulLocator`.* |
| P0-5 (optional this batch) | *Locator-failure recovery is MCP-wrapper concern, not Conductor concern.* Defer to Month 2 with the conductor split unless schedule allows. |

### Batch 6 — AI → code (~1 day)

| Item | Generic rule encoded |
| --- | --- |
| P2-1 | *Topological sort is solved code. The Planner LLM call has no novelty.* Replace `planner.js` with Kahn + indegree-wave partition (~60 lines). |
| P2-2 | Subsumed by Batch 4's P1-3 split. |
| P2-3 | *Drift-prone constants live in one file.* Extract `ROLE_ALIASES` to `server/lib/roleAliases.js`. |

### Batch 7 — Refactors (~3 days, after the rest stabilises)

| Item | Generic rule encoded |
| --- | --- |
| P3-1 | *Files own one concern. Conductor's eight concerns become four modules (locatorKB / snapshotScan / persist / promptBuild).* |
| P3-2 | *MCP transport doesn't own synthetic-tool implementation.* Extract `synthetics.js`. |
| P3-3 | Dead-code (`screenshotsByTc`). |

### Architecture-level (tracked, not yet scheduled)

- Calibrator (CC-2) — long-term answer to "Architect designs blind." Today's TEXT cite-or-demote is the cheap interim.
- Stability detector (CC-4) — Phase 2 work, enables `wait_for_stable` synthetic.
- Negative-case KB (CC-5) — AssertionTrap-style schema for Calibrator's grounding pass.

### Discipline gate (apply to every PR in the sweep)

Before opening any PR in this sweep, write one sentence: **"This fix encodes the rule: ____."** If the sentence is symptom-specific ("don't include null in eval cache search"), refactor to the underlying invariant ("type X declares its corpus and never silently merges"). Symptom-fixes ship the next variant of the same bug class next week.

---

## How to consume this file

- **You**: glance at it to see phase status at any time.
- **Me (next session)**: read this first to know what's already done.
- **Both**: source of truth for the multi-phase contract.

---

## Authored-flow and Tests-page step control — complete (2026-07-23)

| Stage | Status | Delivered contract |
| --- | --- | --- |
| 1. Input foundation | Complete | Messy paragraphs, document-derived text, inline data, and exact source are accepted without a mandatory format. |
| 2. Universal interpretation | Complete | Deterministic story/precondition/logical-step/data/assertion interpretation with stable logical and atomic identities. |
| 3. Assisted authoring | Complete | Non-blocking preview, optional QAAI template/convert action, keyword help, and provider-neutral fallback. |
| 4. Step controls | Complete | Inline same-row add/edit/remove/reorder/count/undo; active runs keep their start snapshot and edits apply next run. |
| 5. Adaptive Conductor | Complete | Exact authored text is authoritative; cleaned interpretation and atomic actions are hints; runtime attempts and independent continuation remain in force. |
| 6. Report/export parity | Complete | Logical authored intent groups runtime evidence in Reports; export traceability cannot manufacture executable ReplayIR. |
| 7. Observation and validation | Complete | Old readiness is diagnostic-only for manual edits; focused backend/UI/export tests, production build, diff check, and unauthenticated rendered boundary are green. |

This implementation deliberately does not introduce a user-facing compiler gate.
When interpretation is uncertain, QAAI preserves the requested step, records a
non-blocking diagnostic, and lets the adaptive execution path attempt it against
the live application. Structural conflicts use step hashes and actionable
conflict responses; semantic uncertainty alone does not refuse the save.

---

## Single-controller recovery closure - Phase 28C-D complete (2026-07-24)

| Stage | Status | Delivered contract |
| --- | --- | --- |
| 28C1. Recovery ownership | Complete | BrowserTransactionController invokes evidence-bound, epoch-bound, proposal-only Healer/Critic recovery. |
| 28C2. Utility continuation | Complete | Scroll uses semantic reveal; recoverable errors continue without descendant cancellation or early teardown. |
| 28C3. Recovery proof | Complete | Wrong-target proposals are rejected; recovery mutations use new exactly-once occurrences; original mutations are never repeated. |
| 28D. Offline gates | Complete | 27 controller files and 159 tests pass; production build and static transport-authority checks pass. |
| 28E. Grouped live proof | Complete (2026-08-05) | Grouped S1->S2 run against qa.linx.odysseylogistics.com: S1 22/22 pass, S2 87/87 pass, 0 failed, 0 blocked, after the locator-binding and operationContractV2 fixes below. One clean run recorded; repeating to five consecutive is not yet done. |

Runtime invariant:

```text
Only BrowserTransactionController decides mutation, recovery, continuation,
commit, and verdict. Missing evidence is bounded and recorded; it cannot cancel
later work, repeat a successful mutation, or fabricate a pass.
```

---

## Passive evidence degradation, self-correction budgets, real locator capture - Phase 29-31 (2026-08-05)

| Stage | Status | Delivered contract |
| --- | --- | --- |
| 29.1. Journal/verdict write degradation | Complete | A journal or verdict-repository write failure heartbeats `evidence_write_degraded` / `verdict_persistence_degraded` and falls back to the already-computed decision/projection; it can never flip a verdict. Chaos-covered. |
| 29.2. Per-case exception boundary | Complete | Any unhandled case-level fault marks only that case `blocked` / `controller_internal_error` and the run continues; the DB `Run` row no longer gets stuck at `running`. Genuine cancellation still stops the run cleanly. |
| 29.3. Configurable timing budgets | Complete | `QAAI_OPERATION_TIMING_MULTIPLIER` scales per-operation deadlines/attempts; termination requires genuine exhaustion, not a hardcoded mismatch to a real site's speed. |
| 29.4. Recovery narrative in Reports | Complete | Per-operation `recoveryTrail` persisted from live heartbeats already being emitted. |
| 30.0. Live locator-capture wiring | Complete | `controllerMcpRuntimeAdapter.js` remembers the resolved MCP ref per operation (side-observation only) and exposes `captureVerifiedLocator`, independently re-verifying a real Playwright locator via the previously-orphaned `actionLocatorResolver.captureStructuralLocator`. Bounded timeout, never throws, 5/5 wiring tests green. |
| 30.1-30.2. Evidence persistence | Complete | `executionContractJson` and a new `replayIrJson` (`qaai-controller-replay-v1`) now populate on every `RunResult`, carrying real per-operation target identity and (when independently verified) real Playwright locator expressions. |
| 30.3. Legacy ReplayIR schema bridge | Not started | `_replayContract.js` / `replayEmitter.js` / `playwrightPom.js` expect the OLD conductor's `browser_click`-actionTrail schema (auth/credential/table/download gap taxonomy, `dataRow` binding) — a separate, larger effort than 30.0-30.2. The ZIP-export path (`replayExport.buildReplayExport`) does not yet consume the new envelope. |
| 30.4. Assertion idiom check | Complete | Confirmed (no code change needed) — `playwrightPom.js` already emits proper `expect(locator).toBeVisible()/toHaveText()/toContainText()/toHaveURL()` with soft/hard distinction. |
| 31. Chaos coverage for evidence degradation | Complete | Two new scenarios in `tests/unit/browserTransactionRuntime.test.js`, now part of `verify:controller-cutover` (23/23 gates, 230/230 tests). |
| Live proof | Complete (2026-08-05) | See Phase 28E row above and the follow-on fixes table below — two real defects surfaced only by this live run, both fixed and re-verified live. |

---

## Live-proof follow-on fixes - Phase 28E close-out (2026-08-05)

| Stage | Status | Delivered contract |
| --- | --- | --- |
| Locator-evidence double-wrap | Fixed | `captureVerifiedLocator` was re-wrapping an already-diagnostic-marked object, so `isVerifiedActionLocator()` short-circuited on the stale `diagnosticOnly` flag before ever re-checking the (still-valid) proof. Verified live: 22/22 attempted locators now `verified: true, persistable: true`. |
| Step-edit compile bug (general) | Fixed | `operationContractV2.js#normalizeValue` checked `value` key-presence, not meaningfulness; `testCaseStepMutations.js` always writes `value: null` for non-value action types. Any step edited through the platform's own step-edit feature, for any action type that doesn't take a value, failed to recompile on the next run. Not case-specific — this was a standing landmine for the next edit anyone made. |
| Step-edit metadata leak | Fixed | `projectId`/`applyTo` were leaking into persisted step JSON from `testCases.js#stepInputFromBody`. Excluded alongside the existing meta-key exclusions. |
| Step-edit feature — end-to-end audit | Verified | Exercised the real `PATCH /:tcId/steps/:stepId` route (not the service directly) to correct 6 steps on a live test case; all 6 returned 200 and persisted correctly including nested `operationCheck`. This is the mechanism a user relies on to fix an authored mistake without regenerating the whole case — confirmed working for text/target rewrites on Fill/WaitForState/AssertVisible/Click/AssertText step types. Add/remove/reorder/undo and other action types (Date/DateTime/Select) were not exercised this session. |
| Root cause of the original failing steps | Not a platform defect | Confirmed via live screenshots: the authored "Owning Organization" field is now the "Customer" field on the live app — authored-content drift, not a QAAI resolution bug. The resolver's repeated NOT_FOUND was correct given the real page. |

Not attempted this round (recommended, not silently assumed done): a Playwright-native `ariaSnapshot()` cross-check on captured locators.

---

## Direct live-evidence codegen - real runnable Output Files (2026-08-05)

| Stage | Status | Delivered contract |
| --- | --- | --- |
| Direct generator (`liveReplayCodegen.js`) | Complete | Verified-locator Fill/Click render as real Playwright calls; assertions render via deterministic literal extraction from authored text; composite ops (Select/Date/Time/Expand/Scroll/WaitForState/Navigate) and non-extractable assertions become visible diagnostic comments, never fabricated. `GET /output-files/live-replay.zip?runId=` serves it, additive to the existing legacy routes. |
| Critical fix: stale MCP ref in locator capture | Fixed | Post-case batch capture (Phase 30.0) verified refs long after the page had moved on, silently binding to a LATER page's element (confirmed: an Email field's capture resolved to the post-login dashboard logo). Moved capture to fire immediately on each operation's commit, inside `browserTransactionRuntime.js`'s own loop, while the correct page is still active. Re-verified live twice: locators now resolve to the correct page/element (`#email` on `/auth/email-classifier`, not a dashboard logo). |
| Timing impact | None (faster) | S1 49.7s (was 80.4s), S2 276.6s (was 387.7s) after moving capture to per-commit. Live conductor pace was not degraded by any of this session's changes. |
| replayIrJson field-path bug | Fixed | `verifiedLocator.expression` was nested one level too deep in `projectControllerReplayIr` since Phase 30.2, so `replayIrJson` has carried `expression: null` for every run recorded since. `stepResults` was unaffected — the generator reads from there. |
| Live UI wiring | Complete | Found the actual Output Files page (file tree, viewer, Download ZIP) never called the new generator — it was 100% wired to `replayExport.js`'s 11,445-line legacy pipeline, which is why new-schema runs always showed "zero execution provenance." Added an additive schema-detection branch at the top of `buildReplayExport()`: new-schema runs delegate to `liveReplayCodegen` for the default `playwright-reference` framework (with legacy secret redaction applied to a real leak — literal credentials were being embedded in generated specs); old-schema runs and other frameworks are byte-for-byte unchanged (26/26 existing `replayExport*` tests still pass). |
| Navigate/WaitForState/Scroll rendering | Complete | Renderer-only, no new capture: Navigate uses its own recorded destination URL; WaitForState uses the same snapshot-text-containment signal the controller itself checks (`exactWaitStateReached`); Scroll uses the same label the real reveal function searches for. All traced to real dispatch code, not guessed. |
| Select/Radio option-vs-trigger capture | Complete, live-verified | Root cause: `controllerCompositeExecutor.js` resolved the chosen option correctly then discarded it (`candidate = null`) one line before returning. Fixed by preserving it as `committedCandidate` and threading it into `captureVerifiedLocator`. Live-confirmed on a fresh run: Ship Direction/Freight Term/every Time dropdown now capture the real distinct option (`span[aria-label="Inbound"]`, etc.); Equipment and the two Time Zone dropdowns still resolve back to their trigger for that specific control — real per-control ambiguity, not eliminated by capture alone. Renderer re-enabled with a dedup guard: renders when the locator differs from the immediately preceding click-like locator, else a diagnostic gap with the reason stated. Radio renders unconditionally (`.check()`/`.uncheck()`) — it never goes through the ambiguous composite path. |
| Per-assertion verified locators | Complete, live-verified | `evaluateControllerAssertionSnapshot()` already computed a `candidateRef` for nearly every assertion type — it was being journaled but never persisted. Now captured the same way actions are. Live-confirmed: order case assertions went from 0/27 to 18/27 with a real verifiedLocator. |
| Playwright POM JS/TS Output formats | Complete | Built `buildLiveReplayPackagePom` generator and resolved locators and page object classes dynamically from steps evidence, preserving sequence and precision contracts. Wired all 4 frameworks. Fully verified execution-level runnable status in JS and TS environments end-to-end against the live site, including fixes for dynamic table-row flakiness, type-aware input value checks, and Page Object assertion imports. Passed core exit gates (32 files/230 tests). |
| BDD / Selenium Output formats | Still not started | Non-POM frameworks (BDD, Selenium) remain on the legacy pipeline. |
| Next-required-control navigation-race gap | Found, not fixed | Plain Click buttons that cause an immediate page transition ("Continue button", "Next button") commit via `matched:next-required-control` — the controller proves the click by observing the NEXT page, not the button itself. By the time post-commit capture fires, the button is legitimately gone from the DOM. Needs a capture-timing redesign (dispatch-time, not commit-time), not a quick patch. |
