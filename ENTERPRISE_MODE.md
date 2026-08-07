# QAAI — Enterprise Mode

The master document for the enterprise-reliability pipeline. Contracts first, AI
second, gates always. Build against this; do not drift from it without updating
it here first.

---

## The invariant (definition of done)

> **QAAI never silently ships an unverifiable, contract-broken, or misleading artifact.**

Not "every test passes." The enforceable guarantee, stated as conditionals:

- if the app is wrong → the test **fails**
- if the test is incomplete → it is **blocked**
- if data mapping is unclear → **human approval** is required
- if generated code cannot compile/run → it is **not shipped**
- if a human step was needed → the export **preserves it** as a manual gate, test hook, or explicit unsupported marker
- if the MCP verdict and the exported-script verdict diverge → the package is **invalid**

Every stage below enforces a slice of this with a deterministic gate. No prompt
promises reliability; gates enforce it. Enterprise Mode is **all-or-nothing** —
no per-gate opt-out except a *recorded* RBAC override.

---

## The pipeline (9 gated stages)

Each stage consumes the prior stage's artifact and may not advance until its gate passes.

| # | Stage | Artifact produced | Gate (cannot pass until…) |
|---|---|---|---|
| 0 | **Requirements Oracle** | Requirement contract (IDs + excerpts) + Requirement Traceability Matrix | every requirement is `covered` \| `manually_excluded` \| `not_automatable(+reason)` |
| 1 | **Role-aware atlas** | PageManifest per **(module × identity × auth profile)**: verified selectors + text corpus + page role | a **fresh, role-scoped** atlas exists for the target module; stale/drifted → re-crawl |
| 2 | **Data mapping + approval** | versioned, **approved** mappingJson | every sheet/column/placeholder human-approved AND verified (exists, typed) |
| 3 | **Assertion contract** | TestCase with the **full** `TestCaseContract`, grounded | `assertContractComplete()` passes (see contract); ungrounded `must` → mismatch finding, never weakened |
| 4 | **Dependency graph** | case-level topo-ordered wave plan | no cycle; a dependent is never scheduled before its prerequisite |
| 5 | **MCP execution** | RunResult + **replay trace** | known starting state (seed applied, prior-run pollution reset) + cleanup registered; mechanical-verdict only; failed `must`-prerequisite **blocks** dependents (`prerequisite_failed`) |
| 6 | **Replay trace → IR** | **ReplayIR** (framework-agnostic) | every executed step + verified assertion represented; `human_input` carried with a disposition |
| 7 | **Export (IR → adapters)** | framework code with adaptive helpers | verdict parity — asserts exactly the contract the run verified; **no secret literals** |
| 8 | **Package run validation** | validated, downloadable package | compiles + discovers + **runs in a clean isolated env**, verdict == MCP verdict; per-adapter |

**Capstone — Evidence bundle:** every run emits one audit artifact: atlas version,
approved mapping, the coverage + traceability matrix, per-case verdict with
assertion evidence, the dependency graph, the export-execution proof, and every
gate's sign-off. This is what a QA lead hands to stakeholders and auditors.

**Anti-circular rule (the oracle backstop):** the atlas governs HOW to interact
and WHICH labels exist — it may **never** originate or override business truth. A
`must` assertion may not have provenance `WEBSITE`. When the atlas lacks evidence
for a required assertion, QAAI emits a **`RequirementSiteMismatch`** finding
(requirement-vs-site drift, for human review) — it never silently weakens the
assertion. This is the cure for "tests the app against itself."

---

## The three frozen contracts

### 1. TestCaseContract — the foundation (Stage 3)

One canonical `persistCases()` writes this for **every** entry path (kills the
agents.js / scenarios.js divergence). One gate `assertContractComplete()` enforces it.

```
TestCaseContract {
  id
  requirementRefs[]   { requirementId, source: BRD|USER_STORY|RELEASE_NOTE, excerpt }   // >= 1, REQUIRED
  module
  authProfile         // identity this runs as: admin|maker|checker|demo|manager|readonly|expired|locked|region:<x>
  steps[]             // placeholders bound to APPROVED mapping only
  declaredAssertions[] {
    id, type, criticality: must|should|incidental,
    provenance: BRD|USER_STORY|RELEASE_NOTE|WEBSITE|HUMAN_OVERRIDE,   // mandatory
    source: { requirementId?, excerpt? },
    payload, targetUrl?, checkAt
  }
  businessRisk: P0|P1|P2
  producesData[] / requiresData[]
  dataBinding: { sheet, rowSelector } | null
  automatability: automatable | manual(+reason)
  // NOTE: coverageDisposition is NOT a case field — it lives on RequirementClause
  // (the RTM is per-requirement). A case carries requirementRefs; a requirement
  // carries its own disposition (covered | uncovered | manually_excluded |
  // not_automatable(+reason)). Reconciled during P2 implementation.
}
```

`assertContractComplete()` rejects the case unless **all** hold:
- `requirementRefs.length >= 1` (traceability)
- at least one `must` assertion (strengthened "no case without declaredAssertions")
- **no `must` whose provenance is `WEBSITE`** (atlas never overrides business truth)
- every `{{placeholder}}` in steps/assertions resolves to an approved + verified mapping
- `authProfile` set (coverageDisposition is a RequirementClause/RTM property, not a case field)

### 2. ReplayIR — the codegen source (Stage 6)

```
ReplayIR {
  caseId, authProfile,
  dataRow?,              // single-row / non-matrix compatibility
  dataRows[]?,           // preferred for data-driven export: one parameterized spec, N rows
  steps[] (
    resolve(candidates[])        // ranked locator fallbacks — the live healer, frozen
    | waitFor(condition)
    | act(action, target, valueRef?)   // NO inline value; valueRef must be env:/vault:/fixture:/masked:
    | handlePopup(known[])
    | assert(contractRef, expected, evidence)
    | humanInput(field, disposition: manual_gate | test_hook | unsupported, valueRef?)
  ),
  verdict { status, perAssertionOutcomes[] }
}
```

**Authoritative shape (zero-drift):** `server/services/codegen/adapters/frameworkAdapter.js#validateReplayIR` + `adapters/fixtures/playwright-reference.replayir.json` are the canonical, executable IR contract — richer than this sketch (`version`, `resolve.as`, `act.target`/`act.valueRef`, `waitFor.condition.{kind,pattern,timeoutMs}`, `assert.channel`/`target`/`evidence`, `authProfile.{strategy,storageStateRef}`, `dataRow.{fields,sensitivity}`, `dataRows[].{fields,sensitivity}`). The P6 emitter MUST produce IR that passes `validateReplayIR`, guarded by an emitter↔fixture check. Any IR-shape change flows into this doc AND `validateReplayIR` together.
For data-driven cases, emit `dataRows[]` with the complete approved row set; keep `dataRow` only as a single-row compatibility shape. `act` and `humanInput(test_hook)` may never carry inline literal `value`; they must carry `valueRef` using `env:/vault:/fixture:/masked:` so secrets and PII are bound by the package shell, not baked into IR or exports.

Frozen enums enforced by `validateReplayIR`:
- `assert.channel`: `UI_TEXT | UI_ROLE | PAGE | URL | API | DB_READ | EMAIL_SMS | DOWNLOAD | PDF | AUDIT_LOG | ASYNC_JOB | EVALUATE | FORBIDDEN_TEXT | FORBIDDEN_ROLE`
- `dataRow.sensitivity` / `dataRows[].sensitivity`: `synthetic | masked | restricted`

### 3. FrameworkAdapter — deterministic, not a prompt (Stage 7/8)

