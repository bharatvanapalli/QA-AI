'use strict';

const crypto = require('node:crypto');
const semanticValidator = require('./caseContractSemanticValidator');
const { SOURCE_LEDGER_VERSION, SOURCE_DISPOSITIONS } = require('./addScenarioSourceLedger');

const PLAN_VERSION = 'AddScenarioSemanticPlanV1';
const CONTRACT_VERSION = semanticValidator.CONTRACT_VERSION || 'CaseContractV1';
const VALUE_STEP_TYPES = new Set(['Fill', 'Type', 'Date', 'Time', 'DateTime', 'Upload', 'PressKey']);
const ACTION_VERB_PATTERN = 'navigate|go\\s+to|visit|open|click|double[- ]?click|press|tap|fill|enter|input|type|clear|select|choose|pick|check|uncheck|hover|scroll|expand|collapse|submit|upload|download|drag|switch|close|capture';
const ASSERTION_VERB_PATTERN = 'verify|assert|validate|confirm|expect';
const COMPOSITE_TYPED_ACTIONS = new Set(['Select', 'Date', 'Expand', 'Collapse']);
const TEMPORAL_OPERAND_FIELDS = new Set(['role', 'kind', 'name', 'ref', 'temporalType', 'value']);
const SOURCE_DISPOSITION_SET = new Set(SOURCE_DISPOSITIONS);
const EXECUTABLE_SOURCE_DISPOSITIONS = new Set(['action', 'assertion', 'condition']);

class AddScenarioSemanticProjectionError extends Error {
  constructor(message, findings = []) {
    super(message);
    this.name = 'AddScenarioSemanticProjectionError';
    this.code = 'ADD_SCENARIO_SEMANTIC_PROJECTION_INVALID';
    this.status = 422;
    this.findings = Array.isArray(findings) ? findings : [];
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function slug(value, fallback) {
  const result = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return result || fallback;
}

function shortDigest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 10);
}

function stableId(prefix, label, index) {
  return `${prefix}.${slug(label, `item-${index + 1}`)}-${shortDigest(`${label}|${index}`)}`;
}

function finding(path, code, detail, evidence = undefined) {
  return { path, code, severity: 'error', detail, ...(evidence === undefined ? {} : { evidence }) };
}

function hasOwn(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function enumToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

function canonicalMember(value, allowed = []) {
  const token = enumToken(value);
  if (!token) return '';
  return allowed.find((candidate) => enumToken(candidate) === token) || '';
}

function exactOccurrences(sourceText, value) {
  const matches = [];
  if (!sourceText || !value) return matches;
  let cursor = 0;
  while (cursor <= sourceText.length - value.length) {
    const start = sourceText.indexOf(value, cursor);
    if (start < 0) break;
    matches.push({ start, end: start + value.length });
    cursor = start + Math.max(1, value.length);
  }
  return matches;
}

function trimSpan(sourceText, start, end) {
  let left = start;
  let right = end;
  while (left < right && /\s/.test(sourceText[left])) left += 1;
  while (right > left && /\s/.test(sourceText[right - 1])) right -= 1;
  return left < right ? { start: left, end: right } : null;
}

function sourceSentenceSpans(sourceText) {
  const spans = [];
  let start = 0;
  const push = (end) => {
    const span = trimSpan(sourceText, start, end);
    if (span) spans.push(span);
    start = end;
  };
  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '\r' || char === '\n') {
      push(index);
      if (char === '\r' && sourceText[index + 1] === '\n') index += 1;
      start = index + 1;
      continue;
    }
    if (/[.!?;]/.test(char) && (index + 1 === sourceText.length || /\s/.test(sourceText[index + 1]))) {
      push(index + 1);
      while (start < sourceText.length && /\s/.test(sourceText[start])) start += 1;
    }
  }
  const finalSpan = trimSpan(sourceText, start, sourceText.length);
  if (finalSpan) spans.push(finalSpan);
  return spans;
}

function evidenceLedgerKey(recordKind, text) {
  return `${recordKind || 'record'}:${text}`;
}

function createEvidenceLedger(actions, assertions) {
  const expected = new Map();
  const add = (recordKind, record) => {
    const anchors = [clean(record && record.sourceQuote), clean(record && record.text)]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);
    for (const anchor of anchors) {
      const key = evidenceLedgerKey(recordKind, anchor);
      expected.set(key, (expected.get(key) || 0) + 1);
    }
  };
  for (const action of actions) add('action', action);
  for (const assertion of assertions) add('assertion', assertion);
  return { expected, next: new Map() };
}

function sourceEvidence(sourceText, quote, path, findings, options = {}) {
  const exact = typeof quote === 'string' ? quote : '';
  const requiredValues = (Array.isArray(options.requiredValues) ? options.requiredValues : [])
    .filter((entry) => isObject(entry) && ['string', 'number', 'boolean'].includes(typeof entry.value))
    .map((entry) => ({ type: clean(entry.type) || 'literal', value: String(entry.value) }))
    .filter((entry, index, values) => entry.value && values.findIndex((candidate) => (
      candidate.type === entry.type && candidate.value === entry.value
    )) === index);
  const reviewedFallback = () => {
    if (options.reviewedInterpretation !== true || !sourceText) return null;
    const allValuesAuthored = requiredValues.every((entry) => (
      semanticValidator.isSourceLinkedStepValue(entry.type, entry.value, sourceText)
    ));
    if (!allValuesAuthored) return null;
    return {
      sourceQuote: sourceText,
      sourceSpan: { start: 0, end: sourceText.length },
    };
  };
  const anchors = [exact, ...(Array.isArray(options.fallbackQuotes) ? options.fallbackQuotes : [])]
    .filter((value) => typeof value === 'string' && value)
    .filter((value, index, values) => values.indexOf(value) === index);
  const candidates = new Map();
  const targetText = clean(options.targetIdentity && (
    options.targetIdentity.label || options.targetIdentity.description
      || options.targetIdentity.reference || options.targetIdentity.url
  ));
  const normalizedTarget = enumToken(targetText);
  const addCandidate = (span) => {
    if (!span) return;
    const text = sourceText.slice(span.start, span.end);
    if (!requiredValues.every((entry) => semanticValidator.isSourceLinkedStepValue(entry.type, entry.value, text))) return;
    const normalizedText = enumToken(text);
    candidates.set(`${span.start}:${span.end}`, {
      ...span,
      text,
      targetMatched: Boolean(normalizedTarget && normalizedText.includes(normalizedTarget)),
    });
  };

  for (const anchor of anchors) {
    for (const occurrence of exactOccurrences(sourceText, anchor)) {
      addCandidate(occurrence);
      for (const span of sourceSentenceSpans(sourceText)) {
        if (span.start <= occurrence.start && span.end >= occurrence.end) addCandidate(span);
      }
    }
  }

  if (requiredValues.length) {
    for (const span of sourceSentenceSpans(sourceText)) addCandidate(span);
  }

  let available = [...candidates.values()];
  if (normalizedTarget && available.some((candidate) => candidate.targetMatched)) {
    available = available.filter((candidate) => candidate.targetMatched);
  }
  const ordered = available.sort((left, right) => (
    (left.end - left.start) - (right.end - right.start) || left.start - right.start
  ));
  if (ordered.length) {
    const uniqueAnchors = anchors
      .map((anchor) => ordered.filter((candidate) => candidate.text === anchor))
      .filter((anchored) => anchored.length === 1)
      .map((anchored) => anchored[0])
      .sort((left, right) => (left.end - left.start) - (right.end - right.start));
    if (uniqueAnchors.length) {
      const selected = uniqueAnchors[0];
      return { sourceQuote: selected.text, sourceSpan: { start: selected.start, end: selected.end } };
    }
    const shortestLength = ordered[0].end - ordered[0].start;
    const shortest = ordered.filter((candidate) => candidate.end - candidate.start === shortestLength);
    if (shortest.length === 1) {
      const selected = shortest[0];
      return { sourceQuote: selected.text, sourceSpan: { start: selected.start, end: selected.end } };
    }
    if (new Set(shortest.map((candidate) => candidate.text)).size === 1 && options.occurrenceLedger) {
      const key = evidenceLedgerKey(options.recordKind, shortest[0].text);
      const expected = options.occurrenceLedger.expected.get(key);
      if (expected === shortest.length) {
        const next = options.occurrenceLedger.next.get(key) || 0;
        const selected = shortest[Math.min(next, shortest.length - 1)];
        options.occurrenceLedger.next.set(key, next + 1);
        return { sourceQuote: selected.text, sourceSpan: { start: selected.start, end: selected.end } };
      }
      const reviewedEvidence = reviewedFallback();
      if (reviewedEvidence) return reviewedEvidence;
      findings.push(finding(path, 'semantic_plan_source_cardinality_mismatch', 'Repeated authored evidence does not have the same number of semantic records.', {
        recordKind: options.recordKind || 'record',
        recordCount: expected || 0,
        occurrenceCount: shortest.length,
      }));
      return { sourceQuote: exact, sourceSpan: { start: null, end: null } };
    }
    const reviewedEvidence = reviewedFallback();
    if (reviewedEvidence) return reviewedEvidence;
    findings.push(finding(path, 'semantic_plan_source_quote_ambiguous', 'Exact source evidence is ambiguous in RAW_SOURCE.', shortest.map(({ start, end }) => ({ start, end }))));
    return { sourceQuote: exact, sourceSpan: { start: null, end: null } };
  }

  const reviewedEvidence = reviewedFallback();
  if (reviewedEvidence) return reviewedEvidence;

  if (!anchors.length) {
    findings.push(finding(path, 'semantic_plan_source_quote_missing', 'An exact non-empty sourceQuote is required.'));
  } else if (!anchors.some((anchor) => sourceText.includes(anchor))) {
    findings.push(finding(path, 'semantic_plan_source_quote_not_found', 'Neither sourceQuote nor display text is an exact substring of RAW_SOURCE.', exact));
  } else {
    findings.push(finding(path, 'semantic_plan_source_quote_literal_mismatch', 'No exact enclosing source clause contains every executable value in authored or canonical-equivalent form.', requiredValues));
  }
  return { sourceQuote: exact, sourceSpan: { start: null, end: null } };
}

