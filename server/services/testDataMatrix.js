'use strict';

/**
 * TestData Round B — per-row (matrix) execution helpers. PURE: no I/O, no LLM,
 * no Prisma. Deterministic and fully unit-testable (scripts/verify_testdata.cjs
 * sections [4]/[5]) — which is the whole point: the fan-out and the value
 * substitution are mechanical, so they belong in Node, not a model call
 * (CLAUDE.md "Node unless genuine novelty").
 *
 * Two responsibilities:
 *   resolveCaseRows(tc, scenario, testData) → the list of data rows a case must
 *     execute against (one RunResult per row). Returns [] when the case is NOT
 *     data-driven, so the caller runs it exactly once, unchanged. A case is
 *     data-driven when it carries an explicit TestCase.dataBindingJson OR its
 *     scenario/module matches a binding in the project's TestDataSet mapping.
 *   substituteCase(tc, row) → a shallow clone of the case with the row's values
 *     substituted into {{token}} placeholders across steps, free-form
 *     assertions, and structured declaredAssertions, plus a DATA-DRIVEN
 *     ITERATION guidance block appended so the agent knows the concrete inputs
 *     + expected outcome for THIS row.
 *
 * Inputs come from Round A:
 *   testData = { sheets: [{ name, headers[], rows[] }], mapping } | null
 *   mapping  = { version, bindings: [{ sheet, scenarioName?, module?,
 *                columnToField:{role:header}, expectedColumn?, rowClassColumn? }],
 *                unmapped: [] }
 */

// A generous cap so a 5,000-row sheet can't detonate a run. Surfaced (not
// silent) by the conductor when it trims. Override per-env if a team really
// wants a bigger matrix.
const { recordDegradation } = require('../lib/degradationSignal');
const { isUntrustedPageName } = require('../lib/pageIdentity');
const { deriveCaseOracleIntent } = require('../lib/dataRowContract');
const inlineCaseInstanceContract = require('./inlineCaseInstanceContract');
const { analyzeSheetUsability } = require('./testDataSheetPolicy');

const MAX_ROWS_PER_CASE = Number(process.env.QAAI_MAX_DATA_ROWS_PER_CASE) || 50;

const ROUND_B_VERSION = 1;

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

function decode(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  if (typeof v !== 'string') return fallback;
  try {
    const parsed = JSON.parse(v);
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function fillTokensDeep(value, tokenMap) {
  if (typeof value === 'string') return fillTokens(value, tokenMap);
  if (Array.isArray(value)) return value.map((item) => fillTokensDeep(item, tokenMap));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = fillTokensDeep(val, tokenMap);
    return out;
  }
  return value;
}

function wholeStringToken(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  const key = m ? norm(m[1]) : '';
  return key || null;
}

function concreteInlineStepValue(step) {
  if (!step || typeof step !== 'object') return null;
  const candidates = [
    step.verify && step.verify.equals,
    step.verify && step.verify.value,
    step.operationCheck && step.operationCheck.actual,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (value && value.indexOf('{{') === -1) return value;
  }
  return null;
}

function bindingIsSyntheticCaseContractPack(binding) {
  if (!binding || typeof binding !== 'object') return false;
  const sheet = norm(binding.sheet || '');
  const status = norm(binding.mappingStatus || binding.status || binding.source || '');
  const compactStatus = status.replace(/[\s_-]+/g, '');
  return sheet === 'casecontractpack'
    && (!compactStatus || /needsmapping|proposed|proposedmapping|review|unversioned/.test(compactStatus));
}

function materializeInlineEvidenceTokens(tc) {
  if (!tc || typeof tc !== 'object') return { case: tc, replacements: [] };
  const stepsWasArray = Array.isArray(tc.steps);
  const stepsArr = stepsWasArray ? tc.steps : decode(tc.steps, null);
  if (!Array.isArray(stepsArr) || !stepsArr.length) return { case: tc, replacements: [] };

  let binding = null;
  try { binding = parseExplicitBinding(tc); } catch (_) { binding = null; }
  if (binding && !bindingIsSyntheticCaseContractPack(binding)) return { case: tc, replacements: [] };

  const tokenMap = {};
  for (const step of stepsArr) {
    if (!step || typeof step !== 'object') continue;
    const token = wholeStringToken(step.value);
    if (!token) continue;
    const inlineValue = concreteInlineStepValue(step);
    if (inlineValue == null) continue;
    tokenMap[token] = inlineValue;
  }
  const replacements = Object.keys(tokenMap).sort();
  if (!replacements.length) return { case: tc, replacements: [] };

  const clone = { ...tc };
  const inlineTokens = new Set(replacements);
  const approveInlineLineage = (lineage) => {
    if (!lineage || typeof lineage !== 'object') return lineage;
    const token = norm(lineage.token || lineage.columnName || '');
    if (!inlineTokens.has(token)) return lineage;
    return {
      ...lineage,
      sheetName: 'InlineText',
      rowIndex: 0,
      rowId: 'inline',
      columnName: lineage.columnName || token,
      token: lineage.token || token,
      mappingStatus: 'approved',
      mappingVersion: 'inline-text',
      source: 'inline_text',
    };
  };
  const materializedSteps = fillTokensDeep(stepsArr, tokenMap).map((step) => {
    if (!step || typeof step !== 'object') return step;
    const next = { ...step };
    if (Array.isArray(next.dataLineage)) next.dataLineage = next.dataLineage.map(approveInlineLineage);
    if (next.raw && typeof next.raw === 'object' && Array.isArray(next.raw.dataLineage)) {
      next.raw = { ...next.raw, dataLineage: next.raw.dataLineage.map(approveInlineLineage) };
    }
    return next;
  });
  clone.steps = stepsWasArray ? materializedSteps : JSON.stringify(materializedSteps);

  const daArr = decode(tc.declaredAssertions, null);
  if (Array.isArray(daArr)) clone.declaredAssertions = JSON.stringify(fillTokensDeep(daArr, tokenMap));
  if (typeof tc.assertions === 'string') clone.assertions = fillTokens(tc.assertions, tokenMap);
  if (Array.isArray(clone.dataLineage)) clone.dataLineage = clone.dataLineage.map(approveInlineLineage);

  if (bindingIsSyntheticCaseContractPack(binding) && findUnresolvedTokens(clone).length === 0) {
    clone.dataBindingJson = null;
    clone.dataBinding = null;
    clone.rowExecutionPlanJson = null;
    clone.rowExecutionPlan = null;
    clone.skippedRowsJson = null;
    clone.skippedRows = null;
  }

  return { case: clone, replacements };
}

function hasRefValue(value) {
  return value != null && String(value).trim() !== '';
}

function datasetIdOf(value) {
  return value && (value.testDataSetId || value.datasetId) || null;
}

function safeSheetCandidate(sheet) {
  return {
    testDataSetId: datasetIdOf(sheet),
    datasetRevisionId: sheet && sheet.datasetRevisionId || null,
    sheetId: sheet && sheet.sheetId || null,
    sheet: sheet && sheet.name || null,
  };
}

function testDataInvalid(code, message, evidence = []) {
  return {
    code,
    blockedReason: 'test_data_invalid',
    message,
    evidence: Array.isArray(evidence) ? evidence : [evidence],
  };
}

// Name-only lookup remains available for companion joins, but a duplicate name
// is NEVER resolved by array order.  The strict primary resolver below returns
// the candidate evidence needed to block the case honestly.
function findSheet(sheets, name) {
  if (!Array.isArray(sheets) || !name) return null;
  const want = norm(name);
  const matches = sheets.filter((s) => s && norm(s.name) === want);
  return matches.length === 1 ? matches[0] : null;
}

function sheetsFromTestData(testData) {
  if (!testData) return [];
  if (Array.isArray(testData)) return testData;
  if (Array.isArray(testData.sheets)) return testData.sheets;
  if (testData.sheets && Array.isArray(testData.sheets.sheets)) return testData.sheets.sheets;
  return [];
}

function mappingFromTestData(testData) {
  if (!testData || typeof testData !== 'object') return null;
  if (testData.mapping && typeof testData.mapping === 'object') return testData.mapping;
  if (testData.sheets && testData.sheets.mapping && typeof testData.sheets.mapping === 'object') return testData.sheets.mapping;
  return null;
}

// Find the mapping binding for a case by scenario name, then module. Used both
// to derive an implicit binding (no dataBindingJson) and to hydrate a bare
// explicit { sheet } binding with columnToField/expected/rowClass.
function mappingBindingFor(tc, scenario, mapping, sheetName = null) {
  const bindings = (mapping && Array.isArray(mapping.bindings)) ? mapping.bindings : [];
  if (!bindings.length) return null;
  if (sheetName) {
    const bySheet = bindings.filter((b) => b && norm(b.sheet) === norm(sheetName));
    if (bySheet.length) return bySheet.length === 1 ? bySheet[0] : null;
  }
  const scnName = norm(scenario && scenario.name);
  const mod = norm((tc && tc.module) || (scenario && scenario.module));
  if (scnName) {
    const byScn = bindings.filter((b) => b && norm(b.scenarioName) === scnName);
    if (byScn.length) return byScn.length === 1 ? byScn[0] : null;
  }
  if (mod) {
    const byMod = bindings.filter((b) => b && norm(b.module) === mod);
    if (byMod.length) return byMod.length === 1 ? byMod[0] : null;
  }
  return null;
}

function parseExplicitBinding(tc) {
  const raw = tc && (tc.dataBindingJson != null ? tc.dataBindingJson : tc.dataBinding);
  let b = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try {
      b = JSON.parse(raw);
    } catch (_) {
      return {
        status: 'incomplete',
        findings: [{ code: 'data_binding_json_invalid', detail: 'Case dataBindingJson is not valid JSON.' }],
      };
    }
  }
  if (!b || typeof b !== 'object') return null;
  if (Array.isArray(b)) {
    return {
      status: 'incomplete',
      findings: [{ code: 'data_binding_json_shape_invalid', detail: 'Case dataBindingJson must contain an object.' }],
    };
  }
  // Inline CaseContract values are materialized from deterministic step
  // evidence, not resolved through the external DatasetContract ledger.
  if (norm(b.mode) === 'inline' && norm(b.status) !== 'incomplete') return null;
  // Any non-empty case-level binding is an authored data contract. Keep an
  // incomplete/malformed object visible so validation fails closed; only the
  // legacy empty object remains equivalent to a truly data-free case.
  if (!Object.keys(b).length) return null;
  return b;
}

function cloneJsonValue(value) {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]));
  }
  return value;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseStrictObject(raw) {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return { status: 'absent', value: null };
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (_) {
      return { status: 'invalid', value: null };
    }
  }
  return isRecord(value)
    ? { status: 'resolved', value }
    : { status: 'invalid', value: null };
}

function inlineResolutionDefect(code, message, evidence = []) {
  return {
    status: 'invalid',
    rows: [],
    defect: testDataInvalid(code, message, evidence),
  };
}

function exactStringArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string' && entry.trim() === entry && entry.length > 0);
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function unresolvedProjectionTokens(value) {
  const found = new Set();
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  const scan = (entry) => {
    if (typeof entry === 'string') {
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(entry))) {
        const token = String(match[1] || '').trim();
        if (token) found.add(token);
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) scan(child);
      return;
    }
    if (entry && typeof entry === 'object') {
      for (const child of Object.values(entry)) scan(child);
    }
  };
  scan(value);
  return [...found].sort();
}

function runtimeInputsFromPublicBindings(publicBindings) {
  return Object.fromEntries(Object.entries(publicBindings || {}).map(([token, binding]) => {
    if (binding && binding.kind === 'inline' && Object.prototype.hasOwnProperty.call(binding, 'value')) {
      return [token, cloneJsonValue(binding.value)];
    }
    return [token, cloneJsonValue(binding)];
  }));
}

/**
 * Resolve compiler-owned inline CaseContract rows before consulting external
 * workbook mappings. Inline execution is deliberately strict: the persisted
 * logical TestCase is only a container; every browser execution must select an
 * exact, revision-pinned instance and its already-literal executable projection.
 */
