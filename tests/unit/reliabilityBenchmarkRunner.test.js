import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const script = path.join(root, 'scripts', 'benchmark_scenarios.cjs');

function tempCase(name, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qaai-benchmark-${name}-`));
  const scenariosPath = path.join(dir, 'scenarios.json');
  const reportPath = path.join(dir, 'report.json');
  fs.writeFileSync(scenariosPath, JSON.stringify(payload, null, 2));
  return { dir, scenariosPath, reportPath };
}

function runBenchmark(payload) {
  const tmp = tempCase('suite', payload);
  const result = spawnSync(process.execPath, [script, '--scenarios', tmp.scenariosPath, '--report', tmp.reportPath], {
    cwd: root,
    encoding: 'utf8',
  });
  const report = fs.existsSync(tmp.reportPath) ? JSON.parse(fs.readFileSync(tmp.reportPath, 'utf8')) : null;
  return { result, report };
}

function completeOrangeHrmSuite() {
  return {
    generation: { id: 'generated-suite', projectId: 'orangehrm', version: 1 },
    scenarios: [
      {
        module: 'Admin',
        cases: [{
          id: 'admin-case',
          name: 'Admin System User Search',
          coverageRefs: ['admin-system-user-search'],
          caseIntent: 'positive admin search',
          dataBinding: { rowIntent: 'positive' },
          steps: [
            { action: 'Fill', target: 'Username filter field', value: '{{usernamefilter}}' },
            { action: 'Select', target: 'User Role dropdown', value: '{{userrolefilter}}' },
            { action: 'Fill', target: 'Employee Name filter field', value: '{{employeename}}' },
            { action: 'Select', target: 'Status dropdown', value: '{{statusfilter}}' },
            { action: 'Click', target: 'Search button' },
            { action: 'Verify', target: 'Result row', verify: { kind: 'text', text: 'Records Found' } },
          ],
          declaredAssertions: [{ type: 'TEXT', target: 'Result row', payload: { expectedText: 'Records Found' } }],
        }],
      },
      {
        module: 'Claim',
        cases: [{
          id: 'claim-case',
          name: 'Claim validation',
          coverageRefs: ['claim-validation'],
          caseIntent: 'validation claim required fields',
          dataBinding: { rowIntent: 'validation' },
          steps: [
            { action: 'Select', target: 'Event dropdown', value: '{{claimevent}}' },
            { action: 'Select', target: 'Currency dropdown', value: '{{claimcurrency}}' },
            { action: 'Fill', target: 'Amount field', value: '{{claimamount}}' },
            { action: 'Fill', target: 'Remarks field', value: '{{claimremarks}}' },
            { action: 'Click', target: 'Submit button' },
            { action: 'Verify', target: 'Claim validation message', verify: { kind: 'validation_message', text: 'Required' } },
          ],
          oracles: [{ kind: 'validation_message', target: 'Claim validation message', expected: 'Required', source: 'story' }],
        }],
      },
      {
        module: 'PIM',
        cases: [{
          id: 'pim-case',
          name: 'PIM Employee Lifecycle',
          coverageRefs: ['pim-employee-lifecycle'],
          caseIntent: 'positive boundary employee lifecycle',
          dataBinding: {
            rowIntent: 'positive boundary',
            sheet: 'PIM_EmployeeLifecycle',
            rows: [{ id: 'row-1', intent: 'positive' }, { id: 'row-2', intent: 'boundary' }],
            columnToField: {
              firstname: 'First Name',
              middlename: 'Middle Name',
              lastname: 'Last Name',
              employeeid: 'Employee ID',
            },
          },
          rowExecutionPlan: {
            rowIds: ['row-1', 'row-2'],
            executionMode: 'per_row',
            skippedRows: [],
            skipReasons: {},
          },
          steps: [
            { action: 'Fill', target: 'First Name field', value: '{{firstname}}' },
            { action: 'Fill', target: 'Middle Name field', value: '{{middlename}}' },
            { action: 'Fill', target: 'Last Name field', value: '{{lastname}}' },
            { action: 'Fill', target: 'Employee Id field', value: '{{employeeid}}' },
            { action: 'Click', target: 'Save button' },
            { action: 'Verify', target: 'Personal Details', verify: { kind: 'text', text: 'Personal Details' } },
          ],
          declaredAssertions: [{ type: 'TEXT', target: 'Personal Details', payload: { expectedText: 'Personal Details' } }],
        }],
      },
      {
        module: 'Authentication',
        cases: [{
          id: 'login-case',
          name: 'Login dashboard',
          coverageRefs: ['login-dashboard'],
          caseIntent: 'positive login',
          dataBinding: { rowIntent: 'positive' },
          steps: [
            { action: 'Fill', target: 'Username field', value: '{{loginusername}}' },
            { action: 'Fill', target: 'Password field', value: '{{loginpassword}}' },
            { action: 'Click', target: 'Login button' },
            { action: 'Verify', target: 'url', verify: { kind: 'url', expected: '/dashboard/index' } },
          ],
          oracles: [{ kind: 'url', target: 'url', expected: '/dashboard/index', source: 'story' }],
        }],
      },
    ],
  };
}

describe('live scenario benchmark runner', () => {
  it('loads all OrangeHRM fixtures and writes a passing report for a complete generated suite', () => {
    const { result, report } = runBenchmark(completeOrangeHrmSuite());

    expect(result.status).toBe(0);
    expect(report.pass).toBe(true);
    expect(report.fixturesLoaded).toEqual(expect.arrayContaining([
      'admin-search.expected.json',
      'claim-validation.expected.json',
      'data-binding.expected.json',
      'multi-row.expected.json',
      'execution-readiness.expected.json',
      'negative-regressions.expected.json',
    ]));
    expect(report.missingRequiredFields).toEqual([]);
    expect(report.regressionDetectionResults.every((entry) => entry.ok)).toBe(true);
  });

  it('fails when Admin Search misses role and status', () => {
    const suite = completeOrangeHrmSuite();
    const adminCase = suite.scenarios[0].cases[0];
    adminCase.steps = adminCase.steps.filter((step) => !/role|status/i.test(step.target));
    const { result, report } = runBenchmark(suite);

    expect(result.status).toBe(1);
    expect(report.pass).toBe(false);
    expect(report.missingRequiredFields.map((failure) => failure.field)).toEqual(expect.arrayContaining(['role', 'status']));
  });

  it('fails when Claim validation misses event, currency, amount, and remarks', () => {
    const suite = completeOrangeHrmSuite();
    suite.scenarios[1].cases[0].steps = [
      { action: 'Click', target: 'Submit button' },
      { action: 'Verify', target: 'Claim validation message', verify: { kind: 'validation_message', text: 'Required' } },
    ];
    const { result, report } = runBenchmark(suite);

    expect(result.status).toBe(1);
    expect(report.missingRequiredFields.map((failure) => failure.field)).toEqual(expect.arrayContaining([
      'event',
      'currency',
      'amount',
      'remarks',
    ]));
  });

  it('fails when rows are skipped without reason', () => {
    const suite = completeOrangeHrmSuite();
    suite.scenarios[2].cases[0].rowExecutionPlan.skippedRows = ['row-2'];
    suite.scenarios[2].cases[0].rowExecutionPlan.skipReasons = {};
    const { result, report } = runBenchmark(suite);

    expect(result.status).toBe(1);
    expect(report.contractDefects.some((failure) => failure.defectCode === 'silent_row_skip')).toBe(true);
  });

  it('fails on weak oracle and token collision', () => {
    const suite = completeOrangeHrmSuite();
    suite.scenarios[0].cases[0].steps[0].value = '{{loginusername}}';
    suite.scenarios[0].cases[0].steps.at(-1).verify = { kind: 'none' };
    suite.scenarios[0].cases[0].declaredAssertions = [];
    const { result, report } = runBenchmark(suite);

    expect(result.status).toBe(1);
    const defectCodes = report.contractDefects.map((failure) => failure.defectCode);
    expect(defectCodes).toEqual(expect.arrayContaining(['token_collision', 'verify_kind_none']));
  });
});
