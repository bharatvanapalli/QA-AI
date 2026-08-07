import { describe, expect, it } from 'vitest';
import bindingContract from '../../server/services/testDataBindingContract.js';
import generationDataContract from '../../server/services/testDataGenerationContract.js';
import generationCompiler from '../../server/services/generationCompiler.js';
import { buildWorkbookContract } from '../../server/services/workbookContract.js';

const approvedData = {
  sheets: [
    {
      name: 'PIM_EmployeeLifecycle',
      headers: ['storyId', 'caseIntent', 'firstName', 'password', 'expected'],
      rows: [
        { storyId: 'US-OHRM-005', caseIntent: 'positive create employee', firstName: 'QAAI', password: 'FixtureSecret-Row1!', expected: 'Personal Details' },
        { storyId: 'US-OHRM-005', caseIntent: 'positive create employee', firstName: 'QAAI2', password: 'FixtureSecret-Row2!', expected: 'Personal Details' },
      ],
    },
    {
      name: 'Login_Negative_Boundary',
      headers: ['storyId', 'caseIntent', 'username', 'password', 'expected'],
      rows: [
        { storyId: 'US-AUTH-001', caseIntent: 'negative invalid password', username: 'Admin', password: 'wrongpass', expected: 'Invalid credentials' },
        { storyId: 'US-AUTH-001', caseIntent: 'boundary empty password', username: 'Admin', password: '', expected: 'Required' },
      ],
    },
  ],
  mapping: {
    bindings: [
      {
        sheet: 'PIM_EmployeeLifecycle',
        module: 'PIM',
        purpose: 'positive create employee',
        columnToField: { firstName: 'firstName', password: 'password' },
        expectedColumn: 'expected',
        rowClassColumn: 'caseIntent',
      },
      {
        sheet: 'Login_Negative_Boundary',
        module: 'Auth',
        purpose: 'negative boundary role login',
        columnToField: { username: 'username', password: 'password' },
        expectedColumn: 'expected',
        rowClassColumn: 'caseIntent',
      },
    ],
  },
};

function approvedGenerationContract() {
  return generationDataContract.buildGenerationDataContract(approvedData, { source: 'approved' });
}

function dataBoundCase(overrides = {}) {
  return {
    name: 'Add employee and verify Personal Details',
    type: 'functional',
    module: 'PIM',
    storyId: 'US-OHRM-005',
    confidence: 90,
    assertions: 'Personal Details page opens',
    dataBinding: {
      sheet: 'PIM_EmployeeLifecycle',
      rowSelector: 'story:US-OHRM-005',
      status: 'complete',
      columnToField: { firstName: 'firstName', password: 'password', expected: 'expected' },
      expectedColumn: 'expected',
      rowClassColumn: 'caseIntent',
    },
    steps: [
      { order: 1, action: 'Fill', element: 'First Name field', value: '{{firstName}}' },
      { order: 2, action: 'Fill', element: 'Password field', value: '{{password}}' },
    ],
    declaredAssertions: [
      { id: 'A1', type: 'TEXT', criticality: 'must', payload: { expectedText: '{{expected}}' } },
    ],
    ...overrides,
  };
}

describe('test data binding contract', () => {
  it('certifies approved data tokens with a complete approved binding', () => {
    const result = bindingContract.certifyCaseDataBinding({
      caseObj: dataBoundCase(),
      generationContract: approvedGenerationContract(),
    });

    expect(result.ok).toBe(true);
    expect(result.bindingComplete).toBe(true);
    expect(result.certifiedInputs.map((i) => i.mode)).toEqual(['approved_data_token', 'approved_data_token']);
    expect(result.certifiedAssertions[0].mode).toBe('approved_data_token');
  });

  it('rejects copied approved literals and secret literals in input steps', () => {
    const result = bindingContract.certifyCaseDataBinding({
      caseObj: dataBoundCase({
        steps: [
          { order: 1, action: 'Fill', element: 'First Name field', value: 'QAAI' },
          { order: 2, action: 'Fill', element: 'Password field', value: 'FixtureSecret-Row1!' },
        ],
      }),
      generationContract: approvedGenerationContract(),
    });

    expect(result.ok).toBe(false);
    expect(result.defects.map((d) => d.code)).toContain('approved_data_literal');
    expect(result.defects.map((d) => d.code)).toContain('secret_literal_not_allowed');
    expect(result.defects.map((d) => d.code)).toContain('bound_field_literal');
  });

  it('rejects tokens and expected assertions that are not approved by the data mapping', () => {
    const result = bindingContract.certifyCaseDataBinding({
      caseObj: dataBoundCase({
        steps: [{ order: 1, action: 'Fill', element: 'First Name field', value: '{{unknownColumn}}' }],
        declaredAssertions: [{ id: 'A1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Personal Details' } }],
      }),
      generationContract: approvedGenerationContract(),
    });

    expect(result.ok).toBe(false);
    expect(result.defects.map((d) => d.code)).toContain('data_token_not_approved');
    expect(result.defects.map((d) => d.code)).toContain('approved_expected_literal');
  });

  it('describes positive, negative, boundary, multi-row, and role-based data coverage', () => {
    const contract = approvedGenerationContract();

    expect(contract.coverageKinds).toEqual(expect.arrayContaining(['positive', 'negative', 'boundary', 'multi_row', 'role_based']));
    expect(contract.bindings.find((b) => b.sheet === 'Login_Negative_Boundary').coverageKinds)
      .toEqual(expect.arrayContaining(['negative', 'boundary', 'multi_row', 'role_based']));
  });

  it('keeps unsafe approved-data literals out of GenerationCompiler ready output', () => {
    const c = dataBoundCase({
      declaredAssertions: [
        { id: 'A1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Personal Details' } },
      ],
    });
    const scenarios = [{ name: 'PIM lifecycle', module: 'PIM', cases: [c] }];
    const workbookContract = buildWorkbookContract({ sheets: approvedData.sheets });
    const compiled = generationCompiler.compileGeneration({
      scenarios,
      testData: { ...approvedData, generationContract: approvedGenerationContract() },
      workbookContract,
      authProfileName: 'ADMIN_DEFAULT',
    });

    expect(compiled.readyScenarios).toHaveLength(0);
    expect(compiled.report.blocked).toBe(1);
    expect(compiled.report.dataBinding.blocked).toBe(1);
    expect(compiled.report.defects.map((d) => d.code)).toContain('approved_expected_literal');
  });
});
