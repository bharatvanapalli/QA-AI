# BUILD_PLAN_V2.md — Outstanding-execution enhancement plan

**Status:** proposed 2026-05-25.
**Author / driver:** Sravan (with Claude review).
**Supersedes:** the "what's next" tail of [BUILD_PLAN.md](BUILD_PLAN.md). Original 12-phase plan + Phase A–D stay as historical record.
**Read alongside:** [CLAUDE.md](CLAUDE.md) (invariants), [PHASE_LOG.md](PHASE_LOG.md) (what already shipped).

---

## Why a new plan

The original BUILD_PLAN was a feature list. This one is a **wedge plan** — picks the differentiators that turn QAAI from "competent autonomous-QA tool" into "outstanding autonomous-QA tool" and orders them by user-visible impact and architectural foundation.

Three principles drive the ordering:

1. **Self-healing locators are the table-stakes 2026 feature** and we are not shipping it yet. Phase E1 is non-negotiably first.
2. **Make the agent loop honest before adding new surfaces.** Phase E2 closes the "Critic sees the final snapshot but Claude has already ended the turn" gap that BUILD_PLAN D4 papered over.
3. **Postgres swap is deferred to the LAST phase before production.** The SQLite footgun is contained and the JSON-as-String tax is paid daily but predictably — every other phase here will run on the existing schema with at most additive nullable columns.

What's explicitly **out of scope until Phase E9+**: Postgres swap, multi-tenancy, SSO/OIDC, object storage, browser pool autoscaling. They're tracked here as the production-hardening phase block, not killed.

---

## Current state — what is actually in the code (verified 2026-05-25)

Read [PHASE_LOG.md](PHASE_LOG.md) for the full timeline. Concrete state:

- **Real `@playwright/mcp` subprocess** is wired through [server/services/mcp.js](server/services/mcp.js). Conductor calls `mcp.callTool()` per turn; snapshots are cached on `session.lastSnapshot`. Frame poller broadcasts JPEGs at ~2 fps over WS.
- **Anti-loop hardening** (Phase D D1–D5) shipped: action-repetition map, `MAX_IDENTICAL_TOOL_CALLS=3`, pre-action page-error read, credential discipline (`Project.testCredentials`), final-snapshot capture, amber Theater warning banner.
- **Provider abstraction** (Phase A) — `lib/llmProvider.js` + `providers/{anthropic,gemini}.js`. Anthropic shape is canonical; Gemini translates at the boundary. Per-project provider choice.
- **Robust JSON parsing** ([server/lib/parseJsonResponse.js](server/lib/parseJsonResponse.js)) — 4-strategy recovery used by every JSON-emitting agent except Architect (which has its own scenario-aware parser).
- **Sprint isolation** (Phase B/B3 hybrid) — Sprint container on Docs/Requirements/Runs/Blockers/PRs; TestCases stay project-level via `SprintTestCase` join.
- **BlockedItem AI fields** (Phase 7) — `aiSummary`, `aiCategory`, `aiRootCauseTcId`, `aiSuggestedFix`, severity, assignee, resolveNote.
- **Conversational RCA + per-case + per-project guidance** (Phase 5.5) — `Project.aiGuidance`, `TestCase.userGuidance`, `RunResult.chatHistory`.

What is **explicitly missing** and what this plan addresses:

| Gap | Today | Phase that fixes it |
|---|---|---|
| **Self-healing locators** | `KnowledgeBaseLocator` is manual CRUD only. No DOM-snapshot-driven regeneration. No semantic intent stored. | **E1** |
| **Critic real-loop verification** | D4 captures final snapshot AFTER Claude ends its turn — Claude can't react to a contradicting snapshot. | **E2** |
| **Code-diff awareness** | Architect ingests BRDs/release notes only. PR diff context is the wedge competitors use. | **E3** |
| **Vision-based screenshot reasoning** | Reports show raw screenshots. No semantic narration of visual change. | **E4** |
| **Model cost routing** | Every agent runs on the project's default Sonnet/Gemini-Pro. Reporter prose burns Sonnet tokens for low-stakes summarisation. | **E5** |
| **AST-based lint** | Regex-on-line rules in `lintGates.js`. Misses brittle locators, missing awaits, hardcoded timeouts. | **E6** |
| **Real Git provider PR push** | Governance "Merge" is a DB state machine. Workflow promise is unfulfilled. | **E7** |
| **Multi-tenancy** | No `orgId` anywhere. Single-tenant-per-instance. | **E8** |
| **Postgres + production hardening** | SQLite with 7 JSON-as-String fields. Local-FS artifacts. Vault key in `.env`. | **E9** |
| **Observability + browser pool** | No traces, localhost-spawn Playwright. Won't survive >3 concurrent users. | **E10** |

---

## Sequencing & dependency graph

```
E1 (self-healing) ───┐
                     ├─→ E5 (cost routing) ───┐
E2 (loop ratify) ────┤                         ├─→ E9 (Postgres)
                     ├─→ E6 (AST lint) ───────┤      │
E3 (code-diff) ──────┤                         │      ├─→ E10 (prod ops)
                     ├─→ E7 (real PR push) ───┤      │
E4 (visual diff) ────┘                         │      │
                                               ├──────┘
                  E8 (multi-tenancy) ──────────┘
```

**Hard sequencing rules:**
- E1 must ship before E2 — healed locators give the Critic something concrete to verify against.
- E1, E2, E3, E4 can ship in parallel between sessions but pick one at a time per session (per CLAUDE.md "no half-built features").
- E9 (Postgres) must ship AFTER E1–E8 — every preceding phase adds nullable columns, which the SQLite-to-Postgres migration recipe can fold into one final pass.
- E10 ships last because browser-pool + observability infrastructure is meaningful only in production.

---

# PHASE E1 — DOM-aware self-healing locator engine ✓ (E1.1-E1.7 ✓ 2026-05-25)

