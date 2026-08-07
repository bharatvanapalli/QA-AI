'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 'qaai.reliability.schema.v1';
const CONTRACT_VERSION = 'qaai.reliability.contract.v1';

const CASE_RELIABILITY_STATUS = Object.freeze({
  PREVIEW: 'preview',
  RELIABLE: 'reliable',
  REPAIRED_RELIABLE: 'repaired_reliable',
  NEEDS_REPAIR: 'needs_repair',
  NEEDS_USER_DECISION: 'needs_user_decision',
  ACCEPTED_EXCEPTION: 'accepted_exception',
  LEGACY_UNVERIFIED: 'legacy_unverified',
});

const SUITE_RELIABILITY_STATUS = Object.freeze({
  PREVIEW: 'preview',
  READY: 'ready',
  READY_WITH_USER_DECISIONS: 'ready_with_user_decisions',
  NEEDS_REPAIR: 'needs_repair',
  NEEDS_USER_DECISION: 'needs_user_decision',
  LEGACY_UNVERIFIED: 'legacy_unverified',
});

const RELIABILITY_SEVERITY = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  REPAIR_REQUIRED: 'repair_required',
  USER_DECISION_REQUIRED: 'user_decision_required',
  CRITICAL: 'critical',
});

const DEFECT_RESOLUTION_STATUS = Object.freeze({
  OPEN: 'open',
  AUTO_REPAIRED: 'auto_repaired',
  USER_ACCEPTED: 'user_accepted',
  DISMISSED: 'dismissed',
  SUPERSEDED: 'superseded',
});

const DEFECT_FAMILY = Object.freeze({
  COVERAGE: 'coverage',
  STEP_SHAPE: 'step_shape',
  DATA_BINDING: 'data_binding',
  SEMANTIC_QUALITY: 'semantic_quality',
  APP_CAPABILITY: 'app_capability',
  EXECUTION_PROOF: 'execution_proof',
  TRACEABILITY: 'traceability',
  BROWSER_ACTION: 'browser_action',
  ORACLE: 'oracle',
  REPAIR_MERGE: 'repair_merge',
  SYSTEM: 'system',
});

const SCENARIO_ACTIONS = Object.freeze([
  'navigate',
  'fill',
  'click',
  'select',
  'check',
  'upload',
  'assertText',
  'assertUrl',
  'assertVisible',
  'waitFor',
]);

const DEFECT_SEVERITY_MATRIX = Object.freeze({
  coverage_missing_required: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  coverage_required_missing: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  verify_kind_none: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  missing_required_story_field: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  token_collision: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  double_encoded_steps: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  unregistered_browser_action: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  non_exportable_action: RELIABILITY_SEVERITY.USER_DECISION_REQUIRED,
  generic_orangehrm_flow: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  cross_module_requirement_ref: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  weak_oracle: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  proposed_data_mapping: RELIABILITY_SEVERITY.USER_DECISION_REQUIRED,
  missing_approved_data: RELIABILITY_SEVERITY.USER_DECISION_REQUIRED,
  missing_app_capability: RELIABILITY_SEVERITY.USER_DECISION_REQUIRED,
  stale_app_capability: RELIABILITY_SEVERITY.USER_DECISION_REQUIRED,
  execution_dry_run_failed: RELIABILITY_SEVERITY.WARNING,
  flaky_after_retry: RELIABILITY_SEVERITY.WARNING,
  repair_introduced_regression: RELIABILITY_SEVERITY.CRITICAL,
  llm_repair_failed: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  benchmark_runner_crashed: RELIABILITY_SEVERITY.WARNING,
  missing_row_execution_plan: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  invalid_row_execution_plan: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  silent_row_skip: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  missing_data_lineage: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
  missing_structured_oracle: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
});

const REPAIR_STOP_REASON = Object.freeze({
  ALL_CONTRACTS_PASSED: 'all_contracts_passed',
  MAX_ROUNDS_REACHED: 'max_rounds_reached',
  SAME_DEFECT_REPEATED: 'same_defect_repeated',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  MISSING_BUSINESS_DECISION: 'missing_business_decision',
  MISSING_APP_CAPABILITY: 'missing_app_capability',
  MISSING_APPROVED_DATA: 'missing_approved_data',
  LLM_REPAIR_FAILED: 'llm_repair_failed',
  TOOL_FAILURE: 'tool_failure',
  CANCELLED: 'cancelled',
});

function withContractVersions(value = {}) {
  return {
    schemaVersion: value.schemaVersion || SCHEMA_VERSION,
    contractVersion: value.contractVersion || CONTRACT_VERSION,
    ...value,
  };
}