```
FrameworkAdapter {
  emitSetup, emitAuth(authProfile), emitLocatorResolver(candidates),
  emitStep, emitWait, emitPopupHandling, emitAssertion(contract),
  emitDataProvider(rows), emitRetryPolicy, emitHumanInput(disposition), emitTeardown,
  fileLayout(), compileCmd(), runCmd(),
  validatePackage()    // its OWN compile+discover+run guard
  regressionCorpus     // its OWN golden tests proving runtime behaviour
}
```

Equal interface ≠ equal reliability. Each adapter (Playwright POM/flat/JS,
Selenium-TestNG, PW-BDD, Selenium-BDD, **company adapters**) earns "first-class"
only by passing its own package-validation guard + regression corpus +
verdict-parity-by-execution. A company framework is a new adapter built from its
**adapter spec**: base classes, utilities, folder layout, fixture/auth model,
wait strategy, assertion library, reporting format, compile + run commands.

---

## Cross-cutting layers

- **Secrets & PII boundary:** credentials/tokens/PII sourced from vault/env at run
  time; masked in logs, replay traces, reports; **never baked** into the IR,
  exports, or data-providers (bind to env/fixtures). Optional synthetic/masked data
  for non-prod.
- **Determinism & anti-flake:** pinned browser/viewport/locale/timezone/env URL +
  seeded data/clock; a pass is confirmed (re-run N-of-M); flaky → quarantined, not
  shipped; tests clean up data they create.
- **Audit, RBAC & maker–checker:** every gate approval (mapping, generation,
  release) is an immutable record (who/when); gates are role-separated; the
  GO/HOLD/NO-GO carries its provenance.
- **Versioning & reproducibility:** every run pins the exact atlas, mapping, and
  contract versions it used; re-validated at run and export time.
- **Resilience:** long runs are resumable/idempotent; every blocked case carries a
  structured reason (`unknown` forbidden on known paths).
- **Environment & data lifecycle (its own gate):** every run establishes a KNOWN
  starting state — seed/fixtures applied, tenant isolation, prior-run pollution
  detected and reset — and registers cleanup/teardown so the suite is idempotent
  and re-runnable. A case that cannot guarantee its starting state is blocked, not
  run on dirty state.
- **DLP / data residency (hard gate):** no requirement text, test data, site
  content, or generated code leaves approved company/local infrastructure. Every
  model/provider call is classified and logged against an allow-list; a disallowed
  provider or egress is BLOCKED, not warned. (Cognizant policy line.)
- **Flake classification:** a non-deterministic result is categorised — app defect,
  test defect, environment defect, data defect, locator drift, timing instability,
  external dependency — never lumped as "flaky." Stakeholders get the cause.
- **Generated-script observability:** package validation (Stage 8) captures
  trace/video/screenshots/logs for the GENERATED script too — not only the MCP
  run — so a script failure ships with proof and a diagnosis.

## Oracle channels (verification is multi-channel)

UI text is not the only oracle. `declaredAssertions` may target, per assertion:
`UI_TEXT` · `UI_ROLE/PAGE` · `URL` · `API` (response/status/JSON path) · `DB_READ`
(safe read-only) · `EMAIL/SMS` (inbox) · `DOWNLOAD/PDF` · `AUDIT_LOG` · `ASYNC_JOB`
(status). The channel is part of the contract and the ReplayIR `assert` op, so the
exported script verifies the same channel the MCP run did.

## Auth & identity policy (SSO / MFA / OTP)

Each `authProfile` declares an auth strategy with an explicit disposition:
`supported_test_hook` (programmatic) · `bypass_fixture` (pre-captured
storageState) · `manual_gate` (run pauses for a human) · `unsupported` (marked,
never silently passed). MFA, magic links, expired sessions, token refresh, and
role switching are first-class strategies, not edge cases.

## Coverage matrix (beyond requirements)

"Covered" is multi-dimensional: **requirement × module × role × data-class ×
browser/device × risk-tier**. The RTM is the requirement axis; the evidence bundle
reports the full matrix so "covered" can't be shallow.

## Scope & boundaries (what Enterprise Mode covers NOW)

In scope today: **functional UI / E2E** validation against requirements. Explicitly
NOT implied (supported later as scoped phases, never silently claimed):
accessibility, performance/load, penetration/security, visual regression, and API
contract testing. The mode never reports coverage it didn't actually exercise.

## Custom framework onboarding (the adapter intake checklist)

A company framework becomes a first-class adapter only with: sample existing tests,
base classes, shared utilities, folder/naming conventions, wait strategy, assertion
library, fixture/auth model, reporting format, CI compile + run command, secrets
policy, and a golden regression corpus to validate the adapter against.

## Release decision policy (deterministic GO / HOLD / NO-GO)

- **NO-GO:** any P0 case failed; any package invalid (won't compile/run, or
  MCP↔script verdict divergence) for a P0.
- **HOLD:** unresolved `RequirementSiteMismatch`; a flaky P0 (unconfirmed);
  uncovered P0 module; P1 failure rate over threshold.
- **BLOCKED (cannot decide):** unapproved mapping; missing/stale atlas; a
  contract-incomplete case in scope; a DLP violation.
- **GO:** all P0 pass and confirmed, coverage thresholds met, no open mismatch,
  every gate signed off — recorded in the evidence bundle with provenance.

---

## Build plan (dependency-ordered)

Built in de-risking order, not pipeline order. Each phase ships a working gate +
its deterministic guard. Two-dev split: **server/pipeline = Claude**,
**codegen adapters + package validation + approval UI = friend**, with the three
contracts above as the frozen seams.

| Phase | Delivers | Owner | Guard |
|---|---|---|---|
| **P0** | This spec frozen on paper | Claude | review sign-off |
| **P1** | `TestCaseContract` + canonical `persistCases()` + `assertContractComplete()` — kills the two-path divergence | Claude | `verify_contract.cjs` |
| **P2** | Requirements Oracle + RTM + mandatory provenance/traceability | Claude | extend `verify_contract.cjs` |
| **P3** | Role-aware atlas: auto-trigger, module-scoped, versioned, drift gate, `RequirementSiteMismatch` | Claude | `verify_atlas.cjs` |
| **P4** | TestData approval gate + auth-profile identity binding (admin/demo/maker per case) | split | `verify_testdata.cjs` (extend) |
| **P5** | Dependency topo + failed-prereq gating on the **AI** engine | Claude | `verify_dependency.cjs` |
| **P6** | Mechanical-verdict-only + `ReplayIR` emission (incl. `human_input` disposition) | Claude | `verify_replayir.cjs` |
| **P7** | Adapter interface + IR→code export w/ adaptive helpers + secrets binding | friend | per-adapter `validatePackage()` |
| **P8** | Per-adapter package validation in a clean isolated env + verdict-parity-by-execution | friend | `verify_executionparity.cjs` + `_smoke_p8_parity.cjs` |
| **P9** | Enterprise Mode toggle (all-or-nothing) + audit/RBAC maker-checker + evidence bundle | split | `verify_enterprise_gates.cjs` |

**Order rationale:** the contract (P1) is the foundation everything validates
against, so it ships first; then the WHAT (P2 oracle), then the HOW (P3 atlas),
then data + identity (P4), dependency (P5), execution→IR (P6), export (P7),
execution-proof (P8), and finally the governance wrapper (P9) that hard-flips
every gate already built.

**Per-phase definition of done** = its gate is live + its guard is green +
`npm test` unbroken + no regression in the trial data.

---

## P2 — Requirement extraction (frozen mini-spec)

