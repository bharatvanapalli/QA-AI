'use strict';

const crypto = require('node:crypto');

const VERSION = 'TestDesignPlanV1';
const PLAN_ERROR_CODE = 'TEST_DESIGN_PLAN_INVALID';
const VOLATILE_KEYS = new Set([
  'generatedAt',
  'createdAt',
  'updatedAt',
  'uploadedAt',
  'timestamp',
  'startedAt',
  'completedAt',
]);
const SENSITIVE_RE = /(?:^|[^a-z0-9])(?:pass(?:word)?|pwd|secret|token|api[_ -]?key|credential|otp|mfa|pin)(?:$|[^a-z0-9])/i;

class TestDesignPlanV1Error extends Error {
  constructor(message, findings = []) {
    super(message);
    this.name = 'TestDesignPlanV1Error';
    this.code = PLAN_ERROR_CODE;
    this.status = 422;
    this.findings = Array.isArray(findings) ? findings : [];
  }
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase();
}

function parseObject(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function canonicalize(value, { stripVolatile = false } = {}) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = canonicalize(item, { stripVolatile });
      return normalized === undefined ? null : normalized;
    });
  }
  if (typeof value !== 'object') return undefined;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (stripVolatile && VOLATILE_KEYS.has(key)) continue;
    const normalized = canonicalize(value[key], { stripVolatile });
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

function stableStringify(value, options) {
  return JSON.stringify(canonicalize(value, options));
}

