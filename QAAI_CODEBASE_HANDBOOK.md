# QAAI Codebase Handbook

Purpose: this is a working map for future Codex work on QAAI. It is based on a source-code pass over the authored project files, not only prior chat notes. Use it to avoid rediscovering the architecture, but always reopen exact files and line ranges before editing.

Actual project root:

```text
C:\Users\2461898\Downloads\qaai_fixed\qaai_fixed\qaai_fixed
```

Generated and output-heavy paths to avoid during broad scans:

```text
playwright/runs/
playwright/telemetry/
playwright/refit/
.playwright-mcp/
test-results/
playwright-report/
*.png
*.gz
*.log
prisma/dev.db
```

## System Summary

QAAI Portal is an autonomous QA platform. It ingests requirements, generates scenarios and test cases, executes approved cases through a real browser, verifies assertions, writes reports/RCA, learns from locators and failure patterns, and emits exportable automation code.

Stack:

- Frontend: React 19, Vite, Tailwind, lucide icons, React Router.
- Backend: Express, Prisma, SQLite locally, WebSocket live stream.
- AI providers: Anthropic and Gemini through a provider abstraction.
- Browser execution: `@playwright/mcp` subprocess controlled through `server/services/mcp.js`.
- Export frameworks: Playwright POM TS, Playwright JS, Playwright BDD, Selenium Java, Selenium BDD.

Main product flows:

1. Project setup configures target URL, framework, credentials, AI provider, browser context, known popups, auth fixtures, calibration, and sprints.
2. Run Suite ingests documents and requirements from upload, ADO, Jira, or manual sources.
3. Architect generates scenarios and test cases.
4. QA approves or rejects cases.
5. Conductor executes approved cases with MCP.
6. Verdict layer ratifies declared assertions and computes status.
7. Reports show run results, RCA, screenshots, traces, verdict evidence, chat, and rerun guidance.
8. Knowledge Base and Failure Patterns feed future runs.
9. Codegen emits runnable automation projects into output files.

## Load-Bearing Invariants

Do not break these.

- `TestCase.status` is approval lifecycle only: `pending`, `approved`, `rejected`, `running`.
- `RunResult.status` is execution outcome: `pass`, `fail`, `blocked`, `skipped`, and sometimes `needs_human` in newer verdict paths.
- Run counters on `Run` are denormalized. Recompute from `RunResult` through `services/runs.js#recomputeRunCounters`; do not increment one counter in isolation.
- Project and organization scoping matter on every API route. Use `requireAuth`, `requireOrg`, and ownership checks.
- CSRF is double-submit. Mutating routes generally use `requireCsrf`.
- Long-running agent calls must use cancellation tokens and propagate `AbortSignal`.
- WebSocket messages must be project-scoped on the frontend where possible, especially when pages can be open during project switches.
- Do not wipe `prisma/dev.db` or trial run output unless the user explicitly asks. The current local DB contains valuable trial history.
- Broad source scans must skip generated Playwright artifacts.
- Prefer deterministic code for graph joins, topological sorts, string normalization, schema validation, status classification, and assertion mechanics. Use LLMs only for genuine judgement or authoring.
- Mechanical verdict mode must not let the agent's claimed verdict override deterministic assertion outcomes.
- Codegen must preserve verdict fidelity: exported specs should assert the same structured `declaredAssertions` that the run verdict used.
- Deterministic locator replay should use run-resolved KB locators instead of asking the LLM to guess selectors again.

## Directory Map

