'use strict';

const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (label, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  <<< ${detail || ''}`}`);
};

const conductorPath = path.join(__dirname, '../server/services/agents/conductor.js');
const conductor = fs.readFileSync(conductorPath, 'utf8');
const actionEnginePath = path.join(__dirname, '../server/services/agents/deterministicActionEngine.js');
const actionEngine = fs.readFileSync(actionEnginePath, 'utf8');

console.log('— execution hot-path checks —');
ok('inline ReplayIR repair is opt-in, not the default between rows/cases',
  conductor.includes('QAAI_INLINE_REPLAY_REPAIR')
    && conductor.includes('inlineReplayRepairEnabled')
    && /envelope\.complete === false && mcpSession && inlineReplayRepairEnabled && !deferInlineCodegen/.test(conductor));

ok('inline codegen/export is opt-in, not part of the default live execution hot path',
  conductor.includes('QAAI_INLINE_CODEGEN')
    && conductor.includes('inlineCodegenEnabled')
    && /else if \(inlineCodegenEnabled && \(status === 'pass' \|\| status === 'fail' \|\| status === 'blocked'\) && provider\)/.test(conductor));

ok('visual regression is opt-in, not run after every live case by default',
  conductor.includes('QAAI_VISUAL_REGRESSION')
    && /const visual = envFlagOn\('QAAI_VISUAL_REGRESSION'\)\s*\?\s*await analyseVisualRegression/.test(conductor));

ok('live frame capture is non-blocking by default on the execution hot path',
  conductor.includes('QAAI_BLOCKING_LIVE_FRAMES')
    && conductor.includes('Execution must not wait for live-frame capture by default')
    && conductor.includes("blocking: forceCapture")
    && conductor.includes("skipIfBusy: !forceCapture"));

ok('fill steps have a default-on pre-model fast path, so password fields do not wait for an LLM turn when resolvable',
  conductor.includes('QAAI_DISABLE_FAST_FILL_PREMODEL')
    && /runDeterministicKernelStep = async \(\{ fillOnly = false \} = \{\}\)/.test(conductor)
    && /await drainDeterministicKernel\(\{ fillOnly: true, source: 'Fast fill path' \}\)/.test(conductor));

ok('Fill/Click deterministic kernel is default-on, with env escape hatch only',
  conductor.includes('QAAI_DISABLE_DETERMINISTIC_STEP_KERNEL')
    && conductor.includes('const deterministicStepKernelEnabled = !envFlagOn')
    && /await drainDeterministicKernel\(\{ fillOnly: false, source: 'Deterministic step kernel' \}\)/.test(conductor));

ok('clicks followed by a Verify step do not burn model turns or block for missing inline effect',
  conductor.includes('kernelNextStepVerifiesEffect')
    && conductor.includes('click_dispatched_next_step_verifies')
    && conductor.includes('the following Verify step owns the outcome proof'));

ok('deterministic Fill/Click kernel re-enters before each model turn, not only before turn zero',
  conductor.includes('Pre-turn deterministic action drain')
    && conductor.includes("source: 'Pre-turn deterministic step kernel'")
    && conductor.includes('prevents helper-only actions such as triple-click from replacing Fill'));

ok('masked sensitive fills do not hard-block on literal value readback',
  conductor.includes('deterministicActionEngine.readbackDisposition')
    && actionEngine.includes('masked_input_accepted')
    && conductor.includes('expected: disposition.expected'));

ok('non-sensitive fills do not hard-block on unknown readback after accepted dispatch',
  actionEngine.includes('value_dispatched_readback_unknown')
    && actionEngine.includes('input_value_dispatched')
    && conductor.includes('readbackDisposition'));

ok('the internal output-preparation live message is only emitted when inline repair is explicitly enabled',
  /if \(inlineReplayRepairEnabled\)\s*\{\s*send\?\.\(\{\s*type: 'agent\.phase\.log'[\s\S]{0,260}Output preparation updated from live fulfillment evidence/.test(conductor));

ok('positive result/list/table expectations cannot pass page_ready when the page shows an empty result state',
  conductor.includes('empty_result_contradicts_expected_row')
    && conductor.includes('expectsPositiveResultSurface')
    && conductor.includes('emptyResultText'));

ok('navigate/click timeouts are salvaged by post-timeout state proof before failure or session restart',
  conductor.includes('recoverTimeoutActionIfStateReached')
    && conductor.includes("['browser_navigate', 'browser_click'].includes(toolName)")
    && conductor.includes('timeoutRecoveredInlineRecorded')
    && conductor.includes('post-timeout state proof')
    && conductor.indexOf('recoverTimeoutActionIfStateReached({') < conductor.indexOf('if (!quarantined && result.isError')
    && conductor.includes('if (!trailEntry.timeoutRecoveredInlineRecorded)'));

ok('Save/navigation command outcomes use generic observable effect proof before falling back to page-ready text heuristics',
  conductor.includes("require('../postActionEffectProof')")
    && conductor.includes('const effectProof = proveEffect({')
    && conductor.includes("evidenceSource: urlOk ? 'url_readback' : effectMatched")
    && conductor.includes('observable effect detected')
    && conductor.indexOf('const effectProof = proveEffect({') < conductor.indexOf('const probed = operationSnapshotProbe({ kind: \'page_ready\''));

console.log('');
if (fail) {
  console.log(`FAILED — ${fail} assertion(s)`);
  process.exit(1);
}
console.log('OK — execution hot path avoids inline export repair and rejects empty-result false passes');
