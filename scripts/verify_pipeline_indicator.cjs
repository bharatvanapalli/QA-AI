#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'components', 'AgentRunningIndicator.jsx'), 'utf8');

let pass = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  pass += 1;
  console.log(`✓ ${message}`);
}

ok(src.includes('const { subscribe, latestSummary, running } = useRunStream();'), 'indicator subscribes to terminal run summary state');
ok(src.includes('const summary = pipelineState?.runSummary || latestSummary;'), 'cancelling state has a terminal-summary backstop');
ok(src.includes("if (pipelineState?.cancelling || running || !summary) return;"), 'backstop waits only while a run is genuinely still active');
ok(src.includes("setStatus(cancelled ? 'cancelled' : 'complete');"), 'backstop exits cancelling into a terminal state');
ok(src.includes('}, 8_000);'), 'stale cancelling state self-dismisses when no terminal event can arrive');
ok(src.includes('if (!res?.cancelled && !res?.runId)'), 'no-active-run cancel response is detected');
ok(src.includes("setStatus('idle');") && src.includes('setDismissed(true);'), 'no-active-run cancel response dismisses the floating card');
ok(src.includes("toast.info('No active pipeline is running.'"), 'no-active-run cancel response explains the dismissal');

console.log(`PASS verify_pipeline_indicator (${pass} checks)`);