```text
src/
  App.jsx                         Route shell and providers
  main.jsx                        React bootstrap
  store/
    auth.jsx                      Auth session state
    project.jsx                   Current project, sprint, generation
    runStream.jsx                 WebSocket stream and pipeline state
  pages/
    Overview.jsx                  Release dashboard and verdict cards
    RunSuite.jsx                  Requirement ingestion and architect launch
    TestCases.jsx                 Scenario/case approval and execution launch
    Theater.jsx                   Live browser/pipeline execution view
    Reports.jsx                   Run detail, RCA, traces, chat, reruns
    BlockedItems.jsx              Blocked recovery and semantic rerun paths
    KnowledgeBase.jsx             Locator KB trust surface
    OutputFiles.jsx               Generated workspace viewer/download
    ProjectSetup.jsx              Project config, credentials, calibration, sprints
    settings/                     AI and integration settings
  components/                     Shared UI and app chrome
  lib/                            API client, hooks, formatters, helpers

server/
  index.js                        Express app, route mounting, WS setup
  prisma.js                       Prisma singleton
  routes/                         API surfaces
  middleware/                     auth, org, csrf, rate limit, error
  services/
    agents/                       LLM and agent pipeline modules
    codegen/                      Export framework generators and helpers
    mcp.js                        Playwright MCP bridge and synthetic tools
    runs.js                       Older generated-spec run engine
    computeVerdict.js             Mechanical verdict pure function
    postLoopRatify.js             Post-loop assertion ratifier
    pageAtlas.js                  Learned page identity signals
    sharedDataStore.js            Cross-case data bag
    failurePatterns.js            Cross-run pattern store
    mcpContextConfig.js           Browser context CLI/init script
    playwright-worker.js          Spec-runner subprocess

prisma/
  schema.prisma                   35-model data model
  migrations/                     Schema evolution history

scripts/
  verification and replay scripts, mostly local no-credit guards

tests/
  frontend unit tests
```

## Frontend Architecture

`src/App.jsx` wraps:

- `AuthProvider`
- `ProjectProvider`
- `RunStreamProvider`
- `ToastProvider`
- `ConfirmProvider`
- app shell with `Sidebar`, `PauseModal`, `PausedBanner`, and `AgentRunningIndicator`

Important app routes:

- `/overview` -> `Overview`
- `/run-suite` -> `RunSuite`
- `/test-cases` -> `TestCases`
- `/live-pipeline` -> `Theater`
- `/reports` -> `Reports`
- `/blocked-items` -> `BlockedItems`
- `/knowledge-base` -> `KnowledgeBase`
- `/output-files` -> `OutputFiles`
- `/project-setup` -> `ProjectSetup`
- `/settings/*` -> provider/integration settings
- `/login` -> `LoginScreen`

### Frontend State Stores

`src/store/auth.jsx`

- Manages authenticated user and auth checking state.
- Uses `apiClient`.
- Exposes `AuthProvider` and `useAuth`.

`src/store/project.jsx`

- Loads projects from `/projects`.
- Tracks current project, sprint, and scenario generation.
- Persists selections in localStorage with safe fallback memory store.
- Loads sprints and generations for current project.
- Important bug history: localStorage fallback must be key-value, not one shared slot.

`src/store/runStream.jsx`

- Owns WebSocket connection and reconnection.
- Applies pipeline messages into durable pipeline state.
- Central for live UI recovery after navigation.
- Pages subscribe through `useRunStream` and `usePipelineState`.

### Frontend Pages

`src/pages/ProjectSetup.jsx`

Responsibilities:

- Create/edit projects.
- Configure framework, target URL, exec mode.
- Configure test credentials.
- Manage auth fixtures and default fixture.
- Run/view calibration.
- Configure Git repo.
- Configure browser context options.
- Configure known popups.
- Manage sprints and carry-forward.

Primary APIs:

- `POST /projects`
- `PUT /projects/:id`
- `PUT /projects/:id/credentials`
- `GET/POST/DELETE /projects/:id/auth-fixtures`
- `GET/POST/DELETE /projects/:id/calibrations`
- `GET/PUT /projects/:id/repo`
- `GET/PUT /projects/:id/browser-context`
- `GET/PUT /projects/:id/known-popups`
- sprint endpoints

`src/pages/RunSuite.jsx`

Responsibilities:

- Requirement upload and pull from ADO/Jira.
- Category tagging.
- Analyst discrepancy detection.
- Diff context fetch/analyze.
- Architect phase live banner.

Primary APIs:

- `GET /projects/:id/requirements`
- `POST /projects/:id/requirements/upload`
- `POST /projects/:id/requirements/pull/:source`
- `POST /projects/:id/analyst/detect-discrepancies`
- `POST /projects/:id/discrepancies/:id/resolve`
- `POST /projects/:id/diff-context`
- `POST /projects/:id/agents/cancel`

