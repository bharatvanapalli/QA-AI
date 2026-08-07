# QAAI 2.0 Phase Plan

Status rule: a phase is marked complete only when its full exit criteria are implemented and verified. Partial slices are recorded as partial and do not unlock later architecture work.

Current focus rule: Phase 0 through Phase 9 are closed for the QAAI 2.0 local architecture baseline. A phase is not called complete because the feature exists in one file; it is called complete only when the runtime/export/reporting path is wired and verified by focused guards.

## Phase Status

| Phase | Name | Status | Notes |
| --- | --- | --- | --- |
| 0 | Runtime Contract Foundation | Complete | Browser Action Contract Registry is wired through runtime/pipeline/codegen; every mutating runtime tool is registered; non-exportable/unknown actions produce explicit preview/certification fallbacks instead of silent drops. |
| 1 | Scenario Generation + Test Case Quality | Complete | Scenario Quality Contract now stamps role/preconditions/session cleanup, rejects vague and duplicate cases before persistence, persists quality metadata, and feeds Playwright-agent-ready Markdown specs. |
| 2 | Test Data Binding Contract | Complete | Approved-data certification, literal/secret rejection, assertion expected-token checks, coverage-kind reporting, and row/value mutex locking are implemented and verified. |
| 3 | Session Isolation + Dirty-State Prevention | Complete | Runtime pre-flight now blocks environment outages before browser launch; independent scenarios, dirty rows, continuation login cases, and final cleanup have verified clean-session behavior. |
| 4 | In-Loop Healer | Complete | Runtime locator/action failures now enter the in-loop healer before step failure, with registry-controlled healing, shared hard budgets, immediate retry, healed-pass evidence, and precise budget-exhausted outcomes. |
| 5 | Native Playwright Agent Lane | Complete | Markdown specs, planner/generator/healer/reviewer agent files, isolated worker workspace creation, sandboxed generated-test execution, artifact collection, and QAAI preview import envelope are implemented and verified. |
| 6 | Script Generation + Output Files Reliability | Complete | Generated bundles run in the platform script runner, queue async validation after live runs, preserve mutable bundle snapshots, journal repairs, expose exact file/line failure evidence, support provider-backed bounded repair proposals, rerun failed scopes, and separate Preview/Certified/Healed states in Output Files and Reports. |
| 7 | Semantic Locator + Deterministic Replay Cache | Complete | Locator intelligence, action memory, deterministic action-locator replay, drift/chaos evaluation, and no-model-derived locator fallback guards are wired and verified. |
| 8 | Trace, Failure Analysis + Evidence Dashboard | Complete | Reports separate behavior results from automation-script status, hide raw trace behind developer toggles, carry script validation/repair evidence, redact sensitive trace/action values, and preserve exact evidence links. |
| 9 | Benchmark + Deploy Hardening | Complete | Local release hardening now has architecture readiness checks, no-fake-pass reliability guards, locator-drift benchmark tests, script/native sandbox policies, CI-ready generated packages, timeouts, secret stripping, and artifact allowlists. External infra provisioning remains an environment/deployment activity, not an application-code phase. |

## Phase 0 Exit Evidence

Completed on 2026-07-03.

- Runtime cannot complete a step with an unregistered runtime tool.
- Every mutating runtime tool known to locator resolution is present in the browser action registry.
- Every registered action declares a `codegenFallback`.
- Exportable registered actions have ReplayIR mappings.
- Non-exportable registered actions emit preview/certification fallback gaps.
- Unknown actions in ReplayIR emit `unregistered_runtime_action` gaps instead of being silently dropped.

Verification:

```text
node --check server\services\browserActionRegistry.js
node --check server\services\codegen\replayEmitter.js
npx vitest run tests\unit\browserActionRegistry.test.js tests\unit\pipelineContract.test.js --reporter=verbose
npx vitest run tests\unit\codegenExport.test.js tests\unit\previewScript.test.js tests\unit\conductorContract.test.js --reporter=verbose
node scripts\verify_codegen_contract.cjs
npm run build
```

