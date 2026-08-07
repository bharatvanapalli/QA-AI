'use strict';

/**
 * DatasetContractV1
 *
 * A pure, deterministic identity layer over the existing WorkbookContract and
 * TestDataSet JSON blobs. The contract deliberately stores references and
 * hashes, never workbook cell values. Raw values remain in TestDataSet.sheetsJson
 * and are resolved only at an approved execution boundary.
 */

const crypto = require('crypto');
const { buildWorkbookContract } = require('./workbookContract');

const SCHEMA_VERSION = 'dataset-contract-v1';
const CATALOG_SCHEMA_VERSION = 'project-dataset-catalog-v1';
const PARSER_VERSION = 'test-data-parser-v1';

const SECRET_RE = /(pass(word)?|pwd|secret|token|otp|pin|api.?key|credential|cvv|ssn|auth)/i;
const RESTRICTED_RE = /(email|phone|mobile|passport|aadhaar|national.?id|tax.?id|credit|card|address|dob|birth)/i;
const RAW_VALUE_KEYS = new Set(['raw', 'value', 'values', 'inputs', 'cells', 'cellValues', 'expectedValue']);

function canonicalize(value) {
  if (value === null || value === undefined) return value === undefined ? null : value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => {
    if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    return out;
  }, {});
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function stableId(kind, parts) {
  const values = Array.isArray(parts) ? parts : [parts];
  return `${String(kind || 'id').toLowerCase()}:${canonicalHash(values).slice(0, 32)}`;
}

function clean(value, max = 260) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizedName(value) {
  return clean(value, 500).normalize('NFKC').toLocaleLowerCase('en-US');
}

function parseMaybe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function parsedSheetList(parsedSheets) {
  if (Array.isArray(parsedSheets)) return parsedSheets;
  if (parsedSheets && Array.isArray(parsedSheets.sheets)) return parsedSheets.sheets;
  return [];
}

function sensitivityFor(role, header, declared) {
  const explicit = clean(declared, 30).toLowerCase();
  if (explicit === 'masked' || explicit === 'restricted' || explicit === 'synthetic') return explicit;
  const text = `${role || ''} ${header || ''}`;
  if (SECRET_RE.test(text)) return 'masked';
  if (RESTRICTED_RE.test(text)) return 'restricted';
  return 'synthetic';
}

function safeFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  return {
    code: clean(finding.code || 'dataset_finding', 100),
    severity: clean(finding.severity || 'warning', 20),
    sheet: finding.sheet == null ? null : clean(finding.sheet, 180),
  };
}

function sanitizeParserManifest(manifest, sheets) {
  const src = manifest && typeof manifest === 'object' ? manifest : {};
  const truncations = (Array.isArray(src.truncations) ? src.truncations : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      return {
        code: clean(item.code || item.kind || 'parser_truncation', 100),
        sheet: item.sheet == null ? null : clean(item.sheet, 180),
        limit: Number.isFinite(Number(item.limit)) ? Number(item.limit) : null,
        actual: Number.isFinite(Number(item.actual)) ? Number(item.actual) : null,
        kept: Number.isFinite(Number(item.kept)) ? Number(item.kept) : null,
      };
    })
    .filter(Boolean);
  return {
    parserVersion: clean(src.parserVersion || PARSER_VERSION, 80),
    sourceSheetCount: Number.isFinite(Number(src.sourceSheetCount)) ? Number(src.sourceSheetCount) : sheets.length,
    parsedSheetCount: sheets.length,
    sourceRowCount: Number.isFinite(Number(src.sourceRowCount)) ? Number(src.sourceRowCount) : null,
    parsedRowCount: sheets.reduce((sum, sheet) => sum + (Array.isArray(sheet && sheet.rows) ? sheet.rows.length : 0), 0),
    truncations,
    complete: src.complete === false ? false : truncations.length === 0,
  };
}

