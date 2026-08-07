# IMPROVEMENTS NEEDED — QAAI

*Generated 2026-05-29. Based on a forensic audit of the agents, services, libs, schema, and the architectural conversation that preceded this file.*

This is a working list of concrete, citation-backed improvements — defects to fix, cost wins to take, AI calls that should be deterministic code, and architecture smells worth addressing.

**Reliability principle (non-negotiable).** Per CLAUDE.md, we use LLMs where there is genuine reasoning under ambiguity and Node where there isn't. This file is conservative: AI→code substitutions are flagged only when a senior engineer would say "yes, that's wasteful AI usage." Aggressive token-cutting that compromises verdict integrity is *not* included.

Findings are grouped by priority bucket. Each finding includes a file path with line range, the actual issue, a concrete fix, and the risk if unfixed.

---

## P0 — Defects (must-fix)

These are real bugs in the code today, not theoretical concerns. Each one has been verified against the current source.

### P0-1 — `evaluateAssertionGate` is contaminating the data we'll use to decide mechanical-mode rollout

**Location:** [server/services/agents/conductor.js:3396-3409](server/services/agents/conductor.js#L3396-L3409), with the case-level gate check at [conductor.js:903-910](server/services/agents/conductor.js#L903-L910).

**Issue.** The Stage-1.5 assertion-gate soft-fail observation runs after the mechanical_v1 verdict has already replaced `status` (line 3292), but it reads the *legacy* `assertions` string and the *legacy* `assertionCheckResults` array. In mechanical mode, the agent calls `assertion_check` keyed by `assertionId` and the actual outcomes land in `v2Recorded`, not in `assertionCheckResults`. The gate sees an empty legacy array and records `wouldReject=true` even when every declared assertion was checked. This flag is persisted to `RunResult` (line 3584) and feeds the "would the strict gate have rejected this case?" analysis.

**Fix.** Skip the gate evaluation entirely when `isMechanical === true`:

```js
const gateVerdict = isMechanical
  ? { wouldReject: false, reason: null }
  : evaluateAssertionGate(assertions, assertionCheckResults, status);
```

Or rewrite the gate to count `v2Recorded` entries in mechanical mode.

**Risk if unfixed.** The data we'll use to make the "flip the gate to hard-reject" decision is corrupted. Mechanical-mode runs show a fake "would-reject" rate that doesn't reflect actual agent behaviour. This is the single highest-value defect in the file — it silently breaks the metric the verdict-layer work was supposed to expose.

---

### P0-2 — `getTestCaseHistory` drops `userId` filter under `orgId`, breaking E8 multi-tenancy

**Location:** [server/services/runs.js:818-832](server/services/runs.js#L818-L832).

**Issue.** The org-scoped branch (lines 807-816) authorises by `orgId`, but the subsequent results query at line 821 filters by `run: { projectId: project.id, userId }` — so a co-org member triggering the history view on a teammate's case gets an empty array. Direct contradiction of CLAUDE.md's E8 invariant: *"Project queries filter by orgId, NOT by userId — sharing a project across an org breaks otherwise."*

**Fix.** Drop the `userId` filter inside the org branch:

```js
run: orgId ? { project: { orgId } } : { projectId: project.id, userId }
```

The project authorisation is already done by the outer guard.

**Risk if unfixed.** Sprint comparison and history-sparkline silently show zeros for legitimate org peers. Users will assume the case has no history; the feature is broken without erroring.

---

### P0-3 — `recordSuccessfulLocator` race condition silently regresses healed selectors

**Location:** [server/services/agents/conductor.js:1551-1641](server/services/agents/conductor.js#L1551-L1641) (write path), [conductor.js:1507-1543](server/services/agents/conductor.js#L1507-L1543) (heal path), called fire-and-forget at [conductor.js:2779-2786](server/services/agents/conductor.js#L2779-L2786).

**Issue.** `recordSuccessfulLocator` is invoked fire-and-forget on every successful tool call, while `recordLocatorHeal` runs synchronously on a successful heal. The success path does `findUnique → update(occurrences++)` with no transaction. Two concurrent tool calls on the same `(projectId, element)` race: both read the pre-heal row, both compute `data` independently, the later `update` clobbers a freshly-promoted heal-selector with the snapshot-derived one. The "promote to more stable strategy" check at lines 1628-1639 uses the stale read, so a heal can be silently lost in the next captured frame.

**Fix.** Replace the read-modify-write with `prisma.knowledgeBaseLocator.upsert` keyed on `projectId_element`, and gate the selector-promotion update with a `where: { updatedAt: existing.updatedAt }` CAS guard. Simpler: never write `data.selector` from the fire-and-forget path — only let the synchronous healer mutate selector/strategy.

**Risk if unfixed.** Healed locators silently regress. The "next run is cheaper than the last" promise from CLAUDE.md E1 quietly degrades and there is no visible signal that it's happening.

---

### P0-4 — `assertion_check matched=false` doesn't trigger the inline Critic

**Location:** [server/services/agents/conductor.js:2719-2762](server/services/agents/conductor.js#L2719-L2762), trail update at [conductor.js:2676-2693](server/services/agents/conductor.js#L2676-L2693), Critic trigger at [conductor.js:3111](server/services/agents/conductor.js#L3111).

**Issue.** `assertion_check` returns `isError: false` even on `matched: false` (the assertion was successfully checked and returned a negative result). So `result.isError === false`, the trail entry's `ok = !result.isError = true`, and `lastTurnErrored` at line 3111 evaluates to `false`. The inline Critic — whose entire purpose is to redirect the agent before MAX_TURNS exhausts — never sees the assertion miss as a trigger. The post-loop ratifier eventually flips the case to fail, but the chance to course-correct mid-flight is gone.

**Fix.** In the `assertion_check` handler around [conductor.js:2894-2924](server/services/agents/conductor.js#L2894-L2924), when `!record.matched` set `trailEntry.assertionFailed = true`. At line 3111 add `|| !!lastTrailEntry?.assertionFailed` to the Critic-trigger condition. Or store the `matched: false` explicitly in `trailEntry.error` with a clear prefix.

**Risk if unfixed.** The inline Critic — the most leveraged intervention point in the loop — misses the prime opportunity to redirect the agent. Cases that should be rescued aren't.

---

### P0-5 — Healer is conductor-layer recovery, not MCP-wrapper interception

**Location:** [server/services/agents/conductor.js:2567-2674](server/services/agents/conductor.js#L2567-L2674) (recovery block).

**Issue.** CLAUDE.md says: *"Locator failures trigger the healer BEFORE Claude sees the error. Claude continues as if the tool succeeded."* That claim is only true on the heal-success path — line 2622 swaps `result = retryRes` before toolResults goes back to Claude. On heal-fail or low-confidence, line 2644 keeps the original error and the agent sees it. The abstraction works on the happy path and leaks on every failure path.

A real top-level healer would intercept inside `mcp.callTool` itself. The Conductor would never see `isError` from a healable failure, period.

**Fix.** Lift the heal block (lines 2567-2674) into a wrapping function in [server/services/mcp.js](server/services/mcp.js). `mcp.callTool` becomes the chokepoint that runs the heal cycle and returns either the healed success or the original error — Conductor logic doesn't change downstream. Roughly 100 lines of refactor plus tests for the failure-shape contract.

**Risk if unfixed.** The healer's promised "Claude never sees the error" is half-true. Token budget and turn budget both pay for the failure even when healing eventually wins.

---

### P0-6 — Healer's `isLocatorClassError` regex misses "found but action failed" patterns

**Location:** [server/services/agents/conductor.js:1287-1303](server/services/agents/conductor.js#L1287-L1303).

**Issue.** The detector catches *element-not-found* and *strict-mode-violation* patterns but misses the entire "element resolved but action failed" family:

- `"element intercepts pointer events"` (overlay in the way)
- `"element is disabled"` / `"not enabled"`
- `"element is outside of viewport"`
- `"element is not visible"` / `"subtree is hidden"`
- `"selector resolved to hidden element"`

Real Playwright errors with these strings flow through to Claude unhealed. Half the real-world locator pain is in this bucket on SUTs with modals, lazy-loaded UI, or auth-driven disable states.

**Fix.** Extend the regex with explicit cases:

```js
/intercepts\s+pointer\s+events/.test(s) ||
/element\s+is\s+(disabled|not\s+enabled)/.test(s) ||
/element\s+is\s+outside\s+(of\s+)?viewport/.test(s) ||
/element\s+is\s+not\s+visible/.test(s) ||
/subtree\s+is\s+hidden/.test(s) ||
```

Five-line change. Highest leverage per LOC in this file.

**Risk if unfixed.** Locator-drift symptoms continue to look like "Claude couldn't decide what to do" when in fact the healer never had a chance to fire.

---

### P0-7 — `browser_fill_form` field failures attribute to `fields[0].name`

**Location:** [server/services/agents/conductor.js:1410-1415](server/services/agents/conductor.js#L1410-L1415) (`elementLabelFromArgs`).

**Issue.** When `browser_fill_form` fails on the third field of a form, the healer heals the locator keyed on `fields[0].name` — the wrong element. KB writes corrupt the first field's healthScore from a third field's failure.

**Fix.** Parse the error message for the field name that failed (Playwright includes it in the error), or attempt healing per-field. Roughly 15 lines.

**Risk if unfixed.** Multi-field form healing corrupts the KB for the wrong element. Failure cascades across fields on every retry.

---

### P0-8 — Architect has zero quarantine awareness (one-way KB)

**Location:** [server/services/agents/architect.js](server/services/agents/architect.js) — grep for `quarantin|healthScore|KnowledgeBaseLocator|knownLocators` returns **no matches**.

**Issue.** The Conductor injects `## Known locators on this site` into its execution prompt, but the Architect — which authors the cases — has no idea which elements have been quarantined. After `healthScore < 30` triggers quarantine, the Architect keeps emitting new cases targeting that element. Conductor refuses at runtime, BlockedItem fires, case blocks. Architect never learns. The KB is one-way.

**Fix.** Build a small helper that fetches the project's quarantined locators (rows where `healthScore < QUARANTINE_HEALTH`) and inject them into the Architect's system prompt as `## Quarantined elements on this project`. The Architect prompt then has: *"Avoid steps that target these elements. If a scenario logically requires them, mark the case as `automatability: manual` with a stated reason."* Same pattern the Conductor uses; ~30 LOC.

**Risk if unfixed.** Quarantine doesn't propagate. Every regenerate produces the same dead-end cases. Cross-run intelligence is half-implemented.

---

### P0-9 — `Run.needs_human` counter doesn't exist; verdict bypass is silent

**Location:** [prisma/schema.prisma:633-636](prisma/schema.prisma#L633-L636), [server/services/runs.js:590-608](server/services/runs.js#L590-L608) (`recomputeRunCounters`).

**Issue.** `computeVerdict` can now produce `needs_human` status ([computeVerdict.js:189](server/services/computeVerdict.js#L189), [:238](server/services/computeVerdict.js#L238)). `recomputeRunCounters` only counts `pass/fail/blocked/skipped`. A `needs_human` RunResult is silently absent from every Run counter. Dashboard shows "we ran 13 cases but the counts add to 9" with no explanation. Direct violation of CLAUDE.md's *"blocked ≠ skipped"* status-distinction principle.

**Fix.** Add `needs_human Int @default(0)` to `Run` in schema.prisma. Update `recomputeRunCounters` to extract `byStatus.needs_human` and write it. Update the Run dashboard and Reports filter to expose the new bucket.

**Risk if unfixed.** `needs_human` cases vanish from the dashboard. Users assume runs are passing when they're actually deferring decisions to humans the system isn't surfacing.

---

### P0-10 — `parseScenarioJson` (Architect) duplicates and diverges from `parseJsonResponse` (lib)

**Location:** [server/services/agents/architect.js:470-526](server/services/agents/architect.js#L470-L526) vs [server/lib/parseJsonResponse.js](server/lib/parseJsonResponse.js).

**Issue.** The Architect has a bespoke JSON parser with 4 strategies; the canonical version in `lib/` has 4 strategies *plus* stack-aware nested-object recovery *plus* trailing-comma fallback. Architect's version is missing the recovery and the comma fallback, so a long stream-cutoff that the lib parses cleanly fails in the Architect.

**Fix.** Replace `parseScenarioJson` with `parseJsonResponse(text, { type: 'array' })`. Delete the architect-local helper.

**Risk if unfixed.** Architect occasionally fails to parse outputs that other agents parse fine. Every provider edge case needs the fix applied in two places — one will be forgotten.

---

### P0-11 — `extractLocator` and `classifyError` duplicated in `runs.js` and `conductor.js` with diverged categories

**Location:** [server/services/runs.js:485-499](server/services/runs.js#L485-L499) vs [server/services/agents/conductor.js:3840-3888](server/services/agents/conductor.js#L3840-L3888).

**Issue.** Two near-identical helpers. The Conductor version has 12+ failure categories (`agent_loop`, `agent_repeating`, `browser_crash`, `captcha`, etc.) and a regex that also handles `ref=`. The runs.js version has 5 categories. A locator failure recorded by one path lands in different BlockedItem categories than the other. Reports UI groups by `reason`; the same root cause splits into two buckets depending on which code path wrote the row.

**Fix.** Extract both to `server/lib/errorClassify.js`. Have both callers import it. The Conductor implementation is canonical.

**Risk if unfixed.** BlockedItem analytics show false fragmentation. Filtering by category misses real signal.

---

### P0-12 — KB write errors swallowed by `catch (_) {}`

**Location:** [server/services/agents/conductor.js:1445-1447](server/services/agents/conductor.js#L1445-L1447), [:1499-1500](server/services/agents/conductor.js#L1499-L1500), [:1540-1542](server/services/agents/conductor.js#L1540-L1542), [:1665-1667](server/services/agents/conductor.js#L1665-L1667), [:2384](server/services/agents/conductor.js#L2384), [:2642](server/services/agents/conductor.js#L2642), [:2668](server/services/agents/conductor.js#L2668), [:3433](server/services/agents/conductor.js#L3433).

**Issue.** Six locator-KB helpers use bare `catch (_) {}` that swallow all errors including transient DB issues, schema-migration mismatches, and constraint violations. On a real schema drift the only signal is silently-missing rows. The QA lead thinks the KB is empty when in fact every write threw.

**Fix.** Replace each `catch (_) {}` with `catch (err) { console.warn('[kb] op failed:', err.code, err.message); }`. Keep the silent-to-run behaviour (heal is best-effort), but make the failure mode visible in server logs.

**Risk if unfixed.** Silent KB write failures look exactly like "no learning is happening." There's no way to tell from outside whether the cross-run-intelligence promise is broken.

---

### P0-13 — `computeVerdict` invariant trip on `parseFailed` type-coercion mismatch

**Location:** [server/services/computeVerdict.js:153-169](server/services/computeVerdict.js#L153-L169), [server/services/postLoopRatify.js:215-216](server/services/postLoopRatify.js#L215-L216).

**Issue.** `postLoopRatify` records `uncheckable("declared_assertion_unparseable")` for `parseFailed` entries; `computeVerdict` exempts `parseFailed` from the "every declared assertion needs a recorded outcome" invariant. These are consistent only if `parseFailed` is the exact same `true` value on both sides. A truthy-but-not-`=== true` value (`"true"`, `1`) trips the invariant and the case falls through to `verdict = { status: 'blocked', reason: 'invariant_violation' }`. The catch swallows the bug with one WS log line.

**Fix.** Coerce to boolean at both write sites — `if (decl.parseFailed === true)`. When the invariant trips, persist the offending `assertionId` on `RunResult.mechanicalVerdictReason` so the bug surfaces in the DB, not just in logs.

**Risk if unfixed.** Silent reliability degradation. Mechanical-mode reports `blocked` for cases that should route to `needs_human`.

---

### P0-14 — URL pattern Architect-emitted assertions not validated at output time

**Location:** [server/services/agents/architect.js:138-167](server/services/agents/architect.js#L138-L167) (the prompt rule), [architect.js:546-579](server/services/agents/architect.js#L546-L579) (`normaliseCase`).

**Issue.** The Architect's prompt has a strong rule against fabricated URL patterns. `normaliseCase` doesn't validate URL assertions. The reachability scanner ([architect.js:854-908](server/services/agents/architect.js#L854-L908)) catches some cases via warning logs only. A bad URL pattern still ships to the DB and produces the `/.*login.*/` vs `/` mismatch seen on saucedemo.

**Fix.** In `normaliseCase`, when `declaredAssertions[i].type === 'URL'` and a `targetUrl` is available, compile the pattern with `new RegExp()` and test it against the literal `targetUrl`. If the pattern wouldn't match its declared target, either:
- Demote the assertion to a TEXT assertion against a known landmark, or
- Strip the assertion with a warning and surface it on the TC creation UI as `parseFailed: true` (which then routes through the post-loop ratifier).

This is the *code-level* enforcement the Architect monolith design can't do at prompt time alone. It's the same generic principle as P0-8: ground assertions in observed/cited reality, not in invented patterns.

**Risk if unfixed.** Saucedemo-pattern false-fails reproduce on every SUT that uses root-URL-as-login or hash-routed auth. The verdict layer now correctly surfaces them, but the bad assertions never should have been emitted in the first place.

---

## P1 — Token waste / cost optimisations

Every finding here flags an opportunity. Numbers should be verified with the replay harness at [scripts/replay/](scripts/replay/) before being quoted in cost claims (per CLAUDE.md *"Cost claims require evidence"*).

### P1-1 — Architect SYSTEM_PROMPT (~10 KB) sent uncached on every call

**Location:** [server/services/agents/architect.js:22-459](server/services/agents/architect.js#L22-L459) (prompt body), used at [architect.js:690](server/services/agents/architect.js#L690).

**Issue.** The Architect prompt is ~10 KB of rules that almost never change between calls. The Conductor uses Anthropic's `cache_control: { type: 'ephemeral' }` on its loop prompt ([conductor.js:2213-2220](server/services/agents/conductor.js#L2213-L2220)); the Architect does not. Every requirement-set re-pays full input-token cost on this prefix.

**Fix.** Change the system shape from a string to:

```js
system: [
  { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ...(extraGuidance ? [{ type: 'text', text: extraGuidance }] : []),
]
```

Cache hits within the 5-minute window save ~90% on the prefix input tokens. Effect compounds when multiple users in the same org architect close in time.

**Verification needed.** Replay harness against the BRD corpus to quantify the win.

---

### P1-2 — Conductor scenario-header block invalidates the system cache every scenario

**Location:** [server/services/agents/conductor.js:2178](server/services/agents/conductor.js#L2178), [:2186](server/services/agents/conductor.js#L2186), [:2215](server/services/agents/conductor.js#L2215).

**Issue.** `buildScenarioHeaderBlock(scenario)` is appended to `staticPrefix` *before* the `cache_control` wrap. The block changes per scenario (scenario name, case list). Anthropic's cache key is byte-exact, so the cache breakpoint moves at every scenario boundary, invalidating the cache and re-paying the full ~18 KB system rule block. The scenario-continuity architecture from Phase F.1 was supposed to compound cache hits across cases; in practice it doesn't.

**Fix.** Move `buildScenarioHeaderBlock(scenario)` out of `staticPrefix` and into `dynamicSuffix` (or its own non-cached block at line 2197). The header is ~500 bytes; paying that uncached preserves cache hits on the ~18 KB rule block across every case in the run.

**Verification needed.** Replay harness; this is one of the highest-leverage wins in the file.

---

### P1-3 — Inline Critic runs at flagship tier; no `TIER` declared

**Location:** [server/services/agents/critic.js:251-308](server/services/agents/critic.js#L251-L308) (`runInline`); compare to [healer.js:40](server/services/agents/healer.js#L40), [reporter.js:23](server/services/agents/reporter.js#L23) which set `const TIER = 'mid'`.

**Issue.** `critic.js` has no `TIER` constant. The resolver default at [modelRouter.js:75](server/lib/modelRouter.js#L75) is `'flagship'`. The Critic has two entry points:
- `Critic.run` — post-run rewriter, produces step-shape JSON. Reasonable as flagship; fewer calls.
- `Critic.runInline` — fires on every tool error and every periodic interval. Highest-frequency LLM call after the conductor's main loop, currently pays flagship Sonnet 4.6 rates.

The inline call's job is monitoring with terse output: detect agent confusion, suggest a pivot, flag a pass-claim. Well within Haiku 4.5 capability.

**Fix.** Add `const INLINE_TIER = 'mid';` and route the inline call through `resolveModelForTier({ provider, requestedModel: model, tier: INLINE_TIER })` at [critic.js:277](server/services/agents/critic.js#L277). Per CLAUDE.md *"Mid-tier ALWAYS routes to Haiku 4.5"*.

**Verification needed.** Replay harness with quality comparison — inline-Critic quality must hold up to a sample of failure scenarios. If it does, this is potentially the single largest cost win in the project.

---

### P1-4 — Mid-tier agents send uncached system prompts

**Location:** [critic.js:138-156](server/services/agents/critic.js#L138-L156), [supervisor.js:123-131](server/services/agents/supervisor.js#L123-L131), [reporter.js:86-93](server/services/agents/reporter.js#L86-L93), [healer.js:175-202](server/services/agents/healer.js#L175-L202), [postMortem.js:228-249](server/services/agents/postMortem.js#L228-L249), [analyst.js:114-123](server/services/agents/analyst.js#L114-L123), [analyst.js:175-186](server/services/agents/analyst.js#L175-L186), [instructionReader.js:142-173](server/services/agents/instructionReader.js#L142-L173), [visualCritic.js:190-222](server/services/agents/visualCritic.js#L190-L222).

**Issue.** Every non-Conductor agent passes `system: composeSystemPrompt(SYSTEM_PROMPT, extraGuidance)` as a plain string. None mark the SYSTEM_PROMPT for ephemeral caching. Healer/instructionReader's prompts are ~2 KB and they fire many times per case. Within the 5-minute window every repeat re-pays the full input cost.

**Fix.** Change `composeSystemPrompt` to return an array of content blocks with `cache_control` on the static prefix:

```js
function composeSystemPrompt(SYSTEM_PROMPT, extraGuidance) {
  return [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ...(extraGuidance ? [{ type: 'text', text: extraGuidance }] : []),
  ];
}
```

The provider boundary already supports both shapes ([llmProvider.js](server/lib/llmProvider.js) treats `system` as Anthropic-native; the Gemini provider translates internally). One change, all mid-tier agents benefit.

**Verification needed.** Replay harness.

---

### P1-5 — Healer truncates snapshot from the wrong end

**Location:** [server/services/agents/healer.js:166](server/services/agents/healer.js#L166).

**Issue.** `String(freshSnapshot).slice(0, 16_000)` keeps the *first* 16 KB, not the *most recent*. The comment at line 165 claims "bottom-up failures get cut first" but the slice does the opposite — top-of-page (often static chrome) is preserved while the bottom-of-viewport (modals, footer CTAs, where heals most often need to look) is cut.

**Fix.** Use a smarter window. Options:
- `.slice(-16_000)` to keep the most recent / bottom-of-snapshot
- Or capture a window around the failed selector if its text is known
- Reduce the cap to 10 KB once tail-slicing is in place (heals rarely need 16 KB)

**Verification needed.** Replay harness on heal accuracy with the smaller cap.

---

### P1-6 — Conductor `MECHANICAL_MODE_PROMPT_BLOCK` reshape opportunity

**Location:** [server/services/agents/conductor.js:281-339](server/services/agents/conductor.js#L281-L339), inserted at [:2185-2187](server/services/agents/conductor.js#L2185-L2187).

**Issue.** The mechanical-mode block (~3 KB) is per-run-immutable (set on Run.create) but appended fresh into every case's system prompt. With the scenario-header fix from P1-2, the cache will hold across the whole run and this block will benefit. Documenting for the same-fix.

**Fix.** Subsumed by P1-2. Once the scenario header is moved out of the cacheable prefix, this block sits inside the cached region and pays its tokens once per run, not once per case.

---

### P1-7 — Inline Critic re-renders `caseContext` per turn

**Location:** [server/services/agents/critic.js:263-269](server/services/agents/critic.js#L263-L269).

**Issue.** The case-context block (case name, declared assertions, last snapshot summary) is identical across every turn of one case. It's rebuilt and sent on every inline-Critic call. Combined with the uncached SYSTEM_PROMPT (P1-4), every inline call pays full input cost for static content.

**Fix.** Build `caseContext` once per case, store on the case-execution context, and pass it as a cached system block alongside SYSTEM_PROMPT. Only `trail` and `lastSnapshot` live in the uncached suffix.

---

### P1-8 — Reporter `maxTokens: 4000` is fixed regardless of failure count

**Location:** [server/services/agents/reporter.js:73-94](server/services/agents/reporter.js#L73-L94).

**Issue.** Reporter requests 4000 output tokens whether the case has 1 failure or 8. Most production runs have <3 failures.

**Fix.** Size adaptively: `maxTokens: Math.min(4000, 500 * failures.length + 1000)`. Small-but-real win on Reporter-heavy projects.

---

## P2 — AI → Code refactor candidates (safe substitutions only)

These are LLM calls where a deterministic Node function would do the same job without compromising reliability. Per the reliability principle at the top of this file, only safe substitutions are listed.

### P2-1 — Planner LLM does what Kahn's algorithm already does

**Location:** [server/services/agents/planner.js](server/services/agents/planner.js) (entire file) vs [server/services/runs.js:430-464](server/services/runs.js#L430-L464) (`expandDependenciesAndTopoSort`).

**Issue.** Planner sends scenarios to Claude with three goals: respect dependencies (topo sort), group P0 first (stable sort key), maximise parallelism (wave partition by indegree). All three are deterministic. `expandDependenciesAndTopoSort` already does Kahn's sort over `dependsOnIds`. CLAUDE.md is explicit: *"Topological sorts, regex classification, keyword matching — Node."*

The only LLM-novel output is `Plan.riskFactors`, and no UI surface currently reads it.

**Why this is safe to remove.** Topo sort is deterministic. Data-isolation wave splitting ("two scenarios both create the same email") is a substring-conflict check, not novel reasoning. P0-first is a stable sort. Risk-factor narrative is unused.

**Fix.** Replace `planner.js` with a pure-Node Kahn topo sort over scenarios' `dependencyOn`, partitioned into waves by indegree level, P0-prioritised within each level. Keep the `{ waves, estimatedDurationSec, riskFactors }` shape; emit `riskFactors: []` when there are no quarantined locators or known-stale modules (or compute it deterministically from KB state).

**Win.** One LLM call eliminated per run. Eliminates the planner failure mode at [planner.js:147-164](server/services/agents/planner.js#L147-L164) (JSON parse failures). Verifiably zero quality regression — current planner outputs almost always produce one wave with all scenarios parallel.

---

### P2-2 — Periodic inline-Critic in thorough mode could use the existing token-overlap helper

**Location:** [server/services/agents/conductor.js:948-972](server/services/agents/conductor.js#L948-L972) (`postHocAssertionCheck`), [conductor.js:889-946](server/services/agents/conductor.js#L889-L946) (`evaluateAssertionGate`), Critic trigger at [conductor.js:3118](server/services/agents/conductor.js#L3118).

**Issue.** The periodic-fire branch of the inline Critic (every-N-turns in thorough mode) does "has the agent forgotten to check assertion X yet?" — which is exactly what `evaluateAssertionGate` already does deterministically via 40% token-overlap.

**Why this is safe.** This applies only to the *periodic* branch. The error-triggered branch (`lastTurnErrored`) keeps the LLM Critic because it reads the snapshot to suggest a pivot strategy — genuine LLM judgment. Loop detection and modal detection are already deterministic in `extractPageInstructions` ([conductor.js:219-253](server/services/agents/conductor.js#L219-L253)).

**Fix.** In the inline-critic dispatch:

```js
if (lastTurnErrored) {
  await critic.runInline(...);  // LLM, unchanged
} else if (periodicTrigger) {
  const gate = evaluateAssertionGate(assertions, assertionCheckResults, 'pass');
  if (gate.wouldReject) {
    // Inject deterministic "you haven't checked: X, Y, Z" user message
    injectAssertionReminder(messages, gate.unchecked);
  }
}
```

**Win.** Eliminates the periodic LLM call in thorough mode. Inline Critic remains active on errors where its judgment is genuinely needed.

---

### P2-3 — Role-aliases map duplicated between conductor and mcp; extract to shared lib

**Location:** [server/services/agents/conductor.js:178-202](server/services/agents/conductor.js#L178-L202) (used by `extractPageErrors` / `extractPageInstructions`) and [server/services/mcp.js:1452-1461](server/services/mcp.js#L1452-L1461) (`ROLE_ALIASES`).

**Not an AI→code candidate** (both are already code). But the duplication creates drift risk.

**Fix.** Move to `server/lib/roleAliases.js`. Both files import. Pure refactor.

**Risk if unfixed.** Future role-alias additions need to be applied in two files; one will be forgotten.

---

### P2-4 — `extractPageErrors` and `scanReachability` are the right pattern; keep doing this

**Location:** [server/services/agents/conductor.js:178-202](server/services/agents/conductor.js#L178-L202), [architect.js:854-908](server/services/agents/architect.js#L854-L908).

**No action needed.** Flagging as examples of the correct AI→code pattern. Both replace what would otherwise have been LLM calls (page-error extraction, reachability validation) with deterministic helpers. Reference these when proposing new agents.

---

## P3 — Architecture smells (maintainability)

### P3-1 — `conductor.js` at 3890 lines owns 8 distinct concerns

**Location:** [server/services/agents/conductor.js](server/services/agents/conductor.js).

**Issue.** Single file owns: MCP session driving, tool-use loop, prompt composition, snapshot extraction, heuristic loop detection, self-healing locator KB CRUD, post-hoc verdict ratification, codegen + PR + BlockedItem persistence. `runOneCase` alone spans ~1700 lines (1768-3465).

**Fix.** Extract into focused modules:
- `conductor/locatorKB.js` — `recordSuccessfulLocator`, `recordLocatorHeal`, `recordLocatorFailure`, `loadKbLocator`, `appendHealHistory` (~250 lines)
- `conductor/snapshotScan.js` — `extractPageErrors`, `extractPageInstructions`, `postHocAssertionCheck`, `evaluateAssertionGate` (~250 lines)
- `conductor/persist.js` — `persistResultAndCodegen` and its codegen / PR / BlockedItem branches (~300 lines)
- `conductor/promptBuild.js` — `buildSourceDocBlock`, `buildScenarioHeaderBlock`, `buildDeclaredAssertionsBlock`, MECHANICAL_MODE_PROMPT_BLOCK, SYSTEM_PROMPT_LOOP (~500 lines)

`postLoopRatify.js` and `computeVerdict.js` are already extracted; same treatment for the rest.

**Risk if unfixed.** Testing the verdict ratification gate in isolation is impossible. Every PR touching the tool-use loop must be diffed against 3890 lines.

---

### P3-2 — `mcp.js` at 1823 lines mixes subprocess management with synthetic-tool implementation

**Location:** [server/services/mcp.js](server/services/mcp.js).

**Issue.** Same shape as conductor.js. Owns stdio subprocess lifecycle, CLI arg building, tool list, the synthetic `assertion_check` implementation ([_checkAssertionOnce](server/services/mcp.js#L1367-L1620), 250 lines), and `final_verdict` semantics. The synthetic tools are domain logic, not transport.

**Fix.** Extract `server/services/mcp/synthetics.js` for `checkAssertion`, `_checkAssertionOnce`, `ASSERTION_CHECK_TOOL_*`, `FINAL_VERDICT_TOOL`. `mcp.js` retains `startMcpSession`, `callTool`, `stopMcpSession`, `listAnthropicTools` (now composed of MCP-discovered + synthetics).

**Risk if unfixed.** Two reviewers ask "where does assertion_check live?" — one finds it in mcp.js, the other looks for `agents/assertion.js` and concludes it doesn't exist.

---

### P3-3 — Dead `screenshotsByTc` parameter threaded through conductor

**Location:** [server/services/agents/conductor.js:1191-1195](server/services/agents/conductor.js#L1191-L1195), [:1769](server/services/agents/conductor.js#L1769), [:3435](server/services/agents/conductor.js#L3435).

**Issue.** `screenshotsByTc[tc.id] = screenshots;` at line 3435 stores per-TC screenshots into an object never read after assignment in this file.

**Fix.** Remove the `screenshotsByTc` parameter from `runOneCase`'s call site (1191) and signature (1769). Remove line 3435.

**Risk if unfixed.** Cognitive overhead. New contributors look for the consumer that doesn't exist.

---

### P3-4 — `KnowledgeBaseLocator` unique key is `(projectId, element)` only

**Location:** [prisma/schema.prisma:817](prisma/schema.prisma#L817).

**Issue.** Two semantically-different elements sharing the same human label collide. "Login button" on a marketing nav and "Login button" on the auth form both upsert to the same row. Already in MEMORY.md as a known issue — re-stated here for completeness.

**Fix (not trivial).** Add `pageUrl` to the unique key: `@@unique([projectId, element, pageUrl])`. Backfill migration sets `pageUrl = ''` for legacy rows. `recordSuccessfulLocator` already normalises `pageUrl` at [conductor.js:1597-1599](server/services/agents/conductor.js#L1597-L1599) — wire that into the unique key. Even better: add an indexed `intent` column keyed on normalised semantic target (label rename survives).

**Risk if unfixed.** Cross-page locator collisions corrupt heal history. An auth button's healthScore degrades from a marketing-nav button's failures.

---

### P3-5 — KB-aware Architect (closes the loop opened in P0-8)

**Location:** Architect prompt + KB read pattern.

**Issue.** Restated for completeness. The Conductor reads the KB but the Architect doesn't. Quarantined locators don't propagate to case generation. Even if P0-8 ships the quarantine list, longer-term the Architect should also see *known-good* locators so it can ground assertions against observed accessible names rather than invented strings — a step toward the Calibrator architecture without shipping a separate agent.

**Fix path.** Phase 1: inject quarantined-locator list (P0-8). Phase 2: inject top-N known-good locators per page-URL pattern. Phase 3 (the eventual Calibrator): the Architect's second pass uses the Conductor's first-touch snapshot to ground concrete assertion text.

---

## Cross-cutting / observed-from-architectural-review

These came from the long architectural discussion that preceded this audit. Most are already covered above; calling out the meta-pattern for completeness.

### CC-1 — Verification is fused with execution

The Conductor both drives the browser and self-reports the verdict. The mechanical verdict layer ([computeVerdict.js](server/services/computeVerdict.js) + [postLoopRatify.js](server/services/postLoopRatify.js)) partly solves this — Phase 1 of the verdict-honesty work. The remaining gap: assertion-check outcomes are recorded by the agent's own tool calls, and the post-loop ratifier compensates. P0-13 closes one of the residual leaks; CC-1 is otherwise mitigated by current architecture.

### CC-2 — Architect designs assertions blind

The Architect proposes assertion text from documentation only, never having seen the SUT. Bucket A failures (untestable assertions: HTTP-status, console-error, ARIA-role guesses, URL-pattern hallucinations) are the symptom. P0-14 catches URL-pattern hallucinations at output time. The structural fix is the eventual Calibrator agent — out of scope for this list but tracked in BUILD_PLAN_V2.

### CC-3 — KB is one-way

Conductor consumes; Architect doesn't see quarantine or known-good state. P0-8 closes the quarantine direction. P3-5 documents the broader bidirectional pattern.

### CC-4 — No stability detector for snapshots

Acknowledged technical debt from the architectural review. `assertion_check` polls a possibly-unsettled snapshot. Phase 2 of the verdict-honesty work adds stability metadata + an optional `wait_for_stable` synthetic tool. Out of scope for this list — flagged here so it's not lost.

### CC-5 — Negative-case KB schema missing

Acknowledged. AssertionTrap-style schema (`(project, page, assertion pattern, failure reason)`) would let the Calibrator feed prior assertion failures back into the Architect's grounding pass. Out of scope for Phase 1; tracked.

---

## Recommended sequencing

If you ship in priority order:

**Week 1 — Stop the bleeding (P0 quick wins, <1 day each):**
1. P0-1 (`evaluateAssertionGate` mechanical-mode skip) — the metric-corruption fix
2. P0-2 (orgId/userId leak in `getTestCaseHistory`) — silent multi-tenancy bug
3. P0-6 (`isLocatorClassError` regex expansion) — 5-line change
4. P0-12 (KB write `catch (_) {}` logging) — observability win
5. P0-13 (`parseFailed` boolean coercion) — defensive correctness

**Week 1-2 — Verdict integrity:**
6. P0-9 (`Run.needs_human` counter + dashboard) — schema + recompute
7. P0-4 (`assertion_check matched=false` triggers Critic) — single-condition addition
8. P0-14 (URL-pattern validation in `normaliseCase`) — closes Bucket A at output time

**Week 2-3 — Cost wins (each requires replay-harness verification):**
9. P1-1 + P1-2 (Architect + Conductor cache fixes) — bundle together
10. P1-3 (Inline Critic → mid-tier) — replay-harness gates the rollout
11. P1-4 (Mid-tier agents cache control) — global change

**Week 3 — KB integrity:**
12. P0-3 (`recordSuccessfulLocator` race fix) — needs careful transactional change
13. P0-7 (per-field fill_form attribution) — small, isolated
14. P0-8 (Architect quarantine awareness) — closes the one-way KB loop
15. P0-5 (Healer → MCP-wrapper interception) — the structural refactor that makes the abstraction honest

**Month 2 — Refactors:**
16. P2-1 (Planner → pure code) — one LLM call removed, one failure mode removed
17. P3-1 (Conductor file split) — touches the most ground; do after the rest stabilises
18. P3-2 (MCP synthetic-tool extraction)

**Architecture-level (tracked, not yet scheduled):**
- Calibrator (CC-2)
- Stability detector (CC-4)
- Negative-case KB (CC-5)
- KB semantic-intent indexing (P3-4 extension)

---

*This file lives alongside [BUILD_PLAN.md](BUILD_PLAN.md) and should be updated as findings are addressed. Mark items with a strikethrough + date when complete, and add a brief verification note. Do not delete completed entries — they're the project's institutional memory of what was once broken.*
