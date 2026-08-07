import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const planner = require('../../server/services/testDesignPlanV1');
const compiler = require('../../server/services/testDesignStepCompiler');

function planFixture() {
  return planner.buildTestDesignPlanV1({
    coverageManifest: {
      version: 1,
      items: [{
        manifestItemId: 'cov-login',
        required: true,
        storyRef: { id: 'US-LOGIN', title: 'Login', moduleHint: 'identity' },
        dataSource: {
          sheet: 'LoginRows',
          rows: [0],
          rowSelector: 'story:us-login',
          placeholders: ['email', 'password'],
          expectedToken: 'expected',
          expectedColumn: 'Expected URL',
        },
      }],
    },
    caseContractPacks: [{
      coverageRef: 'cov-login',
      storyId: 'US-LOGIN',
      module: 'identity',
      title: 'Login',
      pageIntent: 'Login',
      initialState: { description: 'Public login page' },
      expectedFinalState: { description: 'Authenticated home page' },
      sessionRequirement: { required: false, mode: 'fresh' },
      dependencies: [{ from: 'fill-password', to: 'submit' }],
      failurePolicy: { requiredInput: 'stop_descendants', validationMismatch: 'continue' },
      requiredActions: ['fill', 'fill', 'click'],
      requiredFields: ['email', 'password'],
      semanticTokenMap: { email: '{{email}}', password: '{{password}}' },
      rowIntent: { sheet: 'LoginRows', rowSelector: 'story:us-login', rowIds: [0] },
      requiredOracle: {
        id: 'login-destination',
        kind: 'url',
        target: 'url',
        expected: '{{expected}}',
        token: 'expected',
        required: true,
      },
      caseContractV1: {
        version: 'CaseContractV1',
        id: 'case-login',
        steps: [],
        assertions: [{
          id: 'login-destination',
          type: 'AssertUrl',
          comparator: 'url_matches',
          expected: '{{expected}}',
          targetIdentity: { name: 'browser URL' },
          payload: {
            channel: 'url',
            operands: [
              { role: 'actual', kind: 'target_property', property: 'url' },
              { role: 'expected', kind: 'url', value: '{{expected}}' },
            ],
          },
          sourceQuote: 'A valid user reaches the home URL.',
          sourceSpan: { requirementId: 'clause-login', start: 0, end: 34 },
          sourceClauseRefs: ['clause-login'],
          failureBehavior: 'continue',
          stepId: null,
          dataRefs: ['data.expected'],
          required: true,
        }],
      },
    }],
    requirements: [{ id: 'clause-login', storyId: 'US-LOGIN', content: 'A valid user reaches the home URL.' }],
    dataset: {
      source: 'approved',
      workbookContract: { fileHash: 'workbook-login-v1' },
      testData: {
        sheets: [{
          name: 'LoginRows',
          datasetRevisionId: 'dataset-revision-login',
          sheetId: 'sheet-login',
          rows: [{ Email: 'person@example.test', Password: 'Raw-Secret-Value', 'Expected URL': '/home' }],
        }],
        mapping: {
          status: 'approved',
          sources: [{ testDataSetId: 'dataset-login', mappingId: 'mapping-login', version: 4, status: 'approved' }],
          bindings: [{
            storyId: 'US-LOGIN',
            sheet: 'LoginRows',
            datasetRevisionId: 'dataset-revision-login',
            sheetId: 'sheet-login',
            rowGroupId: 'row-group-login',
            columnToField: { email: 'Email', password: 'Password' },
            expectedColumn: 'Expected URL',
            testDataSetId: 'dataset-login',
            mappingId: 'mapping-login',
            mappingVersion: 4,
          }],
        },
      },
    },
  });
}

function validCandidate(plan = planFixture()) {
  const casePlan = plan.scenarios[0].cases[0];
  return [{
    name: 'Model-authored scenario name',
    cases: [{
      planCaseId: casePlan.planCaseId,
      name: 'Model-authored case name',
      storyId: 'WRONG-STORY',
      requirementRefs: ['wrong-clause'],
      coverageRefs: ['wrong-coverage'],
      sessionRequirement: { required: true, mode: 'continue' },
      dataBinding: { sheet: 'WrongSheet', mappingId: 'latest-draft' },
      steps: [
        { action: 'fill', target: 'Email', value: '{{email}}' },
        { action: 'fill', target: 'Password', value: '{{password}}' },
        { action: 'click', target: 'Sign in' },
      ],
      declaredAssertions: [{
        oracleRef: 'login-destination',
        type: 'URL',
        target: 'browser URL',
        payload: { expectedUrlPattern: '{{expected}}' },
      }],
      qualityContract: { existingRule: true },
    }],
  }];
}