**The flagship feature.** Closes the biggest competitor gap (Mabl / Shiplight intent-based healing) and gives QAAI a brag-worthy story: "even when the DOM changes, our locators heal themselves by reading the page."

## E1.1 — Schema: intent + page context on KnowledgeBaseLocator

Extend `KnowledgeBaseLocator` ([prisma/schema.prisma](prisma/schema.prisma)) — additive nullable columns only:

```prisma
model KnowledgeBaseLocator {
  id            String   @id @default(uuid())
  projectId     String
  element       String
  selector      String
  strategy      String   // existing
  occurrences   Int      @default(1)
  healthScore   Int      @default(100)
  lastHealedAt  DateTime?

  // NEW — intent model
  intent        String?  // semantic description: "primary login submit button"
  accessibleName String? // captured from MCP accessibility tree at first sighting
  role          String?  // ARIA role at first sighting
  pageUrl       String?  // URL pattern where this locator lives
  domAnchor     String?  // JSON-encoded short snippet of nearby accessibility tree
  failureCount  Int      @default(0)
  lastFailedAt  DateTime?
  healHistory   String?  // JSON array of {ts, oldSelector, newSelector, reason}
  parentProjectId String? // tracks cross-project locator lineage when healed selectors are promoted

  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@index([projectId, healthScore])
  @@unique([projectId, element])
}
```

Migration name: `20260526xxxxxx_locator_intent_model`. Pure ADD COLUMN — no existing-row rewrite.

## E1.2 — Locator interceptor in the Conductor tool-use loop

Today `mcp.callTool()` either succeeds or surfaces `isError: true`. When it errors with `locator_not_found` / `Element not found` / `Timeout exceeded`, we currently let Claude figure it out. Replace with a server-side intercept.

Touchpoints:

- New helper [server/services/agents/healer.js](server/services/agents/healer.js):
  ```
  async function healLocator({ project, provider, apiKey, model, brokenLocator, freshSnapshot, intent, history, signal, onRateLimit })
    → { strategy, selector, confidence: 0–99, reasoning }
  ```
  System prompt (compressed):
  > You are a locator-healing agent. Given the Playwright-MCP accessibility tree of the current page and the semantic intent of a target element ("primary login submit"), emit a Playwright locator that targets it on THIS DOM. Prefer in this order: `getByRole(role, { name })`, `getByTestId`, `getByLabel`, `getByText`, CSS as last resort. Confidence must reflect ambiguity in the tree (multiple matches = lower confidence). Output strict JSON: `{strategy, selector, confidence, reasoning}`. No prose.

- In [server/services/agents/conductor.js](server/services/agents/conductor.js): on every `isError: true` tool result that mentions a locator-class failure, BEFORE handing the result back to Claude:
  1. Look up the locator in `KnowledgeBaseLocator` by `element` (derived from the tool args). If found, increment `failureCount` + `lastFailedAt`.
  2. Call `healer.healLocator({ freshSnapshot: mcp.getLastSnapshot(session), intent: kbRow?.intent || tu.input.element, history: kbRow?.healHistory })`.
  3. If `confidence >= 70`, re-issue the tool with the new selector. On success: append a `healHistory` entry, decrement `failureCount` by 1, bump `healthScore` by 5 (capped 100), set `selector = new`.
  4. If `confidence < 70` OR retry still fails: drop `healthScore` by 20, emit a `BlockedItem` of category `selector_drift` with the healer's `reasoning` as `aiSuggestedFix`.

- The Critic + Supervisor never see the intercept — Claude continues as if the tool succeeded on the first try. Less context churn, fewer tokens.

## E1.3 — First-sighting capture

When the Conductor successfully resolves a locator (success path, not heal path), capture the intent + accessible name + role + page URL + a 200-char nearby-DOM snippet into `KnowledgeBaseLocator`. This builds the corpus the healer reads from. Insert via `upsert` keyed on `(projectId, element)`.

Implement in [server/services/agents/conductor.js](server/services/agents/conductor.js) — wrap `callTool` with a `recordSuccessfulLocator(session, tool, args, snapshotBefore)` helper. Idempotent; only updates when intent fields are still null OR selector changed.

## E1.4 — UI surface

Two new pieces:

1. **DOM snapshot viewer in Theater** ([src/pages/Theater.jsx](src/pages/Theater.jsx)) — collapsible right-side pane. Shows the latest MCP accessibility-tree text in a mono panel. New WS event `mcp.snapshot.preview` emitted by `mcp.js` (truncated to 8 KB) — Theater renders it under the BrowserFrame in a collapsible card. Default collapsed.
2. **Heal-now button on `selector_drift` BlockedItems** ([src/pages/BlockedItems.jsx](src/pages/BlockedItems.jsx)) — when `aiCategory === 'selector_drift'`, surface a button "Heal locator from current DOM" that POSTs to a new `POST /api/projects/:p/locators/:id/heal-now` endpoint. The endpoint launches a fresh MCP session, navigates to the locator's `pageUrl`, takes a snapshot, runs `healer.healLocator`, and stores the result. UI shows the new selector + confidence + a re-test button.

## E1.5 — Knowledge Base page upgrade

Today [src/pages/KnowledgeBase.jsx](src/pages/KnowledgeBase.jsx) is a flat locator table. Add:

- **Health timeline** (line chart) per locator — `healthScore` over time from `healHistory`. Use a tiny SVG line (no chart library — match Phase 4 sparkline pattern).
- **Top flaky locators (top 10)** — sort by `failureCount` desc, surface in a side panel.
- **Search by element / selector** — existing input box, just wire it to `?q=`.

## E1.6 — Acceptance criteria