function idFor(prefix) {
  if (crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function compactArray(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item != null && item !== '');
}

function severityForCode(code, fallback = RELIABILITY_SEVERITY.WARNING) {
  return DEFECT_SEVERITY_MATRIX[String(code || '')] || fallback;
}

function familyForCode(code) {
  const value = String(code || '');
  if (value.includes('coverage')) return DEFECT_FAMILY.COVERAGE;
  if (value.includes('step') || value.includes('encoded')) return DEFECT_FAMILY.STEP_SHAPE;
  if (value.includes('data') || value.includes('token') || value.includes('mapping')) return DEFECT_FAMILY.DATA_BINDING;
  if (value.includes('oracle') || value.includes('verify')) return DEFECT_FAMILY.ORACLE;
  if (value.includes('action')) return DEFECT_FAMILY.BROWSER_ACTION;
  if (value.includes('capability')) return DEFECT_FAMILY.APP_CAPABILITY;
  if (value.includes('execution') || value.includes('flaky')) return DEFECT_FAMILY.EXECUTION_PROOF;
  if (value.includes('repair')) return DEFECT_FAMILY.REPAIR_MERGE;
  return DEFECT_FAMILY.SYSTEM;
}

function createReliabilityDefect({
  code,
  severity,
  resolutionStatus = DEFECT_RESOLUTION_STATUS.OPEN,
  family,
  caseId,
  coverageRef,
  dataBindingId,
  rowId,
  message,
  repairable,
  userDecisionAllowed,
  evidence,
} = {}) {
  const finalCode = String(code || 'unknown_reliability_defect');
  const finalSeverity = severity || severityForCode(finalCode);
  return withContractVersions({
    id: idFor('defect'),
    code: finalCode,
    severity: finalSeverity,
    resolutionStatus,
    family: family || familyForCode(finalCode),
    caseId: caseId || undefined,
    coverageRef: coverageRef || undefined,
    dataBindingId: dataBindingId || undefined,
    rowId: rowId || undefined,
    message: message || finalCode,
    repairable: typeof repairable === 'boolean'
      ? repairable
      : finalSeverity === RELIABILITY_SEVERITY.REPAIR_REQUIRED || finalSeverity === RELIABILITY_SEVERITY.CRITICAL,
    userDecisionAllowed: typeof userDecisionAllowed === 'boolean'
      ? userDecisionAllowed
      : finalSeverity === RELIABILITY_SEVERITY.USER_DECISION_REQUIRED,
    evidence: evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {},
  });
}

function normalizeStepsInput(value, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 5;
  const allowSingletonObject = !!options.allowSingletonObject;
  let current = value;
  let decodedDepth = 0;

  while (typeof current === 'string' && decodedDepth < maxDepth) {
    const trimmed = current.trim();
    if (!trimmed) {
      return { ok: true, steps: [], decodedDepth, repaired: decodedDepth > 0, defect: null };
    }
    try {
      current = JSON.parse(trimmed);
      decodedDepth += 1;
    } catch (err) {
      return {
        ok: false,
        steps: [],
        decodedDepth,
        repaired: decodedDepth > 0,
        defect: createReliabilityDefect({
          code: 'malformed_steps_json',
          severity: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
          family: DEFECT_FAMILY.STEP_SHAPE,
          message: `Steps could not be parsed as JSON: ${err.message}`,
          evidence: { sample: trimmed.slice(0, 240) },
        }),
      };
    }
  }

  if (Array.isArray(current)) {
    const defects = [];
    const steps = current;
    if (decodedDepth > 1) {
      defects.push(createReliabilityDefect({
        code: 'double_encoded_steps',
        resolutionStatus: DEFECT_RESOLUTION_STATUS.AUTO_REPAIRED,
        family: DEFECT_FAMILY.STEP_SHAPE,
        message: 'Steps were JSON-encoded more than once and were normalized to an array.',
        evidence: { decodedDepth },
      }));
    }
    return {
      ok: true,
      steps,
      decodedDepth,
      repaired: decodedDepth > 1,
      defect: defects[0] || null,
      defects,
    };
  }

  if (current && typeof current === 'object' && allowSingletonObject) {
    return {
      ok: true,
      steps: [current],
      decodedDepth,
      repaired: decodedDepth > 0,
      defect: null,
      defects: [],
    };
  }

  return {
    ok: false,
    steps: [],
    decodedDepth,
    repaired: decodedDepth > 0,
    defect: createReliabilityDefect({
      code: 'invalid_steps_shape',
      severity: RELIABILITY_SEVERITY.REPAIR_REQUIRED,
      family: DEFECT_FAMILY.STEP_SHAPE,
      message: 'Steps must normalize to an array.',
      evidence: { type: Array.isArray(current) ? 'array' : typeof current },
    }),
  };
}

function normalizeStepsStrict(value, options = {}) {
  const result = normalizeStepsInput(value, { ...options, allowSingletonObject: false });
  if (!result.ok) {
    const err = new Error(result.defect ? result.defect.message : 'Steps must normalize to an array.');
    err.code = 'INVALID_STEPS_SHAPE';
    err.defect = result.defect;
    throw err;
  }
  return result.steps;
}

function coverageDefectsFromValidation(validation) {
  const findings = Array.isArray(validation && validation.findings) ? validation.findings : [];
  return findings
    .filter((finding) => finding && finding.severity === 'error')
    .map((finding) => {
      const originalCode = String(finding.code || 'coverage_error');
      const code = originalCode === 'coverage_required_missing' ? 'coverage_missing_required' : originalCode;
      return createReliabilityDefect({
        code,
        severity: severityForCode(code, RELIABILITY_SEVERITY.REPAIR_REQUIRED),
        family: DEFECT_FAMILY.COVERAGE,
        coverageRef: finding.manifestItemId || finding.coverageRef || undefined,
        message: code === 'coverage_missing_required'
          ? `Required coverage item was not generated: ${finding.manifestItemId || 'unknown'}`
          : `Coverage validation failed: ${originalCode}`,
        evidence: { ...finding, originalCode },
      });
    });
}

const STEP_ACTION_ALIASES = Object.freeze({
  navigate: 'navigate',
  goback: 'navigate',
  goforward: 'navigate',
  refresh: 'navigate',
  reload: 'navigate',
  open: 'navigate',
  goto: 'navigate',
  fill: 'fill',
  type: 'fill',
  input: 'fill',
  enter: 'fill',
  append: 'fill',
  clear: 'fill',
  clearandtype: 'fill',
  click: 'click',
  rightclick: 'click',
  middleclick: 'click',
  clickandhold: 'click',
  hoverandclick: 'click',
  tap: 'click',
  press: 'click',
  submit: 'click',
  doubleclick: 'click',
  presskey: 'click',
  hotkey: 'click',
  select: 'select',
  choose: 'select',
  deselect: 'select',
  multiselect: 'select',
  check: 'check',
  uncheck: 'check',
  upload: 'upload',
  drag: 'click',
  draganddrop: 'click',
  slider: 'fill',
  acceptalert: 'click',
  dismissalert: 'click',
  typealert: 'fill',
  copy: 'click',
  paste: 'fill',
  extractdata: 'wait',
  storevariable: 'wait',
  switchcontext: 'wait',
  switchtab: 'wait',
  switchframe: 'wait',
  accessshadow: 'wait',
  scrollintoview: 'wait',
  scrolltotop: 'wait',
  scrolltobottom: 'wait',
  findrow: 'wait',
  countrows: 'assertVisible',
  sortcolumn: 'click',
  verify: 'assertVisible',
  assert: 'assertVisible',
  see: 'assertVisible',
  confirm: 'assertVisible',
  ensure: 'assertVisible',
  asserttext: 'assertText',
  asserturl: 'assertUrl',
  assertvisible: 'assertVisible',
  assertdisabled: 'assertVisible',
  assertenabled: 'assertVisible',
  assertreadonly: 'assertVisible',
  assertvalue: 'assertText',
  assertchecked: 'assertVisible',
  assertselected: 'assertVisible',
  wait: 'waitFor',
  waitfor: 'waitFor',
});

function normalizeStepAction(action, verify) {
  const raw = String(action || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (raw === 'verify' || raw === 'assert') {
    const kind = String((verify && verify.kind) || '').trim().toLowerCase();
    if (kind === 'text' || kind === 'visible_text') return 'assertText';
    if (kind === 'url') return 'assertUrl';
    return 'assertVisible';
  }
  return STEP_ACTION_ALIASES[raw] || null;
}

function registryCanonicalForAction(canonicalAction) {
  if (canonicalAction === 'waitFor') return 'wait';
  if (canonicalAction === 'assertText' || canonicalAction === 'assertUrl' || canonicalAction === 'assertVisible') return 'assert';
  return canonicalAction;
}

function isRegisteredCanonicalAction(canonicalAction) {
  const registryAction = registryCanonicalForAction(canonicalAction);
  if (!registryAction) return false;
  try {
    const registry = require('../browserActionRegistry');
    if (registryAction === 'assert') return !!registry.getActionEntry('assertion_check');
    if (registryAction === 'wait') return !!registry.getActionEntry('browser_wait_for');
    return Object.values(registry.REGISTRY || {}).some((entry) => (
      entry && entry.kind !== 'utility' && entry.canonicalAction === registryAction
    ));
  } catch (_) {
    return false;
  }
}

function buildBrowserActionBinding(step = {}, options = {}) {
  const stepId = options.stepId || step.id || step.stepId || idFor('step');
  const canonicalAction = normalizeStepAction(step.action, step.verify) || 'manual';
  const registryAction = registryCanonicalForAction(canonicalAction);
  let registryEntry = null;
  try {
    const registry = require('../browserActionRegistry');
    if (registryAction === 'assert') registryEntry = registry.getActionEntry('assertion_check');
    else if (registryAction === 'wait') registryEntry = registry.getActionEntry('browser_wait_for');
    else {
      registryEntry = Object.values(registry.REGISTRY || {}).find((entry) => (
        entry && entry.kind !== 'utility' && entry.canonicalAction === registryAction
      )) || null;
    }
  } catch (_) {
    registryEntry = null;
  }
  return withContractVersions({
    stepId,
    registryAction: registryEntry ? registryEntry.tool : registryAction,
    canonicalAction,
    exportable: !!(registryEntry && registryEntry.exportable !== false),
    codegenFallback: registryEntry ? registryEntry.codegenFallback : 'block_certification',
    locator: step.locator || step.locator_hint || step.selector || undefined,
    locatorStrategy: step.locatorStrategy || step.locator_strategy || undefined,
    selectorConfidence: Number.isFinite(Number(step.selectorConfidence)) ? Number(step.selectorConfidence) : undefined,
  });
}

function buildScenarioStep(step = {}, options = {}) {
  const order = Number.isFinite(Number(step.order)) ? Number(step.order) : Number(options.index || 0) + 1;
  const id = step.id || step.stepId || `${options.caseId || 'case'}-step-${order}`;
  const action = normalizeStepAction(step.action, step.verify) || step.action || 'waitFor';
  const value = step.value != null ? step.value : (step.text != null ? step.text : step.input);
  return withContractVersions({
    id,
    order,
    action,
    target: clean(step.target || step.element || step.field || step.label || step.locator_hint || ''),
    valueToken: typeof value === 'string' && /^\s*\{\{[^}]+}}\s*$/.test(value) ? clean(value) : undefined,
    valueLiteral: typeof value === 'string' && /^\s*\{\{[^}]+}}\s*$/.test(value) ? undefined : value,
    dataLineage: step.dataLineage || undefined,
    oracle: step.oracle || undefined,
    coverageRefs: compactArray(step.coverageRefs || options.coverageRefs),
    browserActionBinding: step.browserActionBinding || buildBrowserActionBinding(step, { stepId: id }),
    source: step.source || options.source || 'architect',
  });
}