**Principle: the LLM proposes, Node disposes.** The LLM extracts *candidate*
atomic requirements and flags *candidate* merges/conflicts. Node OWNS and
verifies everything an auditor relies on: IDs, verbatim excerpts, coverage
states, contract completeness. No oracle fact is left to model output.

1. **ID stability (deterministic, content-addressed).**
   `requirementId = "REQ-" + sha1(sourceType + "\n" + normalize(excerpt)).slice(0,10)`,
   normalize = trim + collapse internal whitespace. Re-uploading the same source
   text yields identical IDs. The LLM NEVER invents IDs — Node computes them.
2. **Source-excerpt proof (verbatim, traceable).** Each requirement stores
   `{ sourceType: BRD|USER_STORY|RELEASE_NOTE, sourceDocId, excerpt, span:{start,end} }`.
   Node VERIFIES `excerpt` is an exact substring of the source at `span`
   (paraphrase → rejected), so an auditor can highlight the exact span.
3. **Granularity (atomic).** One requirement = one independently verifiable
   behaviour, not a paragraph. Node flags any span over a length bound; the LLM
   is told to split compound statements.
4. **Dedupe / merge.** Exact-hash duplicates collapse to ONE requirement with
   multiple `sources[]` (Node, deterministic). Near-duplicates across BRD/US/RN →
   the LLM proposes a merge link; Node records a cross-reference, never a second
   oracle row.
5. **Conflict (never silent).** Contradictory expected outcomes for the same
   behaviour → a `RequirementConflict` finding with both sources + the
   disagreement. HOLD-class. Node never auto-resolves.
6. **Coverage disposition (reason mandatory).** `coverageDisposition ∈
   {covered, manually_excluded, not_automatable}`; the latter two REQUIRE a
   non-empty `reason` (Node-enforced). Reserve `dispositionBy`/`dispositionAt`
   for RBAC attribution in P9.
7. **Website-provenance ban.** Assertion `provenance` becomes MANDATORY, vocab
   `{BRD, USER_STORY, RELEASE_NOTE, WEBSITE, HUMAN_OVERRIDE}`. A `must` with
   `provenance=WEBSITE` → `must_provenance_app_origin` (blocks under Enterprise
   Mode). WEBSITE provenance is legal ONLY for locator/label grounding, never as
   the source of a must's expected outcome.
8. **No orphan cases.** `assertContractComplete()` gains `no_requirement_ref` —
   an automatable case with zero `requirementRefs` is incomplete.
9. **No orphan requirements.** The RTM build (Node, post-generation) gives EVERY
   requirement a row: `covered` (≥1 covering case) | `manually_excluded` |
   `not_automatable`; an uncovered, non-excluded requirement → an `uncovered`
   finding (HOLD-class). Complete by construction.

**Data model** (additive migration, hand-authored + `migrate deploy`): atomic
`Requirement` rows (content-hash id, sourceType, sourceDocId, excerpt, span,
behaviourText, sources[]); `TestCase.requirementRefs` (JSON id[]) +
`coverageDisposition` + `dispositionReason`; findings `RequirementConflict` /
`uncovered`. Reconcile with any existing Requirement model rather than duplicate
(verify at implementation). First implementation is deterministic-heavy: the LLM
extracts candidates; Node verifies IDs, excerpts, coverage, completeness.

### P2-integration — wired into live generation (Hybrid + retrieval)

**SHIPPED 2026-06-03** (verify_contract.cjs 60+ checks, all 8 guards green, npm
41/41). The oracle is no longer inert — it feeds every generation path.

**Doctrine (user-set):** once the oracle exists, full BRD/US/RN **bodies must not
keep flowing to the LLM by default**. The oracle exists to make requirements
deterministic and reduce trust in raw prompt context — so the Architect sees a
**compact, data-minimized clause index**, not the source docs.

- **HYBRID (default once verified clauses exist).** The Architect's user-message
  carries a structured clause index — `{ requirementId, sourceType, behaviourText
  [, moduleHint] }` — and NOT the source bodies. The verbatim excerpt stays
  server-side on `RequirementClause` (audit + Node verification). For authoring
  depth, **local deterministic retrieval** (lexical ranking, NO embedding-API
  egress) attaches a short, **capped + logged** verbatim snippet to only the
  top-relevant clauses. `server/services/requirementContext.js` (pure, guarded).
- **ADDITIVE (explicit dev/RBAC override only).** Full bodies + clause index.
  Selected by `QAAI_ARCHITECT_CONTEXT_MODE=additive`; never the enterprise default.
- **DLP egress gate.** `server/lib/dlpEgress.js` — env `QAAI_LLM_EGRESS_ALLOW`
  allow-lists providers that MAY receive document text. Not allow-listed →
  extraction degrades to a deterministic, **no-egress** split (text never leaves);
  disposition is logged for audit. Unset = inert (backward compatible).
  **OPERATIONAL REQUIREMENT (Cognizant / security mode):** teams MUST set
  `QAAI_LLM_EGRESS_ALLOW` before using real BRD / test data. **P9 flips the
  default to DENY in Enterprise Mode** — an unset allow-list will then mean
  "no provider may receive document text" (deterministic extraction only),
  the inverse of today's dev-friendly inert default. The gate already exists so
  P9 only changes the default, not the call sites.
- **Node disposes (the trust spine).** `architect.markRequirementRefs()` validates
  the LLM's `requirementRefs` against the REAL clause id set — **invented ids are
  stripped**, the case-level union is computed (→ `TestCase.requirementRefs`), and
  a `must` with no valid ref is surfaced as a coverage gap (never auto-failed).
  The prompt forbids inventing ids ("use only ids in the provided clause list").
- **RTM (findings-only until P9).** After cases persist, `persistRtmFindings()`
  builds the matrix and writes `requirement_uncovered` Discrepancy rows. Built only
  on full `/generate` (a single-scenario regenerate must not emit project-wide
  uncovered findings).
- **Orchestrator:** `requirementOracle.prepareArchitectClauses()` (load BRD/US/RN
  Documents → DLP gate → extract → persist → mode decision) — wired into
  `scenarios.js` (`/generate` + regenerate-one) and `agents.js` (all-in-one), so
  no path diverges. **Never throws** — any failure degrades to the legacy path.
- **Activation:** prompt/extraction logic is live on next **backend restart**
  (require-cache); `RequirementClause` persistence activates after the Prisma
  client regen that the restart performs (EPERM lock until then — clauses still
  feed the prompt in-memory meanwhile). `requireRequirementRefs` gate stays
  non-blocking until P9 flips Enterprise Mode on.

## P3 — Role-aware atlas = the HOW oracle (frozen spec)

Extends the EXISTING calibrator (`server/services/agents/calibrator.js`,
`Calibration`/`CalibrationPage`, `getCalibrationContext`/`getCalibrationAtlas`,
`groundAssertions.js`) — does NOT rebuild it. The atlas proves **HOW to interact**
(labels, controls, locators, table shapes); it may **NEVER** create a `must` or
satisfy business truth. P2's anti-circular rule, extended to the site.

**Unit of work (the key shift):** `project + module + authProfile + atlasVersion`
— mirrors the `ScenarioGeneration` (version + isCurrent) pattern. Legacy whole-app
calibrations (module=null, authProfile=null) keep working.

**Fork decisions (user-locked 2026-06-03):**
1. **Module = Focus-first.** User names the module + entry URL to crawl/generate.
   Auto-discovery (clause moduleHints + nav) is a later enhancement. No auto-loop
   of all modules now (token/time/debuggability).