function resolveInlineCaseRows(tc) {
  if (!tc || typeof tc !== 'object') return { status: 'not_inline', rows: [], defect: null };

  const bindingParsed = parseStrictObject(tc.dataBindingJson != null ? tc.dataBindingJson : tc.dataBinding);
  const planParsed = parseStrictObject(tc.rowExecutionPlanJson != null ? tc.rowExecutionPlanJson : tc.rowExecutionPlan);
  const bindingMode = bindingParsed.status === 'resolved' ? norm(bindingParsed.value.mode) : '';
  const planMode = planParsed.status === 'resolved' ? norm(planParsed.value.mode) : '';
  const inlineHint = bindingMode === 'inline' || planMode === 'inline';
  if (!inlineHint) return { status: 'not_inline', rows: [], defect: null };

  if (bindingParsed.status !== 'resolved' || bindingMode !== 'inline') {
    return inlineResolutionDefect(
      'inline_data_binding_missing_or_invalid',
      'Inline execution requires a valid compiler-owned inline data binding; QAAI refused to infer one at runtime.',
    );
  }
  if (planParsed.status !== 'resolved' || planMode !== 'inline') {
    return inlineResolutionDefect(
      'inline_row_execution_plan_missing_or_invalid',
      'Inline execution requires a valid compiler-owned row execution plan; QAAI refused to run an unpinned literal instance.',
    );
  }

  const binding = bindingParsed.value;
  const plan = planParsed.value;
  const planCaseId = typeof binding.planCaseId === 'string' ? binding.planCaseId.trim() : '';
  if (!planCaseId || binding.planCaseId !== planCaseId) {
    return inlineResolutionDefect(
      'inline_plan_case_id_missing_or_invalid',
      'Inline execution requires the exact compiler-owned planCaseId from its data binding.',
    );
  }
  const persistedCaseScopeId = typeof tc.caseScopeId === 'string' ? tc.caseScopeId.trim() : '';
  if (persistedCaseScopeId && persistedCaseScopeId !== planCaseId) {
    return inlineResolutionDefect(
      'inline_case_scope_mismatch',
      'The inline instance plan belongs to a different canonical case scope and cannot supply values to this case.',
      [{ caseScopeId: persistedCaseScopeId, planCaseId }],
    );
  }
  const inlineRevision = typeof plan.inlineRevision === 'string' ? plan.inlineRevision.trim() : '';
  const bindingRevision = typeof binding.inlineRevision === 'string' ? binding.inlineRevision.trim() : '';
  const dataBindingId = typeof plan.dataBindingId === 'string' ? plan.dataBindingId.trim() : '';
  if (!inlineRevision || !bindingRevision || !dataBindingId
      || plan.inlineRevision !== inlineRevision
      || binding.inlineRevision !== bindingRevision
      || plan.dataBindingId !== dataBindingId
      || inlineRevision !== bindingRevision || dataBindingId !== inlineRevision) {
    return inlineResolutionDefect(
      'inline_revision_mismatch',
      'Inline data and row execution revisions are missing or do not match exactly; QAAI refused to mix compiled instances.',
      [{ hasPlanRevision: !!inlineRevision, hasBindingRevision: !!bindingRevision, hasDataBindingId: !!dataBindingId }],
    );
  }

  const executionMode = norm(plan.executionMode);
  if (!['single', 'per_row'].includes(executionMode)) {
    return inlineResolutionDefect(
      'inline_execution_mode_invalid',
      'Inline row executionMode must be "single" or "per_row".',
      [{ executionMode: plan.executionMode == null ? null : String(plan.executionMode) }],
    );
  }
  if (!exactStringArray(plan.rowIds) || !exactStringArray(binding.rowIds)) {
    return inlineResolutionDefect(
      'inline_row_ids_missing_or_invalid',
      'Inline execution requires non-empty, exact string row IDs in both the data binding and row plan.',
    );
  }
  if (!sameStringArray(plan.rowIds, binding.rowIds)) {
    return inlineResolutionDefect(
      'inline_row_ids_mismatch',
      'Inline data-binding row IDs and execution-plan row IDs differ; QAAI refused to select by array position.',
      [{ plannedRowIds: [...plan.rowIds], boundRowIds: [...binding.rowIds] }],
    );
  }
  if (new Set(plan.rowIds).size !== plan.rowIds.length) {
    return inlineResolutionDefect(
      'inline_row_ids_duplicate',
      'Inline row IDs must be unique; duplicate identities cannot be selected deterministically.',
      [{ rowIds: [...plan.rowIds] }],
    );
  }
  if ((executionMode === 'single' && plan.rowIds.length !== 1)
      || (executionMode === 'per_row' && plan.rowIds.length < 2)) {
    return inlineResolutionDefect(
      'inline_execution_mode_row_count_mismatch',
      'Inline executionMode does not match the exact number of planned rows.',
      [{ executionMode, rowCount: plan.rowIds.length }],
    );
  }
  if (plan.rowIds.length > MAX_ROWS_PER_CASE) {
    return inlineResolutionDefect(
      'inline_row_cap_exceeded',
      `Inline execution pins ${plan.rowIds.length} exact rows, exceeding the safe runtime limit of ${MAX_ROWS_PER_CASE}; QAAI refused to truncate the compiled row set.`,
      [{ requested: plan.rowIds.length, limit: MAX_ROWS_PER_CASE }],
    );
  }
  if (!Array.isArray(plan.instances) || plan.instances.length !== plan.rowIds.length) {
    return inlineResolutionDefect(
      'inline_instance_inventory_mismatch',
      'Inline row execution requires exactly one compiled instance for every planned row ID.',
      [{ rowCount: plan.rowIds.length, instanceCount: Array.isArray(plan.instances) ? plan.instances.length : null }],
    );
  }
  if (typeof plan.defaultInstanceId !== 'string' || !plan.defaultInstanceId.trim()) {
    return inlineResolutionDefect(
      'inline_default_instance_missing',
      'Inline execution requires one exact defaultInstanceId.',
    );
  }

  const byRowId = new Map();
  const instancePlanIds = new Set();
  for (const instance of plan.instances) {
    if (!isRecord(instance)) {
      return inlineResolutionDefect('inline_instance_shape_invalid', 'Every inline instance must be an object.');
    }
    const rowId = instance.rowId;
    const instancePlanId = instance.instancePlanId;
    const instanceRevision = instance.instanceRevision;
    if (typeof rowId !== 'string' || !rowId || rowId.trim() !== rowId
        || typeof instancePlanId !== 'string' || !instancePlanId || instancePlanId.trim() !== instancePlanId
        || typeof instanceRevision !== 'string' || !instanceRevision || instanceRevision.trim() !== instanceRevision) {
      return inlineResolutionDefect(
        'inline_instance_identity_invalid',
        'Every inline instance requires exact rowId, instancePlanId, and instanceRevision strings.',
      );
    }
    if (byRowId.has(rowId) || instancePlanIds.has(instancePlanId)) {
      return inlineResolutionDefect(
        'inline_instance_identity_duplicate',
        'Inline rowId and instancePlanId values must each be unique.',
        [{ rowId, instancePlanId }],
      );
    }
    if (!Number.isInteger(instance.ordinal) || instance.ordinal < 1) {
      return inlineResolutionDefect(
        'inline_instance_ordinal_invalid',
        'Every inline instance requires a positive integer ordinal.',
        [{ rowId }],
      );
    }
    if (!isRecord(instance.inputs) || !isRecord(instance.publicBindings)) {
      return inlineResolutionDefect(
        'inline_instance_bindings_invalid',
        'Every inline instance requires object-shaped raw inputs and publicBindings.',
        [{ rowId }],
      );
    }
    const inputKeys = Object.keys(instance.inputs).sort();
    const publicKeys = Object.keys(instance.publicBindings).sort();
    if (!sameStringArray(inputKeys, publicKeys)) {
      return inlineResolutionDefect(
        'inline_instance_binding_keys_mismatch',
        'Inline raw inputs and public bindings must identify the same exact token keys.',
        [{ rowId, inputKeys, publicKeys }],
      );
    }

    const projection = instance.executableProjection;
    const projectionKeys = ['name', 'assertions', 'operations', 'oracles', 'declaredAssertions', 'steps'];
    const projectionShapeValid = isRecord(projection)
      && projectionKeys.every((key) => Object.prototype.hasOwnProperty.call(projection, key))
      && Array.isArray(projection.steps);
    if (!projectionShapeValid) {
      return inlineResolutionDefect(
        'inline_executable_projection_invalid',
        'Every inline instance requires name, assertions, operations, oracles, declaredAssertions, and array-shaped steps in its executable projection.',
        [{ rowId }],
      );
    }
    const unresolved = unresolvedProjectionTokens(projection);
    if (unresolved.length) {
      return inlineResolutionDefect(
        'inline_executable_projection_unresolved',
        'An inline executable projection still contains template tokens; QAAI refused runtime substitution or guessing.',
        [{ rowId, tokens: unresolved }],
      );
    }
    const expectedInstancePlanId = inlineCaseInstanceContract.instancePlanId({
      planCaseId,
      inlineRevision,
      rowId,
    });
    if (instancePlanId !== expectedInstancePlanId) {
      return inlineResolutionDefect(
        'inline_instance_plan_id_mismatch',
        'An inline instancePlanId does not match its compiler-owned case, revision, and row identity.',
        [{ rowId, expectedInstancePlanId, actualInstancePlanId: instancePlanId }],
      );
    }
    const expectedInstanceRevision = inlineCaseInstanceContract.instanceRevision({
      instancePlanId,
      planCaseId,
      inlineRevision,
      rowId,
      ordinal: instance.ordinal,
      executableProjection: projection,
    });
    if (instanceRevision !== expectedInstanceRevision) {
      return inlineResolutionDefect(
        'inline_instance_revision_mismatch',
        'An inline executable projection does not match its compiler-owned instance revision.',
        [{ rowId, expectedInstanceRevision, actualInstanceRevision: instanceRevision }],
      );
    }
    byRowId.set(rowId, instance);
    instancePlanIds.add(instancePlanId);
  }

  const defaultMatches = plan.instances.filter((instance) => instance.instancePlanId === plan.defaultInstanceId);
  if (defaultMatches.length !== 1) {
    return inlineResolutionDefect(
      'inline_default_instance_not_found',
      'defaultInstanceId must select exactly one compiled inline instance.',
      [{ defaultInstanceId: plan.defaultInstanceId }],
    );
  }
  const firstPlannedInstance = byRowId.get(plan.rowIds[0]);
  if (!firstPlannedInstance || plan.defaultInstanceId !== firstPlannedInstance.instancePlanId) {
    return inlineResolutionDefect(
      'inline_default_instance_order_mismatch',
      'defaultInstanceId must identify the first authored row projection used by the flat compatibility TestCase.',
      [{ defaultInstanceId: plan.defaultInstanceId, firstRowId: plan.rowIds[0] }],
    );
  }

  const rows = [];
  for (const [index, rowId] of plan.rowIds.entries()) {
    const instance = byRowId.get(rowId);
    if (!instance) {
      return inlineResolutionDefect(
        'inline_planned_row_instance_missing',
        'A planned inline row ID has no exact compiled instance.',
        [{ rowId }],
      );
    }
    if (instance.ordinal !== index + 1) {
      return inlineResolutionDefect(
        'inline_instance_ordinal_mismatch',
        'Inline instance ordinals must exactly match authored rowIds order.',
        [{ rowId, expectedOrdinal: index + 1, actualOrdinal: instance.ordinal }],
      );
    }
    rows.push({
      index,
      rowId,
      ordinal: instance.ordinal,
      instancePlanId: instance.instancePlanId,
      instanceRevision: instance.instanceRevision,
      inlineRevision,
      planCaseId,
      caseScopeId: persistedCaseScopeId || planCaseId,
      defaultInstanceId: plan.defaultInstanceId,
      inlineInstance: true,
      setName: 'InlineText',
      sheet: null,
      label: `Row ${instance.ordinal}`,
      // The executable projection already contains the exact authored literals.
      // Runtime metadata uses the public binding view so WebSocket, reports, and
      // active CaseInstance evidence never expose a sensitive raw input again.
      inputs: runtimeInputsFromPublicBindings(instance.publicBindings),
      publicBindings: cloneJsonValue(instance.publicBindings),
      executableProjection: cloneJsonValue(instance.executableProjection),
      expected: null,
      rowClass: null,
      expectedColumn: null,
      rowClassColumn: null,
      // Conductor's existing profile scheduler consumes raw.profileKey. Give
      // each compiler-owned inline instance a unique generic identity so two
      // credential rows cannot reuse row 1's authenticated session or have row
      // 2's login prelude stripped as a same-profile optimization.
      raw: { profileKey: `inline_${instance.instancePlanId}` },
      // Conductor already transports `evidenceContract` intact when it rebuilds
      // its active dataRow. For inline rows this is identity metadata only (the
      // row-evidence verdict builder ignores this object and derives external
      // matrix evidence from row fields), which preserves exact revisions across
      // the legacy bridge without adding fake workbook columns.
      evidenceContract: {
        kind: 'inline_case_instance_v1',
        rowId,
        ordinal: instance.ordinal,
        instancePlanId: instance.instancePlanId,
        instanceRevision: instance.instanceRevision,
        inlineRevision,
        planCaseId,
        caseScopeId: persistedCaseScopeId || planCaseId,
        defaultInstanceId: plan.defaultInstanceId,
        publicBindings: cloneJsonValue(instance.publicBindings),
      },
      dataBindingRef: {
        mode: 'inline',
        rowId,
        instancePlanId: instance.instancePlanId,
        instanceRevision: instance.instanceRevision,
        inlineRevision,
        planCaseId,
        caseScopeId: persistedCaseScopeId || planCaseId,
      },
    });
  }
  return { status: 'resolved', rows, defect: null };
}

function preserveJsonSurface(originalValue, projectedValue) {
  const cloned = cloneJsonValue(projectedValue);
  return typeof originalValue === 'string' ? JSON.stringify(cloned) : cloned;
}

function materializeInlineCaseInstance(tc, row) {
  if (!tc || !row || row.inlineInstance !== true || !isRecord(row.executableProjection)) return tc;
  const projection = row.executableProjection;
  return {
    ...tc,
    name: projection.name,
    assertions: projection.assertions,
    operations: cloneJsonValue(projection.operations),
    operationsJson: JSON.stringify(cloneJsonValue(projection.operations)),
    oracles: cloneJsonValue(projection.oracles),
    declaredAssertions: preserveJsonSurface(tc.declaredAssertions, projection.declaredAssertions),
    steps: preserveJsonSurface(tc.steps, projection.steps),
  };
}

// Merge an explicit binding with the mapping's column info for its sheet, so a
// minimal { sheet } binding is enough — the run fills the rest from Round A.
function hydrateBinding(binding, tc, scenario, mapping, exactMappingBinding) {
  if (!binding) return null;
  const fromMap = arguments.length >= 5
    ? exactMappingBinding
    : mappingBindingFor(tc, scenario, mapping, binding.sheet);
  // Spread the ORIGINAL binding first so Architect-emitted fields the normaliser
  // below does not list — notably `companions` (the credential/identity join),
  // `storyColumn`/`storyId` (story-row filtering), `placeholders`, `matchKind` —
  // survive hydration. Previously this returned only the 7 normalised fields, so
  // the credential companion + storyColumn were silently dropped and a login step's
  // {{username}}/{{password}} tokens could never resolve (row blocked pre-browser).
  return {
    ...(fromMap || {}),
    ...binding,
    sheet: binding.sheet || (fromMap && fromMap.sheet) || null,
    sheetId: binding.sheetId || (fromMap && fromMap.sheetId) || null,
    testDataSetId: binding.testDataSetId || binding.datasetId
      || (fromMap && (fromMap.testDataSetId || fromMap.datasetId)) || null,
    datasetId: binding.datasetId || binding.testDataSetId
      || (fromMap && (fromMap.datasetId || fromMap.testDataSetId)) || null,
    datasetRevisionId: binding.datasetRevisionId || (fromMap && fromMap.datasetRevisionId) || null,
    mappingId: binding.mappingId || (fromMap && fromMap.mappingId) || null,
    mappingVersion: binding.mappingVersion != null
      ? binding.mappingVersion
      : (fromMap && fromMap.mappingVersion != null ? fromMap.mappingVersion : null),
    rowSelector: binding.rowSelector || 'all',
    rowIds: Array.isArray(binding.rowIds)
      ? [...binding.rowIds]
      : (fromMap && Array.isArray(fromMap.rowIds) ? [...fromMap.rowIds] : []),
    columnToField: binding.columnToField || (fromMap && fromMap.columnToField) || {},
    expectedColumn: binding.expectedColumn || (fromMap && fromMap.expectedColumn) || null,
    rowClassColumn: binding.rowClassColumn || (fromMap && fromMap.rowClassColumn) || null,
    joins: binding.joins || binding.foreignKeyJoins || (fromMap && (fromMap.joins || fromMap.foreignKeyJoins)) || null,
    status: binding.status || (fromMap && fromMap.status) || null,
  };
}

function sourceForMappingBinding(binding, mapping) {
  if (!binding || !mapping) return null;
  const sources = Array.isArray(mapping.sources) ? mapping.sources : [];
  const datasetId = datasetIdOf(binding);
  const candidates = datasetId
    ? sources.filter((source) => datasetIdOf(source) === datasetId)
    : sources;
  return candidates.length === 1 ? candidates[0] : null;
}

function mappingCandidate(binding, mapping) {
  const source = sourceForMappingBinding(binding, mapping);
  return {
    ...binding,
    testDataSetId: binding.testDataSetId || binding.datasetId
      || (source && (source.testDataSetId || source.datasetId)) || null,
    datasetId: binding.datasetId || binding.testDataSetId
      || (source && (source.datasetId || source.testDataSetId)) || null,
    mappingId: binding.mappingId || (source && source.mappingId)
      || (Array.isArray(mapping.sources) && mapping.sources.length > 1 ? null : (mapping.mappingId || mapping.id)) || null,
    mappingVersion: binding.mappingVersion != null
      ? binding.mappingVersion
      : (source && (source.mappingVersion != null ? source.mappingVersion : source.version)) || null,
  };
}

function mappingEvidence(binding) {
  return {
    mappingId: binding && binding.mappingId || null,
    testDataSetId: datasetIdOf(binding),
    datasetRevisionId: binding && binding.datasetRevisionId || null,
    sheetId: binding && binding.sheetId || null,
    sheet: binding && binding.sheet || null,
  };
}