function rowMappingStatus(binding = {}, rowId) {
  if (!rowId || !binding || typeof binding !== 'object') return null;
  const sources = [binding.rowMappingStatus, binding.rowMappingStatuses, binding.rowStatuses, binding.rowStatusById];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const value = source[rowId];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return value.mappingStatus || value.status || value.source || null;
  }
  const rows = Array.isArray(binding.rows) ? binding.rows : (Array.isArray(binding.resolvedRows) ? binding.resolvedRows : []);
  const row = rows.find((item, index) => rowIdFromValue(item, index) === rowId);
  if (row && typeof row === 'object') return row.mappingStatus || row.status || row.source || null;
  return null;
}

function mappingStatusForBinding(binding = {}, rowId = undefined) {
  const raw = clean(rowMappingStatus(binding, rowId) || binding.mappingStatus || binding.status || binding.source || '').toLowerCase();
  if (raw === 'approved' || raw === 'complete_approved') return 'approved';
  if (raw === 'rejected') return 'rejected';
  if (raw === 'needs_mapping' || raw === 'incomplete') return 'needs_mapping';
  if (raw === 'draft' || raw === 'proposed' || raw === 'needs_review' || binding.needsReview === true) return 'proposed';
  return binding.sheet ? 'proposed' : 'needs_mapping';
}

function rowIdFromValue(value, index) {
  if (value && typeof value === 'object') return clean(value.id || value.rowId || value.key || value.index || value.rowIndex || index + 1);
  return clean(value || index + 1);
}

function rowIntentFromValue(value, binding = {}) {
  if (value && typeof value === 'object') return clean(value.intent || value.rowIntent || value.caseIntent || value.class || value.rowClass || value.type);
  return clean(binding.rowIntent || binding.intent || binding.rowSelector);
}