2. **One slice per `(module, authProfile)`.** Calibrate per role; the stored unit
   stays a single slice. Batch "crawl N roles" is UI sugar later. A run/generation
   uses ONLY the atlas slice matching its own `authProfile` (default fixture when
   none) — admin-visible is never evidence for demo.
3. **P3a–c first; P3d separate, reviewed like P2.** P3d (module-scoped generation —
   the generation-behaviour change) ships only after its exact Architect/generation
   diff is shown.

**Schema (additive):** `Calibration` += `module String?`, `authProfileId String?`,
`version Int @default(1)`, `isCurrent Boolean @default(true)`, `atlasFingerprint
String?` (aggregate of page `snapshotHash`es — the drift key), `staleAt DateTime?`.
`CalibrationPage` += `capabilitiesJson String?` (CapabilityRecord[]).

**Capability classification (LLM proposes, NODE disposes).** Each page →
capabilities in the locked vocabulary: `form | table | list | search_filter_sort |
menu | modal | file | workflow_action`, plus a normalized **`entity_collection`**
concept spanning table/grid/card/list (needed for "pick iPhone 17 black with least
visible price"). The LLM may *name* a capability; **Node extracts the evidence
(selectors/fields/columns) from the verified snapshot** — never invented. **Every
evidence selector MUST resolve against the snapshot; an unresolvable selector means
the capability is NOT usable** (dropped, logged).

**Capability Operation Vocabulary — the FROZEN BDD/atlas seam.** Capability records
expose typed *operations* (not prose). This vocabulary is the contract shared by the
atlas (produces it), ReplayIR (executes it), and the BDD lane (renders it). It is
**universal** across domains (HR/CRM/banking/insurance/e-commerce/admin); only the
evidence/locators are site-specific:
```
authenticateAs(role) · navigateToModule(module)
fillField(field, value) · submitForm() · downloadFile()
selectEntityWhere(entity, [ {field, operator, value} ... ])   // over entity_collection
rankByMin(field) · rankByMax(field) · chooseSelected()
assertVisibleText(text) · assertTableContains(row-criteria)
```
A `CapabilityRecord` = `{ type, name, operations[], evidence{...verified selectors...},
elementRefs[] }`. BDD/.feature lines are fixed Given/When/Then phrasings of these
operations; glue calls the operation; the operation compiles to ReplayIR/MCP. **The
LLM selects operations + binds params to verified evidence — it never writes step
sentences.**

**RequirementSiteMismatch.** Deterministic reconciliation of P2 clauses against the
module atlas: a requirement whose interaction surface (page/field/action) is ABSENT
from the slice → a `RequirementSiteMismatch` Discrepancy (clause + missing surface).
Findings-only first; **hard-gated in P9**. NEVER weakens a `must`.

**Drift / version gate.** On (re)crawl of a slice, compute `atlasFingerprint`;
changed → version++ + flip isCurrent (history kept); unchanged → refresh `capturedAt`
(idempotent). `getCalibrationAtlas(projectId, {module, authProfileId})` returns
`{ atlas, freshness: fresh|stale|absent, version }`. **No silent stale reuse** —
staleness surfaced to the Architect; module-scoped generation may refuse a stale slice.

**P3d — module-scoped generation + bound `operations[]` (SHIPPED 2026-06-03, reviewed
+ approved by user + friend; npm 61/61, verify_atlas 13 sections).** Generation is
scoped to one module at a time, fed only the relevant slice (clauses ranked to the
module + capped at 40 — dissolves the `max_tokens` truncation the P2 smoke exposed at
131 clauses — plus the module+authProfile atlas slice + its verified capability menu).
Each automatable case emits a bounded, ordered `operations[]` plan; the LLM SELECTS
operations from the capability menu, NODE DISPOSES (`operationPlan.markCaseOperations`).

LOCKED DECISIONS:
- **Opt-in `module` param first.** Absent → whole-project generation BYTE-IDENTICAL
  (no capability menu, no `operations[]`; the static `SYSTEM_PROMPT` + cache prefix are
  untouched — the menu is a DYNAMIC block, like `siteAtlasBlock`). Present → module-scoped.
  Flip-to-default deferred until proven on one OrangeHRM module.
- **Deterministic `capabilityId`** = `cap-`+sha1(`module|authProfileId|pageUrlNorm|type|
  name|primarySelector`)[:10] — module/page/authProfile context prevents cross-page/role
  collisions ("Save"/"Delete"). `operations[].capabilityRef` binds by id (name fallback in
  soft v1; P9 requires id). Resolution keys mirror the BDD bridge exactly (zero drift).
- **`operationsJson` contract** (on `TestCase`, migration `20260611000000`, additive):
  `{ status:'complete'|'incomplete', operations:[{operation, capabilityRef, params}],
  dropped:[{operation, reason, detail}] }`. The BDD bridge reads `.operations`; the
  export gate reads `status`/`dropped`.
- **THE EXPORT HARD LINE (non-negotiable):** if Node drops an operation, the case is
  `status:'incomplete'`. The BDD **package-export gate MUST refuse to ship a
  complete-looking `.feature`** for an incomplete case — block / mark unsupported until
  the missing capability or data binding is resolved. (Scenario generation stays
  findings-only; the hard stop is at export.) Friend-owned wiring in the export gate.
- **`entity_collection` columns** carry `{name, selector}` (per-column durable evidence)
  — labels validate, but ReplayIR/BDD helpers need a durable selector to read the column.
- **Soft until P9:** dropped ops + unbound placeholders are findings, not failures, at
  authoring. P9 flips Enterprise Mode → hard.

**`scripts/verify_atlas.cjs` (P3 guard) MUST prove:** atlas keyed by
project/module/authProfile/version; stale/absent slice is surfaced (not silently
reused); a changed snapshot fingerprint increments version; a wrong-role atlas cannot
ground a case; every capability selector is verified (unresolvable → unusable);
website-origin `must` is still blocked (P2 invariant intact).

**Build order:** P3a (schema + capability classification + vocabulary) → P3b
(role/module/version crawl + drift gate + slice-aware `getCalibrationAtlas`) → P3c
(`RequirementSiteMismatch`, findings-only) → **P3d** (module-scoped generation,
separate review). Each additive · inert-until-wired · guarded.

## P4 — TestData approval + auth identity (frozen mini-spec)

Stage 2 ("Data mapping + approval") + the `TestCaseContract.authProfile` field made
enforceable. **Principle (as everywhere): the LLM proposes, Node disposes** — the
dataMapper proposes a column→field mapping; Node verifies it (exists/typed) and a
human approves it; identity is a declared business profile, not a captured session.
**Split owner:** server/pipeline = Claude; Approval UI + export-side secrets/data-
provider = friend, across a frozen JSON + route seam. Built P4a → P4b (each proven).

### P4a — Data-mapping approval gate

- **`TestDataMapping`** (new model) = the IMMUTABLE, versioned approval ledger. The
  editable draft stays on `TestDataSet.mappingJson`; approving SNAPSHOTS it as a frozen
  row (`status:'approved'`). Changing an approved mapping requires a NEW version (the
  prior `approved` → `superseded`). `@@unique([testDataSetId, version])`.
- **`testDataApproval.js`** (pure, no LLM/DB) is the gate's teeth:
  - `verifyMapping({mapping, sheets})` — **exists** (`column_not_in_sheet`, error: a bound
    column / expected / rowClass header must be in the sheet) · **typed**
    (`column_type_mismatch`, warning: sampled values for a typeable role conform) ·
    **unclear** (`mapping_unclear`, warning: unmapped / low-confidence). Header match
    normalizes trim+case internally but reports the ORIGINAL header. `ok` = no error.
  - `resolvePlaceholders({cases, approvedMapping})` — every `{{token}}` in steps /
    assertions / declaredAssertions / `operationsJson` params must resolve to a mapped
    role (or `expected`/`rowClass`). Resolves against the APPROVED mapping only.
  - `defaultSensitivity(role)` (masked for password/secret/otp/token/pin, else synthetic)
    + `canonicalJson` (key-sorted, for draft-vs-approved diffing).
- **Routes** (`/api/projects/:projectId/test-data/:tdId/…`, project+org-scoped via
  `getProject`): `POST /approve` — `verifyMapping` → exists-error ⇒ `422
  MAPPING_VERIFICATION_FAILED`; a warning ⇒ requires an `approvalNote` (`422
  APPROVAL_NOTE_REQUIRED`); else a **transactional, race-safe** version bump
  (`$transaction`: max+1 → supersede prior approved → create; retry on P2002).
  `POST /reject` (audit ledger row) · `GET /mappings` (history). `serializeTestDataSet`
  gains `approvedMapping` + `mappingState` (`approved | draft_unapproved_changes |
  unmapped`, canonical-diffed).
- **Contract gate**: `assertContractComplete` gains `requireApprovedMapping` (default
  false) → `placeholder_unresolved` when a case uses a token the approved mapping can't
  fill. INERT until P9 (mirrors `requireRequirementRefs`).
- **A1 — version provenance pin (audit)**: `loadTestDataContext(…, {approvedOnly:true})`
  reads the latest APPROVED `TestDataMapping` (not the draft), returns its
  `{testDataSetId, mappingId, version, status}`, and stamps each binding with its source
  ref. `persistCases`, given an approved context, PINS each case's `dataBindingJson` to
  `{testDataSetId, mappingId, mappingVersion, sheet, rowSelector}`. Run/export resolve by
  the PINNED `mappingId` (`loadApprovedMappingById`), never "latest" — an old case never
  silently upgrades; it changes only on regenerate / explicit re-bind. (Pin + helper ship
  in P4a; consumed under `approvedOnly` at P9.)
- **Inert-until-P9 / trial-data-safe**: every new param defaults off ⇒ current generation,
  the draft path, and the demo flow are byte-identical. Migration additive (`migrate
  deploy`). Guard: `scripts/verify_testdata.cjs` [9]–[13].

### P4↔P6 bridge — role-keyed dataRows + one sensitivity policy (FROZEN rule)

Locked 2026-06-03 (server + codegen agree). Two rules the P6 ReplayIR assembly + export MUST honor:

1. **Role-keyed dataRows.** When P6 assembles `dataRows[]` for export from an APPROVED mapping,
   it MUST key `dataRows[].fields` AND `dataRows[].sensitivity` by the **role/token names** from
   the mapping's `columnToField` — NEVER the raw sheet/Excel header. A mapping
   `password → "Login Password"` exports a row as:
   ```
   fields:      { password: "…" }
   sensitivity: { password: "masked" }
   ```
   This keeps ONE key axis across all three layers: BDD `<placeholders>` (role), mapping approval
   (role), and export masking (role). Raw header names stay server-side. The BDD compiler already
   reads `dataRows[].sensitivity` by field name, so role-keyed rows make its safe-ref output land
   on the correct column.

2. **One sensitivity policy (server is source of truth).** `testDataApproval.defaultSensitivity(role)`
   (P4a, server) is the SINGLE source of truth for the secret→`masked` default. Adapters MUST
   eventually consume it (a shared export / constant), not own a parallel rule. The codegen
   adapter's broader `SECRET_FIELD_RE` is accepted as TEMPORARY fail-safe defense-in-depth, NOT the
   permanent policy — centralize server-side at the P6/P7 wiring so the two lists can't drift.

### P4b — Auth-profile identity binding (SHIPPED + live-proven 2026-06-03)

**Status:** SHIPPED. `AuthProfile` model + `TestCase.authProfile` + migration
`20260613000000`; pure `server/services/authProfileResolver.js` (strategy/disposition
enums, valueRef refs, validation); `assertContractComplete` += `requireAuthProfile`
(inert until P9); `persistCases` stamps `authProfile` via a 4-rung graceful ladder;
`server/routes/authProfiles.js` CRUD (org-scoped, resolver-validated, @@unique→409)
mounted at `/api/projects/:projectId/auth-profiles`; `scenarios.js` resolves the slice
AuthProfile → name and threads it to `persistCases` (inert when none). Guard
`scripts/verify_authprofile.cjs` (5 sections) + live smoke `_smoke_p4b_authprofile.cjs`
(6/6: model + @@unique + resolver + stamp-on-regenerated-client + inert default).

**Principle:** a case binds to a declared business IDENTITY, not to a captured session
blob. The identity declares HOW QAAI authenticates as it (`strategy`) and what QAAI does
when it can't (`disposition`). This is the WHO axis — complements P2 (WHAT/requirements)
and P3 (HOW/atlas).

**Model — `AuthProfile`** (additive, new):
```
AuthProfile {
  id, projectId, name,                 // unique per project: admin|demo|maker|checker|readonly|region:eu …
  strategy:    form | sso | token | mfa | basic | none,    // the auth MECHANISM
  disposition: bypass_fixture | supported_test_hook | manual_gate | unsupported,
  authFixtureId? → AuthFixture,         // when bypass_fixture (the pre-captured storageState)
  credentialRef?,                       // when supported_test_hook (→ named Project.testCredentials; NEVER an inline secret)
  environment (default 'default'), notes?, createdAt, updatedAt
}
```
`disposition` (frozen): `bypass_fixture` — inject `AuthFixture.storageState` (case starts
authenticated; IdP never navigated). `supported_test_hook` — programmatic/form login via a
named credential profile; the secret binds at run/export by `env:/vault:` ref, never inline.
`manual_gate` — the run PAUSES for a human (the pause/resume human_input mechanism); export
preserves it as a manual gate. `unsupported` — can't be automated → blocked/needs_human,
NEVER silently passed (surfaced in the evidence bundle).

**`TestCase.authProfile String?`** — references an `AuthProfile.name` (additive nullable;
null = legacy default-fixture behavior, unchanged).

**Resolver** `server/services/authProfileResolver.js` — `resolveAuthProfile(projectId,
name) → { strategy, disposition, storageStateRef?, credentialRef? }`. Pure mapping; the
conductor (E2 storageState injection) / export (valueRef binding) act on it.

**The pickSlice tie-in (the key link to P3b):** a case's `authProfile` selects which atlas
SLICE it grounds against — `pickSlice` already enforces the wrong-role firewall
(admin≠demo evidence). P4b connects the case's declared identity to the slice key
`(module, authProfileId)`, so a case authored "as admin" is generated + grounded against
the admin slice, never silently on demo evidence. This ACTIVATES the P3b firewall that has
been waiting for an authProfile on the case.

**Contract gate (inert until P9):** `assertContractComplete` gains `requireAuthProfile`
(default false) → `no_auth_profile` when an automatable case has none. Mirrors
`requireRequirementRefs` / `requireApprovedMapping`.

**Friend's eventual slice (NOT now):** an AuthProfile management UI (declare profiles, pick
strategy/disposition, attach a fixture or credential ref).

