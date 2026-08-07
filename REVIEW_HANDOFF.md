# REVIEW HANDOFF — Autonomous-QA redesign (Phase A foundation + VerdictEngine core)

**Read this first — git caveat.** The working tree sits on a large *pre-existing uncommitted baseline*: most of `server/services/*` shows as untracked and core files (`conductor.js`, `mcp.js`, `architect.js`) show ~19k-line diffs that span the **entire project history**, not this work. **`git diff` will NOT isolate the changes under review.** Review exactly the files + line anchors listed below.

## Context / intent

Shift the platform from a brittle *contract-executor* to an **Autonomous QA Engineer**:
- **Architect = Strategist** → authors an AI-derived `requiredEvidence` contract per data row (declaredAssertions become *advisory*, not the oracle).
- **VerdictEngine = deterministic Judge** → `works | bug | not_judged` from `requiredEvidence` vs the evidence the Conductor gathered. No LLM decides pass/fail (preserves "never fake-pass").
- **Conductor = Investigator** → gathers evidence, adapts within steps (wired in Phase B, NOT in this changeset).

This changeset is **Phase A's deterministic foundation + the VerdictEngine core**. It is **unit-proven only**. See "Status" — it is **not wired into the live run and not validated by any real generation/browser run yet.**

## Root cause this fixes (from the real run `90002e1c`)

A negative-login row passed all 6 steps yet was marked **FAIL**: the Architect stamped `payload.pageName = "{{expectedValidationError}}"` onto a `must` PAGE assertion → the per-row substitution made the page identity a garbage error-string (`username_is_required`) → the PAGE semantic rescue correctly rejected it → `anyHardNotMatched(must) → fail`. The matrix also mixed `emptyUsername / validAdminInputs / overlong` under **one** oracle.

---

## Files changed (review these exact spots)

### A. Verdict-poison fixes
| File | Anchor | What the edit does | Review note |
|---|---|---|---|
| `server/services/agents/architect.js` | `bindExpectedLandingPageAssertions` **L1274** | **Neutered to a no-op.** Was the generation-time poison (stamped the expected-column token as `pageName` on every PAGE assertion of a data-bound case). | Confirm no caller relies on its old stamping. It's intentionally inert now. |
| `server/services/testDataMatrix.js` | `bindExpectedColumnToAssertion` **L689** | Run-time de-poison: a PAGE identity is rebuilt **only** from a URL-like destination; an error string can never become `pageName`; a leftover `{{token}}` pageName is stripped. | Verify the URL-destination path still binds (success rows). |
| `server/services/mcp.js` | `isUntrustedPageName` **L3497**, `matchPageAssertion` **L3529**, forbiddenSignals channel **L3655**, rescue de-poison **L3921/L3927**, atlas guard **L3962** | (1) `forbiddenSignals` hard-deny channel — a PAGE check can require markers ABSENT (e.g. dashboard absent on a negative row) and it gates the single-signal `primaryIndicator` fast-path. (2) Rescue de-poison: untrusted `pageName` → LLM claim built from declared signals, not the garbage label. (3) Atlas write guarded against a garbage pageName. | **Key regression check:** existing PAGE assertions (no `forbiddenSignals`, trusted pageName) must be unaffected — the 2 PAGE suites still pass. The channel is inert unless `forbiddenSignals` is declared. |

### B. Contract layer (per-row intent → structured evidence)
| File | Anchor | What the edit does |
|---|---|---|
| `server/services/testDataMatrix.js` | `classifyRowOutcomeClass` **L604** (+ `classifyOutcomeWord` L526, `classifyFromExpectedColumn` L540, `classifyFromInputs` L577) | Deterministic row classifier → `success / required_validation / auth_rejection / boundary / unknown` via a priority ladder (class column → expected-column semantics → input-value semantics → fallback). Generic, no site strings. |
| `server/services/testDataMatrix.js` | `buildRowEvidenceContract` **L819** | Builds the per-row `{ intentClass, confidence, requiredEvidence[], advisoryExpectations[], contractDeltas[] }`. Emits `destination_absent` for negative rows; emits a **conflict delta** when a negative row carries a success destination (intent stays primary). |
| `server/services/testDataMatrix.js` | `detectColumnRole` **L793** / `detectColumnRoles` **L809** | Column-role map: input/class/destination/error/**absence/presence**/count/empty_state/metadata. |
| `server/services/testDataMatrix.js` | `resolveCaseRows` attach **L409** | Attaches `row.evidenceContract` to each resolved data row at run time. |
| `server/lib/declaredAssertions.js` | `VALID_PROVENANCE` **L76** | Added `'qa_standard'` so AI-added QA-standard checks are tagged distinctly from `doc_quoted`. |

