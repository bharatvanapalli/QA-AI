'use strict';

/**
 * Strict semantic boundary for a model-authored CaseContractV1 case.
 *
 * The normalizer may trim display fields and deterministically resolve exact
 * sourceQuote offsets. It never derives an action, target, value, assertion,
 * comparator, operand, or dependency from prose.
 */

const CONTRACT_VERSION = 'CaseContractV1';
const ERROR_CODE = 'SEMANTIC_CASE_CONTRACT_INVALID';
const DEFAULT_MAX_STEPS = 100;

const VALID_STEP_TYPES = Object.freeze([
  'Navigate', 'GoBack', 'GoForward', 'Refresh',
  'Click', 'DoubleClick', 'RightClick', 'ClickAndHold', 'MiddleClick', 'HoverAndClick',
  'Fill', 'Type', 'Append', 'Clear', 'ClearAndType', 'Select', 'Deselect', 'MultiSelect',
  'Check', 'Uncheck', 'Radio', 'Date', 'Time', 'DateTime', 'Upload',
  'Download', 'Hover', 'Scroll', 'ScrollIntoView', 'ScrollToTop', 'ScrollToBottom',
  'Expand', 'Collapse', 'Submit', 'WaitForState', 'PressKey', 'Hotkey', 'DragAndDrop', 'Slider',
  'SwitchContext', 'SwitchTab', 'SwitchFrame', 'AccessShadow', 'Close',
  'AcceptAlert', 'DismissAlert', 'TypeAlert',
  'Copy', 'Paste', 'ExtractData', 'StoreVariable', 'Evaluate', 'human_input', 'human_verification',
  'FindRow', 'CountRows', 'SortColumn',
  'Screenshot',
]);

const VALID_ASSERTION_TYPES = Object.freeze([
  'AssertText', 'AssertRegex', 'AssertUrl', 'AssertNumber', 'AssertCurrency',
  'AssertDate', 'AssertTime', 'AssertDateTime', 'AssertVisible', 'AssertHidden',
  'AssertEnabled', 'AssertDisabled', 'AssertReadonly', 'AssertAttribute', 'AssertValue',
  'AssertSelected', 'AssertChecked', 'AssertCount', 'AssertCollection',
  'AssertTemporal', 'AssertDownload', 'AssertPopup', 'AssertPage',
]);

const VALID_TARGET_KINDS = Object.freeze([
  'control', 'field', 'option', 'collection', 'region', 'page', 'url',
  'document', 'dialog', 'frame', 'viewport', 'browser_context',
]);
const VALID_SELECTION_KINDS = Object.freeze([
  'exact_text', 'exact_value', 'ordinal', 'predicate', 'data_ref', 'reference',
]);
const VALID_FAILURE_BEHAVIORS = Object.freeze([
  'stop_case', 'stop_descendants', 'continue', 'continue_independent',
  'block_dependents',
]);
const VALID_SESSION_MODES = Object.freeze([
  'fresh', 'continue_from_case', 'continue_from_dependency',
  'reuse_authenticated_session',
]);
const VALID_FLOW_IMPACTS = Object.freeze([
  'state_change', 'observation', 'wait', 'navigation', 'context_change',
]);
const VALID_SOURCE_DISPOSITIONS = Object.freeze([
  'action', 'assertion', 'clarification', 'metadata', 'condition', 'data', 'mixed',
]);
const VALID_ASSERTION_CHANNELS = Object.freeze([
  'state', 'text', 'url', 'number', 'collection', 'temporal', 'duration',
]);
const VALID_OPERAND_KINDS = Object.freeze([
  'target_property', 'reference', 'literal', 'boolean', 'text', 'url',
  'number', 'collection', 'count', 'temporal', 'temporal_reference',
  'duration',
]);
const VALID_ASSERTION_COMPARATORS = Object.freeze([
  'equals', 'not_equals', 'contains', 'not_contains', 'matches', 'visible',
  'hidden', 'enabled', 'disabled', 'selected', 'checked', 'url_matches',
  'count_equals', 'count_at_least', 'count_at_most', 'collection_exact',
  'collection_exact_order', 'collection_contains_all',
  'collection_contains_any', 'collection_excludes', 'before', 'after',
  'same_as', 'same_or_before', 'same_or_after', 'duration_equals',
  'duration_at_most', 'duration_at_least',
]);
const COLLECTION_COMPARATORS = Object.freeze([
  'collection_exact', 'collection_exact_order', 'collection_contains_all',
  'collection_contains_any', 'collection_excludes',
]);
const TEMPORAL_COMPARATORS = Object.freeze([
  'before', 'after', 'same_as', 'same_or_before', 'same_or_after',
  'duration_equals', 'duration_at_most', 'duration_at_least',
]);
const VALID_TEMPORAL_TYPES = Object.freeze(['date', 'time', 'datetime']);
const ASSERTION_TYPE_COMPARATORS = Object.freeze({
  AssertText: ['equals', 'not_equals', 'contains', 'not_contains'],
  AssertRegex: ['matches'],
  AssertUrl: ['equals', 'contains', 'url_matches', 'matches'],
  AssertNumber: ['equals', 'not_equals'],
  AssertCurrency: ['equals', 'not_equals'],
  AssertDate: ['equals'],
  AssertTime: ['equals'],
  AssertDateTime: ['equals'],
  AssertVisible: ['visible'],
  AssertHidden: ['hidden'],
  AssertEnabled: ['enabled'],
  AssertDisabled: ['disabled'],
  AssertReadonly: ['readonly', 'disabled', 'equals', 'contains'],
  AssertAttribute: ['equals', 'not_equals', 'contains', 'not_contains', 'matches'],
  AssertValue: ['equals', 'not_equals', 'contains', 'not_contains', 'matches'],
  AssertSelected: ['selected', 'equals'],
  AssertChecked: ['checked'],
  AssertCount: ['count_equals', 'count_at_least', 'count_at_most'],
  AssertCollection: [...COLLECTION_COMPARATORS, 'count_equals', 'count_at_least', 'count_at_most'],
  AssertTemporal: [...TEMPORAL_COMPARATORS],
  AssertDownload: ['equals', 'contains', 'matches'],
  AssertPopup: ['visible', 'equals', 'contains', 'matches'],
  AssertPage: ['url_matches', 'matches', 'equals'],
});

const FINDING_CODES = Object.freeze({
  CONTRACT_NOT_OBJECT: 'semantic_contract_not_object',
  VERSION_INVALID: 'semantic_contract_version_invalid',
  ID_MISSING: 'semantic_contract_id_missing',
  ID_INVALID: 'semantic_contract_id_invalid',
  ID_DUPLICATE: 'semantic_contract_id_duplicate',
  ORDINAL_INVALID: 'semantic_contract_ordinal_not_contiguous',
  SOURCE_TEXT_MISSING: 'semantic_contract_source_text_missing',
  SOURCE_CLAUSES_MISSING: 'semantic_contract_source_clauses_missing',
  SOURCE_QUOTE_MISSING: 'semantic_contract_source_quote_missing',
  SOURCE_QUOTE_NOT_FOUND: 'semantic_contract_source_quote_not_found',
  SOURCE_QUOTE_AMBIGUOUS: 'semantic_contract_source_quote_ambiguous',
  SOURCE_SPAN_INVALID: 'semantic_contract_source_span_invalid',
  SOURCE_SPAN_QUOTE_MISMATCH: 'semantic_contract_source_span_quote_mismatch',
  SOURCE_ORDER_INVALID: 'semantic_contract_source_order_invalid',
  SOURCE_SPAN_DUPLICATE: 'semantic_contract_source_span_duplicate',
  SOURCE_SPAN_OVERLAP: 'semantic_contract_source_span_overlap',
  SOURCE_TEXT_UNCOVERED: 'semantic_contract_source_text_uncovered',
  SOURCE_DISPOSITION_INVALID: 'semantic_contract_source_disposition_invalid',
  SOURCE_DISPOSITION_MISMATCH: 'semantic_contract_source_disposition_mismatch',
  SOURCE_CLAUSE_OMITTED: 'semantic_contract_source_clause_omitted',
  SOURCE_REFS_MISSING: 'semantic_contract_source_refs_missing',
  SOURCE_REF_DUPLICATE: 'semantic_contract_source_ref_duplicate',
  SOURCE_REF_UNKNOWN: 'semantic_contract_source_ref_unknown',
  SOURCE_ENTITY_LINK_MISMATCH: 'semantic_contract_source_entity_link_mismatch',
  STEPS_MISSING: 'semantic_contract_steps_missing',
  STEP_LIMIT_EXCEEDED: 'semantic_contract_step_limit_exceeded',
  STEP_TYPE_UNSUPPORTED: 'semantic_contract_step_type_unsupported',
  STEP_TEXT_MISSING: 'semantic_contract_step_text_missing',
  STEP_NOT_ATOMIC: 'semantic_contract_step_not_atomic',
  TARGET_IDENTITY_MISSING: 'semantic_contract_target_identity_missing',
  TARGET_IDENTITY_INVALID: 'semantic_contract_target_identity_invalid',
  TARGET_IDENTITY_IMPERATIVE: 'semantic_contract_target_identity_imperative',
  TARGET_IDENTITY_PROSE: 'semantic_contract_target_identity_prose',
  LEGACY_TARGET_FORBIDDEN: 'semantic_contract_legacy_target_forbidden',
  UNRESOLVED_REFERENCE: 'semantic_contract_unresolved_reference',
  VALUE_REQUIRED: 'semantic_contract_value_required',
  VALUE_REF_INVALID: 'semantic_contract_value_ref_invalid',
  VALUE_AUTHORITY_AMBIGUOUS: 'semantic_contract_value_authority_ambiguous',
  VALUE_NOT_SOURCE_LINKED: 'semantic_contract_value_not_source_linked',
  VALUE_UNEXPECTED: 'semantic_contract_value_unexpected',
  SELECTION_INVALID: 'semantic_contract_selection_criteria_invalid',
  CONDITION_INVALID: 'semantic_contract_condition_invalid',
  DATE_NOT_CANONICAL: 'semantic_contract_date_not_canonical',
  TIME_NOT_CANONICAL: 'semantic_contract_time_not_canonical',
  DATETIME_NOT_CANONICAL: 'semantic_contract_datetime_not_canonical',
  DATA_REFS_INVALID: 'semantic_contract_data_refs_invalid',
  FLOW_IMPACT_INVALID: 'semantic_contract_flow_impact_invalid',
  FAILURE_BEHAVIOR_INVALID: 'semantic_contract_failure_behavior_invalid',
  DEPENDENCIES_INVALID: 'semantic_contract_dependencies_invalid',
  DEPENDENCY_DUPLICATE: 'semantic_contract_dependency_duplicate',
  DEPENDENCY_MISSING: 'semantic_contract_dependency_missing',
  DEPENDENCY_FORWARD: 'semantic_contract_dependency_not_backward',
  DEPENDENCY_CYCLE: 'semantic_contract_dependency_cycle',
  DUPLICATE_STEP: 'semantic_contract_duplicate_step',
  ASSERTIONS_MISSING: 'semantic_contract_assertions_missing',
  ASSERTION_TYPE_UNSUPPORTED: 'semantic_contract_assertion_type_unsupported',
  ASSERTION_TEXT_MISSING: 'semantic_contract_assertion_text_missing',
  ASSERTION_COMPARATOR_INVALID: 'semantic_contract_assertion_comparator_invalid',
  ASSERTION_PAYLOAD_INVALID: 'semantic_contract_assertion_payload_invalid',
  ASSERTION_CHANNEL_INVALID: 'semantic_contract_assertion_channel_invalid',
  ASSERTION_OPERANDS_INVALID: 'semantic_contract_assertion_operands_invalid',
  ASSERTION_EXPECTED_INSTRUCTION: 'semantic_contract_assertion_expected_instruction',
  COLLECTION_EXPECTED_ARRAY: 'semantic_contract_collection_expected_array_required',
  TEMPORAL_OPERANDS_INVALID: 'semantic_contract_temporal_operands_invalid',
  TEMPORAL_COMPARATOR_INVALID: 'semantic_contract_temporal_comparator_invalid',
  VISIBILITY_ENABLEMENT_CONFLATED: 'semantic_contract_visibility_enablement_conflated',
  HIDDEN_TARGET_DOUBLE_NEGATIVE: 'semantic_contract_hidden_target_double_negative',
  ASSERTION_STEP_INVALID: 'semantic_contract_assertion_step_invalid',
  ASSERTION_REQUIRED_INVALID: 'semantic_contract_assertion_required_invalid',
  DUPLICATE_ASSERTION: 'semantic_contract_duplicate_assertion',
  SESSION_REQUIREMENT_INVALID: 'semantic_contract_session_requirement_invalid',
  FAILURE_POLICY_INVALID: 'semantic_contract_failure_policy_invalid',
  SENSITIVE_LITERAL: 'semantic_contract_sensitive_literal_forbidden',
  METADATA_INVALID: 'semantic_contract_metadata_invalid',
  DATA_BINDING_INVALID: 'semantic_contract_data_binding_invalid',
  CLARIFICATION_INVALID: 'semantic_contract_clarification_invalid',
  CLARIFICATION_REQUIRED: 'semantic_contract_clarification_required',
});