**To confirm at the checkpoint (may shift with P4a-UI/export learnings):** exact
`credentialRef` → `env:/vault:` shape; whether identities need a per-environment matrix vs
the single `environment` field; how `manual_gate` threads into the existing pause/resume
registry. **Build order (when unheld):** schema + resolver + pickSlice wiring + inert gate
+ `verify_authprofile.cjs` + a live smoke (a case bound to "admin" grounds against the
admin slice). Additive · inert-until-P9 · guarded.

## P5 — Dependency topo + failed-prerequisite gating (SHIPPED 2026-06-04)

**Status:** SHIPPED on the AI engine (conductor). Closes the inconsistency where
`runs.js` already topo-expanded `dependsOnIds` but the conductor used it ONLY for journey
codegen partitioning — it never GATED execution on a failed prerequisite.

**Principle — EXPLICIT EDGES ONLY:** a dependent is gated iff a case it names in
`TestCase.dependsOnIds` did not pass. Never inferred from shared scenario / module / name
similarity. A case with no edges is never gated no matter what else failed — so the gate
never hides a real, independent bug.

**Pure core — `server/services/dependencyGraph.js`** (Node disposes; the Architect only
PROPOSES the edges): `buildGraph(cases)` (edges restricted to in-set ids; an out-of-scope
prereq → `externalDeps`, never a fabricated edge); `topoSort(graph, priority)` (Kahn,
stable by authoring order; a cycle returns its members — never throws, never an LLM
repair); `orderCases(subset)` (dependency order within a scenario; cycle → original order);
`evaluateGate(tc, outcomes, graph)`; `unsatisfiedChain`. A prerequisite is UNSATISFIED iff
its outcome ∈ {fail, blocked, needs_human}. `skipped` (engineer-excluded), not-yet-run, and
out-of-scope → advisory finding, NEVER a block.