- A test case run against a page whose login button has been renamed from `data-testid="login-btn"` to `data-testid="auth-submit"` (and where the KB row still has the old selector) MUST: detect the failure → call healer → resolve to the new testid → retry → pass. **Without any human intervention.**
- The post-run KnowledgeBase view shows the heal in `healHistory` with the reason.
- `healthScore` of the resolved locator stays ≥ 80 after the heal (one failure costs 20, one success gives 5; net -15 from baseline 100 = 85).
- A locator with `healthScore < 30` is auto-quarantined: the Conductor refuses to use it and emits a `BlockedItem` instead of attempting. Prevents repeated thrash on a genuinely-deleted element.

## E1.7 — Risks & mitigations

- **Healer hallucinates a plausible-looking selector that hits a different element.** Mitigation: the in-loop Critic (Phase E2) re-reads the post-action snapshot and verifies the expected element behaviour. Healer's output is one signal, not the final verdict.
- **Healer adds a 3rd Claude call per failed action.** Mitigation: Phase E5 routes healer to Haiku 4.5 (cheap, fast). Healer's accessibility-tree reasoning task is well within Haiku's capability.
- **Race condition on parallel test runs hitting the same locator.** Mitigation: KB writes use Prisma `upsert` with last-writer-wins on selector; healHistory is append-only via raw SQL `json_array_append` (SQLite) or manual decode/encode in the service layer.

## E1.8 — Files touched

- `prisma/schema.prisma` + new migration
- `server/services/agents/healer.js` (new)
- `server/services/agents/conductor.js` (intercept + recordSuccessfulLocator)
- `server/services/mcp.js` (broadcast `mcp.snapshot.preview` WS event)
- `server/routes/knowledgeBase.js` (add `POST /:id/heal-now`)
- `src/pages/Theater.jsx` (DOM snapshot pane)
- `src/pages/BlockedItems.jsx` (Heal-now button on selector_drift)
- `src/pages/KnowledgeBase.jsx` (health timeline, top-flaky, search)
- `src/store/runStream.jsx` (handle `mcp.snapshot.preview`)
- `CLAUDE.md` (add convention: "every Conductor tool call records intent on success")

**Estimate:** 2 sessions (8 working hours). E1.1 + E1.2 + E1.3 first session; E1.4 + E1.5 second.

---

# PHASE E1.7 — Sprint-aware KB priming ✓ (2026-05-25)

A manager-facing question that exposed a real gap: today the KB is consulted only on failure (the Healer reads it when a tool errors). That means Sprint 2 is *not* genuinely faster than Sprint 1 — the agent rediscovers every locator via trial-and-error and only saves time when something breaks. To deliver on the "the platform learns the site after the first sprint" promise, the agent must proactively *use* prior locator knowledge on the first attempt of every action.

## E1.7.1 — Proactive KB injection into the Conductor

At the start of every run, load all non-quarantined `KnowledgeBaseLocator` rows for the project (`healthScore >= QUARANTINE_HEALTH`), order by `(healthScore desc, occurrences desc)`, cap at 50 entries. Format into a `## Known locators on this site` block prepended to the Conductor's per-case system prompt — alongside the existing `testCredentialsBlock` and supervisor guidance.

Block shape (one bullet per row):
```
## Known locators on this site (from prior runs — prefer these on first try)
- "Login button" — role=button, name="Sign in" — last selector: getByRole("button",{name:"Sign in"}) — health 95
- "Email field" — role=textbox, name="Email" — last selector: getByLabel("Email") — health 100
- (… up to 50 rows …)
If a known locator no longer matches, the healer will refresh it on failure — you don't have to be careful, just use it.
```

The prompt instruction tells the agent: when you need an element matching one of these intents, prefer the known locator over guessing. Healing still catches drift.

## E1.7.2 — Architect prompt context

Add a one-line preamble to the Architect's system prompt when the project has ≥ 1 prior `Run`:

> This project has been tested before. The Knowledge Base holds locators the agent has already learned for this site. Bias scenarios toward modules and pages the team has covered before so the existing locators get re-exercised.

Cheap (no extra Claude call); it just tells the Architect to lean on continuity instead of always generating fresh exploratory scenarios.

## E1.7.3 — Sprint-aware framing on retry

When the run's `sprintId` is set AND the project has prior completed sprints, the Conductor prompt gets a short addendum:

> Active sprint: <name>. Prior sprints on this project have already mapped the major flows. If you're touching a known surface, use the locators above. Save attempts for surfaces the prior sprints didn't cover.

## E1.7.4 — Acceptance criteria

- A second run against the same site (same project, same approved cases) reaches `RESULT: pass` in fewer Conductor turns on average than the first run. Measure via `AgentRun.log` turn counts.
- The Conductor's system prompt visibly contains the `## Known locators on this site` section when KB has ≥ 1 row.
- A locator with `healthScore < 30` is NOT in the injected list — the agent is never told to use a quarantined entry.
- An empty KB (brand-new project) produces no injection (block omitted, not rendered as "no known locators").

## E1.7.5 — Files touched

- `server/routes/agents.js` — load KB at `runConductorWithRetries` entry; format and thread as `knownLocatorsBlock` through to `runOneCase`.
- `server/services/agents/conductor.js` — accept `knownLocatorsBlock` param; inject into `baseSystem` between `testCredentialsBlock` and supervisor guidance.
- `server/services/agents/architect.js` — append the prior-runs preamble to the system prompt when the route passes `priorRunCount > 0`.

**Estimate:** 0.5 session.

---

# PHASE E1.6 — On-page instruction reader ✓ (2026-05-25)

Real failure observed in production smoke: a login page whose copy said "Click **Register** first to create an account" was ignored by the agent, which kept retrying the login form with fabricated credentials until the loop-guard tripped. The MCP snapshot DID contain the instructional text — the agent just didn't read it because the existing D1 extractor only surfaces `role="alert"` and `role="status"` nodes.

This phase teaches the agent to read on-page guidance the same way a human QA would: scan the visible text for actionable verbs, and (when looping) ask Claude vision to summarise what the page is telling the user to do.