function resolveMappingBindingStrict(mapping, reference, resolvedSheet = null) {
  const rawBindings = mapping && Array.isArray(mapping.bindings) ? mapping.bindings : [];
  const candidates = rawBindings.map((binding) => mappingCandidate(binding, mapping));
  if (!candidates.length) return { status: 'missing', binding: null, candidates: [] };

  const ref = reference || {};
  const exact = {
    mappingId: ref.mappingId || null,
    testDataSetId: ref.testDataSetId || ref.datasetId
      || datasetIdOf(resolvedSheet) || null,
    datasetRevisionId: ref.datasetRevisionId || (resolvedSheet && resolvedSheet.datasetRevisionId) || null,
    sheetId: ref.sheetId || (resolvedSheet && resolvedSheet.sheetId) || null,
  };
  let matches = candidates;
  if (hasRefValue(exact.mappingId)) matches = matches.filter((item) => item.mappingId === exact.mappingId);
  if (hasRefValue(exact.testDataSetId)) matches = matches.filter((item) => datasetIdOf(item) === exact.testDataSetId);
  if (hasRefValue(exact.datasetRevisionId)) matches = matches.filter((item) => item.datasetRevisionId === exact.datasetRevisionId);
  if (hasRefValue(exact.sheetId)) matches = matches.filter((item) => item.sheetId === exact.sheetId);

  // An immutable sheetId is authoritative even if its old display name changed.
  // Otherwise use the name only within the already-pinned dataset/revision pool.
  const sheetName = ref.sheet || (resolvedSheet && resolvedSheet.name) || null;
  if (!hasRefValue(exact.sheetId) && hasRefValue(sheetName)) {
    matches = matches.filter((item) => norm(item.sheet) === norm(sheetName));
  }
  if (matches.length === 1) return { status: 'resolved', binding: matches[0], candidates: [] };
  return {
    status: matches.length ? 'ambiguous' : 'missing',
    binding: null,
    candidates: matches.map(mappingEvidence),
  };
}

function resolveSheetStrict(sheets, reference) {
  const ref = reference || {};
  let matches = Array.isArray(sheets) ? sheets.filter(Boolean) : [];
  const exactDatasetId = ref.testDataSetId || ref.datasetId || null;
  if (hasRefValue(exactDatasetId)) matches = matches.filter((sheet) => datasetIdOf(sheet) === exactDatasetId);
  if (hasRefValue(ref.datasetRevisionId)) matches = matches.filter((sheet) => sheet.datasetRevisionId === ref.datasetRevisionId);
  if (hasRefValue(ref.sheetId)) matches = matches.filter((sheet) => sheet.sheetId === ref.sheetId);
  else if (hasRefValue(ref.sheet)) matches = matches.filter((sheet) => norm(sheet.name) === norm(ref.sheet));
  else return { status: 'missing', sheet: null, candidates: [] };

  if (matches.length === 1) return { status: 'resolved', sheet: matches[0], candidates: [] };
  return {
    status: matches.length ? 'ambiguous' : 'missing',
    sheet: null,
    candidates: matches.map(safeSheetCandidate),
  };
}

function resolutionDefect(kind, binding, candidates = []) {
  const label = binding && (binding.sheet || binding.sheetId) || '(unnamed sheet)';
  if (kind === 'sheet_ambiguous') {
    return testDataInvalid(
      'data_binding_sheet_ambiguous',
      `Test-data binding reference "${label}" matches multiple uploaded sheets; exact datasetRevisionId, testDataSetId, and sheetId pins are required.`,
      candidates,
    );
  }
  if (kind === 'sheet_missing') {
    return testDataInvalid(
      'data_binding_sheet_not_found',
      `Test-data binding reference "${label}" does not match the exact pinned dataset revision and sheet.`,
      candidates,
    );
  }
  if (kind === 'mapping_ambiguous') {
    return testDataInvalid(
      'data_binding_mapping_ambiguous',
      `Test-data binding for "${label}" matches multiple mapping revisions; an exact mappingId pin is required.`,
      candidates,
    );
  }
  return testDataInvalid(
    'data_binding_mapping_not_found',
    `Test-data binding for "${label}" does not match the exact mappingId pin.`,
    candidates,
  );
}

/**
 * Resolve the one immutable sheet + mapping used at runtime. IDs are applied
 * conjunctively before a display name is considered; an unsatisfied pin never
 * falls back to a newer dataset, another mapping, or the first same-name sheet.
 */
function resolveCaseDataSource(tc, scenario, testData) {
  const explicit = parseExplicitBinding(tc);
  if (!explicit) return { status: 'unbound', binding: null, sheet: null, mappingBinding: null, defect: null };
  const caseScope = inlineCaseInstanceContract.caseScopeId(tc || {});
  const bindingScope = inlineCaseInstanceContract.caseScopeId(explicit);
  if (caseScope && bindingScope && caseScope !== bindingScope) {
    return {
      status: 'invalid', binding: explicit, sheet: null, mappingBinding: null,
      defect: testDataInvalid(
        'data_binding_case_scope_mismatch',
        'The test-data binding belongs to a different canonical case and cannot supply values to this case.',
        [{ caseScopeId: caseScope, bindingCaseScopeId: bindingScope }],
      ),
    };
  }
  if (testData && testData.pinValidationError) {
    return {
      status: 'invalid',
      binding: explicit,
      sheet: null,
      mappingBinding: null,
      defect: testDataInvalid(
        testData.pinValidationError.code || 'pinned_test_data_unavailable',
        `The exact approved test-data revision for "${tc && tc.name ? tc.name : 'test case'}" is unavailable; QAAI refused to substitute a newer mapping or workbook. ${testData.pinValidationError.message || ''}`.trim(),
        testData.pinValidationError.findings || [],
      ),
    };
  }

  const sheets = sheetsFromTestData(testData);
  const mapping = mappingFromTestData(testData);
  let mappingResolution = null;
  let binding = { ...explicit };

  // mappingId can itself locate the immutable mapping and supply sheetId/name.
  if (hasRefValue(binding.mappingId)) {
    mappingResolution = resolveMappingBindingStrict(mapping, binding);
    if (mappingResolution.status !== 'resolved') {
      return {
        status: 'invalid', binding, sheet: null, mappingBinding: null,
        defect: resolutionDefect(`mapping_${mappingResolution.status}`, binding, mappingResolution.candidates),
      };
    }
    binding = hydrateBinding(binding, tc, scenario, mapping, mappingResolution.binding);
  }

  const sheetResolution = resolveSheetStrict(sheets, binding);
  if (sheetResolution.status !== 'resolved') {
    return {
      status: 'invalid', binding, sheet: null, mappingBinding: mappingResolution && mappingResolution.binding,
      defect: resolutionDefect(`sheet_${sheetResolution.status}`, binding, sheetResolution.candidates),
    };
  }
  const sheet = sheetResolution.sheet;

  if (!mappingResolution) {
    mappingResolution = resolveMappingBindingStrict(mapping, binding, sheet);
    if (mappingResolution.status === 'ambiguous') {
      return {
        status: 'invalid', binding, sheet, mappingBinding: null,
        defect: resolutionDefect('mapping_ambiguous', binding, mappingResolution.candidates),
      };
    }
    if (mappingResolution.status === 'missing' && hasRefValue(binding.mappingId)) {
      return {
        status: 'invalid', binding, sheet, mappingBinding: null,
        defect: resolutionDefect('mapping_missing', binding, mappingResolution.candidates),
      };
    }
  }

  binding = hydrateBinding(
    binding,
    tc,
    scenario,
    mapping,
    mappingResolution && mappingResolution.status === 'resolved' ? mappingResolution.binding : null,
  );
  // Fill absent metadata from the selected immutable source, but never replace
  // an authored pin.  The strict filters above proved every supplied pin equal.
  binding = {
    ...binding,
    sheet: binding.sheet || sheet.name,
    sheetId: binding.sheetId || sheet.sheetId || null,
    testDataSetId: binding.testDataSetId || datasetIdOf(sheet) || null,
    datasetId: binding.datasetId || datasetIdOf(sheet) || null,
    datasetRevisionId: binding.datasetRevisionId || sheet.datasetRevisionId || null,
    caseScopeId: bindingScope || caseScope || null,
  };
  const mappedHeaders = [
    ...Object.values(binding.columnToField || {}),
    binding.expectedColumn,
    binding.rowClassColumn,
  ].filter((header) => header != null && String(header).trim());
  const usability = analyzeSheetUsability(sheet, mappedHeaders);
  if (!usability.usable) {
    return {
      status: 'invalid', binding, sheet, mappingBinding: mappingResolution && mappingResolution.binding,
      defect: testDataInvalid(
        'data_binding_sheet_not_usable',
        `Test-data binding for "${binding.sheet}" has no usable row for its mapped columns.`,
        [{ reason: usability.reason, sourceRowCount: usability.sourceRowCount, usableRowCount: usability.usableRowCount }],
      ),
    };
  }
  return {
    status: 'resolved',
    binding,
    sheet,
    mappingBinding: mappingResolution && mappingResolution.status === 'resolved' ? mappingResolution.binding : null,
    defect: null,
  };
}

function filterRowsByCaseScope(rows, tc, binding = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const caseScope = inlineCaseInstanceContract.caseScopeId(tc || {}) || inlineCaseInstanceContract.caseScopeId(binding);
  const rowScope = (row) => inlineCaseInstanceContract.caseScopeId({
    caseScopeId: row && row.__caseScopeId,
    planCaseId: row && row.__planCaseId,
    testCaseId: row && row.__testCaseId,
  });
  const scoped = list.filter((row) => rowScope(row));
  if (!scoped.length) return list;
  if (!caseScope) return [];
  return scoped.filter((row) => rowScope(row) === caseScope);
}

function completeBindingFromSheet(binding, sheet) {
  if (!binding || !sheet || !Array.isArray(sheet.headers)) return binding;
  const out = { ...binding };
  const headers = sheet.headers.filter((h) => h != null && String(h).trim() !== '');

  if (!out.rowClassColumn) {
    const classCol = headers.find((h) => detectColumnRole(h) === 'class_label')
      || headers.find((h) => /^(scenario|caseintent|intent|attacktype|authrole|role|variant|testcaseid|testcase_id)$/i.test(String(h).replace(/[^a-z0-9_]/gi, '')));
    if (classCol) out.rowClassColumn = classCol;
  }

  if (!out.expectedColumn) {
    const expectedCols = headers
      .map((h) => ({ h, role: detectColumnRole(h) }))
      .filter(({ h, role }) => (
        ['error', 'destination', 'absence', 'presence', 'expected_count', 'empty_state'].includes(role)
        && !/^(shouldsubmit|shouldcrash|shouldrender|shouldredirect|sensitivity|notes?)$/i.test(String(h).replace(/[^a-z0-9_]/gi, ''))
      ));
    const preferred = expectedCols.find(({ h }) => /^expected/i.test(String(h))) || expectedCols[0];
    if (preferred) out.expectedColumn = preferred.h;
  }

  return out;
}

function bindingHeaderProblem(binding, sheet) {
  if (!binding || !sheet || !Array.isArray(sheet.headers)) return null;
  const headers = new Set(sheet.headers.map((h) => norm(h)));
  const check = (kind, role, header) => {
    if (header == null || String(header).trim() === '') return null;
    const value = String(header).trim();
    if (/\{\{|\}\}/.test(value)) {
      return {
        code: 'data_binding_column_corrupted',
        blockedReason: 'test_data_invalid',
        message: `Test-data binding for "${binding.sheet}" has a corrupted ${kind}${role ? ` "${role}"` : ''} column reference "${value}". Regenerate or repair the binding before execution.`,
      };
    }
    if (!headers.has(norm(value))) {
      return {
        code: 'data_binding_column_not_found',
        blockedReason: 'test_data_invalid',
        message: `Test-data binding for "${binding.sheet}" references ${kind}${role ? ` "${role}"` : ''} column "${value}", but the uploaded sheet does not contain that header.`,
      };
    }
    return null;
  };
  for (const [role, header] of Object.entries(binding.columnToField || {})) {
    const problem = check('input', role, header);
    if (problem) return problem;
  }
  const expectedProblem = check('expected', 'expected', binding.expectedColumn);
  if (expectedProblem) return expectedProblem;
  const rowClassProblem = check('row class', 'rowClass', binding.rowClassColumn);
  if (rowClassProblem) return rowClassProblem;
  return null;
}

function identityColumnsFor(binding = {}, sheet = null) {
  const columns = new Set([
    binding.rowClassColumn,
    binding.columnToField && binding.columnToField.role,
    binding.columnToField && binding.columnToField.scenario,
    'authRole',
    'role',
    'scenario',
    'testCaseID',
    'testCaseId',
    'caseId',
  ].filter(Boolean));
  if (sheet && Array.isArray(sheet.headers)) {
    for (const header of sheet.headers) {
      if (/\b(role|scenario|case\s*id|testcase|test_case|auth)\b/i.test(String(header || ''))) {
        columns.add(header);
      }
    }
  }
  return Array.from(columns);
}

function resolvePinnedRows(rows, binding = {}) {
  const requested = Array.isArray(binding.rowIds)
    ? binding.rowIds.filter(hasRefValue).map((rowId) => String(rowId))
    : [];
  if (!requested.length) return { status: 'unpinned', rows: [], missing: [], ambiguous: [] };

  const duplicateRequests = requested.filter((rowId, index) => requested.indexOf(rowId) !== index);
  if (duplicateRequests.length) {
    return {
      status: 'ambiguous',
      rows: [],
      missing: [],
      ambiguous: Array.from(new Set(duplicateRequests)).sort(),
    };
  }

  const rowsById = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    // Runtime row identity is compiler-owned and injected by testDataContext.
    // Never fall back to array position or a business-domain "id" column.
    if (!row || !hasRefValue(row.__datasetRowId)) continue;
    const rowId = String(row.__datasetRowId);
    if (!rowsById.has(rowId)) rowsById.set(rowId, []);
    rowsById.get(rowId).push(row);
  }
  const missing = requested.filter((rowId) => !rowsById.has(rowId));
  const ambiguous = requested.filter((rowId) => (rowsById.get(rowId) || []).length > 1);
  if (ambiguous.length) {
    return { status: 'ambiguous', rows: [], missing, ambiguous: Array.from(new Set(ambiguous)).sort() };
  }
  if (missing.length) return { status: 'missing', rows: [], missing, ambiguous: [] };
  return {
    status: 'resolved',
    // Preserve the immutable plan's row order, not incidental workbook order.
    rows: requested.map((rowId) => rowsById.get(rowId)[0]),
    missing: [],
    ambiguous: [],
  };
}

function pinnedRowsDefect(resolution, binding) {
  if (!resolution || resolution.status === 'resolved' || resolution.status === 'unpinned') return null;
  if (resolution.status === 'ambiguous') {
    return testDataInvalid(
      'data_binding_row_ids_ambiguous',
      `Test-data binding for "${binding.sheet || binding.sheetId}" has non-unique immutable rowIds; QAAI refused to choose the first row.`,
      resolution.ambiguous.map((rowId) => ({ rowId })),
    );
  }
  return testDataInvalid(
    'data_binding_row_ids_not_found',
    `Test-data binding for "${binding.sheet || binding.sheetId}" references rowIds that are absent from the exact dataset revision.`,
    resolution.missing.map((rowId) => ({ rowId })),
  );
}