function buildRowExecutionPlan(caseObj = {}) {
  const binding = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : null;
  const existing = caseObj.rowExecutionPlan && typeof caseObj.rowExecutionPlan === 'object'
    ? caseObj.rowExecutionPlan
    : (binding && binding.rowExecutionPlan && typeof binding.rowExecutionPlan === 'object' ? binding.rowExecutionPlan : null);
  if (!binding || !binding.sheet) return existing ? withContractVersions(existing) : null;
  const sourceRows = compactArray(
    existing?.rowIds
      || binding.rowIds
      || binding.resolvedRowIds
      || binding.selectedRowIds
      || binding.rows
      || binding.resolvedRows
      || caseObj.rowIds
      || caseObj.dataRowIds
      || [],
  );
  const rowIds = sourceRows.map((row, index) => rowIdFromValue(row, index)).filter(Boolean);
  const rows = sourceRows.map((row, index) => ({
    rowId: rowIdFromValue(row, index),
    intent: rowIntentFromValue(row, binding) || undefined,
    source: row && typeof row === 'object' ? clean(row.source || row.rowSource || binding.source || 'data_binding') : clean(binding.source || 'data_binding'),
  })).filter((row) => row.rowId);
  const rowIntents = compactArray([
    ...(Array.isArray(existing?.rowIntents) ? existing.rowIntents : []),
    ...(Array.isArray(binding.rowIntents) ? binding.rowIntents : []),
    caseObj.rowIntent,
    binding.rowIntent,
    binding.intent,
    binding.rowSelector,
    ...rows.map((row) => row.intent),
  ]);
  const skippedRows = compactArray(existing?.skippedRows || binding.skippedRows || []);
  const skipReasons = (existing?.skipReasons && typeof existing.skipReasons === 'object')
    ? existing.skipReasons
    : ((binding.skipReasons && typeof binding.skipReasons === 'object') ? binding.skipReasons : {});
  const executionMode = existing?.executionMode
    || binding.executionMode
    || (rowIds.length > 1 ? 'per_row' : 'single');
  return withContractVersions({
    caseId: caseObj.id || caseObj.caseId || '',
    dataBindingId: binding.id || binding.mappingId || undefined,
    rowIds,
    executionMode: ['single', 'per_row', 'matrix'].includes(executionMode) ? executionMode : 'single',
    skippedRows,
    skipReasons,
    rowIntents: Array.from(new Set(rowIntents.map(clean).filter(Boolean))),
    rows,
  });
}

function resolveTokenColumn(token, binding = {}) {
  const wanted = norm(token);
  const c2f = binding && binding.columnToField && typeof binding.columnToField === 'object' ? binding.columnToField : {};
  for (const [role, column] of Object.entries(c2f)) {
    if (norm(role) === wanted || norm(column) === wanted) return clean(column || role);
  }
  if (binding.expectedColumn && (wanted === 'expected' || norm(binding.expectedColumn) === wanted)) return clean(binding.expectedColumn);
  return null;
}

function buildDataLineage({ token, binding = {}, rowId, rowIndex = 0 } = {}) {
  const columnName = resolveTokenColumn(token, binding);
  if (!binding || !binding.sheet || !columnName) return null;
  return withContractVersions({
    sheetName: clean(binding.sheet),
    rowIndex: Number.isFinite(Number(rowIndex)) ? Number(rowIndex) : 0,
    rowId: rowId || undefined,
    columnName,
    token: clean(token),
    mappingStatus: mappingStatusForBinding(binding, rowId),
    approvedBy: binding.approvedBy || undefined,
    approvedAt: binding.approvedAt || undefined,
    mappingVersion: clean(binding.mappingVersion || binding.version || 'unversioned'),
  });
}

function stepLineageForToken(step = {}, token, rowId = undefined) {
  const wanted = norm(token);
  const lineages = compactArray(step.dataLineage || step.dataLineages);
  return lineages.find((lineage) => {
    if (!lineage || norm(lineage.token) !== wanted) return false;
    if (norm(lineage.sheetName) === 'executionprofile') return true;
    if (rowId == null || rowId === undefined) return true;
    return !lineage.rowId || clean(lineage.rowId) === clean(rowId);
  }) || null;
}

function assertionToOracle(assertion = {}) {
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : assertion;
  const type = clean(assertion.type || assertion.kind || '').toUpperCase();
  if (payload.expectedText != null || type === 'TEXT') {
    return { kind: 'text', target: clean(assertion.target || 'page'), expected: payload.expectedText ?? payload.text ?? '', source: 'story' };
  }
  if (payload.expectedUrlPattern != null || type === 'URL') {
    return { kind: 'url', target: 'url', expected: payload.expectedUrlPattern ?? payload.url ?? '', source: 'story' };
  }
  if (payload.expectedRole != null || type === 'ROLE') {
    return { kind: 'visible', target: clean(payload.expectedRole || assertion.target || 'role'), expected: true, source: 'story' };
  }
  if (payload.expectedValue != null) {
    return { kind: 'state_change', target: clean(assertion.target || 'value'), expected: payload.expectedValue, source: 'story' };
  }
  return null;
}

function stepToOracle(step = {}) {
  const verify = step.verify && typeof step.verify === 'object' ? step.verify : null;
  if (!verify || clean(verify.kind).toLowerCase() === 'none') return null;
  const kind = clean(verify.kind).toLowerCase();
  if (kind === 'text' || kind === 'visible_text') {
    return { kind: 'text', target: clean(verify.target || step.target || step.element || 'page'), expected: verify.text || verify.expected || step.expected || '', source: 'story' };
  }
  if (kind === 'url') {
    return { kind: 'url', target: 'url', expected: verify.url || verify.expected || step.expected || '', source: 'story' };
  }
  if (kind === 'visible') {
    return { kind: 'visible', target: clean(verify.target || step.target || step.element || 'page'), expected: true, source: 'story' };
  }
  if (kind === 'validation_message') {
    return { kind: 'validation_message', target: clean(verify.target || step.target || step.element || 'page'), expected: verify.text || verify.expected || step.expected || '', source: 'story' };
  }
  return { kind: 'state_change', target: clean(step.target || step.element || 'page'), expected: verify.expected || step.expected || true, source: 'story' };
}

function buildOracle(candidate = {}) {
  if (!candidate) return null;
  return withContractVersions({
    kind: candidate.kind || 'visible',
    target: clean(candidate.target || 'page'),
    expected: candidate.expected == null ? true : candidate.expected,
    source: candidate.source || 'story',
    required: candidate.required !== false,
  });
}

function buildStructuredOracles(caseObj = {}) {
  const raw = [];
  if (Array.isArray(caseObj.oracles)) raw.push(...caseObj.oracles);
  if (Array.isArray(caseObj.declaredAssertions)) {
    for (const assertion of caseObj.declaredAssertions) {
      const oracle = assertionToOracle(assertion);
      if (oracle) raw.push(oracle);
    }
  }
  const normalized = normalizeStepsInput(caseObj.steps, { allowSingletonObject: false });
  if (normalized.ok) {
    for (const step of normalized.steps) {
      const oracle = stepToOracle(step);
      if (oracle) raw.push(oracle);
    }
  }
  return raw.map(buildOracle).filter(Boolean);
}