function authoredEvidenceText(record, sourceText) {
  const candidates = [clean(record && record.sourceQuote), clean(record && record.text)]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .filter((value) => sourceText.includes(value));
  return candidates.sort((left, right) => right.length - left.length)[0] || '';
}

function authoredEvidenceCandidates(record, sourceText) {
  return [clean(record && record.sourceQuote), clean(record && record.text)]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .filter((value) => sourceText.includes(value));
}

function normalizeTarget(value, path, findings) {
  if (typeof value === 'string' && value.trim()) {
    return { kind: 'control', label: value.trim() };
  }
  if (!isObject(value)) {
    findings.push(finding(path, 'semantic_plan_target_missing', 'A typed target object is required.'));
    return null;
  }
  const target = clone(value);
  for (const key of ['kind', 'label', 'role', 'scope', 'controlType', 'reference', 'url', 'description']) {
    if (typeof target[key] === 'string') target[key] = target[key].trim();
  }
  const canonicalKind = canonicalMember(target.kind, semanticValidator.VALID_TARGET_KINDS || []);
  if (canonicalKind) target.kind = canonicalKind;
  else findings.push(finding(`${path}.kind`, 'semantic_plan_target_kind_invalid', 'Target kind must be one supported semantic target kind.', target.kind));
  const identities = ['label', 'reference', 'url', 'description'];
  if (!identities.some((key) => clean(target[key]))) {
    findings.push(finding(path, 'semantic_plan_target_underspecified', 'Target requires an exact label, reference, URL, or description.', target));
  }
  return target;
}

function defaultFlowImpact(type) {
  if (type === 'Navigate') return 'navigation';
  if (type === 'WaitForState') return 'wait';
  if (['Scroll', 'SwitchContext', 'Close'].includes(type)) return 'context_change';
  if (['Hover', 'Screenshot'].includes(type)) return 'observation';
  return 'state_change';
}

function normalizeStepType(value) {
  return canonicalMember(value, semanticValidator.VALID_STEP_TYPES || []) || clean(value);
}

function normalizeFlowImpact(value, type) {
  return canonicalMember(value, semanticValidator.VALID_FLOW_IMPACTS || []) || defaultFlowImpact(type);
}

function normalizeFailureBehavior(value, fallback) {
  return canonicalMember(value, semanticValidator.VALID_FAILURE_BEHAVIORS || []) || fallback;
}

function isExactScalar(value) {
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'boolean';
}

function normalizeSelectionCriteria(value, path, findings) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value) return { kind: 'exact_text', text: value };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'exact_value', value: String(value) };
  if (!isObject(value)) {
    findings.push(finding(path, 'semantic_plan_selection_invalid', 'Selection must be a typed object or an exact text scalar.', value));
    return null;
  }
  if (!Object.keys(value).length) return null;
  const criteria = clone(value);
  for (const key of ['kind', 'text', 'value', 'predicate', 'ref', 'expectedText', 'expectedLabel']) {
    if (typeof criteria[key] === 'string') criteria[key] = criteria[key].trim();
  }
  if (!clean(criteria.expectedText) && clean(criteria.expectedLabel)) criteria.expectedText = criteria.expectedLabel;
  delete criteria.expectedLabel;
  if (!clean(criteria.kind)) {
    if (clean(criteria.text)) criteria.kind = 'exact_text';
    else if (clean(criteria.value)) criteria.kind = 'exact_value';
    else if (Number.isInteger(criteria.ordinal)) criteria.kind = 'ordinal';
    else if (clean(criteria.predicate)) criteria.kind = 'predicate';
    else if (clean(criteria.ref)) criteria.kind = /^data(?::|\.)/.test(criteria.ref) ? 'data_ref' : 'reference';
  }
  const canonicalKind = canonicalMember(criteria.kind, semanticValidator.VALID_SELECTION_KINDS || []);
  if (canonicalKind) criteria.kind = canonicalKind;
  else findings.push(finding(`${path}.kind`, 'semantic_plan_selection_kind_invalid', 'Selection kind is unsupported.', criteria.kind));
  if (criteria.kind === 'exact_text' && !clean(criteria.text) && isExactScalar(criteria.value)) {
    criteria.text = String(criteria.value);
    delete criteria.value;
  } else if (criteria.kind === 'exact_value' && !clean(criteria.value) && clean(criteria.text)) {
    criteria.value = criteria.text;
    delete criteria.text;
  } else if (criteria.kind === 'ordinal' && typeof criteria.ordinal === 'string' && /^\d+$/.test(criteria.ordinal.trim())) {
    criteria.ordinal = Number(criteria.ordinal.trim());
  } else if (criteria.kind === 'predicate' && !clean(criteria.predicate)) {
    criteria.predicate = clean(criteria.text) || clean(criteria.value);
    delete criteria.text;
    delete criteria.value;
  } else if (['data_ref', 'reference'].includes(criteria.kind) && !clean(criteria.ref)) {
    criteria.ref = clean(criteria.value) || clean(criteria.text);
    delete criteria.text;
    delete criteria.value;
  }
  return criteria;
}

function selectionAuthority(criteria) {
  if (!isObject(criteria)) return null;
  if (criteria.kind === 'exact_text' && clean(criteria.text)) return { mode: 'literal', value: criteria.text };
  if (criteria.kind === 'exact_value' && isExactScalar(criteria.value)) return { mode: 'literal', value: String(criteria.value) };
  if (criteria.kind === 'predicate' && clean(criteria.predicate)) return { mode: 'predicate', value: criteria.predicate };
  if (criteria.kind === 'ordinal' && Number.isInteger(criteria.ordinal) && criteria.ordinal > 0) {
    return { mode: 'ordinal', value: criteria.expectedText || null };
  }
  if (['data_ref', 'reference'].includes(criteria.kind) && clean(criteria.ref)) return { mode: 'reference', value: criteria.ref };
  return null;
}

function normalizeCondition(value, sourceText, path, findings, options = {}) {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value === 'string' && clean(value)) {
    const predicate = clean(value);
    const evidence = sourceEvidence(
      sourceText,
      predicate,
      `${path}.sourceQuote`,
      findings,
      { reviewedInterpretation: options.reviewedInterpretation === true },
    );
    return {
      kind: 'authored_predicate',
      comparator: 'satisfied',
      operands: [{ kind: 'text', value: predicate }],
      ...evidence,
    };
  }
  if (!isObject(value)) {
    findings.push(finding(path, 'semantic_plan_condition_invalid', 'Condition must be authored text or a typed condition object.', value));
    return undefined;
  }
  if (!Object.keys(value).length) return undefined;
  const condition = clone(value);
  const authoredPredicate = clean(condition.text) || clean(condition.predicate) || clean(condition.description);
  condition.kind = clean(condition.kind) || 'authored_predicate';
  condition.comparator = clean(condition.comparator) || 'satisfied';
  if (!Array.isArray(condition.operands) || !condition.operands.length) {
    if (!authoredPredicate) {
      findings.push(finding(path, 'semantic_plan_condition_invalid', 'Condition must provide authored text or at least one typed operand.'));
      return undefined;
    }
    condition.operands = [{ kind: 'text', value: authoredPredicate }];
  }
  delete condition.text;
  delete condition.predicate;
  delete condition.description;
  if (condition.sourceQuote !== undefined || condition.sourceSpan !== undefined) {
    Object.assign(condition, sourceEvidence(
      sourceText,
      condition.sourceQuote,
      `${path}.sourceQuote`,
      findings,
    ));
  }
  return condition;
}

function operationCount(value, pattern) {
  return [...String(value || '').matchAll(new RegExp(`\\b(?:${pattern})\\b`, 'ig'))].length;
}

function typeVerbPattern(type) {
  return {
    Navigate: 'navigate|go\\s+to|visit', Click: 'open|click|tap', DoubleClick: 'double[- ]?click',
    Fill: 'fill|enter|input', Type: 'type', Clear: 'clear', Select: 'select|choose|pick',
    Check: 'check', Uncheck: 'uncheck', Radio: 'select|choose|check', Date: 'set|enter|select|choose',
    Time: 'set|enter|select|choose', DateTime: 'set|enter|select|choose', Upload: 'upload', Download: 'download',
    Hover: 'hover', Scroll: 'scroll', Expand: 'expand', Collapse: 'collapse', Submit: 'submit',
    WaitForState: 'wait', PressKey: 'press', DragAndDrop: 'drag', SwitchContext: 'switch', Close: 'close',
    Screenshot: 'capture',
  }[type] || ACTION_VERB_PATTERN;
}

function actionTargetLabel(target) {
  if (typeof target === 'string') return clean(target);
  return clean(target && (target.label || target.description || target.reference || target.url));
}

function actionSelectionLabel(selectionCriteria) {
  const authority = selectionAuthority(selectionCriteria);
  return authority && authority.value !== null ? String(authority.value) : '';
}