**Verdict vocabulary (frozen):** a gated dependent is `RunResult.status='blocked'` +
`blockedReason='failed_prereq'` — its OWN reason, visibly distinct from app-fail
(`status='fail'`), the environmental blocked reasons (`selector_*`, `auth_*`, …), and
needs_human. The gate never fabricates an app failure.

**Evidence inheritance (frozen — the audit answer to "blocked by what?"):** the dependent's
RunResult carries `blockedByTestCaseId`, `blockedByRunResultId` (the EXACT upstream result),
`blockedByReason` (root cause, e.g. `fail` / `blocked:selector_not_found`), and
`dependencyPath` (JSON root-cause-first chain — A fail → B → C stores `[A,B]` on C). All
four additive + nullable (migration `20260614000000`); null for every normally executed
case. `getRun` decodes `dependencyPath` and passes the rest through; Reports labels
`failed_prereq` = "Blocked by prerequisite".

**Soft-first / P9-hard (one flag `requireDependencyOrder`, default false → inert):**
- ALWAYS (both modes): order a scenario's cases in dependency order (`orderCases` — safe:
  same MCP session/conversation, only the sequence changes); build the run graph + emit a
  `dependency_cycle` finding on a cycle (authoring-order fallback); evaluate the gate per
  case and SURFACE advisory findings.
- SOFT (default): a would-block is logged only — execution unchanged → current runs are
  byte-identical.
- HARD (P9 flips the flag; `QAAI_ENFORCE_DEPENDENCY=on` for testing): the dependent is NOT
  executed — `recordFailedPrereqBlock` writes its blocked/`failed_prereq` RunResult with the
  evidence inheritance, the agent never sees it (no random retry), and `caseOutcomes`
  cascades the block to its own dependents.

**Per-case outcome capture:** `recordCaseOutcome` reads each case's authoritative
(post-verdict) RunResult back from the DB (worst-wins across data-driven rows) into the
run's `caseOutcomes` map — so a later dependent's gate sees the real result without touching
`runOneCase` / `persistResultAndCodegen` signatures.

**Conductor injection points** (`conductor.js#run`): graph + `caseOutcomes` before the wave
loop; `orderCases` per scenario; `evaluateGate` before each case (hard →
`recordFailedPrereqBlock` + `continue`); `recordCaseOutcome` after each case;
`dependencyFindings` returned in the run summary.

**Guard** `scripts/verify_dependency.cjs` (pure truth table + wiring greps) + live smoke
`scripts/_smoke_p5_dependency.cjs` (REAL conductor record path + getRun: explicit-edges-only,
evidence inheritance, soft inertness, A→B→D chain path, independent-case untouched, cycle).
Additive · inert-until-P9 · guarded.

## P6 — Mechanical ReplayIR emission (SHIPPED + live-activated 2026-06-04)

**Status:** SHIPPED + live-activated. The conductor emits the frozen ReplayIR from what
MCP ACTUALLY DID and persists it pinned to each RunResult. Closes Stage 6 (codegen source)
— the bridge from "we executed + verified" to "we can regenerate a faithful, framework-
agnostic spec." NOT script-recording, NOT an LLM narrative.

**Emitter — `server/services/codegen/replayEmitter.js#buildReplayIR`** (pure: no LLM, no
prisma, no fs; the conductor/smoke pass recorded facts in). It maps:
- recorded tool trail (what MCP did) → `resolve` + `act` steps;
- declared assertions + recorded `assertion_check` outcomes → `assert` steps (`contractRef`
  = assertion.id, `channel` ∈ ASSERT_CHANNELS) + `verdict.perAssertionOutcomes`;
- the recorded verdict → `verdict.status` (PRESERVED — a fail/blocked run can never compile
  green); the resolved first-class AuthProfile → `ir.authProfile`; role-keyed `dataRows`
  (the P4↔P6 bridge — masked/restricted values → refs).
The FROZEN contract is the friend's (`adapters/frameworkAdapter.js`): the emitter SATISFIES
it; the caller runs `validateReplayIR`→`compileReplayIR` and STOPS export on any error.

**No fabrication (the honesty rule — user, 2026-06-04):** when recorded evidence is missing
the emitter NEVER guesses — it records a GAP + sets `complete:false`: `missing_locator_evidence`
(a locator-needing action with no recorded label + no KB row — the action is NOT emitted with a
guessed target), `missing_assertion_outcome` (declared assertion with no recorded outcome →
perAssertion `needs_human`, never a fabricated pass), `no_replayable_steps`. A non-empty `gaps`
⇒ `complete:false` ⇒ the export lane marks the IR unsupported and surfaces exactly which
evidence is missing — never a silent fallback to AI-written code.

**No secret leak (enforced + verified):** act values are NEVER inline literals — every
fill/type/press/selectOption carries a `valueRef` (`env:`/`vault:`/`fixture:`/`masked:`);
credentials → conventional env names; masked/restricted dataRow values → refs. `validateReplayIR`
rejects any inline value (`replayir_inline_value_forbidden`) → compile throws → export stops.

**`browser_fill_form` fidelity (the live-activation fix, 2026-06-04):** the conductor enters
form data (incl. login) via the MCP `browser_fill_form` tool, whose args carry a MULTI-FIELD
`fields[]` array (`{name,type,target,value}`) — NO single `element`. The FIRST live run
surfaced that the emitter dropped the whole fill (→ `complete:false`, the login credentials
absent from the replay). Fix: expand `fields[]` to per-field `resolve`+`fill` — `field.name`
→ locator label, `field.type` → role candidate (e.g. `role=textbox name=Username`),
`field.value` → `valueRef` (the recorded password literal NEVER reaches the IR). All facts
are recorded ⇒ no fabrication. This is exactly why the live activation matters: a deterministic
guard on a hand-written trail wouldn't have hit the real `fill_form` shape. ([[structural-fixes-over-tactical]])

