'use strict';

/**
 * Load a project's uploaded + mapped test data into the compact shape the
 * Architect's buildTestDataBlock() consumes (TestData Round A — M-C glue).
 *
 * Merges every TestDataSet for the project (optionally sprint-scoped): all
 * sheets concatenated, all mapping bindings/unmapped concatenated. Returns null
 * when the project has no test data — so callers pass `testData: null` and the
 * Architect runs exactly as before (no behaviour change until data is uploaded).
 *
 * Enterprise Mode P4a — `{ approvedOnly }`: when true, the mapping source is the
 * latest APPROVED, immutable `TestDataMapping` row per set (not the editable
 * `TestDataSet.mappingJson` draft), and every binding is stamped with its source
 * `{ testDataSetId, mappingId, mappingVersion }` so a generated case can be PINNED
 * to the exact approved version it was authored against (audit; an old case never
 * silently upgrades). Default `approvedOnly:false` = the legacy draft path,
 * byte-identical return. Wired to true under Enterprise Mode at P9.
 */

const prisma = require('../prisma');
const { normalizeModuleKey, tokenize } = require('./moduleIntelligence');
const { isNonExecutableSheet } = require('./testDataSheetPolicy');
const {
  buildDatasetContractV1,
  buildProjectDatasetCatalogV1,
  validateDatasetContractV1,
  withMappingSnapshot,
} = require('./datasetContractV1');

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizedName(value) {
  return cleanText(value).toLowerCase();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function resolveContractSheetReference(contractSheets, binding) {
  const sheets = Array.isArray(contractSheets) ? contractSheets.filter(Boolean) : [];
  const explicitSheetId = cleanText(binding && binding.sheetId);
  if (explicitSheetId) {
    // An immutable sheet pin is authoritative. A stale/missing ID must never be
    // substituted with a same-name sheet from another dataset revision.
    return sheets.filter((sheet) => cleanText(sheet && sheet.sheetId) === explicitSheetId);
  }
  const sheetName = normalizedName(binding && binding.sheet);
  if (!sheetName) return [];
  return sheets.filter((sheet) => normalizedName(sheet && sheet.name) === sheetName);
}

function parserManifestForVerification(contract) {
  const source = contract && contract.source && typeof contract.source === 'object' ? contract.source : {};
  return {
    parserVersion: source.parserVersion || undefined,
    sourceSheetCount: source.sourceSheetCount,
    sourceRowCount: source.sourceRowCount,
    truncations: Array.isArray(source.truncations) ? source.truncations : [],
    complete: source.complete !== false,
  };
}

function verifyDatasetContractAgainstRaw({
  persistedContract,
  testDataSetId,
  projectId = null,
  sprintId = null,
  sourceName = null,
  rawSheets = [],
  workbookContract = null,
} = {}) {
  const issues = [];
  let rebuiltContract = null;
  try {
    rebuiltContract = buildDatasetContractV1({
      testDataSetId,
      projectId,
      sprintId,
      sourceName,
      sourceHash: persistedContract && persistedContract.source && persistedContract.source.sourceHash || null,
      parsedSheets: rawSheets,
      parserManifest: parserManifestForVerification(persistedContract),
      workbookContract: workbookContract && workbookContract.schemaVersion ? workbookContract : null,
    });
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: 'dataset_contract_rebuild_failed', reason: error.message }],
      rebuiltContract: null,
      rawSheetIds: [],
    };
  }

  if (!persistedContract || typeof persistedContract !== 'object') {
    return {
      ok: false,
      issues: [{ code: 'dataset_contract_missing' }],
      rebuiltContract,
      rawSheetIds: rebuiltContract.sheets.map((sheet) => sheet.sheetId),
    };
  }

  const validation = validateDatasetContractV1(persistedContract);
  if (!validation.ok) {
    issues.push({
      code: 'dataset_contract_invalid',
      findings: validation.errors.map((finding) => finding.code),
    });
  }
  if (!persistedContract.contractId || !/^dataset-contract:[a-f0-9]{32}$/.test(String(persistedContract.contractId))) {
    issues.push({ code: 'dataset_contract_id_invalid' });
  }
  if (persistedContract.datasetId !== testDataSetId) {
    issues.push({ code: 'dataset_contract_dataset_id_mismatch', expected: testDataSetId, actual: persistedContract.datasetId || null });
  }
  if (persistedContract.datasetRevisionId !== rebuiltContract.datasetRevisionId) {
    issues.push({
      code: 'dataset_contract_revision_mismatch',
      expected: rebuiltContract.datasetRevisionId,
      actual: persistedContract.datasetRevisionId || null,
    });
  }
  if (!persistedContract.source || persistedContract.source.parsedHash !== rebuiltContract.source.parsedHash) {
    issues.push({ code: 'dataset_contract_parsed_hash_mismatch' });
  }

  const actualSheets = Array.isArray(persistedContract.sheets) ? persistedContract.sheets : [];
  const expectedSheets = rebuiltContract.sheets;
  const expectedSheetIds = new Set(expectedSheets.map((sheet) => sheet.sheetId));
  if (actualSheets.length !== expectedSheets.length) {
    issues.push({ code: 'dataset_contract_sheet_count_mismatch', expected: expectedSheets.length, actual: actualSheets.length });
  }

  const verifyMembers = ({ actual, expected, idKey, kind, identityMatches, sheetId }) => {
    const expectedIds = new Set(expected.map((item) => item && item[idKey]));
    if (actual.length !== expected.length) {
      issues.push({ code: `dataset_contract_${kind}_count_mismatch`, sheetId, expected: expected.length, actual: actual.length });
    }
    for (const expectedItem of expected) {
      const matches = actual.filter((item) => item && item[idKey] === expectedItem[idKey]);
      if (matches.length !== 1) {
        issues.push({
          code: matches.length ? `dataset_contract_${kind}_id_ambiguous` : `dataset_contract_${kind}_id_missing`,
          sheetId,
          id: expectedItem[idKey],
        });
      } else if (!identityMatches(matches[0], expectedItem)) {
        issues.push({ code: `dataset_contract_${kind}_identity_mismatch`, sheetId, id: expectedItem[idKey] });
      }
    }
    for (const actualItem of actual) {
      if (actualItem && !expectedIds.has(actualItem[idKey])) {
        issues.push({ code: `dataset_contract_${kind}_id_unexpected`, sheetId, id: actualItem[idKey] || null });
      }
    }
  };

  for (const expectedSheet of expectedSheets) {
    const matches = actualSheets.filter((sheet) => sheet && sheet.sheetId === expectedSheet.sheetId);
    if (matches.length !== 1) {
      issues.push({
        code: matches.length ? 'dataset_contract_sheet_id_ambiguous' : 'dataset_contract_sheet_id_missing',
        sheetId: expectedSheet.sheetId,
        ordinal: expectedSheet.ordinal,
      });
      continue;
    }
    const actualSheet = matches[0];
    if (Number(actualSheet.ordinal) !== Number(expectedSheet.ordinal)
      || normalizedName(actualSheet.name) !== normalizedName(expectedSheet.name)) {
      issues.push({ code: 'dataset_contract_sheet_identity_mismatch', sheetId: expectedSheet.sheetId });
    }
    verifyMembers({
      actual: Array.isArray(actualSheet.columns) ? actualSheet.columns : [],
      expected: expectedSheet.columns,
      idKey: 'columnId',
      kind: 'column',
      sheetId: expectedSheet.sheetId,
      identityMatches: (actual, expected) => Number(actual.ordinal) === Number(expected.ordinal)
        && normalizedName(actual.header) === normalizedName(expected.header),
    });
    verifyMembers({
      actual: Array.isArray(actualSheet.rows) ? actualSheet.rows : [],
      expected: expectedSheet.rows,
      idKey: 'rowId',
      kind: 'row',
      sheetId: expectedSheet.sheetId,
      identityMatches: (actual, expected) => Number(actual.ordinal) === Number(expected.ordinal)
        && actual.rowHash === expected.rowHash,
    });
  }
  for (const actualSheet of actualSheets) {
    if (actualSheet && !expectedSheetIds.has(actualSheet.sheetId)) {
      issues.push({ code: 'dataset_contract_sheet_id_unexpected', sheetId: actualSheet.sheetId || null });
    }
  }

  const expectedStats = rebuiltContract.stats || {};
  const actualStats = persistedContract.stats || {};
  for (const key of ['sheetCount', 'columnCount', 'rowCount']) {
    if (Number(actualStats[key]) !== Number(expectedStats[key])) {
      issues.push({ code: 'dataset_contract_stats_mismatch', field: key, expected: expectedStats[key], actual: actualStats[key] });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    rebuiltContract,
    // Raw ordinal is used only to select the rebuilt immutable ID. The persisted
    // contract is subsequently resolved by that ID, never by array position.
    rawSheetIds: expectedSheets.map((sheet) => sheet.sheetId),
  };
}