## E1.6.1 — Snapshot text reader (cheap, no Claude call)

Extend [server/services/agents/conductor.js](server/services/agents/conductor.js) `extractPageErrors` (which D1 introduced) with a sibling helper `extractPageInstructions(snapshot)`. Returns `string[]` of actionable instructional lines.

Heuristic — match the snapshot's paragraph / heading / listitem nodes against an actionable-verb vocabulary:

- **Verbs**: `register`, `sign up`, `create (an )?account`, `verify (your )?email`, `click`, `confirm`, `follow`, `enable`, `complete`, `set up`, `activate`, `request`, `submit`, `paste`, `enter`, `provide`, `use the .* (link|button)`, `check your inbox`, `your account.* not yet`
- **Skip patterns** to avoid noise: cookie banners, marketing copy, footer links. Filter via a short denylist (`accept all`, `privacy policy`, `terms of service`).

Inject the matches as a synthetic user message before the next Claude turn, same shape D1 already uses for alerts:

> Page instructions visible (do NOT ignore these):
> - "Click Register first to create an account before logging in."
> - "Your account must be activated via the email confirmation link."

Cap to 5 instructions per turn so a verbose page doesn't blow the context budget.

## E1.6.2 — Vision fallback (when text reader finds nothing actionable AND the loop guard fires)

Today's `MAX_IDENTICAL_TOOL_CALLS` guard fires after 3 identical retries. Before letting the loop fail outright, attempt one vision pass:

- New helper [server/services/agents/instructionReader.js](server/services/agents/instructionReader.js):
  ```
  async function readInstructions({ screenshotBase64, mediaType, provider, apiKey, model, signal, onRateLimit })
    → { instructions: string[], confidence: 0–99, summary }
  ```
- Prompt (compressed):
  > You are reading a web page screenshot. The user's QA agent is stuck retrying the same action. Look at the screenshot and tell us exactly what the page is instructing the user to do, in plain imperative steps. Return JSON `{instructions: ["step 1", "step 2"], summary, confidence}`. If the page contains no actionable instructions, return an empty array with confidence 0.
- Provider abstraction: Anthropic uses `image` content block, Gemini uses `inlineData`. Per Phase A both flagships support vision.
- Trigger: in conductor.js's loop-detection block (`newCount > MAX_IDENTICAL_TOOL_CALLS`), call `browser_take_screenshot` → pass to `readInstructions` → if `instructions.length > 0`, inject them as the next synthetic user message AND reset the loop counter for THIS tool one time. If the agent still loops after that, surrender (existing path).

## E1.6.3 — Acceptance criteria

- A login page whose visible text says "Click Register first to create an account" MUST trigger the agent to navigate to `/register` (or click the register link) on the second attempt — NOT a third login retry.
- The Theater action trail surfaces a `📜 Page instructions read` entry whenever the snapshot reader or vision fallback fires, with the extracted lines visible inline.
- A page with no actionable instructions (clean blank login) costs zero extra Claude calls — vision fallback only fires under loop-guard pressure.

## E1.6.4 — Files touched

- `server/services/agents/conductor.js` — add `extractPageInstructions`, wire into the pre-action snapshot read; vision-fallback hook on loop-guard fire.
- `server/services/agents/instructionReader.js` (new) — provider-agnostic vision agent.
- `server/services/mcp.js` — no change (existing `browser_take_screenshot` returns the image block).
- `src/pages/Theater.jsx` — surface "Page instructions read" trail entries with a different icon so the operator sees the agent reasoning over copy.

**Estimate:** 0.5 session. Slots between E1.5 and E2 — once the KB UI is up, this is the last polish on the agent-loop honesty story before E2 ratifies assertions.

---

# PHASE E2 — Critic in-loop ratification ✓ (2026-05-25)

Today's D4 takes one extra `browser_snapshot` AFTER Claude has ended its turn and feeds it to the Critic post-hoc. If the snapshot contradicts the agent's "assertions verified ✓" claim, the Critic rewrites the case to `fail` — but Claude never sees it. This is too late: a hallucinated success doesn't get a chance to self-correct mid-run.

## E2.1 — `assertion_check` tool in the MCP tool list

Register a new tool the Conductor MUST call before claiming pass on a test case:

- Tool name: `assertion_check`
- Schema: `{ assertion: string, expectedRole?, expectedText?, expectedUrlPattern? }`
- Server-side handler ([server/services/mcp.js](server/services/mcp.js)): take a fresh snapshot, scan for matching nodes, return `{ matched: bool, evidence: string }`.

Conductor's SYSTEM_PROMPT_LOOP gains the rule: "Before emitting `RESULT: pass`, you MUST call `assertion_check` for each declared assertion. Any `matched: false` flips the result to fail."

## E2.2 — In-loop Critic abort

The inline Critic (already running every 5 turns or on error) gains the ability to emit `{ verdict: 'abort_pass_claim', reasoning }`. When Conductor receives this, it injects a synthetic user message instructing the agent to re-verify before ending the turn.

## E2.3 — Acceptance criteria

- A test case where Claude clicks "submit" but the page returns a 500 error (no redirect, error banner visible) MUST fail, not pass. Today D4 catches this post-hoc; E2 should catch it pre-hoc inside the loop.
- The action trail in Reports must show the `assertion_check` calls and their results.
- A run where every assertion checks pass should complete in the same wall-clock time as today — assertion_check is fast (one snapshot scan, no Claude call).

## E2.4 — Files touched

- `server/services/mcp.js` (register `assertion_check` synthetic tool — the server fabricates the response from `getLastSnapshot()`; no real MCP roundtrip needed)
- `server/services/agents/conductor.js` (prompt update; enforce check before pass)
- `server/services/agents/critic.js` (in-loop abort verdict)
- `src/pages/Reports.jsx` (surface assertion_check rows in action trail with green/red icon)

**Estimate:** 1 session (4 working hours).

---