**Persistence (pinned, additive, never breaks the run — the user's column route):**
`RunResult.replayIrJson` (`String?`, migration `20260615000000`) stores the envelope
`{ ir, complete, gaps, emittedAt, emitterVersion:'p6-emitter-1' }`, pinned to the EXACT result
(verdict/data-row/auth attached). P7 consumes the IR pinned to that RunResult — NEVER a "latest
generated IR." Emission is best-effort: on any failure `replayIrJson` stays null + the reason
logs; the run is unaffected. Existing rows are null → current generation byte-identical.

**Guards + proof:**
- `scripts/verify_replayir.cjs` (10 sections, pure): emit→validate→compile through the REAL
  reference adapter; no-inline-value; verdict-stop; gap-honesty/no-fabrication; conductor wiring
  greps; `fill_form` expansion + no-leak.
- `scripts/_smoke_p6_replay.cjs` (10/10): emits from 199 REAL captured traces — pass + fail/blocked
  verdict parity, leak-free, surfaces incomplete traces honestly. READ-ONLY.
- **LIVE ACTIVATION** (run `2de0cb23`, OrangeHRM, 2026-06-04): a fresh 2-case slice through the
  real `/agents/execute` → conductor → both RunResults persist `complete:true, gaps:0`, valid,
  compile, verdict-parity (pass), no secret literal in the IR OR the compiled spec. Reusable
  harness: `scripts/_p6_live_trigger.cjs` + `_p6_live_inspect.cjs` (acceptance steps 3-8) +
  `_p6_wait_run.cjs`.

Additive · pinned-to-RunResult · never-breaks-run · guarded · live-activated.

## P7 — Export via ReplayIR adapters (P7a/P7b/P7c SHIPPED 2026-06-04)

**The hard rule (frozen):** an export adapter compiles ONLY from `RunResult.replayIrJson`.
No legacy-codegen fallback, no "best-effort" script, no regen from case text, no adapter
improvisation. Flow: live MCP → pinned `replayIrJson` → `compileReplayIR(adapter, ir)` →
assembled package → package validation (in a temp dir) → ZIP + manifest.

**Scope line (do NOT overclaim):** P7 proves IR-only export + compile/list/package
validation + no secret leakage + **manifest verdict PRESERVATION**. It does NOT claim
EXECUTION parity — that is **P8** (clean-env run). Keep the boundary clean.

**Sequence:** P7a Playwright → **P7b BDD (Route B)** → P7c Selenium (BDD second = the
stakeholders' primary concern).

**Cross-cutting invariants (every adapter):**
- **Block gate, no green for bad IR:** missing `replayIrJson` / invalid IR
  (`compileReplayIR` throws) / `complete:false` → that case is BLOCKED with a finding
  (`replayir_missing|replayir_invalid|replayir_incomplete` + gaps). **All selected blocked →
  no normal ZIP** (evidence-only 422). No fallback, ever.
- **Verdict preservation (NOT execution parity):** `pass`→faithful; `fail`→the SAME hard
  assertion (never `test.fail()`/expected-fail — it must hard-fail on replay if the bug
  persists); `blocked`/`needs_human`→`test.describe.skip`/`@Ignore` (cannot report green) +
  manifest `expectedVerdict`. A verdict mismatch (envelope vs RunResult) is a hard finding.
- **Secrets:** masked/restricted never inline (contract + a defense-in-depth assembled-file
  scan); synthetic literals allowed only when `sensitivity==='synthetic'`; a secret leak →
  hard-refuse the export (422). Known credential literals (e.g. `admin123`) banned.
- **Temp-package validation:** assemble into `os.tmpdir()`, run
  `_packageValidate.validatePackage` THERE — never against repo files.
- **Data-row identity:** never collapse fan-out; one result-specific spec per RunResult
  unless siblings share the step skeleton + compatible IR. Manifest carries
  `dataRowIndex`/`dataRowLabel`.
- **Stable `EXPORT_MANIFEST.json`** per entry: `runId, runResultId, testCaseId,
  dataRowIndex, dataRowLabel, adapterId, adapterVersion, emitterVersion, expectedVerdict,
  complete, gaps, files[], validationFindings[], fileHashes{}` (sha256/file).

**P7a SHIPPED (Playwright).** NEW `server/services/codegen/replayExport.js` (pure core:
`compileResults`/`assemblePackage`/`scanSecrets`/`buildManifest`/`wrapForVerdict` +
`buildReplayExport` service). Route `GET /output-files/download.zip?source=replayir&framework=
<id>[&runId=|&runResultIds=]` (ADDITIVE — no `source` ⇒ legacy disk-file ZIP, byte-identical,
inert until P9). Compiles through the friend's frozen `playwright-reference` adapter; validates
via `_packageValidate` (`playwright test --list`). Guard `scripts/verify_replayexport.cjs`
(12 sections, pure) + live `scripts/_smoke_p7_export.cjs` (run `2de0cb23`: both cases compile,
real `--list` exit 0, verdict preserved, zero `admin123`, incomplete→blocked, all-blocked→no
ZIP) + `scripts/_smoke_p7_route.cjs` (HTTP: 200 zip / 400 unknown-fw / 422 all-blocked / legacy
inert). npm 66/66.

**P7b — BDD Route B (SHIPPED).** `replayIrJson → canonical IR-step registry → .feature +
deterministic glue` (NOT authored `operations[]`, NOT prose). NEW
`server/services/codegen/adapters/replayIrBdd.js`: a FROZEN `STEP_LIBRARY` (one entry per IR
step kind, UNIQUE patterns → bddgen rejects ambiguity), `renderIr` (correlates each
`act.target` back to its `resolve` candidates for the human label; `valueRef` env-NAME becomes
the Gherkin param so the VALUE never enters the `.feature`; un-renderable-but-recorded asserts
→ a doc comment, never a fake step), `compileResults` (per-result `.feature` + block/verdict
gates), and the glue/helpers/locators emitters. The glue delegates to shared
`resolveByLabel`/`readEnv`/`dismissKnownPopups` (no LLM-written steps); locator candidates live
in `support/locators.ts` (a getBy-expression stored as a `css` selector is re-encoded to its
proper `role`/`text` strategy — lossless). Verdict: `fail` keeps its hard `Then` (tag
`@verdict-fail`, NOT `@skip`); `blocked`/`needs_human` → `@skip` + verdict comment; traceability
tags `@rr-/@tc-/@row-/@verdict-`. Unsupported assert channels (API/DB_READ/…) → BLOCK with
`bdd_channel_unsupported` (no vague BDD). `replayExport` dispatches `framework='replayir-bdd'`
to this module; validates via `_packageValidate` (`playwright-bdd`) = real `bddgen` +
`playwright test --list`. Requires `playwright-bdd` (added as a devDep in `server/` — it's the
validator for generated BDD packages). Guard `verify_replayexport.cjs` [13]-[18] + live
`_smoke_p7_export.cjs` [G] (run `2de0cb23`: bddgen exit 0, `--list` exit 0, no undefined/
ambiguous steps, no secret, verdict preserved) + `_smoke_p7_route.cjs` [4] (BDD over HTTP).
(Capability `operations[]` may enrich WORDING later, only if it still maps back to ReplayIR.)

**P7c — Selenium adapter (SHIPPED + COMPILE-PROVEN).** NEW
`server/services/codegen/adapters/seleniumReference.js` — a FIRST-CLASS ReplayIR adapter (not a
"translate the PW spec to Java" attempt) implementing all 15 `REQUIRED_METHODS` + `regressionCorpus`,
emitting **Selenium 4 + TestNG** from the IR. Registered in `adapters/index.js`; `replayExport`
maps `selenium-reference → selenium-java`. The 15 emit* assemble ONE TestNG class per RunResult
(`compileReplayIR`); the IR-agnostic Maven shell (`pom.xml`, `testng.xml`, `BaseTest`,
`LocatorResolver`, `LocatorCandidate`, `EnvReader` under `src/test/java/com/qaai/replayir/`) is
the adapter's own `assemblePackage`. **Anti-hallucination floor (the hard part):** locator
candidates map deterministically — `css`/`testId`/`text`/`placeholder`/`label` direct; **`getByRole`
→ a bounded ARIA heuristic** (role attribute / accessible name over visible text / aria-label /
placeholder / associated `<label>`), NEVER an invented CSS selector. If NO candidate of a resolve
step maps → `compileReplayIR` throws → the result is BLOCKED `selenium_locator_unmappable` (refuses
to fabricate a `By`). Assert channels Selenium can't faithfully replay (API/DB_READ/EMAIL_SMS/
DOWNLOAD/PDF/AUDIT_LOG/ASYNC_JOB/EVALUATE) → a throwing stub + an exact `selenium_channel_unsupported:
<channel>` finding (the package still compiles; the test can never report green). Values resolve via
`EnvReader.read(System.getenv)` — never inline; `masked:`→`QAAI_MASKED_*`. Verdict: `pass` faithful;
`fail` keeps the SAME hard `Assert` (NOT disabled); `blocked`/`needs_human`/`skipped` →
`@Test(enabled = false)` + verdict note (cannot report green). Data-row identity = a UNIQUE Java
class name per RunResult (filename == public class — Java invariant). `compileResults` was
generalised (adapter-driven file path + `opts.className` + an `adapterFindings` side-channel; the PW
path stays byte-identical). **Validation is a REAL compile**, not just discovery: `_packageValidate`
runs offline `mvn test-compile` (a Windows `.cmd`-spawn EINVAL there was misread as a compile failure
— **fixed** with the single-string shell form, improving Selenium validation everywhere). Guard
`verify_replayexport.cjs` [20]-[29] (contract + corpus fragments, block gates, fail-keeps-assertion,
blocked-disabled, unsupported-channel stub+finding, unmappable→block, Maven shape, no-leak, data-row
identity, manifest). Live `_smoke_p7_export.cjs` [H] proved it on run `2de0cb23`: **real
`mvn -q -DskipTests test-compile` → BUILD SUCCESS (6 sources, javac release 11)**, verdict preserved,
zero `admin123`. `_smoke_p7_route.cjs` [5] (Selenium over HTTP → 200 zip + `X-QAAI-Export-Valid:true`).
Shared `normalizeCandidate`/`labelForCandidates` extracted to `adapters/_candidateNormalize.js` (BDD +
Selenium project from one normalizer — the [[buildrefrolemap-parser-drift]] consolidation lesson).
npm 66/66. **NOT execution parity** (no browser run) — that is P8.

## P8 — Clean-env execution parity (SHIPPED + live-proven 2026-06-04)

**Status:** SHIPPED for `playwright-reference`, `replayir-bdd`, and `selenium-reference`.
P8 runs the generated package in a clean temp workspace and compares the framework runner's
verdict to the MCP verdict that produced the ReplayIR. This is the first gate that proves
"MCP passed" can become "exported script passes" instead of only "package compiles."

**Core:** `server/services/codegen/executionParity.js` owns the verdict vocabulary:
`pass -> pass`, `fail -> fail`, `blocked|needs_human|skipped -> skipped|disabled|not_run|error`
(never green), and unsupported faithful-oracle channels -> `eligible:false` (not a product fail).
Execution values resolve only from approved refs (`env:` / `vault:` / `fixture:` / `masked:`)
via operator env or the approved local secrets file; Excel literals and generated files never
feed runtime credentials.

**Harness:** `scripts/_smoke_p8_parity.cjs <playwright|bdd|selenium>` builds throwaway
packages, injects approved env only, runs the real framework command, parses runner output
(`playwright test` / `bddgen && playwright test` / Maven Surefire reports), and writes
`playwright/p8-parity/{playwright,bdd,selenium}.json` with `{runResultId, framework,
mcpVerdict, runnerVerdict, matched, eligible, reason, failingAssertion, provenance, logs,
artifacts}`. The real pass slice is re-emitted in memory from `richTraceFile` using the current
P6 emitter so the proof never overwrites trial `RunResult.replayIrJson`.

**Live proof accepted:** real captured RunResult traces, re-emitted in memory to ReplayIR:
- Playwright: `de44bf98 pass -> pass`, `4eeaa846 fail -> fail`, `e391c19c blocked -> skipped`.
- BDD Route B: `de44bf98 pass -> pass`, `4eeaa846 fail -> fail`, `e391c19c blocked -> not_run`.
- Selenium/TestNG: `de44bf98 pass -> pass`, `4eeaa846 fail -> fail`, `e391c19c blocked -> not_run`,
  unsupported API-channel assert -> `eligible:false`.

**P8 findings that became fixes:** P8 exposed two P6 fidelity gaps and one adapter timing gap.
The P6 emitter now emits replayable locator ladders (KB evidence plus placeholder/label/role/text
fallbacks), preserves the initial page URL when MCP began from existing page state, and never
persists session-local MCP refs as replay locators. Playwright/BDD helpers now wait briefly for
candidate visibility before counting, matching MCP's live actionability patience. Selenium parity
parses Surefire report XML/TXT because `mvn -q test` may pass while stdout contains only browser
warnings.

**Guards:** `verify_replayir.cjs` pins locator-faithful ReplayIR + initial-page replay;
`verify_replayexport.cjs` keeps the P7 adapter/export gates green; `verify_executionparity.cjs`
pins the P8 verdict classifier and parser behavior. `npm test` remains 66/66.

## BDD as a first-class pipeline (P7-BDD / P8-BDD - friend-owned codegen lane)

Company's primary deliverable is BDD, so it is a PIPELINE, not "another export
format." The failure modes that make enterprise BDD break are all
determinism/mismatch problems (feature↔glue step-text mismatch, duplicate/undefined/
ambiguous steps, wrong Java class/package/imports, data-table not wired to code,
Scenario-Outline examples not matching placeholders, glue re-imagining the MCP
action, a FAILED MCP case becoming a happy BDD assertion). The cure is the same
contract-first principle: **BDD is GENERATED from capability operations over verified
atlas evidence — never free LLM step prose.**

2026-06-04 hardening: ReplayIR Route B features now carry `@qaai-replayir`
plus source RunResult/testCase comments, expected-verdict comments, row-label
tags when data exists, and blocked-reason tags for blocked/needs-human cases.
The manifest mirrors the same BDD metadata (`featurePath`, `scenarioName`, tags,
step count, step keys, notes, and exact block reason). Repeated same-phase steps
render as `And` for readability, but every line still maps to the same canonical
glue registry entry and P8 BDD execution parity remains green.

Lane (lives in `server/services/codegen/adapters/` — **friend-owned**; the
Capability Operation Vocabulary above is the frozen seam I own and hand over):
- **P7-BDD.1** BDD Contract (Gherkin step ↔ operation mapping; verdict fidelity)
- **P7-BDD.2** Deterministic Gherkin emitter (no free step text)
- **P7-BDD.3** Step Registry / step vocabulary (one sentence per operation)
- **P7-BDD.4** Framework glue adapters (Java/Cucumber, PW-BDD, Selenium-BDD)
- **P7-BDD.5** data-table + Scenario-Outline handling (rows → operation params)
- **P8-BDD.1** Cucumber compile + undefined/ambiguous/DUPLICATE step gate
- **P8-BDD.2** per-row MCP-vs-BDD verdict parity (a failed MCP case must NOT render
  as a passing BDD assertion)
Seam ownership: I define + freeze the operation vocabulary (it derives from atlas
capabilities + compiles to ReplayIR); friend builds the emitter/glue/gates against it.
