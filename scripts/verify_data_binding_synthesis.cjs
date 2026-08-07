#!/usr/bin/env node
/**
 * GUARD: deterministic parameterize-and-bind for uncovered VARIATION data sheets.
 * The LLM authors concrete cases with literal values; this pass must convert a
 * representative case into a data-driven one (input literals → {{role}} tokens) and
 * bind it to the sheet, so its rows are iterated. Pure identity sheets must NOT bind.
 *   node scripts/verify_data_binding_synthesis.cjs
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const tda = require('../server/services/testDataAuthoring');

let failures = 0;
const ok = (c, m) => { if (!c) { console.error('  ✗ ' + m); failures++; } else { console.log('  ✓ ' + m); } };

const testData = {
  sheets: [
    { name: 'NegativeAuth', headers: ['usernameInput', 'passwordInput', 'expectedErrorMessage'], rows: [
      { usernameInput: 'baduser', passwordInput: 'wrongpass', expectedErrorMessage: 'Invalid credentials' },
      { usernameInput: 'Admin', passwordInput: 'nope', expectedErrorMessage: 'Invalid credentials' },
      { usernameInput: ' ', passwordInput: ' ', expectedErrorMessage: 'Required' },
    ] },
    { name: 'AuthProfiles', headers: ['username', 'password', 'authRole'], rows: [
      { username: 'Admin', password: 'admin123', authRole: 'admin' },
    ] },
  ],
  mapping: {
    bindings: [
      { sheet: 'NegativeAuth', module: 'Authentication', columnToField: { username: 'usernameInput', password: 'passwordInput' }, expectedColumn: 'expectedErrorMessage', purpose: 'validation_cases' },
      { sheet: 'AuthProfiles', module: 'Authentication', columnToField: { username: 'username', password: 'password', role: 'authRole' }, purpose: 'auth_profiles' },
    ],
  },
};

// One concrete negative-login case (literal invented values), one ordinary case.
const scenarios = [{
  name: 'Invalid Credentials Handling', module: 'Authentication',
  cases: [
    { name: 'Login with invalid username shows error', steps: [
      { order: 1, action: 'Navigate', element: 'login page', value: 'https://app/auth/login' },
      { order: 2, action: 'Fill', element: 'Username textbox', value: 'someInvalidUser' },
      { order: 3, action: 'Fill', element: 'Password textbox', value: 'someWrongPass' },
      { order: 4, action: 'Click', element: 'Login button' },
      { order: 5, action: 'Verify', element: 'error', expected: 'Invalid credentials shown' },
    ] },
  ],
}];

const stats = tda.bindUncoveredDataSheets(scenarios, testData, {});
const c = scenarios[0].cases[0];
console.log('synthesized:', JSON.stringify(stats));
console.log('case.dataBinding:', JSON.stringify(c.dataBinding));
console.log('username step value:', c.steps[1].value, '| password step value:', c.steps[2].value);

ok(stats.synthesized === 1 && stats.sheets.includes('NegativeAuth'), 'NegativeAuth (variation sheet) got a synthesized binding');
ok(c.dataBinding && c.dataBinding.sheet === 'NegativeAuth', 'representative case is now bound to NegativeAuth');
ok(c.steps[1].value === '{{username}}', 'username fill literal → {{username}} token');
ok(c.steps[2].value === '{{password}}', 'password fill literal → {{password}} token');
ok(!stats.sheets.includes('AuthProfiles'), 'pure identity sheet (AuthProfiles) is NOT auto-bound');

// Iteration check: the bound case must now resolve all 3 NegativeAuth rows.
const tdm = require('../server/services/testDataMatrix');
const boundCase = { ...c, dataBindingJson: JSON.stringify(c.dataBinding) };
let rows = [];
try { rows = tdm.resolveCaseRows(boundCase, scenarios[0], testData, {}); } catch (e) { console.error('resolveCaseRows threw:', e.message); }
console.log('resolved rows:', rows.length, rows.map(r => JSON.stringify(r.inputs || r.fields || {})).join(' '));
ok(rows.length === 3, `bound case iterates all 3 NegativeAuth rows (got ${rows.length})`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