function canonicalActionText(type, target, semantics = {}) {
  const label = actionTargetLabel(target) || 'the authored target';
  const value = hasOwn(semantics, 'value') ? String(semantics.value) : clean(semantics.valueRef);
  const selection = actionSelectionLabel(semantics.selectionCriteria);
  const displays = {
    Navigate: `Navigate to ${label}`,
    Click: `Click ${label}`,
    DoubleClick: `Double-click ${label}`,
    Fill: `Fill ${label}${value ? ` with ${value}` : ''}`,
    Type: `Type${value ? ` ${value}` : ''} in ${label}`,
    Clear: `Clear ${label}`,
    Select: `Select ${selection || 'the authored option'} from ${label}`,
    Check: `Check ${label}`,
    Uncheck: `Uncheck ${label}`,
    Radio: `Select ${label}`,
    Date: `Select${value ? ` ${value}` : ' the authored date'} in ${label}`,
    Time: `Enter${value ? ` ${value}` : ' the authored time'} in ${label}`,
    DateTime: `Enter${value ? ` ${value}` : ' the authored date and time'} in ${label}`,
    Upload: `Upload${value ? ` ${value}` : ''} using ${label}`,
    Download: `Download ${label}`,
    Hover: `Hover over ${label}`,
    Scroll: `Scroll to ${label}`,
    Expand: `Expand ${label}`,
    Collapse: `Collapse ${label}`,
    Submit: `Submit ${label}`,
    WaitForState: `Wait for ${label}`,
    PressKey: `Press ${value || 'the authored key'} on ${label}`,
    DragAndDrop: `Drag ${label}`,
    SwitchContext: `Switch to ${label}`,
    Close: `Close ${label}`,
    Screenshot: `Capture ${label}`,
  };
  return displays[type] || `Use ${label}`;
}

function atomicActionText(action, type, path, findings, context = {}) {
  // Display text is compiler-owned. Provider text is useful only as a source-evidence
  // fallback upstream; it is never copied into the executable contract here.
  const display = clean(context.sourceQuote) || clean(action.sourceQuote);
  const compiled = canonicalActionText(type, context.target, context.semantics);
  if (context.reviewedInterpretation === true) return compiled;
  const actionCount = operationCount(display, ACTION_VERB_PATTERN);
  const assertionCount = operationCount(display, ASSERTION_VERB_PATTERN);
  if (!display) return compiled;
  if (actionCount <= 1 && assertionCount === 0) return display;

  const quote = clean(action.sourceQuote);
  const peerCount = (Array.isArray(context.actions) ? context.actions : [])
    .filter((candidate) => clean(candidate && candidate.sourceQuote) === quote).length;
  const assertionCovered = (Array.isArray(context.assertions) ? context.assertions : []).some((assertion) => {
    const assertionQuote = clean(assertion && assertion.sourceQuote);
    return assertionQuote && quote && (assertionQuote === quote || assertionQuote.includes(quote) || quote.includes(assertionQuote));
  });
  const composite = COMPOSITE_TYPED_ACTIONS.has(type);
  if (['Expand', 'Collapse'].includes(type)) {
    const allowed = type === 'Expand'
      ? /^(?:open|click|expand)$/i
      : /^(?:close|click|collapse)$/i;
    const verbs = [...display.matchAll(new RegExp(`\\b(${ACTION_VERB_PATTERN})\\b`, 'ig'))]
      .map((match) => match[1]);
    if (verbs.length && verbs.every((verb) => allowed.test(verb))
      && (assertionCount === 0 || assertionCovered)) {
      const label = clean(context.target && (
        context.target.label || context.target.description || context.target.reference
      ));
      return `${type} ${label || 'the authored target'}`;
    }
  }
  if ((!composite && actionCount > 1 && peerCount < actionCount) || (assertionCount > 0 && !assertionCovered)) {
    findings.push(finding(`${path}.text`, 'semantic_plan_action_not_atomic', 'Compound action text is not backed by separate typed action/assertion records.', { actionCount, assertionCount }));
    return compiled;
  }

  const boundary = new RegExp(`(?:[.!?;]\\s+|,\\s*(?:(?:and\\s+then|then|and)\\s+)?|\\s+(?:and\\s+then|then|and)\\s+)(?=(?:${ACTION_VERB_PATTERN}|${ASSERTION_VERB_PATTERN})\\b)`, 'i');
  const clauses = display.split(boundary).map((part) => part.trim()).filter(Boolean);
  const actionClauses = clauses.filter((clause) => (
    operationCount(clause, ACTION_VERB_PATTERN) > 0 && operationCount(clause, ASSERTION_VERB_PATTERN) === 0
  ));
  const matching = actionClauses.filter((clause) => operationCount(clause, typeVerbPattern(type)) > 0);
  if (matching.length === 1) return matching[0];
  if (composite) {
    findings.push(finding(`${path}.text`, 'semantic_plan_action_not_atomic', 'A composite typed action must contain exactly one primary semantic action clause.', clauses));
    return compiled;
  }
  if (actionClauses.length === 1) return actionClauses[0];
  findings.push(finding(`${path}.text`, 'semantic_plan_action_not_atomic', 'A unique atomic action clause could not be selected from the compound display text.', clauses));
  return compiled;
}

function actionSourceRequirements(action) {
  const requirements = [];
  if (isExactScalar(action.value)) requirements.push({ type: action.type, value: action.value });
  const authority = selectionAuthority(action.selectionCriteria);
  if (authority && ['literal', 'predicate', 'ordinal'].includes(authority.mode) && authority.value !== null) {
    requirements.push({ type: 'Select', value: authority.value });
  }
  return requirements;
}

function normalizeActionSemantics(action, sourceText, path, findings, options = {}) {
  const type = normalizeStepType(action.type);
  const dataRefs = Array.isArray(action.dataRefs) ? clone(action.dataRefs) : [];
  const hasRawSelection = hasOwn(action, 'selectionCriteria') || hasOwn(action, 'selection');
  let selectionCriteria = hasRawSelection
    ? normalizeSelectionCriteria(hasOwn(action, 'selectionCriteria') ? action.selectionCriteria : action.selection, `${path}.selection`, findings)
    : null;
  let hasValue = hasOwn(action, 'value') && isExactScalar(action.value);
  let value = hasValue ? clone(action.value) : undefined;
  let valueRef = hasOwn(action, 'valueRef') ? clean(action.valueRef) : '';
  let hasValueRef = Boolean(valueRef);
  const hasExpected = hasOwn(action, 'expected') && isExactScalar(action.expected);
  const expected = hasExpected ? clone(action.expected) : undefined;
  if (hasOwn(action, 'value') && !hasValue && action.value !== undefined && action.value !== null && action.value !== '') {
    findings.push(finding(`${path}.value`, 'semantic_plan_action_value_invalid', 'Action value must be an exact scalar.', action.value));
  }
  if (hasValue && hasValueRef) {
    findings.push(finding(path, 'semantic_plan_action_value_ambiguous', 'Use exactly one of value or valueRef.'));
  }
  if (hasOwn(action, 'expected') && !hasExpected && action.expected !== undefined && action.expected !== null && action.expected !== '') {
    findings.push(finding(`${path}.expected`, 'semantic_plan_action_expected_invalid', 'Action expected effect must be an exact scalar.', action.expected));
  }

  if (type === 'Select') {
    const authority = selectionAuthority(selectionCriteria);
    if (!authority) {
      findings.push(finding(`${path}.selection`, 'semantic_plan_selection_invalid', 'Select requires one complete typed selection criterion.'));
    }
    if (hasValue || hasValueRef) {
      findings.push(finding(path, 'semantic_plan_select_value_forbidden', 'Select meaning must come only from its typed selection; value/valueRef cannot be migrated or discarded.', {
        ...(hasValue ? { value } : {}),
        ...(hasValueRef ? { valueRef } : {}),
      }));
    }
  } else if (selectionCriteria) {
    findings.push(finding(`${path}.selection`, 'semantic_plan_selection_for_non_select', 'Only Select may own selection meaning; the projector will not retype the action or migrate the selection.', type));
  }

  const authoredSources = authoredEvidenceCandidates(action, sourceText);
  if (['Date', 'Time'].includes(type) && hasValue && typeof value === 'string') {
    const authoredValues = [...new Set(authoredSources
      .map((candidate) => semanticValidator.uniqueAuthoredCanonicalValue(type, candidate))
      .filter(Boolean))];
    const valueCanonical = semanticValidator.uniqueAuthoredCanonicalValue(type, value);
    if (valueCanonical && authoredValues.length === 1 && authoredValues[0] === valueCanonical) {
      value = valueCanonical;
    } else if (authoredValues.length !== 1 || !valueCanonical || authoredValues[0] !== valueCanonical) {
      findings.push(finding(`${path}.value`, 'semantic_plan_temporal_value_conflict', `${type} value must be canonically equivalent to the authored value; the projector will not replace it with a different value.`, {
        supplied: action.value,
        authored: authoredValues,
      }));
    }
  }

  if (VALUE_STEP_TYPES.has(type) && !hasValue && !hasValueRef) {
    findings.push(finding(path, 'semantic_plan_action_value_missing', `${type} requires an exact value or valueRef.`));
  }

  return {
    type,
    dataRefs,
    selectionCriteria,
    ...(hasValue ? { value } : {}),
    ...(hasValueRef ? { valueRef } : {}),
    ...(hasExpected ? { expected } : {}),
    condition: normalizeCondition(action.condition, sourceText, `${path}.condition`, findings, options),
  };
}

function normalizeAssertionType(value) {
  return canonicalMember(value, semanticValidator.VALID_ASSERTION_TYPES || []) || clean(value);
}

