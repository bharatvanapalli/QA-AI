import { describe, expect, it } from 'vitest';
import pipeline from '../../server/services/reliability/selfHealingPipeline.js';
import contracts from '../../server/services/reliability/contracts.js';

function orangeHrmManifest() {
  return {
    items: [
      {
        manifestItemId: 'admin-search',
        title: 'Admin system user search by username, role, employee name, and status',
        module: 'Admin',
        required: true,
        storyRef: { id: 'US-OHRM-ADMIN-SEARCH', title: 'Search system users' },
        requiredFields: ['username', 'role', 'employee name', 'status'],
        requiredOracles: [{ kind: 'table_row', target: 'System Users results table', expected: 'matching user row', source: 'story', required: true }],
        dataSource: {
          sheet: 'Admin_SystemUserSearch',
          rows: ['row-1', 'row-2'],
          rowSelector: 'all',
          placeholders: ['usernamefilter', 'userrolefilter', 'employeename', 'statusfilter'],
        },
      },
      {
        manifestItemId: 'claim-validation',
        title: 'Claim request form validation for event, currency, amount, and remarks',
        module: 'Claim',
        required: true,
        storyRef: { id: 'US-OHRM-CLAIM-VALIDATION', title: 'Validate claim required fields' },
        requiredFields: ['event', 'currency', 'amount', 'remarks'],
        requiredOracles: [{ kind: 'validation_message', target: 'Claim required fields', expected: 'Required', source: 'story', required: true }],
        dataSource: {
          sheet: 'Claim_Validation',
          rows: ['claim-row-1'],
          rowSelector: 'validation',
          placeholders: ['claimevent', 'claimcurrency', 'claimamount', 'claimremarks'],
        },
      },
    ],
  };
}

function defectCodes(scenarios, manifest) {
  return contracts.collectScenarioReliabilityDefects(scenarios, { coverageManifest: manifest })
    .map((defect) => defect.code);
}

