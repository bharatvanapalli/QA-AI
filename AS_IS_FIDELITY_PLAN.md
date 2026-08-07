# AS-IS Fidelity Plan — QAAI Output Files

Status: canonical plan (converged 2026-06-12). Governs everything the Output Files
tab and ZIP emit. Supersedes ad-hoc codegen patching for this workstream.

---

## 0. The one principle: faithful transcription

**The live MCP run is ground truth. The exported script is a faithful, idiomatic
transcription of it.** QAAI is not a "script generator" that tries to write good
tests — it is a *transcriber* that re-expresses exactly what the agent did, in
standard, human-maintainable code.

Three laws:

- **L1 — Pass fidelity.** The case passed live → the script runs clean and passes,
  using the same elements / values / assertions.
- **L2 — Defect fidelity.** The case failed live because a real assertion/validation
  failed → the script **fails on that same assertion.** A failing script is how we
  hand a developer proof their site has a defect. A failing test is a *success*, not
  something to "fix."
- **L3 — No artifacts (the only real bug).** The script must NEVER pass, fail, or
  crash for a reason that was not in the live run — a bare-eval crash, a hallucinated
  locator, a blank page from missing login, a masked-away test value. Every mechanism
  below exists to kill artifacts. Nothing exists to force a pass.

> If the script's outcome differs from the live run's outcome, that delta is a codegen
> artifact and the only thing we hunt.

---

## 1. Source of truth: the pinned run

The conductor's live run records, per case, into `RunResult.replayIrJson`: each action
(`tool` + `args` + `narration`), the **resolved element** for that action (`domFacts`:
role/name/selector captured at click time — `conductor.js` `recordSuccessfulLocator`,
`mcp.js` `extractDomFactsForTool`), the **values typed**, the **assertion_check**
outcomes, and a **verdict**. The export compiles ONLY from this envelope —
"NO legacy fallback, NO regen from case text, NO adapter improvisation"
(`replayExport.js`). Fidelity is mechanical: re-execute these exact actions against
these exact elements, with these exact values, checking these exact assertions.

---

## 2. Artifact taxonomy (A–G) → kill mechanism