function canonicalAssertionComparator(assertion, type, expected, path, findings) {
  const allowed = (semanticValidator.ASSERTION_TYPE_COMPARATORS
    && semanticValidator.ASSERTION_TYPE_COMPARATORS[type]) || [];
  const authored = clean(assertion.comparator);
  const supplied = canonicalMember(assertion.comparator, semanticValidator.VALID_ASSERTION_COMPARATORS || []);
  if (!authored) {
    findings.push(finding(`${path}.comparator`, 'semantic_plan_assertion_relation_missing', 'A compiler-owned comparator is required; the projector will not infer one from prose.'));
    return authored;
  }
  if (!supplied) {
    findings.push(finding(`${path}.comparator`, 'semantic_plan_assertion_relation_invalid', 'The supplied comparator is unsupported and cannot be repaired.', assertion.comparator));
    return authored;
  }
  if (!allowed.includes(supplied)) {
    findings.push(finding(`${path}.comparator`, 'semantic_plan_assertion_relation_incompatible', 'The supplied comparator is incompatible with the assertion type and cannot be replaced.', {
      type,
      comparator: supplied,
    }));
    return supplied;
  }
  if (type === 'AssertCollection') {
    const countShape = typeof expected === 'number';
    const suppliedCount = /^count_/.test(supplied);
    if (suppliedCount !== countShape) {
      findings.push(finding(`${path}.expected`, 'semantic_plan_assertion_shape_conflict', 'Collection relation and expected value shape contradict each other; neither meaning will be rewritten.', { comparator: supplied, expected }));
    }
  }
  return supplied;
}

function normalizeTemporalExpected(assertion, type, sourceText, path, findings) {
  const expected = assertion.expected;
  if (!['AssertDate', 'AssertTime', 'AssertDateTime'].includes(type)) return clone(expected);
  const semanticType = type.slice('Assert'.length);
  const candidates = authoredEvidenceCandidates(assertion, sourceText);
  const canonicalValues = [...new Set(candidates
    .map((candidate) => semanticValidator.uniqueAuthoredCanonicalValue(semanticType, candidate))
    .filter(Boolean))];
  const suppliedCanonical = semanticValidator.uniqueAuthoredCanonicalValue(semanticType, String(expected));
  if (canonicalValues.length === 1 && suppliedCanonical === canonicalValues[0]) return suppliedCanonical;
  findings.push(finding(`${path}.expected`, 'semantic_plan_temporal_value_conflict', `${semanticType} expected value must be canonically equivalent to the authored value; the projector will not replace it.`, {
    supplied: expected,
    authored: canonicalValues,
  }));
  return expected;
}

function normalizeAssertionExpected(assertion, type, sourceText, path, findings) {
  const implicit = new Set(['AssertVisible', 'AssertHidden', 'AssertEnabled', 'AssertDisabled', 'AssertSelected', 'AssertChecked']);
  if (implicit.has(type)) {
    if (hasOwn(assertion, 'expected')) {
      findings.push(finding(`${path}.expected`, 'semantic_plan_assertion_expected_conflict', `${type} owns its expected state; a separate expected value cannot be discarded.`));
    }
    return undefined;
  }
  if (!hasOwn(assertion, 'expected')) {
    if (type !== 'AssertTemporal' && type !== 'AssertPopup') {
      findings.push(finding(`${path}.expected`, 'semantic_plan_assertion_expected_missing', `${type} requires exact expected meaning.`));
    }
    return undefined;
  }
  if (['AssertDate', 'AssertTime', 'AssertDateTime'].includes(type)) {
    return normalizeTemporalExpected(assertion, type, sourceText, path, findings);
  }
  if (Array.isArray(assertion.expected)) return clone(assertion.expected);
  if (isExactScalar(assertion.expected)) return clone(assertion.expected);
  if (isObject(assertion.expected) && clean(assertion.expected.ref)) {
    return { ref: clean(assertion.expected.ref), name: clean(assertion.expected.name) };
  }
  findings.push(finding(`${path}.expected`, 'semantic_plan_assertion_expected_invalid', 'Expected meaning must be an exact scalar, collection, or approved reference.', assertion.expected));
  return assertion.expected;
}

function normalizeTemporalOperand(input, requiredRole, sourceText, path, findings) {
  if (!isObject(input)) {
    findings.push(finding(path, 'semantic_plan_temporal_operand_invalid', 'Each compiler-owned temporal operand must be an object.'));
    return input;
  }
  const unknownFields = Object.keys(input).filter((key) => !TEMPORAL_OPERAND_FIELDS.has(key));
  if (unknownFields.length) {
    findings.push(finding(path, 'semantic_plan_temporal_operand_fields_forbidden', 'Temporal operand mechanics contain unsupported fields and will not be repaired.', unknownFields));
  }
  const operand = Object.fromEntries(Object.entries(input)
    .filter(([key]) => TEMPORAL_OPERAND_FIELDS.has(key))
    .map(([key, value]) => [key, clone(value)]));
  for (const key of ['role', 'kind', 'name', 'ref', 'temporalType']) {
    if (typeof operand[key] === 'string') operand[key] = operand[key].trim();
  }
  const role = canonicalMember(operand.role, ['actual', 'expected']);
  if (role) operand.role = role;
  if (role !== requiredRole) {
    findings.push(finding(`${path}.role`, 'semantic_plan_temporal_operand_role_invalid', `Operand at this array position must retain role ${requiredRole}.`, operand.role));
  }
  const kind = canonicalMember(operand.kind, semanticValidator.VALID_OPERAND_KINDS || []);
  if (kind) operand.kind = kind;
  else findings.push(finding(`${path}.kind`, 'semantic_plan_temporal_operand_kind_invalid', 'Temporal operand kind is unsupported.', operand.kind));
  if (kind === 'temporal') {
    const temporalType = canonicalMember(operand.temporalType, ['date', 'time', 'datetime']);
    if (temporalType) operand.temporalType = temporalType;
    else findings.push(finding(`${path}.temporalType`, 'semantic_plan_temporal_type_invalid', 'Temporal literal requires date, time, or datetime.', operand.temporalType));
  } else if (!clean(operand.name) || !clean(operand.ref) || !sourceText.includes(clean(operand.name))) {
    findings.push(finding(path, 'semantic_plan_temporal_reference_unlinked', 'Temporal reference must preserve an exact authored name and compiler-owned ref.', operand));
  }
  return operand;
}

function normalizeTemporalOperands(assertion, sourceText, path, findings) {
  const inputs = Array.isArray(assertion.operands) ? assertion.operands : [];
  if (inputs.length !== 2) {
    findings.push(finding(`${path}.operands`, 'semantic_plan_temporal_operands_required', 'AssertTemporal requires exactly two compiler-owned operands; the projector will not infer them from prose.'));
    return clone(inputs);
  }
  const operands = [
    normalizeTemporalOperand(inputs[0], 'actual', sourceText, `${path}.operands[0]`, findings),
    normalizeTemporalOperand(inputs[1], 'expected', sourceText, `${path}.operands[1]`, findings),
  ];
  if (isObject(operands[0]) && isObject(operands[1]) && clean(operands[0].name) === clean(operands[1].name)) {
    findings.push(finding(`${path}.operands`, 'semantic_plan_temporal_operands_not_distinct', 'Temporal operands must preserve distinct authored meanings.'));
  }
  return operands;
}

function assertionSourceRequirements(type, expected, operands) {
  if (type === 'AssertTemporal') return operands.map((operand) => ({
    type: operand.kind === 'temporal' ? ({ date: 'Date', time: 'Time', datetime: 'DateTime' }[operand.temporalType] || 'literal') : 'literal',
    value: operand.kind === 'temporal' ? operand.value : operand.name,
  }));
  if (Array.isArray(expected)) return expected.map((value) => ({ type: 'literal', value }));
  if (isExactScalar(expected)) {
    const semanticType = ['AssertDate', 'AssertTime', 'AssertDateTime'].includes(type) ? type.slice('Assert'.length) : 'literal';
    return [{ type: semanticType, value: expected }];
  }
  return [];
}

function compiledAssertionText(type, target, comparator, expected, operands) {
  const label = actionTargetLabel(target) || 'the authored target';
  if (type === 'AssertTemporal' && operands.length === 2) {
    return `Verify ${operands[0].name || 'the first authored value'} ${comparator} ${operands[1].name || 'the second authored value'}`;
  }
  const statePhrases = {
    visible: 'is visible', hidden: 'is hidden', enabled: 'is enabled', disabled: 'is disabled',
    selected: 'is selected', checked: 'is checked',
  };
  if (statePhrases[comparator]) return `Verify ${label} ${statePhrases[comparator]}`;
  const value = Array.isArray(expected) ? expected.join(', ') : (expected === undefined ? '' : String(expected));
  return `Verify ${label} ${comparator}${value ? ` ${value}` : ''}`;
}

function atomicAssertionText(assertion, semantics, path, findings, context = {}) {
  if (context.reviewedInterpretation === true) return compiledAssertionText(
    semantics.type, context.target, semantics.comparator, semantics.expected, semantics.operands,
  );
  const display = clean(context.sourceQuote) || clean(assertion.sourceQuote);
  if (operationCount(display, ACTION_VERB_PATTERN) === 0
    && operationCount(display, ASSERTION_VERB_PATTERN) <= 1) return display || compiledAssertionText(
    semantics.type, context.target, semantics.comparator, semantics.expected, semantics.operands,
  );
  const boundary = new RegExp(`(?:[.!?;]\\s+|,\\s*(?:(?:and\\s+then|then|and)\\s+)?|\\s+(?:and\\s+then|then|and)\\s+)(?=(?:${ACTION_VERB_PATTERN}|${ASSERTION_VERB_PATTERN})\\b)`, 'i');
  const clauses = display.split(boundary).map((part) => part.trim()).filter(Boolean);
  const assertionClauses = clauses.filter((clause) => operationCount(clause, ASSERTION_VERB_PATTERN) > 0);
  if (assertionClauses.length === 1) return assertionClauses[0];
  const quote = clean(assertion.sourceQuote);
  const peerCount = (Array.isArray(context.assertions) ? context.assertions : [])
    .filter((candidate) => clean(candidate && candidate.sourceQuote) === quote).length;
  if (assertionClauses.length > peerCount) {
    findings.push(finding(`${path}.text`, 'semantic_plan_assertion_not_atomic', 'Compound assertion evidence is not backed by separate semantic assertion records.', clauses));
  }
  return compiledAssertionText(semantics.type, context.target, semantics.comparator, semantics.expected, semantics.operands);
}

