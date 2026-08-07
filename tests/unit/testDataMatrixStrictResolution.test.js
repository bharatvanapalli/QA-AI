import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  materializeInlineEvidenceTokens,
  materializeInlineCaseInstance,
  resolveCaseDataSource,
  resolveCaseRows,
  resolveInlineCaseRows,
  resolvePinnedRows,
  substituteCase,
  validateCaseDataBinding,
} = require('../../server/services/testDataMatrix');
const inlineCaseInstanceContract = require('../../server/services/inlineCaseInstanceContract');

function strictContext() {
  return {
    sheets: [
      {
        name: 'Shared Matrix',
        testDataSetId: 'dataset-a',
        datasetId: 'dataset-a',
        datasetRevisionId: 'revision-a',
        sheetId: 'sheet-a',
        headers: ['Value', 'Expected Result'],
        rows: [
          { Value: 'a-one', 'Expected Result': 'accepted', rowId: 'business-id', __datasetRowId: 'row-a-1' },
          { Value: 'a-two', 'Expected Result': 'accepted', rowId: 'business-id', __datasetRowId: 'row-a-2' },
        ],
      },
      {
        name: 'Shared Matrix',
        testDataSetId: 'dataset-b',
        datasetId: 'dataset-b',
        datasetRevisionId: 'revision-b',
        sheetId: 'sheet-b',
        headers: ['Value', 'Expected Result'],
        rows: [
          { Value: 'b-one', 'Expected Result': 'accepted', rowId: 'business-id', __datasetRowId: 'row-b-1' },
          { Value: 'b-two', 'Expected Result': 'accepted', rowId: 'business-id', __datasetRowId: 'row-b-2' },
        ],
      },
    ],
    mapping: {
      version: 2,
      status: 'approved',
      sources: [
        { testDataSetId: 'dataset-a', mappingId: 'mapping-a', version: 3, status: 'approved' },
        { testDataSetId: 'dataset-b', mappingId: 'mapping-b', version: 7, status: 'approved' },
      ],
      bindings: [
        {
          sheet: 'Shared Matrix',
          testDataSetId: 'dataset-a',
          datasetId: 'dataset-a',
          datasetRevisionId: 'revision-a',
          sheetId: 'sheet-a',
          mappingId: 'mapping-a',
          mappingVersion: 3,
          columnToField: { value: 'Value' },
          expectedColumn: 'Expected Result',
        },
        {
          sheet: 'Shared Matrix',
          testDataSetId: 'dataset-b',
          datasetId: 'dataset-b',
          datasetRevisionId: 'revision-b',
          sheetId: 'sheet-b',
          mappingId: 'mapping-b',
          mappingVersion: 7,
          columnToField: { value: 'Value' },
          expectedColumn: 'Expected Result',
        },
      ],
    },
  };
}

function caseWith(binding) {
  return {
    id: 'case-strict-data',
    name: 'Execute the approved matrix rows',
    assertions: 'Use {{value}} and verify {{expected}}.',
    steps: JSON.stringify([{ action: 'Fill', value: '{{value}}' }]),
    declaredAssertions: JSON.stringify([]),
    dataBindingJson: JSON.stringify(binding),
  };
}

