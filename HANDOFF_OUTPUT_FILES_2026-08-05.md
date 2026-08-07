# Handoff: Output Files end-to-end runnability

Written 2026-08-05, handing off from Claude Code to continue in Antigravity.
Read this fully before touching code. It supersedes nothing in CLAUDE.md —
it's the current-state briefing CLAUDE.md's phase protocol asks for.

**Read in this order before writing any code**: `CLAUDE.md` (project
constitution — conventions, do-nots, phase protocol) → the most recent 3–4
sections of `PHASE_LOG.md` (search for "2026-08-05" — four sections were
added today, in order: passive evidence + real locator capture, live-proof
close-out, direct live-evidence codegen, Select/Radio + assertion capture +
UI wiring, live re-proof) → this file → then start on "Known gaps" below.

## The user's goal, verbatim

"whatever the conductor performs the actions all the steps and its exact
locators including all type of actions our platform should perfectly
capture and write the output files! The script it generates must be
runnable completely end to end as how conductor finished its run understand?"

Repeated demand: **no comments, no empty locators, no fabricated code**.
Every line in a generated spec must be either an independently re-verified
Playwright locator, or a deterministic literal pulled from authored text —
never a guess. Anything that doesn't clear that bar becomes a visible
diagnostic comment, not fabricated code. This precision bar is non-negotiable
and is why the generator (`liveReplayCodegen.js`) is built the way it is —
do not weaken it under time pressure.

**Immediate focus, corrected 2026-08-05 (later same day)**: the user asked
directly whether we'd been building Playwright POM (JS and TS) output —
**we had not**. Everything done so far only covers the FLAT format
(`playwright-reference`, a single inline spec file per case, no page
objects). There are actually four separate framework keys in this system;
today's fix covers exactly one of them:

| Framework key | Shape | Bridged to `liveReplayCodegen.js` today? |
|---|---|---|
| `playwright-reference` | Flat, single spec per case | **Yes** |
| `playwright-reference-js` | Flat, JS variant | No |
| `playwright-pom` | Page Object Model, TypeScript | **No — build this next** |
| `playwright-pom-js` | Page Object Model, JavaScript | **No — build this next** |

**New priority, superseding the "Known gaps" ordering below**: build POM
JS + POM TS support before anything in "Known gaps". The user wants POM
specifically, not more flat-format polish. See "Building POM JS/TS" below,
inserted before the gap list. The flat-format gaps (#1 and #2 in that list)
are still real and still worth fixing, but only after POM has SOME
end-to-end runnable output — match the user's own instruction ("we need to
first achieve at least one framework runnable scripts end to end") to what
they actually meant: POM, now that it's been named explicitly.

## Building POM JS/TS — the new priority

**What POM output means in this codebase** (established convention, see the
legacy `server/services/codegen/adapters/playwrightPom.js` for reference —
4,052 lines, built for the OLD schema, do not try to feed it the new
envelope, just match its OUTPUT CONVENTIONS):
```
locators/<page>.locators.ts   — locator accessor functions, one file per distinct page/URL-domain
pages/<PageClassName>.ts      — a class per page, one method per recorded action/assertion, imports locators/
tests/<case-slug>.spec.ts     — imports page classes, calls their methods in authored order
```
(swap `.ts` for `.js` and drop TS type annotations for the `-js` variant).

**What already exists that you can reuse directly, unchanged**:
- All locator capture (actions, assertions, Select/Radio with the dedup
  guard, Navigate/WaitForState/Scroll rendering) — this is the hard part,
  and it's already solved in `liveReplayCodegen.js`. POM doesn't need new
  capture work, only new OUTPUT PACKAGING of the exact same
  `operation.verifiedLocator` / literal-extraction data.
- The precision contract is identical: a POM method's locator getter is
  allowed to exist under exactly the same rule as a flat spec's inline
  locator (verified === true + expression present, or a deterministic
  literal) — never relax this for POM just because the output shape changed.

**What's new and needs building**:
1. A way to group operations into "pages" — use `operation.targetIdentity.section`/
   `.form`, or the page's URL at the time of the operation (check what's
   actually available on stored `stepResults` entries — inspect real data
   with `qaai-inspect-run.cjs`/direct Prisma queries before assuming a field
   exists, the same way every other fix in this project was grounded in
   real evidence, not assumption).
