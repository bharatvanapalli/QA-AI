# QAAI Fresh AI Handoff

Last verified by Codex: 2026-08-04

This file is for a new AI agent joining the QAAI workspace. Read this first before scanning the repo. It explains what the project is, which files matter, what is currently stable, what is still incomplete, and what must not be touched casually because it can break the current working Conductor flow.

## Correct Root Path

Use this as the real project root:

```text
C:\Users\2461898\Downloads\qaai_fixed\qaai_fixed\qaai_fixed
```

The parent folder is only the outer workspace:

```text
C:\Users\2461898\Downloads\qaai_fixed\qaai_fixed
```

Run commands, searches, tests, and edits from the inner `qaai_fixed` folder.

## Product In One Paragraph

QAAI is an autonomous QA platform. A user uploads requirements or writes test intent, QAAI generates scenarios and test cases, then the AI Conductor runs those cases through a real browser using MCP/Playwright. The platform then produces reports, screenshots/video/artifacts, and generated runnable Playwright/Selenium/POM output files. The current high-priority area is preserving the stable browser execution flow while repairing Output Files, ReplayIR, screenshots, and video artifacts.

## Most Important Rule

Do not turn Output Files, Reports, screenshots, videos, ReplayIR, or validation into execution authorities.

The current working architecture is:

```text
BrowserTransactionController / controller runtime
  -> only authority for scheduling, browser mutation, recovery, continuation, and verdict

Observers / Healer / Critic / Reports / Output Files / artifact recorders
  -> evidence or proposal only
  -> no direct browser mutation
  -> no step termination
  -> no verdict rewrite
```

If you add artifact generation beside the controller and let it block, delay, retry, or terminate runs, you will reproduce the old failures.

## Current Worktree Warning

This repo is very dirty. There are many modified, added, deleted, and untracked files. Assume unrelated changes belong to the user or prior work.

Do not run:

```text
git reset --hard
git clean
git checkout -- .
bulk stash
bulk stage
```

If rollback is needed, use scoped file restoration only after inspecting the target files. A previous safe checkpoint was recorded:

```text
refs/codex/checkpoints/controller-stable-20260724-180817
commit 8c2dd4bd5584437a2ca327a6bcd5becf5ac7c6a1
```

Do not restore the whole tree blindly from that checkpoint.

## Current Stable Execution Slice

Memory from prior verified work says:

```text
npm run verify:controller-cutover
-> 32/32 controller files
-> 228/228 tests
-> 20/20 chaos runs
-> 0 duplicate mutations
-> 0 resume redispatches
```

Treat that as the last known stable Conductor proof, but verify again before making a release claim because the worktree may have changed since then.

The current production Conductor entry path is:

```text
server/services/agents/conductorPinned.js
  -> server/services/agents/controllerConductor.js
  -> server/services/agents/conductorRunner.js
  -> controller/gateway/runtime services
```

Current checked state on 2026-08-04:

```text
server/services/agents/conductor.js                MISSING/deleted in this worktree
server/services/agents/controllerConductor.js      present, about 621 lines
server/services/agents/conductorRunner.js          present, about 434 lines
server/services/agents/conductorPinned.js          present, tiny wrapper
server/services/actionExecutionGateway.js          present, about 954 lines
server/routes/outputFiles.js                       present, large
src/pages/Reports.jsx                              present, large
src/pages/OutputFiles.jsx                          present, large
prisma/schema.prisma                               present, large
```

There are huge legacy conductor backups and tmp files, for example:

```text
server/services/agents/conductor.js.before-cleanup.bak
server/services/agents/conductor.singlepass.tmp.js
_conductor_singlepass.tmp.js
_conductor_auth_refresh.tmp.js
```

Do not edit these unless the user explicitly asks for archaeology or restoration. The active runtime is the controller path above.

## Files To Read First

Read only these before doing work:

```text
AGENTS.md
package.json
server/services/agents/conductorPinned.js
server/services/agents/controllerConductor.js
server/services/agents/conductorRunner.js
server/services/actionExecutionGateway.js
server/routes/outputFiles.js
server/services/codegen/replayExport.js
server/services/codegen/index.js
server/services/codegen/adapters/playwrightPom.js
server/services/codegen/adapters/playwrightPomJs.js
server/services/codegen/adapters/playwrightPomJsStandard.js
src/pages/OutputFiles.jsx
src/pages/Reports.jsx
prisma/schema.prisma
```

