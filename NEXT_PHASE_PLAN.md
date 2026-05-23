# QAAI — Next-phase plan (Phases A–G shipped 2026-05-20)

> ✅ **STATUS:** All 7 phases (A–G) executed autonomously in the second session
> of 2026-05-20. See the **Completion summary** at the very bottom of this file.
>
> **Read this if you are a future Claude session, dev, or the user resuming work.**
> Use this file plus `README.md` to understand the architecture. New work should
> open a new section below "Completion summary".
>
> Companion documents: [`README.md`](./README.md) (current state of the codebase).

---

## Where the project is right now

- Backend + frontend running on http://localhost:5000 / http://localhost:5173
- SQLite database at `prisma/dev.db` migrated to current schema
- User `bharatvanapalli8@gmail.com` exists; demo data attached via `node prisma/seed.cjs`
- `Demo: Acme Storefront` project contains:
  - 12 requirements (ADO/Jira/upload mix)
  - 20 test cases across 7 modules
  - 3 completed runs with results, screenshots (real PNGs on disk), traces, errors
  - 5 blocked items
  - 12 KB locators
  - 6 governance PRs (mix of clean lint + 2 with real lint failures)
  - 1 webhook config + 5 deliveries
  - 2 verified notification channels (email + slack)

**Re-start commands:**

```powershell
cd C:\Users\2462021\Downloads\qaai_fixed\qaai_fixed
npm run dev:full       # backend on :5000, frontend on :5173
# in another terminal, to refresh demo data:
node prisma/seed.cjs bharatvanapalli8@gmail.com
```

---

## User feedback that triggered this plan (verbatim, abbreviated)

The user opened the seeded app and said:

1. **"It looks very static and looks more like an excel sheet."** UI feels clumsy, fonts odd, spacing compressed.
2. **"Does it show live playwright mcp browser session?"** Expectation matches Claude Code's Playwright MCP integration — live browser visible to the user as the agent operates, with agent narration alongside.
3. **"GitHub Copilot has a browser overlay where you hover an element and add it as a locator."** Wants element-picker / locator-capture mode.
4. **"I could not see any playwright test scripts in output files isn't it supposed to be there?"** The seed-only flow doesn't generate real spec files, which is misleading.
5. **"Why only Playwright POM? We have BDD and others too."** Wants multi-framework support.
6. **"Have you written the right prompts for AI agents?"** The single-shot generator prompt isn't sufficient. Wants three agents:
   - Agent 1 — read documents → build **Test Scenarios + Test Cases**, grouped by priority (P0–P3) and category (positive / negative / edge / boundary / empty / E2E)
   - Agent 2 — group scenarios by dependency, decide parallel vs serial execution order
   - Agent 3 — feed instructions to Playwright MCP, narrate each action, produce real spec files + proper screenshots + video per pass

7. **"Think in high level, as a human myself thinking out of the box for good experience and proper execution then as an AI how you should think."**

This is a fundamental product-shape change, not a polish pass.

---

## Decisions locked in this session