describe('generation self-healing pipeline', () => {
  it('builds pre-generation CaseContractPacks with fields, tokens, rows, and oracle', () => {
    const appCapabilityMap = {
      fields: [
        {
          id: 'field_username',
          label: 'Username',
          type: 'text',
          locatorStrategy: 'label',
          selectorConfidence: 0.91,
        },
      ],
    };
    const packs = pipeline.buildCaseContractPacks({ manifest: orangeHrmManifest(), appCapabilityMap });
    const adminPack = packs.find((pack) => pack.coverageRef === 'admin-search');
    const block = pipeline.renderCaseContractPackBlock(packs);

    expect(adminPack.requiredFields).toEqual(['username', 'role', 'employee name', 'status']);
    expect(adminPack.semanticTokenMap.username).toBe('{{usernamefilter}}');
    expect(adminPack.rowIntent.rowIds).toEqual(['row-1', 'row-2']);
    expect(adminPack.requiredOracle.kind).toBe('table_row');
    expect(adminPack.capabilityHints.some((hint) => hint.label === 'Username' && hint.locatorStrategy === 'label')).toBe(true);
    expect(block).toContain('CASE CONTRACT PACKS');
    expect(block).toContain('Username:label:0.91');
    expect(block).toContain('admin-search');
  });

  it('applies benchmark-critical defaults during self-healing, not only pack selection', async () => {
    const manifest = {
      items: [{
        coverageRef: 'cov::req-pim-lifecycle::standard',
        requirementId: 'REQ-PIM-LIFE',
        title: 'Save and verify the Personal Details page opens for the created employee.',
        module: 'PIM',
        required: false,
        dataSource: {
          sheet: 'PIM_EmployeeLifecycle',
          rowSelector: 'positive',
        },
      }],
    };
    const testData = {
      sheets: [{
        name: 'PIM_EmployeeLifecycle',
        rows: [
          { FirstName: 'QA', MiddleName: 'Auto', LastName: 'User', EmployeeId: 'QA001' },
          { FirstName: 'QA', MiddleName: 'Bound', LastName: 'User', EmployeeId: 'QA002' },
        ],
      }],
    };
    const scenarios = [{
      id: 'scenario-pim',
      name: 'PIM employee lifecycle',
      module: 'PIM',
      cases: [{
        id: 'case-pim',
        name: 'Create employee and verify personal details',
        module: 'PIM',
        coverageRefs: ['cov::req-pim-lifecycle::standard'],
        dataBinding: { sheet: 'PIM_EmployeeLifecycle', source: 'proposed' },
        steps: [
          { action: 'Navigate', target: 'PIM page' },
          { action: 'Click', target: 'Save button', verify: { kind: 'none' } },
        ],
      }],
    }];

    const result = await pipeline.runGenerationSelfHealingPipeline({
      scenarios,
      manifest,
      testData,
      enableTargetedRepair: true,
    });

    const repairedCase = result.scenarios[0].cases[0];
    const targets = repairedCase.steps.map((step) => String(step.target || '').toLowerCase());
    const values = repairedCase.steps.map((step) => String(step.value || ''));
    const phase45 = repairedCase.qualityContract.phase45;

    expect(targets.some((target) => target.includes('first name'))).toBe(true);
    expect(targets.some((target) => target.includes('middle name'))).toBe(true);
    expect(targets.some((target) => target.includes('last name'))).toBe(true);
    expect(targets.some((target) => target.includes('employee id'))).toBe(true);
    expect(values).toEqual(expect.arrayContaining([
      '{{firstname}}',
      '{{middlename}}',
      '{{lastname}}',
      '{{employeeid}}',
    ]));
    expect(repairedCase.rowExecutionPlan.rowIntents).toEqual(expect.arrayContaining(['positive', 'boundary']));
    expect(repairedCase.rowExecutionPlan.rowIds).toEqual(['row-1', 'row-2']);
    expect(phase45.rowExecutionPlan.rowIntents).toEqual(expect.arrayContaining(['positive', 'boundary']));
    expect(phase45.structuredOracles.some((oracle) => oracle.target === 'Personal Details')).toBe(true);
  });

  it('links coverage, rewrites legacy tokens, builds row plans, lineage, and structured Admin Search fields before persistence', async () => {
    const manifest = orangeHrmManifest();
    const scenarios = [{
      id: 'scenario-admin',
      name: 'Admin System User Search',
      module: 'Admin',
      cases: [{
        id: 'case-admin',
        name: 'Search system users by username and employee name',
        module: 'Admin',
        caseIntent: 'admin_search',
        dataBinding: { sheet: 'Admin_SystemUserSearch', source: 'proposed' },
        steps: [
          { action: 'Fill', target: 'Username filter', value: '{{username}}' },
          { action: 'Fill', target: 'Employee Name filter', value: '{{employeename}}' },
          { action: 'Click', target: 'Search button', expected: 'page ready', verify: { kind: 'none' } },
        ],
      }],
    }];

    const result = await pipeline.runGenerationSelfHealingPipeline({
      scenarios,
      manifest,
      enableTargetedRepair: true,
    });

    const repairedCase = result.scenarios[0].cases[0];
    const codes = defectCodes(result.scenarios, manifest);

    expect(repairedCase.coverageRefs).toContain('admin-search');
    expect(repairedCase.rowExecutionPlan.rowIds).toEqual(['row-1', 'row-2']);
    expect(repairedCase.dataBinding.rowExecutionPlan.rowIds).toEqual(['row-1', 'row-2']);
    expect(repairedCase.steps.some((step) => step.value === '{{usernamefilter}}')).toBe(true);
    expect(repairedCase.steps.some((step) => /role/i.test(step.target) && step.action === 'Select')).toBe(true);
    expect(repairedCase.steps.some((step) => /status/i.test(step.target) && step.action === 'Select')).toBe(true);
    expect(repairedCase.dataLineage.length).toBeGreaterThan(0);
    expect(repairedCase.qualityContract.phase45.rowExecutionPlan.rowIds).toEqual(['row-1', 'row-2']);
    expect(repairedCase.qualityContract.phase45.dataLineage.length).toBeGreaterThan(0);
    expect(codes).not.toContain('missing_row_execution_plan');
    expect(codes).not.toContain('missing_data_lineage');
    expect(codes).not.toContain('token_collision');
    expect(codes).not.toContain('verify_kind_none');
    expect(codes).not.toContain('missing_structured_oracle');
    expect(codes).not.toContain('missing_required_story_field');
  });

  it('uses workbook rows for RowExecutionPlan when manifest row IDs are absent', async () => {
    const manifest = {
      items: [{
        manifestItemId: 'admin-search',
        title: 'Admin system user search by username, role, employee name, and status',
        module: 'Admin',
        required: true,
        storyRef: { id: 'US-OHRM-ADMIN-SEARCH', title: 'Search system users' },
        requiredFields: ['username', 'role', 'employee name', 'status'],
        requiredOracles: [{ kind: 'table_row', target: 'System Users results table', expected: 'matching user row', source: 'story', required: true }],
        dataSource: {
          sheet: 'Admin_SystemUserSearch',
          rowSelector: 'all',
          placeholders: ['usernamefilter', 'userrolefilter', 'employeename', 'statusfilter'],
        },
      }],
    };
    const testData = {
      sheets: [{
        name: 'Admin_SystemUserSearch',
        rows: [
          { Username: 'Admin', Role: 'Admin' },
          { Username: 'ESSUser', Role: 'ESS' },
        ],
      }],
    };
    const scenarios = [{
      id: 'scenario-admin',
      name: 'Admin System User Search',
      module: 'Admin',
      cases: [{
        id: 'case-admin',
        name: 'Search system users by Username',
        module: 'Admin',
        dataBinding: { sheet: 'Admin_SystemUserSearch', source: 'proposed' },
        steps: [
          { action: 'Fill', target: 'Username', value: '{{username}}' },
          { action: 'Click', target: 'Search button', expected: 'matching user row', verify: { kind: 'text', target: 'System Users results table', expected: 'matching user row' } },
        ],
      }],
    }];

    const result = await pipeline.runGenerationSelfHealingPipeline({
      scenarios,
      manifest,
      testData,
      enableTargetedRepair: true,
    });

    const repairedCase = result.scenarios[0].cases[0];
    expect(repairedCase.rowExecutionPlan.rowIds).toEqual(['row-1', 'row-2']);
    expect(repairedCase.steps.some((step) => step.target === 'Username' && step.value === '{{usernamefilter}}')).toBe(true);
  });

  it('keeps injected login tokens auth-scoped while repairing Admin Search business tokens', async () => {
    const manifest = {
      items: [{
        manifestItemId: 'admin-search',
        title: 'Admin system user search by username, role, employee name, and status',
        module: 'Admin',
        required: true,
        storyRef: { id: 'US-OHRM-ADMIN-SEARCH', title: 'Search system users' },
        requiredFields: ['username', 'role', 'employee name', 'status'],
        requiredOracles: [{ kind: 'table_row', target: 'System Users results table', expected: 'matching user row', source: 'story', required: true }],
        dataSource: {
          sheet: 'Admin_SystemUserSearch',
          rowSelector: 'all',
          placeholders: ['usernamefilter', 'userrolefilter', 'employeename', 'statusfilter'],
        },
      }],
    };
    const testData = {
      sheets: [{
        name: 'Admin_SystemUserSearch',
        rows: [
          { Username: 'Admin', Role: 'Admin', EmployeeName: 'QAAI Alpha', Status: 'Enabled' },
          { Username: 'ESSUser', Role: 'ESS', EmployeeName: 'QAAI Beta', Status: 'Disabled' },
        ],
      }],
    };
    const scenarios = [{
      id: 'scenario-admin',
      name: 'Admin System User Search',
      module: 'Admin',
      cases: [{
        id: 'case-admin',
        name: 'Search system users by username',
        module: 'Admin',
        dataBinding: { sheet: 'Admin_SystemUserSearch', source: 'proposed' },
        steps: [
          { action: 'Navigate', target: 'OrangeHRM login page', value: 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login' },
          { action: 'Fill', target: 'Username', value: '{{username}}' },
          { action: 'Fill', target: 'Password', value: '{{password}}' },
          { action: 'Click', target: 'Login button' },
          { action: 'Fill', target: 'Username', value: '{{username}}' },
          { action: 'Click', target: 'Search button', expected: 'page ready', verify: { kind: 'none' } },
        ],
      }],
    }];

    const result = await pipeline.runGenerationSelfHealingPipeline({
      scenarios,
      manifest,
      testData,
      context: { authRole: 'ADMIN_DEFAULT' },
      enableTargetedRepair: true,
    });

    const repairedCase = result.scenarios[0].cases[0];
    const fillSteps = repairedCase.steps.filter((step) => step.action === 'Fill' && step.target === 'Username');
    const codes = defectCodes(result.scenarios, manifest);

    expect(fillSteps.some((step) => step.value === '{{loginusername}}')).toBe(true);
    expect(fillSteps.some((step) => step.value === '{{usernamefilter}}')).toBe(true);
    expect(repairedCase.rowExecutionPlan.rowIds).toEqual(['row-1', 'row-2']);
    expect(repairedCase.dataLineage.some((lineage) => lineage.sheetName === 'ExecutionProfile' && lineage.token === 'loginusername')).toBe(true);
    expect(repairedCase.dataLineage.some((lineage) => lineage.sheetName === 'Admin_SystemUserSearch' && lineage.token === 'usernamefilter')).toBe(true);
    expect(codes).not.toContain('missing_row_execution_plan');
    expect(codes).not.toContain('missing_data_lineage');
    expect(codes).not.toContain('token_collision');
    expect(codes).not.toContain('verify_kind_none');
    expect(codes).not.toContain('weak_oracle');
  });

  it('persists suite output with report defects instead of throwing for repairable quality issues', async () => {
    const manifest = {
      items: [
        {
          manifestItemId: 'required-admin-search',
          title: 'Required Admin Search coverage',
          module: 'Admin',
          required: true,
          requiredFields: ['username', 'role'],
          requiredOracles: [{ kind: 'table_row', target: 'System Users results table', expected: 'matching user row', source: 'story', required: true }],
        },
      ],
    };
    const scenarios = [{
      id: 'scenario-loose',
      name: 'Loose exploratory case',
      module: 'Admin',
      cases: [{
        id: 'case-loose',
        name: 'Loose case with unresolved quality defects',
        module: 'Admin',
        steps: [
          { action: 'teleport', target: 'Something', value: '{{username}}', expected: 'page ready', verify: { kind: 'none' } },
        ],
      }],
    }];

    const result = await pipeline.runGenerationSelfHealingPipeline({
      scenarios,
      manifest,
      enableTargetedRepair: false,
    });

    const codes = result.reliabilityReport.unresolvedDefects.map((defect) => defect.code);
    expect(result.scenarios).toHaveLength(1);
    expect(codes).toContain('unregistered_browser_action');
    expect(codes.length).toBeGreaterThan(0);
  });

  it('uses the final deterministic pass to add missing required coverage and clean mapped action aliases', async () => {
    const manifest = orangeHrmManifest();
    const scenarios = [{
      id: 'scenario-claim-only',
      name: 'Claim validation only',
      module: 'Claim',
      cases: [{
        id: 'case-claim-only',
        name: 'Claim required validation',
        module: 'Claim',
        coverageRefs: ['claim-validation'],
        dataBinding: { sheet: 'Claim_Validation', source: 'proposed' },
        steps: [
          { action: 'Fill', target: 'Remarks field', value: '{{claimremarks}}' },
          { action: 'tap', target: 'Submit button', expected: 'page ready', verify: { kind: 'none' } },
        ],
      }],
    }];

    const result = await pipeline.runGenerationSelfHealingPipeline({
      scenarios,
      manifest,
      enableTargetedRepair: true,
    });

    const refs = result.scenarios.flatMap((scenario) => scenario.cases.flatMap((caseObj) => caseObj.coverageRefs || []));
    const actions = result.scenarios.flatMap((scenario) => scenario.cases.flatMap((caseObj) => caseObj.steps.map((step) => step.action)));
    const codes = result.defects.map((defect) => defect.code);

    expect(refs).toContain('admin-search');
    expect(refs).toContain('claim-validation');
    expect(actions).toContain('Click');
    expect(codes).not.toContain('coverage_missing_required');
    expect(codes).not.toContain('coverage_required_missing');
    expect(codes).not.toContain('unregistered_browser_action');
    expect(codes).not.toContain('verify_kind_none');
    expect(codes).not.toContain('weak_oracle');
  });

  it('patches Claim validation with event, currency, amount, remarks, and a validation oracle', async () => {
    const manifest = orangeHrmManifest();
    const scenarios = [{
      id: 'scenario-claim',
      name: 'Claim Submit and Validation',
      module: 'Claim',
      cases: [{
        id: 'case-claim',
        name: 'Validate claim request required fields',
        module: 'Claim',
        caseIntent: 'claim_validation',
        dataBinding: { sheet: 'Claim_Validation', source: 'proposed' },
        steps: [
          { action: 'Fill', target: 'Remarks field', value: '{{claimremarks}}' },
          { action: 'Click', target: 'Submit button', expected: 'success', verify: { kind: 'none' } },
        ],
      }],
    }];

    const result = await pipeline.runGenerationSelfHealingPipeline({
      scenarios,
      manifest,
      enableTargetedRepair: true,
    });

    const repairedCase = result.scenarios[0].cases[0];
    const targets = repairedCase.steps.map((step) => step.target);
    const codes = defectCodes(result.scenarios, manifest);

    expect(repairedCase.coverageRefs).toContain('claim-validation');
    expect(targets).toEqual(expect.arrayContaining(['Event field', 'Currency field', 'Amount field', 'Remarks field']));
    expect(repairedCase.oracles.some((oracle) => oracle.kind === 'validation_message' && oracle.target === 'Claim required fields')).toBe(true);
    expect(repairedCase.rowExecutionPlan.rowIds).toEqual(['claim-row-1']);
    expect(codes).not.toContain('missing_required_story_field');
    expect(codes).not.toContain('verify_kind_none');
    expect(codes).not.toContain('weak_oracle');
  });

  it('runs targeted repair for browser action names deterministic normalization cannot map', async () => {
    const manifest = orangeHrmManifest();
    const scenarios = [{
      id: 'scenario-admin',
      name: 'Admin System User Search',
      module: 'Admin',
      cases: [{
        id: 'case-admin',
        name: 'Search system users by username role employee name status',
        module: 'Admin',
        caseIntent: 'admin_search',
        coverageRefs: ['admin-search'],
        dataBinding: { sheet: 'Admin_SystemUserSearch', source: 'proposed' },
        steps: [
          { action: 'Fill', target: 'Username filter', value: '{{usernamefilter}}' },
          { action: 'Select', target: 'User Role filter', value: '{{userrolefilter}}' },
          { action: 'Fill', target: 'Employee Name filter', value: '{{employeename}}' },
          { action: 'Select', target: 'Status filter', value: '{{statusfilter}}' },
          { action: 'tap', target: 'Search button', expected: 'matching user row', verify: { kind: 'text', target: 'System Users results table', expected: 'matching user row' } },
        ],
      }],
    }];

    const result = await pipeline.runGenerationSelfHealingPipeline({
      scenarios,
      manifest,
      enableTargetedRepair: true,
    });

    const actions = result.scenarios[0].cases[0].steps.map((step) => step.action);
    const codes = defectCodes(result.scenarios, manifest);

    expect(actions).toContain('Click');
    expect(codes).not.toContain('unregistered_browser_action');
  });
});