`src/pages/TestCases.jsx`

Responsibilities:

- Scenario generation configuration.
- Scenario and case listing.
- Approval/rejection/bulk update.
- Manual vs automatable tabs.
- Generate/regenerate scenario.
- Execute approved cases.
- Smoke run.
- Smart impact selection.
- Live architect/conductor phase status.

Primary APIs:

- `GET /projects/:id/scenarios`
- `POST /projects/:id/scenarios/generate`
- `POST /projects/:id/scenarios/:scenarioId/regenerate`
- `POST /projects/:id/test-cases/approve-all`
- `POST /projects/:id/test-cases/bulk-update`
- `PUT /projects/:id/test-cases/:tcId`
- `POST /projects/:id/agents/execute`
- `POST /projects/:id/agents/run-smoke`
- `POST /projects/:id/analyst/select-impacted`

Risk: this file is very large. Reopen exact components before changing filters, execution controls, manual tabs, or phase banners.

`src/pages/Theater.jsx`

Responsibilities:

- Live pipeline visualization.
- Browser frame rendering.
- Action trail and DOM snapshot panels.
- Rerun failed cases.
- Shows current case and phase logs.

Primary APIs:

- `GET /projects/:id/agents/status`
- `GET /projects/:id/agents/failed-cases`
- `POST /projects/:id/agents/execute`
- `POST /projects/:id/agents/rerun-failed`
- `POST /projects/:id/agents/cancel`

`src/pages/Reports.jsx`

Responsibilities:

- Run list and detail pane.
- Scenario-grouped results.
- Steps/trace tab.
- Screenshots/video/network.
- RCA analysis and ticket creation.
- Friendly RCA chat.
- Verdict evidence.
- Test history.
- Case guidance and in-place rerun.
- Compare run launch.

Primary APIs:

- `GET /runs?projectId=...`
- `GET /runs/:runId`
- `POST /runs/:runId/analyze`
- `POST /runs/:runId/results/:resultId/ticket`
- `POST /runs/:runId/results/:resultId/chat`
- `GET /projects/:id/test-cases/:tcId/history`
- `PUT /projects/:id/test-cases/:tcId`
- `POST /projects/:id/agents/runs/:runId/cases/:caseId/rerun`

Important bug history:

- Must refetch on both `run.complete` and `run.inplace.complete`.
- Guidance reruns need visible confirmation from `agent.guidance.applied`.
- Watch stale closures after project/sprint switch.

`src/pages/BlockedItems.jsx`

Responsibilities:

- List unresolved/resolved blockers.
- Resolve, skip, delete, patch.
- Rerun blocked item through conductor path.
- Semantic rerun with assertion equivalence rescue.
- Analyze blockers.
- Heal KB locator from current DOM.

Primary APIs:

- `GET /projects/:id/blocked`
- `POST /projects/:id/blocked/:blockedId/resolve`
- `POST /projects/:id/blocked/:blockedId/skip`
- `PATCH /projects/:id/blocked/:blockedId`
- `DELETE /projects/:id/blocked/:blockedId`
- `POST /projects/:id/blocked/:blockedId/rerun`
- `POST /projects/:id/blocked/analyze`
- `POST /projects/:id/agents/rerun-case-semantic`
- `POST /projects/:id/knowledge-base/:locatorId/heal-now`

Important bug history:

- Blocked rerun must use `runConductorWithRetries`, not old spec runner.
- Must reconcile after `run.inplace.complete`.

`src/pages/KnowledgeBase.jsx`

Responsibilities:

- Locator KB trust surface.
- Search/filter/group locators by page.
- Show role, accessible name, page URL, health, history.
- Manual delete/heal.
- Live capture updates from run stream.

Primary APIs:

- `GET /projects/:id/knowledge-base`
- `POST /projects/:id/knowledge-base/:locatorId/heal-now`

`src/pages/OutputFiles.jsx`

Responsibilities:

- Browse generated output tree.
- Select run workspace.
- Preview files with syntax highlighting.
- Download zip.
- Open workspace in VS Code.
- Persist local workspace path.

Primary APIs:

- `GET /projects/:id/output-files`
- `GET /projects/:id/output-files/runs`
- `GET /projects/:id/output-files/file/*`
- `GET /projects/:id/output-files/files.json`
- `POST /projects/:id/output-files/open-in-vscode`
- `PUT /projects/:id`

## Backend Routes

`server/index.js` mounts routes under:

- `/api/auth`
- `/api/settings/claude`
- `/api/settings/gemini`
- `/api/settings/ado`
- `/api/settings/jira`
- `/api/settings/webhook`
- `/api/settings/notifications`
- `/api/projects`
- `/api/projects/:projectId/requirements`
- `/api/projects/:projectId/test-cases`
- `/api/projects/:projectId/scenarios`
- `/api/projects/:projectId/agents`
- `/api/projects/:projectId/knowledge-base`
- `/api/projects/:projectId/governance`
- `/api/projects/:projectId/blocked`
- `/api/projects/:projectId/sprints`
- `/api/projects/:projectId/output-files`
- `/api/runs`
- `/api/dashboard`
- `/api/budget`
- `/api/projects/:projectId/auth-fixtures`
- `/api/projects/:projectId/calibrations`

### Route Responsibilities

`server/routes/agents.js`

- Main autonomous agent pipeline endpoints.
- Starts architect/planner/conductor flows.
- Executes approved cases.
- Reruns failed cases.
- Runs smoke subsets.
- In-place rerun of one case.
- Cancel/status/pause/picker endpoints.
- Very large. Prefer moving shared orchestration to services instead of adding more route logic.

`server/routes/scenarios.js`

- Scenario generation and regeneration.
- Uses Architect, calibration context, declared assertion parsing, grounding.
- Handles generation versions.

`server/routes/testCases.js`

- Test case list, manual guide, approval, bulk update, history, reclassify, delete.
- Can invoke older `testGenerator` path.

`server/routes/runs.js`

- Older generated-spec run path using `services/runs.js`.
- List/get/compare/delete run.

`server/routes/reporter.js`

- RCA analysis.
- Ticket creation.
- RCA chat.
- Post-mortem pattern learning.

`server/routes/blocked.js`

- Blocked item CRUD.
- Analyze blockers.
- Rerun blocked items through `conductorRunner`.

`server/routes/projects.js`

- Project CRUD.
- Guidance, assertion equivalences, provider, credentials, repo, browser context, known popups, downloads, diff context, delete hygiene.

`server/routes/outputFiles.js`

- Output tree, file preview, zip download, VS Code open, workspace metadata.

`server/routes/knowledgeBase.js`

- Locator KB list/create/heal/delete.

`server/routes/dashboard.js`

- Overview data and verdict-disagreement data.

Settings routes:

- Claude/Gemini validation and save.
- ADO/Jira pull/test/save.
- Webhook and notification config.

## Backend Services

### Agent Modules

`server/services/agents/architect.js`

- Generates scenarios/cases from requirements.
- Normalizes scenario and case shapes.
- Parses robust JSON.
- Applies grounding and automatability checks.
- Handles declared assertions and data dependencies.
- Uses source docs, calibration context, prior context, and prompt constraints.

`server/services/agents/planner.js`

- Deterministic Kahn topo-sort and wave planner.
- No LLM.

`server/services/agents/conductor.js`

Main live execution engine.

Responsibilities include:

- Build per-case prompt context.
- Start/bind MCP session.
- Drive Claude tool-use loop.
- Dispatch MCP and synthetic tools.
- Track action trail, step results, traces, screenshots.
- Handle schema validation errors and locator failures.
- Invoke healer.
- Record locator success/failure/heal into KB.
- Manage shared data extraction and substitution.
- Call assertion_check and record V2 outcomes.
- Post-loop ratification and mechanical verdict.
- Visual critic.
- Persist `RunResult`, `BlockedItem`, `GovernancePR`, downloads, rich telemetry.
- Trigger codegen and journey spec emission.

This is the highest blast-radius file. Any change should isolate the exact helper first. Avoid broad edits.

`server/services/agents/conductorRunner.js`