### C. Deterministic judge
| File | Anchor | What the edit does |
|---|---|---|
| `server/services/verdictEngine.js` *(new)* | `evaluateEvidenceContract` **L61**, `mapVerdictToRunStatus` **L110** | Pure tally: any *violated* → `bug`; else any *unobservable* → `not_judged`; else all *satisfied* → `works`; empty contract → `not_judged` (never fake-pass). Maps to `pass / fail / blocked(evidence_missing)`. **Not called by the conductor yet.** |

### D. ADO / text lane (deterministic spine; LLM extraction quality unverified)
| File | Anchor | What the edit does |
|---|---|---|
| `server/services/agents/storyBehaviorExtractor.js` *(new)* | `extractBehaviorModel` **L148**, `normaliseBehaviorModel` **L86** | LLM: ADO/Jira text → structured behavior model (mirrors `instructionReader`). `normaliseBehaviorModel` deterministically validates/coerces/drops (the unit-tested half). |
| `server/services/storyBehaviorModel.js` *(new)* | `generateScenariosFromBehaviorModel` **L85**, `behaviorModelToGroundingBlock` **L196** | Deterministic: model → scenario classes + `requiredEvidence`; and the grounding block the Architect will consume. |

### E. Evidence governance
| File | Anchor | What the edit does |
|---|---|---|
| `server/services/evidenceRegistry.js` *(new)* | `EVIDENCE_KINDS` **L29**, `assertKindsRegistered` **L69**, `partitionByCheckability` **L87** | Closed vocabulary of every `requiredEvidence.kind` + `hasChecker` flag. A kind not in the registry can't be emitted; a kind without a checker is *advisory* (never gates the verdict). Enforces checker↔kind co-evolution. |

