import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  loadTestDataContext,
  loadPinnedTestDataContext,
  resolveContractSheetReference,
  verifyDatasetContractAgainstRaw,
  assertPinnedContextIntegrity,
} = require('../../server/services/testDataContext');
const executionDataPinScope = require('../../server/services/executionDataPinScope');
const { validateCaseDataBinding } = require('../../server/services/testDataMatrix');
const {
  buildDatasetContractV1,
  buildProjectDatasetCatalogV1,
  withMappingSnapshot,
} = require('../../server/services/datasetContractV1');
const prisma = require('../../server/prisma');

function rawSheets() {
  return [{
    name: 'Identity',
    headers: ['Email', 'Expected'],
    rows: [
      { Email: 'first@example.test', Expected: 'accepted' },
      { Email: 'second@example.test', Expected: 'accepted' },
    ],
  }, {
    name: 'Orders',
    headers: ['Amount', 'Expected'],
    rows: [{ Amount: '10.00', Expected: 'created' }],
  }];
}

function persistedContract(sheets = rawSheets()) {
  return buildDatasetContractV1({
    testDataSetId: 'dataset-1',
    projectId: 'project-1',
    sourceName: 'data.xlsx',
    parsedSheets: sheets,
  });
}

function runtimeDataset({ datasetId, mappingId, sheetName, value }) {
  const sheets = [{
    name: sheetName,
    headers: ['Value', 'Expected'],
    rows: [{ Value: value, Expected: 'accepted' }],
  }];
  const mapping = {
    version: 1,
    bindings: [{
      sheet: sheetName,
      columnToField: { value: 'Value' },
      expectedColumn: 'Expected',
    }],
  };
  const baseContract = buildDatasetContractV1({
    testDataSetId: datasetId,
    projectId: 'project-1',
    sourceName: `${datasetId}.xlsx`,
    parsedSheets: sheets,
  });
  mapping.bindings[0].sheetId = baseContract.sheets[0].sheetId;
  const contract = withMappingSnapshot(baseContract, {
    id: mappingId,
    version: 1,
    status: 'approved',
    mapping,
  });
  return {
    contract,
    mapping,
    mappingRow: {
      id: mappingId,
      version: 1,
      status: 'approved',
      mappingJson: JSON.stringify(mapping),
    },
    row: {
      id: datasetId,
      name: `${datasetId}.xlsx`,
      rowCount: 1,
      uploadedAt: new Date(),
      sheetsJson: JSON.stringify({ sheets }),
      mappingJson: JSON.stringify(mapping),
      workbookContractJson: JSON.stringify({ datasetContractV1: contract }),
    },
  };
}

