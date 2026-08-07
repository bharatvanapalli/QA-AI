import { describe, expect, it } from 'vitest';
import comparator from '../../server/services/reliability/benchmarkComparator.js';

describe('scenario benchmark comparator', () => {
  const expected = {
    id: 'orangehrm-core',
    items: [
      {
        coverageRef: 'admin-system-user-search',
        requiredFields: ['username', 'role', 'employee name', 'status'],
        requiredOracles: [{ kind: 'text', target: 'Result row' }],
        dataRowIntents: ['positive'],
      },
      {
        coverageRef: 'claim-validation',
        requiredFields: ['event', 'currency', 'amount', 'remarks'],
        requiredOracles: [{ kind: 'validation_message', target: 'Claim validation message' }],
        dataRowIntents: ['validation'],
      },
    ],
  };

  it('passes only when coverageRef, required fields, oracle, and row intent all match', () => {
    const result = comparator.compareScenarioBenchmark({
      expected,
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
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('does not pass because a title sounds similar', () => {
    const result = comparator.compareScenarioBenchmark({
      expected: { items: [expected.items[0]] },
      scenarios: [{
        module: 'Admin',
        cases: [{
          id: 'weak-admin',
          name: 'Admin System User Search with role and status',
          coverageRefs: ['admin-system-user-search'],
          steps: [
            { action: 'Fill', target: 'Username filter field', value: '{{usernamefilter}}' },
            { action: 'Verify', target: 'Result row', verify: { kind: 'text', text: 'Records Found' } },
          ],
          declaredAssertions: [{ type: 'TEXT', target: 'Result row', payload: { expectedText: 'Records Found' } }],
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain('benchmark_missing_required_field');
    expect(result.failures.map((failure) => failure.field)).toEqual(expect.arrayContaining(['role', 'status']));
  });

  it('detects known negative regression defects', () => {
    const result = comparator.compareNegativeRegressions({
      fixtures: [
        {
          id: 'double-encoded-steps',
          expectedDefectCodes: ['double_encoded_steps'],
          scenarios: [{
            cases: [{
              id: 'encoded-case',
              steps: JSON.stringify(JSON.stringify([{ action: 'Click', target: 'Save button' }])),
            }],
          }],
        },
        {
          id: 'verify-none-and-token-collision',
          expectedDefectCodes: ['verify_kind_none', 'token_collision'],
          scenarios: [{
            cases: [{
              id: 'bad-case',
              name: 'Admin Search',
              steps: [
                { action: 'Fill', target: 'Username search field', value: '{{loginusername}}' },
                { action: 'Verify', target: 'Result row', verify: { kind: 'none' }, expected: 'as expected' },
              ],
            }],
          }],
        },
        {
          id: 'missing-row-plan',
          expectedDefectCodes: ['missing_row_execution_plan'],
          scenarios: [{
            cases: [{
              id: 'row-case',
              dataBinding: { sheet: 'PIM_EmployeeLifecycle' },
              steps: [
                { action: 'Fill', target: 'Employee Id field', value: '{{employeeid}}' },
                { action: 'Verify', target: 'Personal Details', verify: { kind: 'text', text: 'Personal Details' } },
              ],
            }],
          }],
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results.every((entry) => entry.missingDefectCodes.length === 0)).toBe(true);
  });
});