function filterRowsBySelector(rows, binding = {}, sheet = null, tc = null) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const pinned = resolvePinnedRows(rows, binding);
  if (pinned.status === 'resolved') return pinned.rows;
  if (pinned.status !== 'unpinned') return [];
  // Step 3B — a storyId-bound case carries rowSelector "story:<id>": run ONLY the
  // rows whose storyId column equals that id (not the whole sheet). Matched
  // normalized against binding.storyColumn. The bind-time resolver already
  // confirmed such rows exist; the fallback to all rows is purely defensive.
  const rawSel = String(binding.rowSelector || '');
  if (/^story:/i.test(rawSel)) {
    const wantedStory = norm(rawSel.replace(/^story:/i, ''));
    const storyCol = binding.storyColumn;
    const byStory = (storyCol && wantedStory) ? rows.filter((r) => norm(r && r[storyCol]) === wantedStory) : [];
    return byStory.length ? byStory : rows;
  }
  const selector = binding.rowSelector && norm(binding.rowSelector) !== 'all'
    ? norm(binding.rowSelector)
    : '';
  const identityColumns = identityColumnsFor(binding, sheet);

  if (selector) {
    const exact = rows.filter((r) => identityColumns.some((col) => norm(r && r[col]) === selector));
    if (exact.length) return exact;
    if (binding.rowClassColumn) {
      const byClass = rows.filter((r) => norm(r && r[binding.rowClassColumn]) === selector);
      if (byClass.length) return byClass;
    }
  }

  const caseText = norm([tc && tc.name, tc && tc.assertions].filter(Boolean).join(' '));
  if (!caseText) return rows;
  const candidates = rows
    .map((row) => {
      const identities = identityColumns
        .map((col) => row && row[col])
        .filter((v) => v != null && String(v).trim() !== '')
        .map((v) => String(v).trim());
      const best = identities
        .filter((v) => {
          const id = norm(v);
          return id.length >= 3 && caseText.includes(id);
        })
        .sort((a, b) => norm(b).length - norm(a).length)[0];
      return best ? { row, score: norm(best).length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  if (candidates.length && candidates.filter((c) => c.score === candidates[0].score).length === 1) {
    return [candidates[0].row];
  }
  return rows;
}

/**
 * Resolve the data rows a case should execute against.
 * @returns {Array} [] when not data-driven; otherwise one entry per row:
 *   { index, setName, sheet, inputs:{role:value}, raw:{header:value},
 *     expected, rowClass, expectedColumn, rowClassColumn, label }
 */
// Find a companion sheet to source missing login credentials from. Two modes:
//  • 'join'    — the bound sheet HAS an identity (username/login) but no password: pull the password
//                from the companion auth sheet's row matching that identity VALUE.
//  • 'default' — the bound sheet has NO identity at all (e.g. a pure-expectations sheet like
//                ExpectedResults): use the companion auth sheet's DEFAULT (first) row for BOTH
//                username and password, so a login-requiring case still authenticates.
// Returns null when the bound sheet already supplies the password, or no companion auth sheet exists.
// #9 GENERAL CROSS-SHEET JOIN (generic foreign-key resolution).
// The credential join (below) is the special case "bound sheet has username but
// no password; a companion auth sheet has both". Generalise it: when the bound
// sheet and another sheet share a KEY column (the SAME canonical role appears in
// both bindings' columnToField — e.g. employeeId, username, accountId), join by
// that key's VALUE and pull in ANY role the companion supplies that the bound
// sheet lacks. Keyed purely on shared column identity (role), never a site value.
// Returns an array of join specs: { foreignRows, foreignKeyHeader, localKeyHeader,
//   importColumns:{role:header}, foreignSheet }.
function buildForeignKeyJoins(binding, boundSheet, sheets, mapping) {
  const joins = [];
  // Unsafe by default: a shared username is not a foreign-key contract. The old
  // generic join imported every missing role from every same-username sheet and
  // polluted rows with unrelated oracle/control fields. Credential-only joins
  // are still handled by buildCredentialJoin below.
  return joins;
  const localC2f = (binding && binding.columnToField) || {};
  const localRoles = Object.keys(localC2f);
  if (!localRoles.length) return joins;
  const bindings = Array.isArray(mapping && mapping.bindings) ? mapping.bindings : [];
  for (const b of bindings) {
    if (!b || norm(b.sheet) === norm(boundSheet.name)) continue;
    const fc2f = (b.columnToField && typeof b.columnToField === 'object') ? b.columnToField : {};
    const fRoles = Object.keys(fc2f);
    if (!fRoles.length) continue;
    const fSheet = findSheet(sheets, b.sheet);
    if (!fSheet || !Array.isArray(fSheet.rows) || !fSheet.rows.length) continue;
    // Shared KEY = a canonical role present in BOTH bindings → join on its value.
    const sharedKeyRole = localRoles.find((r) => Object.prototype.hasOwnProperty.call(fc2f, r));
    if (!sharedKeyRole) continue;
    // Import every companion role the bound sheet does NOT already supply.
    const importColumns = {};
    for (const [role, header] of Object.entries(fc2f)) {
      if (role === sharedKeyRole) continue;
      if (!Object.prototype.hasOwnProperty.call(localC2f, role)) importColumns[role] = header;
    }
    if (!Object.keys(importColumns).length) continue;
    joins.push({
      foreignRows: fSheet.rows,
      foreignKeyHeader: fc2f[sharedKeyRole],
      localKeyHeader: localC2f[sharedKeyRole],
      importColumns,
      foreignSheet: b.sheet,
    });
  }
  return joins;
}

function buildCredentialJoin(binding, boundSheet, sheets, mapping) {
  const c2f = binding.columnToField || {};
  if (c2f.password) return null; // bound sheet already supplies the password
  const localUserHeader = c2f.username || c2f.user || c2f.login || c2f.email || c2f.loginusername || c2f.loginUsername || null;
  const bindings = Array.isArray(mapping && mapping.bindings) ? mapping.bindings : [];
  for (const b of bindings) {
    if (!b || norm(b.sheet) === norm(boundSheet.name)) continue;
    const bc = b.columnToField || {};
    const fUser = bc.username || bc.user || bc.login || bc.email;
    if (!fUser || !bc.password) continue; // companion must have identity + password
    const fSheet = findSheet(sheets, b.sheet);
    if (!fSheet || !Array.isArray(fSheet.rows) || !fSheet.rows.length) continue;
    if (localUserHeader) {
      const credColumns = {};
      for (const role of ['password', 'otp', 'secret']) if (bc[role]) credColumns[role] = bc[role];
      if (!Object.keys(credColumns).length) continue;
      return { mode: 'join', foreignRows: fSheet.rows, foreignUserHeader: fUser, credColumns, localUserHeader, foreignSheet: b.sheet };
    }
    // No identity in the bound sheet → default-credential fallback. Carry the
    // full companion rows + its role discriminator (role/authRole/scenario) so
    // #36b can pick a row matching the bound row, not blindly rows[0].
    const defaultCred = { username: fUser };
    for (const role of ['password', 'otp', 'secret']) if (bc[role]) defaultCred[role] = bc[role];
    const discriminatorHeader = bc.role || bc.authRole || bc.scenario || null;
    return {
      mode: 'default',
      defaultRow: fSheet.rows[0],
      foreignRows: fSheet.rows,
      defaultCred,
      foreignSheet: b.sheet,
      discriminatorHeader,
    };
  }
  return null;
}

// #36b — choose the companion credential row matching the bound row's
// discriminator (role/identity). Returns { row, fallback }: fallback=true when
// no companion row matched and we fell back to the first row. Generic — keyed on
// the SHARED discriminator role's VALUE, never a site-specific identity.
function pickDefaultCompanionRow(credJoin, boundRow, localColumnToField) {
  const rows = Array.isArray(credJoin && credJoin.foreignRows) ? credJoin.foreignRows : [];
  if (!rows.length) return { row: credJoin && credJoin.defaultRow, fallback: true };
  if (rows.length === 1) return { row: rows[0], fallback: false };
  const fHeader = credJoin.discriminatorHeader;
  // The bound row's discriminator VALUE: prefer the same canonical role's column
  // on the bound sheet (role/authRole/scenario), then the row-class column.
  const localDiscHeader = (localColumnToField && (localColumnToField.role || localColumnToField.authRole || localColumnToField.scenario)) || null;
  const boundVal = localDiscHeader && boundRow ? norm(boundRow[localDiscHeader]) : '';
  if (fHeader && boundVal) {
    const match = rows.find((fr) => norm(fr[fHeader]) === boundVal);
    if (match) return { row: match, fallback: false };
  }
  return { row: rows[0], fallback: true };
}

// Honor the Architect-emitted credential/identity COMPANIONS on a binding. Each
// companion { sheet, columnToField:{ role: header } } sources roles the bound
// sheet cannot supply itself — typically login credentials that live on a shared
// profiles sheet (e.g. every functional row carries profileKey → ExecutionProfiles
// holds loginUsername/loginPassword). The companion row is chosen by a shared
// identity KEY present in BOTH sheets (profileKey/role/username/…); when the
// companion has a single row, that row is used. Generic — keyed on shared column
// identity, never a site value. Returns [{ sheet, rows, columnToField, cKeyHeader,
// bKeyHeader }] for resolveCaseRows to apply per bound row.
function buildCompanionJoins(binding, boundSheet, sheets) {
  const companions = Array.isArray(binding && binding.companions) ? binding.companions : [];
  const out = [];
  if (!companions.length) return out;
  const boundHeaders = boundSheet && Array.isArray(boundSheet.rows) && boundSheet.rows[0]
    ? Object.keys(boundSheet.rows[0])
    : (boundSheet && Array.isArray(boundSheet.headers) ? boundSheet.headers : []);
  const boundNorm = new Set(boundHeaders.map(norm));
  const KEY_PREF = ['profilekey', 'role', 'authrole', 'username', 'login', 'email', 'employeeid', 'accountid'];
  for (const comp of companions) {
    if (!comp || !comp.sheet || !comp.columnToField || typeof comp.columnToField !== 'object') continue;
    const cSheet = findSheet(sheets, comp.sheet);
    if (!cSheet || !Array.isArray(cSheet.rows) || !cSheet.rows.length) continue;
    const cHeaders = cSheet.rows[0] ? Object.keys(cSheet.rows[0]) : (Array.isArray(cSheet.headers) ? cSheet.headers : []);
    const cNorm = new Set(cHeaders.map(norm));
    const keyNorm = KEY_PREF.find((k) => cNorm.has(k) && boundNorm.has(k)) || null;
    out.push({
      sheet: comp.sheet,
      rows: cSheet.rows,
      columnToField: comp.columnToField,
      cKeyHeader: keyNorm ? cHeaders.find((h) => norm(h) === keyNorm) : null,
      bKeyHeader: keyNorm ? boundHeaders.find((h) => norm(h) === keyNorm) : null,
    });
  }
  return out;
}

// Token keys that carry NO per-row TEST intent — they are the login identity/secret
// (or the auth profile selector), which for a same-profile matrix is IDENTICAL on every
// row. A case that consumes ONLY these does the same thing on every row. Generic
// credential vocabulary, never a site value.
const CREDENTIAL_ONLY_TOKEN_KEYS = new Set([
  'username', 'user', 'login', 'loginusername', 'loginuser', 'userid',
  'password', 'loginpassword', 'pass', 'pwd', 'loginpwd',
  'role', 'profilekey', 'profile', 'authrole',
]);

function consumedTokenKeys(tc) {
  const keys = new Set();
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  const scan = (v) => {
    if (typeof v === 'string') { let m; re.lastIndex = 0; while ((m = re.exec(v))) { const k = norm(m[1]); if (k) keys.add(k); } }
    else if (Array.isArray(v)) { for (const it of v) scan(it); }
    else if (v && typeof v === 'object') { for (const val of Object.values(v)) scan(val); }
  };
  scan(decode(tc && tc.steps, null));
  scan(decode(tc && tc.declaredAssertions, null));
  return keys;
}

/**
 * RUN-ONCE rule (fan-out quality). A data-bound case that consumes ONLY credential/profile
 * tokens — and no distinguishing non-credential row field and no row oracle ({{expected}}) —
 * behaves identically on every row (e.g. "Login and verify Dashboard" that happens to be
 * bound to a functional sheet). Fanning it out is redundant, fake-looking "data-driven"
 * repetition and multiplies logins. Such a case must execute ONCE. A case that consumes a
 * distinguishing column ({{menulabel}}, {{shortcutlabel}}, {{expected}}, a filter input, …)
 * still fans out over every row. Keyed on token vocabulary, never a site value.
 */
function caseConsumesOnlyCredentials(tc) {
  const keys = consumedTokenKeys(tc);
  if (!keys.size) return false;
  for (const k of keys) if (!CREDENTIAL_ONLY_TOKEN_KEYS.has(k)) return false;
  return true;
}

function resolveCaseRows(tc, scenario, testData, opts = {}) {
  if (!tc) return [];
  const onLog = opts && typeof opts.onLog === 'function' ? opts.onLog : null;
  const collector = opts && Array.isArray(opts.collector) ? opts.collector : null;
  const inlineResolution = resolveInlineCaseRows(tc);
  if (inlineResolution.status === 'resolved') return inlineResolution.rows;
  if (inlineResolution.status === 'invalid') {
    if (collector && inlineResolution.defect) {
      collector.push({ stage: 'data-binding', severity: 'error', ...inlineResolution.defect });
    }
    if (onLog && inlineResolution.defect) onLog('error', inlineResolution.defect.message);
    return [];
  }
  const resolution = resolveCaseDataSource(tc, scenario, testData);
  if (resolution.status === 'unbound') return [];
  if (resolution.status !== 'resolved') {
    if (collector && resolution.defect) {
      collector.push({ stage: 'data-binding', severity: 'error', ...resolution.defect });
    }
    if (onLog && resolution.defect) onLog('error', resolution.defect.message);
    return [];
  }
  const sheets = sheetsFromTestData(testData);
  const mapping = mappingFromTestData(testData);

  // Fan a case out ONLY when it carries an EXPLICIT data binding (the
  // Architect-emitted dataBindingJson). We deliberately do NOT auto-fan every
  // case whose scenario name matches a sheet: a scenario holds many cases
  // (valid login, empty password, locked account, …), each asserting a
  // DIFFERENT outcome. Multiplying all of them by every data row would both
  // explode the run and assert each case's outcome against rows it was never
  // meant for. The Architect marks the ONE parameterized case with a binding;
  // every other case runs exactly once. The binding may be bare ({ sheet });
  // hydrateBinding fills column→field / expected / row-class from the mapping.
  let binding = resolution.binding;
  const sheet = resolution.sheet;
  if (!sheet || !Array.isArray(sheet.rows) || !sheet.rows.length) return [];
  binding = completeBindingFromSheet(binding, sheet);

  const columnToField = binding.columnToField || {};
  const expectedColumn = binding.expectedColumn || null;
  const rowClassColumn = binding.rowClassColumn || null;
  const mappedHeaders = [...Object.values(columnToField), expectedColumn, rowClassColumn].filter(Boolean);
  const usableRows = analyzeSheetUsability(sheet, mappedHeaders).rows;
  if (!usableRows.length) return [];

  // Cross-sheet credential join: a data-driven case (e.g. a per-role menu matrix) may be bound to
  // the sheet that holds its EXPECTATIONS (RoleAccessControl) while its login step needs a
  // credential (password) that lives on the companion identity sheet (AuthProfiles). When the bound
  // sheet supplies the identity (username/login) but NOT the password, join the companion
  // auth-profiles sheet by matching the identity VALUE and inject the missing credential columns.
  // Generic — keyed on "bound sheet has identity but no password; a companion sheet has both".
  const credJoin = buildCredentialJoin(binding, sheet, sheets, mapping);
  // #9 — general foreign-key joins for ANY missing role (not just credentials).
  const fkJoins = buildForeignKeyJoins(binding, sheet, sheets, mapping);
  // Architect-emitted credential/identity companions (e.g. profileKey → the shared
  // profiles sheet that holds loginUsername/loginPassword). Applied per row below.
  const companionJoins = buildCompanionJoins(binding, sheet, sheets);
  let ambiguousDefaultSignalled = false;

  const caseScopedRows = filterRowsByCaseScope(usableRows, tc, binding);
  const pinnedRows = resolvePinnedRows(caseScopedRows, binding);
  const pinDefect = pinnedRowsDefect(pinnedRows, binding);
  if (pinDefect) {
    if (collector) collector.push({ stage: 'data-binding', severity: 'error', ...pinDefect });
    if (onLog) onLog('error', pinDefect.message);
    return [];
  }
  const hasPinnedRows = pinnedRows.status === 'resolved';
  let rows = hasPinnedRows ? pinnedRows.rows : filterRowsBySelector(caseScopedRows, binding, sheet, tc);
  if (hasPinnedRows && rows.length > MAX_ROWS_PER_CASE) {
    const capDefect = testDataInvalid(
      'data_binding_pinned_row_cap_exceeded',
      `Test-data binding for "${binding.sheet}" pins ${rows.length} exact rows, exceeding the safe runtime limit of ${MAX_ROWS_PER_CASE}; QAAI refused to truncate the approved row set.`,
      [{ requested: rows.length, limit: MAX_ROWS_PER_CASE }],
    );
    if (collector) collector.push({ stage: 'data-binding', severity: 'error', ...capDefect });
    if (onLog) onLog('error', capDefect.message);
    return [];
  }
  if (rows.length > MAX_ROWS_PER_CASE && (onLog || collector)) {
    recordDegradation({
      onLog, collector, stage: 'data-binding', severity: 'warning',
      reason: `row cap applied: ${rows.length - MAX_ROWS_PER_CASE} row(s) were skipped after the first ${MAX_ROWS_PER_CASE}`,
      impact: 'rowCoverageStatus should be partial until the suite is split or the row cap is increased',
    });
  }
  rows = rows.slice(0, MAX_ROWS_PER_CASE);

  const rowObjects = rows.map((r, i) => {
    const inputs = {};
    for (const [role, header] of Object.entries(columnToField)) {
      if (r && Object.prototype.hasOwnProperty.call(r, header)) inputs[role] = r[header];
    }
    // #9 — generic shared-key joins applied first (specific credential join below
    // can still fill any credential the generic pass did not cover).
    for (const j of fkJoins) {
      const localKey = norm(r[j.localKeyHeader]);
      if (!localKey) continue;
      const fRow = j.foreignRows.find((fr) => norm(fr[j.foreignKeyHeader]) === localKey);
      if (!fRow) continue;
      for (const [role, hdr] of Object.entries(j.importColumns)) {
        if (inputs[role] == null && fRow[hdr] != null) inputs[role] = fRow[hdr];
      }
    }
    if (credJoin && credJoin.mode === 'join') {
      const localKey = norm(r[credJoin.localUserHeader]);
      const fRow = credJoin.foreignRows.find((fr) => norm(fr[credJoin.foreignUserHeader]) === localKey);
      if (fRow) for (const [role, hdr] of Object.entries(credJoin.credColumns)) {
        if (inputs[role] == null && fRow[hdr] != null) inputs[role] = fRow[hdr];
      }
    } else if (credJoin && credJoin.mode === 'default') {
      // #36b — pick the companion row whose discriminator (role/identity) matches
      // THIS bound row, instead of blindly using rows[0]. Only fall back to the
      // first row when nothing matches — and signal when that fallback is
      // ambiguous (a multi-row companion gives no basis to choose).
      const chosen = pickDefaultCompanionRow(credJoin, r, columnToField);
      const ambiguousFallback = !!(chosen.fallback && credJoin.foreignRows && credJoin.foreignRows.length > 1);
      const defaultRow = ambiguousFallback ? null : (chosen.row || credJoin.defaultRow);
      if (chosen.fallback && credJoin.foreignRows && credJoin.foreignRows.length > 1 && !ambiguousDefaultSignalled) {
        ambiguousDefaultSignalled = true;
        if (onLog || collector) {
          recordDegradation({
            onLog, collector, stage: 'data-binding', severity: 'error',
            reason: `ambiguous default credential: companion sheet "${credJoin.foreignSheet}" has ${credJoin.foreignRows.length} rows and the bound row carries no matching discriminator`,
            impact: 'credential companion row was not bound; choose an approved discriminator before running',
          });
        }
      }
      for (const [role, hdr] of Object.entries(credJoin.defaultCred)) {
        if (inputs[role] == null && defaultRow && defaultRow[hdr] != null) inputs[role] = defaultRow[hdr];
      }
    }
    // Apply the Architect-emitted companions LAST — fills credential/identity roles
    // (username, loginpassword, …) the bound sheet cannot supply, from the shared
    // profiles sheet joined by profileKey/role. Never overrides a value the bound
    // row already provided.
    for (const comp of companionJoins) {
      let cRow = null;
      if (comp.rows.length === 1) {
        cRow = comp.rows[0];
      } else if (comp.cKeyHeader && comp.bKeyHeader) {
        const bVal = norm(r[comp.bKeyHeader]);
        if (bVal) cRow = comp.rows.find((fr) => norm(fr[comp.cKeyHeader]) === bVal) || null;
      }
      if (cRow) {
        for (const [role, hdr] of Object.entries(comp.columnToField)) {
          if (inputs[role] == null && cRow[hdr] != null) inputs[role] = cRow[hdr];
        }
      } else if (comp.rows.length > 1 && (onLog || collector)) {
        recordDegradation({
          onLog, collector, stage: 'data-binding', severity: 'error',
          reason: `companion sheet "${comp.sheet}" has ${comp.rows.length} rows but no row matched the bound discriminator`,
          impact: 'companion values were not bound; choose an approved row relationship before running',
        });
      }
    }
    const expected = expectedColumn ? r[expectedColumn] : null;
    const rowClass = rowClassColumn ? r[rowClassColumn] : null;
    const caseScopeId = binding.caseScopeId || inlineCaseInstanceContract.caseScopeId(tc || {}) || null;
    const planCaseId = r && hasRefValue(r.__planCaseId) ? String(r.__planCaseId) : null;
    const instancePlanId = r && hasRefValue(r.__instancePlanId) ? String(r.__instancePlanId) : null;
    const instanceRevision = r && hasRefValue(r.__instanceRevision) ? String(r.__instanceRevision) : null;
    const datasetId = binding.datasetId || binding.testDataSetId || null;
    const rowObj = {
      index: i,
      setName: sheet.name,
      sheet: sheet.name,
      inputs,
      raw: r,
      expected,
      rowClass,
      expectedColumn,
      rowClassColumn,
      rowId: r && r.__datasetRowId || null,
      testDataSetId: binding.testDataSetId || binding.datasetId || null,
      datasetId,
      datasetRevisionId: binding.datasetRevisionId || null,
      sheetId: binding.sheetId || null,
      caseScopeId,
      planCaseId,
      instancePlanId,
      instanceRevision,
      mappingId: binding.mappingId || null,
      mappingVersion: binding.mappingVersion != null ? binding.mappingVersion : null,
      workbookHash: binding.workbookHash || null,
      rowGroupId: binding.rowGroupId || null,
      dataBindingRef: {
        testDataSetId: binding.testDataSetId || binding.datasetId || null,
        datasetId,
        datasetRevisionId: binding.datasetRevisionId || null,
        sheetId: binding.sheetId || null,
        mappingId: binding.mappingId || null,
        mappingVersion: binding.mappingVersion != null ? binding.mappingVersion : null,
        workbookHash: binding.workbookHash || null,
        rowGroupId: binding.rowGroupId || null,
        rowId: r && r.__datasetRowId || null,
        caseScopeId,
        planCaseId,
        instancePlanId,
        instanceRevision,
      },
      label: buildRowLabel(i, rowClass, inputs),
    };
    // Phase A2 — attach the per-row STRUCTURED EVIDENCE CONTRACT (what the
    // deterministic VerdictEngine requires for THIS row's outcome class). Built
    // here at run time because the concrete expected value + classified intent
    // only exist once the row is resolved; declaredAssertions stay advisory.
    rowObj.evidenceContract = buildRowEvidenceContract(rowObj);
    return rowObj;
  });

  // Exact rowIds are compiler-owned execution pins. Do not let heuristic intent
  // inference silently remove, reorder, or replace those planned rows.
  const selectorScopedRows = hasPinnedRows ? rowObjects : filterRowsByBindingSelectorIntent(rowObjects, binding);
  const finalRows = hasPinnedRows
    ? selectorScopedRows
    : filterRowsByCaseIntent(selectorScopedRows, tc, scenario, { onLog, collector });
  // RUN-ONCE: collapse a credential-only case to a single representative row (keep row 0
  // so its profileKey still resolves the login credentials). A case that consumes a
  // distinguishing field or the row oracle is untouched and still fans out.
  if (!hasPinnedRows && finalRows.length > 1 && caseConsumesOnlyCredentials(tc)) {
    if (onLog) onLog('info', `Run-once: "${tc.name || tc.id}" consumes only credential/profile tokens (no distinguishing row field or oracle) — executing 1 representative row instead of ${finalRows.length} redundant logins.`);
    return [finalRows[0]];
  }
  return finalRows;
}

function buildRowLabel(i, rowClass, inputs) {
  const lead = Object.values(inputs || {}).find((v) => v != null && String(v).trim() !== '');
  const parts = [`Row ${i + 1}`];
  if (rowClass != null && String(rowClass).trim() !== '') parts.push(String(rowClass).trim());
  if (lead != null) parts.push(String(lead).trim().slice(0, 40));
  return parts.join(' · ');
}

function collectCaseIntentText(tc, scenario) {
  const pieces = [
    scenario && scenario.name,
    scenario && scenario.description,
    scenario && scenario.module,
    tc && tc.name,
    tc && tc.module,
    tc && tc.description,
    tc && tc.assertions,
  ];
  const steps = decode(tc && tc.steps, null);
  const declared = decode(tc && tc.declaredAssertions, null);
  if (steps) pieces.push(JSON.stringify(steps));
  if (declared) pieces.push(JSON.stringify(declared));
  return pieces.filter((v) => v != null && String(v).trim() !== '').join(' ');
}

function inferCaseRowScope(tc, scenario) {
  const text = norm(collectCaseIntentText(tc, scenario)).replace(/\s+/g, ' ');
  if (!text) return null;
  const compact = text.replace(/[\s_\-]+/g, '');
  const validationText = text
    .replace(/\b(?:non|not)\s*[- ]?\s*empty\b/g, '')
    .replace(/\bnonempty\b/g, '');
  const validationCompact = validationText.replace(/[\s_\-]+/g, '');
  const hasFieldFormatValidation =
    /\b(invalid|malformed|bad)\b.{0,40}\b(email|format|field|value)\b/.test(validationText)
    || /\b(email|format|field|value)\b.{0,40}\b(invalid|malformed|bad)\b/.test(validationText);

  const hasRequiredValidation =
    /\b(empty|blank|missing|required|mandatory)\b/.test(validationText)
    || validationCompact.includes('emptyfield')
    || validationCompact.includes('bothfieldsempty')
    || validationCompact.includes('emptyusername')
    || validationCompact.includes('emptypassword')
    || validationCompact.includes('inlinevalidation')
    || hasFieldFormatValidation;
  if (hasRequiredValidation) {
    return { allowed: new Set(['required_validation']), strict: true, reason: 'required_validation_case' };
  }

  const hasAuthRejection =
    !hasFieldFormatValidation
    && (
      /\b(invalid|incorrect|wrong|reject|rejected|denied|unauthor|forbidden|bad cred|badcred|lockout|locked)\b/.test(text)
      || compact.includes('invalidpassword')
      || compact.includes('invalidusername')
      || compact.includes('negativeauthentication')
      || compact.includes('credentialscenario')
    );
  if (hasAuthRejection) {
    return { allowed: new Set(['auth_rejection']), strict: true, reason: 'auth_rejection_case' };
  }

  const hasBoundary =
    /\b(boundary|edge case|limit|maxlength|minlength|overly long|too long|spaces|whitespace|zero result|empty result|no result)\b/.test(text)
    || compact.includes('usernamewithspaces')
    || compact.includes('passwordwithspaces')
    || compact.includes('overlylong');
  if (hasBoundary) {
    return { allowed: new Set(['boundary', 'auth_rejection', 'required_validation']), strict: true, reason: 'boundary_case' };
  }

  const hasNegativeOracle =
    /\b(remain|remains|stay|stays|still)\b.{0,40}\blogin\b/.test(text)
    || /\blogin page still present\b/.test(text)
    || /\bdashboard\b.{0,30}\b(absent|not|never|blocked)\b/.test(text)
    || /\b(absent|not|never|blocked)\b.{0,30}\bdashboard\b/.test(text)
    || compact.includes('destinationabsent')
    || compact.includes('shouldsubmitno')
    || compact.includes('donotsubmit')
    || compact.includes('notsubmit');
  if (hasNegativeOracle) {
    return { allowed: new Set(['required_validation', 'auth_rejection', 'boundary']), strict: true, reason: 'negative_oracle_case' };
  }

  const hasSuccess =
    /\b(valid|positive|success|happy path|successful|dashboard|authorized|allowed)\b/.test(text)
    || compact.includes('validlogin')
    || compact.includes('validadmin')
    || compact.includes('validess');
  if (hasSuccess) {
    return { allowed: new Set(['success']), strict: true, reason: 'success_case' };
  }

  return null;
}

function reindexRowObjects(rows) {
  return rows.map((row, i) => {
    const out = {
      ...row,
      index: i,
      label: buildRowLabel(i, row.rowClass, row.inputs),
    };
    out.evidenceContract = buildRowEvidenceContract(out);
    return out;
  });
}

function filterRowsByCaseIntent(rowObjects, tc, scenario, opts = {}) {
  if (!Array.isArray(rowObjects) || rowObjects.length <= 1) return rowObjects;
  const scope = inferCaseRowScope(tc, scenario);
  if (!scope) return rowObjects;

  const classified = rowObjects.map((row) => ({ row, outcome: classifyRowOutcomeClass(row) }));
  const kept = classified
    .filter(({ outcome }) => scope.allowed.has(outcome && outcome.class))
    .map(({ row }) => row);
  if (!kept.length || kept.length === rowObjects.length) return rowObjects;

  const onLog = opts && typeof opts.onLog === 'function' ? opts.onLog : null;
  const collector = opts && Array.isArray(opts.collector) ? opts.collector : null;
  if (onLog || collector) {
    const skipped = classified
      .filter(({ outcome }) => !scope.allowed.has(outcome && outcome.class))
      .map(({ row, outcome }) => `${row.label || `Row ${(row.index || 0) + 1}`}=${(outcome && outcome.class) || 'unknown'}`)
      .slice(0, 6)
      .join(', ');
    recordDegradation({
      onLog,
      collector,
      stage: 'data-binding',
      severity: 'info',
      reason: `case-intent row scope (${scope.reason}) kept ${kept.length}/${rowObjects.length} rows`,
      impact: `skipped out-of-scope rows before browser execution${skipped ? `: ${skipped}` : ''}`,
    });
  }
  return reindexRowObjects(kept);
}

function filterRowsByBindingSelectorIntent(rowObjects, binding) {
  if (!Array.isArray(rowObjects) || rowObjects.length <= 1) return rowObjects;
  const selector = norm(binding && binding.rowSelector);
  let allowed = null;
  if (selector === 'positive' || selector === 'success' || selector === 'valid') {
    allowed = new Set(['success']);
  } else if (selector === 'negative' || selector === 'invalid') {
    allowed = new Set(['required_validation', 'auth_rejection', 'boundary']);
  } else if (selector === 'validation') {
    allowed = new Set(['required_validation', 'boundary']);
  }
  if (!allowed) return rowObjects;

  const kept = rowObjects.filter((row) => {
    const outcome = classifyRowOutcomeClass(row);
    return allowed.has(outcome && outcome.class);
  });
  return kept.length && kept.length !== rowObjects.length ? reindexRowObjects(kept) : rowObjects;
}

function sheetIntentClass(binding) {
  const s = `${(binding && binding.sheet) || ''} ${(binding && binding.purpose) || ''} ${(binding && binding.module) || ''}`.toLowerCase();
  if (/negative|invalid|reject|wrong[\s_-]?cred|bad[\s_-]?cred|failed[\s_-]?login|lockout/.test(s)) return 'negative';
  if (/security|sql[\s_-]?inj|injection|\bxss\b|attack|exploit/.test(s)) return 'security';
  if (/form[\s_-]?validation|\bvalidation\b|empty[\s_-]?field|required[\s_-]?field/.test(s)) return 'validation';
  if (/auth[\s_-]?profile|auth_profiles|identit|credential[\s_-]?profile/.test(s)) return 'positive_identity';
  return 'neutral';
}

function matrixCaseAllowsMixedRows(tc) {
  const rawText = collectCaseIntentText(tc, null);
  const text = norm(rawText).replace(/[\s_\-]+/g, '');
  return /\{\{\s*expected/i.test(rawText)
    || text.includes('datadriven')
    || text.includes('matrix')
    || text.includes('eachrow')
    || text.includes('allrows')
    || text.includes('perrow')
    || text.includes('perfilter')
    || text.includes('perintent')
    || text.includes('ornoresult')
    || text.includes('ornorecord');
}

function validateCaseDataBinding(tc, scenario, testData) {
  const inlineResolution = resolveInlineCaseRows(tc);
  if (inlineResolution.status === 'invalid') return inlineResolution.defect;
  if (inlineResolution.status === 'resolved') return null;
  const explicit = parseExplicitBinding(tc);
  if (!explicit) return null;
  if (testData && testData.pinValidationError) {
    return {
      code: testData.pinValidationError.code || 'pinned_test_data_unavailable',
      blockedReason: 'test_data_invalid',
      message: `The exact approved test-data revision for "${tc && tc.name ? tc.name : 'test case'}" is unavailable; QAAI refused to substitute a newer mapping or workbook. ${testData.pinValidationError.message || ''}`.trim(),
      evidence: testData.pinValidationError.findings || [],
    };
  }
  if (explicit.status === 'incomplete') {
    const finding = Array.isArray(explicit.findings) && explicit.findings[0] ? explicit.findings[0] : null;
    return {
      code: (finding && finding.code) || 'data_binding_incomplete',
      blockedReason: 'test_data_invalid',
      message: `Test-data binding is incomplete for "${tc && tc.name ? tc.name : 'test case'}"${finding && finding.detail ? `: ${finding.detail}` : ''}.`,
    };
  }

  const resolution = resolveCaseDataSource(tc, scenario, testData);
  if (resolution.status === 'invalid') return resolution.defect;
  if (resolution.status !== 'resolved') return null;
  const mapping = mappingFromTestData(testData);
  let binding = resolution.binding;
  const sheet = resolution.sheet;
  if (!sheet || !Array.isArray(sheet.rows) || !sheet.rows.length) {
    return testDataInvalid(
      'data_binding_sheet_not_found',
      `Test-data binding references sheet "${binding.sheet || binding.sheetId}", but that exact pinned sheet is unavailable or empty.`,
    );
  }
  binding = completeBindingFromSheet(binding, sheet);
  const headerProblem = bindingHeaderProblem(binding, sheet);
  if (headerProblem) return headerProblem;

  const pinnedRows = resolvePinnedRows(sheet.rows, binding);
  const pinDefect = pinnedRowsDefect(pinnedRows, binding);
  if (pinDefect) return pinDefect;
  const hasPinnedRows = pinnedRows.status === 'resolved';
  if (hasPinnedRows && pinnedRows.rows.length > MAX_ROWS_PER_CASE) {
    return testDataInvalid(
      'data_binding_pinned_row_cap_exceeded',
      `Test-data binding for "${binding.sheet}" pins ${pinnedRows.rows.length} exact rows, exceeding the safe runtime limit of ${MAX_ROWS_PER_CASE}; QAAI refused to truncate the approved row set.`,
      [{ requested: pinnedRows.rows.length, limit: MAX_ROWS_PER_CASE }],
    );
  }
  const selectedRows = (hasPinnedRows
    ? pinnedRows.rows
    : filterRowsBySelector(sheet.rows, binding, sheet, tc)).slice(0, MAX_ROWS_PER_CASE);
  const rowObjects = selectedRows.map((r, i) => {
    const inputs = {};
    for (const [role, header] of Object.entries(binding.columnToField || {})) {
      if (r && Object.prototype.hasOwnProperty.call(r, header)) inputs[role] = r[header];
    }
    return {
      index: i,
      setName: sheet.name,
      sheet: sheet.name,
      inputs,
      raw: r,
      expected: binding.expectedColumn ? r[binding.expectedColumn] : null,
      rowClass: binding.rowClassColumn ? r[binding.rowClassColumn] : null,
      expectedColumn: binding.expectedColumn || null,
      rowClassColumn: binding.rowClassColumn || null,
    };
  });
  const selectorScoped = hasPinnedRows ? rowObjects : filterRowsByBindingSelectorIntent(rowObjects, binding);
  const scoped = hasPinnedRows ? selectorScoped : filterRowsByCaseIntent(selectorScoped, tc, scenario);
  let intent = null;
  try { intent = deriveCaseOracleIntent(tc); } catch (_) { intent = null; }
  const mapBinding = resolution.mappingBinding || binding;
  if (intent === 'negative' && sheetIntentClass(mapBinding) === 'positive_identity') {
    const scopedOutcomes = scoped.map((row) => classifyRowOutcomeClass(row))
      .filter((o) => o && o.class && o.class !== 'unknown')
      .map((o) => o.class);
    const scopedDistinct = Array.from(new Set(scopedOutcomes));
    const allScopedRowsFitNegative = scoped.length > 0
      && scopedDistinct.length > 0
      && scopedDistinct.every((cls) => cls === 'required_validation' || cls === 'auth_rejection' || cls === 'boundary');
    if (!allScopedRowsFitNegative) {
      return {
        code: 'data_binding_intent_mismatch',
        blockedReason: 'test_data_invalid',
        message: `Negative/invalid/empty-field case "${tc && tc.name ? tc.name : 'test case'}" is bound to positive identity sheet "${binding.sheet}". Rebind it to a validation/negative/security sheet or an exact negative row selector.`,
      };
    }
  }
  if (scoped.length !== rowObjects.length) return null;

  const rowSelector = norm(binding.rowSelector || 'all');
  const outcomes = selectorScoped.map((row) => classifyRowOutcomeClass(row))
    .filter((o) => o && o.class && o.class !== 'unknown')
    .map((o) => o.class);
  const distinct = Array.from(new Set(outcomes));
  if (selectorScoped.length > 1 && (!rowSelector || rowSelector === 'all') && distinct.length > 1 && !matrixCaseAllowsMixedRows(tc)) {
    return {
      code: 'data_binding_mixed_rows_without_scope',
      blockedReason: 'test_data_invalid',
      message: `Case "${tc && tc.name ? tc.name : 'test case'}" is bound to all rows of mixed-outcome sheet "${binding.sheet}" (${distinct.join(', ')}). Add an exact rowSelector or author this as an explicit data-driven matrix case.`,
    };
  }
  return null;
}

// Token map keyed by BOTH canonical role (username) and the actual header
// (User Name), plus {{expected}} / {{rowClass}}. All keys normalised so
// placeholders are case/space-insensitive.
function buildTokenMap(row) {
  const map = {};
  for (const [role, v] of Object.entries(row.inputs || {})) map[norm(role)] = v;
  for (const [header, v] of Object.entries(row.raw || {})) map[norm(header)] = v;
  if (row.expectedColumn) map['expected'] = row.expected;
  if (row.rowClassColumn) map['rowclass'] = row.rowClass;
  // Credential-token aliasing (generic QA vocabulary). A login step commonly uses
  // {{username}}/{{password}} while a profiles/credentials sheet names its columns
  // loginUsername/loginPassword (or user/login/pass). When the canonical credential
  // token was NOT directly supplied, fall back to whatever equivalent credential
  // value the row DID supply, so a login resolves without a bespoke column mapping.
  // Only fills an ABSENT canonical key — never overrides an explicit value. Keyed on
  // the credential vocabulary, never a site value.
  const credAlias = (canonical, alts) => {
    if (map[canonical] != null && String(map[canonical]).trim() !== '') return;
    for (const a of alts) {
      if (map[a] != null && String(map[a]).trim() !== '') { map[canonical] = map[a]; return; }
    }
  };
  credAlias('username', ['loginusername', 'user', 'login', 'loginuser', 'userid']);
  credAlias('password', ['loginpassword', 'pass', 'pwd', 'loginpwd']);
  credAlias('loginusername', ['username', 'user', 'login']);
  credAlias('loginpassword', ['password', 'pass', 'pwd']);
  return map;
}

// #36c TYPED-VALUE FIDELITY. Excel often hands us Date objects, ISO strings, or
// raw date SERIALS (days since 1899-12-30) and numeric/boolean cells. Coercing a
// serial like 44561 straight to a string types "44561" into a date field. Format
// dates to a sane ISO (YYYY-MM-DD) / locale string and leave numbers/booleans to
// the caller's discretion. Generic — keyed on VALUE SHAPE, never a column name.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30); // Excel's day-0 (with the 1900 leap bug)
function formatTokenValue(v) {
  if (v == null) return '';
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
// Coerce a single token to its string form, formatting Excel date serials when
// the cell is clearly a date serial. We only treat a number as a serial when an
// adjacent signal says so is impossible here (no column type), so we keep numbers
// as-is — formatting a plain quantity as a date would be wrong. Date objects /
// ISO date strings ARE normalised. This preserves numeric/boolean fidelity for
// the whole-string fast path while never inventing a date from a bare integer.
function fillTokens(str, tokenMap) {
  if (typeof str !== 'string' || str.indexOf('{{') === -1) return str;
  return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, key) => {
    const k = norm(key);
    return (Object.prototype.hasOwnProperty.call(tokenMap, k) && tokenMap[k] != null)
      ? formatTokenValue(tokenMap[k])
      : m; // leave unknown tokens verbatim — never blank out
  });
}

// When a field's value is EXACTLY one token (e.g. value: "{{count}}"), return the
// underlying typed value (number/boolean preserved; Date formatted) rather than a
// coerced string. Used by substituteCase for step value/expected fields so a
// numeric/boolean data cell keeps its type into the run. Returns
// { matched, value } — matched=false when not a single whole-string token.
function resolveWholeTokenValue(str, tokenMap) {
  if (typeof str !== 'string') return { matched: false };
  const m = str.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (!m) return { matched: false };
  const k = norm(m[1]);
  if (!Object.prototype.hasOwnProperty.call(tokenMap, k) || tokenMap[k] == null) return { matched: false };
  const v = tokenMap[k];
  if (typeof v === 'number' || typeof v === 'boolean') return { matched: true, value: v };
  if (v instanceof Date) return { matched: true, value: formatTokenValue(v) };
  return { matched: true, value: String(v) };
}

function substituteAssertion(a, tokenMap) {
  if (!a || typeof a !== 'object') return a;
  const fillJsonTokens = (value) => {
    if (typeof value === 'string') return fillTokens(value, tokenMap);
    if (Array.isArray(value)) return value.map(fillJsonTokens);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, fillJsonTokens(val)]));
    }
    return value;
  };
  return fillJsonTokens(a);
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-ROW OUTCOME CLASSIFIER (Phase A1)
//
// A data matrix mixes rows with INCOMPATIBLE expected outcomes (empty field →
// stay + validation error; valid creds → success/navigate; invalid/overlong →
// auth rejection). Each row must select its OWN evidence contract, so we must
// know its outcome class. Real sheets rarely carry a clean `scenarioType`
// column, so classification is a PRIORITY LADDER over generic signals — NEVER a
// site-specific string:
//   1. explicit class signal  — rowClass value / a class-like raw column value / label
//   2. expected-outcome column — what the expected column NAME + VALUE imply
//   3. input-value semantics   — blank required field / oversized-garbage / clean
//   4. fallback                — 'unknown' (low confidence). The Conductor resolves
//                                it from LIVE evidence; never silently certified.
//
// Returns { class, confidence, basis, sourceColumns }.
//   class ∈ 'success' | 'required_validation' | 'auth_rejection' | 'boundary' | 'unknown'
//   confidence ∈ 'high' | 'medium' | 'low'
// This only SELECTS which evidence to require; the deterministic VerdictEngine
// still decides pass/fail from real observed evidence, and the Conductor
// re-confirms the class live — so a mis-classification self-corrects and can
// never fake a verdict.