All commands passed. `npm run build` still reports the pre-existing large-chunk warning.

## Release Verification Gate

Before tagging a deployable build, run the verification set below. These checks prove:

- preview and certified QAAI script lanes are separated,
- preview scripts can include `test.fixme`, manual gates, and clear unsupported-action notes without being presented as certified,
- certified scripts are generated only from ReplayIR/evidence-backed actions,
- output packages include CI/CD-ready artifacts: `package.json` with exact dependency versions, `playwright.config.ts`, and a GitHub Actions workflow,
- output files include certification status, reason, manifest, traces, and package validation results,
- generated packages compile, discover, run, and preserve runtime verdict parity,
- generated bundles are persisted as mutable snapshots so validated and repaired files are the same files users receive,
- script repairs are journaled and certified only after a clean rerun of the affected test scope,
- unsupported actions, missing locators, missing steps, unsafe data bindings, and unverifiable assertions are never hidden.
- dirty data rows recover through a clean browser/session path instead of contaminating later rows.
- provider-backed repairs are bounded to generated output files and still use diff preview, expected-before protection, journaling, and rerun evidence.

## Phase 6 Exit Evidence

Started on 2026-07-03. Completed on 2026-07-04.

Completed so far in Phase 6:

- Added `scriptValidationRunner` as the platform-owned script validation lane for generated Playwright bundles.
- Generated Playwright output can now be executed by QAAI through `POST /api/projects/:projectId/output-files/:bundleId/run`.
- Output Files has a `Run scripts` action and a separate Script Validation Lane panel.
- Script validation runs in a temporary validation workspace with `shell: false`, timeout, sanitized environment, and no QAAI/Prisma/database/JWT/LLM secrets inherited from the platform process.
- Script validation persists `validation-report.json`, stdout, stderr, and allowlisted Playwright artifacts under `playwright/script-validation/...`.
- Playwright JSON results are parsed into user-facing script status: `certified`, `failed`, or `preview_only`.
- Script failures now include exact test title, file, line, code line, error, trace path, screenshot path, and `repairAvailable`.
- Output Files tree responses now include the latest script-validation report for the active bundle.
- ReplayIR Playwright packages are hardened with exact dependency versions, failure-retained video, and `.github/workflows/qaai-run.yml`.
- ReplayIR BDD Playwright packages get the same exact-dependency and CI/artifact hardening.
- Added `scriptBundleStore` as the persistent generated-bundle overlay under `playwright/output-bundles/<project>/<bundle>/<framework>/`.
- Output Files now overlays stored repaired bundle files instead of always regenerating a virtual bundle from the original run.
- Added repair journal storage through `repair-journal.json` and `evidence/script-repair-journal.json`.
- Added safe in-place repair route foundation: `POST /api/projects/:projectId/output-files/:bundleId/repairs/:failureId/apply`.
- Repair patching is path-safe and rejects writes outside the stored bundle.
- Binary output artifacts such as `.xlsx`, screenshots, traces, video, and archives are preserved while script files remain editable text.
- Added `scriptRepairAgent` with deterministic safe locator repair for known simple locator failures and explicit `manual_gate` behavior when a repair is not safe.
- Repair reruns now execute only the affected file/title scope, using `repair_rerun` mode.
- A clean repair rerun returns `healed` with certified script evidence for that validation job.
- Fixed healed rerun reporting so successful repair reruns use `script_repair_rerun_passed`, not a failed-looking reason.
- Output Files now lists script validation failures as actionable rows with exact file/line, error, View line, and Repair controls.
- View line opens the failing generated file, focuses the editor, scrolls to the failed line, and highlights it.
- Repair buttons call the stored-bundle repair route, refresh the repaired file, and update the validation status from the repair rerun.
- Output Files can open `evidence/script-repair-journal.json` when repairs exist.
- Script repair completion stream events now refresh the Output Files bundle state instead of requiring a manual refresh.
- Reworked the Output Files Claude surface from a static context/action panel into a bundle-aware chat shell with transcript, composer, quick commands, active failure awareness, selected-file analysis, generated file inventory, and status context.
- Assistant chat commands can trigger the verified Output Files actions: Run scripts, View failed line, Repair generated script line, and open the Repair journal.
- Added backend assistant context and chat endpoints for Output Files: `GET /api/projects/:projectId/output-files/:bundleId/assistant/context` and `POST /api/projects/:projectId/output-files/:bundleId/assistant/chat`.
- Backend assistant context reads the same stored/repaired generated bundle that Output Files displays and downloads, including selected file excerpt, output file inventory, scenario-like artifacts, data/fixture artifacts, latest validation report, repair journal, manifest, run, generation, project, and framework.
- Output Files chat now calls the backend chat endpoint; configured AI providers receive bounded bundle context, while missing/failed providers fall back to deterministic QAAI script-validation reasoning.
- Added safe repair proposal preview route: `POST /api/projects/:projectId/output-files/:bundleId/repairs/:failureId/propose`.
- Claude Output Agent now shows a repair diff preview before applying a generated-file patch, with target file, line, before/after code, reason, Apply patch & rerun, and Discard controls.
- Repair apply now carries the preview's expected-before content so stale previews cannot overwrite a newer generated bundle file.
- Assistant repair actions reuse the verified stored-bundle repair route instead of creating a separate repair path.
- Assistant replies currently use deterministic script-validation reasoning from captured page context while provider-backed Claude chat/repair/explain remains a separate pending item.