2. A locator-accessor emitter: for each distinct verified locator within a
   page group, emit a named accessor (e.g. `get emailInput() { return
   this.page.locator("#email"); }` for TS, or an equivalent function for JS).
3. A page-method emitter: for each action/assertion, emit a method that
   calls the accessor with the right interaction (`.fill()`, `.click()`,
   `.check()`, `expect(...).toBeVisible()` — reuse the exact interaction
   logic already in `renderActionLine`/`renderRadioLine`/`renderAssertionLine`
   in `liveReplayCodegen.js`, just target a method body instead of an
   inline spec line).
4. A test-file emitter: imports the page classes touched by this case, in
   authored order, and calls their methods — this replaces the flat spec's
   inline `await page....` lines with `await loginPage.fillEmail(...)`-style
   calls.
5. Decide implementation shape: either (a) a new sibling module
   (`livePomCodegen.js`) that reuses `liveReplayCodegen.js`'s render
   helpers, or (b) extend `liveReplayCodegen.js` itself with a `format:
   'pom' | 'flat'` parameter. Given how much render logic is shared,
   (a) with explicit imports from the flat module is probably cleaner than
   duplicating logic — but verify this doesn't create tangled coupling
   before committing to it.
6. Wire it into `replayExport.js`'s existing bridge: extend the
   `framework === 'playwright-reference'` check (search for
   `isControllerReplaySchema` / `buildLiveReplayExportCompat`) to also cover
   `playwright-pom` and `playwright-pom-js`, dispatching to the new POM
   generator instead of the flat one based on which framework was requested.
7. Same verification bar as everything else: syntax-check, regenerate
   against a real run, **read every generated file yourself**, run the
   `npm run verify:controller-cutover` gate if you touched anything in the
   live pipeline (you shouldn't need to for pure codegen work — if you find
   yourself editing controller files for this, stop and reconsider the
   approach), and document in PHASE_LOG.md.

Once POM JS/TS produces genuinely runnable, precise output for the same two
reference test cases used throughout this project (login + order), that's
the "one framework end to end" milestone the user is asking for. Only then
move to the flat-format gaps below, then BDD/Selenium.

## What's already true right now (verified, not assumed)

- The live Conductor pipeline (`controllerConductor.js` →
  `browserTransactionRuntime.js` → `controllerMcpRuntimeAdapter.js` →
  MCP/Playwright) is untouched in its execution/verdict logic. Every change
  made so far is either (a) additive evidence capture that degrades safely
  on failure, or (b) export-time-only code that never touches the browser.
- `server/services/codegen/liveReplayCodegen.js` generates real Playwright
  specs directly from `RunResult.stepResults` (the `qaai-controller-replay-v1`
  evidence envelope). This is the ONLY codegen path that currently produces
  runnable code — the older `server/services/codegen/replayExport.js` (11,445
  lines, built for the OLD conductor's actionTrail schema) still can't process
  the new schema and reports "zero execution provenance" for it.
- `replayExport.js`'s `buildReplayExport()` now has an additive branch (added
  today) that detects new-schema runs and delegates to `liveReplayCodegen` —
  **but only for `framework === 'playwright-reference'`**. This is what makes
  the actual Output Files UI (file tree, viewer, Download ZIP button) show
  real code instead of the old "zero execution provenance" diagnostic.
  POM/BDD/Selenium framework requests still fall through to the untouched
  legacy pipeline.
- Current live-verified coverage (run `08d5054f-7057-4656-b246-da7e83cf819e`,
  both cases passed 2/2 against the real Odyssey site):
  - Login case: 15/22 operations rendered as real code, 7 diagnostic gaps.
  - Order case: 67/87 operations rendered as real code, 20 diagnostic gaps.
  - Every rendered line is real; every diagnostic gap has a stated,
    evidence-backed reason (see "Known gaps" below) — none are silent.

## Architecture map — where things actually live