- Shared orchestration wrapper around Conductor, Critic, Supervisor, and BlockageAnalyzer.
- Used by agent route and blocked-item rerun path.
- Keeps rerun behavior consistent.

`server/services/agents/critic.js`

- Post-run rewrite advice.
- Inline critic hints during conductor loops.

`server/services/agents/supervisor.js`

- Escalates after repeated conductor failures.
- Can revise case/guidance or give up as blocked.

`server/services/agents/reporter.js`

- Structured RCA for failed results.

`server/services/agents/rcaChat.js`

- Per-failure follow-up chat, grounded in result context and prior RCA.

`server/services/agents/blockageAnalyzer.js`

- Classifies blocked/failure rows into dependency, environment, data unavailable, selector drift, flake, unknown.

`server/services/agents/healer.js`

- LLM locator healing from fresh MCP snapshot.
- Should be called only for locator-class failures.

`server/services/agents/calibrator.js`

- Pre-run site crawl.
- Captures pages, interactive elements, visible text corpus, page roles.
- Persists `Calibration` and `CalibrationPage`.
- Provides calibration context and selector resolution.

`server/services/agents/postMortem.js`

- Converts RCA failures into project-scoped reusable `FailurePattern` rows.

`server/services/agents/verifier.js`

- Thorough-mode pass sufficiency reviewer.
- Does not override pass to fail; escalates insufficient proof to needs-human.

`server/services/agents/visualCritic.js`

- Semantic screenshot diff.

### MCP And Verification

`server/services/mcp.js`

The MCP bridge and synthetic tool layer.

Responsibilities:

- Launch `@playwright/mcp` as subprocess via SDK stdio transport.
- Build CLI args from project browser context config.
- Normalize tool args.
- Guard action refs by role.
- Cache snapshots and current URL.
- Broadcast browser frames.
- Implement synthetic tools:
  - `assertion_check`
  - `final_verdict`
  - `human_input`
  - `browser_extract_data`
  - stability/wait helpers
- Match assertions:
  - text
  - role
  - URL
  - page identity
  - data extraction
- Apply project assertion equivalences.
- Integrate semantic verifier fallback and page atlas.

This is the second highest blast-radius file after Conductor.

`server/services/postLoopRatify.js`

- After agent finishes, checks any declared assertion the agent did not check.
- Uses final snapshot and visited URL history.
- Produces `matched`, `not_matched`, or `uncheckable`.
- Important for mechanical verdict invariant.

`server/services/computeVerdict.js`

- Pure priority ladder.
- Deterministically maps termination signals, steps, and assertion outcomes to final status.
- Verification can subsume transient execution noise when all required assertions matched.

`server/services/semanticVerifier.js`

- LLM fallback only after deterministic verifier says no.
- Designed to rescue wording mismatches, not override deterministic passes.

`server/services/pageAtlas.js`

- Stores learned page identity signals from semantic rescues.
- Uses half-weight until corroborated, then full weight.

### Cross-Run Learning

`server/services/failurePatterns.js`

- Upserts `FailurePattern` rows from post-mortem classifications.
- Loads patterns for conductor prompt.
- Matches prior patterns for RCA chat context.

`server/services/sharedDataStore.js`

- Manages `Run.sharedData`.
- Allows cases to produce primitive data and downstream cases to consume it.
- Filters injected prompt data by `requiresData`.

`server/services/knownPopups.js`

- Normalizes operator-declared popup rules.
- Renders prompt blocks and codegen helper snippets.

### Codegen

Registry:

- `server/services/codegen/index.js`

Framework generators:

- `pom.js` - Playwright TypeScript POM.
- `playwrightJs.js` - Playwright JavaScript POM.
- `playwrightBdd.js` - Playwright BDD.
- `selenium.js` - Selenium Java/TestNG.
- `seleniumBdd.js` - Selenium Cucumber/TestNG.

Shared helpers:

- `_env.js` - canonical credential/env contract.
- `_login.js` - one shared login helper per run.
- `_fidelity.js` - declared assertion fidelity for export parity.
- `_locators.js` - deterministic locator replay from KB.
- `_journeys.js` - dependency-chain journey partitioning.
- `_journey.js` - flat Playwright journey spec generation.
- `_recoverJson.js` - robust JSON envelope recovery.
- `_replayTrace.js` - reconstruct action plan from rich trace.
- `_sanitize.js` - deterministic syntax repairs for generated code.

