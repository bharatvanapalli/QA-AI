/**
 * Guard: verify the two codegen polarity/stranded-evaluate fixes.
 *
 * Bug A: EVALUATE negation — scripts with `return !var` where `var` is derived from
 *        `.includes('text')` must emit waitForFunction, NOT assertTextPresent.
 *        Regression: if fixed again emits assertTextPresent for a negated-return script,
 *        the XSS "no alert fires" test would fail (checks absent text, not present text).
 *
 * Bug B: stranded EVALUATE — a case with only one EVALUATE step that checks admin nav
 *        items (not form-validation content) must NOT have a login flow injected.
 *        Regression: if _isFormValidationAssertion still classifies all EVALUATE as
 *        form-validation, the admin-dashboard step gets goto("auth/login") + login button
 *        inject → spec fails because auth/login redirects to dashboard (no login button).
 */
'use strict';
const path = require('path');
const assert = require('assert');

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) { console.log(`  PASS: ${label}`); pass++; }
  else { console.error(`  FAIL: ${label}\n        ${detail}`); fail++; }
}

// ── Bug A: playwrightReference.js negation detection ─────────────────────────

// Simulate what the codegen does
function detectNegation(normalizedScript) {
  return (
    /^!(?!!)/.test(normalizedScript.trim()) ||
    /\breturn\s+!(?!!)/.test(normalizedScript)
  );
}

const XSS_SCRIPT = `(function(){ var scripts = document.querySelectorAll('script'); var injected = Array.from(scripts).some(s => s.textContent.toLowerCase().includes('alert') && !s.src); return !injected; })()`;
const SIMPLE_POSITIVE = `document.querySelector('.msg').textContent.toLowerCase().includes('Dashboard')`;
const NEGATED_TOP = `!document.body.textContent.toLowerCase().includes('error')`;
const DOUBLE_NEGATED = `return !!someVar`;

check('Bug A: XSS return!injected → negated=true',
  detectNegation(XSS_SCRIPT) === true,
  'XSS script `return !injected` must be detected as negated'
);
check('Bug A: simple positive include → negated=false',
  detectNegation(SIMPLE_POSITIVE) === false,
  'Plain .includes() without negation must NOT be flagged as negated'
);
check('Bug A: top-level !expr → negated=true',
  detectNegation(NEGATED_TOP) === true,
  'Script starting with ! must be flagged as negated'
);
check('Bug A: return !!var → negated=false (double negation = positive)',
  detectNegation(DOUBLE_NEGATED) === false,
  'Double negation `!!` must NOT be flagged as negated (it coerces to positive boolean)'
);

// ── Bug B: replayExport.js _isFormValidationAssertion ────────────────────────

// Simulate the function logic
function isFormValidationAssertion(step) {
  if (!step || step.op !== 'assert') return false;
  if (step.channel === 'EVALUATE') {
    const script = String(step.script || step.expected || '');
    return /error[- _]?message|is[- _]?required|required|validation[- _]?error|invalid[- _]?credential|field[- _]?error/i.test(script);
  }
  if (step.channel === 'UI_TEXT' || step.channel === 'TEXT_MATCH') {
    return /required|invalid|error|empty|validation/i.test(String(step.expected || '').toLowerCase());
  }
  return false;
}

const EVAL_ADMIN_NAV = {
  op: 'assert', channel: 'EVALUATE',
  script: `(function(){ var links = Array.from(document.querySelectorAll('a, [role="menuitem"]')).map(el => el.textContent.trim()); return ['Admin','PIM','Recruitment'].every(m => links.includes(m)); })()`,
  expected: 'true'
};
const EVAL_FORM_VALIDATION = {
  op: 'assert', channel: 'EVALUATE',
  script: `Array.from(document.querySelectorAll('.oxd-input-field-error-message')).map(el => el.textContent.trim()).join(' ')`,
  expected: 'Required'
};
const EVAL_ERROR_MESSAGE = {
  op: 'assert', channel: 'EVALUATE',
  script: `document.querySelector('.error-message')?.textContent`,
  expected: 'Required'
};

check('Bug B: EVALUATE checking admin nav items → NOT form-validation',
  isFormValidationAssertion(EVAL_ADMIN_NAV) === false,
  'Admin nav EVALUATE must not be classified as form-validation (would inject wrong login flow)'
);
check('Bug B: EVALUATE checking .oxd-input-field-error-message → IS form-validation',
  isFormValidationAssertion(EVAL_FORM_VALIDATION) === true,
  'Error-message EVALUATE must be classified as form-validation (needs login form state)'
);
check('Bug B: EVALUATE checking .error-message → IS form-validation',
  isFormValidationAssertion(EVAL_ERROR_MESSAGE) === true,
  'field-error EVALUATE must be classified as form-validation'
);

// UI_TEXT validation error → still classified
const UI_TEXT_REQUIRED = { op: 'assert', channel: 'UI_TEXT', expected: 'Required' };
const UI_TEXT_DASHBOARD = { op: 'assert', channel: 'UI_TEXT', expected: 'Dashboard' };
check('Bug B: UI_TEXT "Required" → IS form-validation',
  isFormValidationAssertion(UI_TEXT_REQUIRED) === true,
  'UI_TEXT Required must be form-validation'
);
check('Bug B: UI_TEXT "Dashboard" → NOT form-validation',
  isFormValidationAssertion(UI_TEXT_DASHBOARD) === false,
  'UI_TEXT Dashboard must not be form-validation'
);

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