describe('testDataContext strict runtime pins', () => {
  it('rejects a data-bound pin missing mappingId before loading any fallback context', async () => {
    await expect(loadPinnedTestDataContext('project-1', null, [{
      caseId: 'case-1',
      testDataSetId: 'dataset-1',
      datasetRevisionId: 'revision-1',
      sheetId: 'sheet-1',
    }])).rejects.toMatchObject({
      code: 'PINNED_TEST_DATA_UNAVAILABLE',
      findings: [expect.objectContaining({
        code: 'pinned_mapping_id_missing',
        caseId: 'case-1',
        testDataSetId: 'dataset-1',
      })],
    });
  });

  it('projects an incomplete execution pin into a case-level test_data_invalid defect', async () => {
    const testCase = {
      id: 'case-incomplete',
      name: 'Incomplete data case',
      dataBindingJson: JSON.stringify({
        status: 'incomplete',
        findings: [{ code: 'story_id_no_data', detail: 'No exact row alignment exists.' }],
      }),
    };

    await executionDataPinScope.runWithExecutionDataPins({
      scenarios: [{ cases: [testCase, { id: 'data-free', dataBindingJson: null }] }],
    }, async () => {
      const context = await loadTestDataContext('project-1');
      expect(context.pinValidationError).toMatchObject({
        code: 'PINNED_TEST_DATA_UNAVAILABLE',
        findings: [expect.objectContaining({ code: 'pinned_mapping_id_missing', caseId: 'case-incomplete' })],
      });
      expect(validateCaseDataBinding(testCase, null, context)).toMatchObject({
        code: 'PINNED_TEST_DATA_UNAVAILABLE',
        blockedReason: 'test_data_invalid',
      });
    });
  });

  it('surfaces malformed non-empty dataBindingJson as a pin-validation error', async () => {
    const testCase = {
      id: 'case-invalid-json',
      name: 'Malformed binding case',
      dataBindingJson: '{not-json',
    };

    await executionDataPinScope.runWithExecutionDataPins({
      scenarios: [{ cases: [testCase] }],
    }, async () => {
      const context = await loadTestDataContext('project-1');
      expect(context.pinValidationError).toMatchObject({
        code: 'PINNED_TEST_DATA_UNAVAILABLE',
        findings: [{ code: 'data_binding_json_invalid', caseId: 'case-invalid-json' }],
      });
      expect(validateCaseDataBinding(testCase, null, context)).toMatchObject({
        code: 'PINNED_TEST_DATA_UNAVAILABLE',
        blockedReason: 'test_data_invalid',
      });
    });
  });

  it('does not substitute a same-name sheet when an explicit sheetId is missing', () => {
    const sheets = [
      { sheetId: 'sheet-current', name: 'Shared Matrix' },
    ];

    expect(resolveContractSheetReference(sheets, {
      sheetId: 'sheet-stale',
      sheet: 'Shared Matrix',
    })).toEqual([]);
    expect(resolveContractSheetReference(sheets, {
      sheet: 'shared matrix',
    })).toEqual([sheets[0]]);
  });

  it('rebuilds raw identities and resolves persisted sheets by immutable ID rather than array position', () => {
    const persisted = persistedContract();
    const reorderedPersistence = {
      ...persisted,
      sheets: [...persisted.sheets].reverse(),
    };
    const verification = verifyDatasetContractAgainstRaw({
      persistedContract: reorderedPersistence,
      testDataSetId: 'dataset-1',
      projectId: 'project-1',
      sourceName: 'data.xlsx',
      rawSheets: rawSheets(),
    });

    expect(verification.ok).toBe(true);
    expect(verification.rawSheetIds).toEqual(persisted.sheets.map((sheet) => sheet.sheetId));
    expect(verification.rawSheetIds).not.toEqual(reorderedPersistence.sheets.map((sheet) => sheet.sheetId));
  });

  it('detects raw-sheet revision drift and tampered persisted row identity', () => {
    const originalSheets = rawSheets();
    const persisted = persistedContract(originalSheets);
    const changedSheets = rawSheets();
    changedSheets[0].rows[0].Expected = 'rejected';
    const revisionDrift = verifyDatasetContractAgainstRaw({
      persistedContract: persisted,
      testDataSetId: 'dataset-1',
      projectId: 'project-1',
      sourceName: 'data.xlsx',
      rawSheets: changedSheets,
    });
    const tampered = JSON.parse(JSON.stringify(persisted));
    tampered.sheets[0].rows[0].rowHash = 'tampered-row-hash';
    const rowTamper = verifyDatasetContractAgainstRaw({
      persistedContract: tampered,
      testDataSetId: 'dataset-1',
      projectId: 'project-1',
      sourceName: 'data.xlsx',
      rawSheets: originalSheets,
    });

    expect(revisionDrift.ok).toBe(false);
    expect(revisionDrift.issues).toContainEqual(expect.objectContaining({ code: 'dataset_contract_revision_mismatch' }));
    expect(rowTamper.ok).toBe(false);
    expect(rowTamper.issues).toContainEqual(expect.objectContaining({ code: 'dataset_contract_row_identity_mismatch' }));
  });

  it('surfaces a missing persisted contract and blocks pinned context integrity findings', () => {
    const missing = verifyDatasetContractAgainstRaw({
      persistedContract: null,
      testDataSetId: 'dataset-1',
      projectId: 'project-1',
      sourceName: 'data.xlsx',
      rawSheets: rawSheets(),
    });

    expect(missing).toMatchObject({
      ok: false,
      issues: [{ code: 'dataset_contract_missing' }],
    });
    expect(() => assertPinnedContextIntegrity({ mappingIssues: missing.issues })).toThrowError(expect.objectContaining({
      code: 'PINNED_TEST_DATA_UNAVAILABLE',
      findings: missing.issues,
    }));
    expect(() => assertPinnedContextIntegrity({ mappingIssues: [] })).not.toThrow();
  });

  it('loads verified IDs despite persisted array reordering and makes loadPinned fail after raw tampering', async () => {
    const sheets = rawSheets();
    const mapping = {
      version: 1,
      bindings: [{ sheet: 'Identity', columnToField: { email: 'Email' }, expectedColumn: 'Expected' }],
    };
    const contract = buildDatasetContractV1({
      testDataSetId: 'dataset-1',
      projectId: 'project-1',
      sourceName: 'data.xlsx',
      parsedSheets: sheets,
      mappingSnapshot: { id: 'mapping-1', version: 1, status: 'approved', mapping },
    });
    mapping.bindings[0].sheetId = contract.sheets[0].sheetId;
    const persisted = {
      ...contract,
      sheets: [...contract.sheets].reverse(),
    };
    const row = {
      id: 'dataset-1',
      name: 'data.xlsx',
      rowCount: 3,
      uploadedAt: new Date(),
      sheetsJson: JSON.stringify({ sheets }),
      mappingJson: JSON.stringify(mapping),
      workbookContractJson: JSON.stringify({ datasetContractV1: persisted }),
    };
    const findMany = vi.spyOn(prisma.testDataSet, 'findMany').mockImplementation(async () => [row]);
    const findApproved = vi.spyOn(prisma.testDataMapping, 'findFirst').mockResolvedValue({
      id: 'mapping-1',
      version: 1,
      status: 'approved',
      mappingJson: JSON.stringify(mapping),
    });

    try {
      const context = await loadTestDataContext('project-1', null, {
        approvedOnly: true,
        testDataSetIds: ['dataset-1'],
        mappingPins: { 'dataset-1': 'mapping-1' },
        _ignoreExecutionDataPinScope: true,
      });
      expect(context.mappingIssues).toEqual([]);
      expect(context.sheets[0]).toMatchObject({
        sheetId: contract.sheets[0].sheetId,
        datasetRevisionId: contract.datasetRevisionId,
      });
      expect(context.sheets[0].rows.map((item) => item.__datasetRowId))
        .toEqual(contract.sheets[0].rows.map((item) => item.rowId));

      const tamperedSheets = rawSheets();
      tamperedSheets[0].rows[0].Expected = 'tampered';
      row.sheetsJson = JSON.stringify({ sheets: tamperedSheets });
      await expect(loadPinnedTestDataContext('project-1', null, [{
        caseId: 'case-1',
        testDataSetId: 'dataset-1',
        mappingId: 'mapping-1',
        mappingVersion: 1,
        datasetRevisionId: contract.datasetRevisionId,
        sheetId: contract.sheets[0].sheetId,
      }])).rejects.toMatchObject({
        code: 'PINNED_TEST_DATA_UNAVAILABLE',
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'dataset_contract_revision_mismatch', testDataSetId: 'dataset-1' }),
        ]),
      });
    } finally {
      findMany.mockRestore();
      findApproved.mockRestore();
    }
  });

  it('verifies a generation-wide catalog while loading only the selected case dataset', async () => {
    const identity = runtimeDataset({
      datasetId: 'dataset-identity',
      mappingId: 'mapping-identity',
      sheetName: 'Identity',
      value: 'user@example.test',
    });
    const orders = runtimeDataset({
      datasetId: 'dataset-orders',
      mappingId: 'mapping-orders',
      sheetName: 'Orders',
      value: 'order-100',
    });
    const generationCatalog = buildProjectDatasetCatalogV1([identity.contract, orders.contract]);
    const rowsById = new Map([
      [identity.row.id, identity.row],
      [orders.row.id, orders.row],
    ]);
    const mappingsById = new Map([
      [identity.mappingRow.id, identity.mappingRow],
      [orders.mappingRow.id, orders.mappingRow],
    ]);
    const findMany = vi.spyOn(prisma.testDataSet, 'findMany').mockImplementation(async ({ where }) => (
      (where && where.id && Array.isArray(where.id.in) ? where.id.in : Array.from(rowsById.keys()))
        .map((id) => rowsById.get(id))
        .filter(Boolean)
    ));
    const findApproved = vi.spyOn(prisma.testDataMapping, 'findFirst').mockImplementation(async ({ where }) => (
      mappingsById.get(where && where.id) || null
    ));
    const findGeneration = vi.spyOn(prisma.scenarioGeneration, 'findFirst').mockResolvedValue({
      id: 'generation-1',
      coveragePlanJson: JSON.stringify({ datasetCatalogV1: generationCatalog }),
    });

    try {
      const context = await loadPinnedTestDataContext('project-1', null, [{
        caseId: 'case-identity-only',
        generationId: 'generation-1',
        testDataSetId: 'dataset-identity',
        mappingId: 'mapping-identity',
        mappingVersion: 1,
        workbookHash: generationCatalog.catalogId,
        datasetRevisionId: identity.contract.datasetRevisionId,
        sheetId: identity.contract.sheets[0].sheetId,
        rowGroupId: identity.contract.sheets[0].rowGroups[0].rowGroupId,
      }]);

      expect(context.selectedTestDataSetIds).toEqual(['dataset-identity']);
      expect(context.datasetContracts.map((item) => item.datasetId)).toEqual(['dataset-identity']);
      expect(context.datasetCatalog.catalogId).not.toBe(generationCatalog.catalogId);
      expect(findGeneration).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'generation-1', projectId: 'project-1' },
      }));
    } finally {
      findMany.mockRestore();
      findApproved.mockRestore();
      findGeneration.mockRestore();
    }
  });

  it('fails closed when the persisted generation catalog cannot reproduce its own hash', async () => {
    const identity = runtimeDataset({
      datasetId: 'dataset-identity',
      mappingId: 'mapping-identity',
      sheetName: 'Identity',
      value: 'user@example.test',
    });
    const orders = runtimeDataset({
      datasetId: 'dataset-orders',
      mappingId: 'mapping-orders',
      sheetName: 'Orders',
      value: 'order-100',
    });
    const generationCatalog = buildProjectDatasetCatalogV1([identity.contract, orders.contract]);
    const tamperedCatalog = JSON.parse(JSON.stringify(generationCatalog));
    tamperedCatalog.datasets.pop();
    const findMany = vi.spyOn(prisma.testDataSet, 'findMany').mockResolvedValue([identity.row]);
    const findApproved = vi.spyOn(prisma.testDataMapping, 'findFirst').mockResolvedValue(identity.mappingRow);
    const findGeneration = vi.spyOn(prisma.scenarioGeneration, 'findFirst').mockResolvedValue({
      id: 'generation-1',
      coveragePlanJson: JSON.stringify({ datasetCatalogV1: tamperedCatalog }),
    });

    try {
      await expect(loadPinnedTestDataContext('project-1', null, [{
        caseId: 'case-identity-only',
        generationId: 'generation-1',
        testDataSetId: 'dataset-identity',
        mappingId: 'mapping-identity',
        mappingVersion: 1,
        workbookHash: generationCatalog.catalogId,
        datasetRevisionId: identity.contract.datasetRevisionId,
        sheetId: identity.contract.sheets[0].sheetId,
      }])).rejects.toMatchObject({
        code: 'PINNED_TEST_DATA_UNAVAILABLE',
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'pinned_generation_catalog_integrity_mismatch' }),
        ]),
      });
    } finally {
      findMany.mockRestore();
      findApproved.mockRestore();
      findGeneration.mockRestore();
    }
  });

  it('resolves an older case hash from immutable catalog history after append', async () => {
    const identity = runtimeDataset({
      datasetId: 'dataset-identity',
      mappingId: 'mapping-identity',
      sheetName: 'Identity',
      value: 'user@example.test',
    });
    const orders = runtimeDataset({
      datasetId: 'dataset-orders',
      mappingId: 'mapping-orders',
      sheetName: 'Orders',
      value: 'order-100',
    });
    const appended = runtimeDataset({
      datasetId: 'dataset-profile',
      mappingId: 'mapping-profile',
      sheetName: 'Profile',
      value: 'display-name',
    });
    const originalCatalog = buildProjectDatasetCatalogV1([identity.contract, orders.contract]);
    const appendedCatalog = buildProjectDatasetCatalogV1([identity.contract, orders.contract, appended.contract]);
    const findMany = vi.spyOn(prisma.testDataSet, 'findMany').mockResolvedValue([identity.row]);
    const findApproved = vi.spyOn(prisma.testDataMapping, 'findFirst').mockResolvedValue(identity.mappingRow);
    const findGeneration = vi.spyOn(prisma.scenarioGeneration, 'findFirst').mockResolvedValue({
      id: 'generation-1',
      coveragePlanJson: JSON.stringify({
        datasetCatalogV1: appendedCatalog,
        contractHistory: { datasetCatalogV1: [originalCatalog, appendedCatalog] },
      }),
    });

    try {
      const context = await loadPinnedTestDataContext('project-1', null, [{
        caseId: 'case-created-before-append',
        generationId: 'generation-1',
        testDataSetId: 'dataset-identity',
        mappingId: 'mapping-identity',
        mappingVersion: 1,
        workbookHash: originalCatalog.catalogId,
        datasetRevisionId: identity.contract.datasetRevisionId,
        sheetId: identity.contract.sheets[0].sheetId,
      }]);

      expect(context.selectedTestDataSetIds).toEqual(['dataset-identity']);
      expect(context.datasetCatalog.catalogId).not.toBe(originalCatalog.catalogId);
      expect(appendedCatalog.catalogId).not.toBe(originalCatalog.catalogId);
    } finally {
      findMany.mockRestore();
      findApproved.mockRestore();
      findGeneration.mockRestore();
    }
  });

  it('fails closed when an exact mapping id/version has different content than the catalog snapshot', async () => {
    const identity = runtimeDataset({
      datasetId: 'dataset-identity',
      mappingId: 'mapping-identity',
      sheetName: 'Identity',
      value: 'user@example.test',
    });
    const orders = runtimeDataset({
      datasetId: 'dataset-orders',
      mappingId: 'mapping-orders',
      sheetName: 'Orders',
      value: 'order-100',
    });
    const generationCatalog = buildProjectDatasetCatalogV1([identity.contract, orders.contract]);
    const changedMapping = JSON.parse(JSON.stringify(identity.mapping));
    changedMapping.bindings[0].columnToField.value = 'Expected';
    const findMany = vi.spyOn(prisma.testDataSet, 'findMany').mockResolvedValue([identity.row]);
    const findApproved = vi.spyOn(prisma.testDataMapping, 'findFirst').mockResolvedValue({
      ...identity.mappingRow,
      mappingJson: JSON.stringify(changedMapping),
    });
    const findGeneration = vi.spyOn(prisma.scenarioGeneration, 'findFirst').mockResolvedValue({
      id: 'generation-1',
      coveragePlanJson: JSON.stringify({ datasetCatalogV1: generationCatalog }),
    });

    try {
      await expect(loadPinnedTestDataContext('project-1', null, [{
        caseId: 'case-identity-only',
        generationId: 'generation-1',
        testDataSetId: 'dataset-identity',
        mappingId: 'mapping-identity',
        mappingVersion: 1,
        workbookHash: generationCatalog.catalogId,
        datasetRevisionId: identity.contract.datasetRevisionId,
        sheetId: identity.contract.sheets[0].sheetId,
      }])).rejects.toMatchObject({
        code: 'PINNED_TEST_DATA_UNAVAILABLE',
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'pinned_generation_catalog_mapping_revision_mismatch' }),
        ]),
      });
    } finally {
      findMany.mockRestore();
      findApproved.mockRestore();
      findGeneration.mockRestore();
    }
  });
});
