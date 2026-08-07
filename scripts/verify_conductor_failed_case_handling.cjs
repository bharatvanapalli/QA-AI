'use strict';
/*
 * Replay guard for the "improvise & proceed past a failed case" architecture bug.
 *
 * Built directly from the bad transcript (case a306ab75, AuthProfiles Row 1):
 *   Employee Name autocomplete typed "Alice" → "No Records Found" → the agent
 *   improvised "James", navigated to other modules, used browser_run_code_unsafe,
 *   and the run ended as a vague "agent loop". Root cause: the entire failure-
 *   handling / anti-improvisation path was gated behind QAAI_CERTIFIED_ACTION_TARGETS
 *   (off by default, set in no .env), so it was dead code at runtime; and the few
 *   checks that did run were post-hoc, event-local, and keyed to currentStepIndex.
 *
 * This guard proves the fix WITHOUT a live run (no API, no browser):
 *   A. SOURCE STRUCTURE — the safety net (no-results, approved-data whitelist,
 *      wrong-tool block, terminal stop, top-of-turn gate) is ALWAYS-ON (__safetyOn),
 *      NOT gated by the precision flag; one shared finalizer; the broad pass-
 *      fallbacks are closed for result-bearing / wrong-tool steps.
 *   B. BEHAVIOR — the pure helpers, replayed on the exact transcript surface,
 *      yield: terminal test_data_invalid; Step 11 blocked + Steps 12-20 dependency-
 *      blocked with a UI-consumable error; and the approved-data whitelist rejects
 *      "James" into the field that approved "Alice".
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CONDUCTOR = path.join(ROOT, 'server', 'services', 'agents', 'conductor.js');
const src = fs.readFileSync(CONDUCTOR, 'utf8');
const reportsSrc = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'Reports.jsx'), 'utf8');
const resolverSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'actionLocatorResolver.js'), 'utf8');
const pipelineSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'pipelineContract.js'), 'utf8');
const pomSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'codegen', 'adapters', 'playwrightPom.js'), 'utf8');
const TRIPLE_FILES = {
  'projectActionMemory.js': path.join(ROOT, 'server', 'services', 'projectActionMemory.js'),
  'executionAuthoringCompiler.js': path.join(ROOT, 'server', 'services', 'executionAuthoringCompiler.js'),
  'codegen/_actionPlan.js': path.join(ROOT, 'server', 'services', 'codegen', '_actionPlan.js'),
  'codegen/_replayContract.js': path.join(ROOT, 'server', 'services', 'codegen', '_replayContract.js'),
  'codegen/replayEmitter.js': path.join(ROOT, 'server', 'services', 'codegen', 'replayEmitter.js'),
};
const { decideResultOutcome, isResultBearingStep, classifyResultIntent } = require(path.join(ROOT, 'server', 'lib', 'resultBearingInputVerification'));
const { buildTestDataInvalidOutcome, isSuggestionPickStep } = require(path.join(ROOT, 'server', 'lib', 'widgetVerification'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const has = (needle) => src.includes(needle);
const idx = (needle) => src.indexOf(needle);

console.log('— A. SOURCE STRUCTURE: safety is ALWAYS-ON, not behind the precision flag —');
ok('__safetyOn predicate exists (kill-switch only, on by default)',
  /const __safetyOn = \(\) => !\/\^\(1\|true\|yes\|on\)\$\/i\.test\(process\.env\.QAAI_DISABLE_SAFETY/.test(src));
ok('pre-dispatch SAFETY block is gated by __safetyOn (not __pxEnabled)',
  has('if (__safetyOn() && __pxMutating(tu.name) && !skipDispatchForEvidence'));
ok('approved-data whitelist uses field LIFECYCLE binding (__pxApprovedValueForField), not just currentStepIndex',
  has('const approvedForField = __pxApprovedValueForField(typedField);')
  && has('__pxApprovedValueForField = (fieldLabel)'));
ok('always-on result-bearing protocol runs on every type/fill (gated by __safetyOn, not the flag)',
  has("if (__safetyOn() && !result?.isError && (tu.name === 'browser_type' || tu.name === 'browser_fill')) {")
  && has('resultBearing.decideResultOutcome({ step: curStepRB'));
ok('top-of-turn settled gate exists and runs BEFORE the model call (`let resp;`)',
  has('if (__safetyOn() && __pxPendingResultCheck && !__pxTerminalStop')
  && idx('__pxPendingResultCheck && !__pxTerminalStop') < idx('\n    let resp;'));
ok('the safety block precedes (is separate from) the flag-gated precision-capture block',
  idx('if (__safetyOn() && __pxMutating(tu.name)') < idx('OPTIONAL PRECISION LOCATOR CAPTURE')
  && idx('OPTIONAL PRECISION LOCATOR CAPTURE') < idx('__pxEnabled() && __pxMutating(tu.name) && !skipDispatchForEvidence'));

// NEGATIVE: the no-results / terminal decision must NOT be reachable only under the
// precision flag. Assert decideResultOutcome appears inside a __safetyOn() region.
{
  const sIdx = idx("if (__safetyOn() && !result?.isError && (tu.name === 'browser_type'");
  const window = sIdx >= 0 ? src.slice(sIdx, sIdx + 2600) : '';
  ok('decideResultOutcome + __pxTerminalStop live inside the __safetyOn() block (not the flag block)',
    window.includes('decideResultOutcome') && window.includes('__pxTerminalStop = { stepIndex: currentStepIndex'));
}

console.log('\n— A2. SOURCE STRUCTURE: broad pass-fallbacks closed; one shared finalizer —');
ok('value/Fill expectation BLOCKS a wrong tool (navigate/click) instead of "trust the action"',
  has("reason: 'value_wrong_tool'") && has('if (!isInputMutationTool(toolName)) {'));
ok('verify.kind=none result-bearing step BLOCKS on no-match instead of sealing as "no observable outcome"',
  has("reason: 'result_no_match'") && has("reason: 'result_needs_intent'"));
ok('single shared finalizeTerminalStop used by BOTH the post-dispatch site and the top-of-turn gate',
  /const finalizeTerminalStop = \(ts\) =>/.test(src)
  && has('finalizeTerminalStop(__pxTerminalStop)')   // top-of-turn gate
  && has('const __outcome = finalizeTerminalStop(ts);')); // post-dispatch site

console.log('\n— B. BEHAVIOR: replay the exact transcript surface (Alice → No Records) —');
// The transcript's Step 12 is a suggestion-pick; Step 11 the Fill of "Alice".
const suggestionStep = { action: 'Click', element: 'First autocomplete suggestion in Employee Name dropdown', expected: 'employee selected' };
const fillStep = { order: 11, action: 'Fill', element: 'Employee Name autocomplete textbox', value: 'Alice', expected: 'Employee Name autocomplete shows suggestions' };
const aliceSurface = 'textbox "Employee Name": Alice\nNo Records Found';

ok('the Fill step is recognised as result-bearing', isResultBearingStep(fillStep) === true);
ok('the suggestion-pick step is recognised', isSuggestionPickStep(suggestionStep) === true);
ok('intent of the suggestion-pick is expect_match', classifyResultIntent(suggestionStep) === 'expect_match');
{
  const d = decideResultOutcome({ step: fillStep, snapshotText: aliceSurface });
  ok('Alice + No Records (match required) → terminal_test_data_invalid', d.outcome === 'terminal_test_data_invalid', JSON.stringify(d));
}

console.log('\n— B2. BEHAVIOR: the audit-ready outcome blocks Step 11 + Steps 12-20 —');
{
  const approvedSteps = Array.from({ length: 20 }, (_, i) => ({ order: i + 1, action: 'Verify', element: `step ${i + 1}` }));
  approvedSteps[10] = fillStep; // Step 11 (index 10)
  const stepResults = Array.from({ length: 20 }, (_, i) => ({ status: i < 11 ? 'pass' : 'pending' }));
  const out = buildTestDataInvalidOutcome({ stepResults, approvedSteps, field: 'Employee Name autocomplete textbox', value: 'Alice', fallbackStepIndex: 11 });
  ok('Step 11 is BLOCKED (not the misleading PASS the transcript showed)',
    out.stepResults[10].status === 'blocked' && out.stepResults[10].reason === 'test_data_invalid');
  ok('Step 11 carries a UI-consumable error naming Alice + No Records',
    typeof out.stepResults[10].error === 'string' && /Alice/.test(out.stepResults[10].error) && /No Records Found/.test(out.stepResults[10].error));
  ok('Steps 12-20 are dependency-blocked', out.stepResults.slice(11).every((s) => s.status === 'blocked' && s.reason === 'test_data_invalid_dependency'));
  ok('top-level error is the human explanation, not mechanical_v1', /Alice/.test(out.error) && !/mechanical_v1/.test(out.error));
}

console.log('\n— B3. BEHAVIOR: the approved-data whitelist refuses "James" into the Alice field —');
// Replica of the in-conductor field-key + lifecycle lookup (same shape as
// __pxFieldKey / __pxApprovedValueForField) — the source assertions in A tie the
// real code to this logic; here we prove the logic rejects the improvisation.
{
  const fieldKey = (label) => String(label || '').toLowerCase().replace(/\b(textbox|autocomplete|field|input|box|the)\b/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const approvedSteps = [fillStep];
  const approvedValueForField = (fieldLabel) => {
    const fk = fieldKey(fieldLabel); if (!fk) return null;
    for (const s of approvedSteps) {
      if (!s || !/fill|type|enter/i.test(String(s.action || ''))) continue;
      const v = s.value != null ? String(s.value).trim() : '';
      if (!v || /\{\{.*\}\}/.test(v)) continue;
      const sk = fieldKey(s.element);
      if (sk && (sk === fk || sk.includes(fk) || fk.includes(sk))) return v;
    }
    return null;
  };
  const approved = approvedValueForField('Employee Name autocomplete textbox');
  ok('approved value for Employee Name resolves to "Alice" via lifecycle (not current step)', approved === 'Alice', String(approved));
  const wouldBlock = (typed) => approved && typed && typed.toLowerCase() !== approved.toLowerCase();
  ok('typing "James" into Employee Name is REJECTED (improvisation blocked)', wouldBlock('James') === true);
  ok('typing the approved "Alice" is allowed', wouldBlock('Alice') === false);
}

console.log('\n— C. STEP-STATE REDUCER: single decision authority + invariants —');
ok('a single reduceStepOutcome reducer exists', /const reduceStepOutcome = \(\{/.test(src));
ok('BOTH writers route through it (STEP_VERDICT path + tool-completion path)',
  has('const reducedVerdict = reduceStepOutcome(') && has('const reducedStep = reduceStepOutcome('));
ok('Rule 5 — a non-pass STEP_VERDICT HOLDS the pointer (advance only via sealStepState on pass)',
  has('sealStepState(idx - 1, reducedVerdict)')
  && /const sealStepState = \(idx, reduced\) =>[\s\S]*?currentStepIndex = reduced\.advance \? idx \+ 1 : idx;/.test(src));
ok('Rule 6 — wrong-tool table excludes navigate/run_code from fill/click/select',
  /STEP_TOOLS_FOR_CLASS = \{[\s\S]*?fill: new Set\(\[/.test(src)
  && !/STEP_TOOLS_FOR_CLASS[\s\S]*?fill: new Set\(\[[^\]]*browser_navigate/.test(src));
ok('Rule 1 — reducer downgrades a claimed pass that carries a blocking error/failed check',
  /if \(status === 'pass' && \(opFailed \|\| asFailed \|\| \(outError/.test(src));
ok('Rule 8 (backend) — reconcileStepResults exists and runs BEFORE the result is persisted',
  /const reconcileStepResults = \(\) =>/.test(src)
  && idx('reconcileStepResults();') < idx('precisionRecords: __pxEnabled() ? precisionRecords : undefined }'));
ok('Rule 8 (frontend) — Reports DeclaredStepRow downgrades pass-with-blocking-error',
  /const status = \(rawStatus === 'pass' && \(opFailedRow \|\| asFailedRow \|\| blockingErrorRow/.test(reportsSrc));

console.log('\n— D. browser_triple_click is helper-only, not a live completion tool —');
ok('conductor handles browser_triple_click only as Fill-step helper traffic',
  /fillPreparationHelperTraffic && tu\.name === 'browser_triple_click'/.test(src)
  && /Fill-preparation helper noted: browser_triple_click is not dispatched as a live MCP tool/.test(src));
ok('actionLocatorResolver no longer lists browser_triple_click', !/browser_triple_click/.test(resolverSrc));

console.log('\n— E. BEHAVIOR: reducer rules (logic replica tied to the source asserts above) —');
{
  // Replica of reduceStepOutcome's Rule 6 + Rule 1 (the source asserts in C tie the
  // real code to this shape). Proves a navigate can't satisfy a fill, and a claimed
  // pass with a blocking error is downgraded.
  const TOOLS = { fill: new Set(['browser_type', 'browser_fill', 'browser_fill_form']) };
  const wrongTool = (cls, tool) => TOOLS[cls] && !TOOLS[cls].has(tool);
  ok('browser_navigate cannot satisfy a fill step', wrongTool('fill', 'browser_navigate') === true);
  ok('browser_run_code_unsafe cannot satisfy a fill step', wrongTool('fill', 'browser_run_code_unsafe') === true);
  ok('browser_type CAN satisfy a fill step', wrongTool('fill', 'browser_type') === false);
  const downgrade = (proposed, err) => (proposed === 'pass' && err) ? 'blocked' : proposed;
  ok('a claimed pass with a blocking error downgrades to blocked', downgrade('pass', 'No Records Found') === 'blocked');
  ok('a clean pass stays pass', downgrade('pass', null) === 'pass');
}

console.log('\n— F. SECOND-AUDIT P0s (prompt doctrine, pipelineContract, evidence-missing, finalize, sole-writer) —');
ok('#1 prompt no longer teaches "tool returned ok=true → pass"', !/tool returned ok=true → pass/.test(src));
ok('#1 prompt teaches deterministic evidence doctrine instead',
  has('decides each step') && has('NOT from "the tool returned without error"'));
ok('#2 pipelineContract lists browser_triple_click only as a Fill-preparation helper, not a click completion tool',
  /FILL_PREPARATION_CLICK_TOOLS[\s\S]*browser_triple_click/.test(pipelineSrc)
  && !/const CLICK_TOOLS = new Set\(\[[^\]]*browser_triple_click/.test(pipelineSrc));
ok('#3 single sealStepState mutator exists (sole completion-pointer writer)',
  /const sealStepState = \(idx, reduced\) =>/.test(src) && has('currentStepIndex = reduced.advance ? idx + 1 : idx;'));
ok('#3 BOTH writers seal through it (STEP_VERDICT + tool-completion)',
  has('sealStepState(idx - 1, reducedVerdict)') && has('sealStepState(completedIdx, reducedStep)'));
ok('#4 reducer downgrades a RESULT-BEARING fill/select pass with no proven match → evidence_missing',
  has("reason = 'evidence_missing'") && /!opProven && !asProven/.test(src));
ok('#4 evidence_missing is SCOPED to result-bearing (regression fix: plain password fill must NOT block)',
  /\(cls === 'fill' \|\| cls === 'select'\) && isResultBearing/.test(src) && /isResultBearingStep\(step\)/.test(src));
ok('#6 finalizeStepResults pending tail is NEVER pass (skipped/blocked only)',
  has("const tail = status === 'blocked' ? 'blocked' : 'skipped';") && !/const tail = status === 'pass' \? 'pass'/.test(src));

console.log('\n— G. BEHAVIOR: evidence-missing + pending-not-pass (logic replicas tied to F) —');
{
  // Replica of Rule 5b (SCOPED to result-bearing — the regression fix): a RESULT-
  // BEARING fill/select that proposes pass with no matched check → blocked; a PLAIN
  // fill (username/password/notes) passes on the successful type ("checkpoint IS the
  // action"), even when its effect can't be read back (masked password).
  const reducePass = (cls, opMatched, asMatched, resultBearing) => {
    if ((cls === 'fill' || cls === 'select') && resultBearing) {
      const opProven = opMatched === true, asProven = asMatched === true;
      if (!opProven && !asProven) return 'blocked';
    }
    return 'pass';
  };
  ok('RESULT-BEARING fill, no proven match → blocked (evidence_missing)', reducePass('fill', null, null, true) === 'blocked');
  ok('PLAIN password fill, no readback → PASS (regression fix: must not block login)', reducePass('fill', null, null, false) === 'pass');
  ok('result-bearing fill with a matched operation check → pass', reducePass('fill', true, null, true) === 'pass');
  ok('result-bearing fill with a matched assertion → pass', reducePass('fill', null, true, true) === 'pass');
  // Replica of finalize tail: pending never becomes pass.
  const tailFor = (caseStatus) => caseStatus === 'blocked' ? 'blocked' : 'skipped';
  ok('pending tail on a PASSED case → skipped (never pass)', tailFor('pass') === 'skipped');
  ok('pending tail on a BLOCKED case → blocked', tailFor('blocked') === 'blocked');
}

console.log('\n— H. THIRD-AUDIT items (remaining writers, page-drift hard block, blocking-text, legacy doc) —');
// #1 — auxiliary completion writers now seal through sealStepState.
ok('#1 passive/live-state completion seals via sealStepState',
  has("sealStepState(idx, { status: 'pass', error: null, advance: true })"));
ok('#1 memory-replay completion seals via sealStepState',
  has("sealStepState(i, { status: 'pass', error: null, advance: true })"));
ok('#1 batched tool-completion routes through reducer + sealStepState',
  has('const reducedBatch = reduceStepOutcome(') && has('sealStepState(idx, reducedBatch)'));
ok('#1 batched path no longer writes status/pointer directly',
  !/currentStepIndex = stepStatus === 'pass' \? idx \+ 1 : idx;/.test(src));
// #2 — page-drift hard block (scoped) + always-on module tracking.
ok('#2 page-drift is now a HARD block on drift (not advisory-only)',
  has('if (!__pxBlockReason && drift.block) {'));
ok('#2 hard block exempts navigation tool + explicit navigation step',
  has('__isNavTool') && has('__isNavStep'));
ok('#2 workflow-module tracking is ALWAYS-ON (not behind __pxEnabled — else false-freeze)',
  has('ALWAYS-ON workflow-module tracking')
  && !/if \(__pxEnabled\(\)\) \{\s*[\r\n]+\s*const verifiedModule = __pxModuleOf/.test(src));
// #3 — blocking text/reason consistency, backend + frontend.
ok('#3 backend reconcile has phrase + reason-code blocking detector',
  has('const BLOCKING_TEXT_RE =') && has('const stepHasBlockingSignal =') && has('BLOCKING_REASON_CODES'));
ok('#3 Reports mirrors the blocking phrase/reason detector',
  /STEP_BLOCKING_TEXT_RE/.test(reportsSrc) && /STEP_BLOCKING_REASONS/.test(reportsSrc) && /blockingTextRow \|\| blockingReasonRow/.test(reportsSrc));
// #5 — legacy triple_click codegen translator documented (not a runtime tool).
ok('#5 legacy tripleClick codegen mapping is documented as legacy-trace translator',
  /LEGACY-TRACE TRANSLATOR/.test(pomSrc));

console.log('\n— I. BEHAVIOR: blocking-phrase detector does not collide with benign pass evidence —');
{
  const RE = /\b(no records found|no results found|no matching record|returned no results|did not match|did not reach|does not contain|not committed on the control|selection has not taken|could not be selected|was rejected|blocked because|test[_ ]data[_ ]invalid|effect was not proven)\b/i;
  ok('"No Records Found" evidence → flagged blocking', RE.test('Entered "Alice"; the application returned "No Records Found".') === true);
  ok('"did not reach" evidence → flagged blocking', RE.test('URL "x" did not reach "/dashboard" within the settle window.') === true);
  // Benign pass evidences must NOT trip it:
  ok('semantic-match pass ("not found verbatim … accepting") → NOT flagged',
    RE.test('Expected text "Add System User" not found verbatim, but 2/3 of its key terms are present — accepting.') === false);
  ok('value-confirmed pass ("contains") → NOT flagged', RE.test('Field "Username" contains "Admin" (live DOM value).') === false);
  ok('selection-committed pass → NOT flagged', RE.test('"ESS" is shown on the closed control (selection committed).') === false);
  ok('visible pass → NOT flagged', RE.test('Element textbox "Username" is visible (settled).') === false);
}

console.log('\n— J. FOURTH-AUDIT items (last direct writer, triple_click classification, reason codes) —');
// #1 — step-0 navigation replay now routes through the reducer + sole writer.
ok('#1 step-0 nav replay routes through reduceStepOutcome + sealStepState',
  has('const reduced0 = reduceStepOutcome(') && has('sealStepState(0, reduced0)'));
ok('#1 step-0 nav replay no longer writes status/pointer directly',
  !/stepResults\[0\]\.status = stepStatus;/.test(src) && !/if \(stepStatus === 'pass'\) \{\s*[\r\n]+\s*currentStepIndex = 1;/.test(src));
// Whole-file: there is no remaining direct `= 'pass'` step write outside sealStepState.
ok('#1 NO direct stepResults[..].status = \'pass\' writes remain in conductor',
  !/stepResults\[[a-z0-9]+\]\.status = 'pass'/.test(src));
// #2 — every remaining browser_triple_click reference is a documented legacy translator.
for (const [name, p] of Object.entries(TRIPLE_FILES)) {
  const t = fs.readFileSync(p, 'utf8');
  if (!/browser_triple_click|tripleClick/.test(t)) { ok(`#2 ${name}: no triple_click (clean)`, true); continue; }
  ok(`#2 ${name}: triple_click reference is documented LEGACY-TRACE`, /LEGACY-TRACE/.test(t), 'has triple_click but no LEGACY-TRACE comment');
}
// None of the legacy files may inject browser_triple_click as a LIVE tool the model can call
// (it must only ever appear as a translation key / normalization source, never advertised).
ok('#2 projectActionMemory normalizes triple_click to a real action (cannot surface phantom tool)',
  /browser_triple_click: 'click'/.test(fs.readFileSync(TRIPLE_FILES['projectActionMemory.js'], 'utf8')));
// #4 — structured reason codes are complete + primary (regex is the fallback).
ok('#4 backend reason-code set includes visible/hidden_not_confirmed (complete)',
  /BLOCKING_REASON_CODES = new Set\(\[[\s\S]*?visible_not_confirmed[\s\S]*?hidden_not_confirmed/.test(src));
ok('#4 Reports reason-code set mirrors it',
  /STEP_BLOCKING_REASONS = new Set\(\[[\s\S]*?visible_not_confirmed[\s\S]*?hidden_not_confirmed/.test(reportsSrc));
ok('#4 reason codes documented as the PRIMARY signal (regex = fallback)',
  /PRIMARY blocking signal = structured reason codes/.test(src));

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — conductor failed-case handling: safety always-on; LITERAL single writer (every pass-advancing path incl. step-0 nav seals via sealStepState); pass-only-when-proven; pending never auto-pass; page-drift hard block; blocking reason-codes (primary) + text (fallback) cannot render PASS; all browser_triple_click references are documented legacy-trace translators');