# PHASE E3 — Code-diff awareness (PR-driven test generation) ✓ (2026-05-25)

The wedge that DevAssure and Autonoma use. Today the Architect reads BRDs/release notes — late, noisy, often unwritten. Make it also read the actual code change.

**Shipped** — Project gains `repoUrl/defaultBranch/gitProvider` + per-user PAT in vault; GitHub read-only `fetchDiff` for PR or branch compare; `codeDiffAnalyzer` agent produces `{ summary, impactedModules, suggestedScenarios }`; Architect's `priorContext` composes the prior-runs block from E1.7 with a new `## Recent code changes` block; ProjectSetup `GitRepoEditor` + RunSuite `DiffContextCard` deliver the UI. See PHASE_LOG.md "Phase E3 — Code-diff awareness".

## E3.1 — Schema additions

```prisma
model Project {
  // existing fields
  repoUrl        String?   // git@github.com:org/repo.git or https URL
  defaultBranch  String?   // 'main' typically
  gitProvider    String?   // 'github' | 'gitlab' | 'azure'
}

model DiffContext {
  id            String   @id @default(uuid())
  projectId     String
  sprintId      String?
  ref           String   // PR number, branch name, or commit SHA
  baseRef       String   // 'main' or comparison ref
  changedFiles  String   // JSON array of {path, additions, deletions, status}
  changedModules String  // JSON array of derived module names
  summary       String?  // Claude-generated 2-sentence summary
  fetchedAt     DateTime @default(now())

  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@index([projectId, sprintId])
}
```

Migration: `20260527xxxxxx_diff_context`.

## E3.2 — Git provider clients (read-only first)

[server/services/git/github.js](server/services/git/github.js), `gitlab.js`, `ado.js`. One function each:

```
async function fetchDiff({ token, repo, prNumber?, branch? }) → { changedFiles: [{path, additions, deletions, status}] }
```

Authentication via existing `Secret` vault (per-user PAT). No write operations in E3 — that lands in E7.

## E3.3 — `codeDiffAnalyzer` agent

[server/services/agents/codeDiffAnalyzer.js](server/services/agents/codeDiffAnalyzer.js):

Input: `{ changedFiles, projectName, existingModules }`.
Output: `{ summary: string, impactedModules: [string], suggestedScenarios: [{name, priority, category, rationale}] }`.

Heuristic for `impactedModules`: filename → module mapping using:
1. Exact match to `existingModules` (case-insensitive substring).
2. Path-segment match (`src/auth/login.ts` → `auth`).
3. LLM fallback when (1) and (2) miss.

## E3.4 — Architect gains diff context

The Architect's system prompt gets an optional "Code change context" block, injected when `DiffContext` exists for the current sprint:

> The following files changed since the last release. Bias your scenario generation toward these surfaces:
> ```
> <changed files list>
> ```
> Impacted modules: `<derived>`

## E3.5 — UI

- **ProjectSetup**: new "Git repository" section — repo URL, default branch, provider dropdown, PAT input (uses `SecretInput`, stored in vault as `<provider>.pat`).
- **RunSuite**: new "Diff context" card alongside the existing requirement buckets. User pastes a PR URL or branch name; QAAI fetches the diff and shows changed files + impacted modules. Generate-scenarios picks it up automatically.

## E3.6 — Acceptance criteria

- Paste a real GitHub PR URL into a project; the `changedFiles` should populate within 5 s.
- The Architect produces ≥ 1 scenario explicitly tagged against each impacted module.
- The rationale on those scenarios cites the diff context ("Because `src/auth/login.ts` was modified, verify…").

**Estimate:** 2 sessions.

---

# PHASE E4 — Vision-based screenshot diff with semantic reasoning ✓ (2026-05-25)

Pixel-diff is old. Use Claude's vision capability to describe what changed semantically.

**Shipped** — `RunResult` gains `baselineScreenshot/visualVerdict/visualDiffSummary/visualDiffs`; first-pass writes the baseline, subsequent runs invoke `visualCritic.compare` and persist a structured verdict + diff list; Reports detail pane gets a quiet collapsible `VisualDiffSection` that auto-expands only on fail/inconclusive. Visual verdict is advisory — it never overrides the test's own pass/fail. See PHASE_LOG.md "Phase E4 — Vision-based screenshot diff".

## E4.1 — New `visualCritic` agent

[server/services/agents/visualCritic.js](server/services/agents/visualCritic.js):

Input: `{ baselineScreenshotPath, currentScreenshotPath, expectedAssertion, provider, apiKey, model }`.
Output: `{ verdict: 'pass'|'fail'|'inconclusive', diffs: [{region, before, after, severity}], summary }`.

Uses Anthropic's `image` content block. For Gemini: `inlineData` with the image bytes. Both providers support vision on their current flagship models.

## E4.2 — Baseline capture

The first successful run of a test case writes its final screenshot as the baseline (`RunResult.baselineScreenshotPath`, new column). Subsequent runs compare against it.

```prisma
model RunResult {
  // existing
  baselineScreenshotPath String? // path to the baseline image (first pass)
  visualVerdict          String? // last visualCritic verdict
  visualDiffSummary      String? // last visualCritic narrative
}
```

## E4.3 — Wire into Critic

When the post-hoc Critic concludes `fail` AND the failure mode looks visual (e.g., assertion was about an element being visible, but the trail shows no MCP-level error), invoke `visualCritic` automatically. Surface its output in Reports.

## E4.4 — UI

Reports detail pane gets a new "Visual diff" section under the existing screenshots strip. Shows the baseline + current side-by-side with the semantic narration: "Submit button moved from bottom-right to bottom-centre. Confirmation banner colour changed from green to amber."

**Estimate:** 1 session.

---

# PHASE E5 — Model cost routing ✓ (2026-05-25, routing-only)

