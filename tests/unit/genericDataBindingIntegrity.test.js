import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sheetPolicy = require('../../server/services/testDataSheetPolicy');
const workbook = require('../../server/services/workbookContract');
const bindings = require('../../server/services/testDataBindingContract');
const inlineCases = require('../../server/services/inlineCaseInstanceContract');
const matrix = require('../../server/services/testDataMatrix');

describe('generic data-binding integrity', () => {
  it('requires headers and a usable non-empty row before a sheet can generate tokens', () => {
    expect(sheetPolicy.analyzeSheetUsability({ name: 'Header only', headers: ['Value'], rows: [] }))
      .toMatchObject({ usable: false, reason: 'sheet_rows_empty', usableRowCount: 0 });
    expect(sheetPolicy.analyzeSheetUsability({ name: 'Malformed', headers: [], rows: [null, 'bad'] }))
      .toMatchObject({ usable: false, reason: 'sheet_headers_missing' });
    expect(sheetPolicy.analyzeSheetUsability({ name: 'Empty objects', headers: ['Value'], rows: [{}, { Value: ' ' }] }))
      .toMatchObject({ usable: false, reason: 'sheet_rows_empty' });
    expect(sheetPolicy.analyzeSheetUsability({ name: 'Usable', headers: ['Value'], rows: [{ Value: '' }, { Value: 'alpha' }] }))
      .toMatchObject({ usable: true, usableRowCount: 1, sourceRowCount: 2 });
    expect(sheetPolicy.analyzeSheetUsability({ name: 'Wrong column', headers: ['Value'], rows: [{ Value: 'alpha' }] }, ['Expected']))
      .toMatchObject({ usable: false, reason: 'mapped_column_missing' });
  });

  it('excludes empty/header-only sheets from workbook coverage and token vocabulary', () => {
    const contract = workbook.buildWorkbookContract({
      sheets: [
        { name: 'HeaderOnly', headers: ['Input'], rows: [] },
        { name: 'ActualRows', headers: ['Input', 'Unused'], rows: [{ Input: 'alpha', Unused: '' }] },
      ],
    });
    expect(contract.sheets.find((sheet) => sheet.name === 'HeaderOnly')).toMatchObject({ mappingEligible: false, sourceRowCount: 0, usableRowCount: 0 });
    expect(workbook.buildCoverageItems(contract)).toEqual([
      expect.objectContaining({ sheet: 'ActualRows', rowCount: 1, requiredPlaceholders: ['Input'] }),
    ]);
  });

  it('uses identical inline-data precedence for initial upload and Add Scenario', () => {
    const input = {
      narrativeValues: { count: 'from narrative', state: 'narrative state' },
      uploadedTextValues: { count: 'from upload' },
      pastedTextValues: { count: 'from paste' },
      inlineDataValues: { count: 66, state: 'active' },
    };
    const initial = inlineCases.resolveInlineValueSources({ ...input, surface: 'initial_upload' });
    const added = inlineCases.resolveInlineValueSources({ ...input, surface: 'add_scenario' });
    expect(initial.values).toEqual({ count: 66, state: 'active' });
    expect(added.values).toEqual(initial.values);
    expect(initial.provenance).toEqual({ count: 'inline_data_block', state: 'inline_data_block' });
  });

  it('classifies all six binding kinds and proves workbook tokens to a usable row', () => {
    const caseObj = { dataBinding: { sheet: 'Data', columnToField: { account: 'Account' } } };
    const generationContract = {
      bindings: [{ sheet: 'Data', columnToField: { account: 'Account' }, usableRowCount: 1 }],
    };
    expect(bindings.classifyBinding({ value: 'plain', label: 'Account' })).toMatchObject({ kind: 'literal', value: 'plain' });
    expect(bindings.classifyBinding({ value: 'literal-secret', label: 'Secret field' })).toMatchObject({ kind: 'secret_env', reference: 'env:QAAI_SECRET_FIELD', sourceLiteralPresent: true });
    expect(bindings.classifyBinding({ value: 'env:QAAI_SECRET', label: 'Secret field' })).toMatchObject({ kind: 'secret_env' });
    expect(bindings.classifyBinding({ value: '{{account}}', caseObj, generationContract })).toMatchObject({ kind: 'workbook_column', sheet: 'Data', column: 'Account', usableRowCount: 1 });
    expect(bindings.classifyBinding({ value: 'runtime:created-id' })).toMatchObject({ kind: 'runtime_output' });
    expect(bindings.classifyBinding({ value: 'dependency:previous-case.output' })).toMatchObject({ kind: 'dependency_output' });
    expect(bindings.classifyBinding({ value: 'generated:unique-value' })).toMatchObject({ kind: 'generated_value' });
  });

  it('does not let one case consume another case scoped row even when labels repeat', () => {
    const testData = {
      sheets: [{
        name: 'Shared', headers: ['Value'],
        rows: [
          { Value: 'case-a-value', __caseScopeId: 'case-a', __datasetRowId: 'row-a' },
          { Value: 'case-b-value', __caseScopeId: 'case-b', __datasetRowId: 'row-b' },
        ],
      }],
      mapping: { bindings: [{ sheet: 'Shared', columnToField: { value: 'Value' } }] },
    };
    const testCase = {
      id: 'case-a',
      name: 'Use repeated label',
      steps: JSON.stringify([{ action: 'Fill', element: 'Value', value: '{{value}}' }]),
      dataBindingJson: JSON.stringify({ sheet: 'Shared', caseScopeId: 'case-a', columnToField: { value: 'Value' } }),
    };
    expect(matrix.resolveCaseRows(testCase, null, testData).map((row) => row.inputs.value)).toEqual(['case-a-value']);

    const wrongCase = { ...testCase, id: 'case-b' };
    expect(matrix.validateCaseDataBinding(wrongCase, null, testData)).toMatchObject({ code: 'data_binding_case_scope_mismatch' });
    expect(matrix.resolveCaseRows(wrongCase, null, testData)).toEqual([]);
  });
});
