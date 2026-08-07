'use strict';
/*
 * GUARD: click TARGET-IDENTITY gate (pipelineContract.clickTargetMatchesStep).
 *
 * Root it locks down (run e8307486): the conductor accepted ANY browser_click as
 * completing a click step (tool-class only), so clicking the "Username" textbox
 * satisfied "Click the Dashboard menu link" and the step wrongly advanced. The gate
 * now proves the acted-on element's IDENTITY matches the step's resolved target/value.
 */
const path = require('path');
const pc = require(path.join(__dirname, '..', 'server', 'services', 'pipelineContract.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('PASS ' + m); pass++; } else { console.log('FAIL ' + m); fail++; } };

// The exact reported bug: data-driven "Click left-menu link" with value "Dashboard",
// agent clicks the Username textbox → MUST be rejected.
const navStep = { action: 'Click', target: 'Left-menu link', value: 'Dashboard' };
ok(pc.clickTargetMatchesStep(navStep, { element: 'Username textbox' }).matched === false,
  'clicking "Username textbox" does NOT satisfy Click left-menu link value=Dashboard');
ok(pc.clickTargetMatchesStep(navStep, { element: 'Dashboard' }).matched === true,
  'clicking "Dashboard" satisfies the Dashboard menu step');
ok(pc.clickTargetMatchesStep(navStep, { element: 'PIM menu link' }).matched === false,
  'clicking the wrong menu item (PIM) does NOT satisfy the Dashboard step');

// No concrete value → match on the target noun.
const loginStep = { action: 'Click', target: 'Login button' };
ok(pc.clickTargetMatchesStep(loginStep, { element: 'Login' }).matched === true,
  'clicking "Login" satisfies "Click Login button"');
ok(pc.clickTargetMatchesStep(loginStep, { element: 'Username field' }).matched === false,
  'clicking "Username field" does NOT satisfy "Click Login button"');

// Generic nouns alone (link/button/field/menu) must NOT be treated as identity: two
// controls that share ONLY "button" are still different elements.
ok(pc.clickTargetMatchesStep({ action: 'Click', target: 'Save button' }, { element: 'Cancel button' }).matched === false,
  'shared generic noun ("button") alone is not a match — Save ≠ Cancel');
// A target with NO distinguishing token (all generic nouns) and no value cannot be
// judged → not over-blocked (identity must come from the value or a real noun).
ok(pc.clickTargetMatchesStep({ action: 'Click', target: 'Left-menu link' }, { element: 'Some other link' }).matched === true,
  'value-less all-generic target is not judged (identity comes from {{value}} in practice)');

// Do NOT over-block when we cannot judge (no tool label / no step identity).
ok(pc.clickTargetMatchesStep(navStep, {}).matched === true, 'no tool element label → not judged (no over-block)');
ok(pc.clickTargetMatchesStep({ action: 'Click' }, { element: 'Anything' }).matched === true, 'step with no identity text → not judged (no over-block)');

// Multi-word target still matches on a distinguishing token.
ok(pc.clickTargetMatchesStep({ action: 'Click', target: 'Assign Leave quick launch shortcut' }, { element: 'Assign Leave' }).matched === true,
  'clicking "Assign Leave" satisfies the Assign Leave shortcut step');
ok(pc.clickTargetMatchesStep({ action: 'Click', target: 'Assign Leave quick launch shortcut' }, { element: 'My Info' }).matched === false,
  'clicking "My Info" does NOT satisfy the Assign Leave shortcut step');

console.log('───────────────────────────────────────────────');
if (fail) { console.log(`RESULT: RED — ${fail} failed, ${pass} passed.`); process.exit(1); }
console.log(`RESULT: GREEN — ${pass} assertions passed (click target-identity gate).`);