If working specifically on transaction behavior, also inspect:

```text
server/services/browserTransactionRuntime.js
server/services/browserTransactionEventJournal.js
server/services/controllerActionExecutionGateway.js
server/services/controllerCompositeExecutor.js
server/services/controllerTypedAdapterRegistry.js
server/services/controllerRecoveryCoordinator.js
server/services/controllerMcpRuntimeAdapter.js
server/services/controllerVerdictProjector.js
```

Use `rg --files` to confirm names because this repo changes often.

## How To Read Huge Files Without Burning Tokens

Never open a huge file fully in chat.

Use targeted search first:

```powershell
rg -n --no-heading "RunResult|replayIrJson|actionGraphJson|executionContractJson" server/routes/outputFiles.js
rg -n --no-heading "createBrowserTransactionRuntime|createControllerActionExecutionGateway|RunResult.create|stepResults" server/services/agents/controllerConductor.js
rg -n --no-heading "recordSuccessfulLocator|mcp.callTool|browser_|RESULT:|assertion_check" server/services/agents/conductor.js.before-cleanup.bak
```

Then read only the nearby chunk:

```powershell
$p='server/routes/outputFiles.js'
$c=Get-Content -LiteralPath $p
for($i=3300;$i -le 3380;$i++){ '{0}:{1}' -f $i,$c[$i-1] }
```

For the legacy huge Conductor backup, chunk around named concepts, not linearly:

```powershell
rg -n --no-heading "SYSTEM_PROMPT|recordSuccessfulLocator|runConductor|mcp.callTool|assertion_check|RESULT:" server/services/agents/conductor.js.before-cleanup.bak
```

Only read exact hit windows:

```powershell
$p='server/services/agents/conductor.js.before-cleanup.bak'
$c=Get-Content -LiteralPath $p
for($i=12000;$i -le 12180;$i++){ '{0}:{1}' -f $i,$c[$i-1] }
```

## Codebase Map

Frontend:

```text
src/App.jsx                       routes/pages
src/pages/TestCases.jsx           generated and editable test cases
src/pages/RunSuite.jsx            run launching / theater route integration
src/pages/Theater.jsx             live run view
src/pages/Reports.jsx             run results, screenshots/video/trace UI
src/pages/OutputFiles.jsx         generated output browser
src/lib/apiClient.js              HTTP client
src/store/runStream.jsx           WebSocket run events
src/store/project.jsx             selected project state
```

Backend routes:

```text
server/index.js                   Express entry
server/routes/agents.js           main agent/run pipeline route
server/routes/blocked.js          blocked item rerun path
server/routes/runs.js             run endpoints
server/routes/testCases.js        test case lifecycle
server/routes/scenarios.js        scenario generation
server/routes/outputFiles.js      Output Files list/tree/preview/export/regenerate
server/routes/reporter.js         report-related routes
```

Execution/runtime:

```text
server/services/agents/conductorPinned.js
server/services/agents/controllerConductor.js
server/services/agents/conductorRunner.js
server/services/controllerConductorRunner.js
server/services/actionExecutionGateway.js
server/services/controllerActionExecutionGateway.js
server/services/browserTransactionRuntime.js
server/services/browserTransactionEventJournal.js
server/services/browserMutationTaxonomy.js
server/services/controllerTypedAdapterRegistry.js
server/services/controllerCompositeExecutor.js
server/services/controllerRecoveryCoordinator.js
server/services/controllerMcpRuntimeAdapter.js
server/services/controllerVerdictProjector.js
server/services/sessionRegistry.js
server/services/mcp.js
```

Output/code generation:

```text
server/services/codegen/index.js
server/services/codegen/replayExport.js
server/services/codegen/replayEmitter.js
server/services/codegen/executedCaseAst.js
server/services/codegen/pageObjectRepository.js
server/services/codegen/playwrightJs.js
server/services/codegen/pom.js
server/services/codegen/_locators.js
server/services/codegen/_verifiedActionLocator.js
server/services/codegen/_replayContract.js
server/services/codegen/_packageValidate.js
server/services/codegen/_exportValidate.js
server/services/codegen/adapters/playwrightPom.js
server/services/codegen/adapters/playwrightPomJs.js
server/services/codegen/adapters/playwrightPomJsStandard.js
server/services/codegen/templates/playwright-pom-js/**
```