function compile(plan, scenarios = validCandidate(plan)) {
  return compiler.compileCandidateSuite({ testDesignPlan: plan, candidateScenarios: scenarios });
}

function expectFinding(fn, code) {
  try {
    fn();
    throw new Error('Expected compilation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(compiler.TestDesignStepCompilationError);
    expect(error.code).toBe(compiler.COMPILATION_ERROR_CODE);
    expect(error.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  }
}

describe('TestDesignStepCompiler', () => {
  it('compiles only an exact planCaseId and canonicalizes lineage, binding, session, oracle, and step data refs', () => {
    const plan = planFixture();
    const candidates = validCandidate(plan);
    const before = structuredClone(candidates);
    const result = compile(plan, candidates);
    const compiledCase = result.scenarios[0].cases[0];
    const casePlan = plan.scenarios[0].cases[0];

    expect(candidates).toEqual(before);
    expect(result.report).toMatchObject({ ok: true, plannedCases: 1, candidateCases: 1, compiledCases: 1 });
    expect(compiledCase).toMatchObject({
      planCaseId: casePlan.planCaseId,
      planRevision: plan.revision,
      caseRevision: casePlan.caseRevision,
      storyId: 'US-LOGIN',
      requirementRefs: ['clause-login'],
      requirementRevisions: [{ id: 'clause-login', digest: plan.inputRevisions.requirements.clauses[0].digest }],
      coverageRef: 'cov-login',
      primaryCoverageRef: 'cov-login',
      coverageRefs: ['cov-login'],
      sessionRequirement: { required: false, mode: 'fresh' },
      dataBinding: {
        source: 'test_design_plan',
        approved: true,
        testDataSetId: 'dataset-login',
        mappingId: 'mapping-login',
        mappingVersion: 4,
        workbookHash: 'workbook-login-v1',
        sheet: 'LoginRows',
        planId: plan.planId,
        planRevision: plan.revision,
      },
    });
    expect(compiledCase.steps.map((step) => step.dataRefs)).toEqual([
      ['data.email'],
      ['data.password'],
      [],
    ]);
    expect(compiledCase.steps.map((step) => step.ordinal)).toEqual([1, 2, 3]);
    expect(compiledCase.declaredAssertions[0]).toMatchObject({
      oracleRef: 'login-destination',
      kind: 'url',
      channel: 'url',
      type: 'URL',
      target: 'url',
      expected: '{{expected}}',
      payload: { expectedUrlPattern: '{{expected}}' },
      semanticType: 'AssertUrl',
      comparator: 'url_matches',
      targetIdentity: { name: 'browser URL' },
      sourceQuote: 'A valid user reaches the home URL.',
      sourceSpan: { requirementId: 'clause-login', start: 0, end: 34 },
      sourceClauseRefs: ['clause-login'],
      failureBehavior: 'continue',
      stepId: null,
      dataRefs: ['data.expected'],
    });
    expect(compiledCase.declaredAssertions[0].semanticPayload).toEqual(
      casePlan.caseContractV1.assertions[0].payload,
    );
    expect(compiledCase.qualityContract).toMatchObject({
      existingRule: true,
      testDesignPlan: {
        version: 'TestDesignPlanV1',
        planId: plan.planId,
        revision: plan.revision,
        planCaseId: casePlan.planCaseId,
        caseRevision: casePlan.caseRevision,
        compiledCaseRevision: compiledCase.compiledCaseRevision,
      },
    });
    expect(compiledCase.compiledCaseRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(compiler.compiledCaseRevision(compiledCase)).toBe(compiledCase.compiledCaseRevision);
  });

  it('keeps approved matrix values tokenized even when an in-memory procedural source is supplied', () => {
    const plan = planFixture();
    const compiledCase = compiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: validCandidate(plan),
      proceduralFlowContract: {
        caseContractV1: {
          cases: [{ id: 'unrelated-inline-case' }],
        },
      },
    }).scenarios[0].cases[0];

    expect(compiledCase.dataBinding.mode).not.toBe('inline');
    expect(compiledCase.steps[0].value).toBe('{{email}}');
    expect(compiledCase.steps[1].value).toBe('{{password}}');
    expect(compiledCase.declaredAssertions[0].payload.expectedUrlPattern).toBe('{{expected}}');
  });

  it('fails closed for missing, duplicate, unknown, and unlabelled candidate cases', () => {
    const plan = planFixture();
    const valid = validCandidate(plan)[0].cases[0];

    expectFinding(() => compile(plan, []), 'test_design_planned_case_missing');
    expectFinding(() => compile(plan, [{ name: 'No id', cases: [{ ...valid, planCaseId: undefined }] }]), 'test_design_candidate_case_id_missing');
    expectFinding(() => compile(plan, [{ name: 'Unknown', cases: [{ ...valid, planCaseId: 'tdpc_not_in_plan' }] }]), 'test_design_extra_case');
    expectFinding(() => compile(plan, [{ name: 'Duplicate', cases: [valid, structuredClone(valid)] }]), 'test_design_duplicate_case');
  });

  it('rejects unknown data and oracle tokens instead of rebinding them from text', () => {
    const plan = planFixture();
    const scenarios = validCandidate(plan);
    scenarios[0].cases[0].steps[0].value = '{{username_from_another_sheet}}';
    expectFinding(() => compile(plan, scenarios), 'test_design_unknown_token');
  });

  it('rejects raw sensitive values even when they came from the approved workbook', () => {
    const plan = planFixture();
    const scenarios = validCandidate(plan);
    scenarios[0].cases[0].steps[1].value = 'Raw-Secret-Value';
    expectFinding(() => compile(plan, scenarios), 'test_design_sensitive_literal');
  });

  it('rejects post-planning action topology changes', () => {
    const plan = planFixture();
    const scenarios = validCandidate(plan);
    scenarios[0].cases[0].steps.splice(1, 1);

    expectFinding(() => compile(plan, scenarios), 'test_design_action_topology_drift');
  });

  it('canonicalizes the configured auth profile before stamping the compiler revision', () => {
    const plan = planFixture();
    const result = compiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: validCandidate(plan),
      authProfileName: 'primary-user',
    });
    const compiledCase = result.cases[0];

    expect(compiledCase.authProfile).toBe('primary-user');
    expect(compiler.compiledCaseRevision(compiledCase)).toBe(compiledCase.compiledCaseRevision);
    expect(compiler.compiledCaseRevision({ ...compiledCase, authProfile: 'administrator' }))
      .not.toBe(compiledCase.compiledCaseRevision);
  });

  it('rejects assertion-channel drift and does not turn a URL oracle into text', () => {
    const plan = planFixture();
    const scenarios = validCandidate(plan);
    scenarios[0].cases[0].declaredAssertions = [{
      oracleRef: 'login-destination',
      type: 'TEXT',
      target: 'body',
      payload: { expectedText: '{{expected}}' },
    }];
    expectFinding(() => compile(plan, scenarios), 'test_design_assertion_channel_drift');
  });

  it('detects missing or semantically altered compiled assertions against the immutable ledger', () => {
    const plan = planFixture();
    const casePlan = plan.scenarios[0].cases[0];
    const compiledCase = compile(plan).cases[0];
    const missingFindings = [];
    compiler._private.validateCompiledAssertionParity(
      { ...compiledCase, declaredAssertions: [] },
      casePlan,
      missingFindings,
    );
    expect(missingFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'test_design_assertion_ledger_parity', field: 'count' }),
      expect.objectContaining({ code: 'test_design_assertion_ledger_parity', assertionId: 'login-destination' }),
    ]));

    const altered = structuredClone(compiledCase);
    altered.declaredAssertions[0].semanticPayload.operands[1].value = '/different';
    const alteredFindings = [];
    compiler._private.validateCompiledAssertionParity(altered, casePlan, alteredFindings);
    expect(alteredFindings).toEqual([
      expect.objectContaining({
        code: 'test_design_assertion_ledger_parity',
        assertionId: 'login-destination',
        field: 'semanticPayload',
      }),
    ]);
  });

  it('rejects a tampered plan before inspecting candidate steps', () => {
    const plan = planFixture();
    plan.scenarios[0].cases[0].sessionRequirement = { required: true, mode: 'authenticated' };
    expectFinding(() => compile(plan, validCandidate(plan)), 'test_design_case_revision_invalid');
  });
});
