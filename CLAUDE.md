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
