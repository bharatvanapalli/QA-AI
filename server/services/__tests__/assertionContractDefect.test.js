'use strict';

const {
  CONTRACT_BLOCKED_REASON,
  CONTRACT_OWNERSHIP,
  classifyAssertionContractDefect,
  inferFailureExplanationOwnership,
} = require('../assertionContractDefect');

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  }
}

const dashboardAssertion = {
  id: 'ASN-dashboard',
  type: 'PAGE',
  criticality: 'must',
  provenance: 'doc_quoted',
  payload: {
    pageName: 'dashboard',
    expectedSignals: ['Dashboard', '/dashboard/index'],
  },
};

console.log('Fixture 1 - logout flow with dashboard assertion and login evidence is QAAI contract defect');
{
  const decision = classifyAssertionContractDefect({
    testCase: { name: 'Verify logout redirects ESS user to login page' },
    declaredAssertions: [dashboardAssertion],
    recordedOutcomes: [{
      assertionId: 'ASN-dashboard',
      outcome: 'not_matched',
      evidence: "Snapshot shows login page (URL=/auth/login, heading='Login') not dashboard page",
    }],
    finalUrl: 'https://example.test/auth/login',
    verdictReason: 'assertion_not_matched',
  });
  expect('classified as defect', decision.isDefect, true);
  expect('blocked reason', decision.blockedReason, CONTRACT_BLOCKED_REASON);
  expect('ownership', decision.ownership, CONTRACT_OWNERSHIP);
  expect('defect type', decision.defectType, 'inverted_logout_assertion');
}

console.log('Fixture 2 - normal login expecting dashboard and seeing login remains website failure candidate');
{
  const decision = classifyAssertionContractDefect({
    testCase: { name: 'Verify admin user logs in and reaches dashboard' },
    declaredAssertions: [dashboardAssertion],
    recordedOutcomes: [{
      assertionId: 'ASN-dashboard',
      outcome: 'not_matched',
      evidence: "Snapshot shows login page (URL=/auth/login, heading='Login') not dashboard page",
    }],
    finalUrl: 'https://example.test/auth/login',
    verdictReason: 'assertion_not_matched',
  });
  expect('not a contract defect', decision.isDefect, false);
}

console.log('Fixture 3 - unrelated required assertion miss is not reclassified');
{
  const decision = classifyAssertionContractDefect({
    testCase: { name: 'Verify user list search filters by username' },
    declaredAssertions: [{
      id: 'ASN-user-row',
      type: 'TEXT',
      criticality: 'must',
      payload: { expectedText: 'James Butler' },
    }],
    recordedOutcomes: [{
      assertionId: 'ASN-user-row',
      outcome: 'not_matched',
      evidence: 'Text "James Butler" was not present in the table.',
    }],
    verdictReason: 'assertion_not_matched',
  });
  expect('not a contract defect', decision.isDefect, false);
}

console.log('Fixture 3b - session persistence no-redirect-to-login is not treated as logout');
{
  const decision = classifyAssertionContractDefect({
    testCase: {
      name: 'Admin session persists across navigation to PIM and back to dashboard',
      assertions: 'After navigating to PIM module and back to Dashboard, user remains authenticated; no redirect to login page occurs.',
    },
    declaredAssertions: [dashboardAssertion],
    recordedOutcomes: [{
      assertionId: 'ASN-dashboard',
      outcome: 'not_matched',
      evidence: "Snapshot shows login page (URL=/auth/login, heading='Login') not dashboard page",
    }],
    finalUrl: 'https://example.test/auth/login',
    verdictReason: 'assertion_not_matched',
  });
  expect('not a logout contract defect', decision.isDefect, false);
}

console.log('Fixture 4 - explainer admitting test design error is only a signal, not ownership');
{
  const explanation = inferFailureExplanationOwnership({
    overallSummary: 'The assertion logic is inverted for a logout test. This appears to be a test design error rather than a product bug.',
    assertionExplanations: [],
  });
  expect('ownership signal inferred', explanation.ownershipSignal, CONTRACT_OWNERSHIP);
  expect('status signal inferred', explanation.recommendedStatusSignal, 'blocked');
  expect('ownership not assigned from prose alone', explanation.ownership, undefined);
}

console.log('Fixture 5 - explainer signal plus deterministic evidence classifies ownership');
{
  const decision = classifyAssertionContractDefect({
    testCase: { name: 'Verify logout redirects ESS user to login page' },
    declaredAssertions: [dashboardAssertion],
    recordedOutcomes: [{
      assertionId: 'ASN-dashboard',
      outcome: 'not_matched',
      evidence: "Snapshot shows login page (URL=/auth/login, heading='Login') not dashboard page",
    }],
    failureExplanation: {
      overallSummary: 'The assertion logic is inverted for a logout test. This appears to be a test design error rather than a product bug.',
    },
    finalUrl: 'https://example.test/auth/login',
    verdictReason: 'assertion_not_matched',
  });
  expect('classified as defect', decision.isDefect, true);
  expect('raw verdict preserved', decision.rawMechanicalVerdict, 'fail');
  expect('user-facing verdict', decision.userFacingVerdict, 'blocked');
}

if (failures) {
  console.error(`assertionContractDefect.test.js failed with ${failures} failure(s)`);
  process.exit(1);
}
console.log('assertionContractDefect.test.js passed');