**Shipped (routing only — visibility deferred)** — `server/lib/modelRouter.js` exposes `resolveModelForTier({ provider, requestedModel, tier })`. Each mid-tier agent (Analyst, Reporter, RCA chat, Blockage Analyzer, Diff Analyzer, Healer, Instruction Reader) declares `const TIER = 'mid'` and computes its routed model inside `run()`. Mid-tier always routes to Haiku 4.5 / Gemini 2.5 Flash regardless of the operator's flagship Settings choice — maximum savings for BYOK users. Flagship agents (Architect, Planner, Conductor, Critic, Supervisor, Visual Critic) respect the Settings model. No per-project override UI in v1 and no cost-visibility panel — operator chose routing-first; visibility is a future phase. See PHASE_LOG.md "Phase E5 — Cost routing".

Today every agent runs on the project's Sonnet/Gemini-Pro. Reporter prose and rcaChat don't need flagship models.

## E5.1 — `lib/modelRouter.js`

```js
const MODEL_ROUTES = {
  architect: { tier: 'flagship' },        // Sonnet 4.6 / Gemini 2.5 Pro
  planner: { tier: 'flagship' },
  conductor: { tier: 'flagship' },
  critic: { tier: 'flagship' },           // critic stays flagship — too high-stakes
  supervisor: { tier: 'flagship' },
  analyst: { tier: 'mid' },               // Haiku 4.5 / Gemini 2.5 Flash
  reporter: { tier: 'mid' },
  rcaChat: { tier: 'mid' },
  blockageAnalyzer: { tier: 'mid' },
  visualCritic: { tier: 'flagship' },     // vision needs Sonnet/Gemini-Pro
  healer: { tier: 'mid' },                // DOM-reading is well within Haiku
  codeDiffAnalyzer: { tier: 'mid' },
};

function resolveModel({ agentName, provider, projectOverride }) → string
```

## E5.2 — Per-project override

`Project.modelOverrides String?` JSON-encoded `{architect: 'claude-opus-4-7', healer: 'claude-haiku-4-5-20251001'}`. UI in Settings → AI Provider lets the user pick per-agent.

## E5.3 — Acceptance

