# QAAI Portal — External Agent Brief: Testing Architecture Review

**Written:** 2026-05-30  
**Purpose:** This file is meant to be read by a fresh Claude session (or any capable AI agent). It explains the full QAAI project from first principles and asks for a focused, honest opinion on how to improve the **testing and validation layer** specifically for enterprise-level websites. The team who built this has already run real validation sessions against several live websites. They want fresh eyes on what is architecturally weak and what could be improved.

---

## What Is QAAI Portal?

QAAI (Quality AI) is an autonomous QA platform. The promise is: **upload requirement documents in the morning, get a release-confidence recommendation by lunch.**

It is not a low-code test recorder. It is not a Selenium wrapper with a UI. It is an AI-agent pipeline that reads Product Requirement Documents (PRDs), Business Requirement Documents (BRDs), and release notes, then:

1. **Proposes test scenarios** via an AI Architect agent
2. **Lets QA leads approve, reject, or modify** the scenarios
3. **Executes them autonomously** against a real browser via Playwright MCP
4. **Triages failures** via a Critic and Supervisor agent
5. **Generates a release recommendation** (GO / HOLD / NO_GO) with a Root Cause Analysis report

The target user is a QA Lead or SDET at a 50–500 engineer company. They are accountable for release confidence but understaffed for the feature volume their teams ship. They do not have time to write Playwright scripts by hand for every sprint.

---

## Tech Stack

```
Frontend:  React 19 + Vite 6 + Tailwind CSS (custom design tokens, no raw utility classes)
Backend:   Node.js + Express
Database:  SQLite (dev), Postgres (prod) via Prisma 5.22
AI:        Claude Sonnet 4.6 (primary), Gemini 2.5 Flash/Pro (secondary)
Browser:   Real Playwright MCP subprocess (@playwright/mcp) — NOT a mock
Auth:      JWT + bcrypt, single-user for now (multi-org substrate added)
```

The backend is a thin Express API. All domain logic lives in `server/services/`. The AI agent layer is in `server/services/agents/`. There is no separate orchestration service — everything runs in the same Node process.

---

## The Full Agent Pipeline

When a run is executed, this is the exact sequence:

```
1. ARCHITECT agent
   Input:  Uploaded docs (BRD, release notes, user stories, API specs)
   Output: Structured scenario list [{name, steps, assertions, priority, module}]
   LLM:    Claude/Gemini (flagship tier)

2. QA LEAD (human)
   Reviews architect output, approves/rejects/modifies scenarios
   Can add per-project guidance ("always test with role: admin")

3. PLANNER agent  ← deterministic now (Kahn topological sort, no LLM)
   Input:  Approved scenarios + dependency graph
   Output: Execution wave plan (which scenarios run in which order)

4. CONDUCTOR agent  ← the heart of the execution loop
   Input:  Wave plan + live browser (Playwright MCP)
   Per-case loop: calls browser tools, reads snapshots, verifies assertions
   Emits: browser_navigate, browser_click, browser_fill_form, browser_snapshot
   Output: pass | fail | blocked | skipped per case
   LLM:    Claude/Gemini (flagship tier, ~50 turns per case)

5. CRITIC agent
   Inline: triggers mid-loop when an assertion_check returns matched=false
   Post-loop: verifies the conductor's claimed status against the final DOM snapshot
   LLM:    Claude Haiku / Gemini Flash (mid-tier)

6. SUPERVISOR agent
   Triggers when a case fails — rewrites the case guidance and retries once
   LLM:    Claude (flagship)

7. REPORTER agent
   Writes a structured Root Cause Analysis per run
   Adaptive token budget: scales with failure count
   LLM:    Claude (flagship)

8. RELEASE RECOMMENDATION engine  ← deterministic
   Reads: pass/fail/blocked/skipped counts, coverage %, run history
   Outputs: GO (≥80% pass, no P0 failures) | HOLD | NO_GO
```

---

## What Has Been Validated So Far

The team has run real end-to-end sessions against several live websites. The sites include:

- **`practice.expandtesting.com`** — the primary testing ground. Login flows, registration, form validation, RBAC pages. Multiple full runs with 15–20 test cases per run.
- **`saucedemo.com`** — standard e-commerce demo. Login → product browsing → cart → checkout.
- **`orangehrm.com`** — HR management demo app. Login, employee management, leave management.