function mappingPayload(snapshot) {
  if (!snapshot) return { ref: null, mapping: null };
  const mapping = parseMaybe(snapshot.mapping, null)
    || parseMaybe(snapshot.mappingJson, null)
    || (Array.isArray(snapshot.bindings) ? snapshot : null);
  if (!mapping) return { ref: null, mapping: null };
  const id = clean(snapshot.mappingId || snapshot.id || mapping.mappingId || '', 160) || null;
  const versionRaw = snapshot.mappingVersion || snapshot.version || mapping.mappingVersion || mapping.version;
  const version = Number.isFinite(Number(versionRaw)) ? Number(versionRaw) : null;
  const status = clean(snapshot.mappingStatus || snapshot.status || mapping.status || 'draft', 30) || 'draft';
  return {
    mapping,
    ref: {
      mappingId: id,
      version,
      status,
      hash: canonicalHash(mapping),
    },
  };
}

function bindingForSheet(mapping, sheetName, sheetId) {
  const bindings = mapping && Array.isArray(mapping.bindings) ? mapping.bindings : [];
  const byId = sheetId ? bindings.filter((binding) => binding && binding.sheetId === sheetId) : [];
  if (byId.length === 1) return byId[0];
  const key = normalizedName(sheetName);
  const byName = bindings.filter((binding) => binding && normalizedName(binding.sheet) === key);
  return byName.length === 1 ? byName[0] : null;
}

function mappedRolesForColumn(binding, header) {
  const out = [];
  const c2f = binding && binding.columnToField && typeof binding.columnToField === 'object'
    ? binding.columnToField
    : {};
  for (const [role, mappedHeader] of Object.entries(c2f)) {
    if (normalizedName(mappedHeader) === normalizedName(header)) out.push(role);
  }
  return Array.from(new Set(out)).sort();
}

function workbookSheetFor(workbookContract, sheet, ordinal) {
  const sheets = workbookContract && Array.isArray(workbookContract.sheets) ? workbookContract.sheets : [];
  const sameOrdinal = sheets[ordinal];
  if (sameOrdinal && normalizedName(sameOrdinal.name) === normalizedName(sheet && sheet.name)) return sameOrdinal;
  const matches = sheets.filter((candidate) => normalizedName(candidate && candidate.name) === normalizedName(sheet && sheet.name));
  return matches.length === 1 ? matches[0] : sameOrdinal || null;
}

function columnMetaFor(workbookSheet, header) {
  const columns = workbookSheet && Array.isArray(workbookSheet.columns) ? workbookSheet.columns : [];
  return columns.find((column) => normalizedName(column && column.name) === normalizedName(header)) || null;
}

function expectedMetaFor(workbookSheet, header) {
  const expected = workbookSheet && Array.isArray(workbookSheet.expectedColumns) ? workbookSheet.expectedColumns : [];
  return expected.find((column) => normalizedName(column && column.name) === normalizedName(header)) || null;
}

