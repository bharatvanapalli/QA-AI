'use strict';

const testDataContext = require('./testDataContext');

const VERSION = 1;
const LITERAL_STOP = new Set([
  'pass', 'fail', 'true', 'false', 'yes', 'no', 'ok', 'n/a', 'na',
  'positive', 'negative', 'valid', 'invalid',
]);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function parseMaybe(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function mappingOf(testData) {
  return parseMaybe(testData && testData.mapping, null) || { bindings: [], unmapped: [] };
}

function sheetsOf(testData) {
  return Array.isArray(testData && testData.sheets) ? testData.sheets : [];
}

function normalizeMappingPins(mappingPins) {
  if (!mappingPins || typeof mappingPins !== 'object' || Array.isArray(mappingPins)) return {};
  return Object.fromEntries(Object.entries(mappingPins)
    .map(([testDataSetId, mappingId]) => [clean(testDataSetId), clean(mappingId)])
    .filter(([testDataSetId, mappingId]) => testDataSetId && mappingId));
}

function sameDataset(left, right) {
  const a = clean(left && (left.testDataSetId || left.datasetId));
  const b = clean(right && (right.testDataSetId || right.datasetId));
  return !a || !b || a === b;
}

function resolveSheetForBinding(sheets, binding) {
  const scoped = sheets.filter((sheet) => sameDataset(sheet, binding));
  const sheetId = clean(binding && binding.sheetId);
  if (sheetId) {
    const exact = scoped.filter((sheet) => clean(sheet && sheet.sheetId) === sheetId);
    return exact.length === 1 ? { sheet: exact[0], issue: null } : {
      sheet: null,
      issue: { code: exact.length ? 'ambiguous_sheet_id' : 'missing_sheet_id', sheetId },
    };
  }
  const sheetName = clean(binding && binding.sheet).toLowerCase();
  const byName = scoped.filter((sheet) => clean(sheet && sheet.name).toLowerCase() === sheetName);
  return byName.length === 1 ? { sheet: byName[0], issue: null } : {
    sheet: null,
    issue: {
      code: byName.length ? 'ambiguous_sheet_name' : 'missing_sheet_name',
      sheet: binding && binding.sheet || null,
      candidates: byName.map((sheet) => sheet.sheetId || null),
    },
  };
}

function mappedHeadersForBinding(binding) {
  const c2f = binding && binding.columnToField && typeof binding.columnToField === 'object'
    ? binding.columnToField
    : {};
  return Array.from(new Set([
    ...Object.values(c2f),
    binding && binding.expectedColumn,
    binding && binding.rowClassColumn,
  ].map(clean).filter(Boolean)));
}

function usableRowsForBinding(sheet, binding) {
  const headers = mappedHeadersForBinding(binding);
  if (!headers.length) return [];
  return (Array.isArray(sheet && sheet.rows) ? sheet.rows : []).filter((row) => (
    row && typeof row === 'object' && !Array.isArray(row)
    && headers.some((header) => Object.prototype.hasOwnProperty.call(row, header)
      && row[header] != null
      && clean(row[header]).length > 0)
  ));
}

function rowValuesForBinding(sheet, binding) {
  const headers = mappedHeadersForBinding(binding);

  const values = [];
  for (const row of Array.isArray(sheet && sheet.rows) ? sheet.rows : []) {
    for (const header of headers) {
      const raw = row && row[header];
      const value = clean(raw);
      if (!value) continue;
      const low = value.toLowerCase();
      if (LITERAL_STOP.has(low)) continue;
      if (value.length < 3 && !/^\d+$/.test(value)) continue;
      values.push({ header, value });
    }
  }
  return values;
}

function rolesForBinding(binding) {
  const roles = new Set(Object.keys((binding && binding.columnToField) || {}));
  if (binding && binding.expectedColumn) roles.add('expected');
  if (binding && binding.rowClassColumn) roles.add('rowclass');
  return Array.from(roles);
}

function coverageKindsForBinding(sheet, binding, roles = []) {
  const kinds = new Set();
  const rows = Array.isArray(sheet && sheet.rows) ? sheet.rows : [];
  const textBits = [
    sheet && sheet.name,
    binding && binding.module,
    binding && binding.moduleKey,
    binding && binding.purpose,
    binding && binding.rowSelector,
    binding && binding.expectedColumn,
    binding && binding.rowClassColumn,
    ...roles,
  ];

  for (const row of rows) {
    if (row && typeof row === 'object') {
      textBits.push(...Object.values(row).map((v) => {
        if (v && typeof v === 'object') return Object.values(v).join(' ');
        return v;
      }));
    }
  }

  const hay = textBits.map(clean).filter(Boolean).join(' ').toLowerCase();
  if (rows.length > 1) kinds.add('multi_row');
  if (/\b(role|auth|profile|user(name)?|login|password|credential|admin|manager|employee|viewer)\b/i.test(hay)) {
    kinds.add('role_based');
  }
  if (/\b(negative|invalid|wrong|error|reject|denied|forbid|unauthorized|required|missing|not allowed|fail(?:ure)?)\b/i.test(hay)) {
    kinds.add('negative');
  }
  if (/\b(boundary|edge|limit|min(?:imum)?|max(?:imum)?|empty|blank|null|zero|overflow|underflow|length)\b/i.test(hay)) {
    kinds.add('boundary');
  }
  if (/\b(positive|valid|success|successful|happy path|created|saved|allowed|pass)\b/i.test(hay) || !kinds.has('negative')) {
    kinds.add('positive');
  }
  return Array.from(kinds).sort();
}

function buildGenerationDataContract(testData, { moduleScope = null, source = 'draft' } = {}) {
  const mapping = mappingOf(testData);
  const sheets = sheetsOf(testData);
  const resolutionIssues = [];
  const bindings = (Array.isArray(mapping.bindings) ? mapping.bindings : [])
    .filter((binding) => binding && (binding.sheet || binding.sheetId))
    .map((binding) => {
      const resolution = resolveSheetForBinding(sheets, binding);
      if (!resolution.sheet) {
        resolutionIssues.push({
          ...resolution.issue,
          testDataSetId: binding.testDataSetId || binding.datasetId || null,
          mappingId: binding.mappingId || null,
        });
        return null;
      }
      const sheet = resolution.sheet;
      const usableRows = usableRowsForBinding(sheet, binding);
      // A workbook existing in the project is not enough to make a binding
      // executable. At least one row must carry a concrete value in a mapped
      // input/oracle/classification column. Empty or unrelated rows therefore
      // remain ordinary inline authoring data instead of minting {{tokens}}.
      if (!usableRows.length) return null;
      const roles = rolesForBinding(binding);
      const values = rowValuesForBinding({ ...sheet, rows: usableRows }, binding);
      const coverageKinds = coverageKindsForBinding(sheet, binding, roles);
      return {
        sheet: binding.sheet,
        sheetId: binding.sheetId || sheet.sheetId || null,
        testDataSetId: binding.testDataSetId || binding.datasetId || sheet.testDataSetId || sheet.datasetId || null,
        datasetId: binding.datasetId || binding.testDataSetId || sheet.datasetId || sheet.testDataSetId || null,
        datasetRevisionId: binding.datasetRevisionId || sheet.datasetRevisionId || null,
        mappingId: binding.mappingId || null,
        mappingVersion: binding.mappingVersion || null,
        rowGroupId: binding.rowGroupId || null,
        module: binding.module || null,
        moduleKey: binding.moduleKey || null,
        purpose: binding.purpose || null,
        source,
        roles,
        inputRoles: Object.keys(binding.columnToField || {}),
        expected: binding.expectedColumn || null,
        rowClass: binding.rowClassColumn || null,
        rowCount: usableRows.length,
        sourceRowCount: Array.isArray(sheet && sheet.rows) ? sheet.rows.length : 0,
        usableRowCount: usableRows.length,
        valueCount: values.length,
        coverageKinds,
        values,
      };
    })
    .filter(Boolean);

  const allowedTokens = Array.from(new Set(bindings.flatMap((binding) => binding.roles))).sort();
  const forbiddenLiterals = Array.from(new Set(bindings.flatMap((binding) => binding.values.map((v) => v.value)))).sort();
  const executableSheetNames = bindings.map((binding) => binding.sheet);
  const coverageKinds = Array.from(new Set(bindings.flatMap((binding) => binding.coverageKinds || []))).sort();

  return {
    version: VERSION,
    source,
    status: resolutionIssues.length ? 'blocked' : (bindings.length ? 'ready' : 'empty'),
    strict: bindings.length > 0 && resolutionIssues.length === 0,
    moduleScope: moduleScope || null,
    sheetCount: executableSheetNames.length,
    bindingCount: bindings.length,
    executableSheetNames,
    allowedTokens,
    forbiddenLiterals,
    coverageKinds,
    bindings,
    resolutionIssues,
  };
}

async function loadGenerationTestDataContract({
  projectId,
  sprintId = null,
  moduleScope = null,
  preferApproved = true,
  requireApproved = true,
  testDataSetIds = null,
  mappingPins = null,
} = {}) {
  if (!projectId) return { testData: null, approvedTestData: null, contract: null, source: 'none', status: 'none', blockers: [] };

  const selectedIds = Array.isArray(testDataSetIds)
    ? Array.from(new Set(testDataSetIds.map((id) => clean(id)).filter(Boolean))).sort()
    : null;
  const exactMappingPins = normalizeMappingPins(mappingPins);
  const draftTestData = await testDataContext.loadTestDataContext(projectId, sprintId, {
    approvedOnly: false,
    moduleScope,
    testDataSetIds: selectedIds,
  });
  if (!draftTestData) {
    return {
      testData: null,
      approvedTestData: null,
      contract: null,
      source: 'none',
      status: selectedIds && selectedIds.length ? 'blocked' : 'none',
      blockers: selectedIds && selectedIds.length
        ? [{ code: 'selected_test_data_missing', testDataSetIds: selectedIds }]
        : [],
    };
  }

  let approvedTestData = null;
  if (preferApproved) {
    approvedTestData = await testDataContext.loadTestDataContext(projectId, sprintId, {
      approvedOnly: true,
      moduleScope,
      testDataSetIds: selectedIds,
      mappingPins: exactMappingPins,
    });
    const blockers = [];
    const missing = Array.isArray(approvedTestData && approvedTestData.missingTestDataSetIds)
      ? approvedTestData.missingTestDataSetIds
      : [];
    const unapproved = Array.isArray(approvedTestData && approvedTestData.unapprovedTestDataSetIds)
      ? approvedTestData.unapprovedTestDataSetIds
      : [];
    const mappingIssues = Array.isArray(approvedTestData && approvedTestData.mappingIssues)
      ? approvedTestData.mappingIssues
      : [];
    if (missing.length) blockers.push({ code: 'selected_test_data_missing', testDataSetIds: missing });
    if (unapproved.length) blockers.push({ code: 'test_data_mapping_not_approved', testDataSetIds: unapproved });
    if (mappingIssues.length) blockers.push({ code: 'test_data_mapping_unresolved', issues: mappingIssues });
    const missingPins = (selectedIds || []).filter((id) => !exactMappingPins[id]);
    if (requireApproved && missingPins.length) {
      blockers.push({ code: 'approved_mapping_pin_required', testDataSetIds: missingPins });
    }
    const datasetContracts = Array.isArray(approvedTestData && approvedTestData.datasetContracts)
      ? approvedTestData.datasetContracts
      : [];
    const completeDatasetIds = new Set(datasetContracts
      .filter((contract) => contract && contract.stats && contract.stats.complete === true)
      .map((contract) => clean(contract.datasetId))
      .filter(Boolean));
    const incompleteDatasetIds = (selectedIds || []).filter((id) => !completeDatasetIds.has(id));
    if (incompleteDatasetIds.length) {
      blockers.push({ code: 'dataset_contract_incomplete', testDataSetIds: incompleteDatasetIds });
    }
    const approvedContract = buildGenerationDataContract(approvedTestData, { moduleScope, source: 'approved' });
    if (approvedContract.resolutionIssues.length) {
      blockers.push({ code: 'generation_sheet_resolution_failed', issues: approvedContract.resolutionIssues });
    }
    if (!approvedContract.bindingCount && (selectedIds ? selectedIds.length : draftTestData.selectedTestDataSetIds?.length)) {
      blockers.push({ code: 'approved_test_data_has_no_executable_bindings' });
    }
    if (requireApproved && blockers.length) {
      return {
        testData: null,
        approvedTestData: null,
        draftTestData,
        contract: null,
        source: 'blocked',
        status: 'needs_approval',
        blockers,
      };
    }
    if (approvedContract.bindingCount > 0 && !blockers.length) {
      const testData = { ...approvedTestData, generationContract: approvedContract };
      return { testData, approvedTestData: testData, contract: approvedContract, source: 'approved', status: 'ready', blockers: [] };
    }
  }

  const draftContract = buildGenerationDataContract(draftTestData, { moduleScope, source: 'draft' });
  const testData = { ...draftTestData, generationContract: draftContract };
  return {
    testData,
    approvedTestData: null,
    contract: draftContract,
    source: 'draft',
    status: requireApproved ? 'needs_approval' : 'ready',
    blockers: requireApproved ? [{ code: 'test_data_mapping_not_approved' }] : [],
  };
}

module.exports = {
  VERSION,
  buildGenerationDataContract,
  loadGenerationTestDataContract,
  _private: {
    coverageKindsForBinding,
    mappedHeadersForBinding,
    normalizeMappingPins,
    resolveSheetForBinding,
    usableRowsForBinding,
  },
};