function assertionChannel(type) {
  if (['AssertUrl', 'AssertPage'].includes(type)) return 'url';
  if (['AssertNumber', 'AssertCurrency', 'AssertCount'].includes(type)) return 'number';
  if (type === 'AssertCollection') return 'collection';
  if (['AssertDate', 'AssertTime', 'AssertDateTime', 'AssertTemporal'].includes(type)) return 'temporal';
  if (['AssertText', 'AssertRegex'].includes(type)) return 'text';
  return 'state';
}

function actualProperty(type, comparator) {
  if (['AssertVisible', 'AssertHidden', 'AssertPopup'].includes(type)) return 'visible';
  if (['AssertEnabled', 'AssertDisabled'].includes(type)) return 'enabled';
  if (type === 'AssertChecked') return 'checked';
  if (type === 'AssertSelected') return 'selected';
  if (['AssertUrl', 'AssertPage'].includes(type)) return 'url';
  if (type === 'AssertCount') return 'count';
  if (type === 'AssertCollection') return /^count_/.test(comparator || '') ? 'count' : 'items';
  if (['AssertText', 'AssertRegex'].includes(type)) return 'text';
  return 'value';
}

function expectedOperand(type, comparator, expected) {
  if (['AssertVisible', 'AssertEnabled', 'AssertSelected', 'AssertChecked'].includes(type)
    || (type === 'AssertPopup' && comparator === 'visible')) {
    return { role: 'expected', kind: 'boolean', value: true };
  }
  if (['AssertHidden', 'AssertDisabled'].includes(type)) {
    return { role: 'expected', kind: 'boolean', value: false };
  }
  if (type === 'AssertCollection' && /^count_/.test(comparator || '')) return { role: 'expected', kind: 'count', value: expected };
  if (type === 'AssertCollection') return { role: 'expected', kind: 'collection', items: clone(expected) };
  if (isObject(expected) && clean(expected.ref)) return { role: 'expected', kind: 'reference', ref: clean(expected.ref), ...(clean(expected.name) ? { name: clean(expected.name) } : {}) };
  if (Array.isArray(expected)) return { role: 'expected', kind: 'collection', items: clone(expected) };
  if (typeof expected === 'number') {
    return { role: 'expected', kind: type === 'AssertCount' ? 'count' : 'number', value: expected };
  }
  if (typeof expected === 'boolean') return { role: 'expected', kind: 'boolean', value: expected };
  if (['AssertUrl', 'AssertPage'].includes(type)) return { role: 'expected', kind: 'url', value: expected };
  if (['AssertDate', 'AssertTime', 'AssertDateTime'].includes(type)) {
    const temporalType = type.replace(/^Assert/, '').toLowerCase();
    return { role: 'expected', kind: 'temporal', temporalType, value: expected };
  }
  return { role: 'expected', kind: 'text', value: expected };
}

function assertionPayload(type, comparator, expected, temporalOperands) {
  if (type === 'AssertTemporal') return { channel: 'temporal', operands: clone(temporalOperands) };
  return {
    channel: assertionChannel(type),
    operands: [
      { role: 'actual', kind: 'target_property', property: actualProperty(type, comparator) },
      expectedOperand(type, comparator, expected),
    ],
  };
}

function normalizeAffectedRecord(value, compactCases, path, findings) {
  if (!isObject(value)) {
    findings.push(finding(path, 'semantic_plan_clarification_affected_record_required', 'Clarification must identify one affected case/action/assertion by array position.'));
    return null;
  }
  const caseIndex = value.caseIndex;
  const kind = canonicalMember(value.kind, ['case', 'action', 'assertion']);
  if (!Number.isInteger(caseIndex) || caseIndex < 0 || caseIndex >= compactCases.length) {
    findings.push(finding(`${path}.caseIndex`, 'semantic_plan_clarification_case_index_invalid', 'caseIndex must be a valid zero-based cases array position.', caseIndex));
  }
  if (!kind) {
    findings.push(finding(`${path}.kind`, 'semantic_plan_clarification_record_kind_invalid', 'kind must be case, action, or assertion.', value.kind));
  }
  if (kind === 'case') {
    if (value.recordIndex !== undefined && value.recordIndex !== null) {
      findings.push(finding(`${path}.recordIndex`, 'semantic_plan_clarification_case_record_index_forbidden', 'Case-level clarification uses caseIndex only.'));
    }
    return { caseIndex, kind };
  }
  const recordIndex = value.recordIndex;
  const compactCase = Number.isInteger(caseIndex) ? compactCases[caseIndex] : null;
  const collection = compactCase && Array.isArray(compactCase[`${kind}s`])
    ? compactCase[`${kind}s`]
    : [];
  if (!Number.isInteger(recordIndex) || recordIndex < 0 || recordIndex >= collection.length) {
    findings.push(finding(`${path}.recordIndex`, 'semantic_plan_clarification_record_index_invalid', `recordIndex must be a valid zero-based ${kind} array position.`, recordIndex));
  }
  return { caseIndex, kind, recordIndex };
}

function affectedProjectedRecord(affectedRecord, projectedCases) {
  if (!isObject(affectedRecord) || !Number.isInteger(affectedRecord.caseIndex)) return null;
  const projectedCase = projectedCases[affectedRecord.caseIndex];
  if (!isObject(projectedCase)) return null;
  if (affectedRecord.kind === 'action') return projectedCase.steps && projectedCase.steps[affectedRecord.recordIndex];
  if (affectedRecord.kind === 'assertion') return projectedCase.assertions && projectedCase.assertions[affectedRecord.recordIndex];
  return projectedCase;
}

function projectClarifications(plan, compactCases, projectedCases, source, clauseId, findings) {
  if (plan.unresolvedQuestions !== undefined && !Array.isArray(plan.unresolvedQuestions)) {
    findings.push(finding('$.unresolvedQuestions', 'semantic_plan_unresolved_questions_invalid', 'unresolvedQuestions must be an array when supplied.'));
    return [];
  }
  const questions = Array.isArray(plan.unresolvedQuestions) ? plan.unresolvedQuestions : [];
  return questions.map((question, questionIndex) => {
    const path = `$.unresolvedQuestions[${questionIndex}]`;
    if (!isObject(question)) {
      findings.push(finding(path, 'semantic_plan_clarification_invalid', 'Each unresolved question must be an object.'));
      return question;
    }
    const questionText = clean(question.question);
    const reason = clean(question.reason);
    if (!questionText || !reason) {
      findings.push(finding(path, 'semantic_plan_clarification_detail_required', 'Clarification question and reason are required.'));
    }
    const affectedRecord = normalizeAffectedRecord(
      question.affectedRecord,
      compactCases,
      `${path}.affectedRecord`,
      findings,
    );
    const affected = affectedProjectedRecord(affectedRecord, projectedCases);
    const exactQuote = typeof question.sourceQuote === 'string' ? question.sourceQuote : '';
    const evidence = affected && affected.sourceQuote === exactQuote && isObject(affected.sourceSpan)
      ? { sourceQuote: affected.sourceQuote, sourceSpan: clone(affected.sourceSpan) }
      : sourceEvidence(source, exactQuote, `${path}.sourceQuote`, findings);
    return {
      id: stableId('clarification', questionText || exactQuote, questionIndex),
      ordinal: questionIndex + 1,
      question: questionText,
      reason,
      blocking: true,
      options: [],
      ...evidence,
      sourceClauseRefs: [clauseId],
      affectedRecord,
    };
  });
}

function semanticRecordAuthority(compactCases) {
  const byTransientRef = new Map();
  const byPosition = new Map();
  const descriptors = [];
  const add = (caseIndex, recordKind, recordIndex, record) => {
    const descriptor = { caseIndex, recordKind, recordIndex, record };
    descriptors.push(descriptor);
    byPosition.set(`${caseIndex}:${recordKind}:${recordIndex}`, descriptor);
    const transientRef = clean(record && record.key);
    if (!transientRef) return;
    if (!byTransientRef.has(transientRef)) byTransientRef.set(transientRef, []);
    byTransientRef.get(transientRef).push(descriptor);
  };
  compactCases.forEach((compactCase, caseIndex) => {
    const actions = Array.isArray(compactCase && compactCase.actions) ? compactCase.actions : [];
    const assertions = Array.isArray(compactCase && compactCase.assertions) ? compactCase.assertions : [];
    actions.forEach((record, recordIndex) => {
      add(caseIndex, 'action', recordIndex, record);
      if (record && record.condition !== undefined && record.condition !== null && record.condition !== false) {
        add(caseIndex, 'condition', recordIndex, record.condition);
      }
    });
    assertions.forEach((record, recordIndex) => add(caseIndex, 'assertion', recordIndex, record));
  });
  return { byTransientRef, byPosition, descriptors };
}

function structuredLinkPosition(claim, link) {
  const source = isObject(link) && Number.isInteger(link.caseIndex) ? link : claim;
  const caseIndex = Number(source && source.caseIndex);
  const recordIndex = Number(source && source.recordIndex);
  const recordKind = clean(source && (source.recordKind || source.kind)).toLowerCase();
  if (!Number.isInteger(caseIndex) || caseIndex < 0 || !Number.isInteger(recordIndex) || recordIndex < 0) return null;
  if (!EXECUTABLE_SOURCE_DISPOSITIONS.has(recordKind)) return null;
  return { caseIndex, recordKind, recordIndex };
}