function buildSheetContract({ datasetRevisionId, sheet, ordinal, duplicateNameOccurrence, workbookSheet, binding, mappingRef }) {
  const name = clean(sheet && sheet.name || `Sheet ${ordinal + 1}`, 180);
  const sheetId = stableId('sheet', [datasetRevisionId, normalizedName(name), duplicateNameOccurrence]);
  const headers = Array.isArray(sheet && sheet.headers) ? sheet.headers.map((header) => clean(header, 240)) : [];
  const headerOccurrences = new Map();
  const columns = headers.map((header, columnOrdinal) => {
    const key = normalizedName(header);
    const occurrence = headerOccurrences.get(key) || 0;
    headerOccurrences.set(key, occurrence + 1);
    const wbColumn = columnMetaFor(workbookSheet, header);
    const wbExpected = expectedMetaFor(workbookSheet, header);
    const mappedRoles = mappedRolesForColumn(binding, header);
    const declaredSensitivity = mappedRoles
      .map((role) => binding && binding.sensitivity && binding.sensitivity[role])
      .find(Boolean);
    const columnId = stableId('column', [sheetId, key, occurrence]);
    return {
      columnId,
      ordinal: columnOrdinal,
      header,
      normalizedHeader: key,
      role: wbColumn && wbColumn.role ? wbColumn.role : 'input',
      oracleType: wbExpected && wbExpected.oracleType ? wbExpected.oracleType : null,
      required: wbColumn && typeof wbColumn.required === 'boolean' ? wbColumn.required : null,
      mappedRoles,
      sensitivity: sensitivityFor(mappedRoles[0], header, declaredSensitivity),
    };
  });
  const columnByHeader = new Map(columns.map((column) => [normalizedName(column.header), column]));
  const workbookRows = workbookSheet && Array.isArray(workbookSheet.rows) ? workbookSheet.rows : [];
  const rawRows = Array.isArray(sheet && sheet.rows) ? sheet.rows : [];
  const duplicateRows = new Map();

  const rows = rawRows.map((rawRow, rowOrdinal) => {
    const rowHash = canonicalHash(headers.reduce((out, header) => {
      out[header] = rawRow && Object.prototype.hasOwnProperty.call(rawRow, header) ? rawRow[header] : '';
      return out;
    }, {}));
    const duplicateOccurrence = duplicateRows.get(rowHash) || 0;
    duplicateRows.set(rowHash, duplicateOccurrence + 1);
    const rowId = stableId('row', [sheetId, rowHash, duplicateOccurrence]);
    const wbRow = workbookRows[rowOrdinal] || {};
    const inputColumnIds = columns
      .filter((column) => column.role === 'input')
      .map((column) => column.columnId);
    const expected = columns
      .filter((column) => column.oracleType)
      .map((column) => ({ columnId: column.columnId, oracleType: column.oracleType }));
    const valueRefs = columns.reduce((out, column) => {
      out[column.columnId] = `dataset:${datasetRevisionId}:sheet:${sheetId}:row:${rowId}:column:${column.columnId}`;
      return out;
    }, {});
    const profileKey = wbRow.profileKey == null ? null : clean(wbRow.profileKey, 500);
    return {
      rowId,
      ordinal: rowOrdinal,
      rowHash,
      duplicateOccurrence,
      storyId: wbRow.storyId == null ? null : clean(wbRow.storyId, 120),
      intentClass: wbRow.intentClass || null,
      profileKeyHash: profileKey ? canonicalHash(profileKey) : null,
      inputColumnIds,
      expected,
      valueRefs,
    };
  });

  const inputRoleSignature = Array.from(new Set(columns
    .filter((column) => column.role === 'input')
    .flatMap((column) => column.mappedRoles.length ? column.mappedRoles : [column.normalizedHeader])))
    .sort();
  const columnById = new Map(columns.map((column) => [column.columnId, column]));
  const groupMap = new Map();
  for (const row of rows) {
    const oracleSignature = row.expected.map((item) => `${item.oracleType}:${item.columnId}`).sort();
    // groupHash must remain comparable across immutable dataset revisions.  A
    // columnId is revision-scoped, so use the semantic header + oracle type for
    // content identity while retaining the exact columnId signature for replay.
    const semanticOracleSignature = row.expected.map((item) => {
      const column = columnById.get(item.columnId);
      return `${item.oracleType}:${column ? column.normalizedHeader : 'unknown'}`;
    }).sort();
    const groupKey = canonicalJson({
      storyId: normalizedName(row.storyId || ''),
      intentClass: row.intentClass || null,
      semanticOracleSignature,
      inputRoleSignature,
    });
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        storyId: row.storyId || null,
        intentClass: row.intentClass || null,
        oracleSignature,
        semanticOracleSignature,
        inputRoleSignature,
        rowIds: [],
        rowHashes: [],
      });
    }
    const group = groupMap.get(groupKey);
    group.rowIds.push(row.rowId);
    group.rowHashes.push(row.rowHash);
  }
  const rowGroups = Array.from(groupMap.values()).map((group) => {
    const groupHash = canonicalHash({
      storyId: normalizedName(group.storyId || ''),
      intentClass: group.intentClass,
      semanticOracleSignature: group.semanticOracleSignature,
      inputRoleSignature: group.inputRoleSignature,
      rowHashes: [...group.rowHashes].sort(),
    });
    return {
      rowGroupId: stableId('row-group', [sheetId, groupHash]),
      groupHash,
      storyId: group.storyId,
      intentClass: group.intentClass,
      oracleSignature: group.oracleSignature,
      semanticOracleSignature: group.semanticOracleSignature,
      inputRoleSignature: group.inputRoleSignature,
      rowIds: group.rowIds,
      rowCount: group.rowIds.length,
    };
  });

  const bindingId = binding
    ? stableId('binding', [mappingRef && mappingRef.mappingId, mappingRef && mappingRef.version, sheetId, canonicalHash(binding)])
    : null;
  return {
    sheetId,
    ordinal,
    name,
    normalizedName: normalizedName(name),
    purpose: (binding && binding.purpose) || (workbookSheet && workbookSheet.purpose) || 'unknown',
    purposeConfidence: workbookSheet && Number.isFinite(Number(workbookSheet.purposeConfidence))
      ? Number(workbookSheet.purposeConfidence)
      : null,
    module: (binding && (binding.module || binding.moduleKey)) || null,
    bindingRef: binding ? {
      bindingId,
      mappingId: mappingRef && mappingRef.mappingId,
      mappingVersion: mappingRef && mappingRef.version,
      status: mappingRef && mappingRef.status,
    } : null,
    columns,
    rows,
    rowGroups,
    rowCount: rows.length,
  };
}