const STEP_ENUM = enumIndex(VALID_STEP_TYPES);
const ASSERTION_ENUM = enumIndex(VALID_ASSERTION_TYPES);
const TARGET_KIND_ENUM = enumIndex(VALID_TARGET_KINDS);
const SELECTION_KIND_ENUM = enumIndex(VALID_SELECTION_KINDS);
const FAILURE_BEHAVIOR_ENUM = enumIndex(VALID_FAILURE_BEHAVIORS);
const SESSION_MODE_ENUM = enumIndex(VALID_SESSION_MODES);
const FLOW_IMPACT_ENUM = enumIndex(VALID_FLOW_IMPACTS);
const SOURCE_DISPOSITION_ENUM = enumIndex(VALID_SOURCE_DISPOSITIONS);
const ASSERTION_CHANNEL_ENUM = enumIndex(VALID_ASSERTION_CHANNELS);
const OPERAND_KIND_ENUM = enumIndex(VALID_OPERAND_KINDS);
const COMPARATOR_ENUM = enumIndex(VALID_ASSERTION_COMPARATORS);
const STEP_TYPE_ALIASES = new Map([
  ['opendropdown', 'Click'], ['opencalendar', 'Click'], ['openpicker', 'Click'],
  ['openmenu', 'Click'], ['opendialog', 'Click'], ['openpopover', 'Click'],
  ['activatecontrol', 'Click'], ['clickcontrol', 'Click'],
  ['chooseoption', 'Select'], ['pickoption', 'Select'],
  ['setdate', 'Date'], ['selectdate', 'Date'], ['settime', 'Time'],
  ['selecttime', 'Time'], ['setdatetime', 'DateTime'],
  ['uploadfile', 'Upload'], ['downloadfile', 'Download'],
  ['scrollintoview', 'Scroll'], ['expandsection', 'Expand'],
  ['collapsesection', 'Collapse'], ['selectradio', 'Radio'],
  ['checkcheckbox', 'Check'], ['uncheckcheckbox', 'Uncheck'],
]);
const STABLE_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{1,127}$/;
const DATA_REF_RE = /^(?:data\.)?[A-Za-z_][A-Za-z0-9_.-]*$/;
const VALUE_REF_RE = /^(?:data|env|vault|credential|fixture|runtime|secret):[A-Za-z0-9_.:/-]+$/;
const ROLE_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const IMPERATIVE_TARGET_RE = /^(?:open|click|press|tap|select|choose|pick|fill|enter|input|type|check|tick|scroll|expand|collapse|verify|assert|validate|confirm|expect|wait)\b/i;
const PROSE_TARGET_RE = /\b(?:in capital letters|and then|then click|contains? exactly|displays? exactly|should be|must be|is visible|is enabled|into (?:the|a|an)\s+.+)\b/i;
const ACTION_VERB_RE = /\b(?:navigate|go to|visit|open|click|double[- ]?click|press|tap|fill|enter|input|type|clear|select|choose|pick|check|uncheck|hover|scroll|expand|collapse|submit|upload|download|drag|switch|close|capture)\b/ig;
const ASSERTION_VERB_RE = /\b(?:verify|assert|validate|confirm|expect)\b/ig;
const ASSERTION_INSTRUCTION_RE = /^(?:verify|assert|validate|confirm|expect)(?:\s+that)?\b/i;
const UNRESOLVED_REFERENCE_RE = /\b(?:it|them|they|this value|that value|these values|those values|the selected (?:time|date|value|option|item)|the entered (?:text|value)|the chosen (?:value|option|item)|the (?:above|below|previous|same) (?:value|time|date|option|item))\b/i;
const HIDDEN_DOUBLE_NEGATIVE_RE = /^(?:no|required absence of|absence of|without)\s+(?:required[- ]field\s+)?(?:validation|error|warning|message|element|control|item|option|text)\b|\b(?:is not|isn't|does not|hidden|invisible|absent)\b/i;
const SENSITIVE_RE = /(?:^|[^a-z0-9])(?:pass(?:word)?|pwd|secret|token|api[_ -]?key|credential|otp|mfa|pin)(?:$|[^a-z0-9])/i;
const VALUE_STEP_TYPES = new Set(['Fill', 'Type', 'Date', 'Time', 'DateTime', 'Upload', 'PressKey']);
const TARGET_OPTIONAL_TYPES = new Set(['Navigate', 'SwitchContext', 'Screenshot', 'PressKey']);
const COLLECTION_SET = new Set(COLLECTION_COMPARATORS);
const TEMPORAL_SET = new Set(TEMPORAL_COMPARATORS);
const FAILURE_SET = new Set(VALID_FAILURE_BEHAVIORS);

class SemanticCaseContractValidationError extends Error {
  constructor(message, findings = [], contract = null) {
    super(message);
    this.name = 'SemanticCaseContractValidationError';
    this.code = ERROR_CODE;
    this.status = 422;
    this.findings = Array.isArray(findings) ? findings : [];
    this.contract = contract;
  }
}

function enumIndex(values) {
  return new Map(values.map((value) => [value.toLowerCase().replace(/[^a-z0-9]/g, ''), value]));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function canonicalEnum(value, index) {
  if (typeof value !== 'string') return value;
  const key = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return index.get(key) || value.trim();
}

function enumToken(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    : '';
}

function canonicalStepType(value) {
  const canonical = canonicalEnum(value, STEP_ENUM);
  return VALID_STEP_TYPES.includes(canonical)
    ? canonical
    : (STEP_TYPE_ALIASES.get(enumToken(value)) || canonical);
}

function canonicalOrdinalArray(value) {
  return Array.isArray(value)
    ? value.map((entry, index) => (isObject(entry) ? { ...entry, ordinal: index + 1 } : entry))
    : value;
}

function defaultFlowImpactForType(type) {
  if (type === 'Navigate') return 'navigation';
  if (type === 'WaitForState') return 'wait';
  if (['Scroll', 'SwitchContext', 'Close'].includes(type)) return 'context_change';
  if (['Hover', 'Screenshot'].includes(type)) return 'observation';
  return VALID_STEP_TYPES.includes(type) ? 'state_change' : '';
}

function normalizeStrings(value) {
  return Array.isArray(value) ? value.map(trim) : value;
}

function occurrences(sourceText, quote) {
  const found = [];
  if (!sourceText || !quote) return found;
  let offset = 0;
  while (offset <= sourceText.length - quote.length) {
    const index = sourceText.indexOf(quote, offset);
    if (index < 0) break;
    found.push(index);
    offset = index + Math.max(quote.length, 1);
  }
  return found;
}

function normalizeSourceEvidence(value, sourceText) {
  if (!isObject(value)) return value;
  const normalized = clone(value);
  normalized.sourceQuote = trim(normalized.sourceQuote);
  const quote = typeof normalized.sourceQuote === 'string' ? normalized.sourceQuote : '';
  const span = isObject(normalized.sourceSpan) ? normalized.sourceSpan : null;
  const suppliedStart = span && Number.isInteger(span.start) ? span.start : null;
  const suppliedEnd = span && Number.isInteger(span.end) ? span.end : null;
  if (quote && suppliedStart !== null && suppliedEnd === suppliedStart + quote.length
    && suppliedStart >= 0 && suppliedEnd <= sourceText.length
    && sourceText.slice(suppliedStart, suppliedEnd) === quote) {
    normalized.sourceSpan = { start: suppliedStart, end: suppliedEnd };
    return normalized;
  }
  const matches = occurrences(sourceText, quote);
  normalized.sourceSpan = matches.length === 1
    ? { start: matches[0], end: matches[0] + quote.length }
    : { start: null, end: null };
  return normalized;
}

function normalizeTargetIdentity(value) {
  if (!isObject(value)) return value;
  const normalized = clone(value);
  for (const key of ['kind', 'label', 'role', 'scope', 'controlType', 'reference', 'url', 'description']) normalized[key] = trim(normalized[key]);
  normalized.kind = canonicalEnum(normalized.kind, TARGET_KIND_ENUM);
  if (typeof normalized.role === 'string') normalized.role = normalized.role.toLowerCase();
  return normalized;
}

function normalizeLinkedRecord(value, sourceText) {
  const normalized = normalizeSourceEvidence(value, sourceText);
  if (!isObject(normalized)) return normalized;
  for (const key of ['id', 'name', 'intent', 'text', 'description', 'displayText', 'question', 'reason', 'disposition', 'failureBehavior', 'flowImpact', 'stepId', 'comparator', 'key']) normalized[key] = trim(normalized[key]);
  normalized.sourceClauseRefs = normalizeStrings(normalized.sourceClauseRefs);
  normalized.dataRefs = normalizeStrings(normalized.dataRefs);
  normalized.disposition = canonicalEnum(normalized.disposition, SOURCE_DISPOSITION_ENUM);
  normalized.failureBehavior = canonicalEnum(normalized.failureBehavior, FAILURE_BEHAVIOR_ENUM);
  normalized.flowImpact = canonicalEnum(normalized.flowImpact, FLOW_IMPACT_ENUM);
  if (normalized.targetIdentity !== undefined) normalized.targetIdentity = normalizeTargetIdentity(normalized.targetIdentity);
  return normalized;
}

function normalizeStep(value, sourceText, defaultFailureBehavior = '') {
  const normalized = normalizeLinkedRecord(value, sourceText);
  if (!isObject(normalized)) return normalized;
  normalized.type = canonicalStepType(normalized.type);
  if (!VALID_FLOW_IMPACTS.includes(normalized.flowImpact) && !trim(normalized.flowImpact)) {
    normalized.flowImpact = defaultFlowImpactForType(normalized.type);
  }
  if (!VALID_FAILURE_BEHAVIORS.includes(normalized.failureBehavior) && !trim(normalized.failureBehavior)
    && VALID_FAILURE_BEHAVIORS.includes(defaultFailureBehavior)) {
    normalized.failureBehavior = defaultFailureBehavior;
  }
  normalized.dependsOn = normalizeStrings(normalized.dependsOn);
  if (Object.prototype.hasOwnProperty.call(normalized, 'valueRef')) normalized.valueRef = trim(normalized.valueRef);
  if (isObject(normalized.selectionCriteria)) {
    normalized.selectionCriteria = clone(normalized.selectionCriteria);
    for (const key of ['kind', 'text', 'predicate', 'ref', 'expectedText']) normalized.selectionCriteria[key] = trim(normalized.selectionCriteria[key]);
    normalized.selectionCriteria.kind = canonicalEnum(normalized.selectionCriteria.kind, SELECTION_KIND_ENUM);
  }
  if (isObject(normalized.condition)) {
    normalized.condition = normalized.condition.sourceQuote !== undefined || normalized.condition.sourceSpan !== undefined
      ? normalizeSourceEvidence(normalized.condition, sourceText)
      : clone(normalized.condition);
    normalized.condition.kind = trim(normalized.condition.kind);
    normalized.condition.comparator = trim(normalized.condition.comparator);
  }
  return normalized;
}

function normalizeAssertion(value, sourceText) {
  const normalized = normalizeLinkedRecord(value, sourceText);
  if (!isObject(normalized)) return normalized;
  normalized.type = canonicalEnum(normalized.type, ASSERTION_ENUM);
  normalized.comparator = canonicalEnum(normalized.comparator, COMPARATOR_ENUM);
  if (isObject(normalized.payload)) {
    normalized.payload = clone(normalized.payload);
    normalized.payload.channel = canonicalEnum(normalized.payload.channel, ASSERTION_CHANNEL_ENUM);
    if (Array.isArray(normalized.payload.operands)) {
      normalized.payload.operands = normalized.payload.operands.map((operand) => {
        if (!isObject(operand)) return operand;
        const copy = clone(operand);
        for (const key of ['role', 'kind', 'name', 'ref', 'property', 'unit', 'timeZone', 'temporalType']) copy[key] = trim(copy[key]);
        copy.role = typeof copy.role === 'string' ? copy.role.toLowerCase() : copy.role;
        copy.kind = canonicalEnum(copy.kind, OPERAND_KIND_ENUM);
        return copy;
      });
    }
  }
  return normalized;
}

function normalizeSemanticCaseContract(contract, { sourceText = '' } = {}) {
  if (!isObject(contract)) return contract;
  const source = typeof sourceText === 'string' ? sourceText : '';
  const normalized = normalizeLinkedRecord(contract, source);
  normalized.version = trim(normalized.version);
  normalized.failurePolicy = normalizeLinkedRecord(normalized.failurePolicy, source);
  if (isObject(normalized.failurePolicy)) {
    normalized.failurePolicy.default = canonicalEnum(normalized.failurePolicy.default, FAILURE_BEHAVIOR_ENUM);
    normalized.failurePolicy.onAssertionFailure = canonicalEnum(normalized.failurePolicy.onAssertionFailure, FAILURE_BEHAVIOR_ENUM);
    normalized.failurePolicy.onActionFailure = canonicalEnum(normalized.failurePolicy.onActionFailure, FAILURE_BEHAVIOR_ENUM);
  }
  const defaultFailureBehavior = isObject(normalized.failurePolicy) ? normalized.failurePolicy.default : '';
  normalized.sourceClauses = canonicalOrdinalArray(Array.isArray(normalized.sourceClauses)
    ? normalized.sourceClauses.map((entry) => normalizeLinkedRecord(entry, source)) : normalized.sourceClauses);
  normalized.steps = canonicalOrdinalArray(Array.isArray(normalized.steps)
    ? normalized.steps.map((entry) => normalizeStep(entry, source, defaultFailureBehavior)) : normalized.steps);
  normalized.assertions = canonicalOrdinalArray(Array.isArray(normalized.assertions)
    ? normalized.assertions.map((entry) => normalizeAssertion(entry, source)) : normalized.assertions);
  normalized.metadata = canonicalOrdinalArray(Array.isArray(normalized.metadata)
    ? normalized.metadata.map((entry) => normalizeLinkedRecord(entry, source)) : normalized.metadata);
  normalized.dataBindings = canonicalOrdinalArray(Array.isArray(normalized.dataBindings)
    ? normalized.dataBindings.map((entry) => normalizeLinkedRecord(entry, source)) : normalized.dataBindings);
  normalized.clarifications = canonicalOrdinalArray(Array.isArray(normalized.clarifications)
    ? normalized.clarifications.map((entry) => normalizeLinkedRecord(entry, source)) : normalized.clarifications);
  normalized.sessionRequirement = normalizeLinkedRecord(normalized.sessionRequirement, source);
  normalized.initialState = normalizeLinkedRecord(normalized.initialState, source);
  normalized.expectedFinalState = normalizeLinkedRecord(normalized.expectedFinalState, source);
  if (isObject(normalized.sessionRequirement)) {
    normalized.sessionRequirement.mode = canonicalEnum(normalized.sessionRequirement.mode, SESSION_MODE_ENUM);
    normalized.sessionRequirement.predecessorCaseId = trim(normalized.sessionRequirement.predecessorCaseId);
    normalized.sessionRequirement.dependsOnCaseRefs = normalizeStrings(normalized.sessionRequirement.dependsOnCaseRefs);
  }
  return normalized;
}

function sourceClauseDispositionIndex(cases) {
  const index = new Map();
  const add = (record, disposition) => {
    if (!isObject(record) || !Array.isArray(record.sourceClauseRefs)) return;
    record.sourceClauseRefs.forEach((ref) => {
      if (typeof ref !== 'string' || !ref) return;
      if (!index.has(ref)) index.set(ref, new Set());
      index.get(ref).add(disposition);
    });
  };
  (Array.isArray(cases) ? cases : []).forEach((caseContract) => {
    if (!isObject(caseContract)) return;
    add(caseContract, 'metadata');
    ['sessionRequirement', 'failurePolicy', 'initialState', 'expectedFinalState']
      .forEach((key) => add(caseContract[key], 'metadata'));
    (Array.isArray(caseContract.steps) ? caseContract.steps : []).forEach((record) => add(record, 'action'));
    (Array.isArray(caseContract.assertions) ? caseContract.assertions : []).forEach((record) => add(record, 'assertion'));
    (Array.isArray(caseContract.metadata) ? caseContract.metadata : []).forEach((record) => add(record, 'metadata'));
    (Array.isArray(caseContract.dataBindings) ? caseContract.dataBindings : []).forEach((record) => add(record, 'data'));
    (Array.isArray(caseContract.clarifications) ? caseContract.clarifications : []).forEach((record) => add(record, 'clarification'));
  });
  return index;
}

function isCanonicalDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isCanonicalTime(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  return Boolean(match) && Number(match[1]) <= 23 && Number(match[2]) <= 59
    && (match[3] === undefined || Number(match[3]) <= 59);
}

function isCanonicalDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d{3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || !isCanonicalDate(match[1]) || !isCanonicalTime(match[2])) return false;
  if (match[3] !== 'Z') {
    const [hours, minutes] = match[3].slice(1).split(':').map(Number);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

const MONTH_INDEX = Object.freeze({
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
});

function datePartsKey(year, month, day) {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isCanonicalDate(value) ? value : null;
}

function authoredDateValues(sourceQuote) {
  const source = String(sourceQuote || '');
  const values = new Set();
  for (const match of source.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const value = datePartsKey(Number(match[1]), Number(match[2]), Number(match[3]));
    if (value) values.add(value);
  }
  for (const match of source.matchAll(/\b(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept?|October|Oct|November|Nov|December|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) {
    const value = datePartsKey(Number(match[3]), MONTH_INDEX[match[1].toLowerCase()], Number(match[2]));
    if (value) values.add(value);
  }
  for (const match of source.matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/g)) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first <= 12 && second > 12) {
      const value = datePartsKey(Number(match[3]), first, second);
      if (value) values.add(value);
    } else if (first > 12 && second <= 12) {
      const value = datePartsKey(Number(match[3]), second, first);
      if (value) values.add(value);
    } else if (first === second && first <= 12) {
      const value = datePartsKey(Number(match[3]), first, second);
      if (value) values.add(value);
    }
  }
  return values;
}

function timePartsKey(hours, minutes, seconds = 0) {
  const value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds) <= 59 ? value : null;
}

function canonicalTimeKey(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  return match ? timePartsKey(Number(match[1]), Number(match[2]), Number(match[3] || 0)) : null;
}

function authoredTimeValues(sourceQuote) {
  const source = String(sourceQuote || '');
  const values = new Set();
  for (const match of source.matchAll(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\b/gi)) {
    let hours = Number(match[1]);
    if (hours < 1 || hours > 12) continue;
    if (match[4].toUpperCase() === 'AM') hours = hours === 12 ? 0 : hours;
    else hours = hours === 12 ? 12 : hours + 12;
    const value = timePartsKey(hours, Number(match[2]), Number(match[3] || 0));
    if (value) values.add(value);
  }
  for (const match of source.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b(?!\s*(?:AM|PM))/gi)) {
    const value = timePartsKey(Number(match[1]), Number(match[2]), Number(match[3] || 0));
    if (value) values.add(value);
  }
  return values;
}

