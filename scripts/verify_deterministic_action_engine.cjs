'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const enginePath = path.join(ROOT, 'server', 'services', 'agents', 'deterministicActionEngine.js');
const conductorPath = path.join(ROOT, 'server', 'services', 'agents', 'conductor.js');
const engine = require(enginePath);
const conductor = fs.readFileSync(conductorPath, 'utf8');

let fail = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  <<< ${detail}`}`);
};

console.log('-- Deterministic Action Engine --');

ok('engine exports the primary deterministic policy functions',
  ['stepKind', 'targetLabel', 'stepValue', 'buildToolCall', 'readbackDisposition', 'isSensitiveTarget']
    .every((name) => typeof engine[name] === 'function'));

ok('fill step classification is deterministic',
  engine.stepKind({ action: 'Fill', element: 'Username field' }) === 'fill');
ok('click step classification includes Save-style verbs',
  engine.stepKind({ action: 'Save', element: 'Save button' }) === 'click');
ok('navigate step classification is deterministic',
  engine.stepKind({ action: 'Navigate', element: 'PIM Add Employee page', value: 'https://example.test/pim/addEmployee' }) === 'navigate');
ok('select step classification is deterministic',
  engine.stepKind({ action: 'Select', element: 'Status dropdown' }) === 'select');

const fillCall = engine.buildToolCall({ kind: 'fill', label: 'First Name field', value: 'QAAI', ref: 'e10' });
ok('fill tool call uses browser_fill_form with complete field schema',
  fillCall.toolName === 'browser_fill_form'
    && fillCall.args.fields[0].target === 'e10'
    && fillCall.args.fields[0].text === 'QAAI'
    && fillCall.args.fields[0].value === 'QAAI');

const clickCall = engine.buildToolCall({ kind: 'click', label: 'Save button', ref: 'e20' });
ok('click tool call uses browser_click with readable element plus ref',
  clickCall.toolName === 'browser_click' && clickCall.args.element === 'Save button' && clickCall.args.target === 'e20');

const navigateCall = engine.buildToolCall({ kind: 'navigate', label: 'PIM Add Employee page', value: 'https://example.test/pim/addEmployee' });
ok('navigate tool call uses browser_navigate with url',
  navigateCall.toolName === 'browser_navigate' && navigateCall.args.url === 'https://example.test/pim/addEmployee');

const selectCall = engine.buildToolCall({ kind: 'select', label: 'Status dropdown', value: 'Enabled', ref: 'e30' });
ok('select tool call uses browser_select_option with values[]',
  selectCall.toolName === 'browser_select_option'
    && selectCall.args.element === 'Status dropdown'
    && selectCall.args.target === 'e30'
    && selectCall.args.values[0] === 'Enabled');

ok('confirmed readback passes',
  engine.readbackDisposition({ label: 'First Name field', value: 'QAAI', readback: 'confirmed' }).status === 'pass');
ok('unknown non-sensitive readback does not hard-block after accepted dispatch',
  engine.readbackDisposition({ label: 'First Name field', value: 'QAAI', readback: 'unknown' }).kind === 'input_value_dispatched');
ok('mismatch readback blocks',
  engine.readbackDisposition({ label: 'First Name field', value: 'QAAI', readback: 'mismatch' }).status === 'blocked');
ok('masked password readback passes without literal exposure',
  engine.isSensitiveTarget('Password field')
    && engine.readbackDisposition({ label: 'Password field', value: 'admin123', readback: 'unknown', sensitive: true }).kind === 'masked_input_accepted');

ok('conductor imports the deterministic action engine',
  conductor.includes("require('./deterministicActionEngine')"));
ok('conductor asks the engine for step kind instead of only local fill/click checks',
  conductor.includes('deterministicActionEngine.stepKind(step, pipelineContract)'));
ok('conductor uses the engine readback disposition',
  conductor.includes('deterministicActionEngine.readbackDisposition'));
ok('conductor deterministic kernel handles select steps before the model loop',
  conductor.includes("kernelKind === 'select'") && conductor.includes('no_select_effect_oracle'));
ok('conductor deterministic kernel handles navigate steps before the model loop',
  conductor.includes("kernelKind === 'navigate'") && conductor.includes('no_navigate_effect_oracle'));
ok('conductor builds deterministic tool calls through the engine',
  conductor.includes('deterministicActionEngine.buildToolCall'));

console.log('');
if (fail) {
  console.log(`FAILED - ${fail} assertion(s)`);
  process.exit(1);
}
console.log('OK - deterministic action policy is centralized and wired into the conductor hot path.');