function buildDatasetContractV1({
  testDataSetId,
  projectId = null,
  sprintId = null,
  sourceName = null,
  sourceHash = null,
  parsedSheets = [],
  parserManifest = null,
  workbookContract = null,
  mappingSnapshot = null,
} = {}) {
  const datasetId = clean(testDataSetId, 180);
  if (!datasetId) throw new Error('DatasetContractV1 requires testDataSetId.');
  const sheets = parsedSheetList(parsedSheets);
  const workbook = workbookContract || buildWorkbookContract({ sheets, sourceId: datasetId, sourceName });
  const parser = sanitizeParserManifest(parserManifest, sheets);
  const parsedHash = canonicalHash({ parserVersion: parser.parserVersion, sheets });
  const datasetRevisionId = `dsv1:${parsedHash}`;
  const mappingInfo = mappingPayload(mappingSnapshot);
  const duplicateNames = new Map();
  const sheetContracts = sheets.map((sheet, ordinal) => {
    const key = normalizedName(sheet && sheet.name || `Sheet ${ordinal + 1}`);
    const occurrence = duplicateNames.get(key) || 0;
    duplicateNames.set(key, occurrence + 1);
    const wbSheet = workbookSheetFor(workbook, sheet, ordinal);
    const temporarySheetId = stableId('sheet', [datasetRevisionId, key, occurrence]);
    const binding = bindingForSheet(mappingInfo.mapping, sheet && sheet.name, temporarySheetId);
    return buildSheetContract({
      datasetRevisionId,
      sheet,
      ordinal,
      duplicateNameOccurrence: occurrence,
      workbookSheet: wbSheet,
      binding,
      mappingRef: mappingInfo.ref,
    });
  });
  const workbookFindings = (workbook && Array.isArray(workbook.findings) ? workbook.findings : [])
    .map(safeFinding)
    .filter(Boolean);
  const findings = [...workbookFindings];
  if (!parser.complete) findings.push({ code: 'dataset_source_partial', severity: 'warning', sheet: null });
  for (const [name, count] of duplicateNames) {
    if (count > 1) findings.push({ code: 'duplicate_sheet_name', severity: 'error', sheet: name });
  }
  const contractCore = {
    schemaVersion: SCHEMA_VERSION,
    datasetId,
    datasetRevisionId,
    projectId: projectId == null ? null : clean(projectId, 180),
    sprintId: sprintId == null ? null : clean(sprintId, 180),
    source: {
      name: sourceName == null ? null : clean(sourceName, 260),
      sourceHash: sourceHash ? clean(sourceHash, 160) : null,
      parsedHash,
      ...parser,
    },
    workbook: {
      schemaVersion: workbook && workbook.schemaVersion || null,
      fileHash: workbook && workbook.fileHash || null,
      certification: workbook && workbook.certification || null,
      confidence: workbook && Number.isFinite(Number(workbook.confidence)) ? Number(workbook.confidence) : null,
      findings: workbookFindings,
    },
    mappingRef: mappingInfo.ref,
    sheets: sheetContracts,
    findings,
    stats: {
      sheetCount: sheetContracts.length,
      columnCount: sheetContracts.reduce((sum, sheet) => sum + sheet.columns.length, 0),
      rowCount: sheetContracts.reduce((sum, sheet) => sum + sheet.rows.length, 0),
      rowGroupCount: sheetContracts.reduce((sum, sheet) => sum + sheet.rowGroups.length, 0),
      complete: parser.complete && !findings.some((finding) => finding.severity === 'error'),
    },
  };
  return {
    ...contractCore,
    contractId: stableId('dataset-contract', [datasetId, datasetRevisionId, canonicalHash({ workbook: contractCore.workbook, sheets: sheetContracts })]),
  };
}