### F. Stability
| File | Anchor | What the edit does |
|---|---|---|
| `server/services/agents/conductor.js` | per-row session reset **L2789** | Between rows of a session-establishing matrix, recreate the browser **unconditionally** (removed the URL-heuristic skip that couldn't evict httpOnly cookies → fixed auth pollution across rows). |

### G. Test guards (new, `scripts/`)
`verify_page_matcher_hardening.cjs` · `verify_row_classifier.cjs` · `verify_row_evidence_contract.cjs` · `verify_column_roles.cjs` · `verify_verdict_engine.cjs` · `verify_story_behavior_model.cjs` · `verify_story_behavior_extractor.cjs` · `verify_evidence_registry.cjs`. Each asserts behavior on **real** data shapes (AuthProfiles/FilterData headers, the LINX story, run-90002e1c contract shapes). The guard is the spec for its module — read them together.

---

## Status — do NOT over-trust the green checks

- **Proven:** deterministic + unit-tested only. **8/8 guards green · 3/3 existing suites green · `node --check` clean** on every touched file.
- **NOT wired into the live run:** `row.evidenceContract` is *produced* but **nothing consumes it** — the conductor still uses the old `declaredAssertions → computeVerdict` path; the VerdictEngine is **not called**. Wiring = Phase B (not in this changeset).
- **NOT validated by a real run.** No generation or browser run has exercised any of this. The ADO extractor's *extraction quality* is unverified (needs a real LLM generation).
- **`computeVerdict.js` was NOT touched** — `verdictEngine.js` is a separate, new module by design.
- **Not done:** Architect charter (A4) · deterministic scenario grouping (divergent step flows) · preview-matrix **UI** · Phase B/C/D/E. (ADO flow-injection + preview-matrix **backend** landed in round 2 — see below.)

## How to verify (reviewer)

```
# parse-check
node --check server/services/{mcp,testDataMatrix,verdictEngine,evidenceRegistry,storyBehaviorModel}.js
node --check server/services/agents/{architect,conductor,storyBehaviorExtractor}.js
node --check server/lib/declaredAssertions.js

# guards (deterministic; the spec for each module)
node scripts/verify_page_matcher_hardening.cjs
node scripts/verify_row_classifier.cjs
node scripts/verify_row_evidence_contract.cjs
node scripts/verify_column_roles.cjs
node scripts/verify_verdict_engine.cjs
node scripts/verify_story_behavior_model.cjs
node scripts/verify_story_behavior_extractor.cjs
node scripts/verify_evidence_registry.cjs

# existing suites (regression)
node server/services/__tests__/testDataMatrix.test.js
node server/services/__tests__/matchPageAssertion.test.js
node server/services/__tests__/pageAssertionIntegration.test.js
```

## Review round 1 — findings ADDRESSED (all 9: 2 P0 + 4 P1 + 3 P2)

Verified by `scripts/verify_review_fixes.cjs` (repro-style, all green) + full regression (9 guards + 3 suites green).

- **[P0] PAGE de-poison incomplete after substitution** — `substituteAssertion()` runs before the binder, so `{{expectedValidationError}}` was already the plain string `"Username is required"`, which a `{{…}}` test missed. Fixed: extracted `isUntrustedPageName` to a shared lib **`server/lib/pageIdentity.js`** (used by BOTH `mcp.matchPageAssertion` and the binder); `bindExpectedColumnToAssertion` now strips an UNTRUSTED pageName by shape (prose / outcome words / slug / single-word errors like "Failed"/"Denied"), preserving legit identities ("Dashboard"). Added negative-outcome words to the shared list.
- **[P0] Per-row session reset skipped persisted cases** — detector read `Array.isArray(steps) ? steps : []`, so a JSON-string `steps` → `[]` → false. Fixed: extracted to **`server/lib/sessionScope.js`** `caseEstablishesSessionLive` which **decodes JSON-string steps** before scanning; conductor imports it. Now unit-testable.
- **[P1] data-row guidance contradicted the new model** — `buildDataRowGuidance` reworded: expected value is **ADVISORY**; judge by intent; report deltas; follow intent on contradiction.
- **[P1] vague `page_present(destination, urlPattern:null)`** — a `success` row with no known destination now requires `destination_absent{entry}` (advanced off the login/entry page), never a null-pattern present-check.
- **[P1] destination-column too trusting** — a `landing/destination` column carrying error PROSE ("Access denied") is no longer classified `success`; word-shape/URL/clean-name decide.
- **[P1] `forbiddenSignals` ignored URLs** — `matchPageAssertion` forbidden channel now also checks `forbidden.url` (a negative row landing on `/dashboard` with no "Dashboard" text is caught).
- **[P2] `expectedPageProfile` not generic** — now URL-derived identity only (dropped hardcoded Login/Username/Password/Dashboard signals; atlas provides real signals). `testDataMatrix.test.js` updated (`'login_page'`→`'login'`; intent preserved).
- **[P2] ADO `max_count` without numeric max** — skipped (no more `Max null` / `item_count:null`).
- **[P2] row label leaked input words into classification** — `classifyRowOutcomeClass` no longer uses `row.label` (which embeds the input value) as a class signal; the scenario word comes from `rowClass` / a class-like column. Guard cases updated to the real (`rowClass`) source.

New files this round: `server/lib/pageIdentity.js`, `server/lib/sessionScope.js`, `scripts/verify_review_fixes.cjs`.
Reviewer's vitest caveat is correct: run the `__tests__` suites with `node …` (the handoff commands), not `npx vitest` (its config only includes `tests/unit/**`).

## Review round 2 — overstatement corrected + 2 items closed

The round-1 summary claimed "Phase A complete." **That was an overstatement** — corrected here. What round 2 actually changed:

- **ADO grounding now flows through the NORMAL generation path.** Round 1 wired it only in `server/routes/agents.js`; `server/routes/scenarios.js` (the standard `architect.run` call, ~L878) did NOT pass `behaviorGrounding`. Fixed by extracting a SHARED helper **`buildBehaviorGroundingFromRequirements()`** in `server/services/agents/storyBehaviorExtractor.js` and calling it from BOTH routes (so the two can't drift). The `STORY_SIGNAL` gate + per-requirement best-effort + CANCELLED-propagation live in the one helper now. Architect consumes it at `architect.js:1680` (param) + `:1843` (composed system prompt). *Verified by parse-check; not yet by a real generation run.*
- **Preview-matrix BACKEND built (UI still pending).** `server/services/previewMatrix.js` `buildPreviewMatrix({cases, scenariosById, testData})` — pure, reuses the SAME `resolveCaseRows` the run uses, so it can't diverge. Returns `{ scenarios:[{ scenarioName, cases:[{ dataBound, rowCount, rows:[{ intentClass, confidence, requiredEvidence[], advisoryExpectations[], contractDeltas[] }] }] }], summary:{ totalCases, dataBoundCases, totalRows, byIntentClass, deltaCount } }`. Served read-only at `GET /api/projects/:projectId/scenarios/preview-matrix` (no side-effects, no LLM, no run mutation). Guard: `scripts/verify_preview_matrix.cjs` (real AuthProfiles shape). **The consuming UI (Phase D2c `DataRowAssertionMatrix`) is NOT built.**

Still honestly NOT done (do not call Phase A "complete"):
- **A5 is advisory-only.** There is NO first-class `orphanedDataset` artifact — only `uncoveredSheets` + alignment warnings in `storyDataAlignment.js` / `testDataAuthoring.js` (surfaced as advisory findings, never a forced test/failure). If a first-class finding is wanted, that's a small follow-up; today it's "advisory uncovered/alignment warnings."
- **Scenario grouping is prompt-guided, not deterministic.** A2 killed the one-frozen-oracle defect (per-row `requiredEvidence`), but splitting a scenario when row classes need DIFFERENT step flows (success continues into dashboard checks a negative row doesn't) is still guidance in the Architect prompt (`architect.js:~1595`), not a deterministic splitter. Unsolved.
- **A4 charter rewrite** and **the preview UI** remain.

## Phase B — Checkpoint 1 (recorded-evidence replay) — VERIFIED

**Scope (precise):** this proves the **VerdictEngine + 5 slice checkers** can REMOVE the false website-bug verdict. It is **recorded-evidence replay** (pageState transcribed from run `90002e1c`'s stored assertion evidence in `prisma/dev.db`), **NOT raw-snapshot replay**, and it does **NOT** prove the LIVE Conductor can gather the same evidence (that is B-2).

**What landed:**
- `server/services/evidenceCheckers.js` (new) — `gatherObservation`/`gatherObservations` (checkers: `page_present`, `destination_absent`, `field_error`, `error_present`, `page_settled`) + `judgeRowEvidence(contract, pageState)` (partitions by registry checkability → only wired kinds gate → VerdictEngine). Honesty rule: a `null` channel → `unobservable`, never a fabricated `satisfied`.
- `server/services/evidenceRegistry.js` — flipped `hasChecker:true` for ONLY those 5 kinds; role-access + ADO kinds stay advisory.
- `server/services/testDataMatrix.js` — `buildRowEvidenceContract` now returns populated `sourceColumns` (was dead/empty).
- `server/services/agents/conductor.js` — threaded `evidenceContract` through the `dataRow` rebuild (~L2899) (inert until B-2 consumes it).
- `scripts/fixtures/phaseB_replay_90002e1c.json` (new, provenance: caseId / assertionId / recordedStatus / poisonedPageName / stored evidence excerpt / reconstructed pageState).
- `scripts/verify_phaseB_replay.cjs` (new). `verify_evidence_registry.cjs` updated to the new partition state.

**Result (honest):** OLD poisoned `must` PAGE assertion (`ASN-6f70269f`) recorded **FAIL** on all 5 cases. NEW path on the same stored pageState → **no longer a website bug**; for the real cases it returns **`not_judged` / `evidence_missing`** because `field_error` was never captured in the cancelled old run — this is correct and **must NOT be converted to PASS** until B-2 captures scoped errors live. PASS path proven only on an explicitly fresh-shaped (non-90002e1c) error-present pageState. Synthetic dashboard-on-negative → **bug → fail** (no fake-pass).

**Verify:** `node scripts/verify_phaseB_replay.cjs` + 11 guards + 3 suites green.

## Phase B — Checkpoint 2 plan (LIVE evidence acquisition) — NOT STARTED

**Governing principle (user-locked): ACQUISITION-FIRST, not gate-first.** The product goal is to actively CAPTURE, REPAIR, RESOLVE and CERTIFY everything `requiredEvidence`/codegen needs so completeness is achieved BY DESIGN. `evidence_missing` / export-block / `test.fixme` are last-resort honesty belts only — never the target architecture.

- **B-2a — pageState builder (offline-provable):** from a settled MCP snapshot extract `{ url, title, visibleText, accessibilityTree, fieldErrors[{fieldRole,messageClass,text}], pageErrors, fieldValues, checkedState, networkFailures, consoleErrors, settled }`. Reuse `mcp.matchPageAssertion`/snapshot parsing — do NOT reinvent. Guard against real OrangeHRM snapshot text.
- **B-2b — Evidence Acquisition Loop:** build an evidence plan from `requiredEvidence` before the row; maintain a per-row **pending evidence board**; re-check pending evidence after every action / snapshot / navigation / wait / recovery; allow late satisfaction while still attributing evidence to the originating step.
- **B-2c — page-state guard + bounded recovery:** before every fill/click/select confirm the current page matches the step context and the target is interactive (not a stale/generic wrapper); on mismatch, recover by bounded QA actions (refresh snapshot, wait, close modal, navigate to intended entry, re-resolve locator, scroll into view). Never act blindly on the wrong page.
- **B-2d — gated wiring:** call `judgeRowEvidence` before `final_verdict`, behind `verdictMode` so the old path is untouched until proven. Conductor autonomy rule: it may act outside authored steps ONLY for recovery + evidence gathering, never to invent business flow; the verdict still comes from the engine, not the LLM.
- **B-2e — DoD (fresh OrangeHRM Authentication slice; needs provider key + restart, no run executing):** empty user/pass rows PASS only when login present + dashboard absent + scoped Required error captured; invalid creds PASS only when rejection error captured + destination absent; valid admin PASSES only when destination present; dashboard-on-negative FAILS; field-error channel captured-but-empty → product bug; truly uncaptured channel → automation `evidence_missing` (not a website bug).
- **Do NOT rewrite the Conductor prompt until B-2 live gather is wired and replay+live checks prove the new path.**

**Expanded tracks pulled forward as primary (not deferred polish):**
- **Deterministic checkers as first-class work:** each `requiredEvidence.kind` needs checker + fixture test + replay test + live snapshot adapter + report renderer + codegen meaning. Implement the LINX/ADO kinds (`counter_shows`, `control_disabled`, `item_count`, `message_visible`, `confirmation_visible`, `choice_outcome`, `ordering_correct`, `value_rejected`, `format_rejected`) BEFORE they become verdict-gating. ADO/story generation must not invent unverifiable kinds (registry already enforces closed vocab).
- **Phase E as a primary track — Certified Action Trace + Locator Certification Engine:** every admitted action stores action kind, page identity, target semantic name, role/type, final locator, locator candidates, strict-uniqueness result, actionability result, post-action evidence, data binding, POM method name. Generic wrapper refs resolve to real child controls before admission; stale/wrong-role refs trigger re-resolution (never exported); fallback CSS only if strict-unique + actionability-verified; POM/spec compile from certified trace ONLY. Export-ready = no null locators / no `(none)` / no missing POM methods / no unverified actions / no naked inline clutter / clean reusable page objects / data-driven loops / correct serial+context lifecycle / TS compiles / JS parses / locator-manifest↔POM match / replays where possible.

## Phase B-2c → E — refined plan (code-ready trace is the bridge)

**Governing rule:** B-2c must PRODUCE the code-ready trace that Phase E CONSUMES. Phase E must NOT recover precision after the run. (Acquisition-first applied to codegen.)

**B-2c — Precision Action Execution and Capture.** Every action produces a code-ready `PrecisionActionRecord` AT ACTION TIME.
- B-2c.0 ✅ Certified target resolver (`mcp.resolveActionRefByDescription` hardened: no static fallback; loose `findRefForLabelInSnapshot` quarantined behind `QAAI_CERTIFIED_ACTION_TARGETS`). Guard `verify_certified_action_target`.
- B-2c.1 ✅ Precision Action Kernel (`precisionActionKernel.buildPrecisionActionRecord`): step+page+target+ref+role+locator+widget+effect+`codeReadyIntent`; certification ladder page→target→effect. Guard `verify_precision_action_kernel`.
- B-2c.2 ✅ Memory/live-ref re-certification (`recertifyRememberedTarget` → reuse/reresolve/block through the kernel). Guard `verify_memory_recertification`. *Logic only — not yet called by `memoryFastPathDispatch` (conductor ~:8904) / `liveRefDispatch` (~:9117).*
- B-2c.3 ⏳ Widget routines (dropdown two-step open→panel-visible→select→value-confirmed; form readback; checkbox/radio; modal; table-row) feed `widgetStateBefore`+effect into the kernel.
- B-2c.4 ⏳ Case-start precision: fresh snapshot + entry-page certification + deterministic nav/session reset for ANY login/repeated-flow case (not just data rows).
- **B-2c.5 ⏳ Code-ready trace assembly:** append every `PrecisionActionRecord` to the action trail in the shape Phase E consumes. **DoD includes: the old post-run locator-RECOVERY path is BYPASSED when records exist (behind the flag)** — records coexisting with recovery would conflict.
- **DoD (B-2c):** no action complete unless its record has page+target+ref+locatorCandidate+value+post-action-effect; every live trail entry carries `codeReadyIntent`; normal/memory/live-ref/widget share ONE record shape; Phase E consumes records directly (no narration-based locator inference).

**B-2d (MOMENT OF TRUTH — do not defer):** wire kernel + recertify + acquireEvidence + judgeRowEvidence into live dispatch behind the flag; all four action types produce the same record; update with post-action effect; reset settle after every mutating action. Nothing improves real runs until this lands.

**B-2e (GATE for C/D/E):** fresh OrangeHRM Authentication slice proves the live kernel/verdict path; then flip `QAAI_CERTIFIED_ACTION_TARGETS` default ON. Do NOT build C/D/E before this is green.

**Phase E — Codegen from code-ready trace.** Input = `PrecisionActionRecord`s. Build locator manifest from recorded candidates; POM methods from `codeReadyIntent`; DDT specs from recorded data bindings; TS/JS from one IR; export validation/compile/replay. (Supersedes post-run locator inference.)

**Phase C — Cautions channel.** On-path failure (e.g. 500 on the login API during a login test) = evidence; off-path (broken footer image, unrelated console error/5xx, spelling) = caution. Cautions NEVER gate the verdict. Scoping uses the row's `requiredEvidence`/intent → sits after B.

**Phase D — Reports/Trail clarity (UI binding over existing verdict+delta data).** D1 per-row identity in the live trail; D2 reports show data entered · authored expectation · actual website behavior · QAAI judgment · "the authored assertion/data was wrong" (surfaces `contractDeltas`/`advisoryExpectations`).

## Design references in-repo
- Full plan: `C:\Users\2461898\.claude\plans\foamy-sparking-adleman.md` (phases A–F, acceptance checklist).
- The acceptance matrix the VerdictEngine is built against is encoded in `scripts/verify_verdict_engine.cjs`.
- Phase B checkpoint-1 proof + provenance: `scripts/verify_phaseB_replay.cjs`, `scripts/fixtures/phaseB_replay_90002e1c.json`.
- B-2c guards: `verify_certified_action_target`, `verify_precision_action_kernel`, `verify_memory_recertification`, `verify_evidenceAcquisitionEngine`, `verify_pageStateBuilder`.