describe('testDataMatrix strict runtime resolution', () => {
  it('accepts a sheetId-only binding and resolves immutable IDs before duplicate names', () => {
    const testData = strictContext();
    const tc = caseWith({
      sheetId: 'sheet-b',
      rowIds: ['row-b-2'],
    });

    const source = resolveCaseDataSource(tc, null, testData);
    const rows = resolveCaseRows(tc, null, testData);

    expect(source.status).toBe('resolved');
    expect(source.sheet.sheetId).toBe('sheet-b');
    expect(source.binding.sheet).toBe('Shared Matrix');
    expect(source.binding.mappingId).toBe('mapping-b');
    expect(validateCaseDataBinding(tc, null, testData)).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0].inputs.value).toBe('b-two');
    expect(rows[0].rowId).toBe('row-b-2');
  });

  it('can resolve from mappingId alone and preserves every exact pin on runtime rows', () => {
    const testData = strictContext();
    const tc = caseWith({
      mappingId: 'mapping-b',
      testDataSetId: 'dataset-b',
      datasetRevisionId: 'revision-b',
      rowIds: ['row-b-2', 'row-b-1'],
    });

    const source = resolveCaseDataSource(tc, null, testData);
    const rows = resolveCaseRows(tc, null, testData);

    expect(source.status).toBe('resolved');
    expect(source.binding).toEqual(expect.objectContaining({
      mappingId: 'mapping-b',
      mappingVersion: 7,
      testDataSetId: 'dataset-b',
      datasetRevisionId: 'revision-b',
      sheetId: 'sheet-b',
      rowIds: ['row-b-2', 'row-b-1'],
    }));
    expect(rows.map((row) => row.rowId)).toEqual(['row-b-2', 'row-b-1']);
    expect(rows.map((row) => row.inputs.value)).toEqual(['b-two', 'b-one']);
    expect(rows.every((row) => (
      row.dataBindingRef.testDataSetId === 'dataset-b'
      && row.dataBindingRef.datasetRevisionId === 'revision-b'
      && row.dataBindingRef.sheetId === 'sheet-b'
      && row.dataBindingRef.mappingId === 'mapping-b'
      && row.dataBindingRef.mappingVersion === 7
    ))).toBe(true);
  });

  it('never first-picks duplicate sheet names', () => {
    const testData = strictContext();
    const tc = caseWith({ sheet: 'shared matrix' });
    const collector = [];

    const defect = validateCaseDataBinding(tc, null, testData);
    const rows = resolveCaseRows(tc, null, testData, { collector });

    expect(defect).toEqual(expect.objectContaining({
      code: 'data_binding_sheet_ambiguous',
      blockedReason: 'test_data_invalid',
    }));
    expect(defect.evidence).toHaveLength(2);
    expect(rows).toEqual([]);
    expect(collector).toContainEqual(expect.objectContaining({
      code: 'data_binding_sheet_ambiguous',
      blockedReason: 'test_data_invalid',
      severity: 'error',
    }));
  });

  it('does not fall back by name when an exact dataset revision pin is missing', () => {
    const testData = strictContext();
    const tc = caseWith({
      sheet: 'Shared Matrix',
      testDataSetId: 'dataset-b',
      datasetRevisionId: 'revision-that-does-not-exist',
      sheetId: 'sheet-b',
      columnToField: { value: 'Value' },
    });

    expect(validateCaseDataBinding(tc, null, testData)).toEqual(expect.objectContaining({
      code: 'data_binding_sheet_not_found',
      blockedReason: 'test_data_invalid',
    }));
    expect(resolveCaseRows(tc, null, testData)).toEqual([]);
  });

  it('does not substitute another approved mapping when mappingId is missing', () => {
    const testData = strictContext();
    const tc = caseWith({
      mappingId: 'mapping-that-does-not-exist',
      sheet: 'Shared Matrix',
      sheetId: 'sheet-b',
    });

    expect(validateCaseDataBinding(tc, null, testData)).toEqual(expect.objectContaining({
      code: 'data_binding_mapping_not_found',
      blockedReason: 'test_data_invalid',
    }));
  });

  it('blocks ambiguous mapping revisions for one exact sheet unless mappingId is pinned', () => {
    const testData = strictContext();
    testData.mapping.bindings.push({
      ...testData.mapping.bindings[1],
      mappingId: 'mapping-b-newer',
      mappingVersion: 8,
    });
    testData.mapping.sources.push({
      testDataSetId: 'dataset-b',
      mappingId: 'mapping-b-newer',
      version: 8,
      status: 'approved',
    });
    const tc = caseWith({
      testDataSetId: 'dataset-b',
      datasetRevisionId: 'revision-b',
      sheetId: 'sheet-b',
    });

    expect(validateCaseDataBinding(tc, null, testData)).toEqual(expect.objectContaining({
      code: 'data_binding_mapping_ambiguous',
      blockedReason: 'test_data_invalid',
    }));
  });

  it('filters exclusively by __datasetRowId and reports absent row pins', () => {
    const testData = strictContext();
    const exact = resolvePinnedRows(testData.sheets[1].rows, { rowIds: ['row-b-2'] });
    const businessId = resolvePinnedRows(testData.sheets[1].rows, { rowIds: ['business-id'] });
    const tc = caseWith({
      mappingId: 'mapping-b',
      testDataSetId: 'dataset-b',
      datasetRevisionId: 'revision-b',
      sheetId: 'sheet-b',
      rowIds: ['row-b-missing'],
    });

    expect(exact.status).toBe('resolved');
    expect(exact.rows[0].Value).toBe('b-two');
    expect(businessId.status).toBe('missing');
    expect(validateCaseDataBinding(tc, null, testData)).toEqual(expect.objectContaining({
      code: 'data_binding_row_ids_not_found',
      blockedReason: 'test_data_invalid',
    }));
    expect(resolveCaseRows(tc, null, testData)).toEqual([]);
  });

  it('blocks duplicate immutable row identities instead of taking the first row', () => {
    const testData = strictContext();
    testData.sheets[1].rows[1].__datasetRowId = 'row-b-1';
    const tc = caseWith({
      mappingId: 'mapping-b',
      testDataSetId: 'dataset-b',
      datasetRevisionId: 'revision-b',
      sheetId: 'sheet-b',
      rowIds: ['row-b-1'],
    });

    expect(validateCaseDataBinding(tc, null, testData)).toEqual(expect.objectContaining({
      code: 'data_binding_row_ids_ambiguous',
      blockedReason: 'test_data_invalid',
    }));
  });

  it('propagates pinValidationError as test_data_invalid before any fallback', () => {
    const testData = {
      sheets: [],
      mapping: { bindings: [] },
      pinValidationError: {
        code: 'PINNED_TEST_DATA_UNAVAILABLE',
        message: 'Pinned revision was superseded.',
        findings: [{ code: 'pinned_dataset_revision_mismatch' }],
      },
    };
    const tc = caseWith({ sheetId: 'sheet-b', mappingId: 'mapping-b' });
    const collector = [];

    const defect = validateCaseDataBinding(tc, null, testData);
    const rows = resolveCaseRows(tc, null, testData, { collector });

    expect(defect).toEqual(expect.objectContaining({
      code: 'PINNED_TEST_DATA_UNAVAILABLE',
      blockedReason: 'test_data_invalid',
      evidence: [{ code: 'pinned_dataset_revision_mismatch' }],
    }));
    expect(rows).toEqual([]);
    expect(collector).toContainEqual(expect.objectContaining({
      code: 'PINNED_TEST_DATA_UNAVAILABLE',
      blockedReason: 'test_data_invalid',
    }));
  });

  it('resolves an exact pinned row for journey members instead of returning an unbound execution', () => {
    const testData = strictContext();
    const tc = caseWith({
      mappingId: 'mapping-b',
      testDataSetId: 'dataset-b',
      datasetRevisionId: 'revision-b',
      sheetId: 'sheet-b',
      rowIds: ['row-b-2'],
    });

    expect(validateCaseDataBinding(tc, null, testData)).toBeNull();
    expect(resolveCaseRows(tc, null, testData, { isJourneyMember: true })).toEqual([
      expect.objectContaining({
        rowId: 'row-b-2',
        inputs: expect.objectContaining({ value: 'b-two' }),
        dataBindingRef: expect.objectContaining({ mappingId: 'mapping-b', sheetId: 'sheet-b' }),
      }),
    ]);
  });

  it('preserves truly data-free journey cases as one unbound execution', () => {
    const testCase = {
      id: 'case-data-free',
      name: 'Observe the public landing page',
      steps: JSON.stringify([{ action: 'Navigate', value: 'https://example.test' }]),
      dataBindingJson: null,
    };

    expect(validateCaseDataBinding(testCase, null, strictContext())).toBeNull();
    expect(resolveCaseRows(testCase, null, strictContext(), { isJourneyMember: true })).toEqual([]);
  });

  it('fails closed when an inline binding has no exact compiler-owned instance plan', () => {
    const testCase = {
      id: 'case-inline',
      name: 'Use inline CaseContract data',
      dataBindingJson: JSON.stringify({
        status: 'complete',
        mode: 'inline',
        source: 'case_contract_v1',
        inlineRevision: 'inline-revision-1',
      }),
    };

    expect(validateCaseDataBinding(testCase, null, strictContext())).toMatchObject({
      code: 'inline_row_execution_plan_missing_or_invalid',
      blockedReason: 'test_data_invalid',
    });
    expect(resolveCaseRows(testCase, null, strictContext())).toEqual([]);
  });

  it('selects exact inline instances in rowIds order and overlays their literal executable projection', () => {
    const inlineRevision = 'inline-revision-rows-v1';
    const planCaseId = 'plan-case-inline-rows';
    const projection = (email, password, expected) => ({
      name: `Authenticate ${email}`,
      assertions: `Verify ${expected}`,
      operations: [],
      oracles: [{ kind: 'text', expected }],
      declaredAssertions: [{ kind: 'text', expected }],
      steps: [
        { action: 'Fill', element: 'Email', value: email },
        { action: 'Fill', element: 'Password', value: password },
        { action: 'AssertText', expected },
      ],
    });
    const instance = (rowId, ordinal, inputs, publicBindings, executableProjection) => {
      const instancePlanId = inlineCaseInstanceContract.instancePlanId({ planCaseId, inlineRevision, rowId });
      return {
        instancePlanId,
        rowId,
        ordinal,
        instanceRevision: inlineCaseInstanceContract.instanceRevision({
          instancePlanId,
          planCaseId,
          inlineRevision,
          rowId,
          ordinal,
          executableProjection,
        }),
        inputs,
        publicBindings,
        executableProjection,
      };
    };
    const firstProjection = projection('first@example.test', 'First-Secret', 'Welcome first');
    const secondProjection = projection('second@example.test', 'Second-Secret', 'Welcome second');
    const rowOne = instance(
      'row-001',
      2,
      { email: 'first@example.test', password: 'First-Secret' },
      {
        email: { kind: 'inline', value: 'first@example.test' },
        password: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD_ROW_1' },
      },
      firstProjection,
    );
    const rowTwo = instance(
      'row-002',
      1,
      { email: 'second@example.test', password: 'Second-Secret' },
      {
        email: { kind: 'inline', value: 'second@example.test' },
        password: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD_ROW_2' },
      },
      secondProjection,
    );
    const testCase = {
      id: 'case-inline-rows',
      caseScopeId: planCaseId,
      name: 'Default logical case',
      assertions: 'Default assertion',
      steps: JSON.stringify([{ action: 'Fill', value: 'default@example.test' }]),
      declaredAssertions: JSON.stringify([]),
      dataBindingJson: JSON.stringify({
        status: 'complete',
        mode: 'inline',
        inlineRevision,
        planCaseId,
        rowIds: ['row-002', 'row-001'],
      }),
      rowExecutionPlanJson: JSON.stringify({
        version: 1,
        mode: 'inline',
        executionMode: 'per_row',
        inlineRevision,
        dataBindingId: inlineRevision,
        rowIds: ['row-002', 'row-001'],
        defaultInstanceId: rowTwo.instancePlanId,
        instances: [rowOne, rowTwo],
      }),
    };

    const inline = resolveInlineCaseRows(testCase);
    const rows = resolveCaseRows(testCase, null, strictContext());
    const selected = materializeInlineCaseInstance(testCase, rows[0]);
    const selectedThroughConductorBridge = substituteCase(testCase, rows[0]);

    expect(inline.status).toBe('resolved');
    expect(validateCaseDataBinding(testCase, null, strictContext())).toBeNull();
    expect(rows.map((row) => row.rowId)).toEqual(['row-002', 'row-001']);
    expect(rows.map((row) => row.inputs.email)).toEqual(['second@example.test', 'first@example.test']);
    expect(rows[0]).toMatchObject({
      inlineInstance: true,
      instancePlanId: rowTwo.instancePlanId,
      instanceRevision: rowTwo.instanceRevision,
      inlineRevision,
      planCaseId,
      caseScopeId: planCaseId,
      sheet: null,
      dataBindingRef: expect.objectContaining({
        mode: 'inline',
        planCaseId,
        caseScopeId: planCaseId,
      }),
    });
    expect(rows[0].inputs.password).toEqual({
      kind: 'environment',
      name: 'QAAI_INLINE_PASSWORD_ROW_2',
    });
    expect(rows.map((row) => row.raw.profileKey)).toEqual([
      `inline_${rowTwo.instancePlanId}`,
      `inline_${rowOne.instancePlanId}`,
    ]);
    expect(JSON.parse(selected.steps).map((step) => step.value || step.expected)).toEqual([
      'second@example.test', 'Second-Secret', 'Welcome second',
    ]);
    expect(selectedThroughConductorBridge).toEqual(selected);
    expect(JSON.parse(testCase.steps)[0].value).toBe('default@example.test');
    expect(JSON.stringify(selected)).not.toContain('{{');

    const tampered = structuredClone(testCase);
    const tamperedPlan = JSON.parse(tampered.rowExecutionPlanJson);
    tamperedPlan.instances[1].executableProjection.steps[0].value = 'tampered@example.test';
    tampered.rowExecutionPlanJson = JSON.stringify(tamperedPlan);
    expect(validateCaseDataBinding(tampered, null, strictContext())).toMatchObject({
      code: 'inline_instance_revision_mismatch',
      blockedReason: 'test_data_invalid',
    });

    const wrongCase = structuredClone(testCase);
    wrongCase.caseScopeId = 'another-case-scope';
    expect(validateCaseDataBinding(wrongCase, null, strictContext())).toMatchObject({
      code: 'inline_case_scope_mismatch',
      blockedReason: 'test_data_invalid',
    });
  });

  it('blocks inline row/revision ambiguity instead of substituting by position', () => {
    const testCase = {
      id: 'case-inline-mismatch',
      dataBindingJson: JSON.stringify({
        mode: 'inline',
        planCaseId: 'plan-case-inline-mismatch',
        inlineRevision: 'inline-v1',
        rowIds: ['row-001', 'row-002'],
      }),
      rowExecutionPlanJson: JSON.stringify({
        version: 1,
        mode: 'inline',
        executionMode: 'per_row',
        inlineRevision: 'inline-v2',
        dataBindingId: 'inline-v2',
        rowIds: ['row-001', 'row-002'],
        defaultInstanceId: 'instance-row-001',
        instances: [],
      }),
    };

    expect(validateCaseDataBinding(testCase, null, strictContext())).toMatchObject({
      code: 'inline_revision_mismatch',
      blockedReason: 'test_data_invalid',
    });
  });

  it('continues materializing compiler-owned inline evidence before execution', () => {
    const testCase = {
      id: 'case-inline-materialized',
      name: 'Use inline email',
      dataBindingJson: JSON.stringify({ status: 'complete', mode: 'inline', source: 'case_contract_v1' }),
      steps: JSON.stringify([{
        action: 'Fill',
        element: 'Email',
        value: '{{email}}',
        verify: { equals: 'qa@example.test' },
      }]),
    };

    const materialized = materializeInlineEvidenceTokens(testCase);
    expect(materialized.replacements).toEqual(['email']);
    expect(JSON.parse(materialized.case.steps)[0].value).toBe('qa@example.test');
  });

  it('rejects malformed non-empty dataBindingJson instead of treating it as data-free', () => {
    const testCase = {
      id: 'case-invalid-json',
      name: 'Malformed binding case',
      dataBindingJson: '{not-json',
    };

    expect(validateCaseDataBinding(testCase, null, strictContext())).toMatchObject({
      code: 'data_binding_json_invalid',
      blockedReason: 'test_data_invalid',
    });
    expect(resolveCaseRows(testCase, null, strictContext())).toEqual([]);
  });

  it.each([
    ['empty sheet', [], []],
    ['header-only sheet', ['Value', 'Expected Result'], []],
    ['all-blank sheet', ['Value', 'Expected Result'], [{ Value: '   ', 'Expected Result': '' }]],
  ])('does not create workbook row bindings for an %s', (_label, headers, rows) => {
    const testData = strictContext();
    testData.sheets = [{ ...testData.sheets[0], headers, rows }];
    testData.mapping.sources = [testData.mapping.sources[0]];
    testData.mapping.bindings = [testData.mapping.bindings[0]];
    const testCase = caseWith({
      mappingId: 'mapping-a',
      testDataSetId: 'dataset-a',
      datasetRevisionId: 'revision-a',
      sheetId: 'sheet-a',
    });

    expect(validateCaseDataBinding(testCase, null, testData)).toMatchObject({
      code: 'data_binding_sheet_not_usable',
      blockedReason: 'test_data_invalid',
    });
    expect(resolveCaseRows(testCase, null, testData)).toEqual([]);
  });

  it('excludes blank rows while retaining the exact identity of usable workbook rows', () => {
    const testData = strictContext();
    testData.sheets = [{
      ...testData.sheets[0],
      rows: [
        { Value: '  ', 'Expected Result': '', __datasetRowId: 'row-blank' },
        {
          Value: 'same-value',
          'Expected Result': 'accepted',
          __datasetRowId: 'row-valid',
          __caseScopeId: 'case-valid',
          __planCaseId: 'plan-case-valid',
          __instancePlanId: 'instance-plan-valid',
          __instanceRevision: 'instance-revision-valid',
        },
      ],
    }];
    testData.mapping.sources = [testData.mapping.sources[0]];
    testData.mapping.bindings = [testData.mapping.bindings[0]];
    const testCase = {
      ...caseWith({
        mappingId: 'mapping-a',
        testDataSetId: 'dataset-a',
        datasetRevisionId: 'revision-a',
        sheetId: 'sheet-a',
        caseScopeId: 'case-valid',
      }),
      id: 'case-valid',
    };

    const rows = resolveCaseRows(testCase, null, testData);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowId: 'row-valid',
      sheet: 'Shared Matrix',
      sheetId: 'sheet-a',
      testDataSetId: 'dataset-a',
      datasetId: 'dataset-a',
      datasetRevisionId: 'revision-a',
      caseScopeId: 'case-valid',
      planCaseId: 'plan-case-valid',
      instancePlanId: 'instance-plan-valid',
      instanceRevision: 'instance-revision-valid',
      inputs: { value: 'same-value' },
      dataBindingRef: expect.objectContaining({
        rowId: 'row-valid',
        sheetId: 'sheet-a',
        datasetId: 'dataset-a',
        caseScopeId: 'case-valid',
        planCaseId: 'plan-case-valid',
        instancePlanId: 'instance-plan-valid',
        instanceRevision: 'instance-revision-valid',
      }),
    });
  });

  it('keeps identical values isolated by exact case scope, row, sheet, and dataset identity', () => {
    const testData = strictContext();
    testData.sheets[0].rows = [
      {
        Value: 'repeated-value',
        'Expected Result': 'case-a-result',
        __datasetRowId: 'row-case-a',
        __caseScopeId: 'case-a',
      },
      {
        Value: 'repeated-value',
        'Expected Result': 'case-b-result',
        __datasetRowId: 'row-case-b',
        __caseScopeId: 'case-b',
      },
    ];
    const scopedCase = (id) => ({
      ...caseWith({
        mappingId: 'mapping-a',
        testDataSetId: 'dataset-a',
        datasetRevisionId: 'revision-a',
        sheetId: 'sheet-a',
        caseScopeId: id,
      }),
      id,
    });

    const rowsA = resolveCaseRows(scopedCase('case-a'), null, testData);
    const rowsB = resolveCaseRows(scopedCase('case-b'), null, testData);

    expect(rowsA.map((row) => [row.rowId, row.expected, row.caseScopeId])).toEqual([
      ['row-case-a', 'case-a-result', 'case-a'],
    ]);
    expect(rowsB.map((row) => [row.rowId, row.expected, row.caseScopeId])).toEqual([
      ['row-case-b', 'case-b-result', 'case-b'],
    ]);
    expect(rowsA[0].inputs.value).toBe(rowsB[0].inputs.value);
    expect(rowsA[0].dataBindingRef).toMatchObject({
      testDataSetId: 'dataset-a',
      datasetRevisionId: 'revision-a',
      sheetId: 'sheet-a',
      rowId: 'row-case-a',
      caseScopeId: 'case-a',
    });
    expect(rowsB[0].dataBindingRef).toMatchObject({
      testDataSetId: 'dataset-a',
      datasetRevisionId: 'revision-a',
      sheetId: 'sheet-a',
      rowId: 'row-case-b',
      caseScopeId: 'case-b',
    });
  });
});
