'use strict';
/*
 * P0 regression guard for testDataRuntimeLock — the runtime value-corruption bug.
 * The lock must force a value ONLY for an explicitly data-bound field ({{token}}
 * or columnToField), and PRESERVE concrete literals. It must never apply a login
 * row's username/password to unrelated fields by generic word match.
 */
const { lockToolInputToDataRow } = require('../server/services/testDataRuntimeLock');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

// The case's data row (AuthProfiles login row).
const dataRow = { fields: { username: 'Admin', password: 'admin123' } };
const typed = (label, value, declaredStep) => lockToolInputToDataRow({ toolName: 'browser_type', args: { element: label, text: value }, declaredStep, dataRow });

console.log('— PRESERVE concrete literals on unrelated forms (the P0 bug) —');
{
  // Employee Name = Alice (literal, not bound) must STAY Alice.
  const r1 = typed('Employee Name', 'Alice', { value: 'Alice', element: 'Employee Name' });
  ok('Employee Name "Alice" is NOT changed', r1.changed === false && (r1.args.text === 'Alice'), JSON.stringify(r1));
  // Add User username = qaai_ess_lifecycle_01 must STAY.
  const r2 = typed('Username', 'qaai_ess_lifecycle_01', { value: 'qaai_ess_lifecycle_01', element: 'Username' });
  ok('Add User username "qaai_ess_lifecycle_01" is NOT changed (was forced to Admin)', r2.changed === false && r2.args.text === 'qaai_ess_lifecycle_01', JSON.stringify(r2));
  // Add User Password = Lifecycle@2024 must STAY.
  const r3 = typed('Password', 'Lifecycle@2024', { value: 'Lifecycle@2024', element: 'Password' });
  ok('Add User Password "Lifecycle@2024" is NOT changed (was forced to admin123/Admin)', r3.changed === false && r3.args.text === 'Lifecycle@2024', JSON.stringify(r3));
  // Confirm Password literal preserved.
  const r4 = typed('Confirm Password', 'Lifecycle@2024', { value: 'Lifecycle@2024', element: 'Confirm Password' });
  ok('Confirm Password literal preserved', r4.changed === false && r4.args.text === 'Lifecycle@2024');
  // Search Username = qaai_ess_lifecycle_01 must STAY.
  const r5 = typed('Username', 'qaai_ess_lifecycle_01', { value: 'qaai_ess_lifecycle_01', element: 'Username (search filter)' });
  ok('Search Username "qaai_ess_lifecycle_01" is NOT changed', r5.changed === false && r5.args.text === 'qaai_ess_lifecycle_01');
}

console.log('\n— LEGIT lock: a {{token}} step binds to the current row —');
{
  // Login Username step authored as {{username}} → row Admin. Already Admin → stays Admin.
  const r6 = typed('Username', 'Admin', { value: '{{username}}', element: 'Username' });
  ok('Login Username Admin remains Admin (token bound, already correct)', (r6.changed === false || r6.args.text === 'Admin') && r6.args.text === 'Admin', JSON.stringify(r6));
  // Login Password {{password}} → admin123 stays.
  const r7 = typed('Password', 'admin123', { value: '{{password}}', element: 'Password' });
  ok('Login Password admin123 remains admin123 (token bound)', r7.args.text === 'admin123');
  // Token step where the model drifted to a wrong value → corrected to the row value.
  const r8 = typed('Username', 'wronguser', { value: '{{username}}', element: 'Username' });
  ok('token step DRIFT is corrected to row value (legit lock)', r8.changed === true && r8.args.text === 'Admin' && r8.to === 'Admin', JSON.stringify(r8));
  // columnToField mapping binds the step's field role.
  const r9 = lockToolInputToDataRow({ toolName: 'browser_type', args: { element: 'Username', text: 'x' }, dataRow, declaredStep: { element: 'Username', fieldRole: 'username', dataBinding: { isDataBound: true, columnToField: { username: 'username' } } } });
  ok('columnToField-bound field is locked to row value', r9.changed === true && r9.args.text === 'Admin');
}

console.log('\n— browser_fill_form: only {{token}} fields are bound, literals preserved —');
{
  const r = lockToolInputToDataRow({
    toolName: 'browser_fill_form',
    args: { fields: [
      { element: 'Username', value: '{{username}}' },     // bound
      { element: 'Employee Name', value: 'Alice' },        // literal -> preserve
      { element: 'New Password', value: 'Lifecycle@2024' }, // literal -> preserve
    ] },
    dataRow,
  });
  const byEl = Object.fromEntries(r.args.fields.map((f) => [f.element, f.value]));
  ok('token field -> row value', byEl['Username'] === 'Admin');
  ok('literal Employee Name preserved', byEl['Employee Name'] === 'Alice');
  ok('literal password preserved', byEl['New Password'] === 'Lifecycle@2024');
}

console.log('\n— never generic-word-matches an unrelated field —');
{
  // A field labelled "User Role" must NOT receive the username value by the old /user/ rule.
  const r = typed('User Role', 'ESS', { value: 'ESS', element: 'User Role' });
  ok('"User Role" literal "ESS" not overwritten by username', r.changed === false && r.args.text === 'ESS', JSON.stringify(r));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — testDataRuntimeLock P0 fixed: literals preserved, only explicit bindings locked');