function assertPinnedContextIntegrity(context) {
  const issues = context && Array.isArray(context.mappingIssues) ? context.mappingIssues : [];
  if (!issues.length) return;
  const error = new Error('Pinned test-data context contains unresolved mapping or dataset-contract integrity findings.');
  error.code = 'PINNED_TEST_DATA_UNAVAILABLE';
  error.status = 422;
  error.findings = issues;
  throw error;
}

function sheetTokenText(sheet) {
  return `${sheet?.name || ''} ${(sheet?.headers || []).join(' ')}`;
}

function bindingTokenText(binding) {
  const c2f = binding && binding.columnToField && typeof binding.columnToField === 'object'
    ? Object.keys(binding.columnToField).join(' ')
    : '';
  return `${binding?.sheet || ''} ${binding?.module || ''} ${binding?.scenarioName || ''} ${c2f} ${binding?.expectedColumn || ''} ${binding?.rowClassColumn || ''}`;
}

function isSharedAuthSheet(sheet, bindings = []) {
  if (isNonExecutableSheet(sheet)) return false;
  const text = `${sheetTokenText(sheet)} ${bindings.map(bindingTokenText).join(' ')}`.toLowerCase();
  const tokens = new Set(tokenize(text));
  if (/\b(auth|authentication|login|logout|sign in|signin|credential|credentials|session)\b/i.test(text)) return true;
  return (tokens.has('username') || tokens.has('email')) && (tokens.has('password') || tokens.has('otp') || tokens.has('token'));
}