```
Live Conductor pipeline (DO NOT touch without running the gate — see below):
  server/services/agents/controllerConductor.js      — orchestrates a case's operation loop
  server/services/browserTransactionRuntime.js       — per-operation commit loop, evidence capture hook
  server/services/browserTransactionController.js    — per-operation state machine, composite dispatch
  server/services/controllerCompositeExecutor.js      — runs a composite protocol's phases (Select/Date/Time)
  server/services/controllerCompositeProtocols.js     — defines the phases per protocol (dropdown/calendar/time)
  server/services/controllerMcpRuntimeAdapter.js       — resolver()/observer()/transport, locator capture, MCP calls
  server/services/controllerTypedAdapterRegistry.js    — maps operation type -> ADAPTER_KIND -> dispatch plan
  server/services/operationContractV2.js               — authored-step -> OperationContractV2 compile

Codegen (export-time only, never touches the browser):
  server/services/codegen/liveReplayCodegen.js  — THE generator to extend. Reads RunResult.stepResults directly.
  server/services/codegen/replayExport.js       — legacy 11,445-line pipeline + the new additive bridge branch
                                                    (isControllerReplaySchema / buildLiveReplayExportCompat,
                                                    near the top of buildReplayExport(), search for those names)
  server/routes/outputFiles.js                  — HTTP routes; buildReplayWorkspace() -> buildReplayExport()
  src/pages/OutputFiles.jsx                     — the actual UI. downloadZip() hits /output-files/download.zip

Gates:
  npm run verify:controller-cutover   — runs 22 verify_*.cjs scripts + the 230-test controller unit suite.
                                          MUST pass after touching ANY file in the "Live Conductor pipeline"
                                          list above. Takes ~90s. Non-negotiable per CLAUDE.md.
```

## Precision contract — what "correct" means here (read before writing any renderer code)

A line in a generated spec is allowed to exist ONLY if:
1. It's an action/assertion whose `operation.verifiedLocator.verified === true`
   AND `.expression` is set — meaning `captureVerifiedLocator()` in
   `controllerMcpRuntimeAdapter.js` independently re-proved a real DOM
   element exists at that locator, via a **fresh** `captureStructuralLocator`
   call, not just trusting whatever ref was used during execution. OR
2. It's a deterministic literal extracted from the authored assertion's own
   text via a fixed regex pattern (`LITERAL_PATTERNS` in
   `liveReplayCodegen.js`) — never an LLM guess, never a paraphrase.

If neither holds, the operation becomes a `// QAAI_DIAGNOSTIC_GAP: ...` or
`// QAAI_COMPOSITE_STEP: ...` comment stating *why* it wasn't rendered. Never
silently drop an operation, and never render something you can't prove.

**The one real failure mode already found and fixed once** (2026-08-05):
`liveReplayCodegen.js` briefly rendered Select as `.click()` unconditionally,
which produced `page.locator("#equipment").click()` TWICE in a row (once
for the preceding Click-to-open, once for Select-to-choose) — a genuine
open-then-close no-op, not a selection. This is exactly the kind of bug the
precision contract exists to prevent. **Before rendering any new action type,
regenerate against a real run and read every line — do not trust that "a
locator existed" means "rendering it is correct."** Duplicate-locator
consecutive lines are the specific smell to check for.

## How to trigger a live run (no UI needed)

```
node scripts/qaai-trigger-run.cjs
```
Defaults to the reference project/cases below if no flags passed. Returns
202 immediately; the run executes async. Flags:
`--project <id> --cases <id1,id2> --generation <id> --user <id> --base-url <url>`

Reference IDs (New_Odyssey project, known-good, used throughout this work):
```
projectId:     1582559f-364f-4d0e-bfde-fd18832fdaa7
generationId:  d486351a-6070-47d1-b8b5-2c8bc4156abb
testCaseIds:   4af44607-e59b-4cd4-85a2-68dc1e89cdc9  (Login through email classifier and Microsoft sign-in — 22 steps)
               c7dabb04-0fef-4530-bad8-8c0f6622ed64  (Create an order and validate complex form controls — 87 steps)
userId:        a5d916cd-4178-4bcc-b409-c885a389e843  (bharatvanapalli8@gmail.com, org owner)
orgId:         org-a5d916cd-4178-4bcc-b409-c885a389e843
targetUrl:     https://qa.linx.odysseylogistics.com/auth/email-classifier?returnUrl=%2Fuser%2Fadministration
last known-good runId: 08d5054f-7057-4656-b246-da7e83cf819e  (both cases pass 2/2, post all 2026-08-05 fixes)
```

**Before triggering**: the backend must be running with your latest code —
restart it first. Restarting is usually blocked for automation tools by a
safety classifier; if yours is too, ask the human operator to run
`scripts/restart-backend.ps1`, then confirm with
`curl http://localhost:5000/api/health` before triggering.