Database/schema:

```text
prisma/schema.prisma
server/prisma.js
server/services/runs.js
```

Important `RunResult` fields:

```text
stepResults
assertionCheckResults
screenshots
video
replayIrJson
executionContractJson
actionGraphJson
exportMeta
```

## What Was Fixed And Should Be Protected

The old problem was not lack of safeguards. The old problem was too many modules independently deciding to block, retry, skip, or rewrite truth.

The stabilized direction is:

```text
one controller owns execution decisions
one gateway owns browser mutation dispatch
one journal owns transaction facts
one verdict projector owns final case verdict
observers/proposals cannot mutate or terminate
```

Do not reintroduce:

```text
direct MCP mutation outside gateway
Healer clicking directly
Critic terminating cases directly
Output Files changing run verdict
Reports changing run verdict
WaitForState as a verdict-producing step
assertion failure stopping unrelated later steps
missing screenshot/video as execution failure
missing ReplayIR as execution failure
generic whole-case reruns after late evidence problems
```

Assertions are proof for reports and generated tests. They should record pass/fail truthfully, but an assertion mismatch alone should not freeze execution unless a later required action positively cannot continue.

## Current Known Gap: Output Files / ReplayIR

The controller can execute cases correctly, but the Output Files pipeline is not fully connected to the new controller evidence.

Observed root cause from prior diagnosis:

```text
controllerConductor.js persists:
  status
  duration
  stepResults
  assertionCheckResults
  verdict

but historically dropped or did not fully persist:
  replayIrJson
  executionContractJson
  actionGraphJson
  verified action-time locators
  browser context/frame/shadow identity
  DOM node identity
  detailed transaction evidence needed for codegen
```

That means a run can pass in Reports but still not generate truthful runnable POM output, because Output Files lacks the exact executed action evidence.

Do not solve this by regenerating selectors from authored prose. That creates fake output.

Correct solution:

```text
commit durable critical execution evidence
-> after run/case boundary, project ActionGraph
-> project ReplayIR from ActionGraph
-> generate POM files from ReplayIR
-> Output Files displays actual latest run and truthful status
```

## Current Known Gap: Reports Media

Reports currently has screenshot/video UI, but users have seen `0 screenshots` and need real video recording for every run.

Important rule:

```text
media is passive and may degrade
execution evidence is critical and must not be dropped
```

Screenshot/video capture failure must become:

```text
ARTIFACT_UNAVAILABLE
```

It must not become:

```text
case failed
step blocked
run terminated
```

## Unimplemented Plan: Passive Run Artifact Plane

This plan is not fully implemented yet. It is the next architecture direction for Output Files, ReplayIR, screenshots, and videos.

Target architecture:

```text
BrowserTransactionController
        |
        | executes and verifies operations exactly as today
        |
        +-- publishes immutable timeline events
                    |
                    v
          Run Artifact Recorder
          +-- ReplayIR / ActionGraph
          +-- continuous video
          +-- step screenshots
          +-- report artifacts
```

The recorder must have no authority to:

```text
click
fill
select
retry
heal
delay or release the next step
mark steps passed or failed
terminate the run
change the final verdict
```

### Critical Evidence Ledger

For every operation, persist enough data to rebuild code later:

```text
runId
runResultId
testCaseId
authoredStepId
contractStepId
operationId
actionOccurrenceId
sequenceIndex
operation type
semantic target name
browser page/context id
popup/page ownership
frame chain
shadow DOM chain
selected Playwright locator
locator strategy
locator count
same-node proof
backend node identity when available
accessibility role/name
visible/actionable proof
before/after URL
before/after title
data value reference or literal
assertion expected value
assertion observed value
wait condition
final operation status
timestamps
```

This tiny immutable evidence write is allowed at resolve/commit time. Heavy work is not.

Correct timing:

```text
action commits
-> durable small evidence record
-> release next operation
-> post-run projector builds ActionGraph/ReplayIR/package/media
```

Do not put screenshot extraction, video encoding, package generation, validation, or ReplayIR building between action commit and next-step continuation.

### Video Recording

Create one recorder per browser context:

```text
S1 begins -> start recording
S1 completes -> keep recording because S2 reuses authenticated context
S2 completes -> stop/finalize video
Reports -> one grouped video with S1/S2 step markers
```

Use Playwright native video if available. Otherwise use an isolated CDP screencast behind a `RunVideoRecorder` interface. The recorder must not share execution authority with Conductor.

### Screenshots Without Slowing Every Step

Record video continuously and timestamp every controller decision:

```text
operation resolved
dispatch started
action committed
assertion evaluated
execution error observed
manual boundary observed
case completed
```

After the run, extract the nearest video frame for every committed step and assertion. Full-resolution screenshots can be captured only for:

```text
assertion evaluation
execution errors
manual boundaries
important navigation destinations
final case state
```

Do not take a blocking screenshot after every action.

### Artifact Metadata

Store large files outside database rows. Persist metadata only:

```text
runId
runResultId
testCaseId
operationId
actionOccurrenceId
artifactKind
timestamp
videoOffset
storageKey
mimeType
byteSize
sha256
captureStatus
captureError
```

Supported artifact types:

```text
RUN_VIDEO
STEP_SCREENSHOT
ASSERTION_SCREENSHOT
FAILURE_SCREENSHOT
FINAL_STATE_SCREENSHOT
TRACE
```

Artifact state:

```text
PENDING -> CAPTURING -> FINALIZING -> READY
                                  \-> DEGRADED
```

`DEGRADED` must not modify execution results.

## Output Files Requirements

Output Files must generate clean, standard, runnable Playwright POM output from the browser actions actually performed.

Generated packages must contain:

```text
real executed steps
real action-time locators
preserved assertions
preserved waits
correct data values
clean page objects
runnable specs
truthful status when execution stopped early
```

Output Files must never:

```text
hide a run because ReplayIR is missing
show an older run as latest
emit authored-only steps as runnable code
invent locators from narrative descriptions
put UUIDs/hashes/telemetry noise into spec files
block viewing because certification failed
block viewing because secret detection found something
claim diagnostic files are runnable
```

Correct output states:

```text
Generating output
Generated - not run
Generated - diagnostic only
Generated - failed execution prefix
Runnable package ready
Evidence materialization pending
Output unavailable - reason shown
```

Separate these concepts in UI/API:

```text
Viewable: yes/no
Runnable: yes/no
Certified: yes/no
Executed: yes/no
```

Viewable should almost always be yes once files exist.

## Locator Policy

Locator priority:

```text
1. verified getByTestId
2. verified getByRole with accessible name
3. verified getByLabel
4. verified getByPlaceholder
5. verified stable attribute locator
6. verified scoped semantic locator
7. verified CSS selector
8. verified XPath only for exceptional structural cases
9. guessed locator only as last fallback
```

A locator is verified only when:

```text
it resolves to exactly one element
it resolves to the same action-time element
it survives stabilization/rerender when applicable
it belongs to the correct page/frame/shadow context
```

If guessed fallback is used:

```text
the package stays visible
the fallback is marked clearly
it is not certified
it is not silently treated as real execution truth
```

## Assertion Policy

Assertions must be preserved as assertions, not emitted like clicks.

For every assertion, preserve:

```text
assertion id
assertion type
target locator/reference
expected value
observed value
exact/contains/regex/tolerance mode
pass/fail result
continuation policy
screenshot/video marker when available
```

Good generated examples:

```js
await expect(page.getByText("Welcome OdysseyOne")).toBeVisible();
await expect(locator).toHaveText(/User Management/i);
await expect(locator).toContainText("66");
await expect(page).toHaveURL(/user\/view-user\/3460/);
```

Bad:

```js
expect.soft(false, "expected value was not supplied").toBe(true);
```

If assertion evidence is incomplete, put diagnostics outside runnable specs.

## Package Shape For Playwright POM JS

Preferred output shape:

```text
package.json
package-lock.json when available
playwright.config.js
.env.example
README.md
locators/
pages/
tests/
fixtures/
support/
evidence/
EXPORT_MANIFEST.json
```

Specs must:

```text
import only used page objects
contain no internal telemetry
contain no UUID/hash annotations
contain no duplicate accidental actions
contain assertions
use correct values/data references
be installable/runnable when dependencies are healthy
```