function authoredTimezoneValues(sourceQuote) {
  const source = String(sourceQuote || '');
  const values = new Set();
  if (/\b(?:UTC|GMT)\b|(?:^|\s)Z(?:\s|$)/i.test(source)) values.add('Z');
  for (const match of source.matchAll(/(?:\b(?:UTC|GMT)\s*)?([+-]\d{2}:\d{2})\b/gi)) values.add(match[1]);
  return values;
}

function uniqueAuthoredCanonicalValue(type, sourceQuote) {
  if (type === 'Date') {
    const candidates = [...authoredDateValues(sourceQuote)];
    return candidates.length === 1 ? candidates[0] : null;
  }
  if (type === 'Time') {
    const source = String(sourceQuote || '');
    const candidates = [...authoredTimeValues(source)];
    if (candidates.length !== 1) return null;
    const authoredSeconds = /\b\d{1,2}:\d{2}:\d{2}(?:\s*(?:AM|PM))?\b/i.test(source);
    return authoredSeconds ? candidates[0] : candidates[0].slice(0, 5);
  }
  if (type === 'DateTime') {
    const source = String(sourceQuote || '');
    const dates = [...authoredDateValues(source)];
    const times = [...authoredTimeValues(source)];
    const timezones = [...authoredTimezoneValues(source)];
    if (dates.length !== 1 || times.length !== 1 || timezones.length !== 1) return null;
    const authoredSeconds = /\b\d{1,2}:\d{2}:\d{2}(?:\s*(?:AM|PM))?\b/i.test(source);
    const time = authoredSeconds ? times[0] : times[0].slice(0, 5);
    const candidate = `${dates[0]}T${time}${timezones[0]}`;
    return isCanonicalDateTime(candidate) ? candidate : null;
  }
  return null;
}

