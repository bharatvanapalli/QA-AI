import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const bridge = require('../../server/services/caseContractPlanningBridge');
const storyDataAlignmentPlanV1 = require('../../server/services/storyDataAlignmentPlanV1');
const testDesignPlanV1 = require('../../server/services/testDesignPlanV1');

function step(id, ordinal, type, overrides = {}) {
  return {
    id,
    ordinal,
    type,
    text: `${type} ${id}`,
    dataRefs: [],
    dependsOn: [],
    flowImpact: /^Assert/i.test(type) ? 'observation' : 'state_change',
    failureBehavior: /^Assert/i.test(type) ? 'continue' : 'stop_descendants',
    ...overrides,
  };
}

function assertion(id, ordinal, type, overrides = {}) {
  return {
    id,
    ordinal,
    type,
    text: `${type} ${id}`,
    dataRefs: [],
    stepId: null,
    comparator: 'equals',
    required: true,
    ...overrides,
  };
}

function caseContract(id, name, overrides = {}) {
  return {
    version: 'CaseContractV1',
    id,
    externalId: `REQ-${id}`,
    name,
    intent: `Intent for ${name}`,
    initialState: { description: `${name} initial` },
    expectedFinalState: { description: `${name} final` },
    sessionRequirement: {
      mode: 'fresh',
      dependsOnCaseRefs: [],
      producesAuthenticatedState: false,
    },
    dataBindings: [],
    dataRows: [],
    steps: [step(`${id}-navigate`, 1, 'Navigate')],
    assertions: [],
    unusedDataRefs: [],
    ...overrides,
  };
}

function envelope(cases) {
  return {
    version: 'CaseContractV1',
    source: { requirementIds: ['REQ-FLOW'], digest: 'digest-123' },
    partitioning: { caseCount: cases.length, dataRowsDoNotCreateCases: true },
    cases,
  };
}