function matchesModuleText(text, moduleScope) {
  const moduleKey = normalizeModuleKey(moduleScope);
  if (!moduleKey) return false;
  const hay = cleanText(text).toLowerCase();
  if (hay.includes(moduleKey.replace(/-/g, ' '))) return true;
  const moduleTokens = tokenize(moduleScope);
  const hayTokens = new Set(tokenize(text));
  return moduleTokens.some((t) => hayTokens.has(t));
}

function filterTestDataContextForModule(context, moduleScope) {
  if (!context || !moduleScope) return context;
  context = filterExecutableTestDataContext(context);
  const sheets = Array.isArray(context.sheets) ? context.sheets : [];
  const mapping = context.mapping || { bindings: [], unmapped: [] };
  const bindings = Array.isArray(mapping.bindings) ? mapping.bindings : [];
  const unmapped = Array.isArray(mapping.unmapped) ? mapping.unmapped : [];
  const includedSheetNames = new Set();

  for (const sheet of sheets) {
    const sheetBindings = bindings.filter((b) => b && b.sheet === sheet.name);
    const text = `${sheetTokenText(sheet)} ${sheetBindings.map(bindingTokenText).join(' ')}`;
    if (matchesModuleText(text, moduleScope) || isSharedAuthSheet(sheet, sheetBindings)) {
      includedSheetNames.add(sheet.name);
    }
  }

  const sheetByName = new Map(sheets.map((s) => [s.name, s]));
  const filteredSheets = sheets.filter((s) => includedSheetNames.has(s.name));
  const filteredBindings = bindings.filter((b) => {
    if (!b || !includedSheetNames.has(b.sheet)) return false;
    const sheet = sheetByName.get(b.sheet);
    return matchesModuleText(bindingTokenText(b), moduleScope)
      || matchesModuleText(sheetTokenText(sheet), moduleScope)
      || isSharedAuthSheet(sheet, [b]);
  });
  const filteredUnmapped = unmapped.filter((u) => !u?.sheet || includedSheetNames.has(u.sheet));

  return {
    ...context,
    sheets: filteredSheets,
    mapping: {
      ...mapping,
      bindings: filteredBindings,
      unmapped: filteredUnmapped,
      moduleScope,
      filteredFrom: {
        sheetCount: sheets.length,
        bindingCount: bindings.length,
        keptSheetCount: filteredSheets.length,
        keptBindingCount: filteredBindings.length,
        reason: filteredSheets.length ? null : 'no_module_test_data_match',
      },
    },
  };
}

function filterExecutableTestDataContext(context) {
  if (!context) return context;
  const sheets = Array.isArray(context.sheets) ? context.sheets : [];
  const mapping = context.mapping || { bindings: [], unmapped: [] };
  const bindings = Array.isArray(mapping.bindings) ? mapping.bindings : [];
  const unmapped = Array.isArray(mapping.unmapped) ? mapping.unmapped : [];
  const sheetByName = new Map(sheets.map((s) => [s.name, s]));
  const ignoredSheetNames = new Set();

  for (const sheet of sheets) {
    if (isNonExecutableSheet(sheet)) ignoredSheetNames.add(sheet.name);
  }

  const filteredSheets = sheets.filter((s) => !ignoredSheetNames.has(s.name));
  const filteredBindings = bindings.filter((b) => {
    if (!b || !b.sheet || ignoredSheetNames.has(b.sheet)) return false;
    if (b.purpose === 'non_executable_metadata') return false;
    const sheet = sheetByName.get(b.sheet);
    return !isNonExecutableSheet(sheet || { name: b.sheet, headers: [] });
  });
  const filteredUnmapped = unmapped.filter((u) => !u?.sheet || !ignoredSheetNames.has(u.sheet));
  const existingIgnored = Array.isArray(mapping.ignoredSheets) ? mapping.ignoredSheets : [];

  return {
    ...context,
    sheets: filteredSheets,
    mapping: {
      ...mapping,
      bindings: filteredBindings,
      unmapped: filteredUnmapped,
      ignoredSheets: [
        ...existingIgnored,
        ...Array.from(ignoredSheetNames).map((sheet) => ({ sheet, reason: 'non_executable_workbook_metadata' })),
      ],
    },
  };
}