function weakText(value) {
  const text = clean(value).toLowerCase();
  return !text || ['page ready', 'as expected', 'works', 'working', 'success', 'successfully', 'visible', 'loaded'].includes(text);
}

function isStrongBusinessOracle(oracle = {}) {
  const kind = clean(oracle.kind).toLowerCase();
  const target = clean(oracle.target).toLowerCase();
  const expected = oracle.expected;
  const expectedText = clean(expected).toLowerCase();
  if (kind === 'validation_message' || kind === 'table_row' || kind === 'state_change') return !weakText(expected);
  if (kind === 'url') return !weakText(expected) && expectedText !== '/' && expectedText.length > 1;
  if (kind === 'text') return !weakText(expected) && expectedText.length > 1;
  if (kind === 'visible') {
    if (weakText(expected) && /^(?:page|form|screen|section|panel|button|link|field|heading|header|menu)?$/.test(target)) return false;
    return /\b(row|record|result|details|saved|toast|message|validation|personal details|no records|created|updated)\b/i.test(`${target} ${expectedText}`);
  }
  return false;
}

function oracleMatchesContract(actual = {}, required = {}) {
  if (!actual || !required) return false;
  const actualKind = clean(actual.kind).toLowerCase();
  const requiredKind = clean(required.kind).toLowerCase();
  if (requiredKind && actualKind !== requiredKind) return false;
  const actualTarget = clean(actual.target).toLowerCase();
  const requiredTarget = clean(required.target || required.name).toLowerCase();
  if (requiredTarget && !actualTarget.includes(requiredTarget) && !requiredTarget.includes(actualTarget)) return false;
  return isStrongBusinessOracle(actual);
}

function tokensInValue(value) {
  const found = [];
  const source = typeof value === 'string' ? value : JSON.stringify(value || '');
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let match;
  while ((match = re.exec(source)) !== null) found.push(String(match[1] || '').trim().toLowerCase());
  return found;
}

function hasBusinessTokenCollision(step) {
  const tokens = tokensInValue(step);
  const authTokens = new Set(['username', 'password', 'loginusername', 'loginpassword']);
  if (!tokens.some((token) => authTokens.has(token))) return false;
  const action = String(step && step.action || '').toLowerCase();
  const target = String(step && (step.target || step.element || step.locator_hint || '')).toLowerCase();
  const looksLikeLogin = target.includes('login')
    || target.includes('credential')
    || (target.includes('username') && !target.includes('search') && !target.includes('filter'))
    || (target.includes('password') && !target.includes('search') && !target.includes('filter'));
  return /fill|type|enter|input|select|choose/.test(action) && !looksLikeLogin;
}

function verifyKind(step) {
  return String(step && step.verify && step.verify.kind || '').trim().toLowerCase();
}

function stepHasWeakOracle(step) {
  const kind = verifyKind(step);
  const expected = String(step && (step.expected || step.operationCheck?.expected || '') || '').trim().toLowerCase();
  if (kind === 'none') return true;
  if (!kind && !step?.operationCheck && !step?.declaredAssertion) return true;
  return ['page ready', 'as expected', 'works', 'working', 'successfully'].includes(expected);
}

function caseHasDeclaredOracle(caseObj) {
  return buildStructuredOracles(caseObj).some(isStrongBusinessOracle);
}

function moduleCompatible(left, right) {
  const a = norm(left);
  const b = norm(right);
  if (!a || !b) return true;
  return a === b || a.includes(b) || b.includes(a);
}

function coverageIdentityMapFromContext(context = {}) {
  if (context.coverageIdentityMap && context.coverageIdentityMap.byRef && context.coverageIdentityMap.byAlias) {
    return context.coverageIdentityMap;
  }
  try {
    const { buildCoverageIdentityMap } = require('./coverageIdentityMap');
    return buildCoverageIdentityMap(context.coverageManifest || { items: context.coverageItems || [] });
  } catch (_) {
    return null;
  }
}

function resolveCoverageRefForContext(ref, identityMap) {
  if (!identityMap) return clean(ref);
  try {
    const { resolveCoverageRef } = require('./coverageIdentityMap');
    return resolveCoverageRef(ref, identityMap);
  } catch (_) {
    return clean(ref);
  }
}

function coverageItemIds(item = {}) {
  return compactArray([
    item.manifestItemId,
    item.coverageRef,
    item.id,
    item.coverageItemId,
    item.storyId,
    item.storyRef && item.storyRef.id,
  ]);
}

function coverageItemsForRefs(refs = [], context = {}) {
  const manifests = compactArray(context.coverageManifest?.items || context.coverageItems || []);
  if (!manifests.length || !refs.length) return [];
  const identityMap = coverageIdentityMapFromContext(context);
  const resolvedRefs = new Set(refs.map((ref) => resolveCoverageRefForContext(ref, identityMap)).filter(Boolean));
  return manifests.filter((item) => coverageItemIds(item).some((id) => (
    resolvedRefs.has(resolveCoverageRefForContext(id, identityMap))
  )));
}

function coverageOwnershipDefects(caseObj = {}, scenario = {}, context = {}, caseId, caseName) {
  const refs = compactArray(caseObj.coverageRefs || scenario.coverageRefs || caseObj.requirementRefs || []);
  const items = coverageItemsForRefs(refs, context);
  const defects = [];
  const binding = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : null;
  const caseModule = clean(caseObj.module || scenario.module);
  const caseStoryId = clean(caseObj.storyId || scenario.storyId);
  const caseSheet = clean(binding && (binding.sheet || binding.sheetName));

  for (const item of items) {
    const itemModule = clean(item.module || item.storyRef && item.storyRef.moduleHint);
    const itemStoryId = clean(item.storyId || item.storyRef && item.storyRef.id);
    const itemSheet = clean(item.dataSource && (item.dataSource.sheet || item.dataSource.sheetName));
    const conflicts = [];

    if (caseModule && itemModule && !moduleCompatible(caseModule, itemModule)) {
      conflicts.push({ signal: 'module', caseValue: caseModule, coverageValue: itemModule });
    }
    if (caseStoryId && itemStoryId && norm(caseStoryId) !== norm(itemStoryId)) {
      conflicts.push({ signal: 'storyId', caseValue: caseStoryId, coverageValue: itemStoryId });
    }
    if (caseSheet && itemSheet && norm(caseSheet) !== norm(itemSheet)) {
      conflicts.push({ signal: 'dataSheet', caseValue: caseSheet, coverageValue: itemSheet });
    }

    if (conflicts.length) {
      defects.push(createReliabilityDefect({
        code: 'wrong_coverage_owner',
        caseId,
        family: DEFECT_FAMILY.COVERAGE,
        message: `Case "${caseName}" cites coverage "${clean(item.manifestItemId || item.coverageRef || item.id)}" but ownership evidence conflicts.`,
        evidence: {
          coverageRef: item.manifestItemId || item.coverageRef || item.id,
          conflicts,
        },
      }));
    }
  }

  return defects;
}