function isSourceLinkedStepValue(type, value, sourceQuote) {
  const source = String(sourceQuote || '');
  if (typeof value !== 'string' || !value) return true;
  if (type === 'Date' && isCanonicalDate(value)) {
    const candidates = authoredDateValues(source);
    return candidates.size === 1 && candidates.has(value);
  }
  if (type === 'Time' && isCanonicalTime(value)) {
    const candidates = authoredTimeValues(source);
    return candidates.size === 1 && candidates.has(canonicalTimeKey(value));
  }
  if (type === 'DateTime' && isCanonicalDateTime(value)) {
    return source.includes(value) || uniqueAuthoredCanonicalValue('DateTime', source) === value;
  }
  return source.includes(value);
}

function isValueRef(value) {
  return typeof value === 'string' && VALUE_REF_RE.test(value.trim());
}

function isExactScalar(value) {
  return (typeof value === 'string' && value.length > 0) || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return JSON.stringify(canonicalize(value));
}

function targetFingerprint(value) {
  if (!isObject(value)) return value;
  return { kind: value.kind, label: value.label, role: value.role, scope: value.scope };
}

function uncoveredRanges(source, covered) {
  const ranges = [];
  let start = null;
  for (let index = 0; index < source.length; index += 1) {
    const uncovered = !covered[index] && /\S/.test(source[index]);
    if (uncovered && start === null) start = index;
    if (!uncovered && start !== null) {
      ranges.push({ start, end: index, text: source.slice(start, index) });
      start = null;
    }
  }
  if (start !== null) ranges.push({ start, end: source.length, text: source.slice(start) });
  return ranges;
}

function collectSourceClauseRefs(value, refs = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSourceClauseRefs(entry, refs));
    return refs;
  }
  if (!isObject(value)) return refs;
  if (Array.isArray(value.sourceClauseRefs)) {
    value.sourceClauseRefs.forEach((ref) => {
      if (typeof ref === 'string' && ref) refs.add(ref);
    });
  }
  Object.entries(value).forEach(([key, entry]) => {
    if (key !== 'sourceClauses' && key !== 'cases') collectSourceClauseRefs(entry, refs);
  });
  return refs;
}

function semanticOperationCounts(caseContract) {
  const actionCount = Array.isArray(caseContract && caseContract.steps) ? caseContract.steps.length : 0;
  const assertionCount = Array.isArray(caseContract && caseContract.assertions) ? caseContract.assertions.length : 0;
  return { actionCount, assertionCount, actual: actionCount + assertionCount };
}

function validateSemanticCaseContractEnvelope(contract, { sourceText = '', maxSteps = DEFAULT_MAX_STEPS } = {}) {
  const source = typeof sourceText === 'string' ? sourceText : '';
  const normalized = isObject(contract) ? clone(contract) : contract;
  const findings = [];
  const push = (code, path, detail, evidence = undefined) => findings.push({
    code, severity: 'error', path, detail, ...(evidence === undefined ? {} : { evidence }),
  });
  if (!isObject(normalized)) {
    push(FINDING_CODES.CONTRACT_NOT_OBJECT, '$', 'CaseContractV1 envelope must be an object.');
    return { ok: false, contract: normalized, normalized, findings };
  }
  normalized.version = trim(normalized.version);
  if (normalized.version !== CONTRACT_VERSION) push(FINDING_CODES.VERSION_INVALID, '$.version', `version must be exactly ${CONTRACT_VERSION}.`, normalized.version);
  if (!source) push(FINDING_CODES.SOURCE_TEXT_MISSING, '$sourceText', 'Exact RAW_SOURCE is required for coverage validation.');

  const limit = Number.isInteger(maxSteps) && maxSteps > 0 ? maxSteps : DEFAULT_MAX_STEPS;
  const cases = Array.isArray(normalized.cases) ? normalized.cases : [];
  const dispositionIndex = sourceClauseDispositionIndex(cases);
  const clauses = canonicalOrdinalArray(Array.isArray(normalized.sourceClauses)
    ? normalized.sourceClauses.map((entry) => {
      const clause = normalizeLinkedRecord(entry, source);
      if (!isObject(clause)) return clause;
      clause.disposition = canonicalEnum(clause.disposition, SOURCE_DISPOSITION_ENUM);
      if (!VALID_SOURCE_DISPOSITIONS.includes(clause.disposition)) {
        const dispositions = dispositionIndex.get(clause.id);
        if (dispositions && dispositions.size === 1) clause.disposition = [...dispositions][0];
        else if (dispositions && dispositions.size > 1) clause.disposition = 'mixed';
      }
      return clause;
    })
    : []);
  normalized.sourceClauses = clauses;
  if (!clauses.length) push(FINDING_CODES.SOURCE_CLAUSES_MISSING, '$.sourceClauses', 'At least one exact source clause is required.');
  const clauseIds = new Set();
  const covered = Array.from({ length: source.length }, () => false);
  let previousStart = -1;
  clauses.forEach((clause, index) => {
    const path = `$.sourceClauses[${index}]`;
    if (!isObject(clause)) {
      push(FINDING_CODES.SOURCE_QUOTE_MISSING, path, 'Source clause must be an object.');
      return;
    }
    if (clause.ordinal !== index + 1) push(FINDING_CODES.ORDINAL_INVALID, `${path}.ordinal`, 'Ordinals must be contiguous and match array order.', { expected: index + 1, actual: clause.ordinal });
    if (typeof clause.id !== 'string' || !clause.id) push(FINDING_CODES.ID_MISSING, `${path}.id`, 'Source clause requires a stable id.');
    else if (clauseIds.has(clause.id)) push(FINDING_CODES.ID_DUPLICATE, `${path}.id`, 'Source clause id is duplicated.', clause.id);
    else clauseIds.add(clause.id);
    if (!VALID_SOURCE_DISPOSITIONS.includes(clause.disposition)) push(FINDING_CODES.SOURCE_DISPOSITION_INVALID, `${path}.disposition`, 'Source disposition is unsupported.', clause.disposition);
    const span = clause.sourceSpan;
    if (typeof clause.sourceQuote !== 'string' || !clause.sourceQuote) {
      push(FINDING_CODES.SOURCE_QUOTE_MISSING, `${path}.sourceQuote`, 'An exact non-empty sourceQuote is required.');
      return;
    }
    if (!isObject(span) || !Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < 0 || span.end <= span.start || span.end > source.length) {
      push(FINDING_CODES.SOURCE_SPAN_INVALID, `${path}.sourceSpan`, 'sourceSpan must contain valid zero-based start/end indices.');
      return;
    }
    if (source.slice(span.start, span.end) !== clause.sourceQuote) push(FINDING_CODES.SOURCE_SPAN_QUOTE_MISMATCH, `${path}.sourceSpan`, 'RAW_SOURCE.slice(start,end) must equal sourceQuote exactly.');
    if (span.start < previousStart) push(FINDING_CODES.SOURCE_ORDER_INVALID, `${path}.sourceSpan`, 'Clause ordinals must follow RAW_SOURCE order.');
    previousStart = span.start;
    let overlap = false;
    for (let offset = span.start; offset < span.end; offset += 1) {
      if (covered[offset]) overlap = true;
      covered[offset] = true;
    }
    if (overlap) push(FINDING_CODES.SOURCE_SPAN_OVERLAP, `${path}.sourceSpan`, 'Source clause spans may not overlap.');
  });
  const uncovered = uncoveredRanges(source, covered);
  if (uncovered.length) push(FINDING_CODES.SOURCE_TEXT_UNCOVERED, '$.sourceClauses', 'Every non-whitespace source character must be covered exactly once.', uncovered.slice(0, 12));

  if (!cases.length) push(FINDING_CODES.STEPS_MISSING, '$.cases', 'At least one executable semantic case is required; clarification-only output cannot be persisted.');
  const caseIds = new Set();
  const normalizedCases = [];
  const globallyLinkedClauseRefs = new Set();
  let totalActionCount = 0;
  let totalAssertionCount = 0;
  cases.forEach((caseContract, caseIndex) => {
    const casePath = `$.cases[${caseIndex}]`;
    if (!isObject(caseContract)) {
      push(FINDING_CODES.CONTRACT_NOT_OBJECT, casePath, 'Case must be an object.');
      normalizedCases.push(caseContract);
      return;
    }
    if (typeof caseContract.id !== 'string' || !caseContract.id) push(FINDING_CODES.ID_MISSING, `${casePath}.id`, 'Case requires a stable id.');
    else if (caseIds.has(caseContract.id)) push(FINDING_CODES.ID_DUPLICATE, `${casePath}.id`, 'Case id is duplicated.', caseContract.id);
    else caseIds.add(caseContract.id);
    const operationCounts = semanticOperationCounts(caseContract);
    totalActionCount += operationCounts.actionCount;
    totalAssertionCount += operationCounts.assertionCount;
    const refs = collectSourceClauseRefs(caseContract);
    refs.forEach((ref) => globallyLinkedClauseRefs.add(ref));
    const scopedClauses = clauses
      .filter((clause) => refs.has(clause && clause.id))
      .map((clause, index) => ({ ...clone(clause), ordinal: index + 1 }));
    const scoped = {
      ...clone(caseContract),
      version: caseContract.version || CONTRACT_VERSION,
      sourceClauses: scopedClauses,
    };
    const validation = validateSemanticCaseContract(scoped, {
      sourceText: source,
      maxSteps: limit,
      allowPartialSourceCoverage: true,
    });
    validation.findings.forEach((finding) => findings.push({
      ...finding,
      path: String(finding.path || '$').replace(/^\$/, casePath),
    }));
    const normalizedCase = clone(validation.contract);
    if (isObject(normalizedCase)) delete normalizedCase.sourceClauses;
    normalizedCases.push(normalizedCase);
  });
  const totalOperations = totalActionCount + totalAssertionCount;
  if (totalOperations > limit) push(
    FINDING_CODES.STEP_LIMIT_EXCEEDED,
    '$.cases',
    'Total Add Scenario operation count exceeds the semantic budget.',
    { maxSteps: limit, actual: totalOperations, actionCount: totalActionCount, assertionCount: totalAssertionCount },
  );
  normalized.cases = normalizedCases;

  const clarifications = Array.isArray(normalized.clarifications) ? normalized.clarifications : [];
  collectSourceClauseRefs({ clarifications }).forEach((ref) => globallyLinkedClauseRefs.add(ref));
  clauses.forEach((clause, index) => {
    const clauseId = clause && clause.id;
    if (clauseId && !globallyLinkedClauseRefs.has(clauseId)) {
      push(
        FINDING_CODES.SOURCE_CLAUSE_OMITTED,
        `$.sourceClauses[${index}]`,
        'Source clause is not represented by any case semantic or clarification.',
        clauseId,
      );
    }
  });
  clarifications.forEach((clarification, index) => push(
    FINDING_CODES.CLARIFICATION_REQUIRED,
    `$.clarifications[${index}]`,
    'Unresolved ambiguity blocks freezing and must be returned to the user instead of falling back to prose parsing.',
    clarification && clarification.id,
  ));
  return { ok: findings.length === 0, contract: normalized, normalized, findings };
}