function positionalRef(ref) {
  const match = /^(?:case[:/])?(\d+)[:/](action|assertion|condition)[:/](\d+)$/i.exec(clean(ref));
  if (!match) return null;
  return { caseIndex: Number(match[1]), recordKind: match[2].toLowerCase(), recordIndex: Number(match[3]) };
}

function resolveExecutableLink(claim, link, records, path, findings) {
  const expectedKind = clean(claim && claim.disposition).toLowerCase();
  const linkKind = clean(link && link.kind).toLowerCase();
  if (linkKind !== expectedKind) {
    findings.push(finding(`${path}.kind`, 'source_claim_link_kind_mismatch', 'Executable source claim link kind must exactly match its validated disposition.', { disposition: expectedKind, linkKind }));
    return null;
  }
  let descriptor = null;
  let position = structuredLinkPosition(claim, link) || positionalRef(link && link.ref);
  // Conditions are authored on their owning action record, while the compiler
  // tracks their source evidence as a separate condition descriptor at the
  // same case/record index. Resolve that ownership boundary deterministically
  // without allowing a condition claim to authorize the action itself.
  if (position && expectedKind === 'condition' && position.recordKind === 'action') {
    position = { ...position, recordKind: 'condition' };
  }
  if (position) descriptor = records.byPosition.get(`${position.caseIndex}:${position.recordKind}:${position.recordIndex}`) || null;
  if (!descriptor) {
    const candidates = records.byTransientRef.get(clean(link && link.ref)) || [];
    if (candidates.length === 1) [descriptor] = candidates;
    else if (candidates.length > 1) {
      findings.push(finding(`${path}.ref`, 'source_claim_transient_ref_ambiguous', 'Transient semantic record reference must identify exactly one record.', link.ref));
      return null;
    }
  }
  if (!descriptor) {
    findings.push(finding(`${path}.ref`, 'source_claim_record_unknown', 'Source claim link does not resolve to a semantic record.', link && link.ref));
    return null;
  }
  if (descriptor.recordKind !== expectedKind) {
    findings.push(finding(path, 'source_claim_record_kind_mismatch', 'Source claim disposition disagrees with the resolved semantic record kind.', { disposition: expectedKind, resolved: descriptor.recordKind }));
    return null;
  }
  return descriptor;
}

function validateCompletenessReport(report, ledger, findings) {
  const path = '$compiler.sourceCompleteness';
  if (!isObject(report)) {
    findings.push(finding(path, 'source_completeness_required', 'A compiler-owned source completeness report is required in ledger mode.'));
    return;
  }
  if (report.valid !== true || report.complete !== true || !Array.isArray(report.findings) || report.findings.length) {
    findings.push(finding(path, 'source_completeness_invalid', 'Source completeness must be valid, complete, and finding-free.', {
      valid: report.valid,
      complete: report.complete,
      findings: Array.isArray(report.findings) ? report.findings.map((entry) => entry && entry.code).filter(Boolean) : null,
    }));
  }
  const coverage = report.coverage;
  if (!isObject(coverage)
    || coverage.totalUnits !== ledger.units.length
    || coverage.claimedUnits !== ledger.units.length
    || !Array.isArray(coverage.omittedUnitRefs) || coverage.omittedUnitRefs.length
    || !Array.isArray(coverage.residualSpans) || coverage.residualSpans.length) {
    findings.push(finding(`${path}.coverage`, 'source_completeness_coverage_invalid', 'Completeness must prove every ledger unit and non-whitespace span is claimed exactly once.'));
  }
  for (const key of ['unlinkedExecutableUnitIds', 'unconsumedLiteralUnitIds', 'unresolvedUnitIds']) {
    if (!Array.isArray(report[key]) || report[key].length) {
      findings.push(finding(`${path}.${key}`, 'source_completeness_blocked', `${key} must be present and empty before projection.`, report[key]));
    }
  }
  if (!clean(report.claimsDigest)) findings.push(finding(`${path}.claimsDigest`, 'source_completeness_digest_missing', 'Completeness report requires its immutable claims digest.'));
}

function buildLedgerProjectionAuthority(source, compactCases, options, findings) {
  const supplied = ['sourceLedgerV1', 'sourceClaims', 'sourceCompleteness']
    .some((key) => options[key] !== undefined);
  if (!supplied) return null;
  const ledger = options.sourceLedgerV1;
  const claims = options.sourceClaims;
  const completeness = options.sourceCompleteness;
  if (!isObject(ledger) || ledger.version !== SOURCE_LEDGER_VERSION || !Array.isArray(ledger.units)) {
    findings.push(finding('$compiler.sourceLedgerV1', 'source_ledger_required', `Ledger mode requires a ${SOURCE_LEDGER_VERSION} object.`));
    return { invalid: true };
  }
  if (!Array.isArray(claims)) {
    findings.push(finding('$compiler.sourceClaims', 'source_claims_required', 'Ledger mode requires compiler-resolved sourceClaims.'));
    return { invalid: true };
  }
  validateCompletenessReport(completeness, ledger, findings);
  const unitById = new Map(ledger.units.map((unit) => [unit && unit.id, unit]));
  const records = semanticRecordAuthority(compactCases);
  const claimedUnits = new Set();
  const recordClaims = new Map();
  const claimRecords = new Map();
  const covered = new Uint16Array(source.length);
  const clauses = [];
  const metadataClaims = [];
  const dataClaims = [];

  claims.forEach((claim, claimIndex) => {
    const path = `$compiler.sourceClaims[${claimIndex}]`;
    if (!isObject(claim)) {
      findings.push(finding(path, 'source_claim_invalid', 'Each compiler source claim must be an object.'));
      return;
    }
    const unit = unitById.get(claim.unitRef);
    if (!unit) {
      findings.push(finding(`${path}.unitRef`, 'source_claim_unit_unknown', 'Source claim references an unknown ledger unit.', claim.unitRef));
      return;
    }
    const disposition = clean(claim.disposition).toLowerCase();
    if (!SOURCE_DISPOSITION_SET.has(disposition)) {
      findings.push(finding(`${path}.disposition`, 'source_claim_disposition_invalid', 'Source claim disposition is unsupported.', disposition));
      return;
    }
    const span = claim.sourceSpan;
    if (!isObject(span) || !Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < unit.sourceSpan.start || span.end > unit.sourceSpan.end || span.end <= span.start
      || source.slice(span.start, span.end) !== (claim.sourceQuote === undefined ? source.slice(span.start, span.end) : claim.sourceQuote)) {
      findings.push(finding(`${path}.sourceSpan`, 'source_claim_evidence_invalid', 'Claim span and quote must be exact evidence within its ledger unit.'));
      return;
    }
    let overlap = false;
    for (let offset = span.start; offset < span.end; offset += 1) {
      if (!/\S/.test(source[offset])) continue;
      if (covered[offset] > 0) overlap = true;
      covered[offset] += 1;
    }
    if (overlap) findings.push(finding(`${path}.sourceSpan`, 'source_claim_evidence_conflict', 'Source claims may not overlap non-whitespace evidence.'));
    claimedUnits.add(unit.id);
    const clause = {
      id: `source.clause.${shortDigest(`${unit.id}|${span.start}|${span.end}|${disposition}`)}`,
      ordinal: clauses.length + 1,
      kind: unit.kind,
      disposition,
      sourceQuote: source.slice(span.start, span.end),
      sourceSpan: { start: span.start, end: span.end },
    };
    clauses.push(clause);
    const links = Array.isArray(claim.links) ? claim.links : [];
    if (EXECUTABLE_SOURCE_DISPOSITIONS.has(disposition)) {
      if (!links.length) findings.push(finding(`${path}.links`, 'source_claim_executable_link_missing', 'Executable source claim requires one semantic record link.'));
      links.forEach((link, linkIndex) => {
        const descriptor = resolveExecutableLink(claim, link, records, `${path}.links[${linkIndex}]`, findings);
        if (!descriptor) return;
        const key = `${descriptor.caseIndex}:${descriptor.recordKind}:${descriptor.recordIndex}`;
        if (!recordClaims.has(key)) recordClaims.set(key, []);
        recordClaims.get(key).push(clause);
        if (!claimRecords.has(clause.id)) claimRecords.set(clause.id, []);
        claimRecords.get(clause.id).push(descriptor);
      });
    } else if (disposition === 'metadata') metadataClaims.push({ claim, clause, unit });
    else if (disposition === 'data') dataClaims.push({ claim, clause, unit });
    else if (disposition === 'unresolved') {
      findings.push(finding(path, 'source_claim_unresolved', 'Unresolved source evidence blocks projection and must remain in preview clarification state.'));
    }
  });

  ledger.units.forEach((unit, unitIndex) => {
    if (!claimedUnits.has(unit.id)) findings.push(finding(`$compiler.sourceLedgerV1.units[${unitIndex}]`, 'source_claim_unit_omitted', 'Every ledger unit requires at least one validated disposition claim.', unit.id));
    for (let offset = unit.sourceSpan.start; offset < unit.sourceSpan.end; offset += 1) {
      if (/\S/.test(source[offset]) && covered[offset] !== 1) {
        findings.push(finding(`$compiler.sourceLedgerV1.units[${unitIndex}]`, 'source_claim_unit_incomplete', 'Every non-whitespace unit character must be claimed exactly once.', unit.id));
        break;
      }
    }
  });
  records.descriptors.forEach((descriptor) => {
    const key = `${descriptor.caseIndex}:${descriptor.recordKind}:${descriptor.recordIndex}`;
    const linked = recordClaims.get(key) || [];
    if (!linked.length) findings.push(finding(`$compiler.records.${key}`, 'source_claim_executable_omitted', 'Every semantic action, assertion, and authored condition requires exact source evidence.'));
    if (linked.length > 1) findings.push(finding(`$compiler.records.${key}`, 'source_claim_record_conflict', 'One semantic record cannot be authorized by multiple source claims.', linked.map((entry) => entry.id)));
  });
  clauses.sort((left, right) => left.sourceSpan.start - right.sourceSpan.start || left.sourceSpan.end - right.sourceSpan.end);
  clauses.forEach((clause, index) => { clause.ordinal = index + 1; });
  return {
    clauses,
    recordClaims,
    claimRecords,
    metadataClaims,
    dataClaims,
    evidence(recordKind, caseIndex, recordIndex) {
      const linked = recordClaims.get(`${caseIndex}:${recordKind}:${recordIndex}`) || [];
      const clause = linked[0];
      return clause ? {
        sourceQuote: clause.sourceQuote,
        sourceSpan: clone(clause.sourceSpan),
        sourceClauseRefs: [clause.id],
      } : null;
    },
  };
}