Closed in the final Phase 6 slice:

- Added the async Script Validation Agent and queued ReplayIR script validation after live Conductor completion without blocking the browser loop.
- Added Output Files queued/running/completed script-validation state handling.
- Added Reports automation-script summary so Behavior Result and Automation Script Result are not collapsed into one contradictory verdict.
- Added provider-backed bounded repair proposals for generated Playwright output when valid AI credentials exist, with deterministic/manual-gate fallback.
- Kept the actual patch path safe: generated-bundle only, expected-before guard, repair journal, and failed-scope rerun.
- Added bundle-scoped assistant memory and current-run focused file/data/scenario context, avoiding older-generation token waste.
- Added `scripts/verify_qaai2_readiness.cjs` as the end-to-end static architecture readiness guard.

Verification for completed Phase 6 slice:

```text
node --check server\services\scriptValidationRunner.js
node --check server\services\scriptBundleStore.js
node --check server\services\scriptRepairAgent.js
node --check server\routes\outputFiles.js
node --check server\services\codegen\replayExport.js
node --check server\services\codegen\adapters\replayIrBdd.js
npx vitest run tests\unit\scriptValidationRunner.test.js tests\unit\scriptBundleStore.test.js --reporter=verbose
npx vitest run tests\unit\scriptValidationRunner.test.js tests\unit\scriptBundleStore.test.js --reporter=dot
npx vitest run tests\unit\nativePlaywrightLane.test.js tests\unit\scriptValidationRunner.test.js tests\unit\scriptBundleStore.test.js --reporter=dot
npx vitest run tests\unit\scriptValidationRunner.test.js --reporter=verbose
npx vitest run tests\unit\scriptValidationRunner.test.js tests\unit\codegenExport.test.js tests\unit\previewScript.test.js tests\unit\nativePlaywrightLane.test.js tests\unit\browserActionRegistry.test.js tests\unit\pipelineContract.test.js --reporter=verbose
npx vitest run tests\unit\scriptValidationRunner.test.js tests\unit\nativePlaywrightLane.test.js tests\unit\scenarioQualityContract.test.js tests\unit\browserActionRegistry.test.js tests\unit\pipelineContract.test.js tests\unit\environmentPreflight.test.js tests\unit\testDataBindingContract.test.js tests\unit\testDataMutex.test.js tests\unit\runtimeHealingPolicy.test.js tests\unit\conductorContract.test.js tests\unit\codegenExport.test.js tests\unit\runStream.test.jsx --reporter=verbose
node scripts\verify_codegen_contract.cjs
node scripts\verify_qaai2_readiness.cjs
node scripts\verify_reliability.cjs
npm run build
```