Each full run against the real site takes roughly 1–5 minutes (was 50s/280s
per case historically). This is a REAL browser hitting a REAL external site
— don't trigger it speculatively; trigger it once you have a specific
capture-behavior change to verify.

## How to inspect a run's captured locators

```
node scripts/qaai-inspect-run.cjs --run <runId>
```
Polls until the run leaves `running` status, then prints per-case
action/assertion/select-radio locator-capture coverage, plus every
Select/Radio operation's exact captured expression. This is how you confirm
a capture fix actually changed live behavior — static code reading is not
enough; the composite-protocol resolution logic has already once looked
correct in code review while being wrong in practice (see Known Gap #2).

For anything not covered by this script (arbitrary field inspection), query
directly:
```js
const prisma = require('./server/prisma');
const r = await prisma.runResult.findFirst({ where: { runId: '<id>', testCaseId: '<id>' } });
const steps = JSON.parse(r.stepResults || '[]');
// steps[i] = { operationId, kind, action, target, plannedText, verifiedLocator,
//              commitDisposition, reason, operationCheck, authoredStepId, assertionId, ... }
```
`stepResults` is the single source of truth for codegen — NOT `replayIrJson`
(that field has a known historical field-mapping bug and is not read by the
generator; see PHASE_LOG 2026-08-05 "replayIrJson field-path bug" entry).

## How to regenerate and read the actual generated code

```
node scripts/qaai-regen-codegen.cjs --run <runId>
```
Prints `admitted`/`blocked` summary plus every generated `tests/*.spec.js`
file body. **Read every line after any renderer change.** This is not
optional — it's how the Select double-click bug was caught, twice.

To see it through the real HTTP path the UI actually uses (once a fix is
also verified via the script above):
```
curl "http://localhost:5000/api/projects/1582559f-364f-4d0e-bfde-fd18832fdaa7/output-files/download.zip?framework=playwright-reference&runId=<runId>" -o out.zip
```
(needs the same auth cookie + CSRF header as qaai-trigger-run.cjs — reuse
that script's JWT-signing pattern if you need to call this directly.)

## Conductor live-testing rules — must not violate

From CLAUDE.md, restated because violating these is the single fastest way
to lose the user's trust (has already happened once this project, per
PHASE_LOG history — don't repeat it):

1. **Live Conductor execution speed must never regress.** Every one of
   today's fixes was verified to not add latency (evidence capture is
   fire-and-forget per-operation, wrapped in try/catch, never blocks
   dispatch of the next operation). If you add ANY capture/evidence code to
   the live pipeline, prove via before/after run timing that it didn't slow
   things down — the user checks this.
2. **Never let evidence/codegen work affect the verdict.** `BrowserTransactionController`
   is the sole execution/verdict authority. Healer/Critic/Output-Files/Reports
   are passive, evidence-only consumers. If you're tempted to have codegen
   logic influence whether a case is marked pass/fail — don't. That's an
   architecture violation the whole controller cutover was built to prevent.
3. **Run `npm run verify:controller-cutover` after touching ANY of the "Live
   Conductor pipeline" files listed above.** No exceptions, even for a
   one-line change. It takes 90 seconds. It has caught real regressions before.
4. **MCP snapshot refs (e.g. "e16") are session/snapshot-scoped and get
   reused across later page states.** This caused a real, confirmed bug
   once (an Email field's locator resolved to a different page's logo)
   because capture ran too late, after navigation had already happened.
   Any new capture code MUST fire as close to the actual DOM interaction as
   possible, not in a batch "at the end."
5. **Independent re-verification is not optional.** `captureVerifiedLocator()`
   re-proves a ref via a fresh `captureStructuralLocator()` call rather than
   trusting the ref used during execution. Don't skip this "just to get more
   coverage" — a locator that looks plausible but wasn't re-proven is exactly
   the kind of "looks right, isn't" output the user has zero tolerance for.

## What you must NOT do

- Do not run `npx prisma generate` directly — use `npm run prisma:generate`.
- Do not bypass git hooks (`--no-verify`) or skip migration steps.
- Do not mock the database in tests — integration tests hit real SQLite.
- Do not run `npm install` without the operator's explicit go-ahead.
- Do not run destructive git operations (`reset --hard`, force-push, branch
  deletion) without explicit instruction.
- Do not weaken the precision contract to inflate the "rendered" percentage.
  A lower honest number is always better than a higher fabricated one — this
  has been said to you directly and repeatedly by the user across this
  project's history.
- Do not attempt BDD or Selenium format work before Playwright POM (JS + TS)
  is genuinely complete — see "Building POM JS/TS" above. That's the current
  named priority, not the flat format (the flat format's own remaining gaps,
  #1 and #2 below, come after POM has SOME runnable output, not before).
- Do not guess a fix for Known Gap #2 below (Select/Radio option-vs-trigger
  ambiguity) — it needs real distinguishing DOM evidence, investigated the
  same way the original bug was found (regenerate, read output, check DB).

## Known gaps — what's actually left to build, in priority order

### 1. Dispatch-time locator capture for page-transitioning clicks (DO THIS FIRST)

Plain Click operations that cause an immediate page transition ("Continue
button", "Next button", "Sign in button on the Microsoft password page")
commit successfully (`commitDisposition: EXECUTED`) but capture NO locator.
Their commit `reason` is `matched:next-required-control` — the controller
proves the click worked by observing that the NEXT page's expected control
became visible, not by re-observing the clicked button itself. By the time
`captureVerifiedLocator()` fires (immediately after commit, current design),
the browser has already navigated past the page the button lived on, so the
independent re-verification correctly returns null — the button really is
gone from the DOM. This is the single highest-value remaining fix; it's
blocking a large fraction of every login/navigation-heavy flow.

**Where to look**: `exactNextRequiredControl()` in `controllerMcpRuntimeAdapter.js`
(search for the name) is what decides this commit path fires.
`resolvedRefByOperation.set()` (same file, inside `resolver()`) already runs
BEFORE dispatch — so a ref for these buttons likely DOES exist in that map
at resolution time, before navigation. Investigate whether the existing
`resolvedRefByOperation` entry (pre-navigation) is enough on its own, or
whether `captureVerifiedLocator()`'s independent RE-verification against the
CURRENT (post-navigation) page is the actual blocker. If it's the latter,
you may need a capture mode that trusts the pre-dispatch resolution for
this specific commit pattern (`next-required-control`) rather than
re-verifying post-navigation — but this needs careful thought: it would be
capturing an UNVERIFIED ref for this class of operation, a real tension
with the precision contract above. Do not resolve that tension by guessing;
trace the actual data flow first, the same way the Select/Radio bug was
traced (read the resolver/composite-executor code, check real DB evidence,
regenerate and read output).

### 2. Select option-vs-trigger ambiguity for specific control types

Most Select operations now capture the real distinct option (proven live:
`span[aria-label="Inbound"]`, `span[aria-label="Collect"]`, every Time
dropdown's own `span[aria-label="HH:MM"]`). But "Equipment dropdown" (a
searchable/typeahead combobox) and both Time Zone dropdowns (PrimeNG-style)
resolve their "chosen option" back to the SAME element as their preceding
trigger click. `liveReplayCodegen.js` currently has a dedup guard (compares
against the immediately-preceding click-like locator) that correctly
prevents rendering a broken duplicate click for these — but that's a safety
net, not a fix. These controls' Select operations stay permanently
diagnostic-gapped until this is resolved.

**Where to look**: `resolveDynamicCandidate()` in `controllerCompositeExecutor.js`
is what picks the "option" candidate — for these controls it's picking the
trigger itself as the best-scoring candidate. You'd need either (a) a way
to distinguish "the option that got selected" from "the trigger that's
still visible" using a different signal (e.g. `aria-selected`, the
resolved candidate's committed *value* rather than its *ref*, or excluding
candidates whose ref matches the phase's own `ownerRef`/`triggerRef`), or
(b) accept this is architecturally unresolvable for this control type and
design a different render strategy (e.g. render the OWNER's post-commit
value via `.fill()`-style readback instead of a click, since these are
typeahead-style — check whether the owner's text value after commit
actually reflects "LTL"/timezone selected, which might already be provable
via a different capture path).

### 3. Autocomplete/virtualized Select rendering

Controls whose selection commits via an in-page `browser_evaluate` scan
(`buildVirtualizedOptionSelectionFunction` in `controllerCompositeProtocols.js`
— the `atomicSelection === true` branch of `createDropdownProtocol`) never
produce a discrete DOM ref, by architecture — `committedCandidate` is
correctly `null` for these (see the semantic-acknowledgment branch in
`controllerCompositeExecutor.js`). To render these you'd need the matched
option's TEXT (which the scan function has, but doesn't currently surface
outward) and a text-based Playwright interaction strategy, not a
locator-based one. Not started. Real design work, not a quick patch.

### 4. Collection and temporal-relationship assertions

`AssertCollection`/`AssertCount` and `AssertTemporal` types never get a
single `candidateRef` from `evaluateControllerAssertionSnapshot()` — there's
structurally nothing single-element to capture (a collection assertion
checks N items; a temporal-relationship assertion compares two separate
values). These need their own render strategy — e.g. `.locator(...).count()`
assertions for collections, or a computed comparison for temporal ones. Not
started.

### 5. Calendar grid-navigation fallback — verify, may not need building

The current renderer assumes every `Date`/`DateTime`/`Time` operation
commits via typing into the owner (rendered as `.fill()`). Every Date
operation checked live so far commits via `reason:
composite_protocol_committed:owner-readback`, consistent with that
assumption. But `createCalendarProtocol()` in `controllerCompositeProtocols.js`
also has a full year/month/day grid-picker phase sequence
(`open-year-picker`, `choose-year`, `choose-month`, `choose-day`) as an
alternate path. If a real case ever actually takes that path (check the
`reason` field for something other than `owner-readback` on a Date op, e.g.
`composite_protocol_committed:choose-day`), the current `.fill()` render
would be WRONG for it. Before spending time here: check whether this path
ever actually fires in real usage. If it doesn't, don't build for it
speculatively.

### 6. BDD / Selenium output formats — separate builds, explicitly deferred

Playwright POM (JS + TS) is covered above as the current named priority —
build that first (see "Building POM JS/TS"). BDD (Gherkin + step defs) and
Selenium (Java) are each a further structurally different output shape that
would need their own renderer built on the same `stepResults` evidence —
not a bridge, effectively a parallel build per format. Do not start these
before POM JS/TS has genuinely runnable output, and ideally not before the
flat-format gaps #1–#2 below are closed too.

### 7. Repair-proposal flow / "run bundle in browser" — unverified for new schema

Existing secondary features on the Output Files page, built against the
legacy schema's gap model. Confirmed (via the 26 existing `replayExport*.test.js`
tests, all still passing) that they don't crash for old-schema runs. Whether
they produce anything USEFUL for new-schema (`qaai-controller-replay-v1`)
runs is untested. Investigate only after #1–#5.

