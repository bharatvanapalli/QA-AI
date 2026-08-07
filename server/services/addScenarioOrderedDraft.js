'use strict';

const crypto = require('node:crypto');
const {
  VALID_STEP_TYPES,
  VALID_ASSERTION_TYPES,
  VALID_TARGET_KINDS,
  VALID_SELECTION_KINDS,
  VALID_FAILURE_BEHAVIORS,
  VALID_SESSION_MODES,
  VALID_SOURCE_DISPOSITIONS,
  ASSERTION_TYPE_COMPARATORS,
  FINDING_CODES,
  isValueRef,
  isCanonicalDate,
  isCanonicalTime,
  isCanonicalDateTime,
} = require('./caseContractSemanticValidator');

const ORDERED_DRAFT_VERSION = 'AddScenarioOrderedDraftV1';
const MAX_ORDERED_OPERATIONS = 100;
const REDACTED_SOURCE = '[REDACTED]';
const SHA256_RE = /^sha256-[a-f0-9]{64}$/;
const SENSITIVE_LABEL_RE = /(?:^|[^a-z0-9])(?:pass(?:word)?|pwd|secret|token|api[_ -]?key|credential|otp|mfa|pin)(?:$|[^a-z0-9])/i;

const CODES = Object.freeze({
  OPERATION_LIMIT_EXCEEDED: 'semantic_contract_operation_limit_exceeded',
  OPERATION_KIND_UNSUPPORTED: 'semantic_contract_operation_kind_unsupported',
  SOURCE_DIGEST_MISMATCH: 'semantic_contract_source_digest_mismatch',
  CONTRACT_DIGEST_MISMATCH: 'semantic_contract_contract_digest_mismatch',
  CONTRACT_NOT_FROZEN: 'semantic_contract_not_frozen',
  SENSITIVE_LITERAL: FINDING_CODES.SENSITIVE_LITERAL || 'semantic_contract_sensitive_literal_forbidden',
  VALUE_AUTHORITY_AMBIGUOUS: FINDING_CODES.VALUE_AUTHORITY_AMBIGUOUS,
  VALUE_REF_INVALID: FINDING_CODES.VALUE_REF_INVALID,
  SELECTION_INVALID: FINDING_CODES.SELECTION_INVALID,
  CONDITION_INVALID: FINDING_CODES.CONDITION_INVALID,
});

const INPUT_ROOT_FIELDS = new Set([
  'version', 'name', 'intent', 'initialState', 'expectedFinalState', 'sessionIntent',
  'parentCaseRef', 'sourceText', 'sourceDigest', 'contractDigest', 'sourceClauses',
  'cases', 'operations', 'sensitiveValues',
]);
const CANONICAL_ROOT_FIELDS = new Set(['version', 'sourceDigest', 'contractDigest', 'sourceClauses', 'cases']);
const INPUT_CASE_FIELDS = new Set([
  'id', 'ref', 'ordinal', 'name', 'intent', 'initialState', 'expectedFinalState',
  'sessionIntent', 'parentCaseRef', 'operations',
]);
const CANONICAL_CASE_FIELDS = new Set([
  'id', 'ordinal', 'name', 'intent', 'initialState', 'expectedFinalState',
  'sessionIntent', 'parentCaseRef', 'operations',
]);
const INPUT_CLAUSE_FIELDS = new Set([
  'id', 'ref', 'ordinal', 'disposition', 'kind', 'sourceQuote', 'text', 'sourceSpan', 'sensitive',
]);
const CANONICAL_CLAUSE_FIELDS = new Set([
  'id', 'ordinal', 'disposition', 'sourceSpan', 'quoteDigest', 'redacted', 'sourceQuote',
]);
const INPUT_OPERATION_FIELDS = new Set([
  'id', 'ref', 'ordinal', 'kind', 'type', 'text', 'target', 'targetIdentity',
  'value', 'valueRef', 'selection', 'selectionCriteria', 'expected', 'expectedRef',
  'comparator', 'required', 'condition', 'failureBehavior', 'dependencies', 'dependsOn',
  'sourceRefs', 'sourceClauseRefs', 'sourceQuote', 'sourceSpan',
]);
const CANONICAL_COMMON_OPERATION_FIELDS = new Set([
  'id', 'ordinal', 'kind', 'type', 'text', 'target', 'required', 'condition',
  'failureBehavior', 'dependencies', 'sourceRefs', 'sourceSpan', 'quoteDigest',
  'redacted', 'sourceQuote',
]);

class AddScenarioOrderedDraftError extends Error {
  constructor(message, findings = [], code = 'ADD_SCENARIO_ORDERED_DRAFT_INVALID') {
    super(message);
    this.name = 'AddScenarioOrderedDraftError';
    this.code = code;
    this.status = 422;
    this.findings = Array.isArray(findings) ? findings : [];
  }
}