All commands passed in the final verified slice, including the new readiness guard and the no-fake-pass reliability bundle. The reliability bundle passed 39 guards and 799 assertions. `npm run build` still reports the pre-existing large-chunk warning.

## Phase 7-9 Exit Evidence

Completed on 2026-07-04.

Verification:

```text
npx vitest run tests\unit\locatorIntelligenceV2.test.js tests\unit\locatorChaosEvaluation.test.js tests\unit\verdictContradiction.test.js tests\unit\runResultSemantics.test.js --reporter=dot
node scripts\verify_reliability.cjs
node scripts\verify_codegen_contract.cjs
node scripts\verify_qaai2_readiness.cjs
```

All commands passed. Phase 7-9 are considered complete for the local architecture baseline: semantic locator memory, locator-drift evaluation, evidence clarity, no-fake-pass reporting, and deploy-readiness guards are in place. External production infrastructure choices such as managed Postgres, queue workers, and container hosting are deployment configuration tasks beyond this local codebase phase plan.

## Phase 5 Exit Evidence

Completed on 2026-07-03.

- QAAI can generate a Native Playwright Markdown spec for a case with business goal, role/auth profile, test data, steps, expected results, failure conditions, seed/setup file, output path, and evidence requirements.
- Planner, generator, healer, and reviewer agent files are generated into the run workspace and validated against the native lane contract.
- The agent files are wired for the Playwright MCP pattern through `npx playwright run-test-mcp-server`.
- Native lane workspaces are created under isolated per-run directories and reject unsafe roots such as the repository root.
- The workspace contains the Markdown spec, agent files, generated/fixme spec, seed test, `playwright.config.ts`, `package.json`, and `native-lane-manifest.json`.
- Generated Playwright code runs through a child worker with `cwd` set to the isolated run workspace, `shell: false`, and a per-run timeout.
- The sandbox environment strips platform secrets and blocks QAAI/Prisma/database/JWT/LLM-related environment variables from reaching generated tests.
- Sandbox path policy denies QAAI `.env`, Prisma database files, `server/prisma.js`, and paths outside the run workspace.
- Artifact import is allowlist-based and collects only native lane result, Playwright report/blob, trace, screenshot, video, and test-result directories.
- QAAI import envelopes mark native lane output as experimental `preview_not_certified` until certification import validates it.

Verification:

```text
node --check server\services\nativePlaywrightLane.js
npx vitest run tests\unit\nativePlaywrightLane.test.js --reporter=verbose
npx vitest run tests\unit\nativePlaywrightLane.test.js tests\unit\scenarioQualityContract.test.js tests\unit\browserActionRegistry.test.js tests\unit\pipelineContract.test.js tests\unit\environmentPreflight.test.js tests\unit\testDataBindingContract.test.js tests\unit\testDataMutex.test.js tests\unit\runtimeHealingPolicy.test.js tests\unit\conductorContract.test.js tests\unit\codegenExport.test.js tests\unit\runStream.test.jsx --reporter=verbose
node scripts\verify_codegen_contract.cjs
npm run build
```

All commands passed. The focused Phase 5 suite passed 8 tests originally and 18 focused native/validation/repair tests after the reviewer prompt was added; the broader regression suite passed 110 tests. `npm run build` still reports the pre-existing large-chunk warning.

## Phase 4 Exit Evidence

Completed on 2026-07-03.