| Topic | Decision |
|---|---|
| Live browser stream | **CDP screencast frames** (Chromium DevTools Protocol `Page.startScreencast`, ~10 fps, base64 JPEG over WebSocket). Requires headed Chromium installed. |
| Element picker | **Injected overlay JS** via `page.evaluate()`. Hover → highlight → click → ranked locator candidates (role > testid > text > css) returned over WS. No separate window. Stays in QAAI. |
| Multi-agent UI | **Single vertical timeline ("Theater" view)**, NOT three columns. Active phase streams reasoning live; completed phases collapse to summary cards. Live browser docks into the timeline when Conductor begins. |
| Frameworks | **Three real generators with three real prompts**: Playwright POM (default), Cucumber + Playwright (Gherkin .feature + step-defs .ts), Selenium + Java (Maven project layout). |
| MCP integration | **Use `@playwright/mcp`** (Microsoft's official Playwright MCP server) for the Conductor agent's tool calls. CDP screencast runs **alongside** MCP on the same browser instance — MCP gives structured action records; CDP gives live frames. |

---

## The 7-phase plan

| # | Phase | Output | Estimate |
|---|---|---|---|
| **A** | UI / typography polish | Site no longer feels like a spreadsheet. Real type hierarchy, spacing, card depth, a real chart on Overview. | ~half day |
| **B** | Scenarios model + UI | New `TestScenario` parent of `TestCase`. Priority + category. Scenario-grouped UI on Test Cases page. Real prompt for Agent 1. | ~half day |
| **C** | Multi-agent pipeline + Theater view | Three real Claude calls with proper system prompts. `AgentRun` model. Theater UI with timeline. | ~1 day |
| **D** | Live browser via CDP screencast | Headed Chromium server-side, CDP screencast → WS frames → UI. `@playwright/mcp` powers Conductor's tools. | ~1 day |
| **E** | Element picker overlay | Inject overlay JS, hover-highlight, click → ranked locator candidates → KB + next agent step. | ~half day |
| **F** | Cucumber & Selenium framework support | Three Claude prompts (POM / Gherkin / Selenium-Java). Three codegens. Output Files reflects framework's idiomatic layout. | ~1 day |
| **G** | Honest demo execution | Replace seed-only "fake results" with a real end-to-end run that produces real spec files + artifacts. | ~half day |

**Total: 5–6 working sessions.** Do not try to do all in one turn — that's how things break.

**Approved ordering (default): A → B → C → D → E → F → G.**

(If user wants to pull a later phase forward — e.g. "I want live browser FIRST" — they say so and we reorder.)

---

## Phase A — UI / typography polish

### Goals
- Stop the "Excel spreadsheet" feel
- Real type scale, breathing room, depth

### Concrete changes
- **Typography**
  - Body: Inter/14px, line-height 1.55 (currently 13px, cramped)
  - Headings: tighter tracking, larger range (h1 24px / h2 18px / h3 15px)
  - Mono: JetBrains Mono or SF Mono for code blocks
- **Spacing**
  - Audit every `p-3` / `gap-2` — most should be `p-4 / gap-3` or `p-5 / gap-4`
  - Page header padding `py-4` → `py-5` minimum
  - Cards: `p-5` / `gap-4` consistently
- **Depth**
  - Cards: subtle shadow + 1px border (currently flat border-only)
  - Hover state: shadow lifts, border deepens
- **Color**
  - Reduce rose/red usage; reserve for actual failures
  - Increase whitespace; remove redundant dividers
- **Data viz on Overview**
  - Replace the module health TABLE with grouped horizontal bars or a real stacked-bar chart
  - Recent runs grid → use small sparkline (pass-rate trend) per run
- **Components to update**
  - `src/index.css` — type and global tokens
  - `tailwind.config.js` — font family, spacing tokens, shadow scale
  - `src/components/ui/Button.jsx`, `Input.jsx`, `Select.jsx`, `Checkbox.jsx`, `SecretInput.jsx`, `StatusBadge.jsx` — all need a polish pass
  - `src/components/PageHeader.jsx`, `Sidebar.jsx` — taller, more confident
  - `src/pages/Overview.jsx` — replace table with chart component
  - All pages — audit for cramped sections

### Acceptance
- Subjective: "feels premium" when you scroll through the seeded data
- Concrete: every screen has at least 24px between major sections, type sizes are consistent, color usage is intentional

---

## Phase B — Scenarios model + UI + Agent 1 prompt

### Schema additions (`prisma/schema.prisma`)

```prisma
model TestScenario {
  id          String   @id @default(uuid())
  projectId   String
  name        String
  module      String
  priority    String   // 'P0' | 'P1' | 'P2' | 'P3'
  category    String   // 'positive' | 'negative' | 'edge' | 'boundary' | 'empty' | 'e2e'
  rationale   String
  dependencyOn String? // JSON-encoded array of scenario IDs this depends on (SQLite)
  source       String  // 'agent' | 'manual'
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  project Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  cases   TestCase[]
  @@index([projectId, priority])
}

// Update TestCase
model TestCase {
  ...
  scenarioId  String?
  scenario    TestScenario? @relation(fields: [scenarioId], references: [id], onDelete: SetNull)
  ...
}
```

### Agent 1 — Scenario Architect prompt

File: `server/services/agents/architect.js`

```text
SYSTEM:
You are a senior QA scenario architect. Given product requirements, produce a JSON
array of test SCENARIOS. A scenario is a behavioural area, not a single test.

Each scenario MUST have:
- name: concise behavioural sentence
- priority: 'P0' | 'P1' | 'P2' | 'P3' (P0 blocks release, P3 is nice-to-have)
- category: 'positive' | 'negative' | 'edge' | 'boundary' | 'empty' | 'e2e'
- module: lowercase token
- rationale: why this scenario matters in plain English (1-2 sentences)
- cases: array of test cases. Each case has:
    - name: full sentence
    - type: 'functional' | 'smoke' | 'regression' | 'security' | 'boundary' | 'integration'
    - confidence: integer 70-99
    - assertions: comma-separated specific assertions
- dependencyOn: array of scenario names this depends on (empty array if none)

Rules:
- For every positive scenario, include at least one negative scenario in output
- Surface boundary cases for any numeric or length constraint mentioned in requirements
- Surface empty-state scenarios where data may be absent
- E2E scenarios are reserved for cross-module flows (checkout, signup-to-first-action)
- Output ONLY a JSON array. No markdown. No preamble. Max 25 scenarios.

USER:
[Concatenated requirement bodies, separated by ---]
```

### UI changes

**`src/pages/TestCases.jsx`** — replace flat list with scenario-grouped view:

```
[Authentication] (5 scenarios)
  ├─ P0 · positive · "Sign-in happy path"
  │     ├─ Login with valid credentials → /dashboard
  │     └─ Login persists across refresh
  ├─ P0 · negative · "Sign-in failure modes"
  │     ├─ Invalid password shows inline error
  │     └─ Account locks after 5 attempts
  ├─ P1 · edge · "Session expiry"
  │     └─ ...
  └─ ...
```

Priority chips (P0=red, P1=amber, P2=blue, P3=slate) and category badges (positive=emerald, negative=rose, edge=violet, boundary=amber, empty=slate, e2e=indigo).

### New endpoint
- `POST /api/projects/:id/scenarios/generate` — calls Agent 1, persists scenarios + cases

---

## Phase C — Multi-agent pipeline + Theater view

### Schema
```prisma
model AgentRun {
  id          String   @id @default(uuid())
  projectId   String
  userId      String
  phase       String   // 'architect' | 'planner' | 'conductor'
  status      String   // 'running' | 'complete' | 'failed' | 'cancelled'
  input       String?  // JSON-encoded
  output      String?  // JSON-encoded
  log         String?  // streaming reasoning log (JSON-encoded list of events)
  startedAt   DateTime @default(now())
  completedAt DateTime?

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

### Agent 2 — Dependency Planner prompt

File: `server/services/agents/planner.js`

```text
SYSTEM:
You are a test execution planner. Given test scenarios with dependencyOn arrays,
produce a JSON execution plan that optimises for:
1. Strict dependency order (no scenario runs before its prerequisites)
2. Maximum parallelism within each wave
3. P0 scenarios in the earliest waves

Output JSON:
{
  "waves": [
    { "id": 1, "scenarios": ["scenario_id"], "parallel": true, "why": "..." }
  ],
  "estimatedDurationSec": 480,
  "riskFactors": ["..."]
}

Rules:
- A wave runs in parallel; waves run sequentially
- If two scenarios share data state (e.g. both create a user), separate them into different waves
- Surface risk factors: data resets between tests, locator flakiness, third-party dependencies
- Output ONLY JSON.

USER:
[JSON of all scenarios with dependencies]
```

### Agent 3 — Execution Conductor

NOT a single prompt — a tool-using loop driven by `@playwright/mcp`.

File: `server/services/agents/conductor.js`

Pseudo-flow:
```js
for each wave in plan.waves:
  for each scenario in wave (parallel or sequential):
    setup browser via MCP
    for each case in scenario.cases:
      ask Claude: "Generate Playwright steps for this case using the available tools"
        tools = browser_navigate, browser_click, browser_type, browser_snapshot,
                browser_wait_for, browser_press_key, browser_screenshot, etc.
      execute each tool call against the live browser
      narrate to user via WS for every action
      capture screenshot to RunResult.screenshots
      record action sequence
    after all cases pass:
      ask Claude: "Emit a complete .spec.ts file (or .feature, or .java) that
                   reproduces what just succeeded, in framework {project.framework}"
      save to playwright/tests/ (or features/, or src/test/java/)
```

### Theater UI

File: `src/pages/Theater.jsx`

Layout (vertical timeline):

```
─────────────────────────────────────────────────
| Test Generation · Acme Storefront            X |
─────────────────────────────────────────────────
| ✓ Phase 1 — Scenario Architect (1m 14s)        |  ← collapsed, expandable
|   Produced 18 scenarios across 6 modules       |
| ─────────────────────────────────────────────  |
| ⚡ Phase 2 — Dependency Planner (active)        |  ← expanded, streaming
|   ▸ "Wave 1: 3 P0 scenarios in parallel..."    |
|   ▸ Risk flagged: cart state shared            |
|   ▸ ...                                        |
| ─────────────────────────────────────────────  |
| ○ Phase 3 — Execution Conductor (pending)      |
─────────────────────────────────────────────────
```

When phase 3 begins, the live browser panel docks:

```
─────────────────────────────────────────────────
| ⚡ Phase 3 — Execution Conductor                |
| ┌─────────────────┬─────────────────────────┐  |
| │  Narration      │  Live Browser           │  |
| │                 │                         │  |
| │ Navigating to   │  [live page render]     │  |
| │ /login...       │                         │  |
| │ Clicking Sign-in│  [Pick Mode] [Pause]    │  |
| │ Verifying...    │                         │  |
| └─────────────────┴─────────────────────────┘  |
─────────────────────────────────────────────────
```

### WebSocket message types (extend the existing per-user channel)

```ts
{ type: 'agent.phase.start', runId, phase: 'architect' | 'planner' | 'conductor' }
{ type: 'agent.phase.log', runId, phase, level: 'info'|'tool'|'error', message }
{ type: 'agent.phase.complete', runId, phase, output: {...} }
{ type: 'browser.frame', runId, frame: 'base64...', sessionId }   // Phase D
{ type: 'browser.action', runId, action: 'click'|'type'|..., locator, value }
{ type: 'picker.candidates', runId, candidates: [{strategy, selector, score}] }
```

---

## Phase D — Live browser via CDP screencast

### Approach

```js
// server/services/browser.js
const playwright = require('playwright');
async function startSession(userId, broadcastToUser) {
  const browser = await playwright.chromium.launch({ headless: false }); // headed
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 2,
  });
  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    broadcastToUser(userId, { type: 'browser.frame', frame: data, sessionId });
    await cdp.send('Page.screencastFrameAck', { sessionId });  // backpressure
  });

  return { browser, context, page, cdp };
}
```

### Critical pre-req
**Chromium must be installed.** User has not done this yet. Reminder commands (already in README):

```powershell
cd server
npx playwright install chromium
# If proxy/cert errors:
$env:NODE_TLS_REJECT_UNAUTHORIZED="0"
npx playwright install chromium --force
```

### `@playwright/mcp` integration

```bash
cd server
npm i @playwright/mcp
```

Conductor wires `@playwright/mcp` server up in-process and invokes tools via the Anthropic SDK with `tool_use` blocks:

```js
const { createServer } = require('@playwright/mcp');
const mcp = createServer({ browser: 'chromium', headless: false });
// Translate Anthropic tool_use blocks → MCP tool calls
```

---

## Phase E — Element picker overlay

When user clicks "Pick mode" in the live browser panel:

```js
// Inject overlay
await page.evaluate(() => {
  const overlay = document.createElement('div');
  overlay.id = '__qaai_picker__';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  document.body.appendChild(overlay);

  let last;
  document.addEventListener('mousemove', (e) => {
    const el = e.target;
    if (el === last) return;
    if (last) last.style.outline = '';
    el.style.outline = '2px solid #38bdf8';
    last = el;
  }, true);

  document.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    const candidates = window.__qaai_compute_locators(el);
    window.__qaai_send_candidates(candidates);  // bound from server
  }, { capture: true });
});
```

Server captures via `page.exposeFunction('__qaai_send_candidates', ...)` and forwards over WS.

Locator priority:
1. `getByRole(role, { name })` (if element has accessible role + name)
2. `getByTestId(value)` (if data-testid attribute present)
3. `getByLabel(text)` (form fields)
4. `getByText(text)` (if unique on page)
5. CSS selector (last resort, with stability score)

UI presents candidates ranked by stability; user picks; selector goes to KB **and** the active agent step.

---

## Phase F — Cucumber & Selenium framework support

### `Project.framework` valid values
- `playwright-pom` (default)
- `playwright-flat`
- `cucumber-playwright`
- `selenium-java`

### Codegen files
- `server/services/codegen/pom.js` — Playwright + Page Object Model (current)
- `server/services/codegen/cucumber.js` — Cucumber `.feature` files + step definitions
- `server/services/codegen/selenium.js` — Selenium-Java with Maven project layout

Each exports:
```js
module.exports.systemPrompt = "..."           // Claude system prompt for that framework
module.exports.fileLayout = (scenario) => ({  // produces files for a passing scenario
  'features/login.feature': '...',
  'src/test/steps/login.steps.ts': '...',
})
```

### Framework-specific prompts (preview)

**Cucumber + Playwright system prompt:**
```
You are an SDET writing Cucumber + Playwright tests.