function requiredFieldsFromContext(caseObj = {}, scenario = {}, context = {}) {
  const refs = new Set(compactArray(caseObj.coverageRefs || scenario.coverageRefs || caseObj.requirementRefs || []));
  const fields = new Set(compactArray(caseObj.requiredFields || scenario.requiredFields || []));
  let matchedContractFields = false;
  const manifests = compactArray(context.coverageManifest?.items || context.coverageItems || []);
  for (const item of manifests) {
    if (!item) continue;
    const itemIds = compactArray([item.manifestItemId, item.coverageRef, item.id, item.coverageItemId]);
    if (!itemIds.some((id) => refs.has(id))) continue;
    const required = compactArray(item.requiredFields);
    if (required.length) matchedContractFields = true;
    for (const field of required) fields.add(field);
  }
  const mappings = compactArray(context.exampleMappings || context.exampleMappingContracts || []);
  for (const mapping of mappings) {
    if (!mapping) continue;
    const mappingIds = compactArray([mapping.coverageItemId, mapping.coverageRef, mapping.id]);
    if (!mappingIds.some((id) => refs.has(id))) continue;
    for (const example of compactArray(mapping.examples)) {
      const required = compactArray(example.requiredFields);
      if (required.length) matchedContractFields = true;
      for (const field of required) fields.add(field);
    }
  }
  if (matchedContractFields) return Array.from(fields).filter(Boolean);
  const haystack = [
    caseObj.name,
    caseObj.caseIntent,
    caseObj.module,
    scenario.name,
    scenario.module,
    ...refs,
  ].map(clean).join(' ').toLowerCase();
  if (/\badmin\b/.test(haystack) && /(system\s*user|user\s*search|admin.*search|search.*admin)/.test(haystack)) {
    ['username', 'role', 'employee name', 'status'].forEach((field) => fields.add(field));
  }
  if (/\bclaim\b/.test(haystack) && /(validation|required|submit|request)/.test(haystack)) {
    ['event', 'currency', 'amount', 'remarks'].forEach((field) => fields.add(field));
  }
  return Array.from(fields).filter(Boolean);
}

function fieldAliases(field) {
  const key = norm(field);
  const aliases = {
    username: ['username', 'user name', 'usernamefilter', 'user name filter'],
    role: ['role', 'user role', 'userrole', 'userrolefilter'],
    employeename: ['employee name', 'employeename', 'employee filter', 'employee name filter'],
    status: ['status', 'statusfilter', 'user status'],
    event: ['event', 'claim event'],
    currency: ['currency', 'claim currency', 'claimcurrency'],
    amount: ['amount', 'claim amount', 'claimamount'],
    remarks: ['remarks', 'remark', 'claim remarks', 'claimremarks'],
  };
  return aliases[key] || [field];
}

function fieldPresentInSteps(field, steps = []) {
  const aliases = fieldAliases(field).map(norm);
  return steps.some((step) => {
    const canonical = normalizeStepAction(step && step.action, step && step.verify);
    const verify = verifyKind(step);
    const meaningful = ['fill', 'select', 'check', 'upload'].includes(canonical)
      || (canonical === 'click' && /\b(search|submit|save|apply|filter)\b/i.test(clean(step && (step.target || step.element || step.label))))
      || (['assertText', 'assertVisible'].includes(canonical) && ['validation_message', 'text', 'visible'].includes(verify));
    if (!meaningful) return false;
    const searchable = [
      step && step.action,
      step && step.target,
      step && step.element,
      step && step.field,
      step && step.label,
      step && step.value,
      step && step.verify && step.verify.target,
      step && step.verify && step.verify.field,
    ].map(clean).join(' ');
    const normalized = norm(searchable);
    return aliases.some((alias) => normalized.includes(alias));
  });
}

function inputStepValue(step = {}) {
  if (step.value != null) return step.value;
  if (step.text != null) return step.text;
  if (step.input != null) return step.input;
  if (Array.isArray(step.values)) return step.values.join(' ');
  return '';
}

function isInputAction(step = {}) {
  return /fill|type|enter|input|select|choose/.test(String(step.action || '').toLowerCase());
}

function buildCaseReliabilityArtifacts(caseObj = {}, scenario = {}, context = {}) {
  const caseId = caseObj.id || caseObj.caseId || undefined;
  const normalized = normalizeStepsInput(caseObj.steps, { allowSingletonObject: false });
  const steps = normalized.ok ? normalized.steps : [];
  const rowExecutionPlan = buildRowExecutionPlan(caseObj);
  const binding = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : null;
  const scenarioSteps = steps.map((step, index) => buildScenarioStep(step, {
    caseId,
    index,
    coverageRefs: compactArray(caseObj.coverageRefs || scenario.coverageRefs),
  }));
  const rowIds = rowExecutionPlan && rowExecutionPlan.rowIds.length ? rowExecutionPlan.rowIds : [undefined];
  const dataLineage = [];
  if (binding) {
    steps.forEach((step) => {
      if (!isInputAction(step)) return;
      for (const token of tokensInValue(inputStepValue(step))) {
        rowIds.forEach((rowId, rowIndex) => {
          const lineage = stepLineageForToken(step, token, rowId) || buildDataLineage({ token, binding, rowId, rowIndex });
          if (lineage) dataLineage.push(lineage);
        });
      }
    });
  }
  return withContractVersions({
    caseId,
    scenarioId: scenario.id || scenario.scenarioId || undefined,
    scenarioSteps,
    rowExecutionPlan: rowExecutionPlan || undefined,
    dataLineage,
    oracles: buildStructuredOracles({ ...caseObj, steps }),
    browserActionBindings: scenarioSteps.map((step) => step.browserActionBinding).filter(Boolean),
    requiredFields: requiredFieldsFromContext(caseObj, scenario, context),
  });
}