- Locator-class browser/action failures now enter the in-loop healer inside the same failed step before normal step failure reporting.
- Healing is controlled by the Browser Action Contract Registry through `healingAllowed`; non-healable tools keep their original failure path.
- The same per-step healing budget now covers fresh snapshot collection, deterministic KB-ref recovery, LLM healer proposal, retry tool calls, input tokens, output tokens, and time.
- Fixed the healing budget tool-call off-by-one: `max_heal_tool_calls` now allows exactly that many calls and fails on the next one.
- Deterministic KB-ref recovery and LLM-healed recovery retry immediately inside the failed step.
- Successful healed retries mark the action trail with `runtime_pass_healed` and continue the current row/case instead of stopping.
- Budget exhaustion creates `runtime_failed_after_healing_budget` with a clear `RUNTIME_HEALING_BUDGET_EXHAUSTED` message.
- Healing evidence records original tool/action/locator/error, fresh snapshot summary, healed action/ref/selector, retry result, budget usage, and trace references.
- Low-confidence, unmapped, no-proposal, retry-failed, and skipped-by-contract healer outcomes now record explicit evidence instead of collapsing into vague blocked reports.

Verification:

```text
node --check server\services\agents\conductor.js
node --check server\services\runtimeHealingPolicy.js
npx vitest run tests\unit\runtimeHealingPolicy.test.js tests\unit\conductorContract.test.js --reporter=verbose
npx vitest run tests\unit\browserActionRegistry.test.js tests\unit\pipelineContract.test.js tests\unit\scenarioQualityContract.test.js tests\unit\nativePlaywrightLane.test.js tests\unit\environmentPreflight.test.js tests\unit\testDataBindingContract.test.js tests\unit\testDataMutex.test.js tests\unit\codegenExport.test.js tests\unit\runStream.test.jsx --reporter=verbose
node scripts\verify_codegen_contract.cjs
npm run build
```

All commands passed. `npm run build` still reports the pre-existing large-chunk warning.

## Phase 3 Exit Criteria

Phase 3 was not marked complete until session isolation proved:

- every independent case or data row starts from a clean browser context unless an explicit dependency graph says otherwise,
- cookies, storage, cache, and active browser pages are closed or cleared between independent work,
- failed or partially mutated rows cannot poison the next row or next case,
- a case that needs login again receives a fresh login flow in a fresh context,
- pre-flight environment checks detect baseURL/auth/service outages before expensive browser/agent work begins,
- environment defects are reported as environment/setup defects, not as QAAI or website behavior guesses,
- browser/session shutdown is deterministic and observable in run evidence.

## Phase 2 Exit Criteria

Phase 2 was not marked complete until test data binding proved:

- every fill/select/input step binds to approved test data or an explicit safe literal rule,
- no guessed inline data is used for certified runs,
- positive, negative, boundary, multi-row, and role-based datasets are represented,
- secret values bind through env/vault/fixture references,
- test data mutexes prevent concurrent row/value collisions,
- export blocks missing, ambiguous, unsafe, or uncertified data bindings.

## Phase 1 Exit Evidence

Completed on 2026-07-03.

- Added `scenarioQualityContract` as the deterministic authoring-quality layer.
- Generated cases receive a structured `qualityContract` with role, preconditions, session cleanup, expected result, assertion count, and Markdown readiness status.
- Vague steps and duplicate cases are withheld by `GenerationCompiler` before persistence.
- Missing session cleanup gets a default `fresh_context_per_case` contract instead of staying implicit.
- Native Playwright Markdown specs include preconditions and session cleanup.
- Added nullable `TestCase.qualityContractJson` and migration `20260703010000_add_quality_contract_json`.

Verification:

```text
node --check server\services\scenarioQualityContract.js
node --check server\services\generationCompiler.js
node --check server\services\nativePlaywrightLane.js
node --check server\services\testCaseContract.js
node --check server\routes\scenarios.js
npx vitest run tests\unit\scenarioQualityContract.test.js tests\unit\nativePlaywrightLane.test.js --reporter=verbose
npx prisma generate
npx prisma db push
npx vitest run tests\unit\scenarioQualityContract.test.js tests\unit\nativePlaywrightLane.test.js tests\unit\codegenExport.test.js tests\unit\conductorContract.test.js tests\unit\runStream.test.jsx --reporter=verbose
npm run build
```

All commands passed. `npm run build` still reports the pre-existing large-chunk warning.

## Phase 3 Exit Evidence

Completed on 2026-07-03.

- Added `environmentPreflight` as a runtime pre-flight service before browser startup.
- The conductor now checks the target URL before `mcp.startMcpSession`.
- Clear outages, DNS/connectivity failures, 5xx responses, temporary-unavailable responses, and auth-route rejection become `environment_defect` results.
- When pre-flight fails, the browser is not opened and every selected case receives an explicit blocked RunResult explaining that this is an environment/setup defect, not test evidence.
- Missing project target URL is skipped safely instead of blocking.
- Protected base URLs such as HTTP 401/403 outside auth routes count as reachable, avoiding false environment defects.
- Continuation cases that establish their own login/session now always recreate a clean browser session without requiring a precision feature flag.
- After a continuation login reset succeeds, the case gets a fresh agent conversation via `forceFreshConversation`, preventing prior-case assumptions from bleeding into the fresh browser.
- Existing independent-scenario fresh sessions, dirty-row recovery, final `mcp.stopMcpSession`, session registry cleanup, and `browser.session.end` evidence remain verified by the conductor contract suite.

Verification:

```text
node --check server\services\environmentPreflight.js
node --check server\services\agents\conductor.js
npx vitest run tests\unit\environmentPreflight.test.js tests\unit\conductorContract.test.js --reporter=verbose
npx vitest run tests\unit\codegenExport.test.js tests\unit\runStream.test.jsx tests\unit\testDataBindingContract.test.js tests\unit\testDataMutex.test.js --reporter=verbose
npx vitest run tests\unit\browserActionRegistry.test.js tests\unit\pipelineContract.test.js tests\unit\scenarioQualityContract.test.js tests\unit\nativePlaywrightLane.test.js --reporter=verbose
node scripts\verify_codegen_contract.cjs
npm run build
```

All commands passed. `npm run build` still reports the pre-existing large-chunk warning.

## Phase 2 Exit Evidence

Completed on 2026-07-03.

- Added `testDataBindingContract` as the deterministic approved-data certification layer.
- GenerationCompiler now runs data-binding certification before a case can enter ready output.
- Approved data tokens with complete bindings certify as data-bound.
- Copied approved row values are rejected as unsafe literals instead of being silently treated as reliable automation.
- Secret-like fields must use a token/env/vault/fixture reference; literal secrets are rejected.
- Declared assertions are checked too, so copied approved expected values cannot become fake certified proof.
- `testDataGenerationContract` now reports coverage kinds across bindings: positive, negative, boundary, multi-row, and role-based.
- Existing test-data mutex locking remains part of the phase: dataset rows and protected identity values are locked without exposing raw secrets.

Verification:

```text
node --check server\services\testDataBindingContract.js
node --check server\services\generationCompiler.js
node --check server\services\testDataGenerationContract.js
npx vitest run tests\unit\testDataBindingContract.test.js tests\unit\testDataMutex.test.js tests\unit\scenarioQualityContract.test.js --reporter=verbose
npx vitest run tests\unit\codegenExport.test.js tests\unit\conductorContract.test.js tests\unit\runStream.test.jsx --reporter=verbose
npx vitest run tests\unit\browserActionRegistry.test.js tests\unit\pipelineContract.test.js tests\unit\nativePlaywrightLane.test.js --reporter=verbose
node scripts\verify_codegen_contract.cjs
npm run build
```

All commands passed. `npm run build` still reports the pre-existing large-chunk warning.