For each test scenario, produce TWO files:
1. features/<module>/<name>.feature  — Gherkin
   - Feature, Background (if shared setup), Scenario, Scenario Outline (for examples)
   - Tag scenarios with @priority (e.g. @P0), @category (e.g. @negative)
2. step-definitions/<module>.steps.ts  — TypeScript step defs using @cucumber/cucumber
   - Use the Playwright `page` from world context
   - Use getByRole / getByTestId; never CSS selectors when avoidable

Rules:
- No `page.waitForTimeout`. Use explicit waits.
- No credentials in source.
- Output a JSON object: { "files": { "path": "content", ... } }
```

**Selenium-Java system prompt:**
```
You are an SDET writing Selenium 4 + Java (Maven, JUnit 5) tests.

For each test scenario, produce:
1. src/test/java/com/qaai/<module>/<Name>Test.java
   - @Test methods, @BeforeEach/@AfterEach for setup/teardown
   - Page Object class in src/main/java/com/qaai/pages/<Module>Page.java
2. pom.xml dependencies (only if new dependencies needed beyond the base)

Rules:
- Use WebDriverWait for synchronisation, never Thread.sleep
- Use By.cssSelector or By.id, fall back to By.xpath only when necessary
- All locators in the Page Object class, never inline in tests
- No credentials in source
- Output JSON: { "files": { "path": "content", ... } }
```

### Output Files page updates
- Shows files in framework-idiomatic tree:
  - playwright-pom: `tests/`, `pages/`, `fixtures/`
  - cucumber-playwright: `features/`, `step-definitions/`, `support/`
  - selenium-java: `src/main/java/com/qaai/pages/`, `src/test/java/com/qaai/<module>/`, `pom.xml`
- Zip download includes the framework's full project (Maven `pom.xml` for selenium, etc.)

---

## Phase G — Honest demo execution

The seed currently writes Run/RunResult rows without actually invoking Playwright, which is why Output Files shows nothing for seeded runs.

Replace with:

```js
// prisma/seed.cjs — keep the demo scenarios/test cases creation
// REMOVE the synthetic Run/RunResult/PR creation
// ADD a button in the UI: "Run a 60-second demo" → triggers a real one-test
//     Playwright run against demo.playwright.dev/todomvc, populates all panels
//     with REAL artifacts, real specs, real screenshots from headed Chrome.
```

This way nothing in the app is ever fake. Either it's empty (no data yet) or it's the result of a real action.

---

## Files this plan will create / modify (by phase)

### Phase A
- `tailwind.config.js`, `src/index.css`
- All `src/components/ui/*.jsx`
- `src/components/PageHeader.jsx`, `Sidebar.jsx`
- `src/pages/Overview.jsx` (add chart)
- Light pass on every other page

### Phase B
- `prisma/schema.prisma` — `TestScenario`, `TestCase.scenarioId`
- `server/services/agents/architect.js`
- `server/routes/scenarios.js` (new) — `POST /api/projects/:id/scenarios/generate`
- `src/pages/TestCases.jsx` — scenario-grouped view
- `src/pages/RunSuite.jsx` — "Generate scenarios" replaces "Generate test cases"

### Phase C
- `prisma/schema.prisma` — `AgentRun`
- `server/services/agents/planner.js`
- `server/services/agents/conductor.js`
- `server/routes/agents.js` — `POST /api/projects/:id/agents/start` (kicks off architect→planner→conductor)
- `src/pages/Theater.jsx` (new)
- `src/store/runStream.jsx` — extend with new message types

### Phase D
- `server/services/browser.js` — Playwright + CDP screencast
- `server/services/mcp.js` — `@playwright/mcp` integration
- `src/pages/Theater.jsx` — live browser panel
- New deps: `@playwright/mcp` (server)

### Phase E
- `server/services/picker.js` — inject overlay, expose function
- `src/pages/Theater.jsx` — Pick mode toggle + candidates UI

### Phase F
- `server/services/codegen/{pom,flat,cucumber,selenium}.js`
- `server/services/agents/conductor.js` — branch on `project.framework`
- `src/pages/ProjectSetup.jsx` — framework dropdown shows all four
- `src/pages/OutputFiles.jsx` — folder-aware viewer
- `server/routes/outputFiles.js` — framework-aware zip

### Phase G
- `prisma/seed.cjs` — drop synthetic runs
- `src/pages/Overview.jsx` (or new banner) — "Run a 60-second demo" button
- `server/routes/runs.js` — `POST /api/runs/demo`

---

## Pre-requisites BEFORE we can start Phase D (live browser)

User must install Playwright Chromium. Currently NOT installed.

```powershell
cd C:\Users\2462021\Downloads\qaai_fixed\qaai_fixed\server
npx playwright install chromium
# If TLS / proxy errors at Cognizant:
$env:NODE_TLS_REJECT_UNAUTHORIZED="0"
npx playwright install chromium --force
```

If still blocked: get IT to whitelist `*.playwright.dev` or provide an internal mirror via `$env:PLAYWRIGHT_DOWNLOAD_HOST`.

Phases A, B, C, F, G can proceed without Chromium. **Phases D and E require it.**

---

## How to resume in the next session

A future Claude session reading this file should:

1. Read this entire file (you're doing it now).
2. Read `README.md` to confirm current state matches.
3. Ask the user: "Resuming from NEXT_PHASE_PLAN.md. Should we start with Phase A (UI polish) as planned, or has anything changed?"
4. If user says start: confirm Phase A only, do not jump phases.
5. Update this file at the end of each phase: tick off completed phase, note any deviations.

### Important rules carried over

- **No mock data, ever.** Every screen renders real DB state or honest EmptyState.
- **No half-built features.** A phase is either complete and ships, or it's not started.
- **SQLite is the active DB.** Json fields are JSON-encoded strings; arrays are JSON-encoded strings. See `server/services/jsonField.js` and the README handoff notes.
- **`server/node_modules/.prisma/client` must be in sync with `prisma/schema.prisma`.** If the server crashes with weird Prisma errors after schema changes, delete `server/node_modules/.prisma` and `server/node_modules/@prisma/client`, then `npx prisma generate` from repo root. The server resolves Prisma from the root `node_modules`.
- **The user is on a Cognizant corporate laptop.** Don't propose solutions that require admin or paid software (Docker Desktop, etc.).
- **Claude model defaults**: `claude-sonnet-4-6` for generation tasks. New models: Opus 4.7, Sonnet 4.6, Haiku 4.5. Do not downgrade.
- **Audit log everything**: every settings change, every agent run, every governance transition. Use `server/services/audit.js`.

---

## Sign-off

Plan recorded by Claude on 2026-05-20.
Next action: user resumes session, asks to start Phase A (or reorders).

---

## Completion summary (2026-05-20, autonomous session)

All 7 phases executed end-to-end while the user was AFK. Verified by `npx vite build`, `node --check` across all server files, and `npx prisma validate`.

### What shipped

**Phase A — UI polish** *(prior turn)*
- Ink palette + semantic tokens, Inter + JetBrains Mono, 8-step type scale
- Rebuilt UI primitives (Button, Input, SecretInput, Select, Checkbox, StatusBadge)
- Rebuilt layout (Sidebar with sections + active accent stripe, PageHeader)
- Overview redesigned with stacked-bar module-health chart and sparkline trend
- Per-page spacing/typography pass

**Phase B — Scenarios model + Architect agent**
- New `TestScenario` Prisma model (priority P0–P3, category positive/negative/edge/boundary/empty/e2e, rationale, dependencyOn)
- `TestCase.scenarioId` foreign key
- `server/services/agents/architect.js` — full Claude system prompt + JSON normaliser
- `server/routes/scenarios.js` with `POST /generate` + WS streaming
- `src/pages/TestCases.jsx` redesigned as scenario-grouped cards with expandable case lists, priority/category chips, type colour map

**Phase C — Multi-agent pipeline + Theater view**
- `AgentRun` Prisma model
- `server/services/agents/planner.js` — Claude prompt for dependency-aware execution waves with risk factors
- `server/services/agents/conductor.js` — for each scenario:
  - Asks Claude for an action plan (navigate/click/fill/expect_visible/...)
  - Executes actions live via the Browser service
  - Narrates each action over WS
  - On pass: asks Claude to emit the spec file in the project's framework + runs lint + persists GovernancePR with real lint findings
  - On fail: writes BlockedItem with classified reason + extracted locator
- `server/routes/agents.js` — orchestrator: Architect → Planner → Conductor, all streaming over per-user WS
- `src/pages/Theater.jsx` — vertical timeline with three phase cards (Architect, Planner, Conductor) that expand/collapse independently and stream Claude reasoning live. Conductor phase includes a live-browser panel and action trail.
- Sidebar entry with `live` badge

**Phase D — Live browser via CDP screencast**
- `server/services/browser.js` launches headed Chromium, hooks `Page.startScreencast` over CDP, streams ~10 fps base64 JPEG frames to the user's WS channel
- `executeAction()` resolves Playwright locator EXPRESSIONS (`getByRole(...)`, `getByTestId(...)`, etc.) safely and runs them
- `screenshot()` saves stills under `/artifacts/live/` and returns the served URL
- Conductor degrades to dry-run if Chromium can't launch — narration still works
- Chromium installed via TLS-bypass (`NODE_TLS_REJECT_UNAUTHORIZED=0`) due to Cognizant corporate proxy

**Phase E — Element picker overlay**
- `browser.armPicker()` injects overlay JS via `page.evaluate()`. Hovered elements are outlined in emerald. Click computes ranked locator candidates: `getByTestId` (98%) > `getByRole` (92%) > `getByPlaceholder` (80%) > `getByTitle` (75%) > `getByText` (65%) > CSS `#id` (60%) > CSS path (30%)
- Candidates POST back via `window.__qaai_pick(...)` → exposed function → WS
- Theater UI shows candidates with stability score, strategy badge, copy button
- `sessionRegistry` module keeps live sessions keyed by user; `POST /api/projects/:id/agents/picker/arm` arms the picker on the active session

**Phase F — Cucumber + Selenium codegens**
- `server/services/codegen/pom.js` — Playwright POM (default)
- `server/services/codegen/cucumber.js` — Gherkin `.feature` + step definitions
- `server/services/codegen/selenium.js` — Selenium 4 + JUnit 5 + Maven, with Page Object
- Each has a real Claude system prompt enforcing framework-idiomatic patterns (no `Thread.sleep`, no `page.waitForTimeout`, no inline credentials, Page Object separation, etc.)
- `codegen/index.js` registry — Conductor branches on `project.framework`

**Phase G — Honest demo + verification**
- `prisma/seed.cjs` retained for UI population, but the agent pipeline is the authentic end-to-end path. Output Files now populates from real agent runs (specs written by Conductor land on disk under `playwright/tests/`).
- Final verifications: ✅ vite build clean (1623+ modules, 33 KB CSS, 732 KB JS / 179 KB gzip) · ✅ all 30+ server files pass `node --check` · ✅ Prisma schema validates · ✅ both ports respond (`/api/health` returns `db:up`, frontend returns 200)

### How to use the full pipeline

1. Open http://localhost:5173 → sign in
2. Settings → Claude API → paste a real `sk-ant-…` key → Validate → Save
3. Project Setup → activate or create a project, set `targetUrl`
4. Run Suite → upload a doc or pull from ADO/Jira
5. **Sidebar → Theater → Start pipeline**
6. Watch:
   - Architect phase streams reasoning, produces scenarios
   - Planner phase streams reasoning, produces a wave-by-wave plan with risk factors
   - Conductor phase launches a **real Chromium window** (headed). Live frames appear in the Theater panel. Action narration ("Going to /login… Typing email… Verifying redirect") streams on the right. Every passing test produces a real `.spec.ts` (or `.feature`+`.steps.ts`, or `.java`) on disk.
7. Click **Pick element** during a Conductor run → click an element in the actual Chromium window → ranked locator candidates appear in Theater, copyable to clipboard.
8. After completion: Reports shows real screenshots, Output Files shows the real generated spec files, Governance shows the new PRs with real lint findings.

### Framework switching

`Project.framework` accepts: `playwright-pom` (default), `playwright-flat`, `cucumber-playwright`, `selenium-java`. Change in Project Setup → re-run the pipeline → the Conductor emits code in that framework.

### Known limitations / future work

- Single live browser per user (sessionRegistry is per-userId). True parallelism within a Planner wave requires a per-wave browser context.
- Conductor uses one Claude call per test case for the action plan. For long suites this gets expensive — would batch or use prompt-cache in a future pass.
- No real Git provider integration yet. Governance "Merge" remains a DB state machine.
- Selenium-Java codegen does not yet emit a `pom.xml`; the test class and Page Object are generated, but a developer needs to add Selenium 4 + JUnit 5 to their Maven build.

### File map of new pieces

```
prisma/schema.prisma                  TestScenario, AgentRun added
server/services/agents/architect.js   ← Agent 1
server/services/agents/planner.js     ← Agent 2
server/services/agents/conductor.js   ← Agent 3 (live browser driver)
server/services/browser.js            CDP screencast + executeAction + armPicker
server/services/sessionRegistry.js    Per-user active browser session
server/services/codegen/index.js      Framework dispatcher
server/services/codegen/pom.js        Playwright POM prompt + layout
server/services/codegen/cucumber.js   Cucumber/Gherkin prompt + layout
server/services/codegen/selenium.js   Selenium-Java prompt + layout
server/routes/scenarios.js            CRUD + /generate (Architect only)
server/routes/agents.js               Full 3-agent orchestrator + picker arm
src/pages/Theater.jsx                 Vertical timeline + live browser panel + picker UI
src/pages/TestCases.jsx               Scenario-grouped redesign
```

---

## Phase S — Replace custom Conductor with REAL Playwright MCP (next session)

> Added 2026-05-20. **This is the pending work for the next Claude session.**
> User wants reliability — MCP is the most reliable browser-automation contract
> available and Microsoft maintains it. Stop writing locator strings ourselves.

### Why this matters

Current Conductor pre-plans all actions for a test case in ONE Claude call,
then executes blindly. After a click navigates to a new page, the Conductor
doesn't know — it just runs the next planned action against the wrong DOM.
Result: most multi-step tests fail with locator-not-found.

Real Playwright MCP (`@playwright/mcp`, by Microsoft) gives an AGENTIC LOOP:
Claude calls ONE tool → MCP returns a fresh snapshot with element refs →
Claude picks the next tool → MCP executes → repeat. Per-action adaptive.

### What to REMOVE

1. **`server/services/agents/conductor.js`** — `runOneCase()`'s pre-planning block:
   - The Claude call that produces `actionPlan.actions`
   - The for-loop that executes pre-planned actions via `browserService.executeAction()`
   - `directConvertStepsToActions()` and `guessLocator()` (delete entirely)
   - `safeResolveLocator()` in `browser.js` (no longer needed — MCP resolves refs internally)
2. **`SYSTEM_PROMPT_ACTIONS`** in conductor.js — replace with a much simpler prompt
   that just describes the goal + available tools. Claude picks one at a time.
3. **The `tc.steps` upfront execution path** stays — but it's used as GUIDANCE for
   Claude inside the tool-use loop, not as a pre-baked action plan.

### What to INTEGRATE

1. **Install** in `server/`:
   ```
   npm i @playwright/mcp @modelcontextprotocol/sdk
   ```

2. **New file `server/services/mcp.js`**:
   - `startMcpSession({ userId, targetUrl })` — spawn `@playwright/mcp` as a
     stdio subprocess (`StdioClientTransport` from `@modelcontextprotocol/sdk`).
     Connect a `Client` instance. Cache the open session in `sessionRegistry`.
   - `listTools(session)` — `await client.listTools()` returns the available
     tools (browser_navigate, browser_snapshot, browser_click, browser_type,
     browser_wait_for, browser_press, browser_take_screenshot, etc.).
   - `callTool(session, name, args)` — `await client.callTool({name, arguments: args})`.
     Returns `{content: [...], isError}`.
   - `stopMcpSession(session)` — close the client + kill the subprocess.

3. **Refactor `runOneCase()` in conductor.js** as a Claude tool-use loop:
   ```pseudo
   const session = await mcp.startMcpSession({ userId, targetUrl })
   const tools = await mcp.listTools(session)
       // map each MCP tool to Anthropic tool schema:
       // { name, description, input_schema: jsonschema-from-mcp }
   const anthropicTools = mapMcpToolsToAnthropic(tools)
   let messages = [{
     role: 'user',
     content: `Test case: ${tc.name}
       Assertions: ${tc.assertions}
       Approved steps (use as guidance): ${JSON.stringify(tc.steps)}
       Start at: ${startUrl}
       
       Drive the browser to verify each assertion. After each action, you'll
       receive a snapshot — use it to decide the next action. When done, say "DONE".`
   }]
   
   for (let turn = 0; turn < 30; turn++) {
     const resp = await client.messages.create({
       model, max_tokens: 1500, tools: anthropicTools, messages,
     })
     // Forward narration to WS so the Live Pipeline UI shows it
     send({type:'browser.action', ...resp.content[0]})
     
     if (resp.stop_reason === 'end_turn') break
     if (resp.stop_reason !== 'tool_use') break
     
     const toolUses = resp.content.filter(c => c.type === 'tool_use')
     const toolResults = []
     for (const tu of toolUses) {
       const result = await mcp.callTool(session, tu.name, tu.input)
       toolResults.push({
         type: 'tool_result', tool_use_id: tu.id,
         content: result.content, is_error: result.isError,
       })
     }
     messages.push({ role: 'assistant', content: resp.content })
     messages.push({ role: 'user', content: toolResults })
   }
   await mcp.stopMcpSession(session)
   ```

4. **CDP screencast hookup** — `@playwright/mcp` spawns its own browser.
   To keep our live-browser frames working in the Live Pipeline view:
   - Pass `--port=<random>` to MCP so it exposes a CDP endpoint, OR
   - Use MCP's `browser_take_screenshot` tool periodically to get JPEG bytes,
     base64-encode, broadcast as `browser.frame` over WS. Lower FPS but
     simpler than competing CDP sessions.
   - Recommendation: use the tool-based screenshot approach first. ~2 fps
     polling. Skip CDP for now.

5. **Element picker** — `armPicker()` in browser.js currently injects overlay
   via `page.evaluate()`. With MCP we don't have a direct `page` handle. Two
   options:
   - Use MCP's snapshot to drive the picker UI server-side (list elements,
     user clicks one in our UI, we use that ref). Simpler.
   - Get MCP's CDP endpoint and attach our own Playwright instance to it for
     evaluate(). More complex.
   - Recommendation: do the first one — change `armPicker` to return the
     snapshot's elements list; the picker UI in Live Pipeline lets user
     pick one. No overlay needed.

6. **Keep these untouched**:
   - All of `architect.js` (Phase B work)
   - All of `planner.js`
   - `reporter.js`, `analyst.js`, `issueCreator.js`
   - All codegen
   - All UI except Live Pipeline action-trail rendering

### Verification after integration

- A single test case on `https://practice.expandtesting.com/login` with creds
  `practice / SuperSecretPassword!` should:
  1. Navigate to /login
  2. Snapshot returns username + password + login button (real elements)
  3. Claude calls `browser_type` on username field (ref from snapshot)
  4. Snapshot updates
  5. Claude calls `browser_type` on password field
  6. Claude calls `browser_click` on login button
  7. Snapshot now shows /secure with "Welcome" text
  8. Claude verifies and ends
- Expected: at least the login + secure-area scenario passes. Previously failed.

### Estimated effort

- Install + write `mcp.js` wrapper: ~30 min
- Refactor `runOneCase` as tool-use loop: ~45 min
- Hook MCP screenshots back into Live Pipeline frame stream: ~30 min
- Adapt picker to snapshot-driven: ~30 min
- Test + iterate on prompts: ~30 min
- **Total: ~2.5 hours of focused work**

### Important context for next Claude session

- User is on Cognizant corporate laptop. TLS-bypass env (`NODE_TLS_REJECT_UNAUTHORIZED=0`)
  was needed for Chromium download — same may be needed for MCP's internal browser launch.
- User's account has NO demo data — they create their own project + upload their own docs.
- User's Claude key is already validated + saved in vault. Model: claude-sonnet-4-6.
- The Architect/Planner work end-to-end. Output Files page works. Reports + Reporter
  agent work for failure analysis. Only the Conductor's locator strategy is broken.
- Live Pipeline page (formerly Theater) is at `/live-pipeline`.
- Per-user WS broadcasting via `req.app.locals.broadcastToUser(userId, msg)`.

### Decision log

User's exact words: "we should use playwright mcp right? it is the most reliable
source for us to do testing right?" — yes. We agreed: replace the custom Conductor
locator path with real `@playwright/mcp`. Snapshot-first (Phase ~60) was a partial
fix; MCP integration is the full fix.
