# CLAUDE.md — QAAI Portal constitution

This file is auto-loaded into every Claude Code session. Read [BUILD_PLAN.md](BUILD_PLAN.md) for phase status and [PHASE_LOG.md](PHASE_LOG.md) for what was built in prior phases.

---

## Product vision

**QAAI Portal — Autonomous Quality Intelligence.** AI-driven QA platform that compresses the time between "requirement landed" and "we can confidently ship" from days to minutes.

**Target user**: QA Lead / SDET at a 50–500 engineer org. Accountable for release confidence, understaffed for the feature volume. Does NOT want a low-code recorder — wants an autonomous agent that reads PRDs and tells them whether the system under test still works.

**The promise**: Upload requirement docs in the morning, get a GO / HOLD / NO_GO release recommendation by lunch.

**Workflow**:
```
Project setup → Upload BRD + Release Notes → AI Architect proposes scenarios → QA approves →
AI Planner builds wave plan → AI Conductor drives a real browser via MCP/Playwright →
AI Critic reviews failures → AI Supervisor rewrites stubborn cases → AI Reporter writes RCA →
Dashboard reads result → AI Release Recommendation: GO / HOLD / NO_GO → optional PR / Jira
```

---

## Architecture

```
Pages (React 19 + Vite)
  └─ Domain hooks (useApiResource + WS subscriptions per domain)
      └─ apiClient.js (HTTP + WS invalidation)
          └─ Express routes (thin: validate, auth, CSRF, delegate)
              └─ Domain services (server/services/* — own DB queries, side-effects, broadcast)
                  └─ Agent layer (architect, planner, conductor, critic, supervisor, analyst, reporter)
                      └─ Prisma + SQLite (dev) / Postgres (prod)
```

Stack: React 19, Vite 6, Tailwind 3 with custom tokens, Express, Prisma 5.22, SQLite, Claude Sonnet 4.6 via `@anthropic-ai/sdk`, MCP for browser control, Playwright for execution, WebSocket per-user channel.

---

## Conventions (do these)

### Colour tokens
Use only the project palette. NEVER raw Tailwind colours.
- `success` (greens) — passed cases, GO recommendation
- `danger` (reds) — failed cases, NO_GO, destructive actions
- `warn` (ambers) — blocked cases, HOLD recommendation, cancelling state
- `info` (blues) — running state, links, neutral highlights
- `accent` (purples) — Knowledge / AI features
- `ink` (greys) — text, borders, neutral chrome

Each palette has shades 50/100/200/.../900.

If you find yourself reaching for `bg-slate-*` or `bg-rose-*`, stop and use the token equivalent.

