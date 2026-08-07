'use strict';

const assert = require('assert');
const {
  resolveCaseRows,
  substituteCase,
  validateCaseDataBinding,
  materializeInlineEvidenceTokens,
} = require('../testDataMatrix');
const { deriveCaseOracleIntent } = require('../../lib/dataRowContract');

const testData = {
  sheets: [{
    name: 'AuthProfiles',
    headers: ['authRole', 'username', 'password', 'expectedLandingPage'],
    rows: [
      { authRole: 'admin', username: 'Admin', password: 'admin123', expectedLandingPage: '/web/index.php/dashboard/index' },
      { authRole: 'ess', username: 'ess_user_01', password: 'Admin@123', expectedLandingPage: '/web/index.php/dashboard/index' },
      { authRole: 'admin_logout', username: 'Admin', password: 'admin123', expectedLandingPage: '/web/index.php/auth/login' },
      { authRole: 'ess_logout', username: 'ess_user_01', password: 'Admin@123', expectedLandingPage: '/web/index.php/auth/login' },
    ],
  }],
  mapping: {
    bindings: [{
      sheet: 'AuthProfiles',
      columnToField: {
        role: 'authRole',
        username: 'username',
        password: 'password',
      },
      expectedColumn: 'expectedLandingPage',
      rowClassColumn: null,
    }],
  },
};

const dbWrappedTestData = {
  sheets: { sheets: testData.sheets },
  mapping: testData.mapping,
};

const scenario = { name: 'Credential Injection from AuthProfiles Without Hardcoding', module: 'authentication' };

{
  const generatedCase = {
    name: 'Login through email classifier and Microsoft sign-in',
    dataBinding: {
      sheet: 'CaseContractPack',
      source: 'proposed_mapping',
      mappingStatus: 'needs_mapping',
      columnToField: {
        emailaddress: 'emailaddress',
        microsoftemailphoneskype: 'microsoftemailphoneskype',
      },
    },
    steps: JSON.stringify([
      {
        action: 'Fill',
        element: 'Email Address field',
        value: '{{emailaddress}}',
        verify: { kind: 'value', equals: 'OdysseyOneAutomationTester1@odysseylogistics.com' },
      },
      {
        action: 'Fill',
        element: 'Microsoft email field',
        value: '{{microsoftemailphoneskype}}',
        verify: { kind: 'value', equals: 'OdysseyOneAutomationTester1@odysseylogistics.com' },
      },
    ]),
    declaredAssertions: JSON.stringify([]),
  };

  const result = materializeInlineEvidenceTokens(generatedCase);
  assert.deepStrictEqual(result.replacements, ['emailaddress', 'microsoftemailphoneskype']);
  assert.strictEqual(result.case.dataBinding, null);
  assert.strictEqual(result.case.dataBindingJson, null);
  assert.strictEqual(validateCaseDataBinding(result.case, scenario, null), null);
  const steps = JSON.parse(result.case.steps);
  assert.strictEqual(steps[0].value, 'OdysseyOneAutomationTester1@odysseylogistics.com');
  assert.strictEqual(steps[1].value, 'OdysseyOneAutomationTester1@odysseylogistics.com');
}

{
  const rows = resolveCaseRows({
    name: 'Verify logout redirects ESS user to login page (ess_logout iteration)',
    assertions: 'After ess_user_01 logout, URL is /web/index.php/auth/login.',
    module: 'authentication',
    dataBindingJson: JSON.stringify({ sheet: 'AuthProfiles', rowSelector: 'positive' }),
  }, scenario, testData);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].inputs.role, 'ess_logout');
  assert.strictEqual(rows[0].inputs.username, 'ess_user_01');
  assert.strictEqual(rows[0].expected, '/web/index.php/auth/login');
}

{
  const rows = resolveCaseRows({
    name: 'Verify logout redirects ESS user to login page (ess_logout iteration)',
    assertions: 'After ess_user_01 logout, URL is /web/index.php/auth/login.',
    module: 'authentication',
    dataBindingJson: JSON.stringify({ sheet: 'AuthProfiles', rowSelector: 'positive' }),
  }, scenario, dbWrappedTestData);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].inputs.role, 'ess_logout');
}

