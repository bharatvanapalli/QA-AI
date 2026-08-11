'use strict';

const crypto = require('node:crypto');

const EXISTING_SCENARIO_CONTEXT_VERSION = 'ExistingScenarioContextV1';
const REDACTED = '[REDACTED]';
const DIGEST_RE = /^sha256-[a-f0-9]{64}$/;
const SENSITIVE_KEY_RE = /(?:^|[^a-z0-9])(?:pass(?:word|code)?|pwd|secret|token|api[_ -]?key|client[_ -]?secret|private[_ -]?key|access[_ -]?key|credential|otp|mfa|pin|ssn|email|phone)(?:$|[^a-z0-9])/i;
const SENSITIVE_TEXT_RE = /\b(?:password|passcode|pwd|secret|token|api[_ -]?key|client[_ -]?secret|otp|pin)\s*(?:is|=|:)\s*([^\s,;]+)/ig;
const BEARER_RE = /\bBearer\s+([A-Za-z0-9._~+\/-]{8,})/ig;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/ig;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/\-]{0,255}$/;
const SAFE_REF_RE = /^(?:secret|vault|env|fixture|dataset|data|binding|runtime|shared|sharedData|testData|credential|column|row|field):[A-Za-z0-9][A-Za-z0-9._:@/\-]{0,255}$/i;
const SAFE_DOTTED_REF_RE = /^(?:data|dataset|fixture|runtime|sharedData|testData|process\.env)\.[A-Za-z_][A-Za-z0-9_.-]{0,255}$/;
const TEMPLATE_REF_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]{0,255})\s*\}\}/g;

const CODES = Object.freeze({
  FIELD_REQUIRED: 'existing_context_field_required',
  ARRAY_REQUIRED: 'existing_context_array_required',
  OBJECT_REQUIRED: 'existing_context_object_required',
  ID_INVALID: 'existing_context_id_invalid',
  ID_DUPLICATE: 'existing_context_id_duplicate',
  PROJECT_MISMATCH: 'existing_context_project_mismatch',
  GENERATION_MISMATCH: 'existing_context_generation_mismatch',
  GENERATION_NOT_CURRENT: 'existing_context_generation_not_current',
  REFERENCE_MISSING: 'existing_context_reference_missing',
  DEPENDENCY_DUPLICATE: 'existing_context_dependency_duplicate',
  DEPENDENCY_MISSING: 'existing_context_dependency_missing',
  DEPENDENCY_FORWARD: 'existing_context_dependency_not_backward',
  DEPENDENCY_SELF: 'existing_context_dependency_self_reference',
  ORDINAL_INVALID: 'existing_context_ordinal_invalid',
  ORDINAL_INCONSISTENT: 'existing_context_ordinal_inconsistent',
  ORDINAL_DUPLICATE: 'existing_context_ordinal_duplicate',
  ORDINAL_NOT_CONTIGUOUS: 'existing_context_ordinal_not_contiguous',
  JSON_INVALID: 'existing_context_json_invalid',
  NON_JSON_VALUE: 'existing_context_non_json_value',
  SENSITIVE_LITERAL: 'existing_context_sensitive_literal_forbidden',
  DIGEST_MISMATCH: 'existing_context_digest_mismatch',
  CONTRACT_NOT_FROZEN: 'existing_context_not_deep_frozen',
  FINAL_STATE_INCOMPATIBLE: 'existing_context_final_state_incompatible',
  CASE_NOT_APPROVED: 'existing_context_case_not_approved',
  CASE_NOT_EXECUTED: 'existing_context_case_not_executed',
  DEPENDENCY_INVALID: 'existing_context_dependency_invalid',
  CROSS_PROJECT: 'existing_context_cross_project',
});