Recent/current codegen direction:

- P2 deterministic locators is implemented.
- P1 journey emission exists in helpers and should be treated as a major current workstream.
- Playwright journey support is for Playwright frameworks; Selenium remains per-case unless expanded.

### Older Spec Runner

`server/services/runs.js`

- Generates specs through `test-generator.js`.
- Runs them through `playwright-worker.js`.
- Persists run results, blockers, governance PRs.
- Expands `dependsOnIds` transitively and topo-sorts.

Important distinction: the main autonomous path is Conductor/MCP. Do not accidentally route new rerun logic through this older runner unless the request is specifically about generated specs.

## Prisma Data Model

Core model groups:

Identity and tenancy:

- `User`
- `Organization`
- `OrgMembership`
- `OrgInvite`
- `Session`
- `Secret`
- `Integration`

Notifications and audit:

- `WebhookConfig`
- `WebhookDelivery`
- `NotificationChannel`
- `NotificationRoute`
- `AuditLog`
- `UserDailyUsage`

Project and setup:

- `Project`
- `Sprint`
- `SprintTestCase`
- `AuthFixture`
- `Calibration`
- `CalibrationPage`
- `DiffContext`
- `Download`

Requirements and generation:

- `Document`
- `Requirement`
- `Discrepancy`
- `ScenarioGeneration`
- `TestScenario`
- `TestCase`

Execution:

- `Run`
- `RunResult`
- `AgentRun`

Learning/output:

- `KnowledgeBaseLocator`
- `FailurePattern`
- `GovernancePR`
- `PRComment`
- `BlockedItem`

Important fields:

- `Project.verdictMode`, `Project.execMode`, `Project.testCredentials`, `Project.pageAtlas`, `Project.assertionEquivalences`, browser context fields, known popups, default auth fixture.
- `TestCase.declaredAssertions`, `steps`, `dependsOnIds`, `producesData`, `requiresData`, `automatability`, `businessRisk`, `generationId`.
- `Run.sharedData`, counters, `verdictMode`, `verifierMode`, `generationId`.
- `RunResult.stepResults`, `richTraceFile`, `assertionCheckResults`, `verdictVersion`, `agentClaimedVerdict`, `flipDirection`, `mechanicalVerdictReason`, `blockedReason`.
- `KnowledgeBaseLocator` unique key: `[projectId, element, pageUrl]`.
- `FailurePattern` unique key: `[projectId, signature]`.

Migration history shows evolution through:

- initial app models
- scenarios/test cases/runs
- RCA and POM
- blocked/skipped split
- chat/guidance
- provider support
- credentials
- blockers
- sprints
- locator intent
- diff/visual/governance
- org substrate
- budget/browser context/downloads
- Phase H verdict columns
- step results
- auth fixtures
- business risk
- calibration
- scenario generations
- dependencies/shared data/manual classifier
- failure patterns
- rich traces
- assertion gate
- KB page URL uniqueness
- semantic verifier
- page atlas
- calibration text corpus

## WebSocket And Live State

Backend sends per-user WS events from agent routes, conductor, runs, calibration, and pipeline services.

Frontend centralizes stream handling in `src/store/runStream.jsx`.

Common message categories:

- phase logs and completion
- browser frames
- action trail
- result updates
- run counters
- run complete and in-place complete
- pause/human input
- locator capture
- guidance applied
- calibration progress

When adding a new live event:

1. Include `projectId` where practical.
2. Make frontend ignore messages for non-current project.
3. Decide whether the message should update durable `pipelineState`.
4. Make page-local UI recover after navigation by seeding from `pipelineState`.

## Local Setup Notes

Run from actual root:

```powershell
$env:QAAI_MCP_NO_SANDBOX='1'
npm run server
npm run dev
```

Backend: `http://localhost:5000`
Frontend: `http://localhost:5173`

Health:

```text
GET http://localhost:5000/api/health
```

After schema changes:

```powershell
npx prisma generate
```

MCP Chromium may fail without:

```powershell
$env:QAAI_MCP_NO_SANDBOX='1'
```

## Tests And Verification Guards

Useful no-credit guards:

```powershell
node scripts/_test_locators.cjs
node scripts/_test_journeys.cjs
node scripts/_test_journey_codegen.cjs
node scripts/verify_codegen_contract.cjs
node server/services/__tests__/computeVerdict.test.js
node server/services/__tests__/postLoopRatify.test.js
node server/services/__tests__/matchPageAssertion.test.js
node server/services/__tests__/matchUrlPattern.test.js
node server/services/__tests__/sharedDataExtract.test.js
node server/services/agents/__tests__/sharedDataChaining.test.js
node server/services/agents/__tests__/sharedDataConductor.test.js
npm test
```

Use focused tests based on changed area. Do not run broad generated Playwright suites unless the task requires it.

## Change Safety Checklist

Before editing:

1. Identify which path is involved:
   - frontend UI
   - API route
   - agent prompt/output parser
   - MCP tool/synthetic tool
   - verdict layer
   - codegen/export
   - Prisma schema
2. Reopen exact files and line ranges.
3. Check whether the change affects:
   - project/org scoping
   - run counters
   - approval vs execution status
   - WebSocket recovery
   - cancellation
   - mechanical verdict invariants
   - trial data/output files
   - codegen parity
4. Add or run the nearest no-credit guard when possible.
5. Avoid broad refactors in `conductor.js`, `mcp.js`, `Reports.jsx`, and `TestCases.jsx` unless the task explicitly requires it.

## High-Risk Files

`server/services/agents/conductor.js`

- Huge and multi-concern.
- Changes can affect live execution, verdicts, codegen, KB, reports, blockers, and output files.
- Prefer extracting or changing a named helper.

`server/services/mcp.js`

- Subprocess lifecycle, tool argument normalization, assertion checks, stability, and synthetic tools.
- Breakage can make every live run fail.

`src/pages/Reports.jsx`

- Many independent panels and live update paths.
- Stale closure bugs are easy here.

`src/pages/TestCases.jsx`

- Huge approval/generation/execution surface.
- Bulk state, filters, phase state, and run launch paths can interact subtly.

`server/routes/agents.js`

- Large route-level orchestrator.
- Prefer using `conductorRunner.js` for shared execution logic.

`prisma/schema.prisma`

- Schema changes require migration and `prisma generate`.
- Keep local trial data in mind.

## Current Architectural Direction

The core strategic direction is to stop letting the agent be the sole verifier.

Already in place or partially in place:

- Mechanical verdict columns and `computeVerdict`.
- Post-loop ratification.
- Assertion V2 outcomes.
- Calibration pages and text corpus.
- Semantic fallback verifier.
- Page atlas learning.
- Shared data chaining.
- Failure pattern store.
- Deterministic locator replay.
- Journey planning/generation helpers.

Likely next workstreams:

- Finish/validate dependency-chain journey emission end-to-end.
- Strengthen stability/wait semantics around async app state.
- Continue Calibrator-grounded Architect work.
- Expand replay harness coverage and candidate-vs-baseline measurement.
- Reduce `conductor.js` and `mcp.js` concern density carefully.

## Working Rule For Future Codex

Do not say "I know every line." Say: "I have the system map, and I will reopen the exact code before changing it."

For any task, begin from the relevant artery:

- UI defect: page/component -> store/runStream -> API route.
- Run execution defect: `routes/agents.js` or `conductorRunner.js` -> `conductor.js` -> `mcp.js` -> Prisma result.
- Verdict defect: declared assertions -> `mcp.checkAssertion` -> `postLoopRatify` -> `computeVerdict` -> Reports evidence.
- Codegen defect: `conductor.persistResultAndCodegen` or journey emission -> codegen registry -> framework generator/helper -> contract scripts.
- Locator defect: MCP snapshot parser -> Conductor KB record/heal -> `KnowledgeBaseLocator` -> `_locators.js` replay -> KnowledgeBase UI.
- Rerun defect: Reports/Blocked UI -> rerun route -> `conductorRunner` -> original run update -> `run.inplace.complete` refetch.