### Status semantics (post-CRIT-6)
- `TestCase.status` = approval lifecycle ONLY. Values: `pending | approved | rejected | running`.
- `RunResult.status` = execution outcome. Values: `pass | fail | blocked | skipped`.
- `blocked` ≠ `skipped`. `blocked` = environmental failure (agent tried, couldn't reach assertion). `skipped` = `test.skip()` / `--grep` deselection (engineer intentionally excluded). Conflating them mis-leads release decisions.
- To show execution status on a case row: read `case.latestResult?.status`, fall back to `case.status` for approval state.

### Cancellation pattern
- Every long-running AI call MUST accept an `AbortSignal` and pass it to `client.messages.create(..., { signal })`.
- Create the cancel token via `cancelRegistry.create(userId)` BEFORE the first AI call, not after.
- On AbortError, surface as `agent.phase.complete { cancelled: true, error: 'cancelled' }` over WS.
- HTTP response code for cancellation = `499`.
- Clear the registry in a `finally` block.

### Counter integrity
- `Run.passed/failed/blocked/skipped` are denormalised from `RunResult` for fast list rendering.
- NEVER mutate one counter without recomputing all four from `RunResult` rows via `services/runs.js#recomputeRunCounters`.

### Regenerate semantics
- On regenerate (`replace: true`), delete ALL test cases for the project — NOT just `pending+approved`. Status-filtered delete leaves scenario-less orphans that contaminate dashboard counts.
- RunResult cascades automatically via Prisma FK.
- GovernancePR / BlockedItem keep history but `testCaseId` becomes NULL via SetNull FK.

### Project-scoped WebSocket
- Every WS message that carries `projectId` MUST be guarded in the subscriber: `if (msg.projectId && current?.id && msg.projectId !== current.id) return;`.
- Otherwise concurrent runs in different projects cross-contaminate UI state.

### Inline phase banners over floating widgets
- The page that owns an action (Test Cases for architect/analyst, Theater for conductor) MUST surface phase progress inline via its own banner — not via the global `AgentRunningIndicator`.
- The global indicator hides itself on pages that own the phase (route + phase check). Across-page persistence is the indicator's only job.
- Pattern: `useRunStream().subscribe` + project-scope guard + state machine `idle → running → complete | cancelled | error`. See `ArchitectBanner` in [src/pages/RunSuite.jsx](src/pages/RunSuite.jsx) for the reference shape.

### Self-healing locators (E1)
- Every successful `mcp.callTool` in the Conductor MUST upsert the resolved selector + accessible name + role + page URL into `KnowledgeBaseLocator` (idempotent on `(projectId, element)`). This is how the next sprint runs faster than the first — see [server/services/agents/conductor.js](server/services/agents/conductor.js) `recordSuccessfulLocator`.
- Locator failures trigger the healer (`server/services/agents/healer.js`) BEFORE Claude sees the error. Claude continues as if the tool succeeded — less context churn, fewer tokens.
- A locator with `healthScore < 30` is quarantined: Conductor refuses to use it and emits a `BlockedItem` of category `selector_drift`.
- Conductor's per-case system prompt prepends `## Known locators on this site` from the project's KB (top 50 by `(healthScore desc, occurrences desc)`). Quarantined rows are excluded.

### Assertion check before pass (E2)
- Conductor MUST call the `assertion_check` synthetic tool for each declared assertion before emitting `RESULT: pass`. The tool fabricates its response from `mcp.getLastSnapshot()` — no real MCP roundtrip, no Claude call.
- Any `matched: false` flips the case to `fail`. The inline Critic can also emit `abort_pass_claim` mid-loop to force re-verification.

### Model routing (E5)
- Agents declare their tier via `const TIER = 'mid'` (else flagship is implied) and call `resolveModelForTier({ provider, requestedModel, tier })` from [server/lib/modelRouter.js](server/lib/modelRouter.js) inside their `run()`.
- Mid-tier ALWAYS routes to Haiku 4.5 / Gemini 2.5 Flash regardless of the project's Settings choice — BYOK cost savings. Do not add per-project override UI without an explicit user decision.
- High-stakes agents (Architect, Planner, Conductor, Critic, Supervisor, VisualCritic) stay flagship and DO respect Settings.

### Lint pipeline (E6)
- `server/services/lintGates.js` runs BOTH the regex pipeline AND `server/lib/specAst.js` (Babel-AST-based). AST findings are tagged `engine: 'ast'`. An AST parse error falls back to regex-only gracefully — don't throw.
- New AST rules go in `specAst.js`; new regex rules in `lintGates.js`. The two are independent.
- Six AST rules ship today: missing-await-on-locator, assertion-without-expect-per-test, screenshot-on-failure-missing, brittle-locator-css-with-dynamic-class, unused-page-locator, low-assertion-density (≥4 user interactions + ≤1 expect → warn).

### Multi-tenancy / org scoping (E8)
- Every project-scoped router MUST mount `router.use(requireOrg)` AFTER `router.use(requireAuth)`. Project queries filter by `orgId: req.org.id`, NOT by `userId` — sharing a project across an org breaks otherwise.
- Prisma queries are explicit (no extension magic): `where: { id: projectId, orgId: req.org.id }`. The forged-URL isolation guarantee is verified by [server/scripts/smoke-org-isolation.js](server/scripts/smoke-org-isolation.js).
- `req.org = { id, name, slug, role }` — role is `owner` | `admin` | `member` in THIS org. Destructive endpoints use `requireOrgRole('owner', 'admin')`.
- Signup auto-creates a Solo org with the new user as owner and pins `User.currentOrgId`. Existing single-tenant data was backfilled by migration `20260527180000_orgs_substrate`.

### Provider wrapper — breaker + budget (E10)
- All `provider.complete()` calls go through `server/lib/llmProvider.js` which wraps in: (1) circuit breaker — fail-fast on sustained upstream 5xx/network errors; (2) per-user daily token budget — block when over ceiling, record usage on success.
- User context (`userId`, `orgId`) reaches the wrapper via `server/lib/userContext.js` AsyncLocalStorage — opened by `requireAuth`, populated with `orgId` by `requireOrg`. Agents DO NOT need a `userId` parameter; ALS handles it.
- Background scripts (smoke tests, reaper, manual cron) get `userId = null` and bypass budget enforcement intentionally — operator-initiated, not billable.
- `getRawProvider()` exists for connection-test routes that should fail through the breaker/budget. Use sparingly.
- Breaker classification: 5xx / 503 / network → trip. 4xx / 429 / 499 (cancelled) / NO_API_KEY → do not trip.

### Browser context + downloads (E10.5)
- Per-project browser-context config lives on `Project` (contextViewport, contextDevice, contextLocale, contextUserAgent, contextColorScheme, contextPermissions, contextGeolocation, contextHttpCredentials, contextExtraHeaders, contextIgnoreHttpsErrors, contextProxyServer, contextProxyBypass, autoAcceptDialogs). `mcp.startMcpSession({ project })` reads them via `server/services/mcpContextConfig.js` → translates to CLI flags + a per-session init-script that shims locale / geo / color-scheme / fetch headers / Basic auth / dialog handler.
- `autoAcceptDialogs` defaults to TRUE — the init-script overrides window.alert/confirm/prompt so the agent never hangs on an unexpected popup. Set false ONLY when a test explicitly validates dialog copy.
- Every MCP session gets a per-session `downloadsDir` under `playwright/test-results/downloads/<sessionId>/`. `server/services/downloadWatcher.js` polls it at 1.5s, records each stable file to the `Download` table, and back-fills `runResultId` after each case via `attributeRecentDownloads`. The Conductor calls `downloadWatcher.setCaseStart(session)` at the top of each case so the window is tight.
- `assertion_check` MCP tool accepts `expectedDownload: { filenamePattern, minSize, mimeType }` — verifies against the captured Download rows for the active RunResult. Use this instead of "I clicked the link, must have worked".
- Conductor SYSTEM_PROMPT_LOOP includes a "Tricky-page playbook" block covering iframes, shadow DOM, unexpected modals, downloads, AJAX timing, geolocation, basic auth, and dialogs. Read it before adding new prompt scaffolding for these scenarios.

---

## Do not

- `window.confirm()` / `window.alert()` — use the `<ConfirmDialog>` + `useConfirm()` hook.
- Mock the database in tests — integration tests hit the real SQLite. Reason: prior incident where mock/prod divergence masked a broken migration.
- Hardcode counts, durations, or status labels. Everything must derive from current API state — no fallback "4 passed" sprinkled in.
- Bypass git hooks (`--no-verify`) or skip prisma migrate steps.
- Read `Run.passed` directly when the source of truth for current pass/fail is `RunResult`.
- Create destructive migrations without backfill + recompute steps.
- Use `bg-slate-*`, `bg-rose-*`, `bg-emerald-*`, `bg-amber-*`, `bg-sky-*`, `bg-violet-*` — use tokens.
- Ship placeholder UI. Every button must do something real or be hidden until it can.

---

## Phase protocol

When starting a new phase:

1. Read **BUILD_PLAN.md** — confirm which phase is next and what its scope is.
2. Read **PHASE_LOG.md** — last 2-3 entries, to know what was already shipped.
3. Read **MEMORY.md** index — pick up any cross-session preferences.
4. State (out loud, in chat): "Phase N. Last phase delivered X. Current state Y. I will build Z."
5. Plan the phase: list files to touch, decisions to make. Wait for user confirmation if auto mode is off.
6. Build, marking todos as you go.
7. Verify: `npx vite build`, `node --check` on touched server files, manual smoke of the affected pages.
8. Append a new section to **PHASE_LOG.md** with: scope / built / decisions / open items / files touched / verification.
9. Update **BUILD_PLAN.md** — mark this phase ✓ done.
10. If you made an architectural decision worth keeping forever, update CLAUDE.md.
11. Stop. Ask user before moving to next phase.

---

## Key file map

| Concern | File |
|---|---|
| Frontend routing | [src/App.jsx](src/App.jsx) |
| Auth + WS context | [src/store/auth.jsx](src/store/auth.jsx), [src/store/runStream.jsx](src/store/runStream.jsx) |
| Project state | [src/store/project.jsx](src/store/project.jsx) |
| API client | [src/lib/apiClient.js](src/lib/apiClient.js) |
| Reusable hook | [src/lib/useApiResource.js](src/lib/useApiResource.js) |
| Status maps | [src/lib/statusMeta.js](src/lib/statusMeta.js) |
| Confirm dialog | [src/components/ui/ConfirmDialog.jsx](src/components/ui/ConfirmDialog.jsx), [src/lib/useConfirm.jsx](src/lib/useConfirm.jsx) |
| Server entry | [server/index.js](server/index.js) |
| Cancel registry | [server/services/cancelRegistry.js](server/services/cancelRegistry.js) |
| MCP sessions | [server/services/sessionRegistry.js](server/services/sessionRegistry.js) |
| Run counters | [server/services/runs.js](server/services/runs.js) |
| Agent prompts | [server/services/agents/*.js](server/services/agents/) |
| Prisma schema | [prisma/schema.prisma](prisma/schema.prisma) |