function validateSemanticCaseContract(contract, {
  sourceText = '',
  maxSteps = DEFAULT_MAX_STEPS,
  allowPartialSourceCoverage = false,
} = {}) {
  if (isObject(contract) && Array.isArray(contract.cases)) {
    return validateSemanticCaseContractEnvelope(contract, { sourceText, maxSteps });
  }
  const normalized = normalizeSemanticCaseContract(contract, { sourceText });
  const source = typeof sourceText === 'string' ? sourceText : '';
  const findings = [];
  const limit = Number.isInteger(maxSteps) && maxSteps > 0 ? maxSteps : DEFAULT_MAX_STEPS;
  const push = (code, path, detail, evidence = undefined) => findings.push({
    code, severity: 'error', path, detail, ...(evidence === undefined ? {} : { evidence }),
  });

  if (!isObject(normalized)) {
    push(FINDING_CODES.CONTRACT_NOT_OBJECT, '$', 'CaseContractV1 case must be an object.');
    return { ok: false, contract: normalized, normalized, findings };
  }
  if (normalized.version !== CONTRACT_VERSION) push(FINDING_CODES.VERSION_INVALID, '$.version', `version must be exactly ${CONTRACT_VERSION}.`, normalized.version);
  if (!source) push(FINDING_CODES.SOURCE_TEXT_MISSING, '$sourceText', 'Exact RAW_SOURCE is required for coverage validation.');

  const ids = new Map();
  const registerId = (record, path, label) => {
    const id = record && record.id;
    if (typeof id !== 'string' || !id) {
      push(FINDING_CODES.ID_MISSING, `${path}.id`, `${label} requires a stable id.`);
      return null;
    }
    if (!STABLE_ID_RE.test(id)) push(FINDING_CODES.ID_INVALID, `${path}.id`, `${label} id has unsupported characters.`, id);
    if (ids.has(id)) push(FINDING_CODES.ID_DUPLICATE, `${path}.id`, `${label} id is duplicated.`, { id, firstPath: ids.get(id) });
    else ids.set(id, path);
    return id;
  };
  registerId(normalized, '$', 'Contract');

  const validateOrdinals = (rows, path) => rows.forEach((row, index) => {
    if (!isObject(row) || row.ordinal !== index + 1) push(FINDING_CODES.ORDINAL_INVALID, `${path}[${index}].ordinal`, 'Ordinals must be contiguous and match array order.', { expected: index + 1, actual: row && row.ordinal });
  });

  const validateEvidence = (record, path) => {
    if (!isObject(record) || typeof record.sourceQuote !== 'string' || !record.sourceQuote) {
      push(FINDING_CODES.SOURCE_QUOTE_MISSING, `${path}.sourceQuote`, 'An exact non-empty sourceQuote is required.');
      return null;
    }
    const matches = occurrences(source, record.sourceQuote);
    const span = record.sourceSpan;
    if (!matches.length) push(FINDING_CODES.SOURCE_QUOTE_NOT_FOUND, `${path}.sourceQuote`, 'sourceQuote is not an exact substring of RAW_SOURCE.');
    if (matches.length > 1 && (!isObject(span) || !Number.isInteger(span.start))) push(FINDING_CODES.SOURCE_QUOTE_AMBIGUOUS, `${path}.sourceQuote`, 'Repeated sourceQuote requires an exact sourceSpan.', matches);
    if (!isObject(span) || !Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < 0 || span.end <= span.start || span.end > source.length) {
      push(FINDING_CODES.SOURCE_SPAN_INVALID, `${path}.sourceSpan`, 'sourceSpan must contain valid zero-based start/end indices.');
      return null;
    }
    if (source.slice(span.start, span.end) !== record.sourceQuote) {
      push(FINDING_CODES.SOURCE_SPAN_QUOTE_MISMATCH, `${path}.sourceSpan`, 'RAW_SOURCE.slice(start,end) must equal sourceQuote exactly.');
      return null;
    }
    return { start: span.start, end: span.end };
  };
  validateEvidence(normalized, '$');

  const clauses = Array.isArray(normalized.sourceClauses) ? normalized.sourceClauses : [];
  if (!clauses.length) push(FINDING_CODES.SOURCE_CLAUSES_MISSING, '$.sourceClauses', 'At least one exact source clause is required.');
  validateOrdinals(clauses, '$.sourceClauses');
  const clauseById = new Map();
  const clauseLinks = new Map();
  const covered = Array.from({ length: source.length }, () => false);
  const spanOwners = new Map();
  let previousStart = -1;
  clauses.forEach((clause, index) => {
    const path = `$.sourceClauses[${index}]`;
    if (!isObject(clause)) {
      push(FINDING_CODES.SOURCE_QUOTE_MISSING, path, 'Source clause must be an object.');
      return;
    }
    const id = registerId(clause, path, 'Source clause');
    if (id && !clauseById.has(id)) {
      clauseById.set(id, clause);
      clauseLinks.set(id, []);
    }
    if (!VALID_SOURCE_DISPOSITIONS.includes(clause.disposition)) push(FINDING_CODES.SOURCE_DISPOSITION_INVALID, `${path}.disposition`, 'Source disposition is unsupported.', clause.disposition);
    const span = validateEvidence(clause, path);
    if (!span) return;
    if (span.start < previousStart) push(FINDING_CODES.SOURCE_ORDER_INVALID, `${path}.sourceSpan`, 'Clause ordinals must follow RAW_SOURCE order.');
    previousStart = span.start;
    const spanKey = `${span.start}:${span.end}`;
    if (spanOwners.has(spanKey)) push(FINDING_CODES.SOURCE_SPAN_DUPLICATE, `${path}.sourceSpan`, 'Two source clauses use the same span.', spanOwners.get(spanKey));
    else spanOwners.set(spanKey, path);
    let overlap = false;
    for (let offset = span.start; offset < span.end; offset += 1) {
      if (covered[offset]) overlap = true;
      covered[offset] = true;
    }
    if (overlap) push(FINDING_CODES.SOURCE_SPAN_OVERLAP, `${path}.sourceSpan`, 'Source clause spans may not overlap. Compound semantics share one clause reference.');
  });
  const uncovered = uncoveredRanges(source, covered);
  if (uncovered.length && !allowPartialSourceCoverage) push(FINDING_CODES.SOURCE_TEXT_UNCOVERED, '$.sourceClauses', 'Every non-whitespace source character must be covered exactly once.', uncovered.slice(0, 12));

  const linkRecord = (record, path, category, entityId) => {
    const refs = record && record.sourceClauseRefs;
    if (!Array.isArray(refs) || !refs.length) {
      push(FINDING_CODES.SOURCE_REFS_MISSING, `${path}.sourceClauseRefs`, `${category} requires sourceClauseRefs.`);
      return;
    }
    const seen = new Set();
    refs.forEach((ref, index) => {
      if (seen.has(ref)) push(FINDING_CODES.SOURCE_REF_DUPLICATE, `${path}.sourceClauseRefs[${index}]`, 'Duplicate source clause ref.', ref);
      seen.add(ref);
      if (!clauseById.has(ref)) push(FINDING_CODES.SOURCE_REF_UNKNOWN, `${path}.sourceClauseRefs[${index}]`, 'Unknown source clause ref.', ref);
      else clauseLinks.get(ref).push({ category, entityId, path });
    });
    const entitySpan = validateEvidence(record, path);
    if (entitySpan && refs.length) {
      const mismatchedRefs = refs.filter((ref) => {
        const clause = clauseById.get(ref);
        const clauseSpan = clause && clause.sourceSpan;
        return !isObject(clauseSpan) || entitySpan.start < clauseSpan.start || entitySpan.end > clauseSpan.end;
      });
      if (mismatchedRefs.length) push(
        FINDING_CODES.SOURCE_ENTITY_LINK_MISMATCH,
        `${path}.sourceSpan`,
        'Entity sourceSpan must be contained by every claimed sourceClauseRef; one evidence span cannot prove unrelated clauses.',
        { mismatchedRefs },
      );
    }
  };

  const validateSemanticString = (value, path) => {
    if (typeof value === 'string' && UNRESOLVED_REFERENCE_RE.test(value)) push(FINDING_CODES.UNRESOLVED_REFERENCE, path, 'Unresolved pronouns/references are forbidden in semantic fields.', value);
  };

  const validateTarget = (target, path, required = true) => {
    if (!isObject(target)) {
      if (required) push(FINDING_CODES.TARGET_IDENTITY_MISSING, path, 'Exact targetIdentity is required.');
      return false;
    }
    if (target.kind !== undefined && !VALID_TARGET_KINDS.includes(target.kind)) push(FINDING_CODES.TARGET_IDENTITY_INVALID, `${path}.kind`, 'targetIdentity.kind is unsupported.', target.kind);
    let valid = true;
    const identifiers = ['label', 'reference', 'url', 'description'];
    if (!identifiers.some((key) => typeof target[key] === 'string' && target[key])) {
      push(FINDING_CODES.TARGET_IDENTITY_INVALID, path, 'targetIdentity requires an exact authored label, reference, URL, or description.');
      valid = false;
    }
    for (const key of ['label', 'role', 'scope', 'reference', 'url', 'description']) {
      const value = target[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') {
        push(FINDING_CODES.TARGET_IDENTITY_INVALID, `${path}.${key}`, `targetIdentity.${key} must be a string when supplied.`);
        valid = false;
        continue;
      }
      validateSemanticString(value, `${path}.${key}`);
      if (IMPERATIVE_TARGET_RE.test(value)) {
        push(FINDING_CODES.TARGET_IDENTITY_IMPERATIVE, `${path}.${key}`, 'Target identity names a control/scope; it must not issue an action.', value);
        valid = false;
      }
      if (PROSE_TARGET_RE.test(value) || /[.!?]\s*$/.test(value)) {
        push(FINDING_CODES.TARGET_IDENTITY_PROSE, `${path}.${key}`, 'Target identity contains value/assertion prose.', value);
        valid = false;
      }
    }
    if (typeof target.role === 'string' && target.role && !ROLE_RE.test(target.role)) {
      push(FINDING_CODES.TARGET_IDENTITY_INVALID, `${path}.role`, 'Role must be one normalized role token.', target.role);
      valid = false;
    }
    return valid;
  };

  const rejectLegacyTarget = (record, path) => {
    for (const key of ['target', 'element', 'field', 'locatorHint', 'locator_hint', 'action', 'selection']) {
      if (record && record[key] !== undefined) push(FINDING_CODES.LEGACY_TARGET_FORBIDDEN, `${path}.${key}`, `${key} is not canonical here; use type/targetIdentity/selectionCriteria.`);
    }
  };

  const validateDataRefs = (record, path) => {
    if (!Array.isArray(record.dataRefs)) {
      push(FINDING_CODES.DATA_REFS_INVALID, `${path}.dataRefs`, 'dataRefs must be an explicit array.');
      return [];
    }
    const seen = new Set();
    record.dataRefs.forEach((ref, index) => {
      if (typeof ref !== 'string' || !DATA_REF_RE.test(ref)) push(FINDING_CODES.DATA_REFS_INVALID, `${path}.dataRefs[${index}]`, 'dataRef has invalid syntax.', ref);
      if (seen.has(ref)) push(FINDING_CODES.DATA_REFS_INVALID, `${path}.dataRefs[${index}]`, 'Duplicate dataRef.', ref);
      seen.add(ref);
    });
    return record.dataRefs;
  };

  const validateScalarDate = (type, value, path) => {
    if (type === 'Date' || type === 'AssertDate') {
      if (!isCanonicalDate(value)) push(FINDING_CODES.DATE_NOT_CANONICAL, path, 'Date literal must be YYYY-MM-DD.', value);
    } else if (type === 'Time' || type === 'AssertTime') {
      if (!isCanonicalTime(value)) push(FINDING_CODES.TIME_NOT_CANONICAL, path, 'Time literal must be 24-hour HH:mm or HH:mm:ss.', value);
    } else if (type === 'DateTime' || type === 'AssertDateTime') {
      if (!isCanonicalDateTime(value)) push(FINDING_CODES.DATETIME_NOT_CANONICAL, path, 'DateTime literal must be timezone-qualified ISO-8601.', value);
    }
  };

  const validateSelection = (criteria, path, sourceQuote = '') => {
    if (!isObject(criteria) || !VALID_SELECTION_KINDS.includes(criteria.kind)) {
      push(FINDING_CODES.SELECTION_INVALID, path, 'Select requires supported typed selectionCriteria.');
      return;
    }
    const fieldForKind = {
      exact_text: 'text', exact_value: 'value', ordinal: 'ordinal', predicate: 'predicate', data_ref: 'ref', reference: 'ref',
    }[criteria.kind];
    const criterion = criteria[fieldForKind];
    if (criteria.kind === 'ordinal') {
      if (!Number.isInteger(criterion) || criterion < 1) push(FINDING_CODES.SELECTION_INVALID, `${path}.ordinal`, 'Ordinal must be a positive 1-based integer.');
    } else if (typeof criterion !== 'string' || !criterion) {
      push(FINDING_CODES.SELECTION_INVALID, `${path}.${fieldForKind}`, `${criteria.kind} requires exact ${fieldForKind}.`);
    }
    if (['data_ref', 'reference'].includes(criteria.kind) && !isValueRef(criterion)) push(FINDING_CODES.SELECTION_INVALID, `${path}.ref`, 'Selection reference must use an approved ref scheme.', criterion);
    validateSemanticString(criterion, `${path}.${fieldForKind}`);
    validateSemanticString(criteria.expectedText, `${path}.expectedText`);
    const linkedLiteral = criteria.kind === 'ordinal' ? criteria.expectedText : criterion;
    if (!['data_ref', 'reference'].includes(criteria.kind) && typeof linkedLiteral === 'string'
      && linkedLiteral && !String(sourceQuote).includes(linkedLiteral)) push(FINDING_CODES.VALUE_NOT_SOURCE_LINKED, path, 'Exact selection literal must occur in step.sourceQuote.', linkedLiteral);
  };

  const validateCondition = (condition, path) => {
    if (!isObject(condition) || typeof condition.kind !== 'string' || !condition.kind
      || typeof condition.comparator !== 'string' || !condition.comparator
      || !Array.isArray(condition.operands) || !condition.operands.length) {
      push(FINDING_CODES.CONDITION_INVALID, path, 'Condition requires explicit kind, comparator, and operands.');
      return;
    }
    if (condition.sourceQuote !== undefined || condition.sourceSpan !== undefined) validateEvidence(condition, path);
  };

  const steps = Array.isArray(normalized.steps) ? normalized.steps : [];
  const assertions = Array.isArray(normalized.assertions) ? normalized.assertions : [];
  const operationCounts = semanticOperationCounts(normalized);
  if (!steps.length) push(FINDING_CODES.STEPS_MISSING, '$.steps', 'At least one semantic step is required.');
  if (operationCounts.actual > limit) push(
    FINDING_CODES.STEP_LIMIT_EXCEEDED,
    '$.steps',
    'Semantic operation count exceeds explicit semantic budget.',
    { maxSteps: limit, ...operationCounts },
  );
  validateOrdinals(steps, '$.steps');
  const stepById = new Map();
  const stepFingerprints = new Map();
  steps.forEach((step, index) => {
    const path = `$.steps[${index}]`;
    if (!isObject(step)) {
      push(FINDING_CODES.STEP_TYPE_UNSUPPORTED, path, 'Step must be an object.');
      return;
    }
    const id = registerId(step, path, 'Step');
    if (id && !stepById.has(id)) stepById.set(id, { step, index });
    linkRecord(step, path, 'step', id);
    rejectLegacyTarget(step, path);
    if (!VALID_STEP_TYPES.includes(step.type)) push(FINDING_CODES.STEP_TYPE_UNSUPPORTED, `${path}.type`, 'Unsupported universal step type.', step.type);
    if (typeof step.text !== 'string' || !step.text) push(FINDING_CODES.STEP_TEXT_MISSING, `${path}.text`, 'Source-faithful display text is required.');
    else {
      ACTION_VERB_RE.lastIndex = 0;
      ASSERTION_VERB_RE.lastIndex = 0;
      const actionCount = [...step.text.matchAll(ACTION_VERB_RE)].length;
      const assertionCount = [...step.text.matchAll(ASSERTION_VERB_RE)].length;
      if (actionCount > 1 || assertionCount > 0) push(FINDING_CODES.STEP_NOT_ATOMIC, `${path}.text`, 'One step may contain one browser action and no assertion instruction.', { actionCount, assertionCount });
    }
    if (!TARGET_OPTIONAL_TYPES.has(step.type)) validateTarget(step.targetIdentity, `${path}.targetIdentity`);
    else if (step.targetIdentity !== undefined) validateTarget(step.targetIdentity, `${path}.targetIdentity`, false);
    const dataRefs = validateDataRefs(step, path);
    if (!VALID_FLOW_IMPACTS.includes(step.flowImpact)) push(FINDING_CODES.FLOW_IMPACT_INVALID, `${path}.flowImpact`, 'flowImpact must be explicit and supported.', step.flowImpact);
    if (!FAILURE_SET.has(step.failureBehavior)) push(FINDING_CODES.FAILURE_BEHAVIOR_INVALID, `${path}.failureBehavior`, 'failureBehavior must be explicit and supported.', step.failureBehavior);

    const hasValue = Object.prototype.hasOwnProperty.call(step, 'value');
    const hasValueRef = Object.prototype.hasOwnProperty.call(step, 'valueRef') && step.valueRef !== null && step.valueRef !== '';
    if (hasValue && hasValueRef) push(FINDING_CODES.VALUE_AUTHORITY_AMBIGUOUS, path, 'Use exactly one of scalar value or valueRef.');
    if (hasValue && !isExactScalar(step.value)) push(FINDING_CODES.VALUE_REQUIRED, `${path}.value`, 'value must be an exact executable scalar.');
    if (hasValueRef) {
      if (!isValueRef(step.valueRef)) push(FINDING_CODES.VALUE_REF_INVALID, `${path}.valueRef`, 'valueRef must use an approved compiler-owned scheme.', step.valueRef);
      const normalizedRef = String(step.valueRef).replace(/^[^:]+:/, '').replace(/^data\./, '');
      const dataScheme = String(step.valueRef).startsWith('data:');
      if (!dataRefs.length || (dataScheme && !dataRefs.some((ref) => ref.replace(/^data\./, '') === normalizedRef))) push(FINDING_CODES.VALUE_REF_INVALID, `${path}.dataRefs`, 'valueRef requires a matching dataRefs entry.', { valueRef: step.valueRef, dataRefs });
    }
    if (VALUE_STEP_TYPES.has(step.type) && !hasValue && !hasValueRef) push(FINDING_CODES.VALUE_REQUIRED, path, `${step.type} requires value or valueRef.`);
    if (hasValue && typeof step.value === 'string' && !isSourceLinkedStepValue(step.type, step.value, step.sourceQuote)) push(FINDING_CODES.VALUE_NOT_SOURCE_LINKED, `${path}.value`, 'Executable value must be exactly or canonically represented in step.sourceQuote.', step.value);
    if (hasValue) validateSemanticString(step.value, `${path}.value`);
    if (hasValue && ['Date', 'Time', 'DateTime'].includes(step.type)) validateScalarDate(step.type, step.value, `${path}.value`);
    if (step.type === 'Upload' && hasValue) push(FINDING_CODES.SENSITIVE_LITERAL, `${path}.value`, 'Upload path must use valueRef, not a literal filesystem value.');
    if (step.type === 'Select') validateSelection(step.selectionCriteria, `${path}.selectionCriteria`, step.sourceQuote);
    else if (step.selectionCriteria !== undefined) push(FINDING_CODES.VALUE_UNEXPECTED, `${path}.selectionCriteria`, 'selectionCriteria is only valid for Select.');
    if (step.type === 'Select' && (hasValue || hasValueRef)) push(FINDING_CODES.VALUE_UNEXPECTED, path, 'Select uses selectionCriteria, not value/valueRef.');
    if (step.condition !== undefined && step.condition !== null) validateCondition(step.condition, `${path}.condition`);
    if (isObject(step.targetIdentity) && SENSITIVE_RE.test(`${step.targetIdentity.label || ''} ${step.targetIdentity.scope || ''}`) && hasValue) push(FINDING_CODES.SENSITIVE_LITERAL, `${path}.value`, 'Sensitive controls require valueRef, never literal value.');

    const semantic = fingerprint({
      type: step.type, targetIdentity: targetFingerprint(step.targetIdentity), value: step.value,
      valueRef: step.valueRef, selectionCriteria: step.selectionCriteria,
      condition: step.condition, sourceQuote: step.sourceQuote, sourceSpan: step.sourceSpan,
      sourceClauseRefs: step.sourceClauseRefs,
    });
    if (stepFingerprints.has(semantic)) push(FINDING_CODES.DUPLICATE_STEP, path, 'Duplicate semantic step linked to the same source.', stepFingerprints.get(semantic));
    else stepFingerprints.set(semantic, path);
  });

  const graph = new Map();
  steps.forEach((step, index) => {
    if (!isObject(step)) return;
    const path = `$.steps[${index}].dependsOn`;
    if (!Array.isArray(step.dependsOn)) {
      push(FINDING_CODES.DEPENDENCIES_INVALID, path, 'dependsOn must be an explicit array.');
      return;
    }
    const seen = new Set();
    step.dependsOn.forEach((dependencyId, dependencyIndex) => {
      if (seen.has(dependencyId)) push(FINDING_CODES.DEPENDENCY_DUPLICATE, `${path}[${dependencyIndex}]`, 'Duplicate dependency.', dependencyId);
      seen.add(dependencyId);
      const dependency = stepById.get(dependencyId);
      if (!dependency) push(FINDING_CODES.DEPENDENCY_MISSING, `${path}[${dependencyIndex}]`, 'Dependency step is missing.', dependencyId);
      else if (dependency.index >= index) push(FINDING_CODES.DEPENDENCY_FORWARD, `${path}[${dependencyIndex}]`, 'Dependency must point to an earlier step.', dependencyId);
    });
    if (step.id) graph.set(step.id, step.dependsOn.filter((id) => stepById.has(id)));
  });
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail = []) => {
    if (visiting.has(id)) {
      push(FINDING_CODES.DEPENDENCY_CYCLE, '$.steps', 'Dependency graph contains a cycle.', [...trail, id]);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);

  const channelForType = {
    AssertText: 'text', AssertRegex: 'text', AssertUrl: 'url', AssertPage: 'url',
    AssertNumber: 'number', AssertCurrency: 'number', AssertCount: 'number',
    AssertCollection: 'collection', AssertTemporal: 'temporal', AssertDate: 'temporal',
    AssertTime: 'temporal', AssertDateTime: 'temporal',
  };
  if (!assertions.length) push(FINDING_CODES.ASSERTIONS_MISSING, '$.assertions', 'At least one typed assertion is required.');
  validateOrdinals(assertions, '$.assertions');
  const assertionFingerprints = new Map();
  assertions.forEach((assertion, index) => {
    const path = `$.assertions[${index}]`;
    if (!isObject(assertion)) {
      push(FINDING_CODES.ASSERTION_TYPE_UNSUPPORTED, path, 'Assertion must be an object.');
      return;
    }
    const id = registerId(assertion, path, 'Assertion');
    linkRecord(assertion, path, 'assertion', id);
    rejectLegacyTarget(assertion, path);
    if (!VALID_ASSERTION_TYPES.includes(assertion.type)) push(FINDING_CODES.ASSERTION_TYPE_UNSUPPORTED, `${path}.type`, 'Unsupported universal assertion type.', assertion.type);
    if (typeof assertion.text !== 'string' || !assertion.text) push(FINDING_CODES.ASSERTION_TEXT_MISSING, `${path}.text`, 'Source-faithful assertion display text is required.');
    validateTarget(assertion.targetIdentity, `${path}.targetIdentity`);
    validateDataRefs(assertion, path);
    if (!VALID_ASSERTION_COMPARATORS.includes(assertion.comparator)) push(FINDING_CODES.ASSERTION_COMPARATOR_INVALID, `${path}.comparator`, 'Unsupported assertion comparator.', assertion.comparator);
    const allowedComparators = ASSERTION_TYPE_COMPARATORS[assertion.type] || [];
    if (VALID_ASSERTION_TYPES.includes(assertion.type) && !allowedComparators.includes(assertion.comparator)) push(FINDING_CODES.ASSERTION_COMPARATOR_INVALID, `${path}.comparator`, 'Comparator is incompatible with assertion type.', { type: assertion.type, comparator: assertion.comparator, allowed: allowedComparators });
    if (assertion.type === 'AssertTemporal' && !TEMPORAL_SET.has(assertion.comparator)) push(FINDING_CODES.TEMPORAL_COMPARATOR_INVALID, `${path}.comparator`, 'AssertTemporal requires a temporal comparator.', assertion.comparator);
    if (assertion.type === 'AssertCollection' && !COLLECTION_SET.has(assertion.comparator) && !/^count_/.test(assertion.comparator || '')) push(FINDING_CODES.ASSERTION_COMPARATOR_INVALID, `${path}.comparator`, 'AssertCollection requires a collection/count comparator.', assertion.comparator);
    if (!FAILURE_SET.has(assertion.failureBehavior)) push(FINDING_CODES.FAILURE_BEHAVIOR_INVALID, `${path}.failureBehavior`, 'Assertion failureBehavior must be explicit.', assertion.failureBehavior);
    if (typeof assertion.required !== 'boolean') push(FINDING_CODES.ASSERTION_REQUIRED_INVALID, `${path}.required`, 'required must be boolean.');
    if (assertion.stepId !== undefined && assertion.stepId !== null && !stepById.has(assertion.stepId)) push(FINDING_CODES.ASSERTION_STEP_INVALID, `${path}.stepId`, 'stepId must reference an existing step.', assertion.stepId);

    const payload = assertion.payload;
    let actual = null;
    let expected = null;
    if (!isObject(payload)) {
      push(FINDING_CODES.ASSERTION_PAYLOAD_INVALID, `${path}.payload`, 'payload requires typed channel and operands.');
    } else {
      if (!VALID_ASSERTION_CHANNELS.includes(payload.channel)) push(FINDING_CODES.ASSERTION_CHANNEL_INVALID, `${path}.payload.channel`, 'Unsupported assertion channel.', payload.channel);
      const expectedChannel = channelForType[assertion.type] || 'state';
      if (payload.channel !== expectedChannel) push(FINDING_CODES.ASSERTION_CHANNEL_INVALID, `${path}.payload.channel`, 'Assertion type and payload channel disagree.', { expected: expectedChannel, actual: payload.channel });
      const operands = Array.isArray(payload.operands) ? payload.operands : [];
      if (operands.length !== 2 || !isObject(operands[0]) || operands[0].role !== 'actual'
        || !isObject(operands[1]) || operands[1].role !== 'expected') {
        push(FINDING_CODES.ASSERTION_OPERANDS_INVALID, `${path}.payload.operands`, 'Exactly two ordered operands are required: actual, then expected.');
      }
      [actual, expected] = operands;
      operands.forEach((operand, operandIndex) => {
        const operandPath = `${path}.payload.operands[${operandIndex}]`;
        if (!isObject(operand) || !VALID_OPERAND_KINDS.includes(operand.kind)) push(FINDING_CODES.ASSERTION_OPERANDS_INVALID, `${operandPath}.kind`, 'Unsupported operand kind.', operand && operand.kind);
        if (isObject(operand)) {
          validateSemanticString(operand.name, `${operandPath}.name`);
          validateSemanticString(operand.value, `${operandPath}.value`);
          if (operand.role === 'expected' && typeof operand.value === 'string' && ASSERTION_INSTRUCTION_RE.test(operand.value)) push(FINDING_CODES.ASSERTION_EXPECTED_INSTRUCTION, `${operandPath}.value`, 'Expected value must not begin with Verify/Assert/Validate/Confirm/Expect.', operand.value);
        }
      });
      if (actual && !actual.ref && !actual.property && !Object.prototype.hasOwnProperty.call(actual, 'value')) push(FINDING_CODES.ASSERTION_OPERANDS_INVALID, `${path}.payload.operands[0]`, 'Actual operand needs ref, property, or value.');
      if (expected && !expected.ref && !Array.isArray(expected.items) && !Object.prototype.hasOwnProperty.call(expected, 'value')) push(FINDING_CODES.ASSERTION_OPERANDS_INVALID, `${path}.payload.operands[1]`, 'Expected operand needs ref, items, or value.');
    }

    if (COLLECTION_SET.has(assertion.comparator)) {
      if (!expected || expected.kind !== 'collection' || !Array.isArray(expected.items) || !expected.items.length) push(FINDING_CODES.COLLECTION_EXPECTED_ARRAY, `${path}.payload.operands[1].items`, 'Collection comparator requires a non-empty expected items array.');
      else expected.items.forEach((item, itemIndex) => {
        if (!isExactScalar(item)) push(FINDING_CODES.COLLECTION_EXPECTED_ARRAY, `${path}.payload.operands[1].items[${itemIndex}]`, 'Collection item must be an exact scalar.');
        validateSemanticString(item, `${path}.payload.operands[1].items[${itemIndex}]`);
        if (typeof item === 'string' && ASSERTION_INSTRUCTION_RE.test(item)) push(FINDING_CODES.ASSERTION_EXPECTED_INSTRUCTION, `${path}.payload.operands[1].items[${itemIndex}]`, 'Collection expected item must not be assertion prose.');
      });
    }
    if (TEMPORAL_SET.has(assertion.comparator)) {
      const temporalKinds = new Set(['temporal', 'temporal_reference', 'reference', 'literal', 'duration']);
      if (!actual || !expected || !temporalKinds.has(actual.kind) || !temporalKinds.has(expected.kind)) push(FINDING_CODES.TEMPORAL_OPERANDS_INVALID, `${path}.payload.operands`, 'Temporal comparator requires typed actual/expected temporal operands.');
      else {
        if (typeof actual.name !== 'string' || !actual.name || typeof expected.name !== 'string' || !expected.name || actual.name === expected.name) push(FINDING_CODES.TEMPORAL_OPERANDS_INVALID, `${path}.payload.operands`, 'Temporal operands require distinct stable names.');
        for (const [operand, operandIndex] of [[actual, 0], [expected, 1]]) {
          const operandPath = `${path}.payload.operands[${operandIndex}]`;
          if (operand.kind === 'duration') {
            if (typeof operand.value !== 'number' || !Number.isFinite(operand.value) || typeof operand.unit !== 'string' || !operand.unit) push(FINDING_CODES.TEMPORAL_OPERANDS_INVALID, operandPath, 'Duration operand requires numeric value and unit.');
          } else if (['temporal_reference', 'reference'].includes(operand.kind)) {
            if (typeof operand.ref !== 'string' || !operand.ref) push(FINDING_CODES.TEMPORAL_OPERANDS_INVALID, `${operandPath}.ref`, 'Temporal reference operand requires ref.');
          } else if (!VALID_TEMPORAL_TYPES.includes(operand.temporalType)) {
            push(FINDING_CODES.TEMPORAL_OPERANDS_INVALID, `${operandPath}.temporalType`, 'Literal temporal operand requires explicit date/time/datetime temporalType.');
          } else if (!Object.prototype.hasOwnProperty.call(operand, 'value')) {
            push(FINDING_CODES.TEMPORAL_OPERANDS_INVALID, `${operandPath}.value`, 'Literal temporal operand requires value.');
          } else {
            validateScalarDate(`Assert${operand.temporalType === 'datetime' ? 'DateTime' : operand.temporalType[0].toUpperCase() + operand.temporalType.slice(1)}`, operand.value, `${operandPath}.value`);
          }
        }
      }
    }
    if (assertion.type === 'AssertDate' || assertion.type === 'AssertTime' || assertion.type === 'AssertDateTime') {
      if (expected && Object.prototype.hasOwnProperty.call(expected, 'value')) {
        validateScalarDate(assertion.type, expected.value, `${path}.payload.operands[1].value`);
        const stepType = assertion.type.slice('Assert'.length);
        if (typeof expected.value === 'string' && !isSourceLinkedStepValue(stepType, expected.value, assertion.sourceQuote)) {
          push(FINDING_CODES.VALUE_NOT_SOURCE_LINKED, `${path}.payload.operands[1].value`, 'Temporal expected value must be exactly or unambiguously represented in assertion.sourceQuote.', expected.value);
        }
      }
    }
    if (['AssertVisible', 'AssertEnabled', 'AssertChecked'].includes(assertion.type)
      && (!expected || expected.kind !== 'boolean' || expected.value !== true)) push(FINDING_CODES.ASSERTION_OPERANDS_INVALID, `${path}.payload.operands[1]`, `${assertion.type} requires expected boolean true.`);
    if (['AssertHidden', 'AssertDisabled'].includes(assertion.type)
      && (!expected || expected.kind !== 'boolean' || expected.value !== false)) push(FINDING_CODES.ASSERTION_OPERANDS_INVALID, `${path}.payload.operands[1]`, `${assertion.type} requires expected boolean false.`);
    if (['AssertNumber', 'AssertCurrency', 'AssertCount'].includes(assertion.type)
      && (!expected || !['number', 'count', 'reference'].includes(expected.kind)
        || (expected.kind !== 'reference' && (typeof expected.value !== 'number' || !Number.isFinite(expected.value))))) push(FINDING_CODES.ASSERTION_OPERANDS_INVALID, `${path}.payload.operands[1]`, `${assertion.type} requires a finite numeric/count expected operand or reference.`);
    if (assertion.type === 'AssertCollection' && /^count_/.test(assertion.comparator || '')
      && (!expected || expected.kind !== 'count' || typeof expected.value !== 'number' || !Number.isFinite(expected.value) || expected.value < 0)) push(FINDING_CODES.ASSERTION_OPERANDS_INVALID, `${path}.payload.operands[1]`, 'Collection count comparator requires a non-negative numeric count operand.');
    if (assertion.type === 'AssertVisible' && (assertion.comparator !== 'visible' || actual && actual.property !== 'visible')) push(FINDING_CODES.VISIBILITY_ENABLEMENT_CONFLATED, path, 'AssertVisible must use visible comparator/property only.');
    if (assertion.type === 'AssertHidden' && (assertion.comparator !== 'hidden' || actual && actual.property !== 'visible')) push(FINDING_CODES.VISIBILITY_ENABLEMENT_CONFLATED, path, 'AssertHidden must use hidden comparator and visible property.');
    if (assertion.type === 'AssertEnabled' && (assertion.comparator !== 'enabled' || actual && actual.property !== 'enabled')) push(FINDING_CODES.VISIBILITY_ENABLEMENT_CONFLATED, path, 'AssertEnabled must use enabled comparator/property only.');
    if (assertion.type === 'AssertDisabled' && (assertion.comparator !== 'disabled' || actual && actual.property !== 'enabled')) push(FINDING_CODES.VISIBILITY_ENABLEMENT_CONFLATED, path, 'AssertDisabled must use disabled comparator and enabled property.');
    if (assertion.type === 'AssertHidden' && isObject(assertion.targetIdentity) && HIDDEN_DOUBLE_NEGATIVE_RE.test(assertion.targetIdentity.label || '')) push(FINDING_CODES.HIDDEN_TARGET_DOUBLE_NEGATIVE, `${path}.targetIdentity.label`, 'Hidden target must name a positive UI entity, not encode a second negation.');
    if (isObject(assertion.targetIdentity) && SENSITIVE_RE.test(`${assertion.targetIdentity.label || ''} ${assertion.targetIdentity.scope || ''}`)
      && expected && Object.prototype.hasOwnProperty.call(expected, 'value') && !expected.ref) push(FINDING_CODES.SENSITIVE_LITERAL, `${path}.payload.operands[1]`, 'Sensitive expected values require a reference operand.');

    const semantic = fingerprint({
      type: assertion.type, targetIdentity: targetFingerprint(assertion.targetIdentity),
      comparator: assertion.comparator, payload: assertion.payload,
      sourceQuote: assertion.sourceQuote, sourceSpan: assertion.sourceSpan,
      sourceClauseRefs: assertion.sourceClauseRefs,
    });
    if (assertionFingerprints.has(semantic)) push(FINDING_CODES.DUPLICATE_ASSERTION, path, 'Duplicate semantic assertion linked to the same source.', assertionFingerprints.get(semantic));
    else assertionFingerprints.set(semantic, path);
  });

  const linkMetadata = (record, path, id) => {
    if (!isObject(record)) return false;
    const refs = record.sourceClauseRefs;
    if (!Array.isArray(refs) || !refs.length) {
      push(FINDING_CODES.SOURCE_REFS_MISSING, `${path}.sourceClauseRefs`, `${path} must be source-linked.`);
      return false;
    }
    const seen = new Set();
    refs.forEach((ref, index) => {
      if (seen.has(ref)) push(FINDING_CODES.SOURCE_REF_DUPLICATE, `${path}.sourceClauseRefs[${index}]`, 'Duplicate source ref.', ref);
      seen.add(ref);
      if (!clauseById.has(ref)) push(FINDING_CODES.SOURCE_REF_UNKNOWN, `${path}.sourceClauseRefs[${index}]`, 'Unknown source ref.', ref);
      else clauseLinks.get(ref).push({ category: 'metadata', entityId: id, path });
    });
    return true;
  };

  const session = normalized.sessionRequirement;
  if (!isObject(session) || !VALID_SESSION_MODES.includes(session.mode)) push(FINDING_CODES.SESSION_REQUIREMENT_INVALID, '$.sessionRequirement', 'Explicit supported session mode is required.');
  else {
    linkMetadata(session, '$.sessionRequirement', 'sessionRequirement');
    const dependencies = Array.isArray(session.dependsOnCaseRefs) ? session.dependsOnCaseRefs : [];
    if (['continue_from_case', 'continue_from_dependency'].includes(session.mode)
      && !session.predecessorCaseId && !dependencies.length) push(FINDING_CODES.SESSION_REQUIREMENT_INVALID, '$.sessionRequirement', 'Continuation requires predecessorCaseId or dependsOnCaseRefs.');
    if (session.mode === 'fresh' && (session.predecessorCaseId || dependencies.length)) push(FINDING_CODES.SESSION_REQUIREMENT_INVALID, '$.sessionRequirement', 'fresh session cannot name a predecessor.');
  }
  const policy = normalized.failurePolicy;
  if (!isObject(policy) || !FAILURE_SET.has(policy.default)) push(FINDING_CODES.FAILURE_POLICY_INVALID, '$.failurePolicy', 'Explicit supported failurePolicy.default is required.');
  else {
    linkMetadata(policy, '$.failurePolicy', 'failurePolicy');
    for (const key of ['onAssertionFailure', 'onActionFailure']) if (policy[key] !== undefined && !FAILURE_SET.has(policy[key])) push(FINDING_CODES.FAILURE_POLICY_INVALID, `$.failurePolicy.${key}`, 'Unsupported failure policy.', policy[key]);
  }

  for (const stateKey of ['initialState', 'expectedFinalState']) {
    const state = normalized[stateKey];
    if (state === undefined || state === null) continue;
    const path = `$.${stateKey}`;
    if (!isObject(state) || !Object.prototype.hasOwnProperty.call(state, 'description')) push(FINDING_CODES.METADATA_INVALID, path, `${stateKey} must be a structured description.`);
    else linkMetadata(state, path, stateKey);
  }

  const metadata = Array.isArray(normalized.metadata) ? normalized.metadata : [];
  validateOrdinals(metadata, '$.metadata');
  metadata.forEach((entry, index) => {
    const path = `$.metadata[${index}]`;
    if (!isObject(entry)) {
      push(FINDING_CODES.METADATA_INVALID, path, 'Metadata must be an object.');
      return;
    }
    const id = registerId(entry, path, 'Metadata');
    linkRecord(entry, path, 'metadata', id);
    if (typeof entry.key !== 'string' || !entry.key || entry.value === undefined) push(FINDING_CODES.METADATA_INVALID, path, 'Metadata requires key and value.');
    if (SENSITIVE_RE.test(entry.key || '') && !isValueRef(entry.value)) push(FINDING_CODES.SENSITIVE_LITERAL, `${path}.value`, 'Sensitive metadata requires valueRef syntax.');
  });

  const dataBindings = Array.isArray(normalized.dataBindings) ? normalized.dataBindings : [];
  validateOrdinals(dataBindings, '$.dataBindings');
  dataBindings.forEach((binding, index) => {
    const path = `$.dataBindings[${index}]`;
    if (!isObject(binding)) {
      push(FINDING_CODES.DATA_BINDING_INVALID, path, 'Data binding must be an object.');
      return;
    }
    const id = registerId(binding, path, 'Data binding');
    linkRecord(binding, path, 'data', id);
    if (!['normal', 'sensitive'].includes(binding.classification)) push(FINDING_CODES.DATA_BINDING_INVALID, `${path}.classification`, 'classification must be normal or sensitive.');
    if (binding.classification === 'sensitive' && !isValueRef(binding.valueRef)) push(FINDING_CODES.SENSITIVE_LITERAL, `${path}.valueRef`, 'Sensitive binding requires approved valueRef.');
    if (binding.classification === 'sensitive' && binding.value !== undefined) push(FINDING_CODES.SENSITIVE_LITERAL, `${path}.value`, 'Sensitive binding cannot retain a literal.');
  });

  const clarifications = Array.isArray(normalized.clarifications) ? normalized.clarifications : [];
  validateOrdinals(clarifications, '$.clarifications');
  clarifications.forEach((clarification, index) => {
    const path = `$.clarifications[${index}]`;
    if (!isObject(clarification)) {
      push(FINDING_CODES.CLARIFICATION_INVALID, path, 'Clarification must be an object.');
      return;
    }
    const id = registerId(clarification, path, 'Clarification');
    linkRecord(clarification, path, 'clarification', id);
    if (typeof clarification.question !== 'string' || !clarification.question
      || typeof clarification.reason !== 'string' || !clarification.reason
      || clarification.blocking !== true || !Array.isArray(clarification.options)) push(FINDING_CODES.CLARIFICATION_INVALID, path, 'Clarification requires question, reason, blocking=true, and options array.');
    push(FINDING_CODES.CLARIFICATION_REQUIRED, path, 'Unresolved ambiguity blocks freezing/execution.', id);
  });

  for (const [clauseId, links] of clauseLinks.entries()) {
    const clause = clauseById.get(clauseId);
    const index = clauses.indexOf(clause);
    const path = `$.sourceClauses[${index}]`;
    if (!links.length) {
      push(FINDING_CODES.SOURCE_CLAUSE_OMITTED, path, 'Source clause is not represented by semantics or clarification.', clauseId);
      continue;
    }
    const categories = new Set(links.map((link) => link.category));
    const expectedCategory = clause.disposition === 'action' || clause.disposition === 'condition' ? 'step' : clause.disposition;
    if (clause.disposition === 'mixed') {
      if (categories.size < 2) push(FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, `${path}.disposition`, 'mixed requires at least two semantic categories.', [...categories]);
    } else if (VALID_SOURCE_DISPOSITIONS.includes(clause.disposition) && !categories.has(expectedCategory)) {
      push(FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, `${path}.disposition`, 'Disposition disagrees with linked semantics.', { disposition: clause.disposition, categories: [...categories] });
    }
    if (clause.disposition === 'clarification' && [...categories].some((category) => category !== 'clarification')) push(FINDING_CODES.SOURCE_DISPOSITION_MISMATCH, `${path}.disposition`, 'Clarification source cannot authorize executable semantics.', [...categories]);
  }

  return { ok: findings.length === 0, contract: normalized, normalized, findings };
}

