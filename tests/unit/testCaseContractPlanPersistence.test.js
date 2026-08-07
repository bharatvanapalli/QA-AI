import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const testCaseContract = require('../../server/services/testCaseContract');
const stepCompiler = require('../../server/services/testDesignStepCompiler');

function compiledPlanCase(overrides = {}) {
  const lineage = {
    version: 'TestDesignPlanV1',
    planId: 'tdp_plan_backed_persistence',
    revision: 'plan-revision-1',
    planCaseId: 'tdpc-login',
    caseRevision: 'case-revision-1',
  };
  const row = {
    name: 'Login keeps its frozen data pins',
    type: 'functional',
    module: 'identity',
    confidence: 95,
    automatability: 'automatable',
    businessRisk: 'P1',
    assertions: 'Verify the final page displays Welcome.',
    planCaseId: lineage.planCaseId,
    planRevision: lineage.revision,
    caseRevision: lineage.caseRevision,
    intent: 'Authenticate the selected user',
    storyId: 'US-LOGIN',
    requirementRefs: ['clause-login'],
    requirementRevisions: [{ id: 'clause-login', digest: 'sha256:clause-login' }],
    coverageRef: 'cov-login',
    primaryCoverageRef: 'cov-login',
    coverageRefs: ['cov-login'],
    initialState: { description: 'Public login page' },
    expectedFinalState: { description: 'Authenticated home page' },
    sessionRequirement: { required: false, mode: 'fresh' },
    dependencies: [],
    dependsOnIds: [],
    sessionMode: 'fresh',
    failurePolicy: 'continue_independent',
    dataBinding: {
      status: 'complete',
      source: 'test_design_plan',
      approved: true,
      testDataSetId: 'dataset-b',
      mappingId: 'mapping-b',
      mappingVersion: 7,
      workbookHash: 'workbook-b',
      datasetRevisionId: 'dataset-revision-b',
      sheetId: 'sheet-b',
      rowGroupId: 'row-group-b',
      sheet: 'LoginRows',
      rowSelector: 'all',
      rowIds: ['row-b'],
      columnToField: { password: 'Password' },
      expectedColumn: 'Expected URL',
      rowClassColumn: null,
      planId: lineage.planId,
      planRevision: lineage.revision,
      planCaseId: lineage.planCaseId,
      caseRevision: lineage.caseRevision,
    },
    rowExecutionPlan: {
      version: 1,
      mode: 'matrix',
      sheet: 'LoginRows',
      rowSelector: 'all',
      rowIds: ['row-b'],
      dataBindingId: 'mapping-b',
      mappingVersion: 7,
      workbookHash: 'workbook-b',
      datasetRevisionId: 'dataset-revision-b',
      sheetId: 'sheet-b',
      rowGroupId: 'row-group-b',
    },
    oracles: [{
      oracleRef: 'login-url',
      kind: 'url',
      target: 'url',
      expected: '{{expected}}',
      required: true,
    }],
    declaredAssertions: [{
      id: 'login-url',
      oracleRef: 'login-url',
      kind: 'url',
      channel: 'url',
      type: 'URL',
      target: 'url',
      expected: '{{expected}}',
      required: true,
      criticality: 'must',
      provenance: 'requirement',
      payload: { expectedUrlPattern: '{{expected}}' },
    }],
    steps: [{
      id: 'tdpc-login_step_001',
      ordinal: 1,
      action: 'fill',
      target: 'Password',
      value: '{{password}}',
      dataRefs: ['data.password'],
    }],
    qualityContract: { testDesignPlan: { ...lineage } },
    testDesignPlanRef: { ...lineage },
    ...overrides,
  };
  const compiledCaseRevision = stepCompiler.compiledCaseRevision(row);
  row.compiledCaseRevision = compiledCaseRevision;
  row.qualityContract.testDesignPlan.compiledCaseRevision = compiledCaseRevision;
  row.testDesignPlanRef.compiledCaseRevision = compiledCaseRevision;
  return row;
}

