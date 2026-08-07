import { describe, expect, it } from 'vitest';
import contracts from '../../server/services/reliability/contracts.js';
import promotion from '../../server/services/reliability/promotion.js';
import executionReadiness from '../../server/services/executionReadinessCompiler.js';

describe('scenario reliability core', () => {
  it('recursively normalizes double-encoded step arrays', () => {
    const steps = [{ action: 'Fill', target: 'Username field', value: 'Admin' }];
    const encodedTwice = JSON.stringify(JSON.stringify(steps));
    const result = contracts.normalizeStepsInput(encodedTwice);

    expect(result.ok).toBe(true);
    expect(result.steps).toEqual(steps);
    expect(result.defect?.code).toBe('double_encoded_steps');
    expect(result.defect?.resolutionStatus).toBe('auto_repaired');
  });

  it('turns missing required coverage into a repair-required reliability defect', () => {
    const defects = contracts.coverageDefectsFromValidation({
      findings: [
        { severity: 'error', code: 'coverage_required_missing', manifestItemId: 'admin-search-role-status' },
      ],
    });

    expect(defects).toHaveLength(1);
    expect(defects[0].code).toBe('coverage_missing_required');
    expect(defects[0].severity).toBe('repair_required');
    expect(defects[0].coverageRef).toBe('admin-search-role-status');
  });

  it('does not promote a report with missing coverage to Reliable', () => {
    const report = promotion.createScenarioReliabilityReport({
      scenarios: [{ cases: [{ id: 'case-1', name: 'Admin Search' }] }],
      defects: [
        contracts.createReliabilityDefect({
          code: 'coverage_missing_required',
          coverageRef: 'claim-validation',
        }),
      ],
      coverageSummary: { ok: false, required: 6, covered: 4, missingRequired: 2 },
    });

    expect(report.status).toBe('needs_repair');
    expect(promotion.canPromoteToReliable(report)).toBe(false);
  });

  it('keeps execution-readiness repaired steps as arrays', () => {
    const caseObj = {
      id: 'case-1',
      name: 'PIM Add Employee',
      module: 'PIM',
      dataBinding: {
        sheet: 'PIM_EmployeeLifecycle',
        rowSelector: 'all',
        columnToField: { role: 'profileKey' },
      },
      steps: JSON.stringify(JSON.stringify([
        { order: 1, action: 'Navigate', target: 'PIM Add Employee page' },
      ])),
    };
    const loginTemplate = {
      sourceCase: 'Login',
      prelude: [
        { order: 1, action: 'Navigate', target: 'OrangeHRM login page' },
        { order: 2, action: 'Fill', target: 'Username field', value: '{{loginusername}}' },
      ],
      companion: {
        sheet: 'profiles',
        columnToField: { loginusername: 'Username', loginpassword: 'Password' },
      },
    };

    const result = executionReadiness.repairCaseExecutionReadiness(caseObj, caseObj.dataBinding, loginTemplate);

    expect(result.executable).toBe(true);
    expect(result.reason).toBe('login_setup_injected');
    expect(Array.isArray(caseObj.steps)).toBe(true);
    expect(typeof caseObj.steps).not.toBe('string');
    expect(caseObj.steps).toHaveLength(3);
    expect(caseObj.steps[2].target).toBe('PIM Add Employee page');
  });

  it('treats explicit continuation cases as dependency-session ready instead of injecting login', () => {
    const caseObj = {
      id: 'case-2',
      name: 'Validate User Management after login',
      module: 'User Management',
      sessionMode: 'continue_from_dependency',
      dependsOnIds: JSON.stringify(['case-1']),
      steps: [
        { order: 1, action: 'Click', target: 'User Management menu icon' },
        { order: 2, action: 'Verify', target: 'User Management page' },
      ],
    };

    const result = executionReadiness.repairCaseExecutionReadiness(caseObj, null, null);

    expect(result.executable).toBe(true);
    expect(result.reason).toBe('dependency_session');
    expect(caseObj._execReadiness).toBe('dependency_session');
    expect(caseObj.authSetupPlan).toBeUndefined();
    expect(caseObj.steps).toHaveLength(2);
  });

  it('detects case-level reliability defects without hiding the case', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'case-2',
      name: 'Admin Search',
      dataBinding: {
        sheet: 'Admin_UserSearch',
        rowSelector: 'all',
        source: 'proposed',
      },
      steps: [
        { order: 1, action: 'Navigate', target: 'Admin page', verify: { kind: 'visible' } },
        { order: 2, action: 'Fill', target: 'Username search field', value: '{{username}}' },
        { order: 3, action: 'Verify', target: 'Results', verify: { kind: 'none' }, expected: 'as expected' },
      ],
    });

    const codes = defects.map((defect) => defect.code);
    expect(codes).toContain('missing_row_execution_plan');
    expect(codes).toContain('proposed_data_mapping');
    expect(codes).toContain('token_collision');
    expect(codes).toContain('verify_kind_none');
  });

  it('flags Admin Search cases missing role and status fields', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'admin-case',
      name: 'Admin System User Search by username and employee name',
      module: 'Admin',
      coverageRefs: ['admin-system-user-search'],
      steps: [
        { order: 1, action: 'Navigate', target: 'Admin Users page', verify: { kind: 'visible' } },
        { order: 2, action: 'Fill', target: 'Username filter field', value: '{{usernamefilter}}' },
        { order: 3, action: 'Fill', target: 'Employee Name filter field', value: '{{employeename}}' },
        { order: 4, action: 'Click', target: 'Search button', verify: { kind: 'visible' }, expected: 'Results table visible' },
      ],
    });

    const missing = defects
      .filter((defect) => defect.code === 'missing_required_story_field')
      .map((defect) => defect.evidence.field);
    expect(missing).toContain('role');
    expect(missing).toContain('status');
  });

  it('flags Claim validation cases missing event, currency, and amount fields', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'claim-case',
      name: 'Claim request form validation for remarks',
      module: 'Claim',
      coverageRefs: ['claim-validation'],
      steps: [
        { order: 1, action: 'Navigate', target: 'Claim Submit page', verify: { kind: 'visible' } },
        { order: 2, action: 'Fill', target: 'Remarks field', value: '{{claimremarks}}' },
        { order: 3, action: 'Click', target: 'Submit button', verify: { kind: 'validation_message' }, expected: 'Required' },
      ],
    });

    const missing = defects
      .filter((defect) => defect.code === 'missing_required_story_field')
      .map((defect) => defect.evidence.field);
    expect(missing).toEqual(expect.arrayContaining(['event', 'currency', 'amount']));
    expect(missing).not.toContain('remarks');
  });

  it('builds a row execution plan for multi-row data cases', () => {
    const plan = contracts.buildRowExecutionPlan({
      id: 'pim-case',
      dataBinding: {
        sheet: 'PIM_EmployeeLifecycle',
        mappingStatus: 'approved',
        rows: [{ id: 'row-1' }, { id: 'row-2' }],
      },
    });

    expect(plan.executionMode).toBe('per_row');
    expect(plan.rowIds).toEqual(['row-1', 'row-2']);
  });

  it('flags skipped rows that have no reason', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'skip-case',
      name: 'PIM multi-row case',
      rowExecutionPlan: {
        rowIds: ['row-1'],
        executionMode: 'per_row',
        skippedRows: ['row-2'],
        skipReasons: {},
      },
      dataBinding: {
        sheet: 'PIM_EmployeeLifecycle',
        mappingStatus: 'approved',
        columnToField: { employeeid: 'Employee ID' },
      },
      steps: [
        { order: 1, action: 'Fill', target: 'Employee Id field', value: '{{employeeid}}', verify: { kind: 'visible' } },
      ],
      declaredAssertions: [{ type: 'TEXT', payload: { expectedText: 'Personal Details' } }],
    });

    expect(defects.map((defect) => defect.code)).toContain('silent_row_skip');
  });

  it('extracts approved data lineage for tokenized inputs', () => {
    const lineage = contracts.buildDataLineage({
      token: 'employeeid',
      rowId: 'row-1',
      binding: {
        sheet: 'PIM_EmployeeLifecycle',
        mappingStatus: 'approved',
        mappingVersion: 'v1',
        columnToField: { employeeid: 'Employee ID' },
      },
    });

    expect(lineage.sheetName).toBe('PIM_EmployeeLifecycle');
    expect(lineage.columnName).toBe('Employee ID');
    expect(lineage.mappingStatus).toBe('approved');
    expect(lineage.rowId).toBe('row-1');
  });

  it('flags reserved login tokens used as business filters', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'token-case',
      name: 'Admin System User Search',
      module: 'Admin',
      coverageRefs: ['admin-system-user-search'],
      steps: [
        { order: 1, action: 'Fill', target: 'Username search field', value: '{{loginusername}}' },
        { order: 2, action: 'Verify', target: 'Results table', verify: { kind: 'visible' } },
      ],
    });

    expect(defects.map((defect) => defect.code)).toContain('token_collision');
  });

  it('flags weak final business oracles', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'weak-case',
      name: 'PIM Save',
      steps: [
        { order: 1, action: 'Click', target: 'Save button', expected: 'page ready' },
      ],
    });

    expect(defects.map((defect) => defect.code)).toContain('weak_oracle');
  });

  it('does not emit reliability defects for a valid structured case', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'valid-case',
      name: 'PIM employee opens Personal Details',
      module: 'PIM',
      coverageRefs: ['pim-personal-details'],
      steps: [
        { order: 1, action: 'Navigate', target: 'PIM Add Employee page', verify: { kind: 'visible' }, expected: 'First Name field visible' },
        { order: 2, action: 'Fill', target: 'First Name field', value: 'QAAI' },
        { order: 3, action: 'Click', target: 'Save button', verify: { kind: 'text', text: 'Personal Details' }, expected: 'Personal Details' },
      ],
      declaredAssertions: [{ type: 'TEXT', payload: { expectedText: 'Personal Details' } }],
    });

    expect(defects).toEqual([]);
  });

  it('uses manifest-required fields instead of title heuristics only', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'manifest-case',
      name: 'Custom required field case',
      coverageRefs: ['cov-custom-admin'],
      steps: [
        { order: 1, action: 'Fill', target: 'Username filter field', value: '{{usernamefilter}}' },
        { order: 2, action: 'Verify', target: 'Result row', verify: { kind: 'text', text: 'Records Found' } },
      ],
    }, {}, {
      coverageManifest: {
        items: [
          { manifestItemId: 'cov-custom-admin', requiredFields: ['role'] },
        ],
      },
    });

    expect(defects.some((defect) => defect.code === 'missing_required_story_field' && defect.evidence.field === 'role')).toBe(true);
  });

  it('does not count field words in title or expected text as required-field coverage', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'title-only-case',
      name: 'Admin Search with role and status',
      coverageRefs: ['cov-admin-title-only'],
      steps: [
        { order: 1, action: 'Fill', target: 'Username filter field', value: '{{usernamefilter}}', expected: 'Role and status filters are available' },
        { order: 2, action: 'Verify', target: 'Result row', verify: { kind: 'text', text: 'Records Found' } },
      ],
    }, {}, {
      coverageManifest: {
        items: [
          { manifestItemId: 'cov-admin-title-only', requiredFields: ['role', 'status'] },
        ],
      },
    });

    const missing = defects
      .filter((defect) => defect.code === 'missing_required_story_field')
      .map((defect) => defect.evidence.field);
    expect(missing).toEqual(expect.arrayContaining(['role', 'status']));
  });

  it('attaches data lineage for every intended row', () => {
    const artifacts = contracts.buildCaseReliabilityArtifacts({
      id: 'lineage-case',
      dataBinding: {
        sheet: 'PIM_EmployeeLifecycle',
        mappingStatus: 'approved',
        rows: [{ id: 'row-1' }, { id: 'row-2' }],
        columnToField: { employeeid: 'Employee ID' },
      },
      steps: [
        { order: 1, action: 'Fill', target: 'Employee Id field', value: '{{employeeid}}', verify: { kind: 'text', text: 'Personal Details' } },
      ],
    });

    expect(artifacts.dataLineage.map((lineage) => lineage.rowId)).toEqual(['row-1', 'row-2']);
    expect(artifacts.dataLineage.every((lineage) => lineage.mappingStatus === 'approved')).toBe(true);
  });

  it('flags one proposed row in a multi-row case', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'row-proposed-case',
      dataBinding: {
        sheet: 'PIM_EmployeeLifecycle',
        mappingStatus: 'approved',
        rows: [{ id: 'row-1' }, { id: 'row-2', mappingStatus: 'proposed' }],
        columnToField: { employeeid: 'Employee ID' },
      },
      steps: [
        { order: 1, action: 'Fill', target: 'Employee Id field', value: '{{employeeid}}' },
        { order: 2, action: 'Verify', target: 'Personal Details', verify: { kind: 'text', text: 'Personal Details' } },
      ],
    });

    expect(defects.some((defect) => defect.code === 'proposed_data_mapping' && defect.rowId === 'row-2')).toBe(true);
  });

  it('treats visible page-ready final checks as weak business oracles', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'visible-page-ready',
      name: 'Save form',
      steps: [
        { order: 1, action: 'Click', target: 'Save button', verify: { kind: 'visible', target: 'page' }, expected: 'page ready' },
      ],
    });

    const codes = defects.map((defect) => defect.code);
    expect(codes).toContain('missing_structured_oracle');
    expect(codes).toContain('weak_oracle');
  });

  it('accepts a complete Admin Search case with username, role, employee name, and status', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'admin-valid',
      name: 'Admin System User Search',
      module: 'Admin',
      coverageRefs: ['admin-system-user-search'],
      steps: [
        { order: 1, action: 'Navigate', target: 'Admin Users page', verify: { kind: 'visible' } },
        { order: 2, action: 'Fill', target: 'Username filter field', value: '{{usernamefilter}}' },
        { order: 3, action: 'Select', target: 'User Role dropdown', value: '{{userrolefilter}}' },
        { order: 4, action: 'Fill', target: 'Employee Name filter field', value: '{{employeename}}' },
        { order: 5, action: 'Select', target: 'Status dropdown', value: '{{statusfilter}}' },
        { order: 6, action: 'Click', target: 'Search button' },
        { order: 7, action: 'Verify', target: 'Result row', verify: { kind: 'text', text: 'Records Found' } },
      ],
      declaredAssertions: [{ type: 'TEXT', payload: { expectedText: 'Records Found' } }],
    });

    expect(defects).toEqual([]);
  });

  it('accepts a complete Claim validation case with event, currency, amount, and remarks', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'claim-valid',
      name: 'Claim request form validation',
      module: 'Claim',
      coverageRefs: ['claim-validation'],
      steps: [
        { order: 1, action: 'Navigate', target: 'Claim Submit page', verify: { kind: 'visible' } },
        { order: 2, action: 'Select', target: 'Event dropdown', value: '{{claimevent}}' },
        { order: 3, action: 'Select', target: 'Currency dropdown', value: '{{claimcurrency}}' },
        { order: 4, action: 'Fill', target: 'Amount field', value: '{{claimamount}}' },
        { order: 5, action: 'Fill', target: 'Remarks field', value: '{{claimremarks}}' },
        { order: 6, action: 'Click', target: 'Submit button' },
        { order: 7, action: 'Verify', target: 'Claim validation message', verify: { kind: 'validation_message', text: 'Required' }, expected: 'Required' },
      ],
      declaredAssertions: [{ type: 'TEXT', payload: { expectedText: 'Required' } }],
    });

    expect(defects).toEqual([]);
  });
});