function sha256(value) {
  const input = typeof value === 'string' ? value : stableStringify(value);
  return crypto.createHash('sha256').update(input).digest('hex');
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(stableStringify(value));
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    if (value == null || value === '') continue;
    const key = typeof value === 'string' ? value : stableStringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function sortedStrings(values) {
  return unique((values || []).map((value) => clean(value)).filter(Boolean))
    .sort((a, b) => a.localeCompare(b));
}

function normalizeToken(value) {
  return clean(value)
    .replace(/^\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .replace(/^data\./i, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function normalizeStoryId(value) {
  return clean(value).replace(/\s+/g, '').toLowerCase();
}

function normalizeRequirementInputs(requirements = [], requirementClauses = []) {
  const rows = [...(Array.isArray(requirements) ? requirements : []), ...(Array.isArray(requirementClauses) ? requirementClauses : [])];
  const normalized = rows.map((row, index) => {
    const item = row && typeof row === 'object' ? row : { content: row };
    const semanticText = [
      item.behaviourText,
      item.behaviorText,
      item.content,
      item.text,
      item.description,
      item.excerpt,
      item.acceptanceCriteria,
      item.title,
    ].filter((entry) => entry != null).map(String).join('\n');
    const digest = clean(item.contentHash || item.sourceDigest || item.digest) || sha256(semanticText);
    const id = clean(item.clauseId || item.id || item.requirementId || item.storyId || item.externalId)
      || `requirement_${sha256(`${digest}:${index}`).slice(0, 20)}`;
    return {
      id,
      storyId: clean(item.storyId || item.externalId) || null,
      sourceId: clean(item.requirementId || item.sourceRequirementId || item.documentId) || null,
      digest,
    };
  });
  const deduped = unique(normalized.map((row) => canonicalize(row)))
    .sort((a, b) => a.id.localeCompare(b.id) || a.digest.localeCompare(b.digest));
  return {
    clauseIds: sortedStrings(deduped.map((row) => row.id)),
    clauses: deduped,
    digest: sha256(deduped),
  };
}

function manifestItems(manifest) {
  const parsed = parseObject(manifest, {}) || {};
  return Array.isArray(parsed.items) ? parsed.items.filter(Boolean) : [];
}

function coverageRefOf(value) {
  return clean(value && (
    value.coverageRef
    || value.primaryCoverageRef
    || value.manifestItemId
    || value.coverageItemId
    || value.id
  ));
}

function semanticManifest(manifest) {
  const parsed = parseObject(manifest, {}) || {};
  const items = manifestItems(parsed).map((item) => canonicalize(item, { stripVolatile: true }));
  return {
    version: parsed.version || null,
    sourceMode: parsed.sourceMode || null,
    moduleScope: parsed.moduleScope || null,
    items,
  };
}

function semanticPacks(packs) {
  return (Array.isArray(packs) ? packs : []).map((pack) => canonicalize(pack, { stripVolatile: true }));
}

function derivePacksFromManifest(manifest) {
  const all = manifestItems(manifest);
  const required = all.filter((item) => item.required === true);
  const selected = required.length ? required : all.filter((item) => item.advisory !== true && item.required !== false);
  return selected.map((item) => {
    const dataSource = item.dataSource && typeof item.dataSource === 'object' ? item.dataSource : null;
    const placeholders = dataSource && Array.isArray(dataSource.placeholders) ? dataSource.placeholders : [];
    return {
      coverageRef: coverageRefOf(item),
      storyId: item.storyId || (item.storyRef && item.storyRef.id) || null,
      module: item.module || (item.storyRef && item.storyRef.moduleHint) || null,
      title: item.title || (item.storyRef && item.storyRef.title) || coverageRefOf(item),
      pageIntent: item.pageIntent || item.intent || item.title || (item.storyRef && item.storyRef.title) || coverageRefOf(item),
      requiredFields: Array.isArray(item.requiredFields) ? item.requiredFields : [],
      requiredActions: Array.isArray(item.requiredActions) ? item.requiredActions : [],
      semanticTokenMap: Object.fromEntries(placeholders.map((token) => [token, token])),
      rowIntent: dataSource ? {
        sheet: dataSource.sheet || null,
        rowSelector: dataSource.rowSelector || null,
        rowIds: Array.isArray(dataSource.rows) ? dataSource.rows : [],
        rowSource: 'coverage_manifest',
      } : { sheet: null, rowSelector: null, rowIds: [], rowSource: 'none' },
      requiredOracle: (Array.isArray(item.requiredOracles) && item.requiredOracles[0]) || {
        kind: 'visible',
        target: item.title || coverageRefOf(item),
        expected: true,
        source: 'coverage_manifest',
        required: true,
      },
      requiredOracles: Array.isArray(item.requiredOracles) ? item.requiredOracles : [],
      authPreconditions: Array.isArray(item.authPreconditions) ? item.authPreconditions : [],
    };
  });
}

function unwrapDataset(dataset, testData, workbookContract) {
  const outer = parseObject(dataset, {}) || {};
  const context = parseObject(testData, null)
    || parseObject(outer.testData, null)
    || parseObject(outer.dataset, null)
    || outer;
  const mapping = parseObject(context && context.mapping, {}) || {};
  const workbook = parseObject(workbookContract, null)
    || parseObject(outer.workbookContract, null)
    || parseObject(context && context.workbookContract, null)
    || null;
  const rawSheets = Array.isArray(context && context.sheets)
    ? context.sheets
    : (workbook && Array.isArray(workbook.sheets) ? workbook.sheets : []);
  const bindings = Array.isArray(mapping.bindings) ? mapping.bindings.filter(Boolean) : [];
  const sources = [
    ...(Array.isArray(mapping.sources) ? mapping.sources : []),
    ...(Array.isArray(outer.mappingSources) ? outer.mappingSources : []),
  ].map((source) => ({
    testDataSetId: clean(source && source.testDataSetId) || null,
    mappingId: clean(source && (source.mappingId || source.id)) || null,
    mappingVersion: source && source.mappingVersion != null ? source.mappingVersion : (source && source.version != null ? source.version : null),
    status: clean(source && source.status) || null,
  }));
  const source = clean(outer.source || (context && context.source) || (context && context.generationContract && context.generationContract.source) || mapping.status) || 'none';
  const status = clean(mapping.status || outer.status || source) || 'none';
  const workbookHash = clean(
    outer.workbookHash
    || outer.fileHash
    || (workbook && (workbook.fileHash || workbook.workbookHash))
    || (context && (context.workbookHash || context.fileHash)),
  ) || (rawSheets.length ? sha256(canonicalize(rawSheets, { stripVolatile: true })) : null);
  return {
    source,
    status,
    mapping,
    bindings,
    sources: unique(sources.map(canonicalize)).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    sheets: rawSheets,
    workbook,
    workbookHash,
  };
}

function normalizeAlignmentInput(alignments) {
  if (Array.isArray(alignments)) return alignments.filter(Boolean);
  const parsed = parseObject(alignments, {}) || {};
  for (const key of ['alignments', 'items', 'bindings', 'coverageItems']) {
    if (Array.isArray(parsed[key])) return parsed[key].filter(Boolean);
  }
  return [];
}

function alignmentSemantic(alignment) {
  if (!alignment || typeof alignment !== 'object') return {};
  return canonicalize({
    coverageRef: coverageRefOf(alignment) || null,
    storyId: alignment.storyId || null,
    sheet: alignment.sheet || (alignment.dataSource && alignment.dataSource.sheet) || null,
    datasetRevisionId: alignment.datasetRevisionId || null,
    sheetId: alignment.sheetId || null,
    rowGroupId: alignment.rowGroupId || null,
    testDataSetId: alignment.testDataSetId || null,
    mappingId: alignment.mappingId || null,
    mappingVersion: alignment.mappingVersion != null ? alignment.mappingVersion : (alignment.version != null ? alignment.version : null),
    status: alignment.status || null,
    approved: alignment.approved === true,
    columnToField: alignment.columnToField || null,
    bindings: alignment.bindings || null,
    expectedColumn: alignment.expectedColumn || null,
    rowClassColumn: alignment.rowClassColumn || null,
    rowSelector: alignment.rowSelector || null,
    rowIds: alignment.rowIds || alignment.rows || null,
    requiredOracles: alignment.requiredOracles || alignment.oracles || null,
  });
}

function datasetRevision(datasetContext, alignments) {
  const mappings = datasetContext.sources.map((source) => ({
    testDataSetId: source.testDataSetId,
    mappingId: source.mappingId,
    mappingVersion: source.mappingVersion,
    status: source.status,
  }));
  const bindingProjection = datasetContext.bindings.map((binding) => canonicalize({
    coverageRef: coverageRefOf(binding) || null,
    storyId: binding.storyId || null,
    sheet: binding.sheet || null,
    testDataSetId: binding.testDataSetId || null,
    mappingId: binding.mappingId || null,
    mappingVersion: binding.mappingVersion != null ? binding.mappingVersion : null,
    status: binding.status || null,
    columnToField: binding.columnToField || null,
    expectedColumn: binding.expectedColumn || null,
    rowClassColumn: binding.rowClassColumn || null,
    rowSelector: binding.rowSelector || null,
  }));
  const alignmentProjection = alignments.map(alignmentSemantic);
  return {
    source: datasetContext.source,
    status: datasetContext.status,
    workbookHash: datasetContext.workbookHash,
    mappings,
    digest: sha256({
      source: datasetContext.source,
      status: datasetContext.status,
      workbookHash: datasetContext.workbookHash,
      datasetRevisionId: null,
      sheetId: null,
      rowGroupId: null,
      mappings,
      bindings: bindingProjection,
      alignments: alignmentProjection,
    }),
  };
}

function findManifestItem(pack, items) {
  const ref = coverageRefOf(pack);
  return items.find((item) => {
    const refs = [coverageRefOf(item), item && item.id, item && item.manifestItemId, item && item.coverageItemId]
      .map(clean).filter(Boolean);
    return refs.includes(ref) || (Array.isArray(pack && pack.aliases) && pack.aliases.some((alias) => refs.includes(clean(alias))));
  }) || null;
}

function exactAlignmentCandidates({ pack, manifestItem, datasetContext, alignments }) {
  const coverageRef = coverageRefOf(pack);
  const storyId = normalizeStoryId(pack && (pack.storyId || (manifestItem && manifestItem.storyRef && manifestItem.storyRef.id)));
  const plannedSheet = clean(
    pack && pack.rowIntent && pack.rowIntent.sheet
    || manifestItem && manifestItem.dataSource && manifestItem.dataSource.sheet,
  );
  const all = [
    ...alignments.map((entry) => ({ ...entry, __origin: 'alignment' })),
    ...datasetContext.bindings.map((entry) => ({ ...entry, __origin: 'mapping' })),
  ];
  const direct = all.filter((entry) => coverageRef && [coverageRefOf(entry), clean(entry && entry.primaryCoverageRef)]
    .filter(Boolean).includes(coverageRef));
  if (direct.length) return { basis: 'coverage_ref', candidates: direct, plannedSheet };
  const story = all.filter((entry) => storyId && normalizeStoryId(entry && entry.storyId) === storyId);
  if (story.length) return { basis: 'story_id', candidates: story, plannedSheet };
  const sheet = all.filter((entry) => plannedSheet && norm(entry && entry.sheet) === norm(plannedSheet));
  if (sheet.length) return { basis: 'planned_sheet', candidates: sheet, plannedSheet };
  return { basis: null, candidates: [], plannedSheet };
}

function dedupeAlignmentCandidates(candidates) {
  const bySemantic = new Map();
  for (const candidate of candidates) {
    const key = stableStringify(alignmentSemantic(candidate));
    if (!bySemantic.has(key)) bySemantic.set(key, candidate);
  }
  return Array.from(bySemantic.values());
}

function resolveMappingPin(selected, datasetContext) {
  const direct = {
    testDataSetId: clean(selected && selected.testDataSetId) || null,
    mappingId: clean(selected && selected.mappingId) || null,
    mappingVersion: selected && selected.mappingVersion != null
      ? selected.mappingVersion
      : (selected && selected.version != null ? selected.version : null),
  };
  const exactSources = datasetContext.sources.filter((source) => (
    (!direct.mappingId || source.mappingId === direct.mappingId)
    && (!direct.testDataSetId || source.testDataSetId === direct.testDataSetId)
  ));
  const source = exactSources.length === 1
    ? exactSources[0]
    : (!direct.mappingId && !direct.testDataSetId && datasetContext.sources.length === 1 ? datasetContext.sources[0] : null);
  const revisionConflict = !!(source && (
    (direct.testDataSetId && source.testDataSetId && direct.testDataSetId !== source.testDataSetId)
    || (direct.mappingId && source.mappingId && direct.mappingId !== source.mappingId)
    || (direct.mappingVersion != null && source.mappingVersion != null && String(direct.mappingVersion) !== String(source.mappingVersion))
  ));
  return {
    testDataSetId: direct.testDataSetId || (source && source.testDataSetId) || null,
    mappingId: direct.mappingId || (source && source.mappingId) || null,
    mappingVersion: direct.mappingVersion != null ? direct.mappingVersion : (source && source.mappingVersion != null ? source.mappingVersion : null),
    sourceStatus: clean(selected && selected.status) || (source && source.status) || datasetContext.status,
    ambiguousSource: exactSources.length > 1 && (!direct.mappingId || !direct.testDataSetId),
    sourceMatched: !!source,
    revisionConflict,
  };
}

function sensitivityFor(...values) {
  const text = values.map(clean).filter(Boolean).join(' ');
  return SENSITIVE_RE.test(` ${text} `) ? 'sensitive' : 'normal';
}

function semanticTokenFor(role, semanticTokenMap) {
  const entries = Object.entries(semanticTokenMap && typeof semanticTokenMap === 'object' ? semanticTokenMap : {});
  const direct = entries.find(([field]) => norm(field) === norm(role));
  if (direct) return normalizeToken(direct[1]) || normalizeToken(role);
  const reverse = entries.find(([, token]) => normalizeToken(token) === normalizeToken(role));
  return reverse ? normalizeToken(reverse[1]) : normalizeToken(role);
}

function normalizeBindings(selected, semanticTokenMap) {
  if (Array.isArray(selected && selected.bindings) && selected.bindings.length) {
    return selected.bindings.map((binding) => {
      const token = normalizeToken(binding && (binding.token || binding.dataRef || binding.role || binding.name));
      const column = clean(binding && (binding.column || binding.sourceColumn || binding.header));
      return {
        dataRef: `data.${token}`,
        token,
        column,
        classification: binding && binding.classification === 'sensitive'
          ? 'sensitive'
          : sensitivityFor(token, column),
      };
    }).filter((binding) => binding.token && binding.column);
  }
  const columnToField = selected && selected.columnToField && typeof selected.columnToField === 'object'
    ? selected.columnToField
    : {};
  return Object.entries(columnToField).map(([role, column]) => {
    const token = semanticTokenFor(role, semanticTokenMap);
    return {
      dataRef: `data.${token}`,
      token,
      column: clean(column),
      classification: sensitivityFor(role, token, column),
    };
  }).filter((binding) => binding.token && binding.column)
    .sort((a, b) => a.token.localeCompare(b.token) || a.column.localeCompare(b.column));
}

function rowsForSheet(datasetContext, sheetName) {
  const sheet = datasetContext.sheets.find((entry) => norm(entry && entry.name) === norm(sheetName));
  return sheet && Array.isArray(sheet.rows) ? sheet.rows : [];
}

function cellValue(row, column) {
  if (!row || !column) return null;
  if (Object.prototype.hasOwnProperty.call(row, column)) return row[column];
  if (row.inputs && typeof row.inputs === 'object' && Object.prototype.hasOwnProperty.call(row.inputs, column)) return row.inputs[column];
  if (Array.isArray(row.expected)) {
    const expected = row.expected.find((entry) => norm(entry && entry.column) === norm(column));
    if (expected) return expected.value;
  }
  return null;
}

function selectedRows(rows, rowIds) {
  if (!Array.isArray(rowIds) || !rowIds.length) return rows;
  const wanted = new Set(rowIds.map((id) => String(id)));
  return rows.filter((row, index) => wanted.has(String(index))
    || wanted.has(String(row && row.id))
    || wanted.has(String(row && row.index))
    || wanted.has(String(row && row.rowId))
    || wanted.has(String(row && row.__datasetRowId)));
}

function digestSensitiveLiteral(value, workbookHash) {
  return sha256(`${VERSION}:sensitive:${workbookHash || 'no-workbook'}:${String(value)}`);
}

function sensitiveLiteralDigests(datasetContext, sheet, rowIds, bindings) {
  const sensitive = bindings.filter((binding) => binding.classification === 'sensitive');
  if (!sensitive.length) return [];
  const rows = selectedRows(rowsForSheet(datasetContext, sheet), rowIds);
  const hashes = [];
  for (const row of rows) {
    for (const binding of sensitive) {
      const value = cellValue(row, binding.column);
      if (value == null || String(value) === '') continue;
      hashes.push(digestSensitiveLiteral(value, datasetContext.workbookHash));
    }
  }
  return sortedStrings(hashes);
}

function normalizeRowIds(value) {
  return unique((Array.isArray(value) ? value : []).map((entry) => (
    entry && typeof entry === 'object' ? (entry.id != null ? entry.id : (entry.index != null ? entry.index : entry.rowId)) : entry
  )).filter((entry) => entry != null));
}

function inlineDataPlanFor(pack) {
  const contract = pack && pack.caseContractV1 && typeof pack.caseContractV1 === 'object'
    ? pack.caseContractV1
    : null;
  if (!contract) return null;
  const unused = new Set(Array.isArray(contract.unusedDataRefs) ? contract.unusedDataRefs.map(String) : []);
  const bindings = (Array.isArray(contract.dataBindings) ? contract.dataBindings : [])
    .filter((binding) => binding && !unused.has(String(binding.id)))
    .map((binding) => {
      const token = normalizeToken(binding.name || binding.id);
      return {
        dataRef: `data.${token}`,
        token,
        classification: binding.classification === 'sensitive' ? 'sensitive' : 'normal',
        source: clone(binding.source || null),
      };
    })
    .filter((binding) => binding.token);
  const rows = (Array.isArray(contract.dataRows) ? contract.dataRows : []).map((row) => ({
    id: clean(row && row.id) || null,
    bindings: clone(row && row.bindings || {}),
  }));
  if (!bindings.length && !rows.length) return null;
  const inlineRevision = sha256({
    contractId: contract.id || null,
    bindings,
    rows,
    unusedDataRefs: Array.from(unused).sort(),
  });
  return {
    mode: 'inline',
    approved: true,
    inlineRevision,
    testDataSetId: null,
    mappingId: null,
    mappingVersion: null,
    workbookHash: inlineRevision,
    datasetRevisionId: null,
    sheetId: null,
    rowGroupId: null,
    sheet: null,
    rowSelector: rows.length > 1 ? 'all_rows' : 'single',
    rowIds: rows.map((row) => row.id).filter(Boolean),
    rows,
    bindings,
    columnToField: {},
    expectedColumn: null,
    expectedToken: null,
    rowClassColumn: null,
    allowedTokens: sortedStrings(bindings.map((binding) => binding.token)),
    sensitiveDataRefs: bindings.filter((binding) => binding.classification === 'sensitive').map((binding) => binding.dataRef),
    sensitiveLiteralDigests: [],
    unusedDataRefs: Array.from(unused).sort(),
    alignmentBasis: 'case_contract_v1',
  };
}

function buildDataPlan({ pack, manifestItem, datasetContext, alignments, findings }) {
  const resolved = exactAlignmentCandidates({ pack, manifestItem, datasetContext, alignments });
  const candidates = dedupeAlignmentCandidates(resolved.candidates);
  const plannedRowIntent = pack && pack.rowIntent && typeof pack.rowIntent === 'object' ? pack.rowIntent : {};
  const manifestSource = manifestItem && manifestItem.dataSource && typeof manifestItem.dataSource === 'object'
    ? manifestItem.dataSource
    : {};
  const wantsData = !!(
    resolved.plannedSheet
    || candidates.length
    || normalizeRowIds(plannedRowIntent.rowIds).length
  );
  const inlinePlan = inlineDataPlanFor(pack);

  if (!wantsData) {
    if (inlinePlan) return inlinePlan;
    return {
      mode: 'none',
      approved: false,
      testDataSetId: null,
      mappingId: null,
      mappingVersion: null,
      workbookHash: datasetContext.workbookHash,
      sheet: null,
      rowSelector: null,
      rowIds: [],
      bindings: [],
      columnToField: {},
      expectedColumn: null,
      rowClassColumn: null,
      allowedTokens: [],
      sensitiveDataRefs: [],
      sensitiveLiteralDigests: [],
      alignmentBasis: null,
    };
  }

  if (inlinePlan && inlinePlan.bindings.length) {
    findings.push({
      code: 'test_design_data_source_conflict',
      severity: 'error',
      coverageRef: coverageRefOf(pack),
      detail: 'The case has both authored inline values and an uploaded matrix alignment. Select one authoritative data source before planning; the planner will not choose by precedence.',
    });
  }

  if (!candidates.length) {
    findings.push({
      code: 'test_design_data_alignment_missing',
      severity: 'error',
      coverageRef: coverageRefOf(pack),
      detail: 'The planned data-bound case has no exact coverageRef, storyId, or planned-sheet mapping.',
    });
  }
  if (candidates.length > 1) {
    findings.push({
      code: 'test_design_data_alignment_ambiguous',
      severity: 'error',
      coverageRef: coverageRefOf(pack),
      candidates: candidates.map((entry) => ({
        sheet: entry.sheet || null,
        mappingId: entry.mappingId || null,
        storyId: entry.storyId || null,
      })),
      detail: 'More than one exact data alignment remains; the planner will not choose the first candidate.',
    });
  }
  const selected = candidates[0] || {};
  if (selected.ambiguous === true || norm(selected.decision) === 'ambiguous') {
    findings.push({
      code: 'test_design_data_alignment_ambiguous',
      severity: 'error',
      coverageRef: coverageRefOf(pack),
      detail: 'The supplied alignment is explicitly marked ambiguous.',
    });
  }
  const sheet = clean(selected.sheet || resolved.plannedSheet);
  if (resolved.plannedSheet && sheet && norm(resolved.plannedSheet) !== norm(sheet)) {
    findings.push({
      code: 'test_design_data_sheet_drift',
      severity: 'error',
      coverageRef: coverageRefOf(pack),
      expected: resolved.plannedSheet,
      actual: sheet,
      detail: 'The selected alignment does not match the sheet declared by the coverage plan.',
    });
  }
  const pin = resolveMappingPin(selected, datasetContext);
  const explicitStatus = norm(selected.status);
  const explicitlyRejected = selected.approved === false || (explicitStatus && explicitStatus !== 'approved');
  const approved = !explicitlyRejected && (selected.approved === true
    || explicitStatus === 'approved'
    || norm(pin.sourceStatus) === 'approved'
    || norm(datasetContext.source) === 'approved'
    || norm(datasetContext.status) === 'approved');
  if (!approved) {
    findings.push({
      code: 'test_design_data_unapproved',
      severity: 'error',
      coverageRef: coverageRefOf(pack),
      detail: 'A matrix case may only be designed from an approved immutable mapping.',
    });
  }
  if (pin.ambiguousSource) {
    findings.push({
      code: 'test_design_mapping_pin_ambiguous',
      severity: 'error',
      coverageRef: coverageRefOf(pack),
      detail: 'The exact mapping source cannot be selected without guessing.',
    });
  }
  if (pin.revisionConflict || (datasetContext.sources.length && !pin.sourceMatched)) {
    findings.push({
      code: 'test_design_mapping_revision_mismatch',
      severity: 'error',
      coverageRef: coverageRefOf(pack),
      detail: 'The selected mapping pin does not resolve to the supplied approved mapping source revision.',
    });
  }
  if (!pin.testDataSetId || !pin.mappingId || pin.mappingVersion == null || !datasetContext.workbookHash) {
    findings.push({
      code: 'test_design_mapping_revision_missing',
      severity: 'error',
      coverageRef: coverageRefOf(pack),
      detail: 'The data plan requires testDataSetId, mappingId, mappingVersion, and workbookHash pins.',
    });
  }
  const bindings = normalizeBindings(selected, pack && (pack.semanticTokenMap || pack.semanticTokens));
  if (!bindings.length) {
    findings.push({
      code: 'test_design_data_bindings_missing',
      severity: 'error',
      coverageRef: coverageRefOf(pack),
      detail: 'The exact alignment has no compiler-owned token-to-column bindings.',
    });
  }
  const rowIdSource = [plannedRowIntent.rowIds, selected.rowIds, selected.rows, manifestSource.rows]
    .find((value) => Array.isArray(value) && value.length) || [];
  const rowIds = normalizeRowIds(rowIdSource);
  const expectedColumn = clean(selected.expectedColumn || manifestSource.expectedColumn) || null;
  const expectedToken = expectedColumn ? normalizeToken(selected.expectedToken || manifestSource.expectedToken || 'expected') : null;
  const allowedTokens = sortedStrings([
    ...bindings.map((binding) => binding.token),
    expectedToken,
  ]);
  const columnToField = Object.fromEntries(bindings.map((binding) => [binding.token, binding.column]));
  return {
    mode: 'matrix',
    approved,
    testDataSetId: pin.testDataSetId,
    mappingId: pin.mappingId,
    mappingVersion: pin.mappingVersion,
    workbookHash: datasetContext.workbookHash,
    datasetRevisionId: clean(selected.datasetRevisionId) || null,
    sheetId: clean(selected.sheetId) || null,
    rowGroupId: clean(selected.rowGroupId) || null,
    sheet: sheet || null,
    rowSelector: clean(plannedRowIntent.rowSelector || selected.rowSelector || manifestSource.rowSelector) || 'all',
    rowIds,
    bindings,
    columnToField,
    expectedColumn,
    expectedToken,
    rowClassColumn: clean(selected.rowClassColumn || manifestSource.rowClassColumn) || null,
    allowedTokens,
    sensitiveDataRefs: bindings.filter((binding) => binding.classification === 'sensitive').map((binding) => binding.dataRef),
    sensitiveLiteralDigests: sensitiveLiteralDigests(datasetContext, sheet, rowIds, bindings),
    alignmentBasis: resolved.basis,
  };
}

function normalizeOracleKind(value) {
  const key = norm(value).replace(/[\s-]+/g, '_');
  const aliases = {
    assert_url: 'url',
    url_match: 'url',
    navigation: 'url',
    assert_text: 'text',
    content: 'text',
    validation: 'validation_message',
    error: 'validation_message',
    assert_number: 'number',
    numeric: 'number',
    assert_visible: 'visible',
    visibility: 'visible',
    assert_hidden: 'hidden',
    invisibility: 'hidden',
    state: 'visible',
    state_change: 'visible',
  };
  return aliases[key] || key || 'visible';
}

function normalizeOracles(pack, selectedDataPlan) {
  const supplied = [
    ...(Array.isArray(pack && pack.requiredOracles) ? pack.requiredOracles : []),
    ...(pack && pack.requiredOracle ? [pack.requiredOracle] : []),
  ].filter(Boolean);
  const source = supplied.length ? supplied : [{
    kind: 'visible',
    target: pack && (pack.title || pack.pageIntent || coverageRefOf(pack)),
    expected: true,
    source: 'case_contract_pack',
    required: true,
  }];
  const out = [];
  for (const [index, oracle] of source.entries()) {
    const kind = normalizeOracleKind(oracle.kind || oracle.channel || oracle.type);
    const token = normalizeToken(oracle.token || oracle.dataRef || (
      typeof oracle.expected === 'string' && /^\{\{[^}]+\}\}$/.test(oracle.expected.trim()) ? oracle.expected : ''
    ));
    const semantic = {
      kind,
      target: clean(oracle.target || oracle.label || pack && pack.title) || null,
      expected: oracle.expected === undefined ? true : clone(oracle.expected),
      required: oracle.required !== false,
      source: clean(oracle.source) || 'case_contract_pack',
      column: clean(oracle.column || oracle.sourceColumn || (
        token === selectedDataPlan.expectedToken ? selectedDataPlan.expectedColumn : null
      )) || null,
      token: token || null,
    };
    const oracleRef = clean(oracle.oracleRef || oracle.id)
      || `oracle_${sha256({ index, ...semantic }).slice(0, 20)}`;
    const item = { oracleRef, ...semantic };
    const key = stableStringify(item);
    if (!out.some((existing) => stableStringify(existing) === key)) out.push(item);
  }
  return out;
}

function sessionRequirementFor(pack) {
  const explicit = pack && pack.sessionRequirement && typeof pack.sessionRequirement === 'object'
    ? pack.sessionRequirement
    : null;
  if (explicit) return clone(explicit);
  const auth = Array.isArray(pack && pack.authPreconditions) ? pack.authPreconditions : [];
  if (auth.length) {
    return {
      required: true,
      mode: 'authenticated',
      authPreconditions: clone(auth),
    };
  }
  return { required: false, mode: 'fresh' };
}

function requirementLineageFor(pack, manifestItem, requirementRevision) {
  const storyIds = sortedStrings([
    pack && pack.storyId,
    manifestItem && manifestItem.storyId,
    manifestItem && manifestItem.storyRef && manifestItem.storyRef.id,
  ]);
  const storyKeys = new Set(storyIds.map(normalizeStoryId));
  const matchedClauses = (requirementRevision && Array.isArray(requirementRevision.clauses) ? requirementRevision.clauses : [])
    .filter((clause) => storyKeys.has(normalizeStoryId(clause.storyId)));
  const explicitRefs = sortedStrings(Array.isArray(pack && pack.requirementRefs) ? pack.requirementRefs : []);
  const requirementRefs = sortedStrings([
    ...explicitRefs,
    ...matchedClauses.map((clause) => clause.id),
    ...(matchedClauses.length || explicitRefs.length ? [] : storyIds),
  ]);
  const selectedIds = new Set(requirementRefs);
  const requirementRevisions = (requirementRevision && Array.isArray(requirementRevision.clauses) ? requirementRevision.clauses : [])
    .filter((clause) => selectedIds.has(clause.id))
    .map((clause) => ({ id: clause.id, digest: clause.digest }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { requirementRefs, requirementRevisions };
}

function legacyRequirementRefsFor(pack, manifestItem) {
  return sortedStrings([
    ...(Array.isArray(pack && pack.requirementRefs) ? pack.requirementRefs : []),
    pack && pack.storyId,
    manifestItem && manifestItem.storyId,
    manifestItem && manifestItem.storyRef && manifestItem.storyRef.id,
  ]);
}

function caseSemanticProjection(casePlan) {
  return canonicalize({
    coverageRef: casePlan.coverageRef,
    storyId: casePlan.storyId,
    requirementRefs: casePlan.requirementRefs,
    intent: casePlan.intent,
    module: casePlan.module,
    initialState: casePlan.initialState,
    expectedFinalState: casePlan.expectedFinalState,
    sessionRequirement: casePlan.sessionRequirement,
    dependencies: casePlan.dependencies,
    failurePolicy: casePlan.failurePolicy,
    actionTopology: casePlan.actionTopology,
    requiredFields: casePlan.requiredFields,
    caseContractV1: casePlan.caseContractV1,
    sourceParity: casePlan.sourceParity,
    requirementRevisions: casePlan.requirementRevisions,
    dataPlan: casePlan.dataPlan,
    oracles: casePlan.oracles,
  });
}

function sourceParityFor(caseContract) {
  if (!caseContract || typeof caseContract !== 'object') return null;
  const steps = Array.isArray(caseContract.steps) ? caseContract.steps : [];
  const assertions = Array.isArray(caseContract.assertions) ? caseContract.assertions : [];
  const inventory = {
    version: 'CaseContractSourceParityV1',
    stepCount: steps.length,
    actionCount: steps.filter((step) => !/^Assert/i.test(clean(step && step.type))).length,
    assertionCount: assertions.length,
    steps: steps.map((step) => ({
      id: clean(step && step.id) || null,
      type: clean(step && step.type) || null,
      sourceClauseRefs: sortedStrings(Array.isArray(step && step.sourceClauseRefs) ? step.sourceClauseRefs : []),
    })),
    assertions: assertions.map((assertion) => ({
      id: clean(assertion && assertion.id) || null,
      type: clean(assertion && assertion.type) || null,
      comparator: clean(assertion && assertion.comparator) || null,
      sourceClauseRefs: sortedStrings(Array.isArray(assertion && assertion.sourceClauseRefs) ? assertion.sourceClauseRefs : []),
    })),
  };
  return { ...inventory, digest: sha256(inventory) };
}

function stableCaseIdentity(pack, manifestItem) {
  return {
    sourceCaseId: clean(pack && (pack.caseContractId || pack.contractCaseId || pack.caseId || pack.id)) || null,
    coverageRef: coverageRefOf(pack),
    storyId: clean(pack && pack.storyId || manifestItem && manifestItem.storyRef && manifestItem.storyRef.id) || null,
    intent: clean(pack && (pack.intent || pack.pageIntent || pack.title)) || null,
    partition: pack && pack.behavioralPartition ? canonicalize(pack.behavioralPartition) : null,
  };
}

function buildCasePlan({ pack, manifestItem, datasetContext, alignments, requirementRevision, findings }) {
  const coverageRef = coverageRefOf(pack);
  const dataPlan = buildDataPlan({ pack, manifestItem, datasetContext, alignments, findings });
  const oracles = normalizeOracles(pack, dataPlan);
  const requirementLineage = requirementLineageFor(pack, manifestItem, requirementRevision);
  // Case-to-case dependencies are a different contract from the authored
  // step dependency graph. Never fall back to pack.stepDependencies here: those
  // entries contain step ids/flow metadata and are not durable TestCase ids.
  const dependencies = clone(pack && (pack.dependencies || pack.caseDependencies) || []);
  const failurePolicy = clone(pack && (pack.failurePolicy || pack.caseFailurePolicy) || {
    default: Array.isArray(dependencies) && dependencies.length
      ? 'block_dependents'
      : 'continue_independent',
  });
  const sourceParity = sourceParityFor(pack && pack.caseContractV1);
  const declaredCoverage = manifestItem && manifestItem.requiredCoverage;
  if (sourceParity && declaredCoverage && declaredCoverage.kind === 'case_contract_v1') {
    const mismatches = ['stepCount', 'actionCount', 'assertionCount']
      .filter((field) => declaredCoverage[field] !== undefined
        && Number(declaredCoverage[field]) !== sourceParity[field])
      .map((field) => ({ field, expected: sourceParity[field], actual: declaredCoverage[field] }));
    if (mismatches.length) findings.push({
      code: 'test_design_source_parity_mismatch',
      severity: 'error',
      coverageRef,
      caseId: clean(pack.caseContractV1 && pack.caseContractV1.id) || null,
      mismatches,
      detail: 'Declared coverage counts must equal the immutable CaseContractV1 inventory.',
    });
  }
  const casePlan = {
    planCaseId: `tdpc_${sha256(stableCaseIdentity(pack, manifestItem)).slice(0, 24)}`,
    caseRevision: null,
    coverageRef,
    storyId: clean(pack && pack.storyId || manifestItem && manifestItem.storyId || manifestItem && manifestItem.storyRef && manifestItem.storyRef.id) || null,
    requirementRefs: requirementLineage.requirementRefs,
    requirementRevisions: requirementLineage.requirementRevisions,
    intent: clean(pack && (pack.intent || pack.pageIntent || pack.title)) || coverageRef,
    module: clean(pack && pack.module || manifestItem && manifestItem.module || manifestItem && manifestItem.storyRef && manifestItem.storyRef.moduleHint) || null,
    initialState: clone(pack && pack.initialState || { description: null }),
    expectedFinalState: clone(pack && pack.expectedFinalState || { description: null }),
    sessionRequirement: sessionRequirementFor(pack),
    dependencies,
    failurePolicy,
    actionTopology: clone(pack && (pack.requiredActions || pack.actionTopology) || []),
    requiredFields: clone(pack && pack.requiredFields || []),
    caseContractV1: clone(pack && pack.caseContractV1 || null),
    sourceParity,
    dataPlan,
    oracles,
  };
  casePlan.caseRevision = sha256(caseSemanticProjection(casePlan));
  return casePlan;
}

function scenarioSemanticProjection(scenario) {
  return canonicalize({
    planScenarioId: scenario.planScenarioId,
    intent: scenario.intent,
    module: scenario.module,
    requirementRefs: scenario.requirementRefs,
    cases: scenario.cases,
  });
}

function planSemanticProjection(plan) {
  return canonicalize({
    version: plan.version,
    inputRevisions: plan.inputRevisions,
    scope: plan.scope,
    scenarios: plan.scenarios.map(scenarioSemanticProjection),
  });
}

function validateTestDesignPlanV1(plan) {
  const findings = [];
  if (!plan || typeof plan !== 'object') {
    return { ok: false, findings: [{ code: 'test_design_plan_missing', severity: 'error', detail: 'No plan was supplied.' }] };
  }
  if (plan.version !== VERSION) {
    findings.push({ code: 'test_design_plan_version_invalid', severity: 'error', expected: VERSION, actual: plan.version || null });
  }
  const scenarios = Array.isArray(plan.scenarios) ? plan.scenarios : [];
  if (!scenarios.length) findings.push({ code: 'test_design_plan_empty', severity: 'error', detail: 'At least one planned scenario is required.' });
  const scenarioIds = new Set();
  const caseIds = new Set();
  for (const scenario of scenarios) {
    if (!scenario || !scenario.planScenarioId) {
      findings.push({ code: 'test_design_scenario_id_missing', severity: 'error' });
      continue;
    }
    if (scenarioIds.has(scenario.planScenarioId)) findings.push({ code: 'test_design_scenario_id_duplicate', severity: 'error', planScenarioId: scenario.planScenarioId });
    scenarioIds.add(scenario.planScenarioId);
    for (const casePlan of Array.isArray(scenario.cases) ? scenario.cases : []) {
      if (!casePlan || !casePlan.planCaseId) {
        findings.push({ code: 'test_design_case_id_missing', severity: 'error', planScenarioId: scenario.planScenarioId });
        continue;
      }
      if (caseIds.has(casePlan.planCaseId)) findings.push({ code: 'test_design_case_id_duplicate', severity: 'error', planCaseId: casePlan.planCaseId });
      caseIds.add(casePlan.planCaseId);
      const expectedCaseRevision = sha256(caseSemanticProjection(casePlan));
      if (casePlan.caseRevision !== expectedCaseRevision) {
        findings.push({ code: 'test_design_case_revision_invalid', severity: 'error', planCaseId: casePlan.planCaseId, expected: expectedCaseRevision, actual: casePlan.caseRevision || null });
      }
      if (!casePlan.coverageRef) findings.push({ code: 'test_design_coverage_ref_missing', severity: 'error', planCaseId: casePlan.planCaseId });
      const expectedSourceParity = sourceParityFor(casePlan.caseContractV1);
      if (stableStringify(casePlan.sourceParity || null) !== stableStringify(expectedSourceParity)) {
        findings.push({
          code: 'test_design_source_parity_mismatch',
          severity: 'error',
          planCaseId: casePlan.planCaseId,
          expected: expectedSourceParity,
          actual: clone(casePlan.sourceParity || null),
        });
      }
      if (casePlan.dataPlan && casePlan.dataPlan.mode === 'matrix') {
        for (const field of ['testDataSetId', 'mappingId', 'mappingVersion', 'workbookHash', 'datasetRevisionId', 'sheetId', 'rowGroupId', 'sheet']) {
          if (casePlan.dataPlan[field] == null || casePlan.dataPlan[field] === '') {
            findings.push({ code: 'test_design_mapping_revision_missing', severity: 'error', planCaseId: casePlan.planCaseId, field });
          }
        }
        if (casePlan.dataPlan.approved !== true) findings.push({ code: 'test_design_data_unapproved', severity: 'error', planCaseId: casePlan.planCaseId });
      }
      if (casePlan.dataPlan && casePlan.dataPlan.mode === 'inline') {
        if (!casePlan.dataPlan.inlineRevision) {
          findings.push({ code: 'test_design_inline_revision_missing', severity: 'error', planCaseId: casePlan.planCaseId });
        }
        if (!Array.isArray(casePlan.dataPlan.bindings) || !casePlan.dataPlan.bindings.length) {
          findings.push({ code: 'test_design_inline_bindings_missing', severity: 'error', planCaseId: casePlan.planCaseId });
        }
        const inlineRows = Array.isArray(casePlan.dataPlan.rows) ? casePlan.dataPlan.rows : [];
        const inlineRowIds = Array.isArray(casePlan.dataPlan.rowIds) ? casePlan.dataPlan.rowIds.map((id) => clean(id)) : [];
        const rowIdsFromRows = inlineRows.map((row) => clean(row && row.id));
        if (!inlineRows.length) {
          findings.push({ code: 'test_design_inline_rows_missing', severity: 'error', planCaseId: casePlan.planCaseId });
        }
        if (rowIdsFromRows.some((id) => !id)) {
          findings.push({ code: 'test_design_inline_row_id_missing', severity: 'error', planCaseId: casePlan.planCaseId });
        }
        if (new Set(rowIdsFromRows.filter(Boolean)).size !== rowIdsFromRows.filter(Boolean).length) {
          findings.push({ code: 'test_design_inline_row_id_duplicate', severity: 'error', planCaseId: casePlan.planCaseId });
        }
        if (stableStringify(inlineRowIds) !== stableStringify(rowIdsFromRows)) {
          findings.push({
            code: 'test_design_inline_row_inventory_mismatch',
            severity: 'error',
            planCaseId: casePlan.planCaseId,
            expected: rowIdsFromRows,
            actual: inlineRowIds,
          });
        }
        const inlineTokens = (Array.isArray(casePlan.dataPlan.bindings) ? casePlan.dataPlan.bindings : [])
          .map((binding) => normalizeToken(binding && (binding.token || binding.dataRef)))
          .filter(Boolean);
        inlineRows.forEach((row) => {
          const rowBindings = row && row.bindings && typeof row.bindings === 'object' ? row.bindings : {};
          const missingTokens = inlineTokens.filter((token) => !Object.prototype.hasOwnProperty.call(rowBindings, token));
          if (missingTokens.length) {
            findings.push({
              code: 'test_design_inline_row_binding_missing',
              severity: 'error',
              planCaseId: casePlan.planCaseId,
              rowId: clean(row && row.id) || null,
              dataRefs: missingTokens.map((token) => `data.${token}`),
            });
          }
        });
        if (!casePlan.caseContractV1 || casePlan.caseContractV1.version !== 'CaseContractV1') {
          findings.push({ code: 'test_design_case_contract_missing', severity: 'error', planCaseId: casePlan.planCaseId });
        }
      }
    }
  }
  const expectedRevision = sha256(planSemanticProjection(plan));
  if (plan.revision !== expectedRevision) findings.push({ code: 'test_design_plan_revision_invalid', severity: 'error', expected: expectedRevision, actual: plan.revision || null });
  if (plan.planId !== `tdp_${expectedRevision.slice(0, 24)}`) findings.push({ code: 'test_design_plan_id_invalid', severity: 'error', actual: plan.planId || null });
  return { ok: findings.length === 0, findings };
}

function buildTestDesignPlanV1({
  coverageManifest = null,
  manifest = null,
  caseContractPacks = [],
  requirements = [],
  requirementClauses = [],
  dataset = null,
  testData = null,
  workbookContract = null,
  alignments = [],
  alignment = null,
  scope = {},
} = {}) {
  const coverage = parseObject(coverageManifest, null) || parseObject(manifest, {}) || {};
  const suppliedPacks = Array.isArray(caseContractPacks) ? caseContractPacks.filter(Boolean) : [];
  const packs = suppliedPacks.length ? suppliedPacks : derivePacksFromManifest(coverage);
  const items = manifestItems(coverage);
  const datasetContext = unwrapDataset(dataset, testData, workbookContract);
  const normalizedAlignments = normalizeAlignmentInput(alignment || alignments);
  const requirementRevision = normalizeRequirementInputs(requirements, requirementClauses);
  const findings = [];

  if (!packs.length) {
    findings.push({ code: 'test_design_case_contracts_missing', severity: 'error', detail: 'No CaseContractPack or required coverage item was supplied.' });
  }
  const plannedCases = [];
  for (const pack of packs) {
    const coverageRef = coverageRefOf(pack);
    if (!coverageRef) {
      findings.push({ code: 'test_design_coverage_ref_missing', severity: 'error', detail: 'Every CaseContractPack requires a coverageRef.' });
      continue;
    }
    const manifestItem = findManifestItem(pack, items);
    if (items.length && !manifestItem) {
      findings.push({ code: 'test_design_unknown_coverage_ref', severity: 'error', coverageRef, detail: 'The CaseContractPack does not resolve to the supplied coverage manifest.' });
    }
    plannedCases.push({
      pack,
      casePlan: buildCasePlan({
        pack,
        manifestItem,
        datasetContext,
        alignments: normalizedAlignments,
        requirementRevision,
        findings,
      }),
    });
  }
  const cases = plannedCases.map((entry) => entry.casePlan);

  const seenCases = new Set();
  for (const casePlan of cases) {
    if (seenCases.has(casePlan.planCaseId)) findings.push({ code: 'test_design_case_id_duplicate', severity: 'error', planCaseId: casePlan.planCaseId });
    seenCases.add(casePlan.planCaseId);
  }
  if (findings.some((finding) => finding.severity === 'error')) {
    throw new TestDesignPlanV1Error('TestDesignPlanV1 could not be built without guessing.', findings);
  }

  const scenarioGroups = new Map();
  for (const { pack, casePlan } of plannedCases) {
    const authoredScenario = pack && pack.authoredScenario && typeof pack.authoredScenario === 'object'
      ? pack.authoredScenario
      : null;
    const authoredScenarioId = clean(authoredScenario && authoredScenario.id);
    const groupKey = authoredScenarioId
      ? `authored:${authoredScenarioId}`
      : `case:${casePlan.planCaseId}`;
    if (!scenarioGroups.has(groupKey)) {
      scenarioGroups.set(groupKey, {
        authoredScenario,
        cases: [],
      });
    }
    scenarioGroups.get(groupKey).cases.push(casePlan);
  }
  const scenarios = Array.from(scenarioGroups.values()).map((group) => {
    const firstCase = group.cases[0];
    const authoredScenario = group.authoredScenario;
    const scenarioIdentity = authoredScenario
      ? {
        authoredScenarioId: clean(authoredScenario.id),
        authoredScenarioOrdinal: Number.isFinite(Number(authoredScenario.ordinal))
          ? Number(authoredScenario.ordinal)
          : null,
        caseIds: group.cases.map((casePlan) => casePlan.planCaseId),
      }
      : {
        coverageRef: firstCase.coverageRef,
        planCaseId: firstCase.planCaseId,
        intent: firstCase.intent,
      };
    return {
      planScenarioId: `tdps_${sha256(scenarioIdentity).slice(0, 24)}`,
      intent: clean(authoredScenario && authoredScenario.name) || firstCase.intent,
      module: firstCase.module,
      requirementRefs: unique(group.cases.flatMap((casePlan) => casePlan.requirementRefs || [])),
      cases: group.cases,
    };
  });
  const coverageSemantic = semanticManifest(coverage);
  const packsSemantic = semanticPacks(packs);
  const alignmentSemanticRows = normalizedAlignments.map(alignmentSemantic);
  const plan = {
    version: VERSION,
    planId: null,
    revision: null,
    inputRevisions: {
      requirements: requirementRevision,
      testData: datasetRevision(datasetContext, normalizedAlignments),
      coverage: {
        version: coverageSemantic.version,
        manifestItemIds: sortedStrings(items.map(coverageRefOf)),
        digest: sha256(coverageSemantic),
      },
      caseContractPacks: {
        count: packs.length,
        digest: sha256(packsSemantic),
      },
      alignment: {
        count: alignmentSemanticRows.length,
        digest: sha256(alignmentSemanticRows),
      },
    },
    scope: canonicalize(scope || {}, { stripVolatile: true }),
    scenarios,
  };
  plan.revision = sha256(planSemanticProjection(plan));
  plan.planId = `tdp_${plan.revision.slice(0, 24)}`;
  const validation = validateTestDesignPlanV1(plan);
  if (!validation.ok) throw new TestDesignPlanV1Error('Built TestDesignPlanV1 failed its deterministic integrity check.', validation.findings);
  return plan;
}

function renderTestDesignPlanV1(plan) {
  const validation = validateTestDesignPlanV1(plan);
  if (!validation.ok) throw new TestDesignPlanV1Error('Cannot render an invalid TestDesignPlanV1.', validation.findings);
  const lines = [
    `TEST DESIGN PLAN (AUTHORITATIVE) ${plan.planId} revision=${plan.revision}`,
    'Emit every planCaseId exactly once. Do not add, remove, merge, or rebind cases.',
    'Lineage, session, data bindings, and oracle channels are compiler-owned.',
  ];
  for (const scenario of plan.scenarios) {
    for (const casePlan of scenario.cases) {
      lines.push(`- planCaseId=${casePlan.planCaseId} coverageRef=${casePlan.coverageRef} storyId=${casePlan.storyId || 'none'} intent=${JSON.stringify(casePlan.intent)}`);
      lines.push(`  data=${casePlan.dataPlan.mode}${casePlan.dataPlan.sheet ? `:${casePlan.dataPlan.sheet}` : ''} tokens=${casePlan.dataPlan.allowedTokens.join(',') || 'none'}`);
      lines.push(`  oracles=${casePlan.oracles.map((oracle) => `${oracle.oracleRef}:${oracle.kind}`).join(',')}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  VERSION,
  PLAN_ERROR_CODE,
  TestDesignPlanV1Error,
  buildTestDesignPlanV1,
  buildTestDesignPlan: buildTestDesignPlanV1,
  validateTestDesignPlanV1,
  validateTestDesignPlan: validateTestDesignPlanV1,
  renderTestDesignPlanV1,
  renderTestDesignPlan: renderTestDesignPlanV1,
  stableStringify,
  sha256,
  caseSemanticProjection,
  planSemanticProjection,
  digestSensitiveLiteral,
  normalizeOracleKind,
  _private: {
    canonicalize,
    normalizeRequirementInputs,
    derivePacksFromManifest,
    unwrapDataset,
    datasetRevision,
    exactAlignmentCandidates,
    normalizeBindings,
    buildDataPlan,
    normalizeOracles,
    requirementLineageFor,
    legacyRequirementRefsFor,
  },
};