describe('CaseContractV1 pre-step planning bridge', () => {
  it('makes every authored case authoritative without losing order or semantic detail', () => {
    const first = caseContract('case-one', 'Repeated identity flow', {
      sessionRequirement: {
        mode: 'continue_from_case',
        dependsOnCaseRefs: ['TC-AUTH'],
        producesAuthenticatedState: true,
      },
      dataBindings: [
        {
          id: 'data.email',
          name: 'email',
          label: 'Email',
          classification: 'normal',
          source: { kind: 'inline', value: 'person@example.test' },
        },
        {
          id: 'data.password',
          name: 'password',
          label: 'Password',
          classification: 'sensitive',
          value: 'must-not-survive',
          source: { kind: 'inline', value: 'must-not-survive' },
        },
        {
          id: 'data.unused',
          name: 'unused',
          label: 'Unused',
          classification: 'normal',
          source: { kind: 'inline', value: 'not-consumed' },
        },
      ],
      unusedDataRefs: ['data.unused'],
      steps: [
        step('s1', 1, 'Navigate'),
        step('s2', 2, 'Fill', { dataRefs: ['data.email'], dependsOn: ['s1'] }),
        step('s3', 3, 'Click', { dependsOn: ['s2'], failureBehavior: 'stop_case' }),
        step('s4', 4, 'Fill', { dataRefs: ['data.email'], dependsOn: ['s3'] }),
        step('s5', 5, 'Fill', { dataRefs: ['data.password'], dependsOn: ['s4'] }),
        step('s6', 6, 'AssertVisible', { dependsOn: ['s5'], failureBehavior: 'continue' }),
      ],
      assertions: [
        assertion('a-url', 1, 'AssertUrl', { comparator: 'url_matches' }),
        assertion('a-text', 2, 'AssertText', { dataRefs: ['data.email'], comparator: 'contains' }),
        assertion('a-number', 3, 'AssertNumber'),
        assertion('a-visible', 4, 'AssertVisible'),
        assertion('a-hidden', 5, 'AssertHidden'),
      ],
    });
    const second = caseContract('case-two', 'Independent follow-up', {
      steps: [
        step('t1', 1, 'Navigate'),
        step('t2', 2, 'Click', { dependsOn: ['t1'] }),
      ],
    });
    const contractEnvelope = envelope([first, second]);
    const coverageManifest = {
      version: 1,
      sourceMode: 'requirement_clauses',
      generatedAt: '2026-07-13T00:00:00.000Z',
      items: [
        { manifestItemId: 'cov-old-1', type: 'STANDARD', required: true, title: 'Old required' },
        { manifestItemId: 'cov-old-2', type: 'EXPANSION', required: false, advisory: true },
      ],
    };
    const before = JSON.parse(JSON.stringify({ contractEnvelope, coverageManifest }));

    const result = bridge.buildCaseContractPlanningBridge({
      proceduralFlowContract: { caseContractV1: contractEnvelope },
      coverageManifest,
      caseContractPacks: [{ coverageRef: 'cov-old-1', title: 'Old pack' }],
    });

    expect(result.caseContractPacks.map((pack) => pack.coverageRef)).toEqual([
      'case-contract::case-one',
      'case-contract::case-two',
    ]);
    expect(result.coverageManifest.items.slice(0, 2).map((item) => item.storyRef.title)).toEqual([
      'Repeated identity flow',
      'Independent follow-up',
    ]);
    expect(result.coverageManifest).toMatchObject({
      sourceMode: 'case_contract_v1',
      itemCount: 4,
      requiredCount: 2,
      advisoryCount: 2,
    });
    expect(result.coverageManifest.items.slice(2)).toEqual([
      expect.objectContaining({ manifestItemId: 'cov-old-1', required: false, advisory: true }),
      expect.objectContaining({ manifestItemId: 'cov-old-2', required: false, advisory: true }),
    ]);

    const pack = result.caseContractPacks[0];
    expect(pack.requiredActions).toEqual(['Navigate', 'Fill', 'Click', 'Fill', 'Fill']);
    expect(pack.requiredActionSteps.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(pack.requiredFields).toEqual(['email', 'password']);
    expect(pack.requiredDataRefs).toEqual(['data.email', 'data.password']);
    expect(pack.semanticTokenMap).toEqual({ email: '{{email}}', password: '{{password}}' });
    expect(pack.dataBindings).toHaveLength(3);
    expect(pack.unusedDataRefs).toEqual(['data.unused']);
    expect(pack.stepDependencies.find((item) => item.stepId === 's4')?.dependsOn).toEqual(['s3']);
    expect(pack.failureBehavior.s3).toBe('stop_case');
    expect(pack.initialState).toEqual(first.initialState);
    expect(pack.expectedFinalState).toEqual(first.expectedFinalState);
    expect(pack.sessionRequirement).toEqual(first.sessionRequirement);
    expect(pack.requiredOracles.map((oracle) => oracle.kind)).toEqual([
      'url', 'text', 'number', 'visible', 'hidden',
    ]);
    expect(pack.requiredOracles[0]).toMatchObject({
      assertionId: 'a-url',
      assertionType: 'AssertUrl',
      target: 'url',
      comparator: 'url_matches',
      source: 'case_contract_v1',
    });
    expect(pack.caseContractV1.id).toBe('case-one');
    expect(pack.caseContractV1.steps.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(JSON.stringify(pack)).not.toContain('must-not-survive');
    expect(pack.dataReferenceMap['data.password']).toMatchObject({
      classification: 'sensitive',
      source: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD' },
    });
    expect({ contractEnvelope, coverageManifest }).toEqual(before);

    const repeated = bridge.buildCaseContractPlanningBridge({
      caseContract: contractEnvelope,
      coverageManifest: result.coverageManifest,
      caseContractPacks: result.caseContractPacks,
    });
    expect(repeated).toEqual(result);
  });

  it('inherits one immutable uploaded data source and its exact pack row intent for one authored case', () => {
    const contractEnvelope = envelope([caseContract('only-case', 'One data-bound case')]);
    const dataSource = {
      datasetId: 'dataset-1',
      datasetRevisionId: 'revision-7',
      sheetId: 'sheet-login',
      sheet: 'LoginRows',
      rowGroupId: 'group-positive',
      rowIds: ['row-1', 'row-2'],
      rows: [0, 1],
      rowSelector: 'story:req-only',
      placeholders: ['email', 'password'],
      mappingId: 'mapping-3',
      mappingVersion: 3,
    };
    const rowIntent = {
      sheet: 'LoginRows',
      rowSelector: 'story:req-only',
      rowIds: ['row-1', 'row-2'],
      rowSource: 'coverage_manifest',
      immutableRevision: 'revision-7',
    };
    const alignmentRef = {
      planId: 'alignment-plan-1',
      alignmentId: 'alignment-login',
      rowGroupId: 'group-positive',
    };
    const coverageManifest = {
      items: [
        { manifestItemId: 'cov-data', type: 'DATA_BOUND', required: true, dataSource, alignmentRef },
        { manifestItemId: 'cov-context', type: 'STANDARD', required: true },
      ],
    };

    const result = bridge.buildCaseContractPlanningBridge({
      caseContractV1: contractEnvelope,
      coverageManifest,
      existingCaseContractPacks: [{ coverageRef: 'cov-data', rowIntent }],
    });

    expect(result.caseContractPacks).toHaveLength(1);
    expect(result.caseContractPacks[0]).toMatchObject({
      coverageRef: 'case-contract::only-case',
      type: 'data_bound',
      dataSource,
      alignmentRef,
      rowIntent,
    });
    expect(result.coverageManifest.items[0]).toMatchObject({
      manifestItemId: 'case-contract::only-case',
      type: 'DATA_BOUND',
      required: true,
      dataSource,
      alignmentRef,
    });
    expect(result.coverageManifest.items[1]).toMatchObject({
      manifestItemId: 'cov-data',
      required: false,
      advisory: true,
      dataSource,
    });
    expect(result.coverageManifest.items[2]).toMatchObject({
      manifestItemId: 'cov-context',
      required: false,
      advisory: true,
    });
    expect(result.caseContractPacks[0].dataSource).not.toBe(dataSource);
    expect(result.caseContractPacks[0].rowIntent).not.toBe(rowIntent);

    const testData = {
      sheets: [{
        name: 'LoginRows',
        datasetRevisionId: 'revision-7',
        sheetId: 'sheet-login',
        headers: ['Email'],
        rows: [{ Email: 'first@example.test' }, { Email: 'second@example.test' }],
      }],
      mapping: {
        status: 'approved',
        sources: [{ testDataSetId: 'dataset-1', mappingId: 'mapping-3', version: 3, status: 'approved' }],
        bindings: [{
          storyId: 'REQ-only-case',
          sheet: 'LoginRows',
          datasetRevisionId: 'revision-7',
          sheetId: 'sheet-login',
          rowGroupId: 'group-positive',
          columnToField: { email: 'Email' },
          testDataSetId: 'dataset-1',
          mappingId: 'mapping-3',
          mappingVersion: 3,
          status: 'approved',
        }],
      },
    };
    const alignmentPlan = {
      schemaVersion: storyDataAlignmentPlanV1.SCHEMA_VERSION,
      planId: 'alignment-plan-1',
      alignments: [{
        alignmentId: 'alignment-login',
        storyId: 'REQ-only-case',
        selected: [{
          datasetId: 'dataset-1',
          datasetRevisionId: 'revision-7',
          sheetId: 'sheet-login',
          rowGroupId: 'group-positive',
          rowIds: ['row-1', 'row-2'],
          bindingRef: { mappingId: 'mapping-3', mappingVersion: 3, status: 'approved' },
        }],
      }],
    };
    const designAlignments = storyDataAlignmentPlanV1.toTestDesignAlignments(alignmentPlan, {
      testData,
      coverageManifest: result.coverageManifest,
    });
    expect(designAlignments.map((item) => item.coverageRef)).toEqual([
      'case-contract::only-case',
      'cov-data',
    ]);

    const design = testDesignPlanV1.buildTestDesignPlanV1({
      coverageManifest: result.coverageManifest,
      caseContractPacks: result.caseContractPacks,
      requirements: [{ id: 'REQ-only-case', content: 'Use the approved LoginRows group.' }],
      dataset: {
        source: 'approved',
        workbookContract: { fileHash: 'workbook-1' },
        testData,
      },
      alignments: designAlignments,
    });
    expect(design.scenarios[0].cases[0].dataPlan).toMatchObject({
      mode: 'matrix',
      approved: true,
      alignmentBasis: 'coverage_ref',
      mappingId: 'mapping-3',
      rowIds: ['row-1', 'row-2'],
    });
  });

  it.each([
    {
      name: 'one uploaded data item for multiple authored cases',
      cases: [caseContract('case-a', 'A'), caseContract('case-b', 'B')],
      items: [{ manifestItemId: 'cov-data-a', type: 'DATA_BOUND', dataSource: { sheet: 'RowsA' } }],
      packs: [],
      reason: 'case_data_cardinality_is_not_one_to_one',
    },
    {
      name: 'multiple uploaded data items for one authored case',
      cases: [caseContract('case-a', 'A')],
      items: [
        { manifestItemId: 'cov-data-a', type: 'DATA_BOUND', dataSource: { sheet: 'RowsA' } },
        { manifestItemId: 'cov-data-b', type: 'data-bound', dataSource: { sheet: 'RowsB' } },
      ],
      packs: [],
      reason: 'multiple_data_bound_items',
    },
    {
      name: 'multiple exact row-intent packs for one uploaded data item',
      cases: [caseContract('case-a', 'A')],
      items: [{ manifestItemId: 'cov-data-a', type: 'DATA_BOUND', dataSource: { sheet: 'RowsA' } }],
      packs: [
        { coverageRef: 'cov-data-a', rowIntent: { sheet: 'RowsA', rowIds: [0] } },
        { coverageRef: 'cov-data-a', rowIntent: { sheet: 'RowsA', rowIds: [1] } },
      ],
      reason: 'multiple_exact_row_intents_for_data_item',
    },
  ])('fails closed instead of index-matching: $name', ({ cases, items, packs, reason }) => {
    let error;
    try {
      bridge.buildCaseContractPlanningBridge({
        caseContract: envelope(cases),
        coverageManifest: { items },
        caseContractPacks: packs,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(bridge.CaseContractPlanningBridgeError);
    expect(error).toMatchObject({
      code: 'CASE_CONTRACT_DATA_ALIGNMENT_REVIEW_REQUIRED',
      status: 422,
    });
    expect(error.findings[0].reason).toBe(reason);
  });

  it('rejects mutable declared counts that disagree with the immutable case inventory', () => {
    const authoredCase = caseContract('case-parity', 'Parity case', {
      assertions: [assertion('case-parity-assertion', 1, 'AssertVisible', { comparator: 'visible' })],
    });
    const result = bridge.buildCaseContractPlanningBridge({
      caseContractEnvelope: envelope([authoredCase]),
      coverageManifest: {},
      caseContractPacks: [],
    });
    result.coverageManifest.items[0].requiredCoverage.stepCount = 55;
    result.coverageManifest.items[0].requiredCoverage.assertionCount = 45;

    expect(() => testDesignPlanV1.buildTestDesignPlanV1({
      coverageManifest: result.coverageManifest,
      caseContractPacks: result.caseContractPacks,
      requirements: [{ id: 'REQ-case-parity', content: 'Parity case requirement.' }],
    })).toThrowError(expect.objectContaining({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'test_design_source_parity_mismatch',
          mismatches: expect.arrayContaining([
            { field: 'stepCount', expected: 1, actual: 55 },
            { field: 'assertionCount', expected: 1, actual: 45 },
          ]),
        }),
      ]),
    }));
  });
});
