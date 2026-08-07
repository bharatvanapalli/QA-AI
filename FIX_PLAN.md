# QAAI Scenario-Generation Fix Plan (RBAC validation)

Goal: when the user uploads BRD + user stories + test-data Excel, the platform must
**deliver complete, correctly-bound scenarios/cases/steps** — never a "Data incomplete"
badge, a credential-gap excuse, or a corrupted `{{token}}`. Every fix is GENERIC (keyed off
binding status / sheet structure / brace-adjacency / manual category) — never a site string.

Live baseline (OrangeHRM project 465f2d08, gen v12 "Smoke", 18 cases):
- `hasErrorFinding = 18/18` while `status:incomplete = 0` → badge red on every case.
- Dominant finding `data_literal_from_uploaded_sheet | error ×112` (false-fires on placeholders).
- `columnToField.password` corrupted to literal `"{{password}}"` in per-case binding.
- `RoleAccessControl` mis-classified `purpose=download_expectations`; all 7 sheets forced `module=Authentication`.

---

## Cluster 1 — Status semantics: `incomplete` ONLY for genuinely missing sheet/column
Files: `server/services/testDataAuthoring.js`, `server/services/storyDataAlignment.js`

- `buildBinding` (testDataAuthoring.js:310): status is `incomplete` if ANY `severity:'error'`
  finding exists. The error-severity findings it keys off are authoring/alignment quality, not
  missing data: `data_literal_from_uploaded_sheet`, `data_input_placeholders_missing`,
  `data_expected_placeholder_missing`, `data_placeholder_not_in_mapping`.
  → Downgrade all four to `severity:'warning'` (advisory). The ONLY structural errors that may
  force `incomplete` are `data_binding_sheet_not_found` / `data_binding_column_not_found`.
  → Change the status formula to key off a `STRUCTURAL_DATA_ERROR` set, not raw `error` severity.
- `literalLeaksInCase` (168): skip-guard compares header-name vs placeholder role-name (never
  matches). Make leak findings advisory regardless (covered by the severity downgrade above).
- `storyDataAlignment.appendBindingFinding` (189): flips status→`incomplete` on any `error`
  alignment finding (`story_data_alignment_missing`, `story_data_requirement_mismatch`).
  → Downgrade alignment findings to `warning`; never flip binding status from an alignment heuristic.

Effect: a case whose sheet+columns exist is `complete` with `errorCount===0` → badge green.

## Cluster 2 — Completeness resolution + clear resolved findings (canonical writer)
Files: `server/services/coveragePlanner.js`, `server/services/testCaseContract.js`

- coveragePlanner complete-stamp branches (668/699/724) flip `status:'complete'` but keep the old
  `findings[]` (with `error` entries) → UI stays red. → When stamping complete because the sheet
  resolves, drop resolved `error`/`warning` findings (keep `info`).
- persistCases (testCaseContract.js): add a deterministic reconcile before write — if
  `dataBinding.sheet` exists in supplied/approved testData, ensure `status:'complete'` and strip
  non-structural findings. Universal (both routes funnel through persistCases).

## Cluster 3 — One boundary-aware token engine; stop corrupting binding metadata
Files: `server/services/testDataAuthoring.js`, `server/services/coveragePlanner.js`

- `replaceAllLiteral` (testDataAuthoring.js:245) uses raw `split().join()` → mid-word corruption
  (`s{{role}}ion`). → Replace with a boundary-aware replacer (min length, word boundaries, never
  inside `{{...}}`).
- `replaceStringsDeep` (coveragePlanner.js:585) boundary lookarounds exclude only `[a-zA-Z0-9]`,
  not braces → double-wrap `{{{{password}}}}`; and it recurses over the WHOLE case object,
  corrupting `dataBinding.columnToField` (password→`{{password}}`). → (a) widen lookarounds to also
  reject `{`/`}`; (b) never run literal→token replacement over binding-metadata keys
  (`dataBinding`, `columnToField`, `expectedColumn`, `rowSelector`) — scope to narrative/data fields.
- `sanitizeTokenCorruptions` (coveragePlanner.js:62) is lossy (drops token, rejoins letters →
  garbage). → Make it collapse `{{{{x}}}}`→`{{x}}` and de-fuse mid-word tokens without destroying
  the surrounding word where recoverable; never produce a half-word.

## Cluster 4 — Manual classification: remove credential-absence as a trigger
File: `server/services/agents/architect.js`

- CREDENTIAL SAFETY RULE (≈59-65) pushes `automatability:manual` when a role credential is absent.
  → Remove credential absence as an automatability decision. Manual = ONLY the four enumerated
  categories (physical channel / subjective judgement / org-gate approval / hardware I/O) plus an
  explicit source `[MANUAL]` marker. A missing credential is an execution prerequisite, surfaced as
  a binding/credential note — never a Manual classification.

## Cluster 5 — Structural sheet classification
File: `server/services/testDataUnderstanding.js`

- `classifyPurpose` (≈123): tests AUTH before ACCESS_CONTROL and treats any username+password sheet
  as `auth_profiles`. → Test the most specific structural signal first: a sheet with an
  access-target column (menu/page/url/permission/expected-access/visible/hidden) is `access_control`
  even if it also has credentials. `auth_profiles` only when columns are exhausted by credential roles.
- `bestModule` (≈132): force-returns `module=Authentication` for `auth_profiles`. → Run the
  document-evidence scoring for ALL sheets; represent "shared credential sheet" and "owned module"
  as orthogonal flags; only fall back to a synthetic auth module when no document module scores.
- `analyzeColumns` (≈209): drops non-credential headers to `unmapped`. → For access_control sheets
  (and generally), retain every non-meta column under a role (canonical if known, else camelCased
  header). No data column silently dropped.

## Cluster 6 — Atlas / auth-profile threading + strict-prompt grounding
Files: `server/routes/scenarios.js`, `server/services/agents/calibrator.js`, `server/services/agents/architect.js`

- scenarios.js auto-crawl (≈679-704): pass `authProfileId` into `prisma.calibration.create` AND
  `runCalibrator` so the role-scoped slice is actually built.
- calibrator.js login (≈549-559): when `authProfileId` is supplied, resolve that profile's credential
  (by key/strategy) instead of always `testCredentials[0]`.
- architect.js strict test-data block (≈1483-1490): show the model the REAL clipped cell value
  alongside the `{{token}}` (`role={{role}} (header "X", e.g. <value>)`) so it can confirm data exists
  while still authoring with tokens. (Validated last, after a fresh crawl.)

---

## Verification loop
1. Restart backend; confirm clean boot.
2. Trigger MINIMAL RBAC focus generation (reuse atlas first); watch WS/log events live.
3. Read real DB output: every RBAC case must be story-grounded, bound to RoleAccessControl/AuthProfiles
   rows, `status:complete` + `errorCount:0`, automatable (not manual), clean tokens, runnable steps.
4. Fix → regenerate → re-judge until clean. Then validate cluster 6 with a fresh crawl. Then FULL run.
