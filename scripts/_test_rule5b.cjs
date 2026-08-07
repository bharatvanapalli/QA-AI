'use strict';
const { sanitizeJsTs } = require('../server/services/codegen/_sanitize');

const cases = [
  ["const el = page.getByRole('button', { name: 'User profile dropdown in topbar' });", true, 'A: descriptor text in getByRole name'],
  ["const el = page.getByRole('textbox', { name: 'initialPassword' });", true, 'B: camelCase programmatic name'],
  ["const el = page.getByRole('textbox', { name: 'newPassword456' });", true, 'C: camelCase + digits'],
  ["const el = page.getByRole('button', { name: 'Save' });", false, 'D: normal short label (should pass through)'],
  ["const el = page.getByRole('link', { name: 'View All' });", false, 'E: two-word label (should pass through)'],
  ["const el = page.getByRole('textbox', { name: 'Username' });", false, 'F: single clean word (should pass through)'],
  ["const el = page.getByRole('button', { name: /save/i });", false, 'G: regex name (should pass through)'],
];

let fail = 0;
cases.forEach(([input, expectCaught, label]) => {
  const out = sanitizeJsTs(input);
  const caught = out.includes('QAAI_UNRESOLVED_LOCATOR');
  const ok = caught === expectCaught;
  console.log((ok ? '  PASS' : '  FAIL') + ' -- ' + label);
  if (!ok) {
    console.log('    in:  ' + input);
    console.log('    out: ' + out);
    fail++;
  }
});

console.log('');
console.log(fail === 0 ? 'ALL CHECKS PASSED' : 'FAILED: ' + fail + ' checks');
process.exit(fail > 0 ? 1 : 0);
