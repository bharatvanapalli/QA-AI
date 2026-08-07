'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { buildDataLiteralRepairs, repairDataLiteralsInCase } = require(path.join(ROOT, 'server', 'lib', 'dataLiteralRepair'));
const testDataAuthoring = require(path.join(ROOT, 'server', 'services', 'testDataAuthoring'));
const tdm = require(path.join(ROOT, 'server', 'services', 'testDataMatrix'));

let fail = 0;
const ok = (label, cond, detail) => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  <<< ${detail || ''}`}`);
};

const testData = {
  mapping: {
    bindings: [
      {
        sheet: 'AuthProfiles',
        module: 'Authentication',
        purpose: 'auth_profiles',
        columnToField: { role: 'authRole', username: 'username', password: 'password' },
        expectedColumn: 'expectedLandingPage',
      },
      {
        sheet: 'NegativeAuth',
        module: 'Authentication',
        purpose: 'negative_auth',
        columnToField: {
          scenario: 'scenario',
          username: 'usernameInput',
          password: 'passwordInput',
          expected: 'expectedErrorMessage',
        },
        expectedColumn: 'expectedBehavior',
        rowClassColumn: 'scenario',
      },
      {
        sheet: 'SecurityAuth',
        module: 'Authentication',
        purpose: 'security',
        columnToField: { password: 'passwordPayload' },
        expectedColumn: 'expectedOutcome',
      },
    ],
  },
  sheets: [
    {
      name: 'AuthProfiles',
      headers: ['authRole', 'username', 'password', 'expectedLandingPage'],
      rows: [
        { authRole: 'ess', username: 'ess_user_01', password: 'TestUser@123', expectedLandingPage: '/dashboard' },
      ],
    },
    {
      name: 'NegativeAuth',
      headers: ['scenario', 'usernameInput', 'passwordInput', 'expectedBehavior', 'expectedErrorMessage'],
      rows: [
        {
          scenario: 'invalidUsername',
          usernameInput: 'nonexistent_user',
          passwordInput: 'admin123',
          expectedBehavior: 'Rejected',
          expectedErrorMessage: 'Invalid credentials',
        },
      ],
    },
    {
      name: 'SecurityAuth',
      headers: ['passwordPayload', 'expectedOutcome'],
      rows: [
        { passwordPayload: 'password', expectedOutcome: 'Password is masked' },
      ],
    },
  ],
};

console.log('-- data literal repair cannot corrupt binding metadata --');
{
  const parsed = {
    name: 'NegativeAuth row 1 - invalid username',
    module: 'Authentication',
    assertions: 'Invalid credentials rejected and Error message area stays generic.',
    dataBinding: {
      sheet: 'NegativeAuth',
      rowSelector: 'all',
      columnToField: {
        scenario: 'scenario',
        username: 'usernameInput',
        password: 'passwordInput',
        expected: 'expectedErrorMessage',
      },
      expectedColumn: 'expectedBehavior',
      placeholders: ['scenario', 'username', 'password', 'expected'],
    },
    steps: [
      { order: 1, action: 'Navigate', value: 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login', expected: 'Login page visible' },
      { order: 2, action: 'Fill', element: 'Password field', value: 'password' },
      { order: 3, action: 'Verify', element: 'Error message area', expected: 'Invalid credentials' },
    ],
    declaredAssertions: [
      {
        type: 'EVALUATE',
        note: 'Error message must display Invalid credentials.',
        payload: {
          script: "document.querySelector('.error-message')?.textContent?.trim() || ''",
          expectedReturn: 'Invalid credentials',
        },
      },
    ],
  };

  const repairs = buildDataLiteralRepairs(testData, 'Authentication');
  const literalRepair = repairDataLiteralsInCase(parsed, repairs);
  const repaired = literalRepair.value;
  ok('passwordInput header is preserved', repaired.dataBinding.columnToField.password === 'passwordInput', JSON.stringify(repaired.dataBinding.columnToField));
  ok('expectedErrorMessage header is preserved', repaired.dataBinding.columnToField.expected === 'expectedErrorMessage', JSON.stringify(repaired.dataBinding.columnToField));
  ok('ESS role literal does not rewrite message', repaired.declaredAssertions[0].note.includes('message'), repaired.declaredAssertions[0].note);
  ok('CSS class error-message is not rewritten', repaired.declaredAssertions[0].payload.script.includes('error-message'), repaired.declaredAssertions[0].payload.script);
  ok('exact typed password value can still be tokenized', repaired.steps[1].value === '{{password}}', repaired.steps[1].value);

  const scenarioShell = [{ name: 'Login Form - Negative Auth', module: 'Authentication', cases: [repaired] }];
  testDataAuthoring.markDataAwareCases(scenarioShell, testData, { moduleScope: 'Authentication' });
  const bound = scenarioShell[0].cases[0].dataBinding;
  ok('markDataAwareCases writes approved password column', bound.columnToField.password === 'passwordInput', JSON.stringify(bound));
  ok('markDataAwareCases writes approved expected column', bound.columnToField.expected === 'expectedErrorMessage', JSON.stringify(bound));

  const tc = { ...scenarioShell[0].cases[0], dataBindingJson: JSON.stringify(bound) };
  const defect = tdm.validateCaseDataBinding(tc, { name: scenarioShell[0].name, module: 'Authentication' }, testData);
  ok('corrected binding passes pre-run validation', !defect, JSON.stringify(defect));
}

console.log('');
if (fail) {
  console.log(`FAILED - ${fail} assertion(s)`);
  process.exit(1);
}
console.log('OK - data literal repair is boundary-aware and does not corrupt test-data bindings.');