**Observed pass rate from the baseline corpus (as of 2026-05-28):**  
`16 runs / 109 test cases / 12.8% pass rate / 68.8% blocked rate`

That blocked rate is the key problem. Most cases are not *failing* in the test-is-wrong sense — they are getting *blocked*: the agent cannot complete the interaction because of selector issues, credential issues, unexpected modal popups, session state not being set up correctly, etc.

---

## Current Testing Architecture — The Honest State

### How assertion checking works

Each test case carries a set of `declaredAssertions` the Architect authored, each with:
- `assertionType`: TEXT_PRESENT | URL_MATCH | ELEMENT_VISIBLE | ELEMENT_NOT_VISIBLE | CUSTOM
- `expectedText` / `expectedUrlPattern` / `assertionQuery`
- `priority`: required | recommended | optional

The Conductor calls a synthetic `assertion_check` tool (not a real MCP tool — it's a fabricated tool response built from `mcp.getLastSnapshot()`). This tool returns `matched: true | false | uncheckable`.

**Three-way verdict logic:**
- All required assertions `matched: true` → `pass`
- Any required assertion `matched: false` → Critic triggered inline → may flip to `fail`
- `uncheckable` → demotes to `needs_human`

**Post-loop ratification** (`server/services/postLoopRatify.js`) re-evaluates all assertions against the final snapshot after the conductor loop ends, as a second check on the conductor's self-reported status.

### Known weaknesses that have already been diagnosed

**1. Assertion grounding problem (partially fixed)**
The Architect hallucinates `expectedText` values — strings that don't appear in the source documents. A `markUngroundedText` pass now demotes these to `parseFailed: 'text_ungrounded'` → `needs_human` instead of letting them cause false failures. Same fix applied to URL patterns (`markUngroundedUrl`). But the grounding is still regex/substring-based — not semantic.

**2. URL assertion temporal problem (partially fixed)**
A URL assertion like "page should be /dashboard after login" is checked at assertion_check time, which may be mid-navigation. A three-way temporal model now exists: `current` (URL matches right now), `transient_window_missed` (URL was visited but page moved on), `agent_never_reached` (URL never appeared in the navigation history). But this model depends on the Conductor having correctly recorded its navigation history — gaps in that recording produce wrong temporal judgments.

**3. The selector/locator problem (partially fixed)**
The Knowledge Base (`KnowledgeBaseLocator`) stores selectors that worked in previous runs. The healer (`server/services/agents/healer.js`) fires when a locator fails — it re-reads the DOM and proposes an alternative. But:
- The healer uses its own LLM call (Haiku), which adds latency and token cost mid-case
- Quarantined locators (healthScore < 30) are refused but the case is then `blocked` — there's no fallback
- The architect now reads quarantined locators as "avoid these elements" to prevent re-generating scenarios around broken selectors

**4. The credential problem (fixed)**
Early runs failed catastrophically because the conductor would fabricate login credentials when none were provided. Fix: `Project.testCredentials` stores real test user credentials; the conductor's system prompt explicitly says "if a case needs login and no credentials are listed here, emit BLOCKED: no credentials" instead of guessing.

**5. The action repetition / loop problem (fixed)**
Conductor was entering retry loops — clicking the same button 10 times because it didn't read the error banner in the DOM. Fixes: per-turn snapshot pre-processing extracts `role=alert` nodes and prepends them as "Page error visible: X"; an action-repetition guard hard-stops after 3 identical calls.

**6. Page Identity / navigation confidence**
There is a multi-signal page-identity check (role=2, text=1, url=1, threshold=2) in `mcp.js`. This is used to decide "has the page changed after this action?" But for SPAs with heavy client-side routing, the URL doesn't change and the accessibility tree diff can be small — the agent can be on the wrong logical page and not know it.

---

## What Is NOT Yet Done (Testing-Relevant Gaps)

These are tracked but unbuilt:

### Phase H — Verdict and Stability Architecture (the big one)

A two-architect review in May 2026 concluded the current single-pass verdict is brittle. The proposed architecture is a three-phase decoupling:

**Phase H.1 — Mechanical verdict layer**  
Replace the "conductor claims pass → Critic spot-checks" flow with a dedicated `assertion_check` that runs deterministically from the DOM snapshot after each case. `matched | not_matched | uncheckable` — no LLM in the hot path for yes/no questions. In-flight already (verdictMode: 'mechanical_v1' is a flag, 15% of runs).

**Phase H.2 — Replay harness**  
A pure-Node CLI: `{candidate, baseline, fixtures, scenario_filter}` → per-scenario delta + aggregate. CLAUDE.md says all cost and quality claims require harness evidence. Today the harness is stubs — 4 ad-hoc check scripts hardcoded to specific runIds, not a runnable system. The baseline corpus (16 runs / 109 cases) is captured but the runner isn't built.

**Phase H.3 — Calibrator**  
An agent that reads the SUT (system under test) live *before* the Architect generates scenarios — it crawls the site, maps pages, captures real selectors, and hands a "site atlas" to the Architect. Today the Architect generates scenarios blind (from text documents only). The Calibrator would eliminate the entire class of "scenario references a page that doesn't exist" failures.

### Other known gaps

- **Cross-run learning for blocked cases**: `Phase G` ships a `FailurePattern` store where blocked cases are analyzed post-run by a `postMortem` agent. The pattern is stored and the next run's Conductor sees it as prior context ("last time we hit `/checkout`, the cart session was stale — refresh before asserting"). This is partially shipped but the feedback loop is incomplete.
- **Visual assertion**: `VisualCritic` agent exists but is not in the main conductor loop.
- **Network/API assertion**: There is no HTTP-level assertion — only DOM-level. Enterprise apps that trigger background API calls with visible side effects (e.g. "save succeeded" toast after a POST) are partially covered only if the DOM changes visibly.
- **Multi-tab / popup flows**: Playwright MCP supports multiple pages but the conductor's loop is single-tab. Flows that open a new tab (OAuth popup, print preview, document viewer) are `blocked` immediately.
- **File upload**: The system prompt has a "Tricky-page playbook" entry for file uploads. The `autoAcceptDialogs` flag handles OS file picker interception. But this is convention, not tested systematically.
- **Authentication state between cases**: The conductor runs each case as a fresh browser context (no session carry-forward). For flows that require a previous case's state (e.g. "register a user" → "log in as that user" → "delete that user"), this breaks unless the credentials are pinned in `testCredentials`.

---

## The Numbers That Matter

From `scripts/stage0-output/baseline.json` (the canonical baseline, 2026-05-28):

```
Total runs:       16
Total cases:      109
Pass rate:        12.8%   (14 cases)
Blocked rate:     68.8%   (75 cases)
Fail rate:         ~18%   (remaining)
```

This baseline exists on a dev machine with real Playwright MCP running against live internet sites. It is the fixture against which Phase H changes are measured.

The goal Phase H sets: **run N+1 must be cheaper than run N for the same project, and more cases must reach a verdict (pass or fail) instead of blocked.**

---

## Architecture Files Worth Reading (if the agent wants code context)

| Concern | File |
|---|---|
| Full platform invariants | `CLAUDE.md` |
| Phase history | `BUILD_PLAN.md` + `PHASE_LOG.md` |
| Execution loop | `server/services/agents/conductor.js` |
| Assertion check | `server/services/mcp.js` (`_checkAssertionOnce`, `listAnthropicTools`) |
| Verdict computation | `server/services/computeVerdict.js`, `server/services/postLoopRatify.js` |
| Locator healing | `server/services/agents/healer.js` |
| Scenario generation | `server/services/agents/architect.js` |
| Provider abstraction | `server/lib/llmProvider.js`, `server/lib/providers/gemini.js` |
| Credential resolver | `server/lib/resolveAiCredentials.js` |
| JSON parsing safety | `server/lib/parseJsonResponse.js` |
| Knowledge base | `server/services/agents/conductor.js` → `recordSuccessfulLocator` |
| Error classification | `server/lib/errorClassify.js` |
| Failure patterns (cross-run) | `server/services/agents/postMortem.js` |
| Prisma schema | `prisma/schema.prisma` |

---

## The Question for the Agent Reading This

**The core ask:** Given everything described above, what are your concrete recommendations for improving the testing and validation layer specifically for **enterprise-level websites**?

Enterprise websites are different from practice/demo sites in important ways:
- They require SSO / SAML / OAuth flows (not simple username+password)
- They have complex role hierarchies (not just admin/user)
- They have data isolation requirements (test data must not pollute prod data)
- They have heavy JavaScript SPAs with server-side rendering or hydration
- They often have feature flags that change the DOM between deployments
- They have rate limiting that can trigger during automated runs
- They have complex multi-step workflows (approval chains, multi-party signoff)
- They often use iframes (embedded analytics, chat widgets, payment widgets)
- Page load times are unpredictable (CDN variation, regional data centers)

We have already validated a handful of demo-grade sites and have a 12.8% pass rate there. We are preparing to use this on real enterprise software. The blocked rate of 68.8% is unacceptable for enterprise use.

### Specific sub-questions for the agent:

1. **Assertion design at enterprise scale**: Our current assertion model is DOM-snapshot-based. For enterprise apps, is there a better assertion strategy that doesn't require the exact DOM to match? What layer should assertions live at for a system claiming to validate enterprise software?

2. **State management between test cases**: Enterprise flows require state handoff (user created in step 1 must exist in step 3). Our current approach pins credentials in a JSON blob. What is the right architecture for test state management in an agentic loop?

3. **Authentication complexity**: We handle simple login forms. Enterprise sites use SAML, Okta, Azure AD, Google Workspace SSO. The Playwright MCP subprocess handles cookies/sessions, but the agent needs to navigate SSO flows. What patterns work here without compromising the agent's autonomy?

4. **The blocked rate problem specifically**: 68.8% of cases are blocked, mostly due to selector drift and incomplete state setup. Is the Knowledge Base + healer architecture fundamentally the right approach, or is there a better model for selector resilience at this scale?

5. **Scenario generation quality**: The Architect generates scenarios from documents. For enterprise apps, the documents are often incomplete, stale, or contradictory. What is a better grounding strategy than "cite from source document or demote"?

6. **Test isolation and repeatability**: How should an agentic executor handle tests that mutate shared state? The current approach has no test data lifecycle management. For enterprise validation, this is critical.

7. **Confidence calibration**: Our GO / HOLD / NO_GO recommendation is based on pass %. For enterprise, a 95% pass rate with 2 failing P0 cases in the payment flow is a NO_GO, but a 60% pass rate with all failures in a low-risk admin page might be a GO. How should the recommendation engine be redesigned to reflect business risk, not just test counts?

---

## What the Team Has Already Tried / Decided (So You Don't Repeat It)

- **MCP is NOT the problem.** The Playwright MCP subprocess (`@playwright/mcp`) returns correct DOM snapshots. The agent's *use* of them is what fails. Don't suggest switching the browser automation layer.
- **Low-code recorder is rejected.** This is not Selenium IDE. The team explicitly does not want scenario authoring to be manual.
- **Jira / ticket integration is out of scope.** QAAI is not a ticket tracker. It exposes data for escalation; it doesn't own workflows.
- **The planner is now deterministic (Kahn sort).** It used to be an LLM call. That was eliminated. Don't suggest re-introducing an LLM planner.
- **Parallel execution is not yet in scope.** All cases run sequentially per run (wave-based, but within a wave, sequential). Parallel execution would require multiple MCP subprocesses.
- **GitHub integration is explicitly not wanted by the user** for the current phase.

---

## How to Structure Your Response

Please don't give bullet sketches. The team has read a lot of those. What they want is:

1. **Your honest assessment** of what is fundamentally wrong with the current approach for enterprise validation (not just iteration on what's there, but architectural critique).
2. **Concrete mechanisms** — not "improve assertion logic" but "here is the specific structure that makes assertion logic resilient to DOM churn".
3. **Priority order** — what to fix first given the 68.8% blocked rate is the most urgent problem.
4. **What the team is missing that they haven't even asked about** — the blindspots that come from building in one direction for too long.

The team trusts technical depth over polished recommendations. Write as if you are the senior engineer who just joined and read the whole codebase.
