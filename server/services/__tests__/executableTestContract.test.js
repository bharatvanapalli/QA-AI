'use strict';

const {
  buildExecutionContract,
  buildActionGraph,
  certifyContractExport,
} = require('../executableTestContract');

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

console.log('Executable Test Contract - planned nodes preserve data-row intent');
{
  const contract = buildExecutionContract({
    runId: 'RUN-1',
    testCase: {
      id: 'TC-1',
      name: 'Verify logout redirects ESS user to login page',
      module: 'authentication',
      declaredAssertions: JSON.stringify([{ id: 'ASN-login', type: 'PAGE', pageName: 'login_page' }]),
    },
    declaredSteps: [
      { action: 'click', element: 'Profile picture / user menu trigger' },
      { action: 'click', element: 'Logout menu item' },
      { action: 'verify', expected: 'Login page is displayed' },
    ],
    declaredAssertions: [{ id: 'ASN-login', type: 'PAGE', pageName: 'login_page' }],
    dataRow: { index: 3, label: 'Row 4 - ess_logout', setName: 'AuthProfiles', fields: { expectedLandingPage: '/auth/login' } },
  });
  expect('schema', contract.schema, 'qaai-executable-test-contract/1');
  expect('node count includes steps and assertion', contract.nodes.length, 4);
  expect('row coordinate is attached', contract.nodes[0].rowCoordinateId, 'AuthProfiles:3:Row 4 - ess_logout');
  expect('assertion polarity is explicit', contract.nodes[3].expectedOutcome.polarity, 'must_match');
}

console.log('Executable Test Contract - fill checks remain operational primitives');
{
  const contract = buildExecutionContract({
    runId: 'RUN-fill',
    testCase: { id: 'TC-fill', name: 'Login form accepts credentials', module: 'authentication' },
    declaredSteps: [
      { action: 'Fill', element: 'Username textbox', value: 'Admin', expected: 'Username entered is visible' },
      { action: 'Click', element: 'Profile menu button', expected: 'Profile menu opens' },
    ],
  });
  expect('fill becomes input_accepted', contract.nodes[0].operationCheck.kind, 'input_accepted');
  expect('fill check wording is role-based', contract.nodes[0].operationCheck.expected, 'Username textbox accepts the provided value');
  expect('menu click becomes menu_opened', contract.nodes[1].operationCheck.kind, 'menu_opened');
}

console.log('Certified Action Graph - missing locator creates QAAI repair task');
{
  const contract = buildExecutionContract({
    runId: 'RUN-2',
    testCase: { id: 'TC-2', name: 'Click Save', module: 'admin' },
    declaredSteps: [{ action: 'click', element: 'Save button' }],
  });
  const graph = buildActionGraph({
    contract,
    replayEnvelope: { ir: { steps: [{ op: 'act', action: 'click', target: 'el1' }] } },
    status: 'pass',
    runResultId: 'RR-2',
  });
  expect('graph is incomplete', graph.complete, false);
  expect('repair task category', graph.repairTasks[0].category, 'missing_locator_recipe');
  expect('repair ownership', graph.repairTasks[0].owner, 'qaai_platform');
}

console.log('Contract Export Certification - contract-backed EvaluateMethods cannot certify');
{
  const report = certifyContractExport({
    results: [{
      runResultId: 'RR-3',
      testCaseId: 'TC-3',
      status: 'pass',
      executionContract: { schema: 'qaai-executable-test-contract/1', nodes: [] },
      actionGraph: { schema: 'qaai-certified-action-graph/1', complete: true, repairTasks: [] },
    }],
    files: {
      'pages/EvaluateMethods.js': 'export class EvaluateMethods {}',
      'tests/auth/sample.spec.js': "import { test } from '@playwright/test';\ntest('sample', async () => {});\n",
    },
    validation: { packagePassed: true },
    stepLedger: { summary: { blockedInternal: 0 } },
  });
  expect('contract-first gate active', report.contractFirstActive, true);
  expect('package cannot pass', report.packagePassed, false);
  expect('debug evaluate finding emitted', report.findings.some((f) => f.rule === 'contract_debug_evaluate_methods_in_certified_package'), true);
}

if (failures > 0) {
  console.error(`FAIL - ${failures} executable test contract check(s) failed`);
  process.exit(1);
}
console.log('PASS - executable test contract checks green');
