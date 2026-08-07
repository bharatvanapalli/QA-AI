'use strict';

/*
 * Deterministic Step Kernel Increment 1 source guard.
 *
 * This checks the real conductor hot path. Fill/Click/Select/Navigate must be the default
 * execution path; the model is only a fallback when deterministic control
 * resolution cannot identify the element.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const conductorPath = path.join(ROOT, 'server', 'services', 'agents', 'conductor.js');
const contractPath = path.join(ROOT, 'server', 'services', 'pipelineContract.js');
const enginePath = path.join(ROOT, 'server', 'services', 'agents', 'deterministicActionEngine.js');
const conductor = fs.readFileSync(conductorPath, 'utf8');
const contract = fs.readFileSync(contractPath, 'utf8');
const engine = fs.readFileSync(enginePath, 'utf8');

let fail = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  <<< ${detail}`}`);
};

console.log('-- Deterministic Step Kernel Increment 1 --');

const drainIdx = conductor.indexOf("await drainDeterministicKernel({ fillOnly: false, source: 'Deterministic step kernel' })");
const llmIdx = conductor.indexOf('const anthropicTools = mcp.listAnthropicTools');
ok('deterministic Fill/Click kernel is default-on with an explicit disable escape hatch',
  conductor.includes('QAAI_DISABLE_DETERMINISTIC_STEP_KERNEL')
    && conductor.includes('const deterministicStepKernelEnabled = !envFlagOn'));
ok('default deterministic Fill/Click drain remains before the LLM tool loop', drainIdx > 0 && llmIdx > drainIdx);

ok('Fill kernel dispatches supported browser_fill_form through the deterministic action engine, not model-selected browser_type',
  conductor.includes('deterministicActionEngine.toolNameForKind(kernelKind)')
    && conductor.includes('deterministicActionEngine.buildToolCall({ kind: kernelKind'));
ok('Kernel rejects typeable/clickable refs whose accessible identity does not match the approved step target',
  conductor.includes('kernelRefMatchesTargetIdentity')
    && conductor.includes("reason: 'accessible_name_mismatch'")
    && conductor.includes('if (identity.matched) return ref'));
ok('Fill kernel sends a complete MCP browser_fill_form field schema',
  engine.includes("fields: [{ name: label, element: label, type: 'textbox', target: ref, text: String(value == null ? '' : value), value: String(value == null ? '' : value) }]"));
ok('Fill kernel performs exact readback by name',
  conductor.includes('confirmInputValueByName({ fieldName: label, intendedValue: value'));
ok('Fill kernel performs DOM readback fallback',
  conductor.includes('confirmInputValueViaDom({ fieldName: label, intendedValue: value'));
ok('Fill kernel blocks only confirmed mismatches; unknown readback after accepted dispatch may continue',
  engine.includes('value_dispatched_readback_unknown')
    && engine.includes('input_value_dispatched')
    && engine.includes('later page/outcome checks prove the workflow'));
ok('masked sensitive fills do not hard-block on literal value readback',
  conductor.includes('deterministicActionEngine.readbackDisposition')
    && engine.includes('masked_input_accepted')
    && engine.includes('Sensitive field'));
ok('Fill resolve failure uses controlled DOM label fill instead of handing the step back to the model',
  conductor.includes('deterministicDomFillByLabel')
    && conductor.includes('deterministic_dom_fill')
    && conductor.includes('QAAI will not let the model guess a different field'));
ok('DOM-label fill does not use whole ancestor text as field identity evidence',
  conductor.includes('Do NOT add the whole ancestor text')
    && !conductor.includes('for (let i = 0; cur && i < 4; i += 1, cur = cur.parentElement) {\n          add(cur);'));
ok('Fill operation-check sealing is shared for MCP fill and DOM-label fill',
  conductor.includes('sealFillKernelRecord')
    && conductor.includes("toolName: 'deterministic_dom_fill'"));
ok('Shared contract treats deterministic DOM fill as a first-class Fill completion tool',
  contract.includes("'deterministic_dom_fill'")
    && contract.includes("'deterministic_dom_fill_recovery'"));
ok('Step reducer treats deterministic DOM fill as a first-class Fill completion tool',
  conductor.includes("'deterministic_dom_fill'")
    && conductor.includes("'deterministic_dom_fill_recovery'")
    && conductor.includes('STEP_TOOLS_FOR_CLASS'));
ok('Fill tool errors recover through deterministic DOM label fill before blocking',
  conductor.includes("strategy: 'dom_label_fill_after_tool_error'")
    && conductor.includes('Deterministic engine recovered Fill')
    && conductor.includes("toolName: 'deterministic_dom_fill_recovery'"));
ok('Fill readback mismatch gets one deterministic DOM-label correction before blocking',
  conductor.includes("strategy: 'dom_label_fill_after_readback_mismatch'")
    && conductor.includes("reason: 'readback_mismatch'")
    && conductor.includes('Deterministic engine corrected Fill'));

ok('Click/Select kernel requires a declared effect oracle unless the next approved step is Verify',
  conductor.includes('kernelNextStepVerifiesEffect') && conductor.includes('has no effect oracle'));
ok('Click kernel records/verifies inline step expectation after click',
  conductor.includes('recordInlineStepExpectation({') && conductor.includes('declaredStep: step'));
ok('Shared contract treats deterministic DOM click as a first-class Click completion tool',
  contract.includes("'deterministic_dom_click'")
    && contract.includes("'deterministic_dom_click_recovery'"));
ok('Step reducer treats deterministic DOM click as a first-class Click completion tool',
  conductor.includes("'deterministic_dom_click'")
    && conductor.includes("'deterministic_dom_click_recovery'")
    && conductor.includes('STEP_TOOLS_FOR_CLASS'));
ok('Click resolve failure uses controlled DOM label click instead of model guessing',
  conductor.includes('deterministicDomClickByLabel')
    && conductor.includes('deterministic_dom_click')
    && conductor.includes('QAAI will not let the model click a different control'));
ok('Click tool errors recover through deterministic DOM label click before blocking',
  conductor.includes("strategy: 'dom_label_click_after_tool_error'")
    && conductor.includes('Deterministic engine recovered Click')
    && conductor.includes("toolName: 'deterministic_dom_click_recovery'"));
ok('Click kernel can delegate effect proof to the following Verify step',
  conductor.includes('click_dispatched_next_step_verifies')
    && conductor.includes('following Verify step owns the outcome proof'));
ok('Select kernel can run before the model and delegate proof to a following Verify step',
  conductor.includes("kernelKind === 'select'")
    && conductor.includes('select_dispatched_next_step_verifies')
    && conductor.includes('browser_select_option'));
ok('Shared contract treats deterministic DOM select as a first-class Select completion tool',
  contract.includes("'deterministic_dom_select'")
    && contract.includes("'deterministic_dom_select_recovery'"));
ok('Step reducer treats deterministic DOM select as a first-class Select completion tool',
  conductor.includes("'deterministic_dom_select'")
    && conductor.includes("'deterministic_dom_select_recovery'")
    && conductor.includes('STEP_TOOLS_FOR_CLASS'));
ok('Select resolve failure uses controlled DOM label select instead of model guessing',
  conductor.includes('deterministicDomSelectByLabel')
    && conductor.includes('deterministic_dom_select')
    && conductor.includes('QAAI will not let the model select a different control'));
ok('Select tool errors recover through deterministic DOM label select before blocking',
  conductor.includes("strategy: 'dom_label_select_after_tool_error'")
    && conductor.includes('Deterministic engine recovered Select')
    && conductor.includes("toolName: 'deterministic_dom_select_recovery'"));
ok('Navigate kernel can run before the model and recover timeout by state proof',
  conductor.includes("kernelKind === 'navigate'")
    && conductor.includes('browser_navigate')
    && conductor.includes('no_navigate_effect_oracle')
    && conductor.includes('recoverTimeoutActionIfStateReached({'));
ok('Click kernel blocks when no effect record exists and no Verify follows',
  conductor.includes('produced no checkable effect oracle'));
ok('Kernel re-enters before each model turn after navigation/passive drains',
  conductor.includes('Pre-turn deterministic action drain')
    && conductor.includes("source: 'Pre-turn deterministic step kernel'")
    && conductor.includes('prevents helper-only actions such as triple-click from replacing Fill'));
ok('Prompt builder does not clamp all-complete rows back to the last step',
  conductor.includes('currentStepIndex < approvedSteps.length')
    && conductor.includes('? Math.max(currentStepIndex, 0)')
    && conductor.includes(': -1'));
ok('Pre-turn deterministic drain updates the model with the new current step before any fallback call',
  conductor.includes('backend deterministic engine completed')
    && conductor.includes('Next required step is Step')
    && conductor.includes('All approved steps are complete; do not repeat the previous step'));

ok('Kernel terminal proof failure returns before the LLM can improvise past it',
  conductor.includes('deterministicKernelTerminalBlock')
    && conductor.includes('return { systemic: false, status, error, blockedReason, completedAllSteps: false, dirtyPage: true };'));
ok('Runtime contract fallback rebuilds metadata from current approved step',
  conductor.includes("schema: executionContract?.schema || 'runtime_rebuilt'")
    && conductor.includes("contractStepId: `runtime-step-${(Number(stepIndex) || 0) + 1}`"));
ok('Runtime contract fallback uses toolCanCompleteStep so Save/Add clicks are authorized from the actual step list',
  conductor.includes('pipelineContract.toolCanCompleteStep(toolName, declaredStep)'));
ok('LLM fallback has the same fill target identity proof as the kernel',
  conductor.includes('pipelineContract.fillTargetMatchesStep(currentApprovedStep, tu.input || {})')
    && conductor.includes('WRONG_FIELD_FOR_STEP'));
ok('Project memory cannot seal deterministic-owned steps before the executor',
  conductor.includes('deterministicOwnedKind = deterministicActionEngine.stepKind')
    && conductor.includes("['fill', 'click', 'select', 'navigate'].includes(deterministicOwnedKind)"));
ok('LLM fallback cannot pass deterministic-owned steps without the same proof record',
  conductor.includes('DETERMINISTIC_PROOF_REQUIRED')
    && conductor.includes("['fill', 'click', 'select', 'navigate'].includes(fallbackKind)")
    && conductor.includes('did not produce the required readback/effect proof'));

ok('Session profile is recorded only after a passed session-establishing row',
  conductor.includes("caseResult?.status === 'pass'"));
ok('Dirty non-pass data row recovers a clean session before the next row starts',
  conductor.includes('attempting fresh-session recovery before row')
    && conductor.includes("recoveryStrategy: 'fresh_session_before_next_data_row'"));

ok('Final verdict consumes passed step-level oracle proof before computeVerdict',
  conductor.includes('reconcileRecordedOutcomesWithStepOracle')
    && conductor.includes("source: 'step_oracle'")
    && conductor.includes('declaredAssertionStepProof')
    && conductor.indexOf('const stepOracleRepair = reconcileRecordedOutcomesWithStepOracle') > 0
    && conductor.indexOf('const stepOracleRepair = reconcileRecordedOutcomesWithStepOracle') < conductor.indexOf('verdict = computeVerdict({'));
ok('Step-oracle reconciliation only trusts passed steps with matched operation/assertion proof',
  conductor.includes("stepResult.status !== 'pass'")
    && conductor.includes("op?.matched !== true && assertion?.matched !== true")
    && conductor.includes('oracleTextMatches(stepHaystack, expectedText)'));

ok('Shared contract classifies Save/Create/Add/Delete/Edit/Open as click steps',
  /save\|create\|add\|delete\|remove\|edit\|open/.test(contract));
ok('Shared contract exposes fill target identity checks for model fallback',
  contract.includes('function fillTargetMatchesStep') && contract.includes('fillTargetMatchesStep,'));

console.log('');
if (fail) {
  console.log(`FAILED - ${fail} assertion(s)`);
  process.exit(1);
}
console.log('OK - deterministic Fill/Click kernel is default-on, proof-gated, and contract drift is rebuilt from the actual step list.');