class AddScenarioOperationLimitError extends AddScenarioOrderedDraftError {
  constructor(findings) {
    super(
      `Add Scenario drafts support at most ${MAX_ORDERED_OPERATIONS} combined operations.`,
      findings,
      'SEMANTIC_CONTRACT_OPERATION_LIMIT_EXCEEDED',
    );
    this.name = 'AddScenarioOperationLimitError';
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

function reportUnknownFields(value, allowed, path, findings) {
  if (!isPlainObject(value)) return;
  Object.keys(value).forEach((field) => {
    if (!allowed.has(field)) addFinding(findings, path, 'UNKNOWN_FIELD', 'An unsupported field is present and cannot be discarded.');
  });
}

function cloneCanonicalJson(value, path, findings, stack = new WeakSet(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    addFinding(findings, path, 'NON_FINITE_NUMBER', 'JSON numbers must be finite.');
    return undefined;
  }
  if (typeof value !== 'object') {
    addFinding(findings, path, 'NON_JSON_VALUE', 'The value must be JSON-safe and cannot be coerced.');
    return undefined;
  }
  if (depth > 64) {
    addFinding(findings, path, 'VALUE_TOO_DEEP', 'JSON values cannot exceed 64 nested levels.');
    return undefined;
  }
  if (stack.has(value)) {
    addFinding(findings, path, 'CIRCULAR_VALUE', 'Circular values are not supported.');
    return undefined;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    addFinding(findings, path, 'NON_PLAIN_OBJECT', 'Objects must use plain JSON object semantics.');
    return undefined;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    addFinding(findings, path, 'SYMBOL_KEYS_NOT_SUPPORTED', 'Symbol keys are not supported.');
    return undefined;
  }

  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => cloneCanonicalJson(entry, `${path}[${index}]`, findings, stack, depth + 1));
  } else {
    result = {};
    Object.keys(value).sort().forEach((key) => {
      Object.defineProperty(result, key, {
        value: cloneCanonicalJson(value[key], `${path}.*`, findings, stack, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
  }
  stack.delete(value);
  return result;
}

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

function sha256Text(value) {
  return `sha256-${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function sourceDigest(sourceText) {
  return sha256Text(sourceText);
}

function semanticId(prefix, value, occurrence) {
  const hash = crypto.createHash('sha256').update(stableSerialize(value), 'utf8').digest('hex').slice(0, 20);
  return `${prefix}-${hash}-${String(occurrence).padStart(2, '0')}`;
}

function normalizeEnum(value, allowed) {
  if (!isNonBlankString(value)) return '';
  const key = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return allowed.find((candidate) => candidate.toLowerCase().replace(/[^a-z0-9]+/g, '') === key) || '';
}

function jsonEquivalent(left, right) {
  try {
    return stableSerialize(left) === stableSerialize(right);
  } catch (_) {
    return false;
  }
}

function aliasedValue(raw, canonicalName, aliasName, path, findings, { required = false } = {}) {
  const hasCanonical = hasOwn(raw, canonicalName);
  const hasAlias = hasOwn(raw, aliasName);
  if (hasCanonical && hasAlias && !jsonEquivalent(raw[canonicalName], raw[aliasName])) {
    addFinding(findings, path, 'CONFLICTING_ALIASES', 'Two equivalent contract fields contain conflicting values.');
  }
  if (!hasCanonical && !hasAlias && required) {
    addFinding(findings, `${path}.${canonicalName}`, 'FIELD_REQUIRED', `${canonicalName} is required.`);
  }
  if (hasCanonical) return raw[canonicalName];
  if (hasAlias) return raw[aliasName];
  return undefined;
}

function normalizeReferenceArray(value, path, findings, {
  required = false,
  duplicateCode = 'DUPLICATE_REFERENCE',
} = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) {
    addFinding(findings, path, required ? FINDING_CODES.SOURCE_REFS_MISSING : 'ARRAY_REQUIRED', 'An array of references is required.');
    return [];
  }
  if (required && value.length === 0) {
    addFinding(findings, path, FINDING_CODES.SOURCE_REFS_MISSING, 'At least one source reference is required.');
  }
  const output = [];
  const seen = new Set();
  value.forEach((entry, index) => {
    if (!isNonBlankString(entry)) {
      addFinding(findings, `${path}[${index}]`, 'NON_EMPTY_STRING_REQUIRED', 'References must be non-empty strings.');
      return;
    }
    const normalized = entry.trim();
    if (seen.has(normalized)) {
      addFinding(findings, `${path}[${index}]`, duplicateCode, 'Duplicate references are not permitted.');
      return;
    }
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

function occurrences(sourceText, quote) {
  const output = [];
  if (!sourceText || !quote) return output;
  let offset = 0;
  while (offset <= sourceText.length - quote.length) {
    const index = sourceText.indexOf(quote, offset);
    if (index < 0) break;
    output.push(index);
    offset = index + Math.max(quote.length, 1);
  }
  return output;
}

function normalizeEvidence(quote, span, sourceText, path, findings) {
  if (!isNonBlankString(quote)) {
    addFinding(findings, `${path}.sourceQuote`, FINDING_CODES.SOURCE_QUOTE_MISSING, 'An exact non-empty source quote is required.');
    return null;
  }
  let normalizedSpan = null;
  if (span !== undefined && span !== null) {
    if (!isPlainObject(span) || !Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < 0 || span.end <= span.start || span.end > sourceText.length) {
      addFinding(findings, `${path}.sourceSpan`, FINDING_CODES.SOURCE_SPAN_INVALID, 'Source span must use valid zero-based start and end offsets.');
      return null;
    }
    normalizedSpan = { start: span.start, end: span.end };
    if (sourceText.slice(span.start, span.end) !== quote) {
      addFinding(findings, `${path}.sourceSpan`, FINDING_CODES.SOURCE_SPAN_QUOTE_MISMATCH, 'The source span does not select the exact source quote.');
      return null;
    }
  } else {
    const matches = occurrences(sourceText, quote);
    if (matches.length === 0) {
      addFinding(findings, `${path}.sourceQuote`, FINDING_CODES.SOURCE_QUOTE_NOT_FOUND, 'The exact source quote does not occur in the source input.');
      return null;
    }
    if (matches.length > 1) {
      addFinding(findings, `${path}.sourceQuote`, FINDING_CODES.SOURCE_QUOTE_AMBIGUOUS, 'A repeated source quote requires an explicit source span.');
      return null;
    }
    normalizedSpan = { start: matches[0], end: matches[0] + quote.length };
  }
  return { quote, span: normalizedSpan, quoteDigest: sha256Text(quote) };
}

function containsSensitiveValue(value, sensitiveValues) {
  if (!sensitiveValues.length) return false;
  if (typeof value === 'string') return sensitiveValues.some((literal) => value.includes(literal));
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveValue(entry, sensitiveValues));
  if (isPlainObject(value)) return Object.entries(value).some(([key, entry]) => (
    sensitiveValues.some((literal) => key.includes(literal)) || containsSensitiveValue(entry, sensitiveValues)
  ));
  return false;
}

function hasSensitiveTarget(target) {
  try {
    return SENSITIVE_LABEL_RE.test(stableSerialize(target));
  } catch (_) {
    return false;
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function throwInvalid(findings) {
  if (findings.length > 0) {
    throw new AddScenarioOrderedDraftError('Add Scenario ordered draft validation failed.', findings);
  }
}

function operationCount(rawCases) {
  return rawCases.reduce((total, rawCase) => total + (
    isPlainObject(rawCase) && Array.isArray(rawCase.operations) ? rawCase.operations.length : 0
  ), 0);
}

function normalizeSensitiveValues(input, options, findings) {
  const candidates = [
    ...(Array.isArray(input.sensitiveValues) ? input.sensitiveValues : []),
    ...(Array.isArray(options.sensitiveValues) ? options.sensitiveValues : []),
  ];
  const output = [];
  candidates.forEach((value, index) => {
    if (!isNonBlankString(value)) {
      addFinding(findings, `sensitiveValues[${index}]`, 'NON_EMPTY_STRING_REQUIRED', 'Sensitive values must be non-empty strings.');
      return;
    }
    if (!output.includes(value)) output.push(value);
  });
  return output;
}

function normalizeSourceClauses(input, sourceTextValue, sensitiveValues, findings) {
  if (!Array.isArray(input)) {
    addFinding(findings, 'sourceClauses', FINDING_CODES.SOURCE_CLAUSES_MISSING, 'Granular source clauses are required.');
    return { clauses: [], handleToId: new Map() };
  }
  if (input.length === 0) {
    addFinding(findings, 'sourceClauses', FINDING_CODES.SOURCE_CLAUSES_MISSING, 'At least one granular source clause is required.');
  }

  const provisional = input.map((raw, index) => {
    const path = `sourceClauses[${index}]`;
    if (!isPlainObject(raw)) {
      addFinding(findings, path, 'OBJECT_REQUIRED', 'Each source clause must be an object.');
      return null;
    }
    reportUnknownFields(raw, INPUT_CLAUSE_FIELDS, path, findings);
    const handles = [];
    for (const field of ['id', 'ref']) {
      if (!hasOwn(raw, field)) continue;
      if (!isNonBlankString(raw[field])) addFinding(findings, `${path}.${field}`, FINDING_CODES.ID_MISSING, 'Source clause handles must be non-empty strings.');
      else if (!handles.includes(raw[field].trim())) handles.push(raw[field].trim());
    }
    if (handles.length === 0) addFinding(findings, `${path}.id`, FINDING_CODES.ID_MISSING, 'A source clause requires an authoring handle.');

    const rawDisposition = aliasedValue(raw, 'disposition', 'kind', path, findings, { required: true });
    const disposition = normalizeEnum(rawDisposition, VALID_SOURCE_DISPOSITIONS);
    if (!disposition) {
      addFinding(findings, `${path}.disposition`, FINDING_CODES.SOURCE_DISPOSITION_INVALID, 'Source clause disposition is unsupported.');
    }
    const rawQuote = aliasedValue(raw, 'sourceQuote', 'text', path, findings, { required: true });
    const evidence = normalizeEvidence(rawQuote, raw.sourceSpan, sourceTextValue, path, findings);
    const sensitive = raw.sensitive === true
      || (isNonBlankString(rawQuote) && SENSITIVE_LABEL_RE.test(rawQuote))
      || containsSensitiveValue(rawQuote, sensitiveValues);
    if (hasOwn(raw, 'sensitive') && typeof raw.sensitive !== 'boolean') {
      addFinding(findings, `${path}.sensitive`, 'BOOLEAN_REQUIRED', 'sensitive must be boolean when supplied.');
    }
    return { handles, disposition, evidence, sensitive, path };
  });

  let previousStart = -1;
  const covered = Array.from({ length: sourceTextValue.length }, () => false);
  const exactSpans = new Set();
  provisional.forEach((clause) => {
    if (!clause || !clause.evidence) return;
    const { start, end } = clause.evidence.span;
    if (start < previousStart) {
      addFinding(findings, `${clause.path}.sourceSpan`, FINDING_CODES.SOURCE_ORDER_INVALID, 'Source clause array order must follow source order.');
    }
    previousStart = start;
    const spanKey = `${start}:${end}`;
    if (exactSpans.has(spanKey)) {
      addFinding(findings, `${clause.path}.sourceSpan`, FINDING_CODES.SOURCE_SPAN_DUPLICATE, 'Source clauses cannot reuse an exact span.');
    }
    exactSpans.add(spanKey);
    let overlap = false;
    for (let offset = start; offset < end; offset += 1) {
      if (covered[offset]) overlap = true;
      covered[offset] = true;
    }
    if (overlap) addFinding(findings, `${clause.path}.sourceSpan`, FINDING_CODES.SOURCE_SPAN_OVERLAP, 'Source clause spans cannot overlap.');
  });
  if (sourceTextValue && sourceTextValue.split('').some((character, index) => /\S/.test(character) && !covered[index])) {
    addFinding(findings, 'sourceClauses', FINDING_CODES.SOURCE_TEXT_UNCOVERED, 'Every non-whitespace source character must be covered exactly once.');
  }

  const occurrenceByFingerprint = new Map();
  provisional.forEach((clause) => {
    if (!clause || !clause.evidence) return;
    const identity = {
      disposition: clause.disposition,
      sourceSpan: clause.evidence.span,
      quoteDigest: clause.evidence.quoteDigest,
    };
    const fingerprint = stableSerialize(identity);
    const occurrence = (occurrenceByFingerprint.get(fingerprint) || 0) + 1;
    occurrenceByFingerprint.set(fingerprint, occurrence);
    clause.id = semanticId('clause', identity, occurrence);
  });

  const handleToId = new Map();
  provisional.forEach((clause) => {
    if (clause && clause.id) handleToId.set(clause.id, clause.id);
  });
  provisional.forEach((clause) => {
    if (!clause || !clause.id) return;
    clause.handles.forEach((handle) => {
      const existing = handleToId.get(handle);
      if (existing && existing !== clause.id) {
        addFinding(findings, clause.path, FINDING_CODES.ID_DUPLICATE, 'A source clause handle identifies more than one clause.');
      } else {
        handleToId.set(handle, clause.id);
      }
    });
  });
  return { clauses: provisional.filter(Boolean), handleToId };
}

function normalizeSessionIntent(value, path, findings) {
  if (value === undefined || value === null) return { mode: 'fresh' };
  if (typeof value === 'string') {
    const mode = normalizeEnum(value, VALID_SESSION_MODES);
    if (!mode) addFinding(findings, path, 'semantic_contract_session_mode_invalid', 'Session intent mode is unsupported.');
    return { mode };
  }
  if (!isPlainObject(value)) {
    addFinding(findings, path, 'semantic_contract_session_mode_invalid', 'Session intent must be a supported mode or object.');
    return { mode: '' };
  }
  const output = cloneCanonicalJson(value, path, findings);
  const mode = normalizeEnum(output.mode, VALID_SESSION_MODES);
  if (!mode) addFinding(findings, `${path}.mode`, 'semantic_contract_session_mode_invalid', 'Session intent mode is unsupported.');
  output.mode = mode;
  return cloneCanonicalJson(output, path, findings);
}

function normalizeCondition(value, path, findings) {
  if (value === undefined || value === null) return null;
  const condition = cloneCanonicalJson(value, path, findings);
  if (!isPlainObject(condition) || !isNonBlankString(condition.kind)
    || !isNonBlankString(condition.comparator) || !Array.isArray(condition.operands)
    || condition.operands.length === 0) {
    addFinding(findings, path, CODES.CONDITION_INVALID, 'Condition requires kind, comparator, and at least one operand.');
    return condition;
  }
  condition.kind = condition.kind.trim().toLowerCase().replace(/[\s-]+/g, '_');
  condition.comparator = condition.comparator.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return cloneCanonicalJson(condition, path, findings);
}

function normalizeSelection(value, path, findings) {
  if (!isPlainObject(value)) {
    addFinding(findings, path, CODES.SELECTION_INVALID, 'Select requires typed selection criteria.');
    return value;
  }
  const selection = cloneCanonicalJson(value, path, findings);
  const kind = normalizeEnum(selection.kind, VALID_SELECTION_KINDS);
  if (!kind) addFinding(findings, `${path}.kind`, CODES.SELECTION_INVALID, 'Selection kind is unsupported.');
  selection.kind = kind;
  const fieldByKind = {
    exact_text: 'text',
    exact_value: 'value',
    ordinal: 'ordinal',
    predicate: 'predicate',
    data_ref: 'ref',
    reference: 'ref',
  };
  const field = fieldByKind[kind];
  const criterion = field ? selection[field] : undefined;
  if (kind === 'ordinal') {
    if (!Number.isInteger(criterion) || criterion < 1) addFinding(findings, `${path}.ordinal`, CODES.SELECTION_INVALID, 'Selection ordinal must be a positive integer.');
  } else if (!isNonBlankString(criterion)) {
    addFinding(findings, path, CODES.SELECTION_INVALID, 'Selection criteria are incomplete.');
  }
  if (['data_ref', 'reference'].includes(kind) && !isValueRef(criterion)) {
    addFinding(findings, `${path}.ref`, CODES.VALUE_REF_INVALID, 'Selection references must use an approved reference scheme.');
  }
  return cloneCanonicalJson(selection, path, findings);
}

function validateTemporalLiteral(type, value, path, findings) {
  if (type === 'Date' || type === 'AssertDate') {
    if (!isCanonicalDate(value)) addFinding(findings, path, FINDING_CODES.DATE_NOT_CANONICAL, 'Date literal must use canonical YYYY-MM-DD form.');
  } else if (type === 'Time' || type === 'AssertTime') {
    if (!isCanonicalTime(value)) addFinding(findings, path, FINDING_CODES.TIME_NOT_CANONICAL, 'Time literal must use canonical 24-hour form.');
  } else if (type === 'DateTime' || type === 'AssertDateTime') {
    if (!isCanonicalDateTime(value)) addFinding(findings, path, FINDING_CODES.DATETIME_NOT_CANONICAL, 'Date-time literal must use timezone-qualified ISO-8601 form.');
  }
}

function normalizeOperation(raw, caseIndex, operationIndex, findings) {
  const path = `cases[${caseIndex}].operations[${operationIndex}]`;
  if (!isPlainObject(raw)) {
    addFinding(findings, path, 'OBJECT_REQUIRED', 'Each ordered operation must be an object.');
    return null;
  }
  reportUnknownFields(raw, INPUT_OPERATION_FIELDS, path, findings);

  const actionType = normalizeEnum(raw.type, VALID_STEP_TYPES);
  const assertionType = normalizeEnum(raw.type, VALID_ASSERTION_TYPES);
  const inferredKind = assertionType ? 'assertion' : 'action';
  const kind = hasOwn(raw, 'kind') ? normalizeEnum(raw.kind, ['action', 'assertion']) : inferredKind;
  if (!kind) addFinding(findings, `${path}.kind`, CODES.OPERATION_KIND_UNSUPPORTED, 'Operation kind must be action or assertion.');
  const type = kind === 'assertion' ? assertionType : actionType;
  if (!type) {
    addFinding(
      findings,
      `${path}.type`,
      kind === 'assertion' ? FINDING_CODES.ASSERTION_TYPE_UNSUPPORTED : FINDING_CODES.STEP_TYPE_UNSUPPORTED,
      'Operation type is unsupported by the semantic contract.',
    );
  }
  if (!isNonBlankString(raw.text)) addFinding(findings, `${path}.text`, 'semantic_contract_operation_text_missing', 'A source-faithful operation text is required.');

  const rawTarget = aliasedValue(raw, 'target', 'targetIdentity', path, findings, { required: true });
  const target = cloneCanonicalJson(rawTarget, `${path}.target`, findings);
  if (!(isNonBlankString(target) || (isPlainObject(target) && Object.keys(target).length > 0))) {
    addFinding(findings, `${path}.target`, FINDING_CODES.TARGET_IDENTITY_MISSING, 'A precise target is required.');
  }
  if (isPlainObject(target) && hasOwn(target, 'kind')) {
    const targetKind = normalizeEnum(target.kind, VALID_TARGET_KINDS);
    if (!targetKind) addFinding(findings, `${path}.target.kind`, FINDING_CODES.TARGET_IDENTITY_INVALID, 'Target kind is unsupported.');
    target.kind = targetKind;
  }

  const required = hasOwn(raw, 'required') ? raw.required : true;
  if (typeof required !== 'boolean') addFinding(findings, `${path}.required`, 'BOOLEAN_REQUIRED', 'required must be boolean.');
  const condition = normalizeCondition(raw.condition, `${path}.condition`, findings);
  const failureBehavior = normalizeEnum(raw.failureBehavior, VALID_FAILURE_BEHAVIORS);
  if (!failureBehavior) addFinding(findings, `${path}.failureBehavior`, FINDING_CODES.FAILURE_BEHAVIOR_INVALID, 'Failure behavior is unsupported.');

  const rawSourceRefs = aliasedValue(raw, 'sourceRefs', 'sourceClauseRefs', path, findings, { required: true });
  const sourceHandles = normalizeReferenceArray(rawSourceRefs, `${path}.sourceRefs`, findings, {
    required: true,
    duplicateCode: FINDING_CODES.SOURCE_REF_DUPLICATE,
  });
  const rawDependencies = aliasedValue(raw, 'dependencies', 'dependsOn', path, findings);
  const dependencyHandles = normalizeReferenceArray(rawDependencies, `${path}.dependencies`, findings, {
    duplicateCode: FINDING_CODES.DEPENDENCY_DUPLICATE,
  });

  const handles = [];
  for (const field of ['id', 'ref']) {
    if (!hasOwn(raw, field)) continue;
    if (!isNonBlankString(raw[field])) addFinding(findings, `${path}.${field}`, FINDING_CODES.ID_MISSING, 'Operation handles must be non-empty strings.');
    else if (!handles.includes(raw[field].trim())) handles.push(raw[field].trim());
  }

  const operation = {
    kind,
    type,
    text: raw.text,
    target,
    required,
    condition,
    failureBehavior,
    sourceHandles,
    dependencyHandles,
    handles,
    rawSourceQuote: raw.sourceQuote,
    rawSourceSpan: raw.sourceSpan,
    path,
  };

  const rawSelection = aliasedValue(raw, 'selection', 'selectionCriteria', path, findings);
  if (kind === 'action') {
    const hasValue = hasOwn(raw, 'value');
    const hasValueRef = hasOwn(raw, 'valueRef') && raw.valueRef !== null && raw.valueRef !== '';
    if (hasValue && hasValueRef) addFinding(findings, path, CODES.VALUE_AUTHORITY_AMBIGUOUS, 'Use exactly one literal value or approved value reference.');
    if (hasValue) operation.value = cloneCanonicalJson(raw.value, `${path}.value`, findings);
    if (hasValueRef) {
      if (!isValueRef(raw.valueRef)) addFinding(findings, `${path}.valueRef`, CODES.VALUE_REF_INVALID, 'Value reference scheme is unsupported.');
      operation.valueRef = isNonBlankString(raw.valueRef) ? raw.valueRef.trim() : raw.valueRef;
    }
    if (type === 'Select') operation.selection = normalizeSelection(rawSelection, `${path}.selection`, findings);
    else if (rawSelection !== undefined) addFinding(findings, `${path}.selection`, CODES.SELECTION_INVALID, 'Selection criteria are only valid for Select.');
    if (hasOwn(raw, 'expected') || hasOwn(raw, 'expectedRef') || hasOwn(raw, 'comparator')) {
      addFinding(findings, path, 'ASSERTION_FIELDS_ON_ACTION', 'Assertion-only fields cannot be placed on an action.');
    }
    if (hasValue) validateTemporalLiteral(type, operation.value, `${path}.value`, findings);
  } else if (kind === 'assertion') {
    if (hasOwn(raw, 'value') || hasOwn(raw, 'valueRef') || rawSelection !== undefined) {
      addFinding(findings, path, 'ACTION_FIELDS_ON_ASSERTION', 'Action-only fields cannot be placed on an assertion.');
    }
    const hasExpected = hasOwn(raw, 'expected');
    const hasExpectedRef = hasOwn(raw, 'expectedRef') && raw.expectedRef !== null && raw.expectedRef !== '';
    if (hasExpected === hasExpectedRef) addFinding(findings, path, CODES.VALUE_AUTHORITY_AMBIGUOUS, 'Assertions require exactly one expected literal or expected reference.');
    if (hasExpected) operation.expected = cloneCanonicalJson(raw.expected, `${path}.expected`, findings);
    if (hasExpectedRef) {
      if (!isValueRef(raw.expectedRef)) addFinding(findings, `${path}.expectedRef`, CODES.VALUE_REF_INVALID, 'Expected reference scheme is unsupported.');
      operation.expectedRef = isNonBlankString(raw.expectedRef) ? raw.expectedRef.trim() : raw.expectedRef;
    }
    const comparator = normalizeEnum(raw.comparator, Object.keys(ASSERTION_TYPE_COMPARATORS).length
      ? [...new Set(Object.values(ASSERTION_TYPE_COMPARATORS).flat())]
      : []);
    if (!comparator || (type && !ASSERTION_TYPE_COMPARATORS[type].includes(comparator))) {
      addFinding(findings, `${path}.comparator`, FINDING_CODES.ASSERTION_COMPARATOR_INVALID, 'Comparator is unsupported for this assertion type.');
    }
    operation.comparator = comparator;
    if (hasExpected) validateTemporalLiteral(type, operation.expected, `${path}.expected`, findings);
  }
  return operation;
}

function normalizeCase(raw, caseIndex, findings) {
  const path = `cases[${caseIndex}]`;
  if (!isPlainObject(raw)) {
    addFinding(findings, path, 'OBJECT_REQUIRED', 'Each case must be an object.');
    return null;
  }
  reportUnknownFields(raw, INPUT_CASE_FIELDS, path, findings);
  if (!isNonBlankString(raw.name)) addFinding(findings, `${path}.name`, 'NON_EMPTY_STRING_REQUIRED', 'Case name is required.');
  if (!isNonBlankString(raw.intent)) addFinding(findings, `${path}.intent`, 'NON_EMPTY_STRING_REQUIRED', 'Case intent is required.');
  if (!Array.isArray(raw.operations) || raw.operations.length === 0) addFinding(findings, `${path}.operations`, 'ARRAY_MUST_NOT_BE_EMPTY', 'Each case requires an ordered operation stream.');
  const handles = [];
  for (const field of ['id', 'ref']) {
    if (!hasOwn(raw, field)) continue;
    if (!isNonBlankString(raw[field])) addFinding(findings, `${path}.${field}`, FINDING_CODES.ID_MISSING, 'Case handles must be non-empty strings.');
    else if (!handles.includes(raw[field].trim())) handles.push(raw[field].trim());
  }
  const parentHandle = raw.parentCaseRef == null ? null : (
    isNonBlankString(raw.parentCaseRef) ? raw.parentCaseRef.trim() : ''
  );
  if (raw.parentCaseRef != null && !parentHandle) addFinding(findings, `${path}.parentCaseRef`, 'NON_EMPTY_STRING_REQUIRED', 'parentCaseRef must identify an earlier case.');
  return {
    handles,
    name: raw.name,
    intent: raw.intent,
    initialState: cloneCanonicalJson(hasOwn(raw, 'initialState') ? raw.initialState : null, `${path}.initialState`, findings),
    expectedFinalState: cloneCanonicalJson(hasOwn(raw, 'expectedFinalState') ? raw.expectedFinalState : null, `${path}.expectedFinalState`, findings),
    sessionIntent: normalizeSessionIntent(raw.sessionIntent, `${path}.sessionIntent`, findings),
    parentHandle,
    operations: Array.isArray(raw.operations)
      ? raw.operations.map((operation, operationIndex) => normalizeOperation(operation, caseIndex, operationIndex, findings))
      : [],
    path,
  };
}

function caseIdentity(value) {
  return {
    name: value.name,
    intent: value.intent,
    initialState: value.initialState,
    expectedFinalState: value.expectedFinalState,
    sessionIntent: value.sessionIntent,
  };
}

function operationIdentity(caseId, operation) {
  const identity = {
    caseId,
    kind: operation.kind,
    type: operation.type,
    text: operation.text,
    target: operation.target,
    required: operation.required,
    condition: operation.condition,
    failureBehavior: operation.failureBehavior,
    sourceRefs: operation.sourceRefs,
    sourceSpan: operation.sourceSpan,
    quoteDigest: operation.quoteDigest,
    redacted: operation.redacted,
    sourceQuote: operation.sourceQuote,
  };
  for (const field of ['value', 'valueRef', 'selection', 'expected', 'expectedRef', 'comparator']) {
    if (hasOwn(operation, field)) identity[field] = operation[field];
  }
  return identity;
}

function sourceProjection(evidence, sensitive) {
  return {
    sourceSpan: evidence.span,
    quoteDigest: evidence.quoteDigest,
    redacted: Boolean(sensitive),
    sourceQuote: sensitive ? REDACTED_SOURCE : evidence.quote,
  };
}

function contractDigestPayload(draft) {
  return {
    version: draft.version,
    sourceDigest: draft.sourceDigest,
    sourceClauses: draft.sourceClauses,
    cases: draft.cases,
  };
}

function computeAddScenarioContractDigest(draft) {
  return sha256Text(stableSerialize(contractDigestPayload(draft)));
}

function legacyCaseInput(input) {
  return {
    name: isNonBlankString(input.name) ? input.name : 'Add Scenario',
    intent: isNonBlankString(input.intent) ? input.intent : (isNonBlankString(input.name) ? input.name : 'Execute the authored scenario.'),
    initialState: hasOwn(input, 'initialState') ? input.initialState : null,
    expectedFinalState: hasOwn(input, 'expectedFinalState') ? input.expectedFinalState : null,
    sessionIntent: hasOwn(input, 'sessionIntent') ? input.sessionIntent : { mode: 'fresh' },
    parentCaseRef: hasOwn(input, 'parentCaseRef') ? input.parentCaseRef : null,
    operations: input.operations,
  };
}

function createAddScenarioOrderedDraft(input, options = {}) {
  const findings = [];
  if (!isPlainObject(input)) {
    throw new AddScenarioOrderedDraftError('Add Scenario ordered draft input must be an object.', [
      { path: '$', code: 'OBJECT_REQUIRED', message: 'Draft input must be an object.' },
    ]);
  }
  reportUnknownFields(input, INPUT_ROOT_FIELDS, '$', findings);
  if (hasOwn(input, 'version') && input.version !== ORDERED_DRAFT_VERSION) {
    addFinding(findings, 'version', 'VERSION_MISMATCH', `Version must be ${ORDERED_DRAFT_VERSION}.`);
  }
  if (hasOwn(input, 'cases') && hasOwn(input, 'operations')) {
    addFinding(findings, '$', CODES.VALUE_AUTHORITY_AMBIGUOUS, 'Use cases or temporary one-case operations input, never both.');
  }

  const rawCases = Array.isArray(input.cases)
    ? input.cases
    : (Array.isArray(input.operations) ? [legacyCaseInput(input)] : []);
  if (rawCases.length === 0) addFinding(findings, 'cases', 'ARRAY_MUST_NOT_BE_EMPTY', 'At least one case is required.');
  const totalOperations = operationCount(rawCases);
  if (totalOperations > MAX_ORDERED_OPERATIONS) {
    const limitFinding = {
      path: 'cases',
      code: CODES.OPERATION_LIMIT_EXCEEDED,
      message: `The combined operation budget is ${MAX_ORDERED_OPERATIONS}.`,
    };
    throw new AddScenarioOperationLimitError([limitFinding]);
  }

  const rawSource = typeof input.sourceText === 'string' ? input.sourceText : '';
  if (!rawSource) addFinding(findings, 'sourceText', FINDING_CODES.SOURCE_TEXT_MISSING, 'Exact source input is required transiently.');
  const computedSourceDigest = sourceDigest(rawSource);
  if (hasOwn(input, 'sourceDigest') && input.sourceDigest !== computedSourceDigest) {
    addFinding(findings, 'sourceDigest', CODES.SOURCE_DIGEST_MISMATCH, 'Provided source digest does not match the exact source input.');
  }
  const sensitiveValues = normalizeSensitiveValues(input, options, findings);
  const sourceModel = normalizeSourceClauses(input.sourceClauses, rawSource, sensitiveValues, findings);
  const normalizedCases = rawCases.map((rawCase, index) => normalizeCase(rawCase, index, findings));
  throwInvalid(findings);

  const caseOccurrence = new Map();
  normalizedCases.forEach((normalizedCase) => {
    const identity = caseIdentity(normalizedCase);
    const fingerprint = stableSerialize(identity);
    const occurrence = (caseOccurrence.get(fingerprint) || 0) + 1;
    caseOccurrence.set(fingerprint, occurrence);
    normalizedCase.id = semanticId('case', identity, occurrence);
  });
  const caseHandleToId = new Map(normalizedCases.map((entry) => [entry.id, entry.id]));
  normalizedCases.forEach((entry) => {
    entry.handles.forEach((handle) => {
      const existing = caseHandleToId.get(handle);
      if (existing && existing !== entry.id) addFinding(findings, entry.path, FINDING_CODES.ID_DUPLICATE, 'A case handle identifies more than one case.');
      else caseHandleToId.set(handle, entry.id);
    });
  });
  const caseIndexById = new Map(normalizedCases.map((entry, index) => [entry.id, index]));
  normalizedCases.forEach((entry, index) => {
    entry.parentCaseRef = null;
    if (!entry.parentHandle) return;
    const parentId = caseHandleToId.get(entry.parentHandle);
    if (!parentId) addFinding(findings, `${entry.path}.parentCaseRef`, FINDING_CODES.DEPENDENCY_MISSING, 'Parent case reference is unknown.');
    else if (caseIndexById.get(parentId) >= index) addFinding(findings, `${entry.path}.parentCaseRef`, FINDING_CODES.DEPENDENCY_FORWARD, 'Parent case must precede its child.');
    else entry.parentCaseRef = parentId;
  });

  const clauseById = new Map(sourceModel.clauses.map((clause) => [clause.id, clause]));
  normalizedCases.forEach((entry) => {
    entry.operations.forEach((operation) => {
      operation.sourceRefs = [];
      const seen = new Set();
      operation.sourceHandles.forEach((handle, index) => {
        const clauseId = sourceModel.handleToId.get(handle);
        if (!clauseId) {
          addFinding(findings, `${operation.path}.sourceRefs[${index}]`, FINDING_CODES.SOURCE_REF_UNKNOWN, 'A source reference does not identify a source clause.');
          return;
        }
        if (seen.has(clauseId)) {
          addFinding(findings, `${operation.path}.sourceRefs[${index}]`, FINDING_CODES.SOURCE_REF_DUPLICATE, 'Source references must remain unique after canonical resolution.');
          return;
        }
        seen.add(clauseId);
        operation.sourceRefs.push(clauseId);
      });
      if (hasOwn(operation, 'valueRef') || hasOwn(operation, 'expectedRef')) {
        operation.sourceRefs.forEach((clauseId) => { clauseById.get(clauseId).sensitive = true; });
      }
    });
  });
  throwInvalid(findings);

  const clauseLinks = new Map(sourceModel.clauses.map((clause) => [clause.id, new Set()]));
  const canonicalCases = normalizedCases.map((entry, caseIndex) => {
    const provisionalOperations = entry.operations.map((operation) => {
      const linkedClauses = operation.sourceRefs.map((ref) => clauseById.get(ref)).filter(Boolean);
      linkedClauses.forEach((clause) => {
        clauseLinks.get(clause.id).add(operation.kind);
        if (operation.condition) clauseLinks.get(clause.id).add('condition');
      });
      let evidence;
      if (operation.rawSourceQuote !== undefined || operation.rawSourceSpan !== undefined) {
        evidence = normalizeEvidence(operation.rawSourceQuote, operation.rawSourceSpan, rawSource, operation.path, findings);
      } else if (linkedClauses.length > 0) {
        evidence = linkedClauses[0].evidence;
      }
      if (!evidence) return null;
      const contained = linkedClauses.some((clause) => (
        evidence.span.start >= clause.evidence.span.start && evidence.span.end <= clause.evidence.span.end
      ));
      if (!contained) {
        addFinding(findings, `${operation.path}.sourceSpan`, FINDING_CODES.SOURCE_ENTITY_LINK_MISMATCH, 'Operation source evidence must be contained by a referenced clause.');
      }

      const sensitive = linkedClauses.some((clause) => clause.sensitive)
        || hasOwn(operation, 'valueRef') || hasOwn(operation, 'expectedRef')
        || SENSITIVE_LABEL_RE.test(evidence.quote)
        || containsSensitiveValue(operation.text, sensitiveValues)
        || containsSensitiveValue(evidence.quote, sensitiveValues);
      const literal = operation.kind === 'action' ? operation.value : operation.expected;
      const hasLiteral = operation.kind === 'action' ? hasOwn(operation, 'value') : hasOwn(operation, 'expected');
      if (hasLiteral && (sensitive || hasSensitiveTarget(operation.target) || containsSensitiveValue(literal, sensitiveValues))) {
        addFinding(findings, operation.path, CODES.SENSITIVE_LITERAL, 'Sensitive semantics require an approved reference and cannot retain a literal.');
      }
      for (const semanticField of ['target', 'condition', 'selection', 'valueRef', 'expectedRef']) {
        if (hasOwn(operation, semanticField) && containsSensitiveValue(operation[semanticField], sensitiveValues)) {
          addFinding(findings, `${operation.path}.${semanticField}`, CODES.SENSITIVE_LITERAL, 'Sensitive literal cannot be retained in canonical semantic fields.');
        }
      }

      const projection = sourceProjection(evidence, sensitive);
      const output = {
        kind: operation.kind,
        type: operation.type,
        text: sensitive ? REDACTED_SOURCE : operation.text,
        target: operation.target,
        required: operation.required,
      };
      for (const field of ['value', 'valueRef', 'selection', 'expected', 'expectedRef', 'comparator']) {
        if (hasOwn(operation, field)) output[field] = operation[field];
      }
      output.condition = operation.condition;
      output.failureBehavior = operation.failureBehavior;
      output.sourceRefs = operation.sourceRefs;
      Object.assign(output, projection);
      output.handles = operation.handles;
      output.dependencyHandles = operation.dependencyHandles;
      output.path = operation.path;
      return output;
    });
    throwInvalid(findings);

    const operationOccurrence = new Map();
    const operations = provisionalOperations.map((operation, operationIndex) => {
      const identity = operationIdentity(entry.id, operation);
      const fingerprint = stableSerialize(identity);
      const occurrence = (operationOccurrence.get(fingerprint) || 0) + 1;
      operationOccurrence.set(fingerprint, occurrence);
      const output = {
        id: semanticId(`${entry.id}.step`, identity, occurrence),
        ordinal: operationIndex + 1,
        kind: operation.kind,
        type: operation.type,
        text: operation.text,
        target: operation.target,
        required: operation.required,
      };
      for (const field of ['value', 'valueRef', 'selection', 'expected', 'expectedRef', 'comparator']) {
        if (hasOwn(operation, field)) output[field] = operation[field];
      }
      output.condition = operation.condition;
      output.failureBehavior = operation.failureBehavior;
      output.dependencies = [];
      output.sourceRefs = operation.sourceRefs;
      output.sourceSpan = operation.sourceSpan;
      output.quoteDigest = operation.quoteDigest;
      output.redacted = operation.redacted;
      output.sourceQuote = operation.sourceQuote;
      return output;
    });

    const handleToId = new Map(operations.map((operation) => [operation.id, operation.id]));
    provisionalOperations.forEach((operation, operationIndex) => {
      operation.handles.forEach((handle) => {
        const existing = handleToId.get(handle);
        if (existing && existing !== operations[operationIndex].id) {
          addFinding(findings, operation.path, FINDING_CODES.ID_DUPLICATE, 'An operation handle identifies more than one operation.');
        } else {
          handleToId.set(handle, operations[operationIndex].id);
        }
      });
    });
    const indexById = new Map(operations.map((operation, index) => [operation.id, index]));
    provisionalOperations.forEach((operation, operationIndex) => {
      const seen = new Set();
      operation.dependencyHandles.forEach((handle, dependencyIndex) => {
        const dependencyId = handleToId.get(handle);
        const path = `${operation.path}.dependencies[${dependencyIndex}]`;
        if (!dependencyId) addFinding(findings, path, FINDING_CODES.DEPENDENCY_MISSING, 'Dependency does not identify an operation in the same case.');
        else if (indexById.get(dependencyId) >= operationIndex) addFinding(findings, path, FINDING_CODES.DEPENDENCY_FORWARD, 'Dependencies must point backward in the case-local stream.');
        else if (seen.has(dependencyId)) addFinding(findings, path, FINDING_CODES.DEPENDENCY_DUPLICATE, 'Canonical dependencies must be unique.');
        else {
          seen.add(dependencyId);
          operations[operationIndex].dependencies.push(dependencyId);
        }
      });
    });
    return {
      id: entry.id,
      ordinal: caseIndex + 1,
      name: entry.name,
      intent: entry.intent,
      initialState: entry.initialState,
      expectedFinalState: entry.expectedFinalState,
      sessionIntent: entry.sessionIntent,
      parentCaseRef: entry.parentCaseRef,
      operations,
    };
  });

  sourceModel.clauses.forEach((clause) => {
    const links = clauseLinks.get(clause.id);
    if (links.size === 0 && !['metadata', 'data'].includes(clause.disposition)) {
      addFinding(findings, clause.path, FINDING_CODES.SOURCE_CLAUSE_OMITTED, 'Executable source clause is not linked to canonical semantics.');
    } else if (clause.disposition === 'action' && !links.has('action')) {
      addFinding(findings, `${clause.path}.disposition`, FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, 'Action clause must authorize an action.');
    } else if (clause.disposition === 'assertion' && !links.has('assertion')) {
      addFinding(findings, `${clause.path}.disposition`, FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, 'Assertion clause must authorize an assertion.');
    } else if (clause.disposition === 'condition' && !links.has('condition')) {
      addFinding(findings, `${clause.path}.disposition`, FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, 'Condition clause must authorize a condition.');
    } else if (clause.disposition === 'mixed' && !(links.has('action') && links.has('assertion'))) {
      addFinding(findings, `${clause.path}.disposition`, FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, 'Mixed clause must authorize both action and assertion semantics.');
    }
  });

  for (const entry of normalizedCases) {
    for (const field of ['name', 'intent', 'initialState', 'expectedFinalState', 'sessionIntent']) {
      if (containsSensitiveValue(entry[field], sensitiveValues)) {
        addFinding(findings, `${entry.path}.${field}`, CODES.SENSITIVE_LITERAL, 'Sensitive literals cannot be retained in case metadata.');
      }
    }
  }
  throwInvalid(findings);

  const sourceClauses = sourceModel.clauses.map((clause, index) => ({
    id: clause.id,
    ordinal: index + 1,
    disposition: clause.disposition,
    ...sourceProjection(clause.evidence, clause.sensitive),
  }));
  const draft = {
    version: ORDERED_DRAFT_VERSION,
    sourceDigest: computedSourceDigest,
    contractDigest: '',
    sourceClauses,
    cases: canonicalCases,
  };
  draft.contractDigest = computeAddScenarioContractDigest(draft);
  if (hasOwn(input, 'contractDigest') && input.contractDigest !== draft.contractDigest) {
    throw new AddScenarioOrderedDraftError('Canonical contract digest does not match.', [
      { path: 'contractDigest', code: CODES.CONTRACT_DIGEST_MISMATCH, message: 'Provided contract digest does not match canonical semantics.' },
    ]);
  }
  const validation = validateAddScenarioOrderedDraft(draft);
  if (!validation.valid) throw new AddScenarioOrderedDraftError('Internal canonical draft validation failed.', validation.findings);
  return deepFreeze(draft);
}

function validateSourceProjection(record, path, findings) {
  if (!isPlainObject(record.sourceSpan) || !Number.isInteger(record.sourceSpan.start)
    || !Number.isInteger(record.sourceSpan.end) || record.sourceSpan.start < 0
    || record.sourceSpan.end <= record.sourceSpan.start) {
    addFinding(findings, `${path}.sourceSpan`, FINDING_CODES.SOURCE_SPAN_INVALID, 'Canonical source span is invalid.');
  }
  if (!SHA256_RE.test(record.quoteDigest)) addFinding(findings, `${path}.quoteDigest`, 'DIGEST_INVALID', 'Quote digest must be SHA-256.');
  if (typeof record.redacted !== 'boolean') addFinding(findings, `${path}.redacted`, 'BOOLEAN_REQUIRED', 'redacted must be boolean.');
  if (record.redacted === true && record.sourceQuote !== REDACTED_SOURCE) {
    addFinding(findings, `${path}.sourceQuote`, CODES.SENSITIVE_LITERAL, 'Redacted source projections cannot retain source text.');
  }
  if (record.redacted === false && (!isNonBlankString(record.sourceQuote) || sha256Text(record.sourceQuote) !== record.quoteDigest)) {
    addFinding(findings, `${path}.sourceQuote`, FINDING_CODES.SOURCE_SPAN_QUOTE_MISMATCH, 'Visible source quote must match its digest.');
  }
  if (record.redacted === false && isPlainObject(record.sourceSpan) && typeof record.sourceQuote === 'string'
    && record.sourceSpan.end - record.sourceSpan.start !== record.sourceQuote.length) {
    addFinding(findings, `${path}.sourceSpan`, FINDING_CODES.SOURCE_SPAN_QUOTE_MISMATCH, 'Visible source quote length must match its exact span.');
  }
}

function validateCanonicalOperation(operation, caseId, operationIndex, path, clauseById, findings, occurrenceByFingerprint) {
  if (!isPlainObject(operation)) {
    addFinding(findings, path, 'OBJECT_REQUIRED', 'Canonical operation must be an object.');
    return;
  }
  const allowed = new Set(CANONICAL_COMMON_OPERATION_FIELDS);
  if (operation.kind === 'action') ['value', 'valueRef', 'selection'].forEach((field) => allowed.add(field));
  if (operation.kind === 'assertion') ['expected', 'expectedRef', 'comparator'].forEach((field) => allowed.add(field));
  reportUnknownFields(operation, allowed, path, findings);
  CANONICAL_COMMON_OPERATION_FIELDS.forEach((field) => {
    if (!hasOwn(operation, field)) addFinding(findings, `${path}.${field}`, 'FIELD_REQUIRED', 'Canonical operation field is missing.');
  });
  if (operation.ordinal !== operationIndex + 1) addFinding(findings, `${path}.ordinal`, FINDING_CODES.ORDINAL_INVALID, 'Operation ordinal must match array order.');
  if (!['action', 'assertion'].includes(operation.kind)) addFinding(findings, `${path}.kind`, CODES.OPERATION_KIND_UNSUPPORTED, 'Canonical operation kind is unsupported.');
  if (!isNonBlankString(operation.text)) addFinding(findings, `${path}.text`, 'semantic_contract_operation_text_missing', 'Canonical operation text is required.');
  if (!(isNonBlankString(operation.target) || (isPlainObject(operation.target) && Object.keys(operation.target).length > 0))) {
    addFinding(findings, `${path}.target`, FINDING_CODES.TARGET_IDENTITY_MISSING, 'Canonical operation target is required.');
  }
  const allowedTypes = operation.kind === 'assertion' ? VALID_ASSERTION_TYPES : VALID_STEP_TYPES;
  if (!allowedTypes.includes(operation.type)) addFinding(findings, `${path}.type`, operation.kind === 'assertion' ? FINDING_CODES.ASSERTION_TYPE_UNSUPPORTED : FINDING_CODES.STEP_TYPE_UNSUPPORTED, 'Canonical operation type is unsupported.');
  if (!VALID_FAILURE_BEHAVIORS.includes(operation.failureBehavior)) addFinding(findings, `${path}.failureBehavior`, FINDING_CODES.FAILURE_BEHAVIOR_INVALID, 'Canonical failure behavior is unsupported.');
  if (typeof operation.required !== 'boolean') addFinding(findings, `${path}.required`, 'BOOLEAN_REQUIRED', 'required must be boolean.');
  if (operation.condition !== null) normalizeCondition(operation.condition, `${path}.condition`, findings);
  validateSourceProjection(operation, path, findings);
  if (operation.redacted === true && operation.text !== REDACTED_SOURCE) {
    addFinding(findings, `${path}.text`, CODES.SENSITIVE_LITERAL, 'Redacted operation text cannot retain source content.');
  }
  const refs = normalizeReferenceArray(operation.sourceRefs, `${path}.sourceRefs`, findings, { required: true, duplicateCode: FINDING_CODES.SOURCE_REF_DUPLICATE });
  const linkedClauses = [];
  refs.forEach((ref, index) => {
    const clause = clauseById.get(ref);
    if (!clause) addFinding(findings, `${path}.sourceRefs[${index}]`, FINDING_CODES.SOURCE_REF_UNKNOWN, 'Canonical source reference is unknown.');
    else linkedClauses.push(clause);
  });
  if (isPlainObject(operation.sourceSpan) && linkedClauses.length > 0 && !linkedClauses.some((clause) => (
    operation.sourceSpan.start >= clause.sourceSpan.start && operation.sourceSpan.end <= clause.sourceSpan.end
  ))) addFinding(findings, `${path}.sourceSpan`, FINDING_CODES.SOURCE_ENTITY_LINK_MISMATCH, 'Operation span must be contained by a referenced clause.');
  if (operation.kind === 'action') {
    if (hasOwn(operation, 'value') && hasOwn(operation, 'valueRef')) addFinding(findings, path, CODES.VALUE_AUTHORITY_AMBIGUOUS, 'Canonical action has ambiguous value authority.');
    if (hasOwn(operation, 'valueRef') && !isValueRef(operation.valueRef)) addFinding(findings, `${path}.valueRef`, CODES.VALUE_REF_INVALID, 'Canonical value reference is invalid.');
    if (operation.type === 'Select') normalizeSelection(operation.selection, `${path}.selection`, findings);
    else if (hasOwn(operation, 'selection')) addFinding(findings, `${path}.selection`, CODES.SELECTION_INVALID, 'Selection is only valid for Select.');
    if (hasSensitiveTarget(operation.target) && hasOwn(operation, 'value')) addFinding(findings, `${path}.value`, CODES.SENSITIVE_LITERAL, 'Sensitive target cannot retain a literal.');
    if (operation.redacted === true && hasOwn(operation, 'value')) addFinding(findings, `${path}.value`, CODES.SENSITIVE_LITERAL, 'Redacted action cannot retain a literal value.');
    if (hasOwn(operation, 'value')) validateTemporalLiteral(operation.type, operation.value, `${path}.value`, findings);
  } else if (operation.kind === 'assertion') {
    if (hasOwn(operation, 'expected') === hasOwn(operation, 'expectedRef')) addFinding(findings, path, CODES.VALUE_AUTHORITY_AMBIGUOUS, 'Canonical assertion must have one expected authority.');
    if (hasOwn(operation, 'expectedRef') && !isValueRef(operation.expectedRef)) addFinding(findings, `${path}.expectedRef`, CODES.VALUE_REF_INVALID, 'Canonical expected reference is invalid.');
    if (!ASSERTION_TYPE_COMPARATORS[operation.type] || !ASSERTION_TYPE_COMPARATORS[operation.type].includes(operation.comparator)) addFinding(findings, `${path}.comparator`, FINDING_CODES.ASSERTION_COMPARATOR_INVALID, 'Canonical comparator is invalid for assertion type.');
    if (hasSensitiveTarget(operation.target) && hasOwn(operation, 'expected')) addFinding(findings, `${path}.expected`, CODES.SENSITIVE_LITERAL, 'Sensitive assertion cannot retain a literal.');
    if (operation.redacted === true && hasOwn(operation, 'expected')) addFinding(findings, `${path}.expected`, CODES.SENSITIVE_LITERAL, 'Redacted assertion cannot retain a literal expected value.');
    if (hasOwn(operation, 'expected')) validateTemporalLiteral(operation.type, operation.expected, `${path}.expected`, findings);
  }
  try {
    const identity = operationIdentity(caseId, operation);
    const fingerprint = stableSerialize(identity);
    const occurrence = (occurrenceByFingerprint.get(fingerprint) || 0) + 1;
    occurrenceByFingerprint.set(fingerprint, occurrence);
    if (operation.id !== semanticId(`${caseId}.step`, identity, occurrence)) addFinding(findings, `${path}.id`, 'UNSTABLE_OPERATION_ID', 'Canonical operation id does not match its semantic identity.');
  } catch (_) {
    addFinding(findings, `${path}.id`, 'ID_CANNOT_BE_DERIVED', 'Canonical operation id cannot be derived.');
  }
}

function validateAddScenarioOrderedDraft(draft) {
  const findings = [];
  if (!isPlainObject(draft)) return { valid: false, findings: [{ path: '$', code: 'OBJECT_REQUIRED', message: 'Canonical draft must be an object.' }] };
  reportUnknownFields(draft, CANONICAL_ROOT_FIELDS, '$', findings);
  if (draft.version !== ORDERED_DRAFT_VERSION) addFinding(findings, 'version', 'VERSION_MISMATCH', `Version must be ${ORDERED_DRAFT_VERSION}.`);
  if (!SHA256_RE.test(draft.sourceDigest)) addFinding(findings, 'sourceDigest', 'DIGEST_INVALID', 'Source digest must be SHA-256.');
  if (!Array.isArray(draft.sourceClauses) || draft.sourceClauses.length === 0) addFinding(findings, 'sourceClauses', FINDING_CODES.SOURCE_CLAUSES_MISSING, 'Canonical source clauses are required.');
  if (!Array.isArray(draft.cases) || draft.cases.length === 0) addFinding(findings, 'cases', 'ARRAY_MUST_NOT_BE_EMPTY', 'Canonical cases are required.');
  if (!Array.isArray(draft.sourceClauses) || !Array.isArray(draft.cases)) return { valid: false, findings };

  const clauseById = new Map();
  const clauseOccurrence = new Map();
  let previousEnd = -1;
  draft.sourceClauses.forEach((clause, index) => {
    const path = `sourceClauses[${index}]`;
    if (!isPlainObject(clause)) {
      addFinding(findings, path, 'OBJECT_REQUIRED', 'Canonical source clause must be an object.');
      return;
    }
    reportUnknownFields(clause, CANONICAL_CLAUSE_FIELDS, path, findings);
    if (clause.ordinal !== index + 1) addFinding(findings, `${path}.ordinal`, FINDING_CODES.ORDINAL_INVALID, 'Source clause ordinal must match array order.');
    if (!VALID_SOURCE_DISPOSITIONS.includes(clause.disposition)) addFinding(findings, `${path}.disposition`, FINDING_CODES.SOURCE_DISPOSITION_INVALID, 'Canonical source disposition is unsupported.');
    validateSourceProjection(clause, path, findings);
    if (isPlainObject(clause.sourceSpan) && clause.sourceSpan.start < previousEnd) addFinding(findings, `${path}.sourceSpan`, FINDING_CODES.SOURCE_SPAN_OVERLAP, 'Canonical source clauses cannot overlap.');
    if (isPlainObject(clause.sourceSpan)) previousEnd = clause.sourceSpan.end;
    const identity = { disposition: clause.disposition, sourceSpan: clause.sourceSpan, quoteDigest: clause.quoteDigest };
    const fingerprint = stableSerialize(identity);
    const occurrence = (clauseOccurrence.get(fingerprint) || 0) + 1;
    clauseOccurrence.set(fingerprint, occurrence);
    if (clause.id !== semanticId('clause', identity, occurrence)) addFinding(findings, `${path}.id`, 'UNSTABLE_CLAUSE_ID', 'Canonical source clause id does not match its identity.');
    if (clauseById.has(clause.id)) addFinding(findings, `${path}.id`, FINDING_CODES.ID_DUPLICATE, 'Canonical source clause id is duplicated.');
    else clauseById.set(clause.id, clause);
  });

  const totalOperations = draft.cases.reduce((total, entry) => total + (isPlainObject(entry) && Array.isArray(entry.operations) ? entry.operations.length : 0), 0);
  if (totalOperations > MAX_ORDERED_OPERATIONS) addFinding(findings, 'cases', CODES.OPERATION_LIMIT_EXCEEDED, `The combined operation budget is ${MAX_ORDERED_OPERATIONS}.`);
  const caseOccurrence = new Map();
  const caseIndexById = new Map();
  const clauseLinks = new Map([...clauseById.keys()].map((id) => [id, new Set()]));
  draft.cases.forEach((entry, caseIndex) => {
    const path = `cases[${caseIndex}]`;
    if (!isPlainObject(entry)) {
      addFinding(findings, path, 'OBJECT_REQUIRED', 'Canonical case must be an object.');
      return;
    }
    reportUnknownFields(entry, CANONICAL_CASE_FIELDS, path, findings);
    CANONICAL_CASE_FIELDS.forEach((field) => {
      if (!hasOwn(entry, field)) addFinding(findings, `${path}.${field}`, 'FIELD_REQUIRED', 'Canonical case field is missing.');
    });
    if (entry.ordinal !== caseIndex + 1) addFinding(findings, `${path}.ordinal`, FINDING_CODES.ORDINAL_INVALID, 'Case ordinal must match array order.');
    if (!isNonBlankString(entry.name) || !isNonBlankString(entry.intent)) addFinding(findings, path, 'NON_EMPTY_STRING_REQUIRED', 'Canonical case name and intent are required.');
    const mode = isPlainObject(entry.sessionIntent) ? entry.sessionIntent.mode : null;
    if (!VALID_SESSION_MODES.includes(mode)) addFinding(findings, `${path}.sessionIntent.mode`, 'semantic_contract_session_mode_invalid', 'Canonical session mode is unsupported.');
    const identity = caseIdentity(entry);
    const fingerprint = stableSerialize(identity);
    const occurrence = (caseOccurrence.get(fingerprint) || 0) + 1;
    caseOccurrence.set(fingerprint, occurrence);
    if (entry.id !== semanticId('case', identity, occurrence)) addFinding(findings, `${path}.id`, 'UNSTABLE_CASE_ID', 'Canonical case id does not match its identity.');
    if (caseIndexById.has(entry.id)) addFinding(findings, `${path}.id`, FINDING_CODES.ID_DUPLICATE, 'Canonical case id is duplicated.');
    else caseIndexById.set(entry.id, caseIndex);
    if (!Array.isArray(entry.operations) || entry.operations.length === 0) {
      addFinding(findings, `${path}.operations`, 'ARRAY_MUST_NOT_BE_EMPTY', 'Canonical case operations are required.');
      return;
    }
    const operationOccurrence = new Map();
    entry.operations.forEach((operation, operationIndex) => validateCanonicalOperation(
      operation,
      entry.id,
      operationIndex,
      `${path}.operations[${operationIndex}]`,
      clauseById,
      findings,
      operationOccurrence,
    ));
    entry.operations.forEach((operation) => {
      if (!isPlainObject(operation) || !Array.isArray(operation.sourceRefs)) return;
      operation.sourceRefs.forEach((ref) => {
        const links = clauseLinks.get(ref);
        if (!links) return;
        links.add(operation.kind);
        if (operation.condition) links.add('condition');
      });
    });
    const operationIndexById = new Map();
    entry.operations.forEach((operation, operationIndex) => {
      if (!isPlainObject(operation) || !isNonBlankString(operation.id)) return;
      if (operationIndexById.has(operation.id)) addFinding(findings, `${path}.operations[${operationIndex}].id`, FINDING_CODES.ID_DUPLICATE, 'Canonical operation id is duplicated.');
      else operationIndexById.set(operation.id, operationIndex);
    });
    entry.operations.forEach((operation, operationIndex) => {
      if (!isPlainObject(operation) || !Array.isArray(operation.dependencies)) return;
      const seen = new Set();
      operation.dependencies.forEach((dependencyId, dependencyIndex) => {
        const dependencyPath = `${path}.operations[${operationIndex}].dependencies[${dependencyIndex}]`;
        if (!operationIndexById.has(dependencyId)) addFinding(findings, dependencyPath, FINDING_CODES.DEPENDENCY_MISSING, 'Canonical dependency is unknown in its case.');
        else if (operationIndexById.get(dependencyId) >= operationIndex) addFinding(findings, dependencyPath, FINDING_CODES.DEPENDENCY_FORWARD, 'Canonical dependency must point backward.');
        else if (seen.has(dependencyId)) addFinding(findings, dependencyPath, FINDING_CODES.DEPENDENCY_DUPLICATE, 'Canonical dependency is duplicated.');
        seen.add(dependencyId);
      });
    });
  });
  draft.cases.forEach((entry, index) => {
    if (!isPlainObject(entry) || entry.parentCaseRef == null) return;
    if (!caseIndexById.has(entry.parentCaseRef)) addFinding(findings, `cases[${index}].parentCaseRef`, FINDING_CODES.DEPENDENCY_MISSING, 'Canonical parent case is unknown.');
    else if (caseIndexById.get(entry.parentCaseRef) >= index) addFinding(findings, `cases[${index}].parentCaseRef`, FINDING_CODES.DEPENDENCY_FORWARD, 'Canonical parent case must precede its child.');
  });
  draft.sourceClauses.forEach((clause, index) => {
    if (!isPlainObject(clause)) return;
    const links = clauseLinks.get(clause.id) || new Set();
    const path = `sourceClauses[${index}]`;
    if (links.size === 0 && !['metadata', 'data'].includes(clause.disposition)) {
      addFinding(findings, path, FINDING_CODES.SOURCE_CLAUSE_OMITTED, 'Canonical executable source clause is unlinked.');
    } else if (clause.disposition === 'action' && !links.has('action')) {
      addFinding(findings, `${path}.disposition`, FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, 'Canonical action disposition has no action link.');
    } else if (clause.disposition === 'assertion' && !links.has('assertion')) {
      addFinding(findings, `${path}.disposition`, FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, 'Canonical assertion disposition has no assertion link.');
    } else if (clause.disposition === 'condition' && !links.has('condition')) {
      addFinding(findings, `${path}.disposition`, FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, 'Canonical condition disposition has no condition link.');
    } else if (clause.disposition === 'mixed' && !(links.has('action') && links.has('assertion'))) {
      addFinding(findings, `${path}.disposition`, FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, 'Canonical mixed disposition requires action and assertion links.');
    }
  });
  if (!SHA256_RE.test(draft.contractDigest) || draft.contractDigest !== computeAddScenarioContractDigest(draft)) {
    addFinding(findings, 'contractDigest', CODES.CONTRACT_DIGEST_MISMATCH, 'Canonical contract digest does not match canonical semantics.');
  }
  return { valid: findings.length === 0, findings };
}

module.exports = {
  ORDERED_DRAFT_VERSION,
  MAX_ORDERED_OPERATIONS,
  REDACTED_SOURCE,
  CODES,
  AddScenarioOrderedDraftError,
  AddScenarioOperationLimitError,
  sourceDigest,
  computeAddScenarioContractDigest,
  createAddScenarioOrderedDraft,
  validateAddScenarioOrderedDraft,
};