function withMappingSnapshot(contract, snapshot) {
  if (!contract || contract.schemaVersion !== SCHEMA_VERSION) throw new Error('withMappingSnapshot requires DatasetContractV1.');
  const mappingInfo = mappingPayload(snapshot);
  if (!mappingInfo.mapping) return { ...contract, mappingRef: null };
  const cloned = JSON.parse(JSON.stringify(contract));
  cloned.mappingRef = mappingInfo.ref;
  for (const sheet of cloned.sheets) {
    const binding = bindingForSheet(mappingInfo.mapping, sheet.name, sheet.sheetId);
    if (!binding) {
      sheet.bindingRef = null;
      continue;
    }
    sheet.bindingRef = {
      bindingId: stableId('binding', [mappingInfo.ref.mappingId, mappingInfo.ref.version, sheet.sheetId, canonicalHash(binding)]),
      mappingId: mappingInfo.ref.mappingId,
      mappingVersion: mappingInfo.ref.version,
      status: mappingInfo.ref.status,
    };
    for (const column of sheet.columns) {
      column.mappedRoles = mappedRolesForColumn(binding, column.header);
      const explicit = column.mappedRoles
        .map((role) => binding.sensitivity && binding.sensitivity[role])
        .find(Boolean);
      column.sensitivity = sensitivityFor(column.mappedRoles[0], column.header, explicit);
    }
  }
  return cloned;
}

function buildProjectDatasetCatalogV1(contracts = []) {
  const datasets = (Array.isArray(contracts) ? contracts : []).map((contract) => JSON.parse(JSON.stringify(contract)));
  const findings = [];
  const sheetIndex = {};
  for (const dataset of datasets) {
    for (const sheet of (Array.isArray(dataset && dataset.sheets) ? dataset.sheets : [])) {
      const key = normalizedName(sheet.name);
      if (!sheetIndex[key]) sheetIndex[key] = [];
      sheetIndex[key].push({
        datasetId: dataset.datasetId,
        datasetRevisionId: dataset.datasetRevisionId,
        sheetId: sheet.sheetId,
        name: sheet.name,
      });
    }
  }
  for (const [name, refs] of Object.entries(sheetIndex)) {
    if (refs.length > 1) findings.push({ code: 'ambiguous_sheet_name', severity: 'warning', sheet: name, candidates: refs.map((ref) => ref.sheetId) });
  }
  const revisionRefs = datasets.map((dataset) => ({
    datasetId: dataset.datasetId,
    datasetRevisionId: dataset.datasetRevisionId,
    contractId: dataset.contractId,
    mappingRef: dataset.mappingRef,
  }));
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    catalogId: stableId('dataset-catalog', revisionRefs),
    datasets,
    sheetIndex,
    findings,
    stats: {
      datasetCount: datasets.length,
      sheetCount: datasets.reduce((sum, dataset) => sum + (dataset.sheets || []).length, 0),
      rowCount: datasets.reduce((sum, dataset) => sum + ((dataset.stats && dataset.stats.rowCount) || 0), 0),
      complete: datasets.every((dataset) => dataset.stats && dataset.stats.complete),
    },
  };
}

function datasetsOf(catalogOrContract) {
  if (!catalogOrContract) return [];
  if (catalogOrContract.schemaVersion === SCHEMA_VERSION) return [catalogOrContract];
  return Array.isArray(catalogOrContract.datasets) ? catalogOrContract.datasets : [];
}

function allSheetRefs(catalogOrContract) {
  return datasetsOf(catalogOrContract).flatMap((dataset) => (dataset.sheets || []).map((sheet) => ({ dataset, sheet })));
}

function resolveSheet(catalogOrContract, ref = {}) {
  let candidates = allSheetRefs(catalogOrContract);
  if (ref.datasetId) candidates = candidates.filter((item) => item.dataset.datasetId === ref.datasetId);
  if (ref.datasetRevisionId) candidates = candidates.filter((item) => item.dataset.datasetRevisionId === ref.datasetRevisionId);
  if (ref.sheetId) candidates = candidates.filter((item) => item.sheet.sheetId === ref.sheetId);
  else if (ref.sheetName) candidates = candidates.filter((item) => normalizedName(item.sheet.name) === normalizedName(ref.sheetName));
  if (candidates.length === 1) return { status: 'resolved', dataset: candidates[0].dataset, sheet: candidates[0].sheet, candidates: [] };
  const refs = candidates.map((item) => ({ datasetId: item.dataset.datasetId, datasetRevisionId: item.dataset.datasetRevisionId, sheetId: item.sheet.sheetId, name: item.sheet.name }));
  return { status: candidates.length ? 'ambiguous' : 'missing', dataset: null, sheet: null, candidates: refs };
}