{
  const row = resolveCaseRows({
    name: 'Verify logout redirects ESS user to login page (ess_logout iteration)',
    assertions: 'After ess_user_01 logout, URL is /web/index.php/auth/login.',
    module: 'authentication',
    dataBindingJson: JSON.stringify({ sheet: 'AuthProfiles', rowSelector: 'positive' }),
  }, scenario, testData)[0];

  const substituted = substituteCase({
    name: 'Verify logout redirects ESS user to login page (ess_logout iteration)',
    assertions: 'After logout, user reaches {{expected}}.',
    steps: JSON.stringify([]),
    declaredAssertions: JSON.stringify([{
      id: 'ASN-dashboard',
      type: 'PAGE',
      payload: {
        pageName: 'dashboard',
        expectedSignals: { text: ['Dashboard'], url: ['/web/index.php/dashboard/index'] },
      },
    }]),
  }, row);

  const declared = JSON.parse(substituted.declaredAssertions);
  assert.strictEqual(declared.length, 1);
  assert.strictEqual(declared[0].type, 'PAGE');
  // review P2a — expectedPageProfile is now generic (URL-tail identity), so a
  // /auth/login destination yields pageName 'login' (was the hardcoded 'login_page').
  // The INTENT is unchanged: the PAGE assertion is re-pointed to the login page
  // (NOT the dashboard) because the row's expected landing is /auth/login.
  assert.strictEqual(declared[0].payload.pageName, 'login');
  assert.deepStrictEqual(declared[0].payload.expectedSignals.url, ['/web/index.php/auth/login']);
  assert.ok(!JSON.stringify(declared[0]).includes('/web/index.php/dashboard/index'));
  assert.strictEqual(declared[0].dataBinding.expectedColumn, 'expectedLandingPage');
}

{
  assert.strictEqual(
    deriveCaseOracleIntent({ name: 'Dashboard widgets are visible and non-empty' }),
    null,
  );
}

const orangeLikeTestData = {
  sheets: [
    {
      name: 'Maintenance_Access',
      headers: ['maintenanceCaseId', 'caseIntent', 'maintenancePasswordInput', 'expectedVisibleSignal'],
      rows: [
        {
          maintenanceCaseId: 'MNT-GATE-01',
          caseIntent: 'valid_maintenance_password',
          maintenancePasswordInput: 'admin123',
          expectedVisibleSignal: 'Maintenance or Purge Records',
        },
        {
          maintenanceCaseId: 'MNT-GATE-02',
          caseIntent: 'invalid_maintenance_password',
          maintenancePasswordInput: 'wrongPassword123',
          expectedVisibleSignal: 'Administrator Access remains or Invalid credentials',
        },
      ],
    },
    {
      name: 'Recruitment_Candidates',
      headers: ['candidateCaseId', 'caseIntent', 'firstNameInput', 'middleNameInput', 'lastNameInput', 'emailInput', 'expectedVisibleSignal', 'expectedValidationMessage'],
      rows: [
        {
          candidateCaseId: 'REC-CAND-01',
          caseIntent: 'add_candidate',
          firstNameInput: 'QAAI',
          middleNameInput: 'Recruit',
          lastNameInput: 'Gamma001',
          emailInput: 'qaai.candidate.gamma001@example.test',
          expectedVisibleSignal: 'Candidate profile or success toast',
          expectedValidationMessage: '',
        },
        {
          candidateCaseId: 'REC-CAND-02',
          caseIntent: 'candidate_email_validation',
          firstNameInput: 'QAAI',
          middleNameInput: '',
          lastNameInput: 'BadEmail',
          emailInput: 'not-an-email',
          expectedVisibleSignal: '',
          expectedValidationMessage: 'Expected format',
        },
      ],
    },
  ],
  mapping: {
    bindings: [
      {
        sheet: 'Maintenance_Access',
        purpose: 'auth_profiles',
        columnToField: {
          caseintent: 'caseIntent',
          password: 'maintenancePasswordInput',
          expected: 'expectedVisibleSignal',
        },
        expectedColumn: 'expectedVisibleSignal',
      },
      {
        sheet: 'Recruitment_Candidates',
        purpose: 'validation_cases',
        columnToField: {
          caseintent: 'caseIntent',
          firstName: 'firstNameInput',
          middleName: 'middleNameInput',
          lastName: 'lastNameInput',
          email: 'emailInput',
          expectedvalidationmessage: 'expectedValidationMessage',
        },
        expectedColumn: 'expectedVisibleSignal',
      },
    ],
  },
};

{
  const scenario = { name: 'Maintenance Password Gate', module: 'maintenance' };
  const tc = {
    name: 'Wrong password at Maintenance gate does not grant access',
    module: 'maintenance',
    assertions: 'Wrong password must keep Administrator Access visible.',
    dataBindingJson: JSON.stringify({ sheet: 'Maintenance_Access', rowSelector: 'all' }),
  };
  const rows = resolveCaseRows(tc, scenario, orangeLikeTestData);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].raw.maintenanceCaseId, 'MNT-GATE-02');
  assert.strictEqual(validateCaseDataBinding(tc, scenario, orangeLikeTestData), null);
}

{
  const scenario = { name: 'Recruitment Candidate Management', module: 'recruitment' };
  const tc = {
    name: 'Add candidate with invalid email triggers validation message',
    module: 'recruitment',
    assertions: 'Invalid email should show {{expectedvalidationmessage}}.',
    dataBindingJson: JSON.stringify({ sheet: 'Recruitment_Candidates', rowSelector: 'negative' }),
  };
  const rows = resolveCaseRows(tc, scenario, orangeLikeTestData);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].raw.candidateCaseId, 'REC-CAND-02');
}

console.log('testDataMatrix.test.js: PASS');