async function loadTestDataContext(projectId, sprintId = null, {
  approvedOnly = false,
  moduleScope = null,
  testDataSetIds = null,
  mappingPins = null,
  _ignoreExecutionDataPinScope = false,
} = {}) {
  if (!projectId) return null;
  if (!_ignoreExecutionDataPinScope && !testDataSetIds && !mappingPins) {
    const executionPins = require('./executionDataPinScope').currentExecutionDataPins();
    if (executionPins.length) {
      try {
        return await loadPinnedTestDataContext(projectId, sprintId, executionPins);
      } catch (error) {
        return {
          sheets: [],
          datasetContracts: [],
          datasetCatalog: null,
          mapping: { version: 0, status: 'pin_validation_failed', bindings: [], unmapped: [], sources: [] },
          pinValidationError: {
            code: error.code || 'PINNED_TEST_DATA_UNAVAILABLE',
            message: error.message,
            findings: error.findings || [],
          },
        };
      }
    }
  }
  const selectedIds = Array.isArray(testDataSetIds)
    ? Array.from(new Set(testDataSetIds.map((id) => cleanText(id)).filter(Boolean))).sort()
    : null;
  const pinnedMappingBySet = mappingPins && typeof mappingPins === 'object'
    ? new Map(Object.entries(mappingPins).map(([testDataSetId, mappingId]) => [cleanText(testDataSetId), cleanText(mappingId)]))
    : new Map();
  let rows;
  try {
    rows = await prisma.testDataSet.findMany({
      where: {
        projectId,
        ...(sprintId ? { sprintId } : {}),
        ...(selectedIds ? { id: { in: selectedIds } } : {}),
      },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        name: true,
        rowCount: true,
        uploadedAt: true,
        sheetsJson: true,
        mappingJson: true,
        workbookContractJson: true,
      },
    });
  } catch (_) {
    // testDataSet table/client not present (older client) → degrade to no data.
    return null;
  }
  if (!rows || !rows.length) return null;

  const sheets = [];
  const bindings = [];
  const unmapped = [];
  const sources = [];
  const understandings = [];
  const datasetContracts = [];
  const mappingIssues = [];
  const loadedIds = new Set(rows.map((row) => row.id));
  const missingTestDataSetIds = selectedIds ? selectedIds.filter((id) => !loadedIds.has(id)) : [];
  const unapprovedTestDataSetIds = [];
  let maxVersion = 0;

  for (const r of rows) {
    let parsed = null;
    try { parsed = JSON.parse(r.sheetsJson); } catch (_) { parsed = null; }
    const rawSheets = parsed && Array.isArray(parsed.sheets) ? parsed.sheets : [];
    const persistedWorkbook = parseJson(r.workbookContractJson, null);

    // Choose the mapping source. approvedOnly → the latest approved (immutable)
    // TestDataMapping; default → the editable TestDataSet.mappingJson draft.
    let mappingStr = null;
    let provenance = null;
    if (approvedOnly) {
      let approved = null;
      try {
        const pinnedMappingId = pinnedMappingBySet.get(r.id);
        approved = await prisma.testDataMapping.findFirst({
          where: pinnedMappingId
            ? { id: pinnedMappingId, testDataSetId: r.id, projectId }
            : { testDataSetId: r.id, status: 'approved' },
          orderBy: { version: 'desc' },
          select: { id: true, version: true, status: true, mappingJson: true },
        });
      } catch (_) { approved = null; }
      if (approved) {
        mappingStr = approved.mappingJson;
        provenance = { testDataSetId: r.id, mappingId: approved.id, mappingVersion: approved.version, status: approved.status };
        if (approved.version > maxVersion) maxVersion = approved.version;
        sources.push({ testDataSetId: r.id, mappingId: approved.id, version: approved.version, status: approved.status });
      } else {
        unapprovedTestDataSetIds.push(r.id);
      }
      // No approved mapping for this set under approvedOnly → contribute no bindings
      // (an unapproved draft is never silently consumed once P4 is active).
    } else {
      mappingStr = r.mappingJson;
    }

    const selectedMapping = parseJson(mappingStr, null);
    const persistedDatasetContract = persistedWorkbook && persistedWorkbook.datasetContractV1;
    let datasetContract = null;
    let datasetVerification = null;
    try {
      datasetVerification = verifyDatasetContractAgainstRaw({
        persistedContract: persistedDatasetContract,
        testDataSetId: r.id,
        projectId,
        sprintId,
        sourceName: r.name,
        rawSheets,
        workbookContract: persistedWorkbook,
      });
      if (!datasetVerification.ok) {
        mappingIssues.push(...datasetVerification.issues.map((issue) => ({ ...issue, testDataSetId: r.id })));
      } else {
        datasetContract = persistedDatasetContract;
      }
      if (datasetContract && selectedMapping) {
        datasetContract = withMappingSnapshot(datasetContract, {
          mapping: selectedMapping,
          ...(provenance || { status: 'draft' }),
        });
      }
      if (datasetContract) datasetContracts.push(datasetContract);
    } catch (error) {
      mappingIssues.push({ code: 'dataset_contract_unavailable', testDataSetId: r.id, reason: error.message });
      datasetContract = null;
    }

    const contractSheets = datasetContract && Array.isArray(datasetContract.sheets)
      ? datasetContract.sheets
      : [];
    for (let ordinal = 0; ordinal < rawSheets.length; ordinal += 1) {
      const rawSheet = rawSheets[ordinal];
      const expectedSheet = datasetVerification && datasetVerification.ok
        && datasetVerification.rebuiltContract && datasetVerification.rebuiltContract.sheets[ordinal]
        || null;
      const sheetMatches = expectedSheet
        ? contractSheets.filter((sheet) => sheet && sheet.sheetId === expectedSheet.sheetId)
        : [];
      const contractSheet = sheetMatches.length === 1 ? sheetMatches[0] : null;
      const contractRowsById = new Map((contractSheet && Array.isArray(contractSheet.rows) ? contractSheet.rows : [])
        .map((row) => [row && row.rowId, row]));
      sheets.push({
        ...rawSheet,
        rows: (Array.isArray(rawSheet && rawSheet.rows) ? rawSheet.rows : []).map((row, rowOrdinal) => ({
          ...row,
          __datasetRowId: expectedSheet && expectedSheet.rows && expectedSheet.rows[rowOrdinal]
            && contractRowsById.has(expectedSheet.rows[rowOrdinal].rowId)
            ? expectedSheet.rows[rowOrdinal].rowId : null,
        })),
        testDataSetId: r.id,
        datasetId: r.id,
        datasetRevisionId: datasetContract && datasetContract.datasetRevisionId || null,
        sheetId: contractSheet && contractSheet.sheetId || null,
      });
    }

    if (mappingStr && datasetContract) {
      const m = selectedMapping;
      if (m && Array.isArray(m.bindings)) {
        for (const b of m.bindings) {
          const matchingSheets = resolveContractSheetReference(contractSheets, b);
          if (matchingSheets.length !== 1) {
            const explicitSheetId = cleanText(b && b.sheetId);
            mappingIssues.push({
              code: matchingSheets.length
                ? 'ambiguous_sheet_reference'
                : (explicitSheetId ? 'missing_sheet_id_reference' : 'missing_sheet_reference'),
              testDataSetId: r.id,
              sheet: b && b.sheet || null,
              sheetId: explicitSheetId || null,
              candidates: matchingSheets.map((sheet) => sheet.sheetId),
            });
            continue;
          }
          bindings.push({
            ...b,
            ...(provenance || { testDataSetId: r.id }),
            datasetId: r.id,
            datasetRevisionId: datasetContract && datasetContract.datasetRevisionId || null,
            sheetId: matchingSheets[0].sheetId,
          });
        }
      }
      if (m && Array.isArray(m.unmapped)) {
        unmapped.push(...m.unmapped.map((item) => ({ ...item, testDataSetId: r.id })));
      }
      if (m && m.understanding && typeof m.understanding === 'object') {
        understandings.push({ testDataSetId: r.id, ...m.understanding });
      }
    }
  }
  if (!sheets.length) return null;

  const shared = {
    datasetContracts,
    datasetCatalog: buildProjectDatasetCatalogV1(datasetContracts),
    selectedTestDataSetIds: selectedIds || rows.map((row) => row.id).sort(),
    missingTestDataSetIds,
    unapprovedTestDataSetIds: Array.from(new Set(unapprovedTestDataSetIds)).sort(),
    mappingIssues,
  };

  if (approvedOnly) {
    return filterTestDataContextForModule(
      filterExecutableTestDataContext({ ...shared, sheets, mapping: { version: maxVersion || 1, status: sources.length ? 'approved' : 'none', bindings, unmapped, sources, understandings } }),
      moduleScope
    );
  }
  // Default/draft path — unchanged shape (version:1, no provenance).
  return filterTestDataContextForModule(filterExecutableTestDataContext({ ...shared, sheets, mapping: { version: 1, bindings, unmapped, understandings } }), moduleScope);
}