function collectScenarioReliabilityArtifacts(scenarios = [], context = {}) {
  const artifacts = [];
  for (const scenario of (Array.isArray(scenarios) ? scenarios : [])) {
    for (const caseObj of (Array.isArray(scenario && scenario.cases) ? scenario.cases : [])) {
      artifacts.push(buildCaseReliabilityArtifacts(caseObj, scenario, context));
    }
  }
  return artifacts;
}

function collectCaseReliabilityDefects(caseObj = {}, scenario = {}, context = {}) {
  const caseId = caseObj.id || caseObj.caseId || undefined;
  const caseName = caseObj.name || caseObj.title || 'unnamed case';
  const defects = [];
  const normalized = normalizeStepsInput(caseObj.steps, { allowSingletonObject: false });
  if (Array.isArray(normalized.defects)) {
    for (const defect of normalized.defects) defects.push({ ...defect, caseId });
  }
  if (!normalized.ok) {
    defects.push(createReliabilityDefect({
      ...(normalized.defect || {}),
      code: (normalized.defect && normalized.defect.code) || 'invalid_steps_shape',
      caseId,
      family: DEFECT_FAMILY.STEP_SHAPE,
      message: `Case "${caseName}" has steps that do not normalize to an array.`,
    }));
    return defects;
  }

  const initialRefs = compactArray(caseObj.coverageRefs || scenario.coverageRefs || caseObj.requirementRefs || []);
  if ((context.coverageManifest || context.coverageItems) && !initialRefs.length) {
    defects.push(createReliabilityDefect({
      code: 'coverage_owner_unknown',
      caseId,
      family: DEFECT_FAMILY.COVERAGE,
      message: `Case "${caseName}" is not anchored to a deterministic coverage owner.`,
      evidence: { scenario: scenario.name || scenario.title || undefined },
    }));
  }
  defects.push(...coverageOwnershipDefects(caseObj, scenario, context, caseId, caseName));

  const structuredOracles = buildStructuredOracles({ ...caseObj, steps: normalized.steps });
  if (!structuredOracles.length || !caseHasDeclaredOracle({ ...caseObj, steps: normalized.steps })) {
    defects.push(createReliabilityDefect({
      code: 'missing_structured_oracle',
      caseId,
      family: DEFECT_FAMILY.ORACLE,
      message: `Case "${caseName}" has no structured oracle or declared assertion.`,
      evidence: { scenario: scenario.name || scenario.title || undefined },
    }));
  }
  const refs = new Set(initialRefs);
  const manifests = compactArray(context.coverageManifest?.items || context.coverageItems || []);
  for (const item of manifests) {
    if (!item) continue;
    const itemIds = compactArray([item.manifestItemId, item.coverageRef, item.id, item.coverageItemId]);
    if (!itemIds.some((id) => refs.has(id))) continue;
    for (const requiredOracle of compactArray(item.requiredOracles)) {
      if (structuredOracles.some((oracle) => oracleMatchesContract(oracle, requiredOracle))) continue;
      defects.push(createReliabilityDefect({
        code: 'weak_oracle',
        caseId,
        family: DEFECT_FAMILY.ORACLE,
        message: `Case "${caseName}" is missing required business oracle "${clean(requiredOracle.target || requiredOracle.name || requiredOracle.kind)}".`,
        evidence: { requiredOracle, coverageRefs: Array.from(refs) },
      }));
    }
  }

  const binding = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : null;
  const rowPlan = buildRowExecutionPlan(caseObj);
  if (binding && binding.sheet && (!rowPlan || (!rowPlan.rowIds.length && !rowPlan.skippedRows.length))) {
    defects.push(createReliabilityDefect({
      code: 'missing_row_execution_plan',
      caseId,
      family: DEFECT_FAMILY.DATA_BINDING,
      message: `Data-driven case "${caseName}" has no RowExecutionPlan.`,
      evidence: { sheet: binding.sheet, rowSelector: binding.rowSelector || null },
    }));
  }
  if (rowPlan && rowPlan.skippedRows.length) {
    for (const rowId of rowPlan.skippedRows) {
      if (!rowPlan.skipReasons || !clean(rowPlan.skipReasons[rowId])) {
        defects.push(createReliabilityDefect({
          code: 'silent_row_skip',
          caseId,
          rowId,
          family: DEFECT_FAMILY.DATA_BINDING,
          message: `Data-driven case "${caseName}" skips row "${rowId}" without a reason.`,
          evidence: { skippedRows: rowPlan.skippedRows },
        }));
      }
    }
  }
  if (binding && (binding.source === 'draft' || binding.source === 'proposed' || binding.needsReview === true || binding.status === 'proposed')) {
    defects.push(createReliabilityDefect({
      code: 'proposed_data_mapping',
      caseId,
      family: DEFECT_FAMILY.DATA_BINDING,
      message: `Case "${caseName}" uses proposed or review-needed data mapping.`,
      evidence: { sheet: binding.sheet || null, status: binding.status || null, source: binding.source || null },
    }));
  }

  normalized.steps.forEach((step, index) => {
    const stepId = step && (step.id || step.stepId || `${caseId || caseName}-step-${index + 1}`);
    const scenarioStep = buildScenarioStep(step, {
      caseId,
      index,
      coverageRefs: compactArray(caseObj.coverageRefs || scenario.coverageRefs),
    });
    const canonicalAction = normalizeStepAction(step && step.action, step && step.verify);
    if (!canonicalAction || !SCENARIO_ACTIONS.includes(canonicalAction) || !isRegisteredCanonicalAction(canonicalAction)) {
      defects.push(createReliabilityDefect({
        code: 'unregistered_browser_action',
        caseId,
        family: DEFECT_FAMILY.BROWSER_ACTION,
        message: `Step "${stepId}" does not map to a registered browser action.`,
        evidence: { action: step && step.action, canonicalAction },
      }));
    }
    if (verifyKind(step) === 'none') {
      defects.push(createReliabilityDefect({
        code: 'verify_kind_none',
        caseId,
        family: DEFECT_FAMILY.ORACLE,
        message: `Step "${stepId}" uses verify.kind = none.`,
        evidence: { stepId },
      }));
    } else if (stepHasWeakOracle(step) && index === normalized.steps.length - 1) {
      defects.push(createReliabilityDefect({
        code: 'weak_oracle',
        caseId,
        family: DEFECT_FAMILY.ORACLE,
        message: `Final step "${stepId}" has a weak or missing oracle.`,
        evidence: { expected: step && step.expected, verify: step && step.verify },
      }));
    }
    if (hasBusinessTokenCollision(step)) {
      defects.push(createReliabilityDefect({
        code: 'token_collision',
        caseId,
        family: DEFECT_FAMILY.DATA_BINDING,
        message: `Step "${stepId}" appears to reuse auth tokens as business/search data.`,
        evidence: { target: step && (step.target || step.element), value: step && step.value },
      }));
    }
    if (binding && isInputAction(step)) {
      for (const token of tokensInValue(inputStepValue(step))) {
        const rowIds = rowPlan && rowPlan.rowIds.length ? rowPlan.rowIds : [undefined];
        rowIds.forEach((rowId, rowIndex) => {
          const lineage = stepLineageForToken(step, token, rowId) || buildDataLineage({ token, binding, rowId, rowIndex });
          if (!lineage) {
            defects.push(createReliabilityDefect({
              code: 'missing_data_lineage',
              caseId,
              rowId,
              family: DEFECT_FAMILY.DATA_BINDING,
              message: `Step "${stepId}" token "{{${token}}}" has no data lineage.`,
              evidence: { stepId, token, sheet: binding.sheet || null },
            }));
          } else if (lineage.mappingStatus !== 'approved') {
            defects.push(createReliabilityDefect({
              code: lineage.mappingStatus === 'needs_mapping' ? 'missing_approved_data' : 'proposed_data_mapping',
              caseId,
              rowId,
              dataBindingId: lineage.dataBindingId,
              family: DEFECT_FAMILY.DATA_BINDING,
              message: `Step "${stepId}" token "{{${token}}}" uses ${lineage.mappingStatus} data mapping for row "${rowId || rowIndex + 1}".`,
              evidence: { stepId, token, lineage },
            }));
          }
        });
      }
    }
    if (scenarioStep.browserActionBinding && scenarioStep.browserActionBinding.exportable === false
      && !['assertText', 'assertUrl', 'assertVisible', 'waitFor'].includes(scenarioStep.action)) {
      defects.push(createReliabilityDefect({
        code: 'non_exportable_action',
        caseId,
        family: DEFECT_FAMILY.BROWSER_ACTION,
        message: `Step "${stepId}" maps to a non-exportable action.`,
        evidence: { action: scenarioStep.action, binding: scenarioStep.browserActionBinding },
      }));
    }
  });

  for (const field of requiredFieldsFromContext(caseObj, scenario, context)) {
    if (fieldPresentInSteps(field, normalized.steps)) continue;
    defects.push(createReliabilityDefect({
      code: 'missing_required_story_field',
      caseId,
      family: DEFECT_FAMILY.SEMANTIC_QUALITY,
      message: `Case "${caseName}" does not exercise required field "${field}".`,
      evidence: { field, coverageRefs: compactArray(caseObj.coverageRefs || scenario.coverageRefs) },
    }));
  }

  return defects;
}