// ORDER MATTERS. "invalid" CONTAINS "valid", and "emptyState" contains "empty",
// so the more-specific / negative groups are tested BEFORE the generic ones.
// Matched as substrings on a separator-collapsed string, because real labels are
// camelCase compounds ("emptyUsername", "invalidCredentials") with no separators.
const OUTCOME_KEYWORDS = [
  { cls: 'auth_rejection', words: ['negative', 'invalid', 'incorrect', 'wrong', 'reject', 'denied', 'deny', 'disallow', 'unauthor', 'forbidden', 'locked', 'lockout', 'expired', 'overlong', 'overlylong', 'toolong', 'maxlength', 'garbage', 'malformed', 'sqlinjection', 'failure', 'failedlogin', 'badcred'] },
  { cls: 'boundary', words: ['boundary', 'minlength', 'maxbound', 'edgecase', 'limit', 'space', 'spaces', 'zeroresult', 'noresult', 'emptyresult', 'emptystate', 'nodata'] },
  { cls: 'required_validation', words: ['empty', 'blank', 'missing', 'required', 'mandatory', 'noinput', 'whitespace'] },
  { cls: 'success', words: ['valid', 'positive', 'success', 'happy', 'correct', 'authorized', 'granted', 'allowed', 'goodcred'] },
];