function assertSemanticCaseContract(contract, options) {
  const result = validateSemanticCaseContract(contract, options);
  if (!result.ok) throw new SemanticCaseContractValidationError('Model-authored CaseContractV1 failed semantic validation.', result.findings, result.contract);
  return result.contract;
}

module.exports = {
  CONTRACT_VERSION,
  ERROR_CODE,
  DEFAULT_MAX_STEPS,
  VALID_STEP_TYPES,
  VALID_ASSERTION_TYPES,
  VALID_TARGET_KINDS,
  VALID_SELECTION_KINDS,
  VALID_FAILURE_BEHAVIORS,
  VALID_SESSION_MODES,
  VALID_FLOW_IMPACTS,
  VALID_SOURCE_DISPOSITIONS,
  VALID_ASSERTION_CHANNELS,
  VALID_OPERAND_KINDS,
  VALID_ASSERTION_COMPARATORS,
  COLLECTION_COMPARATORS,
  TEMPORAL_COMPARATORS,
  ASSERTION_TYPE_COMPARATORS,
  FINDING_CODES,
  SemanticCaseContractValidationError,
  normalizeSemanticCaseContract,
  validateSemanticCaseContractEnvelope,
  validateSemanticCaseContract,
  assertSemanticCaseContract,
  isValueRef,
  isCanonicalDate,
  isCanonicalTime,
  isCanonicalDateTime,
  isSourceLinkedStepValue,
  uniqueAuthoredCanonicalValue,
  _private: {
    occurrences,
    normalizeSourceEvidence,
    normalizeTargetIdentity,
    uncoveredRanges,
  },
};
