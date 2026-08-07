import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const datasetContract = require('../../server/services/datasetContractV1');

function workbookSheets() {
  return [
    {
      name: 'Order validation',
      headers: ['Story ID', 'Intent', 'Email', 'Password', 'Amount', 'Expected Result'],
      rows: [
        {
          'Story ID': 'US-ORD-101',
          Intent: 'positive',
          Email: 'buyer-one@example.test',
          Password: 'First-Never-Persist-Secret',
          Amount: '20.00',
          'Expected Result': 'Order accepted',
        },
        {
          'Story ID': 'US-ORD-101',
          Intent: 'positive',
          Email: 'buyer-two@example.test',
          Password: 'Second-Never-Persist-Secret',
          Amount: '50.00',
          'Expected Result': 'Order accepted',
        },
        {
          'Story ID': 'US-ORD-101',
          Intent: 'negative',
          Email: 'buyer-three@example.test',
          Password: 'Third-Never-Persist-Secret',
          Amount: '-1',
          'Expected Result': 'Amount rejected',
        },
      ],
    },
    {
      name: 'Authentication profiles',
      headers: ['Username', 'Password'],
      rows: [{ Username: 'qa-user@example.test', Password: 'Auth-Never-Persist-Secret' }],
    },
  ];
}

function build(overrides = {}) {
  return datasetContract.buildDatasetContractV1({
    testDataSetId: 'dataset-orders',
    projectId: 'project-one',
    sourceName: 'orders.xlsx',
    parsedSheets: workbookSheets(),
    ...overrides,
  });
}

describe('DatasetContractV1', () => {
  it('builds deterministic revision, sheet, column, row, and row-group identities', () => {
    const first = build();
    const second = build();

    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe('dataset-contract-v1');
    expect(first.datasetRevisionId).toMatch(/^dsv1:[a-f0-9]{64}$/);
    expect(first.contractId).toMatch(/^dataset-contract:[a-f0-9]{32}$/);
    expect(first.sheets.every((sheet) => /^sheet:[a-f0-9]{32}$/.test(sheet.sheetId))).toBe(true);
    expect(first.sheets.flatMap((sheet) => sheet.columns).every((column) => /^column:[a-f0-9]{32}$/.test(column.columnId))).toBe(true);
    expect(first.sheets.flatMap((sheet) => sheet.rows).every((row) => /^row:[a-f0-9]{32}$/.test(row.rowId))).toBe(true);
    expect(first.sheets.flatMap((sheet) => sheet.rowGroups).every((group) => /^row-group:[a-f0-9]{32}$/.test(group.rowGroupId))).toBe(true);
    expect(datasetContract.validateDatasetContractV1(first)).toEqual(expect.objectContaining({ ok: true, errors: [] }));
  });

  it('changes the immutable dataset revision when any source cell changes', () => {
    const original = build();
    const changedSheets = workbookSheets();
    changedSheets[0].rows[0].Amount = '20.01';
    const changed = build({ parsedSheets: changedSheets });

    expect(changed.datasetRevisionId).not.toBe(original.datasetRevisionId);
    expect(changed.contractId).not.toBe(original.contractId);
  });

  it('contains only hashes and resolvable value references, never workbook cell values', () => {
    const contract = build();
    const serialized = JSON.stringify(contract);

    expect(serialized).not.toContain('buyer-one@example.test');
    expect(serialized).not.toContain('First-Never-Persist-Secret');
    expect(serialized).not.toContain('Order accepted');
    expect(serialized).not.toContain('qa-user@example.test');
    expect(serialized).not.toContain('Auth-Never-Persist-Secret');

    const orderSheet = contract.sheets[0];
    const passwordColumn = orderSheet.columns.find((column) => column.header === 'Password');
    const emailColumn = orderSheet.columns.find((column) => column.header === 'Email');
    expect(passwordColumn.sensitivity).toBe('masked');
    expect(emailColumn.sensitivity).toBe('restricted');
    expect(orderSheet.rows[0].valueRefs[passwordColumn.columnId]).toContain(contract.datasetRevisionId);
    expect(orderSheet.rows[0].valueRefs[emailColumn.columnId]).toContain(orderSheet.rows[0].rowId);
  });

  it('partitions rows by story, intent, input topology, and oracle topology without making one case per row', () => {
    const contract = build();
    const groups = contract.sheets[0].rowGroups;

    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.intentClass === 'positive')).toEqual(expect.objectContaining({
      storyId: 'US-ORD-101',
      rowCount: 2,
    }));
    expect(groups.find((group) => group.intentClass === 'negative')).toEqual(expect.objectContaining({
      storyId: 'US-ORD-101',
      rowCount: 1,
    }));
    expect(groups.every((group) => group.oracleSignature.length === 1)).toBe(true);
  });

  it('reports parser truncation as an incomplete source instead of silently certifying it', () => {
    const contract = build({
      parserManifest: {
        parserVersion: 'xlsx-parser-7',
        sourceSheetCount: 3,
        sourceRowCount: 10,
        complete: false,
        truncations: [{ code: 'row_limit', sheet: 'Order validation', limit: 3, actual: 9, kept: 3 }],
      },
    });
    const validation = datasetContract.validateDatasetContractV1(contract);

    expect(contract.source.complete).toBe(false);
    expect(contract.stats.complete).toBe(false);
    expect(contract.findings).toContainEqual(expect.objectContaining({ code: 'dataset_source_partial' }));
    expect(validation.warnings).toContainEqual({ code: 'dataset_source_partial' });
  });

  it('never resolves duplicate sheet names by candidate order', () => {
    const first = build();
    const secondSheets = workbookSheets();
    secondSheets[0].rows[0].Amount = '99.99';
    const second = build({ testDataSetId: 'dataset-orders-two', parsedSheets: secondSheets });
    const catalog = datasetContract.buildProjectDatasetCatalogV1([first, second]);

    const ambiguous = datasetContract.resolveSheet(catalog, { sheetName: 'order VALIDATION' });
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.sheet).toBeNull();
    expect(ambiguous.candidates).toHaveLength(2);

    const exact = datasetContract.resolveSheet(catalog, {
      datasetRevisionId: first.datasetRevisionId,
      sheetId: first.sheets[0].sheetId,
    });
    expect(exact.status).toBe('resolved');
    expect(exact.sheet.sheetId).toBe(first.sheets[0].sheetId);
  });

  it('keeps mapping identity and sensitivity metadata while excluding mapped values', () => {
    const contract = build({
      mappingSnapshot: {
        mappingId: 'mapping-orders',
        version: 4,
        status: 'approved',
        mapping: {
          bindings: [{
            sheet: 'Order validation',
            purpose: 'data_matrix',
            module: 'orders',
            columnToField: { email: 'Email', password: 'Password', amount: 'Amount' },
            sensitivity: { email: 'restricted', password: 'masked', amount: 'synthetic' },
          }],
        },
      },
    });
    const sheet = contract.sheets[0];

    expect(contract.mappingRef).toEqual(expect.objectContaining({ mappingId: 'mapping-orders', version: 4, status: 'approved' }));
    expect(sheet.module).toBe('orders');
    expect(sheet.bindingRef).toEqual(expect.objectContaining({ mappingId: 'mapping-orders', mappingVersion: 4 }));
    expect(sheet.columns.find((column) => column.header === 'Email').mappedRoles).toEqual(['email']);
    expect(JSON.stringify(contract)).not.toContain('buyer-two@example.test');
  });
});