function classifyOutcomeWord(text) {
  const n = norm(text).replace(/[\s_\-]+/g, '');      // collapse separators for compound matching
  if (!n) return null;
  for (const group of OUTCOME_KEYWORDS) {
    for (const w of group.words) {
      if (w === 'valid' && n.includes('validation')) continue;
      if (n.includes(w)) return group.cls;
    }
  }
  return null;
}

const OUTCOME_CLASS_HEADER_RE = /(scenario|rowclass|row_?class|testtype|test_?type|variant|category|outcome|disposition|case_?type|expectation_?type)/i;
const OUTCOME_AUTH_PAGE_RE = /(\/auth\b|\/login\b|signin|sign[-_]?in|logon|\/sso\b)/i;

function classifyFromExpectedColumn(colName, value) {
  const col = norm(colName);
  const valStr = String(value == null ? '' : value).trim();
  const valLow = valStr.toLowerCase();
  if (!valStr) return null;

  // Destination / landing column → success UNLESS the destination is itself an
  // auth/login page (then the row expects to STAY on login = negative).
  if (/(landing|destination|redirect|navigates?to|target_?page|expected_?url|expected_?page|goesto|lands?on)/.test(col)) {
    if (OUTCOME_AUTH_PAGE_RE.test(valLow)) return { class: 'auth_rejection', confidence: 'medium' };
    // review P1c — a destination column carrying ERROR PROSE is mis-authored data,
    // NOT a success contract. Classify the value's word-shape first; only a real
    // URL or a clean short page-name counts as a success destination.
    const byWord = classifyOutcomeWord(valStr);
    if (byWord && byWord !== 'success') return { class: byWord, confidence: 'medium' };
    if (expectedLooksLikeUrl(valStr)) return { class: 'success', confidence: 'high' };
    if (/^[A-Za-z][\w /-]{0,38}$/.test(valStr) && !isUntrustedPageName(valStr)) return { class: 'success', confidence: 'medium' };
    return null;
  }
  // Result-count column → 0 → boundary, >0 → success.
  if (/(result_?count|num_?results)/.test(col)) {
    const numeric = Number(valStr.replace(/[^0-9.\-]/g, ''));
    if (Number.isFinite(numeric)) return numeric === 0 ? { class: 'boundary', confidence: 'high' } : { class: 'success', confidence: 'medium' };
  }
  // Empty-state column → truthy → boundary.
  if (/(empty_?state|no_?results|is_?empty)/.test(col)) {
    if (/^(true|yes|1|empty|none)$/i.test(valLow)) return { class: 'boundary', confidence: 'high' };
  }
  // Error / message column → the value is an expected ERROR string → negative.
  // Disambiguate required-field vs auth-rejection by the value's word-shape.
  if (/(error|message|validation|expected_?msg|expected_?err)/.test(col)) {
    const byWord = classifyOutcomeWord(valStr);
    if (byWord === 'required_validation' || byWord === 'auth_rejection') return { class: byWord, confidence: 'high' };
    return { class: 'auth_rejection', confidence: 'medium' };   // a generic error present → stays + error
  }
  // Generic expected column → value word-shape, then URL shape.
  const byWord = classifyOutcomeWord(valStr);
  if (byWord) return { class: byWord, confidence: 'medium' };
  if (OUTCOME_AUTH_PAGE_RE.test(valLow)) return { class: 'auth_rejection', confidence: 'low' };
  if (/^https?:\/\/|^\//.test(valStr)) return { class: 'success', confidence: 'low' };   // a non-auth destination
  return null;
}

function classifyFromInputs(inputs) {
  if (!inputs || typeof inputs !== 'object') return null;
  const entries = Object.entries(inputs);
  if (!entries.length) return null;

  // Any mapped input blank/whitespace → exercising required-field validation
  // (strong, deterministic signal).
  const blankFields = entries.filter(([, v]) => v == null || String(v).trim() === '').map(([k]) => k);
  if (blankFields.length) return { class: 'required_validation', confidence: 'high', fields: blankFields };

  // All present. Oversized / control-char / pure-symbol value → garbage → auth
  // rejection (heuristic, medium confidence).
  const garbageFields = entries.filter(([, v]) => {
    const s = String(v);
    if (s.length > 64) return true;
    if (Array.prototype.some.call(s, (ch) => ch.charCodeAt(0) < 32)) return true; // control chars
    if (s.length >= 6 && !/[a-z0-9]/i.test(s)) return true;
    return false;
  }).map(([k]) => k);
  if (garbageFields.length) return { class: 'auth_rejection', confidence: 'medium', fields: garbageFields };

  // All present and well-formed → success. MEDIUM: a well-formed-but-WRONG
  // credential is indistinguishable from valid by data shape alone; the
  // VerdictEngine + the Conductor's live evidence settle it.
  return { class: 'success', confidence: 'medium', fields: entries.map(([k]) => k) };
}

function classifyRowOutcomeClass(row) {
  if (!row || typeof row !== 'object') return { class: 'unknown', confidence: 'low', basis: 'no_row', sourceColumns: [] };
  // Inline CaseContract instances already carry their own literal assertions
  // and typed oracles. External-matrix shape heuristics ("all fields present"
  // => success) must not reinterpret an authored negative inline instance and
  // block it before the browser. Its executable projection remains authority.
  if (row.inlineInstance === true) {
    return { class: 'unknown', confidence: 'low', basis: 'compiler_inline_instance', sourceColumns: [] };
  }

  // ── Rung 1: explicit class signal ──────────────────────────────────────
  const explicit = [];
  if (row.rowClass != null && String(row.rowClass).trim() !== '') {
    explicit.push({ text: row.rowClass, src: row.rowClassColumn || 'rowClass' });
  }
  const raw = (row.raw && typeof row.raw === 'object') ? row.raw : {};
  for (const [header, val] of Object.entries(raw)) {
    if (header === row.rowClassColumn || header === row.expectedColumn) continue;
    if (OUTCOME_CLASS_HEADER_RE.test(header) && val != null && /[a-z]/i.test(String(val))) {
      explicit.push({ text: val, src: header });
    }
  }
  // review P2c — DO NOT use row.label as a class signal: it embeds the lead INPUT
  // value, so a username/email like "invalid_user" or "valid@x.com" would inject
  // the words "invalid"/"valid" and misclassify the row. The scenario word, when
  // present, comes from row.rowClass / a class-like column (handled above); the
  // label adds only the risky input value.
  for (const sig of explicit) {
    const cls = classifyOutcomeWord(sig.text);
    if (cls) return { class: cls, confidence: 'high', basis: 'class_signal', sourceColumns: [sig.src] };
  }

  // ── Rung 2: expected-outcome column semantics ──────────────────────────
  if (row.expectedColumn && row.expected != null && String(row.expected).trim() !== '') {
    const r2 = classifyFromExpectedColumn(row.expectedColumn, row.expected);
    if (r2) return { class: r2.class, confidence: r2.confidence, basis: 'expected_column', sourceColumns: [row.expectedColumn] };
  }

  // ── Rung 3: input-value semantics ──────────────────────────────────────
  const r3 = classifyFromInputs(row.inputs);
  if (r3) return { class: r3.class, confidence: r3.confidence, basis: 'input_values', sourceColumns: r3.fields };

  // ── Rung 4: fallback — never silently certified; Conductor resolves live ─
  return { class: 'unknown', confidence: 'low', basis: 'fallback', sourceColumns: [] };
}

function hasConcreteExpectedValue(row) {
  return !!row
    && !!row.expectedColumn
    && row.expected != null
    && String(row.expected).trim() !== '';
}

function expectedLooksLikeUrl(value) {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) || /^\//.test(text);
}