function projectSemanticPlan(plan, options = {}) {
  const { sourceText = '' } = options;
  const source = typeof sourceText === 'string' ? sourceText : '';
  const findings = [];
  if (!isObject(plan) || plan.version !== PLAN_VERSION) {
    throw new AddScenarioSemanticProjectionError(`Compact semantic plan must use version ${PLAN_VERSION}.`, [
      finding('$.version', 'semantic_plan_version_invalid', `version must equal ${PLAN_VERSION}.`, plan && plan.version),
    ]);
  }
  const compactCases = Array.isArray(plan.cases) ? plan.cases : [];
  if (!compactCases.length) {
    throw new AddScenarioSemanticProjectionError('Compact semantic plan contains no executable cases.', [
      finding('$.cases', 'semantic_plan_cases_missing', 'At least one compact semantic case is required.'),
    ]);
  }

  const clauseId = 'source.clause.add-scenario';
  const wholeSourceEvidence = sourceEvidence(source, source, '$.sourceClauses[0].sourceQuote', findings);
  const ledgerAuthority = buildLedgerProjectionAuthority(source, compactCases, options, findings);
  if (ledgerAuthority && Array.isArray(plan.unresolvedQuestions) && plan.unresolvedQuestions.length) {
    findings.push(finding('$.unresolvedQuestions', 'source_completeness_plan_conflict', 'A complete source authority cannot accompany unresolved semantic questions.'));
  }
  const caseIds = compactCases.map((entry, index) => stableId('case', entry && (entry.key || entry.name || entry.intent), index));
  const caseKeyMap = new Map();
  compactCases.forEach((entry, index) => {
    const key = clean(entry && entry.key) || `case-${index + 1}`;
    caseKeyMap.set(key, caseIds[index]);
  });

  const projectedCases = compactCases.map((compactCase, caseIndex) => {
    const casePath = `$.cases[${caseIndex}]`;
    if (!isObject(compactCase)) {
      findings.push(finding(casePath, 'semantic_plan_case_invalid', 'Each compact case must be an object.'));
      return compactCase;
    }
    const caseId = caseIds[caseIndex];
    const actions = Array.isArray(compactCase.actions) ? compactCase.actions : [];
    const compactAssertions = Array.isArray(compactCase.assertions) ? compactCase.assertions : [];
    const evidenceLedger = createEvidenceLedger(actions, compactAssertions);
    if (!actions.length) findings.push(finding(`${casePath}.actions`, 'semantic_plan_actions_missing', 'Each case requires at least one atomic action.'));
    if (!compactAssertions.length) findings.push(finding(`${casePath}.assertions`, 'semantic_plan_assertions_missing', 'Each case requires at least one typed assertion.'));

    const actionIds = actions.map((action, index) => stableId(`${caseId}.step`, action && (action.key || action.text || action.type), index));
    const actionKeyMap = new Map();
    actions.forEach((action, index) => actionKeyMap.set(clean(action && action.key) || `step-${index + 1}`, actionIds[index]));

    const steps = actions.map((action, actionIndex) => {
      const path = `${casePath}.actions[${actionIndex}]`;
      if (!isObject(action)) {
        findings.push(finding(path, 'semantic_plan_action_invalid', 'Each action must be an object.'));
        return action;
      }
      const semantics = normalizeActionSemantics(action, source, path, findings, options);
      const type = semantics.type;
      const targetIdentity = normalizeTarget(action.targetIdentity || action.target, `${path}.target`, findings);
      const actionLedgerEvidence = ledgerAuthority && !ledgerAuthority.invalid
        ? ledgerAuthority.evidence('action', caseIndex, actionIndex)
        : null;
      const conditionLedgerEvidence = semantics.condition !== undefined && ledgerAuthority && !ledgerAuthority.invalid
        ? ledgerAuthority.evidence('condition', caseIndex, actionIndex)
        : null;
      let ledgerEvidence = actionLedgerEvidence;
      if (actionLedgerEvidence && conditionLedgerEvidence) {
        const combinedSpan = {
          start: Math.min(actionLedgerEvidence.sourceSpan.start, conditionLedgerEvidence.sourceSpan.start),
          end: Math.max(actionLedgerEvidence.sourceSpan.end, conditionLedgerEvidence.sourceSpan.end),
        };
        const authoredQuote = clean(action.sourceQuote);
        if (authoredQuote && source.slice(combinedSpan.start, combinedSpan.end) === authoredQuote) {
          ledgerEvidence = {
            sourceQuote: authoredQuote,
            sourceSpan: combinedSpan,
            sourceClauseRefs: [...new Set([
              ...actionLedgerEvidence.sourceClauseRefs,
              ...conditionLedgerEvidence.sourceClauseRefs,
            ])],
          };
        }
      }
      const evidence = ledgerEvidence || sourceEvidence(source, action.sourceQuote, `${path}.sourceQuote`, findings, {
        requiredValues: actionSourceRequirements(semantics),
        fallbackQuotes: [action.text],
        targetIdentity,
        occurrenceLedger: evidenceLedger,
        recordKind: 'action',
        reviewedInterpretation: options.reviewedInterpretation === true,
      });
      const step = {
        id: actionIds[actionIndex],
        ordinal: actionIndex + 1,
        type,
        text: atomicActionText(action, type, path, findings, {
          actions,
          assertions: compactAssertions,
          target: targetIdentity,
          sourceQuote: evidence.sourceQuote,
          semantics,
          reviewedInterpretation: options.reviewedInterpretation === true,
        }),
        ...evidence,
        sourceClauseRefs: ledgerEvidence ? clone(ledgerEvidence.sourceClauseRefs) : [clauseId],
        targetIdentity,
        dataRefs: semantics.dataRefs,
        dependsOn: (Array.isArray(action.dependsOn) ? action.dependsOn : []).map((key) => {
          const resolved = actionKeyMap.get(clean(key));
          if (!resolved) findings.push(finding(`${path}.dependsOn`, 'semantic_plan_dependency_unknown', `Unknown action dependency: ${String(key)}.`));
          return resolved || clean(key);
        }),
        flowImpact: normalizeFlowImpact(action.flowImpact, type),
        failureBehavior: normalizeFailureBehavior(
          action.failureBehavior,
          normalizeFailureBehavior(compactCase.failurePolicy && compactCase.failurePolicy.default, 'stop_descendants'),
        ),
      };
      for (const key of ['value', 'valueRef', 'expected']) if (hasOwn(semantics, key)) step[key] = clone(semantics[key]);
      for (const key of ['postcondition', 'waitContract']) if (hasOwn(action, key)) step[key] = clone(action[key]);
      if (semantics.selectionCriteria) step.selectionCriteria = clone(semantics.selectionCriteria);
      if (semantics.condition !== undefined) {
        const conditionEvidence = conditionLedgerEvidence;
        step.condition = {
          ...clone(semantics.condition),
          ...(conditionEvidence || {}),
        };
        if (conditionEvidence) {
          step.sourceClauseRefs = [...new Set([...step.sourceClauseRefs, ...conditionEvidence.sourceClauseRefs])];
        }
      }
      return step;
    });

    const assertions = compactAssertions.map((assertion, assertionIndex) => {
      const path = `${casePath}.assertions[${assertionIndex}]`;
      if (!isObject(assertion)) {
        findings.push(finding(path, 'semantic_plan_assertion_invalid', 'Each assertion must be an object.'));
        return assertion;
      }
      const type = normalizeAssertionType(assertion.type);
      const expected = normalizeAssertionExpected(assertion, type, source, path, findings);
      const comparator = canonicalAssertionComparator(assertion, type, expected, path, findings);
      const authoredAssertionSource = authoredEvidenceText(assertion, source);
      const temporalOperands = type === 'AssertTemporal'
        ? normalizeTemporalOperands(assertion, authoredAssertionSource, path, findings)
        : [];
      const targetIdentity = normalizeTarget(assertion.targetIdentity || assertion.target, `${path}.target`, findings);
      const ledgerEvidence = ledgerAuthority && !ledgerAuthority.invalid
        ? ledgerAuthority.evidence('assertion', caseIndex, assertionIndex)
        : null;
      const evidence = ledgerEvidence || sourceEvidence(source, assertion.sourceQuote, `${path}.sourceQuote`, findings, {
        requiredValues: assertionSourceRequirements(type, expected, temporalOperands),
        fallbackQuotes: [assertion.text],
        targetIdentity,
        occurrenceLedger: evidenceLedger,
        recordKind: 'assertion',
        reviewedInterpretation: options.reviewedInterpretation === true,
      });
      const stepKey = clean(assertion.stepRef || assertion.after);
      const stepId = stepKey ? actionKeyMap.get(stepKey) : null;
      if (stepKey && !stepId) findings.push(finding(`${path}.stepRef`, 'semantic_plan_assertion_step_unknown', `Unknown assertion stepRef: ${stepKey}.`));
      return {
        id: stableId(`${caseId}.assertion`, assertion.key || assertion.text || assertion.type, assertionIndex),
        ordinal: assertionIndex + 1,
        type,
        text: atomicAssertionText(assertion, {
          type, comparator, expected, operands: temporalOperands,
        }, path, findings, {
          sourceQuote: evidence.sourceQuote,
          target: targetIdentity,
          assertions: compactAssertions,
          reviewedInterpretation: options.reviewedInterpretation === true,
        }),
        ...evidence,
        sourceClauseRefs: ledgerEvidence ? clone(ledgerEvidence.sourceClauseRefs) : [clauseId],
        targetIdentity,
        comparator,
        payload: assertionPayload(type, comparator, expected, temporalOperands),
        dataRefs: Array.isArray(assertion.dataRefs) ? clone(assertion.dataRefs) : [],
        stepId,
        required: assertion.required !== false,
        failureBehavior: normalizeFailureBehavior(
          assertion.failureBehavior,
          normalizeFailureBehavior(compactCase.failurePolicy && compactCase.failurePolicy.onAssertionFailure, 'continue_independent'),
        ),
      };
    });

    const sessionInput = compactCase.sessionRequirement || compactCase.session || {};
    const failureInput = compactCase.failurePolicy || {};
    const sessionMode = clean(sessionInput.mode) || 'fresh';
    const predecessorKey = clean(sessionInput.predecessorCaseKey);
    const predecessorCaseId = clean(sessionInput.predecessorCaseId)
      || (predecessorKey ? caseKeyMap.get(predecessorKey) : null)
      || null;
    const dependencies = (Array.isArray(compactCase.dependencies) ? compactCase.dependencies : [])
      .map((key) => caseKeyMap.get(clean(key)) || clean(key));
    const sessionDependencies = (Array.isArray(sessionInput.dependsOnCaseRefs) ? sessionInput.dependsOnCaseRefs : dependencies)
      .map((key) => caseKeyMap.get(clean(key)) || clean(key));
    const ledgerClauseRefs = ledgerAuthority && !ledgerAuthority.invalid
      ? ledgerAuthority.clauses.map((clause) => clause.id)
      : null;
    const caseSourceRefs = ledgerClauseRefs || [clauseId];
    const caseEvidence = ledgerAuthority && !ledgerAuthority.invalid && ledgerAuthority.clauses[0]
      ? {
        sourceQuote: ledgerAuthority.clauses[0].sourceQuote,
        sourceSpan: clone(ledgerAuthority.clauses[0].sourceSpan),
      }
      : wholeSourceEvidence;
    const descriptionFor = (value) => {
      if (isObject(value)) return { ...clone(value), sourceClauseRefs: clone(caseSourceRefs) };
      return { description: value == null ? null : String(value), sourceClauseRefs: clone(caseSourceRefs) };
    };

    return {
      version: CONTRACT_VERSION,
      id: caseId,
      name: clean(compactCase.name) || `Authored scenario ${caseIndex + 1}`,
      intent: clean(compactCase.intent) || clean(compactCase.name) || `Execute authored scenario ${caseIndex + 1}.`,
      ...caseEvidence,
      sourceClauseRefs: clone(caseSourceRefs),
      behavioralPartition: clone(compactCase.behavioralPartition || { ordinal: caseIndex + 1, reason: 'semantic_plan' }),
      initialState: descriptionFor(compactCase.initialState),
      expectedFinalState: descriptionFor(compactCase.expectedFinalState),
      sessionRequirement: {
        mode: sessionMode,
        predecessorCaseId,
        dependsOnCaseRefs: sessionDependencies,
        sourceClauseRefs: clone(caseSourceRefs),
      },
      dependencies,
      failurePolicy: {
        default: normalizeFailureBehavior(failureInput.default, 'stop_descendants'),
        onAssertionFailure: normalizeFailureBehavior(failureInput.onAssertionFailure, 'continue_independent'),
        onActionFailure: normalizeFailureBehavior(failureInput.onActionFailure, 'stop_descendants'),
        sourceClauseRefs: clone(caseSourceRefs),
      },
      dataBindings: [],
      dataRows: Array.isArray(compactCase.dataRows) ? clone(compactCase.dataRows) : [],
      unusedDataRefs: Array.isArray(compactCase.unusedDataRefs) ? clone(compactCase.unusedDataRefs) : [],
      steps,
      assertions,
      metadata: [],
      clarifications: [],
    };
  });

  const nonBrowserRefIds = new Map();
  if (ledgerAuthority && !ledgerAuthority.invalid && projectedCases[0]) {
    const targetCase = projectedCases[0];
    ledgerAuthority.metadataClaims.forEach(({ clause, unit }, index) => {
      const id = stableId(`${targetCase.id}.metadata`, clause.id, index);
      targetCase.metadata.push({
        id,
        ordinal: targetCase.metadata.length + 1,
        key: `source.${unit.kind}.${unit.ordinal}`,
        value: clause.sourceQuote,
        sourceQuote: clause.sourceQuote,
        sourceSpan: clone(clause.sourceSpan),
        sourceClauseRefs: [clause.id],
      });
      nonBrowserRefIds.set(clause.id, id);
    });
    ledgerAuthority.dataClaims.forEach(({ clause, unit }, index) => {
      const id = stableId(`${targetCase.id}.data`, clause.id, index);
      const classification = unit.sensitive === true ? 'sensitive' : 'normal';
      targetCase.dataBindings.push({
        id,
        ordinal: targetCase.dataBindings.length + 1,
        name: `source.${unit.kind}.${unit.ordinal}`,
        classification,
        ...(classification === 'sensitive'
          ? { valueRef: `secret:source-ledger.${slug(unit.id, `unit-${unit.ordinal}`)}` }
          : { value: clause.sourceQuote }),
        sourceQuote: clause.sourceQuote,
        sourceSpan: clone(clause.sourceSpan),
        sourceClauseRefs: [clause.id],
      });
      nonBrowserRefIds.set(clause.id, id);
    });
  }

  const clarifications = projectClarifications(
    plan,
    compactCases,
    projectedCases,
    source,
    clauseId,
    findings,
  );

  if (findings.length && options.userApproved !== true) {
    throw new AddScenarioSemanticProjectionError('Compact semantic plan could not be projected safely.', findings);
  }

  const sourceCoverage = ledgerAuthority && !ledgerAuthority.invalid
    ? ledgerAuthority.clauses.map((clause) => {
      const descriptors = ledgerAuthority.claimRecords.get(clause.id) || [];
      const descriptor = descriptors[0];
      let refId = nonBrowserRefIds.get(clause.id) || null;
      if (descriptor) {
        const projectedCase = projectedCases[descriptor.caseIndex];
        if (descriptor.recordKind === 'assertion') refId = projectedCase && projectedCase.assertions[descriptor.recordIndex] && projectedCase.assertions[descriptor.recordIndex].id;
        else refId = projectedCase && projectedCase.steps[descriptor.recordIndex] && projectedCase.steps[descriptor.recordIndex].id;
      }
      return {
        sourceQuote: clause.sourceQuote,
        sourceSpan: clone(clause.sourceSpan),
        disposition: clause.disposition,
        refId,
        sourceClauseRef: clause.id,
      };
    })
    : projectedCases.flatMap((caseContract) => [
    ...caseContract.steps.map((step) => ({
      sourceQuote: step.sourceQuote,
      sourceSpan: clone(step.sourceSpan),
      disposition: 'action',
      refId: step.id,
    })),
    ...caseContract.assertions.map((assertion) => ({
      sourceQuote: assertion.sourceQuote,
      sourceSpan: clone(assertion.sourceSpan),
      disposition: 'assertion',
      refId: assertion.id,
    })),
  ]).concat(clarifications.map((clarification) => ({
    sourceQuote: clarification.sourceQuote,
    sourceSpan: clone(clarification.sourceSpan),
    disposition: 'clarification',
    refId: clarification.id,
  })));

  return {
    version: CONTRACT_VERSION,
    partitioning: {
      mode: compactCases.length === 1 ? 'single_behavior_topology' : 'explicit_behavioral_cases',
      explicitOneFlow: compactCases.length === 1,
      caseCount: projectedCases.length,
      dataRowsDoNotCreateCases: true,
    },
    dataDictionary: Array.isArray(plan.dataDictionary) ? clone(plan.dataDictionary) : [],
    dataRows: Array.isArray(plan.dataRows) ? clone(plan.dataRows) : [],
    sourceClauses: ledgerAuthority && !ledgerAuthority.invalid ? clone(ledgerAuthority.clauses) : [{
      id: clauseId,
      ordinal: 1,
      kind: 'mixed',
      disposition: 'mixed',
      ...wholeSourceEvidence,
    }],
    unusedDataRefs: Array.isArray(plan.unusedDataRefs) ? clone(plan.unusedDataRefs) : [],
    clarifications,
    sourceCoverage,
    cases: projectedCases,
    ...(options.userApproved === true && findings.length
      ? { approvalDiagnostics: clone(findings) }
      : {}),
  };
}

module.exports = {
  PLAN_VERSION,
  AddScenarioSemanticProjectionError,
  projectSemanticPlan,
  project: projectSemanticPlan,
};