describe('plan-backed TestCaseContract persistence', () => {
  it('persists strict compiler steps, assertions, and exact data pins without legacy inference or sheet-name rebinding', async () => {
    const created = [];
    const prisma = {
      requirementClause: {
        findMany: async () => [{ id: 'clause-login', storyId: 'US-LOGIN' }],
      },
      testCase: {
        create: async ({ data }) => {
          created.push(data);
          return { id: 'tc-login', ...data };
        },
        update: async () => ({}),
      },
    };
    const source = compiledPlanCase();
    const expectedSteps = structuredClone(source.steps);
    const expectedAssertions = structuredClone(source.declaredAssertions);
    const expectedBinding = structuredClone(source.dataBinding);

    await testCaseContract.persistCases({
      prisma,
      projectId: 'project-1',
      scenarioId: 'scenario-1',
      generationId: 'generation-1',
      moduleName: 'identity',
      cases: [source],
      approvedTestData: {
        mapping: {
          status: 'approved',
          bindings: [
            {
              sheet: 'LoginRows',
              testDataSetId: 'dataset-a',
              mappingId: 'mapping-a',
              mappingVersion: 99,
              columnToField: { password: 'Password' },
            },
            {
              sheet: 'LoginRows',
              testDataSetId: 'dataset-b',
              mappingId: 'mapping-b',
              mappingVersion: 7,
              columnToField: { password: 'Password' },
            },
          ],
        },
      },
      log: { info() {}, warn() {} },
    });

    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0].steps)).toEqual(expectedSteps);
    expect(JSON.parse(created[0].steps)[0].value).toBe('{{password}}');
    expect(JSON.parse(created[0].declaredAssertions)).toEqual(expectedAssertions);
    expect(JSON.parse(created[0].dataBindingJson)).toEqual(expectedBinding);
    expect(JSON.parse(created[0].dataBindingJson)).not.toHaveProperty('rowExecutionPlan');
  });

  it('fails closed when a plan-backed case reaches persistence without its compiler revision', async () => {
    const source = compiledPlanCase();
    delete source.compiledCaseRevision;
    const prisma = {
      requirementClause: { findMany: async () => [] },
      testCase: { create: async () => { throw new Error('must not write'); } },
    };

    await expect(testCaseContract.persistCases({
      prisma,
      projectId: 'project-1',
      scenarioId: 'scenario-1',
      cases: [source],
    })).rejects.toMatchObject({ code: 'TEST_DESIGN_COMPILED_CASE_INVALID' });
  });

  it('fails closed when core data pins change after strict compilation', async () => {
    const source = compiledPlanCase();
    source.dataBinding.mappingId = 'mapping-rebound-after-compilation';
    const prisma = {
      requirementClause: { findMany: async () => [] },
      testCase: { create: async () => { throw new Error('must not write'); } },
    };

    await expect(testCaseContract.persistCases({
      prisma,
      projectId: 'project-1',
      scenarioId: 'scenario-1',
      cases: [source],
    })).rejects.toMatchObject({ code: 'TEST_DESIGN_COMPILED_CASE_INVALID' });
  });

  it('fails closed when persistence tries to override the compiled auth profile', async () => {
    const source = compiledPlanCase({ authProfile: 'primary-user' });
    const create = vi.fn(async () => { throw new Error('must not write'); });
    const prisma = {
      requirementClause: { findMany: async () => [] },
      testCase: { create },
    };

    await expect(testCaseContract.persistCases({
      prisma,
      projectId: 'project-1',
      scenarioId: 'scenario-1',
      cases: [source],
      authProfileName: 'administrator',
    })).rejects.toMatchObject({ code: 'TEST_DESIGN_COMPILED_CASE_INVALID' });

    expect(create).not.toHaveBeenCalled();
  });

  it('persists the compiler-owned auth profile after an equivalent caller value is verified', async () => {
    const source = compiledPlanCase({ authProfile: 'primary-user' });
    const created = [];
    const prisma = {
      requirementClause: { findMany: async () => [] },
      testCase: {
        create: async ({ data }) => {
          created.push(data);
          return { id: 'tc-login', ...data };
        },
        update: async () => ({}),
      },
    };

    await testCaseContract.persistCases({
      prisma,
      projectId: 'project-1',
      scenarioId: 'scenario-1',
      cases: [source],
      authProfileName: '  primary-user  ',
    });

    expect(created).toHaveLength(1);
    expect(created[0].authProfile).toBe('primary-user');
  });
});