function expectedPageProfile(value) {
  // review P2a — GENERIC, URL-derived identity only. The old version synthesized
  // login/dashboard-specific text+role signals (Login/Username/Password/Dashboard),
  // a login-pattern bias that doesn't fit the generic platform goal. Real per-page
  // signals come from the calibrator atlas (matchPageAssertion reads atlasSignals);
  // this is just a URL-based fallback identity for a data-bound PAGE/URL assertion.
  const text = String(value || '').trim();
  const lower = text.toLowerCase();
  const tail = lower.split(/[/?#]/).filter(Boolean).pop() || lower || 'expected_page';
  const pageName = tail.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'expected_page';
  return {
    pageName,
    expectedSignals: { url: [text] },
    primaryIndicator: null,
  };
}

function bindExpectedColumnToAssertion(assertion, row) {
  if (!assertion || typeof assertion !== 'object' || !hasConcreteExpectedValue(row)) return assertion;
  const expected = String(row.expected).trim();
  const expectedColumn = row.expectedColumn;
  const type = String(assertion.type || '').toUpperCase();
  const out = {
    ...assertion,
    dataExpected: expectedColumn,
    dataBinding: {
      isDataBound: true,
      expectedColumn,
      sourceColumn: expectedColumn,
      source: 'test_data_matrix_expected_column',
    },
  };
  const payload = out.payload && typeof out.payload === 'object' && !Array.isArray(out.payload)
    ? { ...out.payload }
    : {};

  // URL-type assertion (or one already carrying a URL payload): bind the expected
  // value as the URL pattern ONLY when it actually looks like a URL. An error /
  // result string must never become a URL pattern.
  if (type !== 'PAGE' && (type === 'URL' || payload.expectedUrlPattern || payload.targetUrl)) {
    if (expectedLooksLikeUrl(expected)) {
      out.type = 'URL';
      out.expectedUrlPattern = expected;
      out.targetUrl = expected;
      payload.expectedUrlPattern = expected;
      payload.targetUrl = expected;
    }
    out.payload = payload;
    return out;
  }

  // PAGE identity is rebuilt ONLY from a DESTINATION (URL-like) value. An
  // error/result string is NOT a page identity — turning "Username is required"
  // into pageName "username_is_required" was the run-90002e1c false-FAIL poison.
  if (expectedLooksLikeUrl(expected)) {
    const profile = expectedPageProfile(expected);
    out.type = type || 'PAGE';
    out.pageName = profile.pageName;
    payload.pageName = profile.pageName;
    payload.expectedUrlPattern = expected;
    payload.targetUrl = expected;
    payload.expectedSignals = profile.expectedSignals;
    if (profile.primaryIndicator) payload.primaryIndicator = profile.primaryIndicator;
    else delete payload.primaryIndicator;
    out.payload = payload;
    return out;
  }

  // Non-URL expected value on a PAGE assertion (an error/result string). NEVER
  // rebuild pageName from it. CRITICAL (review P0a): substituteAssertion() runs
  // BEFORE this binder, so a "{{expectedValidationError}}" pageName has ALREADY
  // become a plain error string ("Username is required") by now — a `{{ }}` test
  // alone misses it. Strip the pageName whenever it is an UNTRUSTED label (shared
  // shape test: braces, prose, outcome words, slug/sentence) OR it equals this
  // row's substituted error value. The error is captured as field/error evidence
  // in the row's evidenceContract, never as a page identity. isUntrustedPageName
  // (shared with mcp.matchPageAssertion) catches the substituted error string by
  // SHAPE (prose, outcome words, slug) — a legit short page identity like
  // "Dashboard"/"Login" is preserved.
  if (type === 'PAGE' && typeof payload.pageName === 'string' && isUntrustedPageName(payload.pageName)) {
    delete payload.pageName;
    out.payload = payload;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-ROW STRUCTURED EVIDENCE CONTRACT (Phase A2)
//
// The deterministic VerdictEngine (Phase B) consumes `requiredEvidence`; the
// authored declaredAssertions stay ADVISORY (preserved as provenance, never the
// must-gate oracle). An expected value NEVER becomes a page-identity oracle here.
//   { intentClass, confidence, basis, requiredEvidence[], advisoryExpectations[], contractDeltas[] }
// requiredEvidence kinds: page_present{page,urlPattern?} | destination_absent{destinationHint}
//   | field_error{fieldRole,messageClass,expectedText?} | error_present{messageClass,expectedText?}
//   | empty_result{expectedText?} | page_settled
// ─────────────────────────────────────────────────────────────────────────────
const DEST_COLUMN_RE = /(landing|destination|redirect|navigates?to|target_?page|expected_?url|expected_?page|goesto|lands?on)/i;
const ERR_COLUMN_RE = /(error|message|validation|expected_?msg|expected_?err|required_?message|inline_?error)/i;

function findRawColumnValue(raw, re) {
  if (!raw || typeof raw !== 'object') return null;
  for (const [header, v] of Object.entries(raw)) {
    if (re.test(header) && v != null && String(v).trim() !== '') return { column: header, value: String(v).trim() };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// COLUMN-ROLE DETECTION (Phase A — Test Data Intelligence)
//
// Identify what each sheet column MEANS, generically (keyed off header SHAPE,
// never a site string), so the contract builder + the pre-generation preview
// know inputs from expectations. Roles:
//   input | class_label | destination | error | absence | presence
//   | expected_count | empty_state | metadata | unknown
// This is a HINT (like the row classifier): the architect's columnToField is
// authoritative for actual step inputs, and live evidence is the backstop.
// Overloaded terms ("note"/"description") default to input on purpose.
// ─────────────────────────────────────────────────────────────────────────────
const COLROLE_CLASS_RE = /(scenario_?name|scenario_?type|row_?class|test_?type|test_?case_?type|variant|disposition|outcome_?class|case_?class)/i;
const COLROLE_ABSENCE_RE = /(hidden|forbidden|not_?visible|must_?not|absent|disallow|denied|restricted|does_?not|not_?contain|exclude|without)/i;
const COLROLE_PRESENCE_RE = /(visible|shown|should_?see|allowed_?items|granted|contains|includes?)/i;
const COLROLE_COUNT_RE = /(result_?count|num_?results|expected_?count|notes?_?count|item_?count|row_?count|count_?of)/i;
const COLROLE_EMPTYSTATE_RE = /(empty_?state|no_?results|is_?empty|zero_?results)/i;
const COLROLE_METADATA_RE = /(sensitivity|priority|^risk$|severity|^tags?$|comment|test_?case_?id|^ticket|^id$|timestamp|created_?by|updated_?by|^author$|definition_?of_?done|^dod$|^module$|^epic$)/i;

function detectColumnRole(header) {
  const h = String(header == null ? '' : header).trim();
  if (!h) return 'unknown';
  // Precedence: explicit class > absence > presence > error > destination >
  // count > empty_state > metadata > input (default).
  if (COLROLE_CLASS_RE.test(h)) return 'class_label';
  if (COLROLE_ABSENCE_RE.test(h)) return 'absence';
  if (COLROLE_PRESENCE_RE.test(h)) return 'presence';
  if (ERR_COLUMN_RE.test(h)) return 'error';
  if (DEST_COLUMN_RE.test(h)) return 'destination';
  if (COLROLE_COUNT_RE.test(h)) return 'expected_count';
  if (COLROLE_EMPTYSTATE_RE.test(h)) return 'empty_state';
  if (COLROLE_METADATA_RE.test(h)) return 'metadata';
  return 'input';
}

function detectColumnRoles(headers) {
  const out = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    if (h == null || String(h).trim() === '') continue;
    out[String(h)] = detectColumnRole(h);
  }
  return out;
}

function buildRowEvidenceContract(row) {
  const cls = classifyRowOutcomeClass(row);
  const raw = (row && row.raw && typeof row.raw === 'object') ? row.raw : {};
  const inputs = (row && row.inputs && typeof row.inputs === 'object') ? row.inputs : {};
  const expected = (row && row.expectedColumn && row.expected != null) ? String(row.expected).trim() : '';
  const expectedIsUrl = expectedLooksLikeUrl(expected);
  const expectedIsAuthPage = expectedIsUrl && OUTCOME_AUTH_PAGE_RE.test(expected.toLowerCase());

  // Destination + error hints — from the designated expected column AND a
  // defensive raw-column scan (a sheet may carry BOTH a landing column and an
  // error column; the binding designates only one as expectedColumn).
  let destination = (expectedIsUrl && !expectedIsAuthPage) ? expected : null;
  let destinationSource = destination ? row.expectedColumn : null;
  if (!destination) {
    const d = findRawColumnValue(raw, DEST_COLUMN_RE);
    if (d && expectedLooksLikeUrl(d.value) && !OUTCOME_AUTH_PAGE_RE.test(d.value.toLowerCase())) {
      destination = d.value; destinationSource = d.column;
    }
  }
  let errorText = (!expectedIsUrl && expected) ? expected : null;
  let errorSource = errorText ? row.expectedColumn : null;
  if (!errorText) {
    const e = findRawColumnValue(raw, ERR_COLUMN_RE);
    if (e) { errorText = e.value; errorSource = e.column; }
  }

  const advisoryExpectations = [];
  if (expected) advisoryExpectations.push({ source: row.expectedColumn, value: expected });
  if (errorText && errorSource && errorSource !== row.expectedColumn) advisoryExpectations.push({ source: errorSource, value: errorText });
  if (destination && destinationSource && destinationSource !== row.expectedColumn) advisoryExpectations.push({ source: destinationSource, value: destination });

  const contractDeltas = [];
  const negativeIntent = cls.class === 'required_validation' || cls.class === 'auth_rejection' || cls.class === 'boundary';
  // CONFLICT: the row's intent is negative (stay/reject) yet a real success
  // destination is also specified. Do NOT choose silently — record the delta and
  // let INTENT be primary (require staying + destination ABSENT).
  if (negativeIntent && destination) {
    contractDeltas.push({
      kind: 'destination_vs_intent_conflict',
      intentClass: cls.class,
      destination,
      destinationSource,
      note: `row intent "${cls.class}" expects to stay/reject, but column "${destinationSource}" points at destination "${destination}". Intent is primary; the destination must be ABSENT.`,
    });
  }

  // field_error scope = the actually-blank input field(s) (reliable regardless of
  // how the row was classified).
  const blankInputFields = Object.entries(inputs).filter(([, v]) => v == null || String(v).trim() === '').map(([k]) => k);

  // Is this a LOGIN row? Detected by its credential columns (a username/email/login
  // input AND a password input) — generic, no site strings. Only a login row gets the
  // login_form_present composite signal (a non-login negative row, e.g. empty-name on
  // a create-user form, must NOT require a login form to be visible).
  const __ikeys = Object.keys(inputs).map((k) => k.toLowerCase());
  const isLoginRow = __ikeys.some((k) => /pass|pwd/.test(k)) && __ikeys.some((k) => /user|email|login|account/.test(k));

  // sourceColumns — the columns that materially drove THIS row's intent +
  // evidence (the outcome/class/destination/error columns, not the input
  // columns). Surfaced in the preview matrix so a reviewer can trace why a row
  // was classified as it was. Presence/absence columns are added in the success
  // branch below.
  const sourceColumns = new Set(
    [row.expectedColumn, row.rowClassColumn, destinationSource, errorSource].filter(Boolean),
  );

  const requiredEvidence = [];
  switch (cls.class) {
    case 'success':
      // review P1b — only require a SPECIFIC destination when one is known;
      // otherwise require advancing OFF the entry/login page (a checkable success
      // proxy) instead of a vague page_present(destination, urlPattern:null).
      if (destination) requiredEvidence.push({ kind: 'page_present', page: 'destination', urlPattern: destination });
      else requiredEvidence.push({ kind: 'destination_absent', destinationHint: 'entry', note: 'success: must advance off the entry/login page' });
      break;
    case 'required_validation': {
      requiredEvidence.push({ kind: 'page_present', page: 'entry' });
      if (isLoginRow) requiredEvidence.push({ kind: 'login_form_present' }); // composite 4th signal (login rows only)
      requiredEvidence.push({ kind: 'destination_absent', destinationHint: destination || 'authenticated_area' });
      const fields = blankInputFields.length ? blankInputFields : [null];
      for (const f of fields) requiredEvidence.push({ kind: 'field_error', fieldRole: f, messageClass: 'required', expectedText: errorText || null });
      break;
    }
    case 'auth_rejection':
      requiredEvidence.push({ kind: 'page_present', page: 'entry' });
      if (isLoginRow) requiredEvidence.push({ kind: 'login_form_present' }); // composite 4th signal (login rows only)
      requiredEvidence.push({ kind: 'destination_absent', destinationHint: destination || 'authenticated_area' });
      requiredEvidence.push({ kind: 'error_present', messageClass: 'auth', expectedText: errorText || null });
      break;
    case 'boundary':
      requiredEvidence.push({ kind: 'page_present', page: 'entry' });
      requiredEvidence.push({ kind: 'empty_result', expectedText: errorText || null });
      break;
    default:
      // unknown — minimal "page settled" requirement, LOW confidence. The
      // Conductor resolves the real evidence from the live page; never silently
      // certified as pass.
      requiredEvidence.push({ kind: 'page_settled' });
      break;
  }

  // Role-access evidence: a SUCCESS row may carry presence/absence columns
  // (e.g. expectedVisibleMenuItems / expectedHiddenMenuItems) listing items that
  // must be present/absent AFTER authentication. Keyed off detected column ROLE,
  // never a site string. (Their deterministic checkers land with Phase B; until
  // then the Conductor reports them unobservable -> not_judged, never fake-pass.)
  if (cls.class === 'success') {
    const roles = detectColumnRoles(Object.keys(raw));
    for (const [col, role] of Object.entries(roles)) {
      if (role !== 'presence' && role !== 'absence') continue;
      const val = raw[col];
      if (val == null || String(val).trim() === '') continue;
      sourceColumns.add(col);
      const labels = String(val).split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
      for (const label of labels) {
        requiredEvidence.push(role === 'presence'
          ? { kind: 'element_present', label, sourceColumn: col }
          : { kind: 'element_absent', label, sourceColumn: col });
      }
    }
  }

  return {
    intentClass: cls.class,
    confidence: cls.confidence,
    basis: cls.basis,
    sourceColumns: Array.from(sourceColumns),
    requiredEvidence,
    advisoryExpectations,
    contractDeltas,
  };
}

function buildDataRowGuidance(row) {
  const lines = [
    '',
    '--- DATA-DRIVEN ITERATION (one row of a test-data matrix) ---',
    `Data set "${row.setName}" · ${row.label}.`,
    'This block is data, not a step list. Follow the backend-approved current',
    'step contract in order and use only the values for this single row.',
    'Use exactly these current-row input values when a step asks for them:',
  ];
  for (const [role, v] of Object.entries(row.inputs || {})) {
    lines.push(`  • ${role} = ${JSON.stringify(v)}`);
  }
  if (row.expectedColumn && row.expected != null && String(row.expected).trim() !== '') {
    const cls = row.rowClass != null && String(row.rowClass).trim() !== '' ? ` (${String(row.rowClass).trim()} case)` : '';
    lines.push(`Expected result for this row${cls} (ADVISORY — from the uploaded data): ${JSON.stringify(row.expected)}.`);
    lines.push('Judge by what SHOULD happen for this row\'s intent, NOT by exact-matching this value. If the page behaves correctly but the wording/value differs, that is a PASS — report the difference as a delta. If the uploaded expectation contradicts the test\'s intent, follow the intent and note the discrepancy.');
  }
  return lines.join('\n');
}

/**
 * Return a shallow clone of the case with the row substituted in. The original
 * tc is never mutated. steps may be a JSON string (persisted shape) or an
 * array; the clone preserves whichever shape it received.
 */
function substituteCase(tc, row) {
  if (!tc || !row) return tc;
  if (row.inlineInstance === true) return materializeInlineCaseInstance(tc, row);
  const tokenMap = buildTokenMap(row);
  const clone = { ...tc };

  // steps — JSON-encoded string OR array of step objects.
  const stepsWasArray = Array.isArray(tc.steps);
  const stepsArr = stepsWasArray ? tc.steps : decode(tc.steps, null);
  if (Array.isArray(stepsArr)) {
    const sub = stepsArr.map((s) => {
      if (typeof s === 'string') return fillTokens(s, tokenMap);
      if (!s || typeof s !== 'object') return s;
      const o = { ...s, raw: s.raw && typeof s.raw === 'object' ? { ...s.raw } : { ...s } };
      for (const f of ['action', 'target', 'element', 'locator_hint', 'value', 'expected']) {
        if (typeof o[f] !== 'string') continue;
        const originalField = o[f];
        for (const [key, val] of Object.entries(tokenMap)) {
          const tokenRe = new RegExp(`\\{\\{\\s*${String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'gi');
          if (tokenRe.test(o[f]) || o[f] === String(val)) {
            o.raw.dataBinding = { isDataBound: true, sourceColumn: key, source: 'strict_token_compiler' };
            o.dataBinding = o.raw.dataBinding;
            o[f] = o[f].replace(tokenRe, formatTokenValue(val));
          }
        }
        o[f] = fillTokens(o[f], tokenMap);
        // #36c — typed fidelity: when the VALUE/EXPECTED field was exactly one
        // whole-string token, keep the underlying number/boolean type (dates are
        // formatted). Locator/target/action stay strings (they index the DOM).
        if (f === 'value' || f === 'expected') {
          const typed = resolveWholeTokenValue(originalField, tokenMap);
          if (typed.matched && (typeof typed.value === 'number' || typeof typed.value === 'boolean')) {
            o[f] = typed.value;
          }
        }
      }
      for (const nestedField of ['operationCheck', 'syncState', 'sync_state']) {
        if (!o[nestedField] || typeof o[nestedField] !== 'object') continue;
        const nestedText = JSON.stringify(o[nestedField]);
        for (const [key, val] of Object.entries(tokenMap)) {
          const tokenRe = new RegExp(`\\{\\{\\s*${String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'i');
          if (tokenRe.test(nestedText) || nestedText === JSON.stringify(String(val))) {
            o.raw.dataBinding = { isDataBound: true, sourceColumn: key, source: 'strict_token_compiler' };
            o.dataBinding = o.raw.dataBinding;
          }
        }
        o[nestedField] = fillTokensDeep(o[nestedField], tokenMap);
      }
      // FINAL DEEP FILL — resolve {{tokens}} in EVERY remaining field the hardcoded
      // list above does not cover, notably the typed `verify` contract
      // (verify.equals / verify.value) and the preserved `raw` step copy. Without
      // this the typed checker would compare the field against a literal
      // "{{username}}" (always failing) AND the execution-time unresolved-token gate
      // would block the row even though value/element already resolved. fillTokensDeep
      // only rewrites {{...}} occurrences, so all non-token text is left intact.
      return fillTokensDeep(o, tokenMap);
    });
    clone.steps = stepsWasArray ? sub : JSON.stringify(sub);
  }

  // declaredAssertions — JSON-encoded string of structured records.
  const daArr = decode(tc.declaredAssertions, null);
  if (Array.isArray(daArr)) {
    clone.declaredAssertions = JSON.stringify(
      daArr.map((a) => bindExpectedColumnToAssertion(substituteAssertion(a, tokenMap), row))
    );
  }

  // free-form assertions prose + the data-row guidance block.
  clone.assertions = fillTokens(tc.assertions || '', tokenMap) + buildDataRowGuidance(row);

  return clone;
}

// #36a — EXECUTION-TIME UNRESOLVED-TOKEN GATE. After substituteCase, any
// remaining {{token}} in the case's steps OR declaredAssertions means the row
// did not supply a value for that placeholder (unknown tokens are left verbatim
// by fillTokens — never blanked). Running such a step would type/assert the
// literal text "{{token}}", which is quietly-wrong. The conductor calls this to
// detect that condition and block the row honestly instead. Returns the unique,
// sorted list of unresolved token KEYS (without braces); empty when clean.
function findUnresolvedTokens(caseObj) {
  if (!caseObj || typeof caseObj !== 'object') return [];
  const found = new Set();
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  const scan = (value) => {
    if (typeof value === 'string') {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(value))) {
        const key = String(m[1] || '').trim();
        if (key) found.add(key);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) scan(item);
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) scan(v);
    }
  };
  // Only the executable surfaces: steps + declaredAssertions. The free-form
  // `assertions` prose carries the DATA-DRIVEN ITERATION guidance block and is
  // narration, not a contract, so a stray brace there must not block a row.
  const stepsArr = Array.isArray(caseObj.steps) ? caseObj.steps : decode(caseObj.steps, null);
  if (stepsArr != null) scan(stepsArr);
  const daArr = decode(caseObj.declaredAssertions, null);
  if (daArr != null) scan(daArr);
  return Array.from(found).sort();
}

module.exports = {
  resolveCaseRows,
  resolveInlineCaseRows,
  classifyRowOutcomeClass,
  classifyOutcomeWord,
  detectColumnRole,
  detectColumnRoles,
  buildRowEvidenceContract,
  buildDataRowGuidance,
  expectedPageProfile,
  bindExpectedColumnToAssertion,
  substituteCase,
  materializeInlineCaseInstance,
  findUnresolvedTokens,
  caseConsumesOnlyCredentials,
  consumedTokenKeys,
  // exported for the guard / future callers
  buildRowLabel,
  inferCaseRowScope,
  filterRowsByCaseIntent,
  validateCaseDataBinding,
  materializeInlineEvidenceTokens,
  buildTokenMap,
  fillTokens,
  formatTokenValue,
  buildForeignKeyJoins,
  pickDefaultCompanionRow,
  hydrateBinding,
  resolveCaseDataSource,
  resolveSheetStrict,
  resolveMappingBindingStrict,
  resolvePinnedRows,
  filterRowsBySelector,
  filterRowsByCaseScope,
  sheetsFromTestData,
  mappingFromTestData,
  bindExpectedColumnToAssertion,
  mappingBindingFor,
  MAX_ROWS_PER_CASE,
  ROUND_B_VERSION,
};