function collectScenarioReliabilityDefects(scenarios = [], context = {}) {
  const defects = [];
  for (const scenario of (Array.isArray(scenarios) ? scenarios : [])) {
    for (const caseObj of (Array.isArray(scenario && scenario.cases) ? scenario.cases : [])) {
      defects.push(...collectCaseReliabilityDefects(caseObj, scenario, context));
    }
  }
  if (context && (context.appCapabilityMap || context.capabilityGroundingRequired)) {
    try {
      const capabilityMap = require('./capabilityMap');
      defects.push(...capabilityMap.collectAppCapabilityDefects(scenarios, {
        capabilityMap: context.appCapabilityMap || null,
        requiredModules: compactArray(context.requiredModules || []),
        targetUrl: context.targetUrl,
        authRole: context.authRole,
        maxAgeDays: context.maxCapabilityAgeDays,
        minSelectorConfidence: context.minSelectorConfidence,
        requireCapabilityMap: !!context.capabilityGroundingRequired,
      }));
    } catch (_) {
      defects.push(createReliabilityDefect({
        code: 'missing_app_capability',
        family: DEFECT_FAMILY.APP_CAPABILITY,
        message: 'App capability grounding could not run.',
        userDecisionAllowed: true,
      }));
    }
  }
  return defects;
}

function summarizeDefects(defects = []) {
  const summary = {};
  for (const defect of (Array.isArray(defects) ? defects : [])) {
    if (!defect || !defect.family || !defect.code) continue;
    summary[defect.family] = summary[defect.family] || {};
    summary[defect.family][defect.code] = Number(summary[defect.family][defect.code] || 0) + 1;
  }
  return summary;
}

function countCases(scenarios) {
  return (Array.isArray(scenarios) ? scenarios : [])
    .reduce((sum, scenario) => sum + (Array.isArray(scenario && scenario.cases) ? scenario.cases.length : 0), 0);
}

module.exports = {
  SCHEMA_VERSION,
  CONTRACT_VERSION,
  CASE_RELIABILITY_STATUS,
  SUITE_RELIABILITY_STATUS,
  RELIABILITY_SEVERITY,
  DEFECT_RESOLUTION_STATUS,
  DEFECT_FAMILY,
  SCENARIO_ACTIONS,
  DEFECT_SEVERITY_MATRIX,
  REPAIR_STOP_REASON,
  withContractVersions,
  createReliabilityDefect,
  severityForCode,
  normalizeStepsInput,
  normalizeStepsStrict,
  coverageDefectsFromValidation,
  normalizeStepAction,
  buildScenarioStep,
  buildBrowserActionBinding,
  buildRowExecutionPlan,
  buildDataLineage,
  buildOracle,
  buildStructuredOracles,
  isStrongBusinessOracle,
  requiredFieldsFromContext,
  fieldPresentInSteps,
  buildCaseReliabilityArtifacts,
  collectScenarioReliabilityArtifacts,
  tokensInValue,
  collectCaseReliabilityDefects,
  collectScenarioReliabilityDefects,
  summarizeDefects,
  countCases,
};
