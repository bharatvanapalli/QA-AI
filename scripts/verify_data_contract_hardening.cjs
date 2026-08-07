'use strict';
/*
 * Permanent DB/data-contract hardening guard.
 *
 * Covers the failures found in the OrangeHRM DB audit:
 *   - AuthProfiles rows must not inherit scenario/shouldSubmit/attackType from
 *     other sheets that merely share username.
 *   - Credential companion join still works for expectation sheets.
 *   - Legacy approved bad bindings are blocked before browser execution.
 *   - Mixed-outcome "all rows" bindings require either case-intent scoping or an
 *     explicit matrix/per-row case.
 *   - Malformed must PAGE assertions are detectable pre-run.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const tdm = require(path.join(ROOT, 'server', 'services', 'testDataMatrix'));
const declaredAssertions = require(path.join(ROOT, 'server', 'lib', 'declaredAssertions'));

let fail = 0;
const ok = (label, cond, detail) => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  <<< ${detail || ''}`}`);
};

const mapping = {
  bindings: [
    {
      sheet: 'AuthProfiles',
      purpose: 'auth_profiles',
      columnToField: { role: 'authRole', username: 'username', password: 'password' },
      expectedColumn: 'expectedLandingPage',
      rowClassColumn: 'authRole',
    },
    {
      sheet: 'FormValidation',
      purpose: 'form_validation',
      columnToField: { scenario: 'scenario', username: 'usernameInput', password: 'passwordInput', shouldSubmit: 'shouldSubmit' },
      expectedColumn: 'expectedValidationError',
      rowClassColumn: 'scenario',
    },
    {
      sheet: 'SecurityAuth',
      purpose: 'security',
      columnToField: { attackType: 'attackType', username: 'usernamePayload', password: 'passwordPayload', shouldCrash: 'shouldCrash' },
      expectedColumn: 'expectedOutcome',
      rowClassColumn: 'attackType',
    },
    {
      sheet: 'RoleAccessControl',
      purpose: 'access_control',
      columnToField: { role: 'role', username: 'username', menuItemShouldExist: 'menuItemShouldExist', menuItemShouldBeHidden: 'menuItemShouldBeHidden' },
      expectedColumn: 'menuItemShouldExist',
      rowClassColumn: 'role',
    },
  ],
};

const testData = {
  mapping,
  sheets: [
    {
      name: 'AuthProfiles',
      headers: ['authRole', 'username', 'password', 'expectedLandingPage'],
      rows: [
        { authRole: 'admin', username: 'Admin', password: 'admin123', expectedLandingPage: '/web/index.php/dashboard/index' },
        { authRole: 'ess', username: 'ess_user_01', password: 'TestUser@123', expectedLandingPage: '/web/index.php/dashboard/index' },
      ],
    },
    {
      name: 'FormValidation',
      headers: ['scenario', 'usernameInput', 'passwordInput', 'expectedValidationError', 'shouldSubmit'],
      rows: [
        { scenario: 'emptyPassword', usernameInput: 'Admin', passwordInput: '', expectedValidationError: 'Password is required', shouldSubmit: 'No' },
        { scenario: 'validAdminInputs', usernameInput: 'Admin', passwordInput: 'admin123', expectedValidationError: '', shouldSubmit: 'Yes' },
      ],
    },
    {
      name: 'SecurityAuth',
      headers: ['attackType', 'usernamePayload', 'passwordPayload', 'expectedOutcome', 'shouldCrash'],
      rows: [
        { attackType: 'passwordNotMasked', usernamePayload: 'Admin', passwordPayload: 'admin123', expectedOutcome: 'Password is masked', shouldCrash: 'No' },
      ],
    },
    {
      name: 'RoleAccessControl',
      headers: ['role', 'username', 'menuItemShouldExist', 'menuItemShouldBeHidden'],
      rows: [
        { role: 'admin', username: 'Admin', menuItemShouldExist: 'Admin,PIM,Leave', menuItemShouldBeHidden: 'None' },
      ],
    },
  ],
};

console.log('-- A. no implicit cross-sheet contamination --');
{
  const tc = {
    name: 'Admin login redirects to dashboard',
    assertions: 'Valid admin reaches dashboard',
    declaredAssertions: JSON.stringify([{ type: 'PAGE', criticality: 'must', payload: { expectedSignals: { url: ['/dashboard'] } } }]),
    dataBindingJson: JSON.stringify({ sheet: 'AuthProfiles', rowSelector: 'admin' }),
  };
  const rows = tdm.resolveCaseRows(tc, { name: 'Admin login', module: 'Authentication' }, testData);
  const inputs = rows[0] && rows[0].inputs;
  ok('AuthProfiles resolves exactly one admin row', rows.length === 1, `got ${rows.length}`);
  ok('AuthProfiles row keeps own credential fields', inputs && inputs.username === 'Admin' && inputs.password === 'admin123', JSON.stringify(inputs));
  ok('AuthProfiles row does NOT inherit FormValidation scenario', inputs && !Object.prototype.hasOwnProperty.call(inputs, 'scenario'), JSON.stringify(inputs));
  ok('AuthProfiles row does NOT inherit shouldSubmit=No', inputs && !Object.prototype.hasOwnProperty.call(inputs, 'shouldSubmit'), JSON.stringify(inputs));
  ok('AuthProfiles row does NOT inherit SecurityAuth attackType', inputs && !Object.prototype.hasOwnProperty.call(inputs, 'attackType'), JSON.stringify(inputs));
}

console.log('\n-- B. narrow credential companion join still works --');
{
  const tc = {
    name: 'Admin role access menu matrix',
    assertions: 'Admin role sees allowed menus',
    dataBindingJson: JSON.stringify({ sheet: 'RoleAccessControl', rowSelector: 'admin' }),
  };
  const rows = tdm.resolveCaseRows(tc, { name: 'Role access control', module: 'Authentication' }, testData);
  const inputs = rows[0] && rows[0].inputs;
  ok('RoleAccessControl resolves one admin row', rows.length === 1, `got ${rows.length}`);
  ok('Credential join imports password only from AuthProfiles', inputs && inputs.username === 'Admin' && inputs.password === 'admin123', JSON.stringify(inputs));
  ok('Credential join does not import AuthProfiles expectedLandingPage', inputs && !Object.prototype.hasOwnProperty.call(inputs, 'expectedLandingPage'), JSON.stringify(inputs));
}

console.log('\n-- C. legacy bad bindings block before browser --');
{
  const negAuthProfiles = {
    name: 'Invalid password - correct username rejected',
    credentialHint: 'invalid',
    declaredAssertions: JSON.stringify([{ type: 'PAGE', criticality: 'must', payload: { expectedSignals: { text: ['Invalid credentials'] } } }]),
    dataBindingJson: JSON.stringify({ sheet: 'AuthProfiles' }),
  };
  const defect = tdm.validateCaseDataBinding(negAuthProfiles, { name: 'Negative Authentication', module: 'Authentication' }, testData);
  ok('negative case bound to AuthProfiles is a data_binding_intent_mismatch', defect && defect.code === 'data_binding_intent_mismatch', JSON.stringify(defect));

  const incomplete = {
    name: 'Generated bad case',
    dataBindingJson: JSON.stringify({ sheet: 'MissingSheet', status: 'incomplete', findings: [{ code: 'data_binding_sheet_not_found', detail: 'sheet missing' }] }),
  };
  const defect2 = tdm.validateCaseDataBinding(incomplete, { name: 'Any' }, testData);
  ok('legacy dataBinding.status=incomplete blocks pre-run', defect2 && defect2.code === 'data_binding_sheet_not_found', JSON.stringify(defect2));

  const corruptedHeader = {
    name: 'NegativeAuth row 1 — {{scenario}}: login rejected with {{expected}}',
    credentialHint: 'invalid',
    dataBindingJson: JSON.stringify({
      sheet: 'FormValidation',
      rowSelector: 'all',
      columnToField: { scenario: 'scenario', username: 'usernameInput', password: '{{password}}Input' },
      expectedColumn: 'expectedValidationError',
      rowClassColumn: 'scenario',
    }),
  };
  const defect3 = tdm.validateCaseDataBinding(corruptedHeader, { name: 'Form Validation', module: 'Authentication' }, testData);
  ok('token-corrupted binding header blocks before row fan-out', defect3 && defect3.code === 'data_binding_column_corrupted', JSON.stringify(defect3));

  const missingHeader = {
    name: 'Generated bad binding',
    dataBindingJson: JSON.stringify({
      sheet: 'FormValidation',
      columnToField: { username: 'missingUsernameColumn' },
    }),
  };
  const defect4 = tdm.validateCaseDataBinding(missingHeader, { name: 'Form Validation', module: 'Authentication' }, testData);
  ok('missing binding header blocks before browser', defect4 && defect4.code === 'data_binding_column_not_found', JSON.stringify(defect4));
}

console.log('\n-- D. mixed all-row bindings require matrix/scoped intent --');
{
  const singlePurpose = {
    name: 'Password field masks input as bullets',
    assertions: 'Password should be masked',
    dataBindingJson: JSON.stringify({ sheet: 'FormValidation', rowSelector: 'all' }),
  };
  const defect = tdm.validateCaseDataBinding(singlePurpose, { name: 'Form Validation', module: 'Authentication' }, testData);
  ok('single-purpose case cannot silently run all mixed FormValidation rows', defect && defect.code === 'data_binding_mixed_rows_without_scope', JSON.stringify(defect));

  const matrixCase = {
    name: 'Data-driven form validation matrix',
    assertions: 'Run each row in the validation matrix',
    dataBindingJson: JSON.stringify({ sheet: 'FormValidation', rowSelector: 'all' }),
  };
  const defect2 = tdm.validateCaseDataBinding(matrixCase, { name: 'Form Validation', module: 'Authentication' }, testData);
  ok('explicit matrix case may run all scoped rows', !defect2, JSON.stringify(defect2));
}

console.log('\n-- E. malformed hard PAGE assertions are detectable --');
{
  const bad = [{
    id: 'ASN-bad',
    type: 'PAGE',
    criticality: 'must',
    payload: { pageName: '{{expectedValidationError}}', expectedSignals: { text: ['Required'] } },
  }];
  const issues = declaredAssertions.findMalformedMustAssertions(bad);
  ok('must PAGE with unresolved pageName is malformed', issues.length === 1 && issues[0].issue === 'page_assertion_unresolved_token', JSON.stringify(issues));

  const soft = [{ ...bad[0], criticality: 'should' }];
  ok('soft malformed PAGE is not a hard pre-run block', declaredAssertions.findMalformedMustAssertions(soft).length === 0);
}

console.log('');
if (fail) {
  console.log(`FAILED - ${fail} assertion(s)`);
  process.exit(1);
}
console.log('OK - DB/data-contract hardening prevents cross-sheet contamination, blocks legacy bad bindings, preserves credential joins, and detects malformed hard assertions.');