- Reporter runs on Haiku 4.5 by default. Token cost on a 50-case suite drops by ≥ 60% versus pre-E5 baseline (measure via the rate-limit chip's totals).
- A project that overrides `critic: 'claude-opus-4-7'` actually uses Opus for critic calls (verifiable via `RunResult.modelUsed` — new column).

**Estimate:** 1 session.

---

# PHASE E6 — AST-based lint engine ✓ (2026-05-25, Option C)

**Shipped (Option C — additive)** — `server/lib/specAst.js` is a new file using `@babel/parser` + `@babel/traverse` (zero new deps; both already in node_modules via Vite) that contributes five scope-aware rules: `ast-missing-await-on-locator`, `ast-assertion-without-expect-per-test`, `ast-screenshot-on-failure-missing`, `ast-brittle-locator-css-with-dynamic-class`, `ast-unused-page-locator`. Each finding is tagged `engine: 'ast'`. `lintGates.lint()` now calls both engines and merges findings; AST parse errors fall back to regex-only gracefully. Smoke-test verifies V2 acceptance — 6 AST findings on the bad spec, 0 on the good, 47 ms / 12 ms latency. See PHASE_LOG.md "Phase E6 — AST-based lint engine".

Today's `lintGates.js` is regex-on-lines. Add real parsing.

## E6.1 — `lib/specAst.js`

Use `@babel/parser` (already widely depended-on in Vite's transitive graph) to parse `.spec.ts` / `.ts` files. Cache the AST keyed on `(filename, contentHash)`.

## E6.2 — New rules

- `brittle-locator-css-with-dynamic-class`: detect `getByCss('.btn-xyz')` where the class looks generated (numeric tail).
- `missing-await-on-locator`: `page.click(...)` without `await`.
- `hardcoded-timeout`: `waitForTimeout(\d+)` calls.
- `assertion-without-expect`: `it(...)` blocks containing no `expect(...)` call.
- `screenshot-on-failure-missing`: `test.afterEach` without `if (testInfo.status !== 'passed') await page.screenshot(...)`.

Five rules to start — extensible array.

## E6.3 — Acceptance

- A deliberately-bad spec hits 4+ AST findings.
- A canonical-good spec produces 0 findings.
- Lint time on a typical 10-case suite stays under 500 ms.

**Estimate:** 1 session.

---

# PHASE E7 — Real Git provider PR push ✓ (2026-05-25, GitHub-only, both-coexist UX)

**Shipped** — `github.js` gains `createBranch / commitFile / openPullRequest / pushSpec` (idempotent on branch-already-exists). `GovernancePR` gains six provider columns. `POST /:id/push-to-git` route assembles branch + commit + PR with server-side body, audits, and updates provider state. `GET /:id/push-preview` feeds the modal. `PushToGitModal` in Governance.jsx lets operators edit branch / commit / title / path before confirming. "Push to Git" coexists alongside "Merge in QAAI" — they are different actions (one external, one internal-baseline). GitLab and Azure Repos deferred — route refuses cleanly with `PROVIDER_UNSUPPORTED`. See PHASE_LOG.md "Phase E7 — Real Git provider PR push".

Close the workflow loop the README has promised since day one.

## E7.1 — Write methods on the git clients

Extend [server/services/git/{github,gitlab,ado}.js](server/services/git/) from E3 with:

- `createBranch({ token, repo, branchName, baseBranch })`
- `commitFile({ token, repo, branch, path, content, message })`
- `openPullRequest({ token, repo, head, base, title, body }) → { number, url }`

## E7.2 — Governance merge wires real PR

[server/routes/governance.js](server/routes/governance.js) gains:

- `POST /:prId/push-to-git` — assembles the GovernancePR's `specCode` into a branch, commits, opens a PR, returns the provider URL.
- Updates `GovernancePR.providerPrNumber`, `providerPrUrl`, `providerStatus`.

## E7.3 — UI

[src/pages/Governance.jsx](src/pages/Governance.jsx) — when a PR is approved, "Merge" button becomes "Push to Git". Modal shows: target repo, branch name, commit message preview. On success: PR card shows the external URL with a chip ("GitHub PR #1234").

## E7.4 — Acceptance

- Approving a GovernancePR and clicking "Push to Git" creates a real branch + PR in the configured repo.
- The PR description includes the QAAI run link, lint findings, and the BRD requirement IDs.
- If the repo doesn't exist or the PAT lacks permissions, the action fails cleanly with a 4xx and an actionable toast.

**Estimate:** 2 sessions.

---

# PHASE E8 — Multi-tenancy substrate ◐ (Part 1 of 2 — 2026-05-25)

**Part 1 shipped — secure isolation substrate.** `Organization` / `OrgMembership` / `OrgInvite` models added; `orgId` columns on Project, Secret, Integration, WebhookConfig, NotificationChannel, AuditLog. Backfill migration creates a Solo org per existing user, sets `User.currentOrgId`, tags every owned row. `requireOrg` middleware loads + verifies org on each request. Auth signup auto-creates a Solo org. 14 route files (every project-scoped router) updated to filter by orgId instead of userId. Settings/Webhook/Notification routes deliberately left per-user for now. Isolation acceptance verified by `smoke-org-isolation.js` — User B can't see User A's project via forged URL. See PHASE_LOG.md "Phase E8 (Part 1 — substrate)".

**Part 2 deferred to next session** — invite flow (POST /api/org/invite, accept-invite token endpoint), role enforcement (requireOrgRole on destructive endpoints), org-management UI (Settings → Organization, org name in PageHeader, member list, invite/remove). User picked the full "substrate + invite + roles" scope; Part 1 ships the isolation layer that everything else rests on.

Adds `orgId` everywhere. The most invasive phase but conceptually simple.

## E8.1 — Schema

New `Organization` model. `orgId` added to: User, Project, Secret, Integration, WebhookConfig, NotificationChannel, AuditLog. Cascaded delete on Organization.

## E8.2 — Middleware

`requireOrg(req, res, next)` reads `req.user.orgId`, attaches to `req.org`, and ALL queries get an automatic `where: { orgId }` injection via a Prisma extension.

## E8.3 — Migration

User signup picks an org (or creates one). Existing single-user data backfills into a default "Solo" org for the current user.

## E8.4 — Acceptance

- A user from Org A cannot see Project from Org B even with a direct API call (verified by curl with a forged URL).
- Audit log captures `orgId` on every entry.

**Estimate:** 2 sessions. Touches many files but each touch is mechanical.

---

# PHASE E9 — Postgres swap + JSON-as-String cleanup ⏸ (infra-blocked, deferred 2026-05-25)

**Status:** explicitly deferred until production infra exists. Cannot ship locally — flipping `provider = "postgresql"` without a Postgres instance breaks the dev loop; KMS and object-storage migrations need cloud accounts. The schema is already E9-friendly (every E1–E8 column is additive nullable) so when infra lands this is a clean one-pass migration.

Deferred until last per Sravan's direction. Recipe is already in [README.md](README.md#sqlite-vs-postgres-tradeoffs-in-this-codebase).

## E9.1 — Schema flip

Change `prisma/schema.prisma` provider to `postgresql`. Convert all 7 String-JSON fields to native `Json`:

| Model.Field | Current | Target |
|---|---|---|
| Integration.config | String | Json |
| WebhookConfig.events | String | String[] |
| WebhookDelivery.payload | String | Json |
| Run.config | String? | Json? |
| GovernancePR.lintFindings | String? | Json? |
| AuditLog.metadata | String? | Json? |
| RunResult.screenshots | String | String[] |

Plus the new fields E1–E8 added (healHistory, modelOverrides, etc.) get their proper Json types from this migration onward.

## E9.2 — Call-site cleanup

Delete `server/services/jsonField.js`. Grep for `encodeJson`, `encodeArray`, `decodeJson`, `decodeArray` — every call site removes the wrapper because Prisma now returns native types.

## E9.3 — Vault key to KMS

Move `VAULT_MASTER_KEY` from `.env` to Azure Key Vault or AWS KMS. Per-tenant DEK with envelope encryption.

## E9.4 — Object storage

Migrate `playwright/test-results/` + `/artifacts/live/` to S3 or Azure Blob. Add signed-URL generation to the existing `/artifacts/*` static route.

## E9.5 — Acceptance

- `npx prisma migrate dev` against a fresh Postgres applies cleanly.
- Every existing UI flow works against Postgres — verified by running the manual smoke test from README.md.
- A run produces artifacts in Blob storage, not local FS, and the Reports page renders them via signed URLs.

**Estimate:** 3 sessions (schema, migration verification, object storage migration).

---

# PHASE E10 — Production operations ◐ (local subset shipped 2026-05-25; infra parts deferred)

**Status:** E10.3 (per-user daily token budget) and E10.4 (circuit breaker on `provider.complete`) shipped — both are local-runnable protective primitives that work without external infra. E10.1 (browser pool — Docker/BullMQ/Redis) and E10.2 (OpenTelemetry traces — Grafana/Datadog backend) are explicitly deferred until production infra exists; building either locally would produce untested scaffolding that may not work when infra arrives.

See PHASE_LOG.md "Phase E10 (local-runnable subset)" for the full ship notes. The breaker is keyed per provider (claude/gemini), trips after 5 consecutive 5xx/503/network failures within 60s, and exposes state via `GET /api/budget/breaker`. The budget defaults to 5M tokens/user/day (`BUDGET_DEFAULT_DAILY_TOKENS` env), tracks per-provider, and surfaces in PageHeader as a hidden-by-default chip that only appears at ≥ 50% usage.

The last mile. Required for real-time deployment beyond demo.

## E10.1 — Browser pool

Containerise the Playwright worker. New service `qaai-runner` — a Docker image that boots, accepts a job from BullMQ, runs the MCP subprocess, reports back. Autoscaling group of 2–10 workers behind a queue.

## E10.2 — Observability

OpenTelemetry traces from Express request → agent → `provider.complete` → MCP tool. Spans surface in Grafana / Datadog. Logs JSON-structured.

## E10.3 — Cost guardrails

Per-org daily Claude/Gemini budget. Block new runs with a clear toast when 90% consumed. Refill at UTC midnight.

## E10.4 — Circuit breakers

`provider.complete` wrapped in a circuit breaker (opossum or hand-rolled). Open after 5 consecutive 5xx; close on first success after a 30 s cool-down.

## E10.5 — Acceptance

- 10 concurrent runs across 3 orgs complete without server CPU saturation.
- A simulated Claude outage triggers the circuit breaker; in-flight runs degrade to "BLOCKED: upstream unavailable" cleanly.
- Daily budget enforcement shows up in the UI as a header chip.

**Estimate:** 3+ sessions. Crosses into devops territory.

---

# Cross-cutting hygiene (do continuously, not as a phase)

- **CLAUDE.md updates** — every architectural convention that lands in E1–E10 gets added to the "Conventions" section. The healer-records-intent-on-success rule, the assertion_check rule, the model-router-default-tier rule.
- **PHASE_LOG.md entries** — one per shipped sub-phase. Scope / built / decisions / open items / files / verification (same template as existing entries).
- **No mock data, ever.** Every E1+ feature ships with EmptyState handling.
- **Cancellation hygiene** — every new agent (healer, codeDiffAnalyzer, visualCritic) accepts `signal` and propagates it to `provider.complete`. Per CLAUDE.md cancellation pattern.
- **Project-scoped WS guard** — every new WS message that carries `projectId` honours the existing guard rule.

---

# Estimating the total

| Phase | Sessions | Cumulative |
|---|---|---|
| E1 — self-healing | 2 | 2 |
| E2 — in-loop critic | 1 | 3 |
| E3 — code-diff | 2 | 5 |
| E4 — visual diff | 1 | 6 |
| E5 — cost routing | 1 | 7 |
| E6 — AST lint | 1 | 8 |
| E7 — git push | 2 | 10 |
| E8 — multi-tenancy | 2 | 12 |
| E9 — Postgres | 3 | 15 |
| E10 — prod ops | 3+ | 18+ |

A session ≈ 4 focused working hours. ~12 sessions to "outstanding without production hardening." ~18 sessions to "deployable as multi-tenant SaaS."

---

# What to do in the next session

**V2 plan substantially complete as of 2026-05-25.** What shipped this run cycle:

- E1 (self-healing), E1.6 (instruction reader), E1.7 (KB priming) ✓
- E2 (in-loop critic) ✓
- E3 (code-diff awareness) ✓
- E4 (vision diff) ✓
- E5 (cost routing, routing-only) ✓
- E6 (AST lint, option C additive) ✓
- E7 (Git PR push, GitHub-only, both-coexist UX) ✓
- E8 Part 1 (multi-tenancy substrate + isolation acceptance) ✓
- E10.3 + E10.4 (budget cap + circuit breaker) ✓

**What remains, all explicitly infra-blocked or deferred at user direction:**

- E8 Part 2 — invite flow + role enforcement + Org-management UI. Deferred by Sravan; substrate is enough for "outstanding without production hardening."
- E9 — Postgres + KMS + object storage. Requires real infra (no local Postgres / no Azure or AWS account on this laptop).
- E10.1 / E10.2 — browser pool + observability. Requires Docker, BullMQ/Redis, and a tracing backend.
- Various V2 follow-ups (E5 cost-visibility panel, E7 GitLab + ADO providers, E7 GitHub merge-webhook) — judged premature by Sravan; revisit when a user actually asks.

**Original "what to do next" (E1.1 + E1.2) preserved below for historical reference; superseded by the completion above.**

**Start E1.1 + E1.2.** Concrete order:

1. Add the schema columns to `KnowledgeBaseLocator`. Generate the migration. Apply.
2. Create `server/services/agents/healer.js` with the system prompt and the JSON output schema.
3. In `conductor.js`, wrap `mcp.callTool` with the failure-detection intercept that calls the healer.
4. Add `recordSuccessfulLocator` and call it on every success path.
5. Verify with the canonical test: rename a `data-testid` on a known page, run a case that targets it, watch the healer resolve, confirm the heal lands in `KnowledgeBaseLocator.healHistory`.
6. Append a PHASE_LOG.md entry. Mark Phase E1.1/E1.2 ✓ in this file.

Do NOT start E1.4 (UI) until E1.2 is verifiably working end-to-end. The infrastructure must heal correctly before we surface the snapshot pane.

---

# Open questions parked for Sravan

These don't block work — flagged so the next session asks before guessing.

- **Healer model default**: route to Haiku 4.5 (cheap, fast, sufficient for DOM-reading) OR Sonnet 4.6 (more reliable, higher cost)? Plan assumes Haiku. Override per-project if it under-performs.
- **First-sighting capture trigger**: only on Conductor's first run of a test case, or on every run that successfully touches the locator? Plan assumes "every run, idempotent upsert" — captures DOM drift over time.
- **Locator quarantine threshold**: `healthScore < 30` per E1.6. Could be 20 or 40. Plan picks 30 as the median pessimistic value.
- **Visual diff baseline ownership**: per-project baselines vs per-sprint baselines? Plan assumes per-project (first successful run owns the baseline forever, unless explicitly cleared). Sprint-level baselines are a Phase B+ idea.

These are documented here so they're not surprises later.

---

*End of BUILD_PLAN_V2.md. Append phase completion notes to PHASE_LOG.md as work ships; update the status marker per phase in this file.*