| Class | What breaks fidelity / maintainability | Mechanism | Status |
|---|---|---|---|
| **A. Runtime crash** | `page.evaluate(document…)` bare expr runs in Node → `ReferenceError`; live ran it in-browser | `_sanitize.js` **Rule 8** wraps bare browser-global args in `()=>`; convert to native idiomatic assertion when the intent is standard (`type==='password'` → `toHaveAttribute`) | BUILT (wrap) + NEW (idiomatic conversion) |
| **B. Locator** | narration / invented name / ambiguous → times out where live clicked a real element | drop-narration filter (`_candidateNormalize`); emit the action-time captured locator (inline `domFacts` first); **identity enrichment** for nameless/icon elements (real attrs + unique selector, by `ref`); **uniqueness probe** | BUILT (filter+inline) + NEW (enrichment+probe) |
| **C. Setup / state** | standalone spec asserts a logged-in page with no login; orphan teardown on a fresh page | **setup-chain composition** (prepend the case's real auth + navigation); **state-transition waits**; **trace segmentation** (don't carry a prior case's teardown into the next) | NEW (largest gap) |
| **D. Value** | masking overwrote the intended literal on a negative case → defect hidden | **action-time value binding**: emit the literal as typed; classify secret→`envRef`, intended test value→literal, dynamic→`regex`/`dataRef` | NEW (partly via `_env`/mask today) |
| **E. Assertion** | non-diagnostic structural label; ungrounded guessed string; unscoped global check | **structural-label gate** (`groundAssertions.js`, role-keyed); **grounding** (soft-tier only); **assertion scope** (container/row/column) | BUILT (gate+grounding) + NEW (scope) |
| **F. Idiomatic shape** | machine bloat: `el1/el2`, `ASN-xxxx` annotations, `_evalResult` scaffolding | idiomatic emission: semantic names, native assertions, clean test names | PARTIAL (hybrid trim) + NEW |
| **G. Maintainable framework shape** | inline selectors → testers firefight selector changes across files; output looks like telemetry replay | **Centralized locator repository + page objects + manual-override contract + evidence separation** (see §4) | NEW (the maintenance shield) |

File-by-file mapping of the 14 sample exports lives in §9 / the audit report.

---

## 3. Defect fidelity (L2), guaranteed

The pinned `declaredAssertions` carry the exact `expected` value + `criticality`. The
adapter asserts **exactly that set — no upgrade, no invention** (`_fidelity.js`). We
demote ONLY non-diagnostic structural labels and **ungrounded soft-tier** copy — NEVER
a real `must`. So a real assertion failure in live reproduces as the same failing
assertion in the export. Negative cases emit the **wrong value the agent typed** (D),
so the invalid path genuinely triggers and the script shows the defect. We never turn a
red into a green.

---

## 4. Class G in detail — Maintainable Framework Shape

A runnable export must look like a human automation framework, not a telemetry dump.
Target layout (Playwright shown; per-framework presets in G.6):

```
tests/        admin-navigation.spec.ts      (reads like English; imports page objects)
pages/        LoginPage.ts, PIMPage.ts       (faithful action wrappers)
locators/     login.locators.ts, …           (strategy-tagged, editable)
support/      auth.ts, testData.ts
evidence/     locator-manifest.json, replayir.json, certification-report.json
playwright.config.ts
```

### Two hard guardrails (or Class G regresses us)

1. **Semantics-preserving refactor only.** The repository stores the *exact*
   probe-approved action-time locator, renamed and relocated. It must NEVER re-derive a
   "cleaner" selector. (e.g. a password field that resolved as
   `getByRole('textbox',{name:'Password'})` is stored as that — NOT rewritten to
   `input[type="password"]`; re-derivation is a website-specific heuristic and an L3
   fidelity break.) Site-specific *selectors* in the repo are correct (they are real
   evidence); site-specific *rules* in our generator are forbidden.
2. **Deterministic idempotent union, conflict → block.** A shared per-domain file is
   the same shape that caused the historical `pimPage.X is not a function`
   last-write-wins clobber. It is safe only when built by a deterministic merge keyed by
   semantic name across all cases: same name → same expression = reuse; same name →
   *different* expression = **hard block + surface both**, never silently pick one.

### G.1 Central locator file — strategy-tagged schema + resolver + equivalence

Locators are a tagged union covering every approved strategy (role+name, css, testId,
label, placeholder, href, name-attr), holding the exact approved components. A resolver
maps each to the framework call and an **equivalence check** asserts the named
expression is identical to the inline one it replaces.

### G.2 Manual override contract (and its fidelity caveat)

```
locators/generated/login.generated.locators.ts   (regenerated; overwritten safely)
locators/overrides/login.override.locators.ts     (tester-owned; never overwritten)
```
Resolver precedence: override → generated. Override keys are the stable semantic names;
a renamed element **surfaces**, never silently orphans. **Caveat:** an override is a
deliberate exit from AS-IS — the certification report marks overridden locators as
"tester-edited, not action-time evidence," and the runtime-parity proof (§6) does not
claim MCP-fidelity for them.

### G.3 No telemetry in runnable code

Move to `evidence/`, not the runnable spec: RunResult/TestCase UUIDs, ASN ids, ReplayIR
ids, raw `el1/el2`, inline candidate arrays. Shared helpers stay in `support/`
(imported, not copied per file).

### G.4 Semantic naming engine (deterministic, narration banned)

camelCase from `role` + `accessibleName` (+ `tag`/`type` for inputs):
"Username"+textbox → `usernameInput`; "Login"+button → `loginButton`; password input →
`passwordInput` (from type, not prose). Fallbacks: testId → name-attr → enrichment.
**If no clean semantic name exists, the evidence is weak → block** (per the gate).
Narration words are banned from names.

### G.5 Page/Screen object layer — CONSTRAINED to faithful wrapping

Methods wrap the recorded actions **1:1** (plus the one recognized atomic sequence:
login via `_login.js`). We do **not** synthesize, combine, or reorder actions to make it
look richer. The method's grouping boundary is the page-identity key (§4.9); the method
name comes from the action purpose. The hand-written look is bounded by what the trace
supports — honesty over polish.

### G.6 Framework style presets

- **Playwright:** `tests/*.spec.ts`, `pages/*.ts`, `locators/*.ts`, `fixtures/*.ts`; no per-spec helper dump.
- **BDD:** `features/*.feature` (business steps only — no locators), `steps/*.steps.ts`, `pages/*.ts`, `locators/*.ts`.
- **Selenium:** `src/test/java/{pages,locators,tests}`, TestNG/JUnit, locators in `By` classes, explicit waits in page methods.

### G.7 Readable-code gate — DOWNGRADE, don't block

A *quality* failure downgrades the file to **Draft** (runnable, flagged un-professional);
only *fidelity/syntax* failures hard-block. Quality signals: UUID-only filename,
`full journey` test name without scenario context, inline locator in test body,
`el1/el2` variables, internal IDs in runnable code, duplicated boilerplate, candidate
arrays dumped into specs, oversized file from embedded support code.

### G.8 Evidence separation

`evidence/locator-manifest.json` (chosen locator, rejected candidates, why, validation
status), `replayir.json`, `certification-report.json`. All internal IDs live here.

### G.9 The domain splitter (generic, no hardcoded page names)

Lives in codegen (`pageObjectRepository.js`), not the conductor (the conductor only
guarantees `normalizedUrl` per action — capture vs compile).

```
key(action):
  segs = pathname(action.normalizedUrl).split('/').filter(nonEmpty)
  segs = segs.map(collapseDynamic)            // 123 / uuid / 40-hex → ":id"
  segs = segs.filter(s => !UNIVERSAL_NOISE.has(s))   // index,home,default,view,web,app,php,html,main — framework-universal ONLY
  return segs.join('/') || 'root'

fileName(key, action):
  base = calibratorPageRole(action.normalizedUrl)   // PREFER the calibrator's classified role
         ?? camelCase(lastSegment(key))             // else route leaf segment
  return base + "Page"                               // loginPage, dashboardPage, employeeListPage
```

- **SPA fallback** (URL doesn't change between screens): partition by
  `calibratorPageRole` → captured page `<title>`/heading → single URL.
- **Cross-page elements** (global topbar): hoisted to `commonElements` by a deterministic
  ≥N-pages threshold; else per-page (no god-file).
- **Collisions:** two keys → same slug → append a stable path discriminator; same name →
  different expression → block (guardrail 2).
- No page-name dictionary anywhere; everything derived from `normalizedUrl` +
  `calibratorPageRole` (both computed per-site).

---

## 5. Write-after-proof + provenance + tiers

- **Per-file status in the tree:** `{ source, status: runnable|draft|blocked, why, validationsPassed }`. The tab honors the **same gate as the ZIP** (today it doesn't — `outputFiles.js:418` "always show files" is the leak that surfaced broken specs in the tab).
- **Tiers:** Draft (static-validated, marked) · Runnable default (approved evidence + package-validated, per-file) · Certified (runtime parity verified).
- **Blocked cases show why as evidence**, never as a broken `.spec`.

---

## 6. Validation ladder (proof of fidelity)

1. **Static** — sanitize + AST parse + lint (`_certify.js`). Catches loadability, not
   runtime artifacts (a bare-eval parses) — why static alone was never enough.
2. **Compile-time evidence** — every locator/assertion traces to approved action-time
   evidence; the uniqueness probe runs against the **frozen action-time snapshot** pinned
   in the ReplayIR (never a live, mutated browser — see §10.3), rejecting any candidate
   that does not resolve to exactly the acted-on element.
3. **Runtime parity (Certified tier)** — re-run the package, assert **export verdict ==
   pinned live verdict, per case.** Opt-in, never a hard write-gate (a down SUT must not
   blank the folder). The literal proof of "live == export."

---

## 7. Sequencing (correctness before maintainability)

0. **Provenance audit** (read-only) — diff real runs' current export per file: already-fixed vs still-artifact.
1. **Provenance + per-file status + uniform tab/zip gate.**
2. **Locator identity enrichment + uniqueness probe** (kills B).
3. **Setup-chain composition + state waits + trace segmentation** (kills C — largest).
4. **Value binding** (kills D).
5. **Assertion scope** (completes E).
6. **Idiomatic + POM-LR** (F + G) — only after locators are correct.
7. **Certified runtime-parity tier** (proves L1/L2).

Each behind a deterministic guard (`scripts/verify_*.cjs`).

---

## 8. Honest boundaries (what AS-IS does NOT mean)

- **Not "all green."** By L2, cases that failed live fail in export — the deliverable.
- **No faking.** A self-contradicting case (fills valid password, expects "Invalid
  credentials") will fail until *authoring* injects a real wrong value. Codegen won't fake it.
- **ESS files need an ESS credential profile** to compose login (C); without it they are
  honestly blocked, not faked into a fresh login.
- **Overrides are not AS-IS** (G.2) — marked, not certified as MCP-faithful.
- **Method-POM is bounded by the trace** (G.5) — we don't invent abstraction.
- **External factors out of scope** — site down / real-site locator change. Certified
  preflight reports "environment unreachable — not a script defect."

---

## 9. Starting line (built today)

Rule 8 (turns ~8 of the 14 sample files from instant crash → running),
drop-narration filter, snapshot-derived roles, structural-label gate, title-integrity,
`complete:false` block, certify parse-gate, no-LLM-locator (hard-fail marker, not a
guess), shared `_login`/`_env`, IR-only export. Remaining NEW work concentrates in
C (setup), B-enrichment, D (value), E-scope, F+G (idiomatic + framework shape), and the
runtime-parity proof.

---

## 10. Appended refinements — edge context & dynamic data (2026-06-12)

These harden the plan against encapsulation, multi-window, SPA timing, and runtime
tokens. The standard Playwright MCP (0.0.75) is aria-snapshot based, so each notes its
**capture dependency** honestly — some of this is NEW capture, not a schema-only change.
(The Conductor's "Tricky-page playbook" already lets the agent *act* inside iframes /
shadow / tabs during the live run; the gap these close is faithful *export-side*
reconstruction.)

### 10.1 Encapsulation: iframe & shadow DOM (refines G.1 / Class B)

The locator manifest carries an optional `frameChain` (ordered iframe selectors) and a
`shadow` handle; the resolver compiles the parent chain natively BEFORE the target
selector.
- **iframe** → `page.frameLocator(sel)…` (Playwright) / frame switch (Selenium).
  *Capture dependency:* the frame's own selector must be captured at action time — the MCP
  snapshot shows frame **nesting via indentation** but not a usable frame selector, so it is
  derived like any other element's locator.
- **open shadow DOM** → usually **no special handling**: Playwright's `getByRole/getByText`
  pierce open roots by default. Only deep/nested cases need an explicit pierce string.
- **closed shadow DOM** → not pierceable by Playwright or MCP → **honest block**, never a guess.

Without the frame chain, an in-iframe action's candidate resolves to 0 in the frozen probe
→ false block; this closes that gap.

### 10.2 Multi-tab / window contract (refines Class C / state transitions)

Track a `pageContextId` per action. When an action opens a popup / new tab (e.g.
`target="_blank"`), emit the switch hook (`page.waitForEvent('popup')` → route subsequent
page-object calls to that context) and, for Selenium, window-handle switching.
*Capture dependency:* MCP 0.0.75 does not expose tab/window IDs natively — this needs
(a) confirming the MCP build surfaces popup/tab events and (b) capturing which context each
subsequent action ran in. If the MCP cannot attribute an action to a context → **honest
block**, never a primary-tab guess.

### 10.3 Frozen point-in-time probe (CORRECTS §6 ladder item 2)

The uniqueness probe runs against the **frozen action-time snapshot** pinned in the
ReplayIR — NEVER a live, re-navigated browser. In SPAs the live DOM has already mutated
past the step, so live probing yields false rejections. The agent's `ref` resolving to
exactly the acted element at action time **is** the point-in-time uniqueness proof; the
probe merely verifies the chosen candidate (role+name) resolves to that same single node
within the frozen snapshot. (Aria-snapshot uniqueness is free today; CSS/structural-strategy
uniqueness additionally needs the action-time HTML serialization captured, or it leans on the
`ref`.) Cheaper, deterministic, SPA-safe — a genuine improvement over the earlier wording.

### 10.4 Dynamic-token hoisting in assertions (extends Class D → E, and G.3)

A captured expected-text containing a runtime token ("Order #84920", a timestamp, a
generated id, "Welcome, &lt;name&gt;") must NOT be frozen as a literal. It is parsed, the
volatile span replaced with a regex/pattern (`Order #\d+`) or a bound variable, and hoisted
into the page-object method / data binding; raw observed values go to `evidence/`.
**False-positive guard:** prefer EVIDENCE of variability — if the same assertion across
reruns / data-rows showed different values, it is dynamic; a single static observation stays
literal unless it matches a strong dynamic pattern. This avoids regex-ing genuinely static
copy ("Top 10" must not become "Top \d+").

---

## 11. Deferred — Framework-selection registry & export-boundary cleanup (DO LAST)

*Status: parked. Pick this up only after the AS-IS fidelity work above is settled — we are
mid-stream on that and this is lower priority. Captured here so it isn't lost.*

**Context.** A teammate flagged a broad "two competing export systems" critique. Verified
against the live wiring (`server/routes/outputFiles.js`): **mostly stale** — the ReplayIR path
(`buildReplayExport`) is ALREADY the default product path for both the Output Files tab and the
ZIP; the legacy LLM generators (`pom.js`, `playwrightBdd.js`, `seleniumBdd.js`, …) are opt-in
only (`?source=legacy`) or a fallback for runs with no ReplayIR output. So "kill the legacy
path / move to deterministic IR" is a destination we have largely reached — **do NOT undertake
a big refactor on that framing.**

**The one real, live bug to fix here (the only actionable part):** `replayFramework()`
(outputFiles.js ~line 280) maps `playwright-js → playwright-reference-js`, `playwright-bdd →
replayir-bdd`, `selenium-java → selenium-reference`, else `DEFAULT = playwright-reference`. It
has **no case for `selenium-bdd`** (and `cucumber-playwright`), so a project set to Selenium BDD
**silently exports a Playwright package** — a valid-looking ZIP in the wrong framework. The raw
`?framework=` query param also passes through unvalidated.

**Faithful fix (small, contained):**
1. **Verify-first:** confirm what the Project Setup UI / `project.framework` enum actually
   exposes (does it really offer `selenium-bdd`? are `playwright-pom` / `playwright-flat` real?)
   so the registry matches reality.
2. Centralize the product-name → adapter-id map as ONE registry (the teammate's
   `PROJECT_REPLAY_FRAMEWORKS` constant is the right seed) and route BOTH `replayFramework` and
   the ZIP export through it; validate `?framework=` against it.
3. For frameworks with no deterministic ReplayIR adapter (`selenium-bdd` today), **BLOCK with a
   clear reason** (`UNSUPPORTED_REPLAY_FRAMEWORK`) instead of silently falling back to Playwright
   — same "never silently ship something misleading" invariant as the rest of this plan.
4. Add a guard test (registry covers every UI-offered framework; unsupported → block, never a
   wrong-framework emit). Either wire the teammate's two dead constants in correctly or strip
   them — no dead code.

**Out of scope:** rewriting/deleting the legacy generators. They are already off the default
path; leave them as legacy/debug unless a separate decision says otherwise.
