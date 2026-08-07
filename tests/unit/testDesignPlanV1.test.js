import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const planner = require('../../server/services/testDesignPlanV1');

function fixture(overrides = {}) {
  const coverageManifest = {
    version: 1,
    sourceMode: 'requirement_clauses',
    generatedAt: '2026-07-13T00:00:00.000Z',
    items: [{
      manifestItemId: 'cov-login-us-1',
      required: true,
      type: 'data_bound',
      storyRef: { id: 'US-1', title: 'Authenticate a user', moduleHint: 'identity' },
      dataSource: {
        sheet: 'LoginRows',
        rows: [0, 1],
        rowSelector: 'story:us-1',
        placeholders: ['email', 'password'],
        expectedToken: 'expected',
        expectedColumn: 'Expected URL',
      },
    }],
  };
  const caseContractPacks = [{
    coverageRef: 'cov-login-us-1',
    storyId: 'US-1',
    module: 'identity',
    title: 'Authenticate a user',
    pageIntent: 'Authenticate a user',
    requiredFields: ['email', 'password'],
    requiredActions: ['fill', 'fill', 'click'],
    semanticTokenMap: { email: '{{email}}', password: '{{password}}' },
    rowIntent: {
      sheet: 'LoginRows',
      rowSelector: 'story:us-1',
      rowIds: [0, 1],
      rowSource: 'coverage_manifest',
    },
    requiredOracle: {
      kind: 'url',
      target: 'url',
      expected: '{{expected}}',
      token: 'expected',
      source: 'requirement',
      required: true,
    },
    sessionRequirement: { required: false, mode: 'fresh' },
  }];
  const requirements = [{ id: 'clause-us-1', storyId: 'US-1', content: 'A valid user can authenticate and reaches /home.' }];
  const dataset = {
    source: 'approved',
    workbookContract: { fileHash: 'workbook-v1' },
    testData: {
      sheets: [{
        name: 'LoginRows',
        datasetRevisionId: 'dataset-revision-1',
        sheetId: 'sheet-login-1',
        headers: ['Story ID', 'Email', 'Password', 'Expected URL'],
        rows: [
          { 'Story ID': 'US-1', Email: 'first@example.test', Password: 'First-Secret', 'Expected URL': '/home' },
          { 'Story ID': 'US-1', Email: 'second@example.test', Password: 'Second-Secret', 'Expected URL': '/home' },
        ],
      }],
      mapping: {
        status: 'approved',
        sources: [{ testDataSetId: 'dataset-1', mappingId: 'mapping-1', version: 7, status: 'approved' }],
        bindings: [{
          storyId: 'US-1',
          sheet: 'LoginRows',
          datasetRevisionId: 'dataset-revision-1',
          sheetId: 'sheet-login-1',
          rowGroupId: 'row-group-login-1',
          columnToField: { email: 'Email', password: 'Password' },
          expectedColumn: 'Expected URL',
          testDataSetId: 'dataset-1',
          mappingId: 'mapping-1',
          mappingVersion: 7,
        }],
      },
    },
  };
  return {
    coverageManifest,
    caseContractPacks,
    requirements,
    dataset,
    scope: { module: 'identity', mode: 'full' },
    ...overrides,
  };
}