function pinnedDataUnavailable(message, findings) {
  const error = new Error(message);
  error.code = 'PINNED_TEST_DATA_UNAVAILABLE';
  error.status = 422;
  error.findings = findings;
  return error;
}

async function loadVerifiedGenerationDatasetCatalog({
  projectId,
  generationId,
  expectedCatalogId,
  pins,
  selectedContext,
}) {
  let generation = null;
  try {
    generation = await prisma.scenarioGeneration.findFirst({
      where: { id: generationId, projectId },
      select: { id: true, coveragePlanJson: true },
    });
  } catch (error) {
    return {
      catalog: null,
      findings: [{
        code: 'pinned_generation_catalog_lookup_failed',
        generationId,
        reason: error && error.message || 'generation_catalog_lookup_failed',
      }],
    };
  }
  if (!generation) {
    return {
      catalog: null,
      findings: [{ code: 'pinned_generation_missing', generationId }],
    };
  }

  const coveragePlan = parseJson(generation.coveragePlanJson, null);
  const catalogHistory = coveragePlan && coveragePlan.contractHistory
    && Array.isArray(coveragePlan.contractHistory.datasetCatalogV1)
    ? coveragePlan.contractHistory.datasetCatalogV1
    : [];
  const catalogCandidates = [
    coveragePlan && coveragePlan.datasetCatalogV1,
    ...catalogHistory,
  ].filter((candidate) => candidate && typeof candidate === 'object');
  // Append keeps one ScenarioGeneration row. Old and newly appended cases may
  // therefore carry different generation-wide catalog hashes; select only the
  // immutable catalog whose ID the case actually pins.
  const catalog = catalogCandidates.find((candidate) => candidate.catalogId === expectedCatalogId)
    || catalogCandidates[0]
    || null;
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.datasets)) {
    return {
      catalog: null,
      findings: [{ code: 'pinned_generation_catalog_missing', generationId }],
    };
  }

  let rebuiltCatalog = null;
  try {
    rebuiltCatalog = buildProjectDatasetCatalogV1(catalog.datasets);
  } catch (error) {
    return {
      catalog: null,
      findings: [{
        code: 'pinned_generation_catalog_invalid',
        generationId,
        reason: error && error.message || 'generation_catalog_rebuild_failed',
      }],
    };
  }

  const findings = [];
  if (catalog.schemaVersion !== rebuiltCatalog.schemaVersion
    || !cleanText(catalog.catalogId)
    || catalog.catalogId !== rebuiltCatalog.catalogId) {
    findings.push({
      code: 'pinned_generation_catalog_integrity_mismatch',
      generationId,
      expected: rebuiltCatalog.catalogId,
      actual: catalog.catalogId || null,
    });
  }
  if (catalog.catalogId !== expectedCatalogId) {
    findings.push({
      code: 'pinned_generation_catalog_revision_mismatch',
      generationId,
      expected: expectedCatalogId,
      actual: catalog.catalogId || null,
    });
  }

  // The persisted generation catalog is the authority for the generation-wide
  // workbookHash. It is safe to use for a subset run only after the selected
  // live contracts and exact mapping revisions are proven to be members of it.
  const catalogDatasets = Array.isArray(catalog.datasets) ? catalog.datasets : [];
  const liveDatasets = selectedContext && Array.isArray(selectedContext.datasetContracts)
    ? selectedContext.datasetContracts
    : [];
  for (const pin of pins) {
    const catalogMatches = catalogDatasets.filter((dataset) => dataset && dataset.datasetId === pin.testDataSetId);
    if (catalogMatches.length !== 1) {
      findings.push({
        code: catalogMatches.length ? 'pinned_generation_catalog_dataset_ambiguous' : 'pinned_generation_catalog_dataset_missing',
        caseId: pin.caseId,
        generationId,
        testDataSetId: pin.testDataSetId,
      });
      continue;
    }
    const catalogDataset = catalogMatches[0];
    const liveDataset = liveDatasets.find((dataset) => dataset && dataset.datasetId === pin.testDataSetId);
    if (!liveDataset
      || liveDataset.contractId !== catalogDataset.contractId
      || liveDataset.datasetRevisionId !== catalogDataset.datasetRevisionId) {
      findings.push({
        code: 'pinned_generation_catalog_dataset_revision_mismatch',
        caseId: pin.caseId,
        generationId,
        testDataSetId: pin.testDataSetId,
        expected: catalogDataset.datasetRevisionId || null,
        actual: liveDataset && liveDataset.datasetRevisionId || null,
      });
    }
    const catalogMapping = catalogDataset.mappingRef && typeof catalogDataset.mappingRef === 'object'
      ? catalogDataset.mappingRef
      : null;
    const liveMapping = liveDataset && liveDataset.mappingRef && typeof liveDataset.mappingRef === 'object'
      ? liveDataset.mappingRef
      : null;
    if (!catalogMapping
      || cleanText(catalogMapping.mappingId) !== pin.mappingId
      || (pin.mappingVersion != null && Number(catalogMapping.version) !== pin.mappingVersion)
      || !liveMapping
      || cleanText(liveMapping.mappingId) !== cleanText(catalogMapping.mappingId)
      || Number(liveMapping.version) !== Number(catalogMapping.version)
      || cleanText(liveMapping.hash) !== cleanText(catalogMapping.hash)) {
      findings.push({
        code: 'pinned_generation_catalog_mapping_revision_mismatch',
        caseId: pin.caseId,
        generationId,
        testDataSetId: pin.testDataSetId,
        expected: { mappingId: pin.mappingId, mappingVersion: pin.mappingVersion },
        actual: catalogMapping && {
          mappingId: liveMapping && liveMapping.mappingId || null,
          mappingVersion: liveMapping && liveMapping.version != null ? Number(liveMapping.version) : null,
          mappingHash: liveMapping && liveMapping.hash || null,
        } || null,
      });
    }
  }

  return { catalog: findings.length ? null : catalog, findings };
}