## Things Not To Touch Casually

Do not casually change:

```text
server/services/agents/conductorPinned.js
server/services/agents/controllerConductor.js
server/services/agents/conductorRunner.js
server/services/actionExecutionGateway.js
server/services/controllerActionExecutionGateway.js
server/services/browserTransactionRuntime.js
server/services/controllerVerdictProjector.js
server/services/controllerTypedAdapterRegistry.js
server/services/controllerCompositeExecutor.js
server/services/controllerRecoveryCoordinator.js
```

If you must touch them, first write down:

```text
what exact Conductor behavior changes
why Output Files/Reports cannot be fixed passively instead
which test proves no duplicate mutation/no new stall/no new termination
```

Then run at least:

```powershell
npm run verify:controller-cutover
```

For narrow syntax checks:

```powershell
node --check server/services/agents/controllerConductor.js
node --check server/services/actionExecutionGateway.js
node --check server/routes/outputFiles.js
```

Do not run `npm install` unless the user explicitly authorizes it. Dependencies already exist in `node_modules`; final generated-package install/run proof may be environment-blocked if npm is unhealthy.

## Live Odyssey S1 -> S2 Notes

The important live demo flow is grouped S1 -> S2. S2 must reuse the authenticated browser context created by S1.

Known IDs from prior handoff:

```text
Project ID:     1582559f-364f-4d0e-bfde-fd18832fdaa7
Generation ID:  d486351a-6070-47d1-b8b5-2c8bc4156abb
User ID:        a5d916cd-4178-4bcc-b409-c885a389e843
S1 Test Case:   4af44607-e59b-4cd4-85a2-68dc1e89cdc9
S2 Test Case:   c7dabb04-0fef-4530-bad8-8c0f6622ed64
```

Run only through QAAI backend execution pipeline. Do not manually control Chrome, Playwright, CDP, or the website from Codex.

Required demo environment:

```text
QAAI_DISABLE_UNIVERSAL_ACTION_RUNTIME=1
QAAI_DEMO_BYPASS_TARGET_GUARDS=1
QAAI_DEMO_CONTINUE_KERNEL_GUARDS=1
```

Do not set:

```text
QAAI_DISABLE_DETERMINISTIC_STEP_KERNEL
QAAI_DISABLE_FAST_FILL_PREMODEL
```

Backend commands:

```powershell
node scripts\_start_new_odyssey_grouped.cjs
node scripts\_watch_new_odyssey_ws.cjs
node scripts\_new_odyssey_status.cjs
node scripts\_cancel_new_odyssey.cjs
```

Keep watcher invocations bounded to about 40-50 seconds. Do not restart backend during an active run.

## Working Safely On The Next Improvement

If implementing the passive artifact/output architecture, expected areas to touch are:

```text
server/services/runArtifactRecorder*.js              new or existing passive services
server/services/runArtifactProjector*.js             post-run materialization
server/services/codegen/**                           ReplayIR/ActionGraph/POM projection
server/routes/outputFiles.js                         latest-run visibility and package API
server/routes/reporter.js                            artifact metadata exposure
src/pages/OutputFiles.jsx                            UI states and package visibility
src/pages/Reports.jsx                                video/screenshots timeline UI
prisma/schema.prisma                                 artifact metadata if needed
tests/unit/*output*                                  Output Files tests
tests/unit/*artifact*                                artifact recorder/projector tests
tests/unit/*codegen*                                 replay/codegen tests
```

Avoid changing controller behavior. If you think you need to change it, first ask whether the missing data can be captured as passive evidence instead.

## Good Acceptance Criteria

The final solution is not complete until a fresh run proves:

```text
latest run appears in Output Files
files are viewable
no old run is substituted
no secret/certification gate hides files
generated spec contains actual executed steps
locators are action-time verified locators
assertions are preserved
waits are preserved
page objects are clean
data values are correct
failed/interrupted runs preserve executed prefix truthfully
Reports show video/screenshot status truthfully
artifact failure does not alter verdict
Conductor still passes controller cutover gates
S1 -> S2 authenticated session continuity remains intact
```

The most important invariant:

```text
Executed operation
= journal evidence
= ActionGraph operation
= ReplayIR operation
= generated POM method
= spec call
```

If any link in that chain is missing, say so truthfully. Do not fabricate.