## Verification checklist before calling anything "done"

For every change:
1. `node --check <file>` on every touched file.
2. If you touched anything in the "Live Conductor pipeline" list above:
   `npm run verify:controller-cutover` — must show `GATE_PASS` for all 22
   verifiers + `230 passed` (or however many exist by the time you read
   this) in the unit suite.
3. Trigger a fresh live run (`qaai-trigger-run.cjs`), wait for completion
   (`qaai-inspect-run.cjs`), regenerate code (`qaai-regen-codegen.cjs`), and
   **read every line of the output yourself**. Do not trust that a fix
   "should" work from code review alone — this project's history has two
   confirmed cases (stale MCP ref, Select double-click) where correct-looking
   code produced wrong output, caught only by reading real generated code
   against real run data.
4. Append a dated section to `PHASE_LOG.md` (scope/built/decisions/verification/
   open items/files touched) and update the relevant `BUILD_PLAN.md` table row.
   This is not busywork — it's how the next session (human or AI) picks up
   context without re-discovering everything from scratch.

## Files this session touched (for quick review of exactly what changed)

```
server/services/controllerCompositeExecutor.js      — committedCandidate capture
server/services/browserTransactionRuntime.js         — capture-trigger gate extended to assertions + composite candidate
server/services/agents/controllerConductor.js        — captureLocatorEvidence signature threading
server/services/controllerMcpRuntimeAdapter.js       — assertion candidateRef capture, captureVerifiedLocator committedCandidate param
server/services/codegen/liveReplayCodegen.js          — Navigate/WaitForState/Scroll/Select/Radio rendering, dedup guard
server/services/codegen/replayExport.js               — additive new-schema detection + bridge to liveReplayCodegen
scripts/qaai-trigger-run.cjs                          — NEW, this handoff
scripts/qaai-inspect-run.cjs                          — NEW, this handoff
scripts/qaai-regen-codegen.cjs                        — NEW, this handoff
PHASE_LOG.md / BUILD_PLAN.md                          — documentation of all of the above
```