async function loadPinnedTestDataContext(projectId, sprintId = null, pins = []) {
  const normalizedPins = (Array.isArray(pins) ? pins : [])
    .filter((pin) => pin && typeof pin === 'object')
    .map((pin) => ({
      caseId: cleanText(pin.caseId) || null,
      generationId: cleanText(pin.generationId) || null,
      testDataSetId: cleanText(pin.testDataSetId),
      mappingId: cleanText(pin.mappingId),
      mappingVersion: pin.mappingVersion == null ? null : Number(pin.mappingVersion),
      workbookHash: cleanText(pin.workbookHash) || null,
      datasetRevisionId: cleanText(pin.datasetRevisionId) || null,
      sheetId: cleanText(pin.sheetId) || null,
      rowGroupId: cleanText(pin.rowGroupId) || null,
      pinParseError: cleanText(pin.pinParseError) || null,
    }));
  if (!normalizedPins.length) return null;

  const findings = [];
  const mappingPins = {};
  for (const pin of normalizedPins) {
    if (pin.pinParseError) {
      findings.push({ code: pin.pinParseError, caseId: pin.caseId });
      continue;
    }
    if (!pin.mappingId) {
      findings.push({ code: 'pinned_mapping_id_missing', caseId: pin.caseId, testDataSetId: pin.testDataSetId || null });
      continue;
    }
    if (!pin.testDataSetId) {
      findings.push({ code: 'pinned_dataset_id_missing', caseId: pin.caseId, mappingId: pin.mappingId });
      continue;
    }
    if (mappingPins[pin.testDataSetId] && mappingPins[pin.testDataSetId] !== pin.mappingId) {
      findings.push({ code: 'multiple_mapping_revisions_for_dataset', testDataSetId: pin.testDataSetId });
      continue;
    }
    mappingPins[pin.testDataSetId] = pin.mappingId;
  }
  if (findings.length) {
    const error = new Error('Pinned test-data references are incomplete or conflicting.');
    error.code = 'PINNED_TEST_DATA_UNAVAILABLE';
    error.status = 422;
    error.findings = findings;
    throw error;
  }

  const context = await loadTestDataContext(projectId, sprintId, {
    approvedOnly: true,
    testDataSetIds: Object.keys(mappingPins),
    mappingPins,
    _ignoreExecutionDataPinScope: true,
  });
  if (!context) {
    const error = new Error('Pinned test data no longer exists for this generation.');
    error.code = 'PINNED_TEST_DATA_UNAVAILABLE';
    error.status = 422;
    error.findings = normalizedPins.map((pin) => ({ code: 'pinned_dataset_missing', caseId: pin.caseId, testDataSetId: pin.testDataSetId }));
    throw error;
  }
  assertPinnedContextIntegrity(context);

  const workbookPins = normalizedPins.filter((pin) => pin.workbookHash);
  const requestedWorkbookHashes = Array.from(new Set(workbookPins.map((pin) => pin.workbookHash)));
  let verifiedWorkbookCatalog = context.datasetCatalog;
  const subsetCatalogSatisfiesPins = requestedWorkbookHashes.every((catalogId) => (
    verifiedWorkbookCatalog && verifiedWorkbookCatalog.catalogId === catalogId
  ));
  if (requestedWorkbookHashes.length > 1) {
    findings.push({
      code: 'multiple_workbook_revisions_for_execution',
      workbookHashes: requestedWorkbookHashes,
    });
  } else if (!subsetCatalogSatisfiesPins && requestedWorkbookHashes.length === 1) {
    const generationIds = Array.from(new Set(workbookPins.map((pin) => pin.generationId).filter(Boolean)));
    const missingGenerationPins = workbookPins.filter((pin) => !pin.generationId);
    if (missingGenerationPins.length) {
      findings.push(...missingGenerationPins.map((pin) => ({
        code: 'pinned_generation_id_missing_for_workbook_catalog',
        caseId: pin.caseId,
        expected: pin.workbookHash,
      })));
    } else if (generationIds.length !== 1) {
      findings.push({
        code: 'multiple_generation_catalogs_for_execution',
        generationIds,
      });
    } else {
      const generationCatalog = await loadVerifiedGenerationDatasetCatalog({
        projectId,
        generationId: generationIds[0],
        expectedCatalogId: requestedWorkbookHashes[0],
        pins: workbookPins,
        selectedContext: context,
      });
      findings.push(...generationCatalog.findings);
      if (generationCatalog.catalog) verifiedWorkbookCatalog = generationCatalog.catalog;
    }
  }

  for (const pin of normalizedPins) {
    const source = (context.mapping && context.mapping.sources || []).find((item) => (
      item.testDataSetId === pin.testDataSetId && item.mappingId === pin.mappingId
    ));
    if (!source || (pin.mappingVersion != null && Number(source.version) !== pin.mappingVersion)) {
      findings.push({ code: 'pinned_mapping_revision_mismatch', caseId: pin.caseId, mappingId: pin.mappingId, mappingVersion: pin.mappingVersion });
    }
    const dataset = (context.datasetContracts || []).find((item) => item.datasetId === pin.testDataSetId);
    if (!dataset || (pin.datasetRevisionId && dataset.datasetRevisionId !== pin.datasetRevisionId)) {
      findings.push({ code: 'pinned_dataset_revision_mismatch', caseId: pin.caseId, expected: pin.datasetRevisionId, actual: dataset && dataset.datasetRevisionId });
      continue;
    }
    const sheet = pin.sheetId ? (dataset.sheets || []).find((item) => item.sheetId === pin.sheetId) : null;
    if (pin.sheetId && !sheet) findings.push({ code: 'pinned_sheet_missing', caseId: pin.caseId, sheetId: pin.sheetId });
    if (pin.rowGroupId && (!sheet || !(sheet.rowGroups || []).some((item) => item.rowGroupId === pin.rowGroupId))) {
      findings.push({ code: 'pinned_row_group_missing', caseId: pin.caseId, rowGroupId: pin.rowGroupId });
    }
    if (pin.workbookHash && (!verifiedWorkbookCatalog || verifiedWorkbookCatalog.catalogId !== pin.workbookHash)) {
      findings.push({ code: 'pinned_workbook_revision_mismatch', caseId: pin.caseId, expected: pin.workbookHash, actual: verifiedWorkbookCatalog && verifiedWorkbookCatalog.catalogId || null });
    }
  }
  if (findings.length) {
    throw pinnedDataUnavailable(
      'Pinned test-data revision validation failed; execution will not substitute a newer mapping or workbook.',
      findings,
    );
  }
  return context;
}

/**
 * Resolve one specific approved mapping by id — used by run/export to honour a
 * case's PINNED dataBindingJson.mappingId (never "latest approved"), so an old
 * case keeps its authored version. Inert until P9 wires it into the conductor/
 * export; degrades to null pre-migration (client lacks the model).
 */
async function loadApprovedMappingById(mappingId) {
  if (!mappingId) return null;
  try {
    const row = await prisma.testDataMapping.findUnique({
      where: { id: mappingId },
      select: { id: true, testDataSetId: true, version: true, status: true, mappingJson: true },
    });
    if (!row) return null;
    let mapping = null;
    try { mapping = JSON.parse(row.mappingJson); } catch (_) { mapping = null; }
    return { id: row.id, testDataSetId: row.testDataSetId, version: row.version, status: row.status, mapping };
  } catch (_) {
    return null;
  }
}

module.exports = {
  loadTestDataContext,
  loadPinnedTestDataContext,
  loadApprovedMappingById,
  filterTestDataContextForModule,
  filterExecutableTestDataContext,
  isSharedAuthSheet,
  matchesModuleText,
  resolveContractSheetReference,
  verifyDatasetContractAgainstRaw,
  assertPinnedContextIntegrity,
};
