import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const generationContract = require('../../server/services/testDataGenerationContract');
const approval = require('../../server/services/testDataApproval');
const testDataContext = require('../../server/services/testDataContext');
const originalLoadTestDataContext = testDataContext.loadTestDataContext;

afterEach(() => {
  testDataContext.loadTestDataContext = originalLoadTestDataContext;
  vi.restoreAllMocks();
});

function approvedContext({ complete = true } = {}) {
  return {
    selectedTestDataSetIds: ['dataset-a'],
    missingTestDataSetIds: [],
    unapprovedTestDataSetIds: [],
    mappingIssues: [],
    datasetContracts: [{ datasetId: 'dataset-a', stats: { complete } }],
    sheets: [{
      name: 'Login',
      testDataSetId: 'dataset-a',
      sheetId: 'sheet-a',
      datasetRevisionId: 'revision-a',
      rows: [{ Email: 'a@example.test' }],
    }],
    mapping: {
      status: 'approved',
      bindings: [{
        sheet: 'Login',
        sheetId: 'sheet-a',
        testDataSetId: 'dataset-a',
        datasetRevisionId: 'revision-a',
        mappingId: 'mapping-a',
        mappingVersion: 3,
        columnToField: { email: 'Email' },
      }],
    },
  };
}

describe('generation test-data identity contract', () => {
  it('resolves a binding by immutable dataset and sheet ids and preserves its pins', () => {
    const contract = generationContract.buildGenerationDataContract({
      sheets: [
        { name: 'Login', testDataSetId: 'dataset-a', sheetId: 'sheet-a', datasetRevisionId: 'rev-a', rows: [{ Email: 'a@example.test' }] },
        { name: 'Login', testDataSetId: 'dataset-b', sheetId: 'sheet-b', datasetRevisionId: 'rev-b', rows: [{ Email: 'b@example.test' }] },
      ],
      mapping: {
        bindings: [{
          sheet: 'Login',
          sheetId: 'sheet-b',
          testDataSetId: 'dataset-b',
          datasetRevisionId: 'rev-b',
          mappingId: 'mapping-b',
          mappingVersion: 7,
          columnToField: { email: 'Email' },
        }],
      },
    }, { source: 'approved' });

    expect(contract).toMatchObject({ status: 'ready', strict: true, bindingCount: 1 });
    expect(contract.bindings[0]).toMatchObject({
      testDataSetId: 'dataset-b',
      datasetId: 'dataset-b',
      datasetRevisionId: 'rev-b',
      sheetId: 'sheet-b',
      mappingId: 'mapping-b',
      mappingVersion: 7,
      valueCount: 1,
    });
    expect(contract.forbiddenLiterals).toEqual(['b@example.test']);
  });

  it('does not replace a stale explicit sheet id with a same-name sheet', () => {
    const contract = generationContract.buildGenerationDataContract({
      sheets: [{ name: 'Login', testDataSetId: 'dataset-a', sheetId: 'sheet-current', rows: [] }],
      mapping: { bindings: [{ sheet: 'Login', sheetId: 'sheet-stale', testDataSetId: 'dataset-a' }] },
    }, { source: 'approved' });

    expect(contract).toMatchObject({ status: 'blocked', strict: false, bindingCount: 0 });
    expect(contract.resolutionIssues).toEqual([
      expect.objectContaining({ code: 'missing_sheet_id', sheetId: 'sheet-stale' }),
    ]);
  });

  it('does not make a workbook binding executable until a mapped column has a usable row value', () => {
    const emptyMappedRows = generationContract.buildGenerationDataContract({
      sheets: [{
        name: 'Login',
        testDataSetId: 'dataset-a',
        sheetId: 'sheet-a',
        rows: [{ Email: '' }, { Notes: 'unrelated metadata' }, {}],
      }],
      mapping: {
        bindings: [{
          sheet: 'Login',
          sheetId: 'sheet-a',
          testDataSetId: 'dataset-a',
          columnToField: { email: 'Email' },
        }],
      },
    }, { source: 'approved' });

    expect(emptyMappedRows).toMatchObject({
      status: 'empty',
      strict: false,
      bindingCount: 0,
      executableSheetNames: [],
      allowedTokens: [],
    });

    const usableMappedRow = generationContract.buildGenerationDataContract({
      sheets: [{
        name: 'Login',
        testDataSetId: 'dataset-a',
        sheetId: 'sheet-a',
        rows: [{ Email: '' }, { Email: 'usable@example.test' }],
      }],
      mapping: {
        bindings: [{
          sheet: 'Login',
          sheetId: 'sheet-a',
          testDataSetId: 'dataset-a',
          columnToField: { email: 'Email' },
        }],
      },
    }, { source: 'approved' });

    expect(usableMappedRow).toMatchObject({ status: 'ready', strict: true, bindingCount: 1 });
    expect(usableMappedRow.bindings[0]).toMatchObject({
      rowCount: 1,
      sourceRowCount: 2,
      usableRowCount: 1,
    });
  });

  it('normalizes only explicit non-empty mapping revision pins', () => {
    expect(generationContract._private.normalizeMappingPins({
      ' dataset-a ': ' mapping-a ',
      'dataset-b': '',
    })).toEqual({ 'dataset-a': 'mapping-a' });
  });

  it('blocks approval when a sheet name is duplicate instead of last-wins selection', () => {
    const result = approval.verifyMapping({
      mapping: { bindings: [{ sheet: 'Login', columnToField: { email: 'Email' } }] },
      sheets: [
        { name: 'Login', headers: ['Email'], rows: [] },
        { name: 'login', headers: ['Email'], rows: [] },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'ambiguous_sheet_reference', severity: 'error' }),
    ]);
  });

  it('loads the exact reviewed mapping id instead of selecting a newer approval', async () => {
    const calls = [];
    testDataContext.loadTestDataContext = vi.fn(async (_projectId, _sprintId, options) => {
      calls.push(options);
      return options.approvedOnly ? approvedContext() : approvedContext();
    });

    const result = await generationContract.loadGenerationTestDataContract({
      projectId: 'project-a',
      testDataSetIds: ['dataset-a'],
      mappingPins: { 'dataset-a': 'mapping-a' },
      requireApproved: true,
    });

    expect(result.status).toBe('ready');
    expect(calls[1].mappingPins).toEqual({ 'dataset-a': 'mapping-a' });
    expect(result.contract.bindings[0]).toMatchObject({
      mappingId: 'mapping-a',
      mappingVersion: 3,
      datasetRevisionId: 'revision-a',
      sheetId: 'sheet-a',
    });
  });

  it('fails closed when a selected dataset lacks a reviewed mapping pin', async () => {
    testDataContext.loadTestDataContext = vi.fn(async () => approvedContext());

    const result = await generationContract.loadGenerationTestDataContract({
      projectId: 'project-a',
      testDataSetIds: ['dataset-a'],
      mappingPins: {},
      requireApproved: true,
    });

    expect(result.status).toBe('needs_approval');
    expect(result.blockers).toContainEqual({
      code: 'approved_mapping_pin_required',
      testDataSetIds: ['dataset-a'],
    });
  });

  it('fails closed when parser truncation makes the dataset contract incomplete', async () => {
    testDataContext.loadTestDataContext = vi.fn(async () => approvedContext({ complete: false }));

    const result = await generationContract.loadGenerationTestDataContract({
      projectId: 'project-a',
      testDataSetIds: ['dataset-a'],
      mappingPins: { 'dataset-a': 'mapping-a' },
      requireApproved: true,
    });

    expect(result.status).toBe('needs_approval');
    expect(result.blockers).toContainEqual({
      code: 'dataset_contract_incomplete',
      testDataSetIds: ['dataset-a'],
    });
  });
});