describe('TestDesignPlanV1', () => {
  it('builds deterministic immutable case, requirement, and approved data revisions without retaining secrets', () => {
    const input = fixture();
    const first = planner.buildTestDesignPlanV1(input);
    const second = planner.buildTestDesignPlanV1({
      ...input,
      scope: { mode: 'full', module: 'identity' },
      coverageManifest: {
        generatedAt: '2099-01-01T00:00:00.000Z',
        items: input.coverageManifest.items,
        sourceMode: input.coverageManifest.sourceMode,
        version: input.coverageManifest.version,
      },
    });

    expect(first).toEqual(second);
    expect(planner.validateTestDesignPlanV1(first)).toEqual({ ok: true, findings: [] });
    expect(first.planId).toBe(`tdp_${first.revision.slice(0, 24)}`);
    expect(first.inputRevisions.requirements.clauseIds).toEqual(['clause-us-1']);

    const casePlan = first.scenarios[0].cases[0];
    expect(casePlan.planCaseId).toMatch(/^tdpc_[a-f0-9]{24}$/);
    expect(casePlan.caseRevision).toHaveLength(64);
    expect(casePlan.requirementRefs).toEqual(['clause-us-1']);
    expect(casePlan.requirementRevisions).toEqual([
      { id: 'clause-us-1', digest: first.inputRevisions.requirements.clauses[0].digest },
    ]);
    expect(casePlan.dataPlan).toMatchObject({
      mode: 'matrix',
      approved: true,
      testDataSetId: 'dataset-1',
      mappingId: 'mapping-1',
      mappingVersion: 7,
      workbookHash: 'workbook-v1',
      datasetRevisionId: 'dataset-revision-1',
      sheetId: 'sheet-login-1',
      rowGroupId: 'row-group-login-1',
      sheet: 'LoginRows',
      allowedTokens: ['email', 'expected', 'password'],
    });
    expect(casePlan.dataPlan.bindings).toEqual([
      { dataRef: 'data.email', token: 'email', column: 'Email', classification: 'normal' },
      { dataRef: 'data.password', token: 'password', column: 'Password', classification: 'sensitive' },
    ]);
    expect(casePlan.oracles[0]).toMatchObject({ kind: 'url', token: 'expected', expected: '{{expected}}' });
    expect(casePlan.dataPlan.sensitiveLiteralDigests).toHaveLength(2);
    expect(JSON.stringify(first)).not.toContain('First-Secret');
    expect(JSON.stringify(first)).not.toContain('Second-Secret');
  });

  it('changes revisions when a requirement, mapping version, or workbook revision changes', () => {
    const baseline = planner.buildTestDesignPlanV1(fixture());
    const requirementChanged = planner.buildTestDesignPlanV1(fixture({
      requirements: [{ id: 'clause-us-1', storyId: 'US-1', content: 'A valid user reaches /dashboard.' }],
    }));

    const mappingInput = fixture();
    mappingInput.dataset.testData.mapping.sources[0].version = 8;
    mappingInput.dataset.testData.mapping.bindings[0].mappingVersion = 8;
    const mappingChanged = planner.buildTestDesignPlanV1(mappingInput);

    const workbookInput = fixture();
    workbookInput.dataset.workbookContract.fileHash = 'workbook-v2';
    const workbookChanged = planner.buildTestDesignPlanV1(workbookInput);

    expect(requirementChanged.revision).not.toBe(baseline.revision);
    expect(requirementChanged.scenarios[0].cases[0].caseRevision).not.toBe(baseline.scenarios[0].cases[0].caseRevision);
    expect(mappingChanged.revision).not.toBe(baseline.revision);
    expect(mappingChanged.scenarios[0].cases[0].caseRevision).not.toBe(baseline.scenarios[0].cases[0].caseRevision);
    expect(workbookChanged.revision).not.toBe(baseline.revision);
  });

  it('fails closed for draft data, missing revision pins, and ambiguous exact alignments', () => {
    const draft = fixture();
    draft.dataset.source = 'draft';
    draft.dataset.testData.mapping.status = 'draft';
    draft.dataset.testData.mapping.sources[0].status = 'draft';
    expect(() => planner.buildTestDesignPlanV1(draft)).toThrowError(expect.objectContaining({
      code: planner.PLAN_ERROR_CODE,
      findings: expect.arrayContaining([expect.objectContaining({ code: 'test_design_data_unapproved' })]),
    }));

    const unpinned = fixture();
    unpinned.dataset.testData.mapping.sources = [];
    delete unpinned.dataset.testData.mapping.bindings[0].testDataSetId;
    delete unpinned.dataset.testData.mapping.bindings[0].mappingId;
    delete unpinned.dataset.testData.mapping.bindings[0].mappingVersion;
    expect(() => planner.buildTestDesignPlanV1(unpinned)).toThrowError(expect.objectContaining({
      findings: expect.arrayContaining([expect.objectContaining({ code: 'test_design_mapping_revision_missing' })]),
    }));

    const mismatchedPin = fixture();
    mismatchedPin.dataset.testData.mapping.bindings[0].mappingVersion = 999;
    expect(() => planner.buildTestDesignPlanV1(mismatchedPin)).toThrowError(expect.objectContaining({
      findings: expect.arrayContaining([expect.objectContaining({ code: 'test_design_mapping_revision_mismatch' })]),
    }));

    const ambiguous = fixture();
    ambiguous.dataset.testData.sheets.push({ name: 'OtherLoginRows', headers: [], rows: [] });
    ambiguous.dataset.testData.mapping.bindings.push({
      storyId: 'US-1',
      sheet: 'OtherLoginRows',
      columnToField: { email: 'Email', password: 'Password' },
      expectedColumn: 'Expected URL',
      testDataSetId: 'dataset-1',
      mappingId: 'mapping-1',
      mappingVersion: 7,
    });
    expect(() => planner.buildTestDesignPlanV1(ambiguous)).toThrowError(expect.objectContaining({
      findings: expect.arrayContaining([expect.objectContaining({ code: 'test_design_data_alignment_ambiguous' })]),
    }));
  });

  it('uses an exact coverage alignment ahead of same-story alternatives and never chooses by array order', () => {
    const input = fixture({
      alignments: [{
        coverageRef: 'cov-login-us-1',
        storyId: 'US-1',
        sheet: 'LoginRows',
        datasetRevisionId: 'dataset-revision-1',
        sheetId: 'sheet-login-1',
        rowGroupId: 'row-group-login-1',
        columnToField: { email: 'Email', password: 'Password' },
        expectedColumn: 'Expected URL',
        testDataSetId: 'dataset-1',
        mappingId: 'mapping-1',
        mappingVersion: 7,
        status: 'approved',
      }],
    });
    input.dataset.testData.mapping.bindings.push({
      storyId: 'US-1',
      sheet: 'UnrelatedRows',
      columnToField: { account: 'Account' },
      testDataSetId: 'dataset-2',
      mappingId: 'mapping-2',
      mappingVersion: 1,
    });
    const plan = planner.buildTestDesignPlanV1(input);
    expect(plan.scenarios[0].cases[0].dataPlan).toMatchObject({
      alignmentBasis: 'coverage_ref',
      sheet: 'LoginRows',
      mappingId: 'mapping-1',
    });
  });

  it('detects semantic or revision tampering', () => {
    const plan = planner.buildTestDesignPlanV1(fixture());
    const tampered = structuredClone(plan);
    tampered.scenarios[0].cases[0].dataPlan.sheet = 'WrongSheet';
    const validation = planner.validateTestDesignPlanV1(tampered);
    expect(validation.ok).toBe(false);
    expect(validation.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'test_design_case_revision_invalid',
      'test_design_plan_revision_invalid',
    ]));
  });

  it('recomputes embedded case source parity instead of trusting signed-looking counts', () => {
    const input = fixture();
    input.caseContractPacks[0].caseContractV1 = {
      version: 'CaseContractV1',
      id: 'case-login',
      steps: [{ id: 'step.login', type: 'Click', sourceClauseRefs: ['clause-login'] }],
      assertions: [{ id: 'assert.login', type: 'AssertUrl', comparator: 'url_matches', sourceClauseRefs: ['clause-login'] }],
    };
    const plan = planner.buildTestDesignPlanV1(input);
    const tampered = structuredClone(plan);
    tampered.scenarios[0].cases[0].sourceParity.stepCount = 55;

    expect(planner.validateTestDesignPlanV1(tampered).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'test_design_source_parity_mismatch' }),
    ]));
  });

  it('keeps a standard required-field pack data-free when no upstream data alignment exists', () => {
    const plan = planner.buildTestDesignPlanV1({
      coverageManifest: {
        version: 1,
        items: [{ manifestItemId: 'cov-profile', required: true, storyRef: { id: 'US-2', title: 'Open profile' } }],
      },
      caseContractPacks: [{
        coverageRef: 'cov-profile',
        storyId: 'US-2',
        title: 'Open profile',
        requiredFields: ['employee name'],
        semanticTokenMap: { 'employee name': '{{employee_name}}' },
        rowIntent: { sheet: null, rowIds: [], rowSource: 'needs_mapping' },
        requiredOracle: { kind: 'visible', target: 'Profile heading', expected: true, required: true },
      }],
      requirements: [{ id: 'clause-us-2', storyId: 'US-2', content: 'The user can open a profile.' }],
    });
    expect(plan.scenarios[0].cases[0].dataPlan).toMatchObject({ mode: 'none', sheet: null, bindings: [] });
  });
});