class ExistingScenarioContextError extends Error {
  constructor(message, findings = []) {
    super(message);
    this.name = 'ExistingScenarioContextError';
    this.code = 'ADD_SCENARIO_EXISTING_CONTEXT_INVALID';
    this.status = 422;
    this.findings = normalizeFindings(findings);
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addFinding(findings, path, code, message) {
  findings.push({ path, code, message });
}

function normalizeFindings(findings) {
  return [...(Array.isArray(findings) ? findings : [])].sort((left, right) => {
    const pathOrder = String(left.path || '').localeCompare(String(right.path || ''));
    if (pathOrder) return pathOrder;
    return String(left.code || '').localeCompare(String(right.code || ''));
  });
}

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return `sha256-${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function isDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((entry) => isDeepFrozen(entry, seen));
}

function safeIdentifier(value, path, findings, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) addFinding(findings, path, CODES.FIELD_REQUIRED, 'A persisted identifier is required.');
    return null;
  }
  const normalized = String(value).trim();
  if (!SAFE_ID_RE.test(normalized)) {
    addFinding(findings, path, CODES.ID_INVALID, 'The persisted identifier is invalid.');
    return null;
  }
  return normalized;
}

function parseJson(value, path, findings, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    addFinding(findings, path, CODES.JSON_INVALID, 'Persisted JSON could not be decoded.');
    return fallback;
  }
}

function decodeArray(value, path, findings) {
  const parsed = parseJson(value, path, findings, []);
  if (!Array.isArray(parsed)) {
    addFinding(findings, path, CODES.ARRAY_REQUIRED, 'A persisted array is required.');
    return [];
  }
  return parsed;
}

function readArray(input, aliases, path, findings) {
  for (const alias of aliases) {
    if (!hasOwn(input, alias)) continue;
    if (!Array.isArray(input[alias])) {
      addFinding(findings, path, CODES.ARRAY_REQUIRED, 'A persisted row array is required.');
      return [];
    }
    return input[alias];
  }
  return null;
}

function collectSensitiveLiterals(value, output = new Set(), key = '', contextSensitive = false, seen = new WeakSet()) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'string') {
    const sensitive = contextSensitive || SENSITIVE_KEY_RE.test(key);
    if (sensitive && !isSafeDataRef(value) && value.length >= 3) output.add(value);
    // Persisted JSON strings can contain approved reference-only values such as
    // `secret:login.password`.  Those are identifiers, not secret literals; do
    // not let the generic "secret: value" detector classify their suffix as a
    // leak and then reject the same safe reference in canonical output.
    const scanValue = value.replace(/\b(?:secret|vault|env|fixture|dataset|data|binding|runtime|shared|sharedData|testData|credential|column|row|field):[A-Za-z0-9][A-Za-z0-9._:@/\-]{0,255}/gi, '');
    for (const regex of [SENSITIVE_TEXT_RE, BEARER_RE]) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(scanValue))) if (match[1] && match[1].length >= 3) output.add(match[1]);
    }
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSensitiveLiterals(entry, output, key, contextSensitive, seen));
  } else {
    const targetText = [value.target, value.targetIdentity, value.field, value.label, value.name]
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (!entry || typeof entry !== 'object') return '';
        try { return stableSerialize(entry); } catch (_) { return ''; }
      })
      .join(' ');
    const objectSensitive = contextSensitive || SENSITIVE_KEY_RE.test(targetText);
    Object.entries(value).forEach(([childKey, entry]) => {
      const valueBearingKey = /^(?:value|expected|input|defaultValue|rawValue)$/i.test(childKey);
      collectSensitiveLiterals(entry, output, childKey, objectSensitive && valueBearingKey, seen);
    });
  }
  seen.delete(value);
  return output;
}

function isSafeDataRef(value, { explicit = false } = {}) {
  if (!isNonBlankString(value)) return false;
  const normalized = value.trim();
  if (SAFE_REF_RE.test(normalized) || SAFE_DOTTED_REF_RE.test(normalized)) return true;
  if (/^\{\{\s*[A-Za-z_][A-Za-z0-9_.-]{0,255}\s*\}\}$/.test(normalized)) return true;
  return explicit && /^[A-Za-z_][A-Za-z0-9_.:/\-]{0,255}$/.test(normalized);
}

function sanitizeString(value, sensitiveValues, { redactEmail = true } = {}) {
  let output = String(value);
  [...sensitiveValues]
    .filter((literal) => typeof literal === 'string' && literal.length >= 3)
    .sort((left, right) => right.length - left.length)
    .forEach((literal) => { output = output.split(literal).join(REDACTED); });
  output = output.replace(/(\b(?:password|passcode|pwd|secret|token|api[_ -]?key|client[_ -]?secret|otp|pin)\s*(?:is|=|:)\s*)[^\s,;]+/ig, `$1${REDACTED}`);
  output = output.replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]{8,}/ig, `$1${REDACTED}`);
  if (redactEmail) output = output.replace(EMAIL_RE, REDACTED);
  return output;
}

function canonicalSafeJson(value, path, findings, sensitiveValues, options = {}, stack = new WeakSet(), depth = 0) {
  if (value === null) return { value: null, redacted: false };
  if (typeof value === 'string') {
    const sanitized = sanitizeString(value, sensitiveValues, options);
    return { value: sanitized, redacted: sanitized !== value };
  }
  if (typeof value === 'boolean') return { value, redacted: false };
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return { value, redacted: false };
    addFinding(findings, path, CODES.NON_JSON_VALUE, 'Persisted state must contain finite JSON values.');
    return { value: null, redacted: false };
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return { value: value.toISOString(), redacted: false };
  if (typeof value !== 'object') {
    addFinding(findings, path, CODES.NON_JSON_VALUE, 'Persisted state must be JSON-safe.');
    return { value: null, redacted: false };
  }
  if (depth > 64 || stack.has(value) || (!Array.isArray(value) && !isPlainObject(value))) {
    addFinding(findings, path, CODES.NON_JSON_VALUE, 'Persisted state must use finite, acyclic JSON semantics.');
    return { value: null, redacted: false };
  }
  stack.add(value);
  let redacted = false;
  let output;
  if (Array.isArray(value)) {
    output = value.map((entry, index) => {
      const result = canonicalSafeJson(entry, `${path}[${index}]`, findings, sensitiveValues, options, stack, depth + 1);
      redacted = redacted || result.redacted;
      return result.value;
    });
  } else {
    output = {};
    Object.keys(value).sort().forEach((key) => {
      if (SENSITIVE_KEY_RE.test(key)) {
        const raw = value[key];
        if (typeof raw === 'string' && isSafeDataRef(raw)) output[key] = raw.trim();
        else output[key] = REDACTED;
        redacted = true;
        return;
      }
      const result = canonicalSafeJson(value[key], `${path}.${key}`, findings, sensitiveValues, options, stack, depth + 1);
      redacted = redacted || result.redacted;
      output[key] = result.value;
    });
  }
  stack.delete(value);
  return { value: output, redacted };
}

function firstOwn(value, fields) {
  for (const field of fields) if (hasOwn(value, field)) return { field, value: value[field] };
  return { field: null, value: undefined };
}

function normalizeRevision(row, path, findings, sensitiveValues) {
  let value = hasOwn(row, 'revision') ? row.revision : undefined;
  if (value === undefined && hasOwn(row, 'qualityContractJson')) {
    const quality = parseJson(row.qualityContractJson, `${path}.qualityContractJson`, findings, null);
    const plan = quality && isPlainObject(quality)
      ? (quality.testDesignPlan || quality.testDesignPlanV1 || null)
      : null;
    if (plan && isPlainObject(plan)) {
      value = {
        planRevision: plan.revision ?? plan.planRevision ?? null,
        caseRevision: plan.caseRevision ?? null,
        compiledCaseRevision: plan.compiledCaseRevision ?? null,
      };
    }
  }
  if (value === undefined && hasOwn(row, 'caseRevision')) value = row.caseRevision;
  if (value === undefined && hasOwn(row, 'updatedAt')) value = row.updatedAt;
  if (value === undefined || value === null || value === '') return null;
  const normalized = canonicalSafeJson(value, `${path}.revision`, findings, sensitiveValues, { redactEmail: true });
  return normalized.value;
}

function extractOrdinal(row, path, findings) {
  const aliases = ['ordinal', 'order', 'position', 'sequenceIndex'];
  const present = aliases.filter((field) => hasOwn(row, field) && row[field] !== null && row[field] !== undefined);
  if (!present.length) return null;
  const values = present.map((field) => row[field]);
  if (values.some((entry) => entry !== values[0])) {
    addFinding(findings, path, CODES.ORDINAL_INCONSISTENT, 'Persisted ordinal aliases disagree.');
  }
  const ordinal = Number(values[0]);
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    addFinding(findings, path, CODES.ORDINAL_INVALID, 'Persisted ordinals must be positive integers.');
    return null;
  }
  return ordinal;
}

function orderRows(records, path, findings) {
  const decorated = records.map((record, index) => ({
    ...record,
    sourceIndex: index,
    explicitOrdinal: extractOrdinal(record.row, `${record.path}.ordinal`, findings),
  }));
  const explicitCount = decorated.filter((record) => record.explicitOrdinal !== null).length;
  if (explicitCount > 0 && explicitCount !== decorated.length) {
    addFinding(findings, path, CODES.ORDINAL_INCONSISTENT, 'A persisted order cannot mix explicit and implicit ordinals.');
    return decorated.map((record, index) => ({ ...record, ordinal: index + 1 }));
  }
  if (!explicitCount) return decorated.map((record, index) => ({ ...record, ordinal: index + 1 }));
  const byOrdinal = new Map();
  decorated.forEach((record) => {
    if (byOrdinal.has(record.explicitOrdinal)) {
      addFinding(findings, `${record.path}.ordinal`, CODES.ORDINAL_DUPLICATE, 'A persisted ordinal is duplicated in its scope.');
    } else byOrdinal.set(record.explicitOrdinal, record);
  });
  const expected = Array.from({ length: decorated.length }, (_, index) => index + 1);
  if (expected.some((ordinal) => !byOrdinal.has(ordinal))) {
    addFinding(findings, path, CODES.ORDINAL_NOT_CONTIGUOUS, 'Persisted ordinals must be contiguous and one-based.');
  }
  return [...decorated]
    .sort((left, right) => left.explicitOrdinal - right.explicitOrdinal || left.sourceIndex - right.sourceIndex)
    .map((record) => ({ ...record, ordinal: record.explicitOrdinal }));
}

function normalizeReferenceList(value, path, findings) {
  const rows = decodeArray(value, path, findings);
  const output = [];
  const seen = new Set();
  rows.forEach((entry, index) => {
    const id = safeIdentifier(entry, `${path}[${index}]`, findings);
    if (!id) return;
    if (seen.has(id)) addFinding(findings, `${path}[${index}]`, CODES.DEPENDENCY_DUPLICATE, 'A dependency reference is duplicated.');
    else { seen.add(id); output.push(id); }
  });
  return output;
}

function normalizeDataRef(value, { explicit = false } = {}) {
  if (!isSafeDataRef(value, { explicit })) return null;
  const normalized = value.trim();
  if (/^\{\{/.test(normalized)) {
    const match = /^\{\{\s*([A-Za-z_][A-Za-z0-9_.-]{0,255})\s*\}\}$/.exec(normalized);
    return match ? `{{${match[1]}}}` : null;
  }
  return normalized;
}

function collectInlineDataRefs(value) {
  const refs = [];
  const seenRefs = new Set();
  const seenObjects = new WeakSet();
  const add = (candidate, explicit = false) => {
    const ref = normalizeDataRef(candidate, { explicit });
    if (ref && !seenRefs.has(ref)) { seenRefs.add(ref); refs.push(ref); }
  };
  const visit = (entry, key = '') => {
    if (typeof entry === 'string') {
      if (/(?:value|expected|data|binding|fixture|secret|dataset|column|row)Ref$/i.test(key)) add(entry, true);
      add(entry, false);
      TEMPLATE_REF_RE.lastIndex = 0;
      let match;
      while ((match = TEMPLATE_REF_RE.exec(entry))) add(`{{${match[1]}}}`);
      return;
    }
    if (!entry || typeof entry !== 'object' || seenObjects.has(entry)) return;
    seenObjects.add(entry);
    if (Array.isArray(entry)) entry.forEach((item) => visit(item, key));
    else Object.entries(entry).forEach(([childKey, item]) => visit(item, childKey));
  };
  visit(value);
  return refs;
}

function boundedToken(value) {
  if (!isNonBlankString(value)) return null;
  const token = value.trim();
  return /^[A-Za-z][A-Za-z0-9_ -]{0,63}$/.test(token) ? token : null;
}

function operationType(step) {
  const direct = firstOwn(step, ['type', 'operation', 'actionType']).value;
  const token = boundedToken(direct);
  if (token) return token;
  const text = String(step.action || step.text || '').toLowerCase();
  const rules = [
    [/\b(?:verify|assert|expect|check)\b.*\bvisible\b/, 'AssertVisible'],
    [/\b(?:verify|assert|expect|check)\b/, 'Assert'],
    [/\b(?:navigate|open|visit|go to)\b/, 'Navigate'],
    [/\b(?:click|press|tap)\b/, 'Click'],
    [/\b(?:enter|fill|type|input)\b/, 'Fill'],
    [/\bselect\b/, 'Select'],
    [/\bwait\b/, 'Wait'],
  ];
  const match = rules.find(([regex]) => regex.test(text));
  return match ? match[1] : 'Operation';
}

function operationKind(step, type) {
  const kind = String(step.kind || '').trim().toLowerCase();
  if (['assertion', 'assert', 'validation', 'verify'].includes(kind)) return 'assertion';
  if (/^(?:assert|verify|expect|check)/i.test(type)) return 'assertion';
  return 'action';
}

function targetSummary(step, sensitiveValues) {
  const raw = step.targetIdentity !== undefined ? step.targetIdentity : step.target;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return { name: sanitizeString(raw, sensitiveValues) };
  if (!isPlainObject(raw)) return null;
  const output = {};
  for (const key of ['kind', 'role', 'name', 'label', 'testId']) {
    if (!isNonBlankString(raw[key])) continue;
    const sanitized = sanitizeString(raw[key], sensitiveValues);
    if (key === 'kind' || key === 'role') {
      const token = boundedToken(sanitized);
      if (token) output[key] = token;
    } else output[key] = sanitized;
  }
  return Object.keys(output).length ? output : null;
}

function normalizeOperation(step, context) {
  const { path, ordinal, findings, sensitiveValues } = context;
  const id = firstOwn(step, ['id', 'stepId', 'operationId']).value;
  const normalizedId = id === undefined || id === null || id === ''
    ? null
    : safeIdentifier(id, `${path}.id`, findings);
  const type = operationType(step);
  const dependencies = normalizeReferenceList(
    firstOwn(step, ['dependsOnIds', 'dependencies', 'dependsOn']).value,
    `${path}.dependsOnIds`,
    findings,
  );
  const target = targetSummary(step, sensitiveValues);
  const output = {
    id: normalizedId,
    ordinal,
    kind: operationKind(step, type),
    type,
    target,
    required: step.required !== false,
    dependsOnIds: dependencies,
    inlineDataRefs: collectInlineDataRefs(step),
  };
  return output;
}

function normalizePersistedStep(step, context) {
  const operation = normalizeOperation(step, context);
  const output = {
    id: operation.id,
    ordinal: operation.ordinal,
    action: operation.type,
    kind: operation.kind,
    target: operation.target,
    required: operation.required,
    dependsOnIds: operation.dependsOnIds,
  };
  for (const field of ['valueRef', 'expectedRef', 'dataRef', 'bindingRef', 'fixtureRef']) {
    if (!hasOwn(step, field)) continue;
    const ref = normalizeDataRef(step[field], { explicit: true });
    if (ref) output[field] = ref;
  }
  return output;
}

function normalizeDeclaredAssertions(row, path, findings, sensitiveValues) {
  const raw = decodeArray(row.declaredAssertions, `${path}.declaredAssertions`, findings);
  const normalizedRaw = (Array.isArray(raw) ? raw : []).map((entry, index) => {
    if (typeof entry === 'string') {
      return {
        id: `decl-assert-${index + 1}`,
        ordinal: index + 1,
        type: 'Assertion',
        target: { name: sanitizeString(entry, sensitiveValues) },
        description: entry,
      };
    }
    return entry;
  });
  const ordered = orderRows(normalizedRaw.filter((entry, index) => {
    if (isPlainObject(entry)) return true;
    addFinding(findings, `${path}.declaredAssertions[${index}]`, CODES.OBJECT_REQUIRED, 'Each persisted assertion must be an object.');
    return false;
  }).map((entry, index) => ({ row: entry, path: `${path}.declaredAssertions[${index}]` })), `${path}.declaredAssertions`, findings);
  return ordered.map((record) => {
    const assertion = record.row;
    const id = safeIdentifier(assertion.id, `${record.path}.id`, findings, { required: false });
    const output = {
      id,
      ordinal: record.ordinal,
      type: boundedToken(assertion.type) || 'Assertion',
      target: targetSummary(assertion, sensitiveValues),
      comparator: boundedToken(assertion.comparator),
    };
    if (hasOwn(assertion, 'expectedRef')) {
      const ref = normalizeDataRef(assertion.expectedRef, { explicit: true });
      if (ref) output.expectedRef = ref;
    }
    return output;
  });
}

function selectState(row, fields, path, findings) {
  for (const field of fields) {
    if (!hasOwn(row, field)) continue;
    return /Json$/.test(field) ? parseJson(row[field], `${path}.${field}`, findings, null) : row[field];
  }
  return null;
}

function normalizeSessionIntent(row, path, findings, sensitiveValues) {
  return {
    mode: isNonBlankString(row.sessionMode) ? sanitizeString(row.sessionMode.trim(), sensitiveValues) : 'fresh',
    failurePolicy: isNonBlankString(row.failurePolicy) ? sanitizeString(row.failurePolicy.trim(), sensitiveValues) : null,
  };
}

function latestExecution(row, runResultsByCase) {
  const candidates = [...(runResultsByCase.get(String(row.id)) || [])];
  if (isPlainObject(row.latestExecution)) candidates.push(row.latestExecution);
  if (!candidates.length) return { state: null, resultId: null, revision: null };
  const ranked = candidates.map((entry, index) => ({ entry, index })).sort((left, right) => {
    const leftTime = Date.parse(left.entry.createdAt || left.entry.completedAt || '') || 0;
    const rightTime = Date.parse(right.entry.createdAt || right.entry.completedAt || '') || 0;
    const leftSequence = Number.isFinite(Number(left.entry.sequence)) ? Number(left.entry.sequence) : 0;
    const rightSequence = Number.isFinite(Number(right.entry.sequence)) ? Number(right.entry.sequence) : 0;
    return rightTime - leftTime || rightSequence - leftSequence || right.index - left.index;
  });
  const latest = ranked[0].entry;
  return {
    state: isNonBlankString(latest.executionStatus)
      ? latest.executionStatus.trim()
      : (isNonBlankString(latest.status) ? latest.status.trim() : null),
    resultId: isNonBlankString(latest.resultId || latest.id) ? String(latest.resultId || latest.id).trim() : null,
    revision: isNonBlankString(latest.executedCaseRevision || latest.executionRevision || latest.compiledCaseRevision)
      ? String(latest.executedCaseRevision || latest.executionRevision || latest.compiledCaseRevision).trim()
      : null,
  };
}

function ancestryFor(caseId, caseById) {
  const ordered = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    const entry = caseById.get(id);
    if (!entry) return;
    seen.add(id);
    entry.dependsOnIds.forEach(visit);
    ordered.push(id);
  };
  visit(caseId);
  return ordered;
}

function revisionForProject(row, path, findings, sensitiveValues) {
  const direct = firstOwn(row, ['revision', 'version']).value;
  if (direct !== undefined && direct !== null) {
    return canonicalSafeJson(direct, `${path}.revision`, findings, sensitiveValues).value;
  }
  if (row.updatedAt instanceof Date && !Number.isNaN(row.updatedAt.valueOf())) return row.updatedAt.toISOString();
  if (isNonBlankString(row.updatedAt)) return sanitizeString(row.updatedAt.trim(), sensitiveValues);
  return null;
}

function stateSatisfies(finalState, requiredState) {
  if (requiredState === null || requiredState === undefined) return false;
  if (requiredState === REDACTED || finalState === REDACTED) return false;
  if (Array.isArray(requiredState)) {
    if (!Array.isArray(finalState)) return false;
    const used = new Set();
    return requiredState.every((requiredEntry) => {
      const matchIndex = finalState.findIndex((finalEntry, index) => !used.has(index) && stateSatisfies(finalEntry, requiredEntry));
      if (matchIndex < 0) return false;
      used.add(matchIndex);
      return true;
    });
  }
  if (isPlainObject(requiredState)) {
    if (!isPlainObject(finalState)) return false;
    return Object.keys(requiredState).every((key) => hasOwn(finalState, key) && stateSatisfies(finalState[key], requiredState[key]));
  }
  return Object.is(finalState, requiredState);
}

function containsRedacted(value) {
  if (value === REDACTED) return true;
  if (Array.isArray(value)) return value.some(containsRedacted);
  if (isPlainObject(value)) return Object.values(value).some(containsRedacted);
  return false;
}

function hasGenuineStateContract(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function validateDependencies(records, idToIndex, pathPrefix, findings, field = 'dependsOnIds') {
  records.forEach((record, index) => {
    const seen = new Set();
    (record[field] || []).forEach((dependencyId, dependencyIndex) => {
      const path = `${pathPrefix}[${index}].${field}[${dependencyIndex}]`;
      if (dependencyId === record.id) addFinding(findings, path, CODES.DEPENDENCY_SELF, 'A record cannot depend on itself.');
      else if (seen.has(dependencyId)) addFinding(findings, path, CODES.DEPENDENCY_DUPLICATE, 'A dependency reference is duplicated.');
      else if (!idToIndex.has(dependencyId)) addFinding(findings, path, CODES.DEPENDENCY_MISSING, 'A dependency does not exist in the current generation.');
      else if (idToIndex.get(dependencyId) >= idToIndex.get(record.id)) addFinding(findings, path, CODES.DEPENDENCY_FORWARD, 'A dependency must point to an earlier persisted record.');
      seen.add(dependencyId);
    });
  });
}

function throwIfInvalid(findings) {
  if (findings.length) throw new ExistingScenarioContextError('Existing scenario context validation failed.', findings);
}

function createAddScenarioExistingContext(input = {}, options = {}) {
  const findings = [];
  if (!isPlainObject(input)) {
    throw new ExistingScenarioContextError('Existing scenario context validation failed.', [{
      path: '$', code: CODES.OBJECT_REQUIRED, message: 'An existing-context input object is required.',
    }]);
  }
  const project = input.currentProject || input.project;
  const generation = input.currentGeneration || input.generation;
  if (!isPlainObject(project)) addFinding(findings, 'project', CODES.OBJECT_REQUIRED, 'The explicit current project is required.');
  if (!isPlainObject(generation)) addFinding(findings, 'generation', CODES.OBJECT_REQUIRED, 'The explicit current generation is required.');
  throwIfInvalid(findings);

  const sensitiveValues = collectSensitiveLiterals(input);
  for (const value of (Array.isArray(options.sensitiveValues) ? options.sensitiveValues : [])) {
    if (isNonBlankString(value)) sensitiveValues.add(value);
  }
  const projectId = safeIdentifier(project.id, 'project.id', findings);
  const generationId = safeIdentifier(generation.id, 'generation.id', findings);
  const generationProjectId = safeIdentifier(generation.projectId, 'generation.projectId', findings);
  if (projectId && generationProjectId && projectId !== generationProjectId) {
    addFinding(findings, 'generation.projectId', CODES.PROJECT_MISMATCH, 'The generation does not belong to the explicit current project.');
    addFinding(findings, 'generation.projectId', CODES.CROSS_PROJECT, 'Cross-project existing context is forbidden.');
  }
  if (generation.isCurrent === false) {
    addFinding(findings, 'generation.isCurrent', CODES.GENERATION_NOT_CURRENT, 'The supplied generation is not current.');
  }

  let scenarioRows = readArray(input, ['persistedScenarios', 'scenarios'], 'scenarios', findings);
  if (scenarioRows === null && Array.isArray(generation.scenarios)) scenarioRows = generation.scenarios;
  if (scenarioRows === null) scenarioRows = [];
  const scenarioRecords = scenarioRows.map((row, index) => ({ row, path: `scenarios[${index}]` }));
  scenarioRecords.forEach((record) => {
    if (!isPlainObject(record.row)) addFinding(findings, record.path, CODES.OBJECT_REQUIRED, 'Each persisted scenario row must be an object.');
  });
  let orderedScenarioRecords = orderRows(scenarioRecords.filter((record) => isPlainObject(record.row)), 'scenarios', findings);

  const caseRecords = [];
  orderedScenarioRecords.forEach((scenarioRecord) => {
    if (!Array.isArray(scenarioRecord.row.cases)) return;
    scenarioRecord.row.cases.forEach((row, index) => caseRecords.push({
      row,
      path: `${scenarioRecord.path}.cases[${index}]`,
      inheritedScenarioId: scenarioRecord.row.id,
    }));
  });
  const explicitCasePath = hasOwn(input, 'currentCases') ? 'currentCases' : 'cases';
  const explicitCases = readArray(input, ['currentCases', 'persistedCases', 'cases'], explicitCasePath, findings);
  if (explicitCases) explicitCases.forEach((row, index) => caseRecords.push({ row, path: `${explicitCasePath}[${index}]`, inheritedScenarioId: null }));
  caseRecords.forEach((record) => {
    if (!isPlainObject(record.row)) addFinding(findings, record.path, CODES.OBJECT_REQUIRED, 'Each persisted case row must be an object.');
  });

  // Some callers project TestCase rows directly without loading TestScenario
  // records. Preserve their exact persisted scenarioId values by materializing
  // only a minimal index; no names, dependencies, or behavior are inferred.
  if (orderedScenarioRecords.length === 0 && explicitCases) {
    const seenScenarioIds = new Set();
    const projected = [];
    caseRecords.filter((record) => isPlainObject(record.row)).forEach((record) => {
      const scenarioId = String(record.row.scenarioId || '').trim();
      if (!scenarioId || seenScenarioIds.has(scenarioId)) return;
      seenScenarioIds.add(scenarioId);
      projected.push({
        row: {
          id: scenarioId,
          projectId,
          generationId,
          ordinal: projected.length + 1,
          dependencyOn: [],
        },
        path: `projectedScenarios[${projected.length}]`,
      });
    });
    orderedScenarioRecords = orderRows(projected, 'projectedScenarios', findings);
  }

  const rawStepRecords = [];
  caseRecords.filter((record) => isPlainObject(record.row)).forEach((caseRecord) => {
    const rawSteps = caseRecord.row.steps;
    if (rawSteps === undefined || rawSteps === null || rawSteps === '') return;
    const steps = decodeArray(rawSteps, `${caseRecord.path}.steps`, findings);
    steps.forEach((row, index) => rawStepRecords.push({
      row,
      path: `${caseRecord.path}.steps[${index}]`,
      inheritedCaseId: caseRecord.row.id,
    }));
  });
  const explicitSteps = readArray(input, ['persistedSteps', 'steps'], 'steps', findings);
  if (explicitSteps) explicitSteps.forEach((row, index) => rawStepRecords.push({ row, path: `steps[${index}]`, inheritedCaseId: null }));
  rawStepRecords.forEach((record) => {
    if (!isPlainObject(record.row)) addFinding(findings, record.path, CODES.OBJECT_REQUIRED, 'Each persisted step row must be an object.');
  });

  const scenarioIdToIndex = new Map();
  const scenarioDrafts = orderedScenarioRecords.map((record, index) => {
    const row = record.row;
    const id = safeIdentifier(row.id, `${record.path}.id`, findings);
    if (id && scenarioIdToIndex.has(id)) addFinding(findings, `${record.path}.id`, CODES.ID_DUPLICATE, 'A persisted scenario identifier is duplicated.');
    else if (id) scenarioIdToIndex.set(id, index);
    if (hasOwn(row, 'projectId') && row.projectId !== null && String(row.projectId) !== projectId) {
      addFinding(findings, `${record.path}.projectId`, CODES.PROJECT_MISMATCH, 'A scenario belongs to a different project.');
      addFinding(findings, `${record.path}.projectId`, CODES.CROSS_PROJECT, 'Cross-project existing context is forbidden.');
    }
    if (hasOwn(row, 'generationId') && row.generationId !== null && String(row.generationId) !== generationId) {
      addFinding(findings, `${record.path}.generationId`, CODES.GENERATION_MISMATCH, 'A scenario belongs to a different generation.');
    }
    return {
      id,
      revision: normalizeRevision(row, record.path, findings, sensitiveValues),
      ordinal: record.ordinal,
      name: isNonBlankString(row.name) ? sanitizeString(row.name.trim(), sensitiveValues) : null,
      dependsOnIds: normalizeReferenceList(firstOwn(row, ['dependsOnIds', 'dependencyOn']).value, `${record.path}.dependsOnIds`, findings),
      caseIds: [],
    };
  });

  const runResultRows = readArray(input, ['runResults', 'persistedRunResults'], 'runResults', findings) || [];
  const runResultsByCase = new Map();
  runResultRows.forEach((row, index) => {
    if (!isPlainObject(row)) {
      addFinding(findings, `runResults[${index}]`, CODES.OBJECT_REQUIRED, 'Each persisted run result must be an object.');
      return;
    }
    const caseId = String(row.testCaseId || row.caseId || '').trim();
    if (!caseId) {
      addFinding(findings, `runResults[${index}].testCaseId`, CODES.FIELD_REQUIRED, 'A run result case reference is required.');
      return;
    }
    if (!runResultsByCase.has(caseId)) runResultsByCase.set(caseId, []);
    runResultsByCase.get(caseId).push(row);
  });

  const casesByScenario = new Map();
  caseRecords.filter((record) => isPlainObject(record.row)).forEach((record) => {
    const scenarioId = String(record.row.scenarioId || record.inheritedScenarioId || '').trim();
    if (!casesByScenario.has(scenarioId)) casesByScenario.set(scenarioId, []);
    casesByScenario.get(scenarioId).push(record);
  });
  const orderedCaseRecords = [];
  if (explicitCases !== null) {
    orderedCaseRecords.push(...orderRows(
      caseRecords.filter((record) => isPlainObject(record.row)),
      explicitCasePath,
      findings,
    ));
  } else {
    orderedScenarioRecords.forEach((scenarioRecord) => {
      const scenarioId = String(scenarioRecord.row.id || '').trim();
      const scoped = orderRows(casesByScenario.get(scenarioId) || [], `${scenarioRecord.path}.cases`, findings);
      orderedCaseRecords.push(...scoped.map((record) => ({ ...record, scenarioOrdinal: scenarioRecord.ordinal })));
    });
  }
  for (const [scenarioId, records] of casesByScenario.entries()) {
    if (scenarioIdToIndex.has(scenarioId)) continue;
    records.forEach((record) => addFinding(findings, `${record.path}.scenarioId`, CODES.REFERENCE_MISSING, 'A case references a scenario outside the current generation.'));
  }

  const stepsByCase = new Map();
  rawStepRecords.filter((record) => isPlainObject(record.row)).forEach((record) => {
    const caseId = String(record.row.testCaseId || record.row.caseId || record.inheritedCaseId || '').trim();
    if (!stepsByCase.has(caseId)) stepsByCase.set(caseId, []);
    stepsByCase.get(caseId).push(record);
  });

  const caseIdToIndex = new Map();
  const caseDrafts = orderedCaseRecords.map((record, globalIndex) => {
    const row = record.row;
    const id = safeIdentifier(row.id, `${record.path}.id`, findings);
    if (id && caseIdToIndex.has(id)) addFinding(findings, `${record.path}.id`, CODES.ID_DUPLICATE, 'A persisted case identifier is duplicated.');
    else if (id) caseIdToIndex.set(id, globalIndex);
    const scenarioId = safeIdentifier(row.scenarioId || record.inheritedScenarioId, `${record.path}.scenarioId`, findings);
    if (hasOwn(row, 'projectId') && row.projectId !== null && String(row.projectId) !== projectId) {
      addFinding(findings, `${record.path}.projectId`, CODES.PROJECT_MISMATCH, 'A case belongs to a different project.');
      addFinding(findings, `${record.path}.projectId`, CODES.CROSS_PROJECT, 'Cross-project existing context is forbidden.');
    }
    if (hasOwn(row, 'generationId') && row.generationId !== null && String(row.generationId) !== generationId) {
      addFinding(findings, `${record.path}.generationId`, CODES.GENERATION_MISMATCH, 'A case belongs to a different generation.');
    }
    const initialRaw = selectState(row, ['requiresStateJson'], record.path, findings);
    const finalRaw = selectState(row, ['producesStateJson'], record.path, findings);
    const initial = canonicalSafeJson(initialRaw, `${record.path}.initialState`, findings, sensitiveValues);
    const final = canonicalSafeJson(finalRaw, `${record.path}.expectedFinalState`, findings, sensitiveValues);
    const orderedSteps = orderRows(stepsByCase.get(String(row.id)) || [], `${record.path}.steps`, findings);
    const operations = orderedSteps.map((stepRecord) => normalizeOperation(stepRecord.row, {
      path: stepRecord.path,
      ordinal: stepRecord.ordinal,
      findings,
      sensitiveValues,
    }));
    const steps = orderedSteps.map((stepRecord) => normalizePersistedStep(stepRecord.row, {
      path: stepRecord.path,
      ordinal: stepRecord.ordinal,
      findings,
      sensitiveValues,
    }));
    const declaredAssertions = normalizeDeclaredAssertions(row, record.path, findings, sensitiveValues);
    const execution = latestExecution(row, runResultsByCase);
    const revision = normalizeRevision(row, record.path, findings, sensitiveValues);
    const approvalStatus = isNonBlankString(row.status) ? row.status.trim() : null;
    const sessionMode = isNonBlankString(row.sessionMode) ? row.sessionMode.trim() : 'fresh';
    const failurePolicy = isNonBlankString(row.failurePolicy) ? row.failurePolicy.trim() : null;
    return {
      id,
      revision,
      ordinal: record.ordinal,
      projectId,
      generationId,
      scenarioId,
      name: isNonBlankString(row.name) ? sanitizeString(row.name.trim(), sensitiveValues) : null,
      initialState: initial.value,
      expectedFinalState: final.value,
      requiresState: initial.value,
      producesState: final.value,
      stateSafety: { initialStateRedacted: initial.redacted, expectedFinalStateRedacted: final.redacted },
      sessionIntent: normalizeSessionIntent(row, record.path, findings, sensitiveValues),
      sessionMode,
      failurePolicy,
      dependsOnIds: normalizeReferenceList(row.dependsOnIds, `${record.path}.dependsOnIds`, findings),
      approvalStatus,
      approvalState: approvalStatus || (isNonBlankString(row.readinessStatus) ? row.readinessStatus.trim() : null),
      readinessStatus: isNonBlankString(row.readinessStatus) ? row.readinessStatus.trim() : null,
      runEligibility: isNonBlankString(row.runEligibility) ? row.runEligibility.trim() : null,
      executionStatus: execution.state,
      executionRevision: execution.revision,
      executionState: execution.state,
      executionResultId: execution.resultId,
      operations,
      steps,
      assertions: isNonBlankString(row.assertions) ? sanitizeString(row.assertions.trim(), sensitiveValues) : null,
      declaredAssertions,
      inlineDataRefs: collectInlineDataRefs({
        dataBinding: parseJson(row.dataBindingJson, `${record.path}.dataBindingJson`, findings, row.dataBindingJson),
        operations: orderedSteps.map((entry) => entry.row),
      }),
    };
  });

  caseDrafts.forEach((entry) => {
    const scenarioIndex = scenarioIdToIndex.get(entry.scenarioId);
    if (scenarioIndex !== undefined) scenarioDrafts[scenarioIndex].caseIds.push(entry.id);
  });
  validateDependencies(scenarioDrafts, scenarioIdToIndex, 'scenarios', findings);
  validateDependencies(caseDrafts, caseIdToIndex, 'cases', findings);
  caseDrafts.forEach((entry, index) => {
    const operationIndexById = new Map();
    entry.operations.forEach((operation, operationIndex) => {
      if (!operation.id) return;
      if (operationIndexById.has(operation.id)) addFinding(findings, `cases[${index}].operations[${operationIndex}].id`, CODES.ID_DUPLICATE, 'A persisted operation identifier is duplicated within its case.');
      else operationIndexById.set(operation.id, operationIndex);
    });
    validateDependencies(entry.operations, operationIndexById, `cases[${index}].operations`, findings);
  });
  for (const [caseId, records] of stepsByCase.entries()) {
    if (caseIdToIndex.has(caseId)) continue;
    records.forEach((record) => addFinding(findings, `${record.path}.caseId`, CODES.REFERENCE_MISSING, 'A step references a case outside the current generation.'));
  }
  for (const caseId of runResultsByCase.keys()) {
    if (!caseIdToIndex.has(caseId)) addFinding(findings, 'runResults', CODES.REFERENCE_MISSING, 'A run result references a case outside the current generation.');
  }

  const dependencyFaultCodes = new Set([
    CODES.DEPENDENCY_DUPLICATE,
    CODES.DEPENDENCY_MISSING,
    CODES.DEPENDENCY_FORWARD,
    CODES.DEPENDENCY_SELF,
  ]);
  if (findings.some((finding) => dependencyFaultCodes.has(finding.code))) {
    addFinding(findings, 'cases', CODES.DEPENDENCY_INVALID, 'The persisted dependency graph is invalid and cannot be repaired while authoring.');
  }

  const continuationInput = isPlainObject(input.continuation) ? input.continuation : {};
  const rootRequested = firstOwn(input, ['requestedInitialState', 'newScenarioInitialState']).value;
  let requestedInput;
  let requestedPath;
  if (hasOwn(continuationInput, 'requiredInitialStateJson')) {
    requestedInput = parseJson(
      continuationInput.requiredInitialStateJson,
      'continuation.requiredInitialStateJson',
      findings,
      null,
    );
    requestedPath = 'continuation.requiredInitialStateJson';
  } else if (hasOwn(continuationInput, 'requestedInitialState')) {
    requestedInput = continuationInput.requestedInitialState;
    requestedPath = 'continuation.requestedInitialState';
  } else if (rootRequested !== undefined) {
    requestedInput = rootRequested;
    requestedPath = 'requestedInitialState';
  } else if (options.requestedInitialState !== undefined) {
    requestedInput = options.requestedInitialState;
    requestedPath = 'requestedInitialState';
  } else {
    requestedInput = null;
    requestedPath = 'requestedInitialState';
  }
  if (typeof requestedInput === 'string') {
    const trimmed = requestedInput.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      requestedInput = parseJson(trimmed, requestedPath, findings, null);
    }
  }
  const requested = canonicalSafeJson(requestedInput, requestedPath, findings, sensitiveValues);
  const predecessorInput = firstOwn(input, ['predecessorCaseId', 'continuationParentCaseId']).value
    ?? continuationInput.predecessorCaseId
    ?? options.predecessorCaseId;
  const predecessorCaseId = predecessorInput === undefined || predecessorInput === null || predecessorInput === ''
    ? null
    : safeIdentifier(predecessorInput, 'continuation.predecessorCaseId', findings);
  if (predecessorCaseId && !caseIdToIndex.has(predecessorCaseId)) {
    addFinding(findings, 'continuation.predecessorCaseId', CODES.DEPENDENCY_MISSING, 'The explicit predecessor is not an existing case in the current generation.');
    addFinding(findings, 'continuation.predecessorCaseId', CODES.DEPENDENCY_INVALID, 'The explicit predecessor is outside the persisted dependency graph.');
  }
  const hasGenuineRequestedState = hasGenuineStateContract(requested.value);
  const effectiveRequestedState = hasGenuineRequestedState ? requested.value : null;
  const requestedContinuation = typeof continuationInput.requested === 'boolean'
    ? (continuationInput.requested || Boolean(predecessorCaseId))
    : Boolean(predecessorCaseId || hasGenuineRequestedState);
  const mode = requestedContinuation
    ? (isNonBlankString(continuationInput.mode) ? continuationInput.mode.trim() : 'continue_from_dependency')
    : 'fresh';
  const sameSession = requestedContinuation
    ? (typeof continuationInput.sameSession === 'boolean' ? continuationInput.sameSession : mode !== 'fresh')
    : false;
  let candidates = [];
  if (requestedContinuation && hasGenuineRequestedState && !containsRedacted(effectiveRequestedState)) {
    candidates = caseDrafts.filter((entry) => (
      entry.expectedFinalState !== null
      && stateSatisfies(entry.expectedFinalState, effectiveRequestedState)
    )).map((entry) => ({
      caseId: entry.id,
      caseRevision: entry.revision,
      scenarioId: entry.scenarioId,
      caseOrdinal: entry.ordinal,
      expectedFinalState: entry.expectedFinalState,
      approvalState: entry.approvalState,
      executionState: entry.executionState,
      proof: 'declared_final_state_satisfies_requested_initial_state',
    }));
  }
  if (requestedContinuation && predecessorCaseId && !hasGenuineRequestedState) {
    const pendingCase = caseDrafts.find((entry) => entry.id === predecessorCaseId);
    if (pendingCase) candidates = [{
      caseId: pendingCase.id,
      caseRevision: pendingCase.revision,
      scenarioId: pendingCase.scenarioId,
      caseOrdinal: pendingCase.ordinal,
      expectedFinalState: pendingCase.expectedFinalState,
      approvalState: pendingCase.approvalState,
      executionState: pendingCase.executionState,
      proof: 'explicit_predecessor_pending_state_validation',
    }];
  }
  if (requestedContinuation && predecessorCaseId && hasGenuineRequestedState
    && !candidates.some((candidate) => candidate.caseId === predecessorCaseId)) {
    findings.push({
      path: requestedPath,
      code: CODES.FINAL_STATE_INCOMPATIBLE,
      message: 'The explicit predecessor final state does not satisfy the requested initial state.',
      predecessorCaseId,
    });
  }

  const candidateCaseIds = candidates.map((candidate) => candidate.caseId);
  let resolution = 'fresh';
  let reason = null;
  let selectedCaseId = null;
  let unresolved = null;
  if (requestedContinuation) {
    if (predecessorCaseId && !hasGenuineRequestedState) {
      resolution = 'pending_state_validation';
      reason = 'awaiting_requested_initial_state';
      selectedCaseId = predecessorCaseId;
    } else if (!hasGenuineRequestedState) {
      resolution = 'unresolved';
      reason = 'requested_initial_state_missing';
    } else if (requested.redacted || containsRedacted(effectiveRequestedState)) {
      resolution = 'unresolved';
      reason = 'requested_initial_state_contains_unresolved_sensitive_data';
    } else if (predecessorCaseId && candidateCaseIds.includes(predecessorCaseId)) {
      resolution = 'resolved';
      selectedCaseId = predecessorCaseId;
    } else if (!predecessorCaseId && candidates.length === 1) {
      resolution = 'resolved';
      selectedCaseId = candidates[0].caseId;
    } else if (candidates.length > 1) {
      resolution = 'unresolved';
      reason = 'ambiguous_compatible_predecessors';
    } else {
      resolution = 'unresolved';
      reason = 'no_compatible_predecessor';
    }
    if (resolution === 'unresolved') unresolved = {
      code: reason === 'ambiguous_compatible_predecessors'
        ? 'continuation_ambiguous'
        : (reason === 'no_compatible_predecessor' ? 'continuation_not_provable' : reason),
      message: reason === 'ambiguous_compatible_predecessors'
        ? 'More than one existing case can satisfy the requested initial state.'
        : 'Continuation cannot be proven from the persisted final-state graph.',
      candidateCaseIds,
    };
  }

  const caseById = new Map(caseDrafts.map((entry) => [entry.id, entry]));
  const ancestryCaseIds = selectedCaseId ? ancestryFor(selectedCaseId, caseById) : [];
  const selectedCase = selectedCaseId ? caseById.get(selectedCaseId) : null;

  throwIfInvalid(findings);
  const body = {
    version: EXISTING_SCENARIO_CONTEXT_VERSION,
    projectId,
    project: {
      id: projectId,
      revision: revisionForProject(project, 'project', findings, sensitiveValues),
    },
    generation: {
      id: generationId,
      projectId: generationProjectId,
      revision: revisionForProject(generation, 'generation', findings, sensitiveValues),
      version: Number.isInteger(Number(generation.version)) ? Number(generation.version) : null,
      isCurrent: generation.isCurrent !== false,
    },
    scenarios: scenarioDrafts,
    cases: caseDrafts,
    continuation: {
      requestedInitialState: effectiveRequestedState,
      requiredInitialState: requestedContinuation ? effectiveRequestedState : [],
      requested: requestedContinuation,
      mode,
      resolution,
      sameSession,
      predecessorCaseId,
      candidateCaseIds,
      ancestryCaseIds,
      resolvedFinalState: resolution === 'resolved' && selectedCase ? selectedCase.expectedFinalState : null,
      finalStateCompatible: resolution === 'resolved' ? true : (resolution === 'pending_state_validation' ? null : (requestedContinuation ? false : null)),
      reason,
      status: resolution,
      selectedCaseId,
      candidates,
      unresolved,
    },
  };
  throwIfInvalid(findings);
  const digest = computeAddScenarioExistingContextDigest(body);
  const context = { ...body, digest, contextDigest: digest };
  const serialized = stableSerialize(context);
  const leaked = [...sensitiveValues].some((literal) => typeof literal === 'string' && literal.length >= 3 && serialized.includes(literal));
  if (leaked) {
    throw new ExistingScenarioContextError('Existing scenario context validation failed.', [{
      path: '$', code: CODES.SENSITIVE_LITERAL, message: 'A sensitive literal reached the existing-context boundary.',
    }]);
  }
  return deepFreeze(context);
}

function computeAddScenarioExistingContextDigest(context) {
  if (!context || typeof context !== 'object') return sha256(stableSerialize(null));
  const body = {};
  Object.keys(context).filter((key) => !['digest', 'contextDigest'].includes(key)).forEach((key) => { body[key] = context[key]; });
  return sha256(stableSerialize(body));
}

function validateAddScenarioExistingContext(context) {
  const findings = [];
  if (!isPlainObject(context)) {
    addFinding(findings, '$', CODES.OBJECT_REQUIRED, 'An existing scenario context object is required.');
    return { valid: false, findings: normalizeFindings(findings) };
  }
  if (context.version !== EXISTING_SCENARIO_CONTEXT_VERSION) {
    addFinding(findings, 'version', CODES.FIELD_REQUIRED, 'The existing scenario context version is unsupported.');
  }
  if (!isNonBlankString(context.projectId)) addFinding(findings, 'projectId', CODES.FIELD_REQUIRED, 'The top-level project identifier is required.');
  if (!isPlainObject(context.project) || !isNonBlankString(context.project.id)) addFinding(findings, 'project.id', CODES.FIELD_REQUIRED, 'The project identifier is required.');
  if (!isPlainObject(context.generation) || !isNonBlankString(context.generation.id)) addFinding(findings, 'generation.id', CODES.FIELD_REQUIRED, 'The generation identifier is required.');
  if (isPlainObject(context.project) && isPlainObject(context.generation)
    && context.project.id !== context.generation.projectId) {
    addFinding(findings, 'generation.projectId', CODES.PROJECT_MISMATCH, 'The generation does not belong to the context project.');
  }
  if (!Array.isArray(context.scenarios)) addFinding(findings, 'scenarios', CODES.ARRAY_REQUIRED, 'Canonical scenarios must be an array.');
  if (!Array.isArray(context.cases)) addFinding(findings, 'cases', CODES.ARRAY_REQUIRED, 'Canonical cases must be an array.');
  const scenarios = Array.isArray(context.scenarios) ? context.scenarios : [];
  const cases = Array.isArray(context.cases) ? context.cases : [];
  const validateOrderedIds = (records, path) => {
    const idToIndex = new Map();
    records.forEach((record, index) => {
      if (!isPlainObject(record)) {
        addFinding(findings, `${path}[${index}]`, CODES.OBJECT_REQUIRED, 'Canonical records must be objects.');
        return;
      }
      if (record.ordinal !== index + 1) addFinding(findings, `${path}[${index}].ordinal`, CODES.ORDINAL_NOT_CONTIGUOUS, 'Canonical ordinals must be contiguous and one-based.');
      if (!isNonBlankString(record.id)) addFinding(findings, `${path}[${index}].id`, CODES.FIELD_REQUIRED, 'A canonical identifier is required.');
      else if (idToIndex.has(record.id)) addFinding(findings, `${path}[${index}].id`, CODES.ID_DUPLICATE, 'A canonical identifier is duplicated.');
      else idToIndex.set(record.id, index);
    });
    validateDependencies(records.filter(isPlainObject), idToIndex, path, findings);
    return idToIndex;
  };
  const scenarioIds = validateOrderedIds(scenarios, 'scenarios');
  const caseIds = new Map();
  cases.forEach((record, index) => {
    if (!isPlainObject(record)) {
      addFinding(findings, `cases[${index}]`, CODES.OBJECT_REQUIRED, 'Canonical records must be objects.');
      return;
    }
    if (record.ordinal !== index + 1) addFinding(findings, `cases[${index}].ordinal`, CODES.ORDINAL_NOT_CONTIGUOUS, 'Canonical case ordinals must be contiguous and preserve persisted suite order.');
    if (!isNonBlankString(record.id)) addFinding(findings, `cases[${index}].id`, CODES.FIELD_REQUIRED, 'A canonical identifier is required.');
    else if (caseIds.has(record.id)) addFinding(findings, `cases[${index}].id`, CODES.ID_DUPLICATE, 'A canonical identifier is duplicated.');
    else caseIds.set(record.id, index);
  });
  validateDependencies(cases.filter(isPlainObject), caseIds, 'cases', findings);
  cases.forEach((entry, caseIndex) => {
    if (!isPlainObject(entry)) return;
    if (!scenarioIds.has(entry.scenarioId)) addFinding(findings, `cases[${caseIndex}].scenarioId`, CODES.REFERENCE_MISSING, 'A canonical case references an unknown scenario.');
    if (entry.parentCaseId) {
      if (!caseIds.has(entry.parentCaseId)) addFinding(findings, `cases[${caseIndex}].parentCaseId`, CODES.DEPENDENCY_MISSING, 'A canonical parent case is unknown.');
      else if (caseIds.get(entry.parentCaseId) >= caseIndex) addFinding(findings, `cases[${caseIndex}].parentCaseId`, CODES.DEPENDENCY_FORWARD, 'A canonical parent case must point backward.');
    }
    const operations = Array.isArray(entry.operations) ? entry.operations : [];
    if (!Array.isArray(entry.operations)) addFinding(findings, `cases[${caseIndex}].operations`, CODES.ARRAY_REQUIRED, 'Canonical operations must be an array.');
    const operationIds = new Map();
    operations.forEach((operation, operationIndex) => {
      if (!isPlainObject(operation)) {
        addFinding(findings, `cases[${caseIndex}].operations[${operationIndex}]`, CODES.OBJECT_REQUIRED, 'Canonical operations must be objects.');
        return;
      }
      if (operation.ordinal !== operationIndex + 1) addFinding(findings, `cases[${caseIndex}].operations[${operationIndex}].ordinal`, CODES.ORDINAL_NOT_CONTIGUOUS, 'Canonical operation ordinals must be contiguous.');
      if (operation.id && operationIds.has(operation.id)) addFinding(findings, `cases[${caseIndex}].operations[${operationIndex}].id`, CODES.ID_DUPLICATE, 'A canonical operation identifier is duplicated.');
      else if (operation.id) operationIds.set(operation.id, operationIndex);
    });
    validateDependencies(operations.filter(isPlainObject), operationIds, `cases[${caseIndex}].operations`, findings);
  });
  const expectedDigest = computeAddScenarioExistingContextDigest(context);
  if (!DIGEST_RE.test(String(context.digest || '')) || context.digest !== expectedDigest
    || !DIGEST_RE.test(String(context.contextDigest || '')) || context.contextDigest !== expectedDigest) {
    addFinding(findings, 'digest', CODES.DIGEST_MISMATCH, 'The existing scenario context digest does not match its canonical content.');
  }
  if (!isDeepFrozen(context)) addFinding(findings, '$', CODES.CONTRACT_NOT_FROZEN, 'The existing scenario context must be deeply frozen.');
  return { valid: findings.length === 0, findings: normalizeFindings(findings) };
}

module.exports = {
  EXISTING_SCENARIO_CONTEXT_VERSION,
  REDACTED,
  CODES,
  ExistingScenarioContextError,
  createAddScenarioExistingContext,
  validateAddScenarioExistingContext,
  computeAddScenarioExistingContextDigest,
};