function resolveColumn(sheet, ref = {}) {
  const columns = sheet && Array.isArray(sheet.columns) ? sheet.columns : [];
  let candidates = columns;
  if (ref.columnId) candidates = candidates.filter((column) => column.columnId === ref.columnId);
  else if (ref.header) candidates = candidates.filter((column) => normalizedName(column.header) === normalizedName(ref.header));
  if (candidates.length === 1) return { status: 'resolved', column: candidates[0], candidates: [] };
  return {
    status: candidates.length ? 'ambiguous' : 'missing',
    column: null,
    candidates: candidates.map((column) => ({ columnId: column.columnId, header: column.header })),
  };
}

function rowsForRef(catalogOrContract, ref = {}) {
  const sheetResolution = resolveSheet(catalogOrContract, ref);
  if (sheetResolution.status !== 'resolved') return { status: sheetResolution.status, rows: [], candidates: sheetResolution.candidates };
  const sheet = sheetResolution.sheet;
  let rowIds = Array.isArray(ref.rowIds) ? ref.rowIds : null;
  if (ref.rowGroupId) {
    const groups = (sheet.rowGroups || []).filter((group) => group.rowGroupId === ref.rowGroupId);
    if (groups.length !== 1) return { status: groups.length ? 'ambiguous' : 'missing', rows: [], candidates: groups.map((group) => group.rowGroupId) };
    rowIds = groups[0].rowIds;
  }
  const wanted = rowIds ? new Set(rowIds) : null;
  const rows = (sheet.rows || []).filter((row) => !wanted || wanted.has(row.rowId));
  if (wanted && rows.length !== wanted.size) return { status: 'missing', rows, candidates: [] };
  return { status: 'resolved', rows, candidates: [] };
}

function validateDatasetContractV1(contract) {
  const errors = [];
  const warnings = [];
  if (!contract || contract.schemaVersion !== SCHEMA_VERSION) errors.push({ code: 'dataset_contract_version_invalid' });
  if (!contract || !contract.datasetId) errors.push({ code: 'dataset_id_missing' });
  if (!contract || !contract.datasetRevisionId) errors.push({ code: 'dataset_revision_id_missing' });
  const ids = new Set();
  const visitId = (id, code) => {
    if (!id) errors.push({ code: `${code}_missing` });
    else if (ids.has(id)) errors.push({ code: `${code}_duplicate`, id });
    else ids.add(id);
  };
  for (const sheet of (contract && Array.isArray(contract.sheets) ? contract.sheets : [])) {
    visitId(sheet.sheetId, 'sheet_id');
    for (const column of (sheet.columns || [])) visitId(column.columnId, 'column_id');
    for (const row of (sheet.rows || [])) {
      visitId(row.rowId, 'row_id');
      for (const key of Object.keys(row)) {
        if (RAW_VALUE_KEYS.has(key)) errors.push({ code: 'raw_value_field_forbidden', sheetId: sheet.sheetId, rowId: row.rowId, field: key });
      }
    }
    for (const group of (sheet.rowGroups || [])) visitId(group.rowGroupId, 'row_group_id');
  }
  if (contract && contract.source && contract.source.complete === false) warnings.push({ code: 'dataset_source_partial' });
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: contract && contract.stats ? { ...contract.stats } : null,
  };
}

module.exports = {
  SCHEMA_VERSION,
  CATALOG_SCHEMA_VERSION,
  buildDatasetContractV1,
  validateDatasetContractV1,
  withMappingSnapshot,
  buildProjectDatasetCatalogV1,
  resolveSheet,
  resolveColumn,
  rowsForRef,
  canonicalHash,
  canonicalJson,
  stableId,
  _private: {
    canonicalize,
    normalizedName,
    sensitivityFor,
    sanitizeParserManifest,
  },
};
