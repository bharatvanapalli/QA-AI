'use strict';

/**
 * Execution Journal compatibility layer.
 *
 * The database currently stores RunResult.stepResults as a JSON encoded array.
 * This module deliberately keeps that outer shape so existing readers can keep
 * consuming `index`, `status`, and `error`, while new readers gain independent
 * action, assertion, continuation, dependency, and evidence fields.
 *
 * Every public operation is immutable: the input journal is never changed.
 */

const JOURNAL_VERSION = 'execution_journal_v1';
const REDACTED = '[REDACTED]';
const { classifyActionFailureOwnership } = require('./executionOutcomeOwnership');
const {
  isPresenceConditionalAction,
  conditionalActionRequiredByContract,
} = require('./conditionalActionIntent');
const executionContinuationPolicy = require('./executionContinuationPolicy');

const ACTION_OUTCOMES = new Set(['succeeded', 'failed', 'not_executed']);
const ASSERTION_OUTCOMES = new Set(['matched', 'not_matched', 'uncheckable', 'not_applicable']);
const CONTINUATION_OUTCOMES = new Set(['continue', 'retry', 'stop_descendants', 'stop_case']);

const OPTIONAL_ABSENCE_TYPES = new Set([
  'optional_absent', 'optional_target_absent', 'optional_popup_absent', 'not_present_optional',
]);

const SENSITIVE_KEY_RE = /(?:^|[_\-.])(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|credential|client[_-]?secret|private[_-]?key|access[_-]?key|refresh[_-]?token)(?:$|[_\-.])/i;
const SENSITIVE_NAME_RE = /\b(password|passcode|passwd|pwd|secret|token|api\s*key|authorization|cookie|credential|client\s*secret|private\s*key|access\s*key|refresh\s*token)\b/i;
const VALUE_FIELD_RE = /^(value|values|input|inputValue|text|actual|observed|expected|data|payload|body)$/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = cloneValue(item);
  return out;
}

function objectDeclaresSensitive(value) {
  if (!isObject(value)) return false;
  if (value.sensitive === true || value.isSensitive === true) return true;
  const classification = String(value.classification || value.dataClassification || value.sensitivity || '').toLowerCase();
  if (['sensitive', 'secret', 'credential', 'restricted', 'pii_secret'].includes(classification)) return true;
  const identity = [
    value.reference,
    value.ref,
    value.name,
    value.key,
    value.field,
    value.sourceColumn,
    value.envRef,
    value.environmentReference,
    value.credentialProfileRef,
  ].filter(Boolean).join(' ');
  return SENSITIVE_NAME_RE.test(identity);
}

function redactSensitiveValues(value, options = {}, pathKey = '') {
  const forceSensitive = options.forceSensitive === true;
  const redactValueFields = options.redactValueFields === true;

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item, options, pathKey));
  }
  if (!isObject(value)) {
    if (forceSensitive && options.redactRoot === true) return value == null ? value : REDACTED;
    return value;
  }

  const objectSensitive = forceSensitive || objectDeclaresSensitive(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const keySensitive = SENSITIVE_KEY_RE.test(key);
    const valueFieldSensitive = objectSensitive && redactValueFields && VALUE_FIELD_RE.test(key);
    if ((keySensitive || valueFieldSensitive) && item != null) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSensitiveValues(item, {
      forceSensitive: objectSensitive,
      redactValueFields,
      redactRoot: false,
    }, pathKey ? `${pathKey}.${key}` : key);
  }
  return out;
}

function redactSensitiveText(value, sensitiveLiterals = []) {
  let text = humanReadableText(value);
  text = text.replace(/\b(password|passwd|pwd|passcode|secret|token|api[_ -]?key|client[_ -]?secret)\s*([:=])\s*(?:"[^"]*"|'[^']*'|\S+)/gi, (_m, key, sep) => `${key}${sep}${REDACTED}`);
  for (const literal of sensitiveLiterals) {
    const needle = String(literal == null ? '' : literal);
    if (!needle) continue;
    text = text.split(needle).join(REDACTED);
  }
  return text;
}

function humanReadableText(value, seen = new Set()) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Error) return humanReadableText(value.message || value.name, seen);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => humanReadableText(item, seen)).filter(Boolean))].join('; ');
  }
  const preferred = ['message', 'reason', 'detail', 'error', 'code', 'type', 'status', 'outcome'];
  const parts = [];
  for (const key of preferred) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const rendered = humanReadableText(value[key], seen);
    if (rendered && rendered !== '[object Object]' && !parts.includes(rendered)) parts.push(rendered);
  }
  return parts.join(': ');
}

function looksLikeBindingDescriptor(value) {
  if (!isObject(value)) return false;
  return [
    'reference', 'ref', 'source', 'sourceColumn', 'field', 'name', 'key',
    'value', 'boundValue', 'envRef', 'environmentReference',
    'credentialProfileRef', 'classification', 'sensitive', 'isDataBound',
  ].some((key) => hasOwn(value, key));
}

function bindingList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [{ value }];
  if (looksLikeBindingDescriptor(value)) return [value];
  if (Array.isArray(value.bindings)) return value.bindings;
  return Object.entries(value).map(([key, item]) => (
    isObject(item) ? { reference: key, ...item } : { reference: key, value: item }
  ));
}

function bindingReference(binding, fallbackIndex) {
  return binding.reference
    || binding.ref
    || binding.dataRef
    || binding.sourceColumn
    || binding.field
    || binding.key
    || binding.name
    || binding.envRef
    || binding.environmentReference
    || binding.credentialProfileRef
    || `binding_${fallbackIndex + 1}`;
}

function normalizeBindings(value) {
  return bindingList(value).map((input, index) => {
    const binding = isObject(input) ? input : { value: input };
    const reference = String(bindingReference(binding, index));
    const sensitive = objectDeclaresSensitive(binding) || SENSITIVE_NAME_RE.test(reference);
    const rawValue = hasOwn(binding, 'value') ? binding.value
      : hasOwn(binding, 'boundValue') ? binding.boundValue
        : undefined;
    const classification = sensitive
      ? 'sensitive'
      : String(binding.classification || binding.dataClassification || 'normal').toLowerCase();
    return {
      reference,
      source: binding.source || binding.sourceColumn || null,
      classification,
      sensitive,
      environmentReference: binding.envRef || binding.environmentReference || null,
      credentialProfileReference: binding.credentialProfileRef || null,
      value: rawValue === undefined
        ? undefined
        : sensitive
          ? REDACTED
          : redactSensitiveValues(rawValue),
    };
  });
}

function sensitiveLiteralsFromBindings(value) {
  const out = [];
  for (const input of bindingList(value)) {
    const binding = isObject(input) ? input : { value: input };
    const reference = String(bindingReference(binding, out.length));
    if (!objectDeclaresSensitive(binding) && !SENSITIVE_NAME_RE.test(reference)) continue;
    const raw = hasOwn(binding, 'value') ? binding.value : binding.boundValue;
    if (['string', 'number', 'boolean'].includes(typeof raw)) out.push(String(raw));
  }
  return out;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function plannedTextFor(step, node, ordinal) {
  const direct = firstDefined(
    step && step.plannedText,
    step && step.description,
    step && step.text,
    node && node.plannedText,
  );
  if (direct != null && String(direct).trim()) return String(direct).trim();
  const action = firstDefined(step && step.action, node && node.actionType, node && node.kind);
  const target = firstDefined(step && step.element, step && step.target, step && step.field);
  const joined = [action, target].filter(Boolean).join(' ').trim();
  return joined || `Step ${ordinal}`;
}

function controlTargetFor(step, node) {
  return firstDefined(
    step && step.element,
    step && step.target,
    step && step.field,
    step && step.control,
    node && node.target,
    node && node.element,
    node && node.control,
    node && node.raw && node.raw.element,
    node && node.raw && node.raw.target,
    null,
  );
}

function normalizedControlKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:dropdown|combobox|listbox|menu|options?|option list|calendar|date picker|time picker|field|input|control|button|link|section|panel|page)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isIndependentStep(step, node) {
  const values = [step, node, node && node.raw].filter(isObject);
  for (const value of values) {
    if (value.independent === true || value.fresh === true) return true;
    const mode = String(value.dependencyMode || value.flowImpact || value.failureImpact || '').toLowerCase();
    if (['independent', 'none', 'standalone', 'fresh'].includes(mode)) return true;
  }
  return false;
}

const DEPENDENCY_FIELDS = [
  'dependsOnStepIds', 'dependencyStepIds', 'dependencyIds', 'dependsOn',
  'dependencies', 'requiresStepIds', 'predecessorStepIds', 'afterStepIds',
];

function explicitDependencies(step, node) {
  for (const source of [step, node, node && node.raw]) {
    if (!isObject(source)) continue;
    for (const field of DEPENDENCY_FIELDS) {
      if (!hasOwn(source, field)) continue;
      const raw = source[field];
      return { present: true, refs: Array.isArray(raw) ? raw : raw == null ? [] : [raw] };
    }
  }
  return { present: false, refs: [] };
}

function topLevelDependencyMap(executionContract) {
  const map = new Map();
  if (!isObject(executionContract)) return map;

  const candidates = [
    executionContract.stepDependencies,
    executionContract.dependenciesByStepId,
    executionContract.dependencyGraph && executionContract.dependencyGraph.dependenciesByStepId,
  ];
  for (const candidate of candidates) {
    if (!isObject(candidate)) continue;
    for (const [stepRef, refs] of Object.entries(candidate)) {
      map.set(String(stepRef), Array.isArray(refs) ? refs : refs == null ? [] : [refs]);
    }
  }

  const edgeLists = [
    executionContract.stepDependencyEdges,
    executionContract.dependencyEdges,
    executionContract.dependencyGraph && executionContract.dependencyGraph.edges,
  ];
  for (const edges of edgeLists) {
    if (!Array.isArray(edges)) continue;
    for (const edge of edges) {
      if (!isObject(edge)) continue;
      const from = firstDefined(edge.from, edge.source, edge.prerequisite, edge.dependsOn, edge.parent);
      const to = firstDefined(edge.to, edge.target, edge.dependent, edge.stepId, edge.child);
      if (from == null || to == null) continue;
      const key = String(to);
      const refs = map.get(key) || [];
      refs.push(from);
      map.set(key, refs);
    }
  }
  return map;
}

function rowAliases(row) {
  return [
    row.stepId,
    row.contractStepId,
    row.ordinal,
    row.index,
    `step-${row.ordinal}`,
    `step:${row.ordinal}`,
  ].filter((value) => value !== null && value !== undefined).map(String);
}

const SOURCE_STEP_ID_FIELDS = [
  'stepId', 'id', 'contractStepId', 'caseContractStepId', 'plannedStepId',
  'sourceContractStepId', 'stepAuthoringId',
];

function dependencyAliases(row, spec) {
  const aliases = [...rowAliases(row)];
  for (const source of [spec && spec.step, spec && spec.node, spec && spec.node && spec.node.raw]) {
    if (!isObject(source)) continue;
    for (const field of SOURCE_STEP_ID_FIELDS) {
      const value = source[field];
      if (value !== null && value !== undefined && String(value).trim()) aliases.push(String(value));
    }
  }
  return [...new Set(aliases)];
}

function refValue(ref) {
  if (!isObject(ref)) return ref;
  return firstDefined(
    ref.stepId,
    ref.contractStepId,
    ref.id,
    ref.reference,
    ref.ref,
    ref.ordinal,
    ref.order,
    ref.index,
  );
}

function resolveDependencyRef(ref, aliasToStepId, rows) {
  const raw = refValue(ref);
  if (raw === null || raw === undefined) return null;
  const direct = aliasToStepId.get(String(raw));
  if (direct) return direct;
  const numeric = Number(raw);
  if (Number.isInteger(numeric)) {
    const ordinal = numeric === 0 ? 1 : numeric;
    const row = rows.find((item) => item.ordinal === ordinal || item.index === numeric);
    return row ? row.stepId : null;
  }
  return null;
}

function uniqueStepId(preferred, ordinal, used) {
  const base = String(preferred || `step-${ordinal}`);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const unique = `${base}#${ordinal}`;
  used.add(unique);
  return unique;
}

function requiredForStep(step, node) {
  const sources = [step, node, node && node.raw];
  if (isPresenceConditionalAction(...sources)) {
    return conditionalActionRequiredByContract(...sources);
  }
  for (const source of sources) {
    if (!isObject(source)) continue;
    if (source.optional === true || source.required === false || source.proofRequired === false) return false;
  }
  return true;
}

function requiredForContinuationForStep(step, node) {
  for (const source of [step, node, node && node.raw]) {
    if (!isObject(source)) continue;
    if (source.requiredForContinuation === true || source.blocking === true) return true;
    const flowRule = [
      source.flowImpact,
      source.failureBehavior,
      source.continuation,
      source.dependencyMode,
    ].filter(Boolean).join(' ').toLowerCase();
    if (/\b(?:blocking|required_for_continuation|stop_descendants|stop_case)\b/.test(flowRule)) return true;
  }
  return false;
}

function assertionStep(step, node) {
  const kind = String(firstDefined(node && node.kind, step && step.kind, step && step.type, '')).toLowerCase();
  const action = String(firstDefined(node && node.actionType, step && step.action, '')).toLowerCase();
  return kind === 'assertion'
    || kind === 'verification'
    || /^(assert|verify|validate)(?:_|$)/.test(action)
    || (step && step.assertion === true);
}

function bindingInputFor(step, node) {
  return firstDefined(
    node && node.dataBinding,
    step && step.dataBindings,
    step && step.dataBinding,
    step && step.bindings,
    step && step.inlineDataBindings,
  );
}

function nodeForStep(nodes, step, ordinal, usedNodes) {
  const desiredId = step && (step.contractStepId || step.stepId || step.id);
  let index = desiredId == null ? -1 : nodes.findIndex((node, idx) => !usedNodes.has(idx) && [node.contractStepId, node.stepId, node.id].filter(Boolean).map(String).includes(String(desiredId)));
  if (index < 0) index = nodes.findIndex((node, idx) => !usedNodes.has(idx) && Number(node.stepOrdinal) === ordinal);
  if (index < 0) index = nodes.findIndex((_node, idx) => !usedNodes.has(idx));
  if (index < 0) return null;
  usedNodes.add(index);
  return nodes[index];
}

function initializeExecutionJournal({ approvedSteps = [], executionContract = null } = {}) {
  const nodes = Array.isArray(executionContract && executionContract.nodes)
    ? executionContract.nodes.filter(isObject)
    : [];
  const sourceSteps = Array.isArray(approvedSteps) && approvedSteps.length
    ? approvedSteps
    : nodes;
  const usedNodes = new Set();
  const usedStepIds = new Set();
  const dependencySpecs = [];

  let rows = sourceSteps.map((rawStep, index) => {
    const step = isObject(rawStep) ? rawStep : { description: String(rawStep == null ? '' : rawStep) };
    const ordinal = Number(step.order || step.ordinal || step.stepOrdinal) || index + 1;
    const node = Array.isArray(approvedSteps) && approvedSteps.length
      ? nodeForStep(nodes, step, ordinal, usedNodes)
      : step;
    const bindingInput = bindingInputFor(step, node);
    const bindings = normalizeBindings(bindingInput);
    const sensitiveLiterals = sensitiveLiteralsFromBindings(bindingInput);
    const contractStepId = firstDefined(node && node.contractStepId, step.contractStepId, null);
    const stepId = uniqueStepId(firstDefined(step.stepId, step.id, node && node.stepId, contractStepId), ordinal, usedStepIds);
    const explicit = explicitDependencies(step, node);
    dependencySpecs.push({ explicit, independent: isIndependentStep(step, node), step, node });
    const hasSensitiveBindings = bindings.some((binding) => binding.sensitive);
    const expectedState = firstDefined(
      node && node.expectedOutcome,
      step.expectedState,
      step.expected,
      null,
    );
    const conditionalPresence = isPresenceConditionalAction(step, node, node && node.raw);
    const required = requiredForStep(step, node);
    const controlTarget = controlTargetFor(step, node);

    return {
      journalVersion: JOURNAL_VERSION,
      index: ordinal,
      ordinal,
      stepId,
      contractStepId: contractStepId || null,
      plannedText: redactSensitiveText(plannedTextFor(step, node, ordinal), sensitiveLiterals),
      kind: firstDefined(node && node.kind, step.kind, step.type, 'action'),
      actionType: firstDefined(node && node.actionType, step.action, null),
      assertionStep: assertionStep(step, node),
      required,
      optional: conditionalPresence && !required,
      conditionalPresence,
      requiredForContinuation: requiredForContinuationForStep(step, node),
      controlTarget: controlTarget == null ? null : redactSensitiveText(String(controlTarget), sensitiveLiterals),
      controlKey: normalizedControlKey(controlTarget),
      operationCheckKind: String(firstDefined(
        step && step.operationCheck && step.operationCheck.kind,
        node && node.operationCheck && node.operationCheck.kind,
        '',
      ) || '').toLowerCase() || null,
      dependencyStepIds: [],
      dependentStepIds: [],
      boundDataReferences: bindings,
      hasSensitiveBindings,
      attempts: [],
      retryCount: 0,
      maxRetries: 0,
      retryExhausted: false,
      invalidatedByStepId: null,
      recoveryWaitingForStepId: null,
      recoveryHistory: [],
      expectedState: expectedState == null
        ? null
        : redactSensitiveValues(expectedState, { forceSensitive: hasSensitiveBindings, redactValueFields: true }),
      observedState: null,
      actionOutcome: null,
      assertionOutcome: null,
      assertionOutcomes: [],
      continuationOutcome: null,
      continuationReason: null,
      failureImpact: null,
      affectedDescendantStepIds: [],
      blockedByStepIds: [],
      dependencySkipped: false,
      executionError: false,
      executionErrorReason: null,
      durationMs: null,
      evidence: null,
      reconciliationHistory: [],
      error: null,
      status: 'pending',
    };
  });

  const aliasToStepId = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    for (const alias of dependencyAliases(row, dependencySpecs[index])) {
      if (!aliasToStepId.has(alias)) aliasToStepId.set(alias, row.stepId);
    }
  }
  const topLevel = topLevelDependencyMap(executionContract);

  rows = rows.map((row, index) => {
    const spec = dependencySpecs[index];
    let refs = spec.explicit.refs;
    for (const alias of dependencyAliases(row, spec)) {
      if (!topLevel.has(alias)) continue;
      refs = topLevel.get(alias);
      break;
    }
    const declaredRefs = (Array.isArray(refs) ? refs : refs == null ? [] : [refs])
      .filter((ref) => ref != null && String(ref).trim());
    if (!spec.independent && index > 0 && declaredRefs.length === 0) {
      refs = [rows[index - 1].stepId];
    } else if (spec.independent || index === 0) {
      refs = [];
    } else {
      refs = declaredRefs;
    }
    let dependencyStepIds = [...new Set((refs || [])
      .map((ref) => resolveDependencyRef(ref, aliasToStepId, rows))
      .filter((stepId) => stepId && stepId !== row.stepId))];
    if (!spec.independent && index > 0 && dependencyStepIds.length === 0) {
      dependencyStepIds = [rows[index - 1].stepId];
    }
    return { ...row, dependencyStepIds };
  });

  const dependentMap = new Map(rows.map((row) => [row.stepId, []]));
  for (const row of rows) {
    for (const dependencyId of row.dependencyStepIds) {
      if (!dependentMap.has(dependencyId)) dependentMap.set(dependencyId, []);
      dependentMap.get(dependencyId).push(row.stepId);
    }
  }
  return rows.map((row) => ({
    ...row,
    dependentStepIds: [...new Set(dependentMap.get(row.stepId) || [])],
    status: deriveLegacyStatus(row),
  }));
}

function ensureJournal(journal) {
  if (!Array.isArray(journal)) throw new TypeError('execution journal must be an array');
  return cloneValue(journal);
}

function rowIndexForRef(journal, stepRef) {
  const raw = refValue(stepRef);
  if (raw === null || raw === undefined) return -1;
  if (typeof raw === 'number') {
    if (raw === 0 && journal[0]) return 0;
    const byOrdinal = journal.findIndex((row) => row.ordinal === raw || row.index === raw);
    if (byOrdinal >= 0) return byOrdinal;
  }
  const stringRef = String(raw);
  let index = journal.findIndex((row) => row.stepId === stringRef || row.contractStepId === stringRef);
  if (index >= 0) return index;
  if (/^\d+$/.test(stringRef)) {
    const ordinal = Number(stringRef);
    index = journal.findIndex((row) => row.ordinal === ordinal || row.index === ordinal);
  }
  return index;
}

function requireRowIndex(journal, stepRef) {
  const index = rowIndexForRef(journal, stepRef);
  if (index < 0) throw new Error(`execution journal step not found: ${String(refValue(stepRef))}`);
  return index;
}

function normalizedActionOutcome(input) {
  const raw = isObject(input) ? firstDefined(input.outcome, input.actionOutcome, input.status) : input;
  const value = String(raw || '').toLowerCase();
  const aliases = {
    pass: 'succeeded', passed: 'succeeded', success: 'succeeded', ok: 'succeeded',
    fail: 'failed', failed: 'failed', error: 'failed', blocked: 'failed',
    skipped: 'not_executed', pending: 'not_executed', not_run: 'not_executed',
  };
  const normalized = aliases[value] || value;
  if (!ACTION_OUTCOMES.has(normalized)) throw new TypeError(`invalid action outcome: ${String(raw)}`);
  return normalized;
}

function normalizedAssertionOutcome(input) {
  const object = isObject(input) ? input : { outcome: input };
  let raw = firstDefined(object.outcome, object.assertionOutcome, object.status);
  if (raw == null && typeof object.matched === 'boolean') raw = object.matched ? 'matched' : 'not_matched';
  const value = String(raw || '').toLowerCase();
  const aliases = {
    pass: 'matched', passed: 'matched', success: 'matched', true: 'matched',
    fail: 'not_matched', failed: 'not_matched', false: 'not_matched', mismatch: 'not_matched',
    unchecked: 'uncheckable', unknown: 'uncheckable', skipped: 'not_applicable',
  };
  const normalized = aliases[value] || value;
  if (!ASSERTION_OUTCOMES.has(normalized)) throw new TypeError(`invalid assertion outcome: ${String(raw)}`);
  return normalized;
}

function semanticToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const DIRECT_OPERATION_PROOF_KINDS = new Set([
  'operationcheck',
  'actioncompleted',
  'actionpostcondition',
  'attribute',
  'checked',
  'count',
  'effect',
  'effectproof',
  'hidden',
  'number',
  'postcondition',
  'selected',
  'selectionexact',
  'text',
  'url',
  'valueexact',
  'value',
  'visible',
  'urlexact',
]);

function authoritativeOperationProof(input = {}) {
  const details = isObject(input) ? input : {};
  const evidence = isObject(details.evidence) ? details.evidence : {};
  const candidates = [
    { source: 'operation_check', proof: details.operationCheck, named: true },
    { source: 'postcondition', proof: details.postcondition, named: true },
    { source: 'effect_proof', proof: details.effectProof, named: true },
    { source: 'evidence_operation_check', proof: evidence.operationCheck, named: true },
    { source: 'evidence_postcondition', proof: evidence.postcondition, named: true },
    { source: 'evidence_effect_proof', proof: evidence.effectProof, named: true },
    { source: 'evidence', proof: evidence, named: false },
  ];

  for (const candidate of candidates) {
    const proof = candidate.proof;
    if (!isObject(proof) || proof.matched !== true || semanticToken(proof.status) !== 'pass') continue;
    if (proof.checked === false) continue;
    if (!candidate.named && !DIRECT_OPERATION_PROOF_KINDS.has(semanticToken(
      firstDefined(proof.kind, proof.type, proof.source, proof.operationKind, ''),
    ))) continue;
    return { source: candidate.source, proof };
  }
  return null;
}

const EXACT_ASSERTION_COMPARATORS = new Set([
  'exact',
  'equals',
  'eq',
  'strictequal',
  'strictequals',
  'textequals',
  'valueequals',
  'numberequals',
  'valueexact',
  'selectionexact',
  'selected',
  'checked',
  'present',
  'absent',
  'origin',
  'path',
  'pathandquery',
]);

const EXACT_READBACK_KINDS = new Set([
  'attribute',
  'attributeexact',
  'checked',
  'controlreadback',
  'exactreadback',
  'exacttext',
  'readback',
  'selected',
  'selectionexact',
  'textexact',
  'urlexact',
  'value',
  'valueexact',
]);

function isExactAssertionReadback(row, details = {}) {
  if (details.matched === false) return false;
  const status = semanticToken(details.status);
  if (status && !['pass', 'matched', 'success', 'succeeded'].includes(status)) return false;
  const comparator = semanticToken(firstDefined(details.comparator, details.operator, details.relation, ''));
  const kind = semanticToken(firstDefined(
    details.assertionType,
    details.kind,
    details.type,
    details.checkKind,
    row && row.kind,
    row && row.actionType,
    '',
  ));
  const exact = details.exact === true
    || (comparator ? EXACT_ASSERTION_COMPARATORS.has(comparator) : EXACT_READBACK_KINDS.has(kind));
  if (!exact) return false;
  return details.checked === true
    || details.evidence != null
    || ['actual', 'observed', 'observedState', 'value', 'selected', 'checked'].some((key) => hasOwn(details, key));
}

function isSemanticOnlyTooltipVisualEvidence(details = {}) {
  if (!details || typeof details !== 'object' || details.matched !== true) return false;
  const evidence = String(details.evidence || '');
  return /tooltip text .*present semantically in DOM\/accessibility[\s\S]*no rendered visual bubble was captured/i.test(evidence);
}

function normalizedContinuationOutcome(input) {
  const raw = isObject(input) ? firstDefined(input.outcome, input.continuationOutcome, input.status) : input;
  const value = String(raw || '').toLowerCase();
  if (!CONTINUATION_OUTCOMES.has(value)) throw new TypeError(`invalid continuation outcome: ${String(raw)}`);
  return value;
}

function continuationNodeKindForRow(row = {}) {
  if (row.assertionStep === true) return 'assertion';
  const value = String(firstDefined(row.actionType, row.kind, 'action')).trim().toLowerCase();
  if (/\b(?:wait|waitforstate|wait_for_state|synchronize|stabilize)\b/.test(value)) return 'wait_for_state';
  if (/^(?:page_ready|url|url_changed|navigation|redirect)$/.test(String(row.operationCheckKind || '').toLowerCase())) return 'navigation';
  if (/\b(?:navigate|navigation|goto|openpage|redirect)\b/.test(value)) return 'navigation';
  if (/\b(?:auth|authentication|session|session_continuation)\b/.test(value)) return 'session';
  if (/\b(?:environment|network|infrastructure|external_site)\b/.test(value)) return 'environment';
  return 'action';
}

function journalOutcomeForPolicy(decision = {}) {
  switch (decision.outcome) {
    case executionContinuationPolicy.CONTINUATION_OUTCOME.RETRY_OBSERVATION:
      return 'retry';
    case executionContinuationPolicy.CONTINUATION_OUTCOME.BLOCK_DEPENDENTS:
      return 'stop_descendants';
    case executionContinuationPolicy.CONTINUATION_OUTCOME.STOP_RUN:
      return 'stop_case';
    default:
      return 'continue';
  }
}

function decideJournalContinuation(row, details = {}, overrides = {}) {
  const input = {
    kind: overrides.kind || continuationNodeKindForRow(row),
    status: overrides.status || details.status || details.outcome,
    required: details.required === undefined ? row.required !== false : details.required === true,
    optional: details.optional === true || row.optional === true,
    optionalTargetAbsent: overrides.optionalTargetAbsent === true || details.optionalTargetAbsent === true || details.optionalAbsent === true,
    targetPresent: details.targetPresent,
    temporarilyUnavailable: details.temporarilyUnavailable === true,
    observation: details.observation,
    evidence: details.evidence,
    observationBudgetExhausted: overrides.observationBudgetExhausted === true || details.observationBudgetExhausted === true || details.retryBudgetExhausted === true,
    failureProven: overrides.failureProven === true || details.failureProven === true,
    inabilityProven: overrides.failureProven === true || details.inabilityProven === true,
    failureClass: details.failureClass || details.failureType || details.failureKind,
    impossible: details.impossible === true,
    runImpossible: details.runImpossible === true,
  };
  const decision = executionContinuationPolicy.decideContinuation(input);
  return {
    decision,
    journalOutcome: journalOutcomeForPolicy(decision),
  };
}

function compactContinuationPolicyDecision(decision = {}) {
  return {
    outcome: decision.outcome || null,
    reason: decision.reason || null,
    scope: decision.scope || 'none',
    stepVerdict: decision.stepVerdict ?? null,
    continueIndependent: decision.continueIndependent === true,
    blockDependents: decision.blockDependents === true,
    retryObservation: decision.retryObservation === true,
    redispatchAction: decision.redispatchAction === true,
  };
}

function stableAssertionOutcomeId(item) {
  if (!item || typeof item !== 'object') return null;
  const value = firstDefined(
    item.assertionId,
    item.contractAssertionId,
    item.checkId,
    item.oracleId,
    item.id,
    null,
  );
  return value == null || String(value).trim() === '' ? null : String(value);
}

/**
 * Retain the full observation array on the journal row, but derive terminal
 * truth from the latest observation for each stable assertion identity.
 * Anonymous observations cannot be proven to be retries of one another, so
 * they intentionally remain independent.
 */
function latestAssertionOutcomes(outcomes) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  const lastIndexById = new Map();
  list.forEach((item, index) => {
    const id = stableAssertionOutcomeId(item);
    if (id != null) lastIndexById.set(id, index);
  });
  return list.filter((item, index) => {
    const id = stableAssertionOutcomeId(item);
    return id == null || lastIndexById.get(id) === index;
  });
}

function aggregateAssertionOutcome(outcomes) {
  const values = latestAssertionOutcomes(outcomes).map((item) => item && item.outcome).filter(Boolean);
  if (values.includes('not_matched')) return 'not_matched';
  if (values.includes('uncheckable')) return 'uncheckable';
  if (values.includes('matched')) return 'matched';
  if (values.includes('not_applicable')) return 'not_applicable';
  return null;
}

function deriveLegacyStatus(row) {
  if (!row) return 'pending';
  if (row.dependencySkipped || row.actionOutcome === 'not_executed') return 'skipped';
  // A failed attempt with an explicit retry decision is not a terminal failure.
  // Keeping the compatibility status pending ensures legacy continuation gates
  // do not mistake a retryable step for completed execution.
  if (row.continuationOutcome === 'retry') return 'pending';
  if (row.executionError) return 'blocked';
  if (row.actionOutcome === 'failed') return 'fail';
  const assertion = row.assertionOutcome || aggregateAssertionOutcome(row.assertionOutcomes);
  if (assertion === 'not_matched') return 'fail';
  if (assertion === 'uncheckable') return 'blocked';
  if (row.actionOutcome === 'succeeded') return 'pass';
  return 'pending';
}

function refreshStatuses(journal) {
  return journal.map((row) => ({ ...row, status: deriveLegacyStatus(row) }));
}

function descendantStepIds(journal, sourceStepId) {
  const byId = new Map(journal.map((row) => [row.stepId, row]));
  const seen = new Set();
  const queue = [...(byId.get(sourceStepId)?.dependentStepIds || [])];
  while (queue.length) {
    const stepId = queue.shift();
    if (!stepId || seen.has(stepId)) continue;
    seen.add(stepId);
    const row = byId.get(stepId);
    if (row) queue.push(...(row.dependentStepIds || []));
  }
  return [...seen];
}

function ancestorStepIds(journal, sourceStepId) {
  const byId = new Map(journal.map((row) => [row.stepId, row]));
  const seen = new Set();
  const queue = [...(byId.get(sourceStepId)?.dependencyStepIds || [])];
  while (queue.length) {
    const stepId = queue.shift();
    if (!stepId || seen.has(stepId)) continue;
    seen.add(stepId);
    const row = byId.get(stepId);
    if (row) queue.push(...(row.dependencyStepIds || []));
  }
  return [...seen];
}

function prerequisiteIdentityText(row) {
  const bindings = Array.isArray(row?.boundDataReferences) ? row.boundDataReferences : [];
  return [
    row?.plannedText,
    row?.actionType,
    row?.kind,
    row?.contractStepId,
    ...bindings.flatMap((binding) => [
      binding?.reference,
      binding?.name,
      binding?.environmentReference,
      binding?.credentialProfileReference,
    ]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function isInputProducer(row) {
  return /\b(?:fill|type|select|check|set|input)\b/i.test(String(row?.actionType || row?.kind || ''));
}

function schedulePrerequisiteRetry(journal, failedStepRef, input = {}) {
  let next = ensureJournal(journal);
  const failedIndex = requireRowIndex(next, failedStepRef);
  const failedRow = next[failedIndex];
  const details = isObject(input) ? input : {};
  const requiredInputKind = String(firstDefined(
    details.requiredInputKind,
    details.inputKind,
    details.requiredControl,
    '',
  )).trim().toLowerCase();
  const requiredDataReference = String(firstDefined(details.requiredDataReference, details.dataReference, '')).trim().toLowerCase();
  const ancestorIds = new Set(ancestorStepIds(next, failedRow.stepId));
  let predecessorIndex = details.predecessorStepRef == null
    ? -1
    : requireRowIndex(next, details.predecessorStepRef);

  if (predecessorIndex >= 0 && !ancestorIds.has(next[predecessorIndex].stepId)) {
    throw new Error(`execution journal prerequisite ${next[predecessorIndex].stepId} is not upstream of ${failedRow.stepId}`);
  }

  if (predecessorIndex < 0) {
    const candidates = next
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => ancestorIds.has(row.stepId) && isInputProducer(row))
      .filter(({ row }) => {
        const identity = prerequisiteIdentityText(row);
        if (requiredDataReference && !identity.includes(requiredDataReference)) return false;
        if (requiredInputKind && !identity.includes(requiredInputKind)) return false;
        return Boolean(requiredDataReference || requiredInputKind);
      })
      .sort((left, right) => Number(right.row.ordinal || right.index + 1) - Number(left.row.ordinal || left.index + 1));
    predecessorIndex = candidates[0]?.index ?? -1;
  }

  const safeReason = redactSensitiveText(firstDefined(
    details.reason,
    `A required ${requiredInputKind || 'input'} was no longer present when the dependent action ran.`,
  ));
  const cause = String(details.cause || 'required_input_missing_after_action');

  if (predecessorIndex < 0) {
    const unresolvedReason = redactSensitiveText(
      `QAAI detected an unmet ${requiredInputKind || 'input'} prerequisite but could not map it to an executed upstream producer step.`,
    );
    next[failedIndex] = {
      ...failedRow,
      executionError: true,
      executionErrorReason: unresolvedReason,
      failureType: 'required_input_prerequisite_unresolved',
      failureOwner: 'qaai',
      failureImpact: 'execution_error',
      continuationOutcome: 'stop_descendants',
      continuationReason: unresolvedReason,
      error: unresolvedReason,
    };
    next = stopDescendants(next, failedIndex, unresolvedReason);
    return {
      journal: refreshStatuses(next),
      scheduled: false,
      exhausted: false,
      reason: 'required_input_prerequisite_unresolved',
      failedStepId: failedRow.stepId,
      predecessorStepId: null,
    };
  }

  const predecessor = next[predecessorIndex];
  if (!isInputProducer(predecessor)) {
    throw new Error(`execution journal prerequisite ${predecessor.stepId} is not an input-producing step`);
  }
  if (predecessor.actionOutcome !== 'succeeded') {
    throw new Error(`execution journal prerequisite ${predecessor.stepId} was not previously successful`);
  }

  const retryCount = Number(predecessor.retryCount || 0);
  const maxRetries = Math.max(0, Math.min(10, Number(details.maxRetries ?? predecessor.maxRetries ?? 1) || 1));
  if (retryCount >= maxRetries) {
    const exhaustedReason = redactSensitiveText(
      `QAAI could not re-establish the required ${requiredInputKind || 'input'} after ${maxRetries} bounded recovery attempt${maxRetries === 1 ? '' : 's'}.`,
    );
    next[predecessorIndex] = {
      ...predecessor,
      maxRetries,
      retryExhausted: true,
      continuationOutcome: 'continue',
      continuationReason: exhaustedReason,
    };
    next[failedIndex] = {
      ...failedRow,
      retryExhausted: true,
      executionError: true,
      executionErrorReason: exhaustedReason,
      failureType: 'required_input_recovery_exhausted',
      failureOwner: 'qaai',
      failureImpact: 'execution_error',
      continuationOutcome: 'stop_descendants',
      continuationReason: exhaustedReason,
      error: exhaustedReason,
    };
    next = stopDescendants(next, failedIndex, exhaustedReason);
    return {
      journal: refreshStatuses(next),
      scheduled: false,
      exhausted: true,
      reason: 'required_input_recovery_exhausted',
      failedStepId: failedRow.stepId,
      predecessorStepId: predecessor.stepId,
      retryCount,
      maxRetries,
    };
  }

  const recoveryNumber = retryCount + 1;
  const recoveryEvent = {
    recovery: recoveryNumber,
    cause,
    invalidatedByStepId: failedRow.stepId,
    prerequisiteStepId: predecessor.stepId,
    priorActionOutcome: predecessor.actionOutcome,
    priorContinuationOutcome: predecessor.continuationOutcome,
    reason: safeReason,
  };
  const retainedAssertionOutcomes = (failedRow.assertionOutcomes || [])
    .filter((item) => item?.source !== 'action_postcondition');

  next[predecessorIndex] = {
    ...predecessor,
    retryCount: recoveryNumber,
    maxRetries,
    retryExhausted: false,
    invalidatedByStepId: failedRow.stepId,
    recoveryWaitingForStepId: null,
    recoveryHistory: [...(predecessor.recoveryHistory || []), recoveryEvent],
    continuationOutcome: 'retry',
    continuationReason: safeReason,
    failureImpact: 'prerequisite_invalidated',
  };
  next[failedIndex] = {
    ...failedRow,
    assertionOutcomes: retainedAssertionOutcomes,
    assertionOutcome: aggregateAssertionOutcome(retainedAssertionOutcomes),
    executionError: false,
    executionErrorReason: null,
    failureType: 'transient_required_input_missing',
    failureOwner: 'transient',
    failureImpact: 'waiting_for_prerequisite_retry',
    continuationOutcome: 'retry',
    continuationReason: safeReason,
    recoveryWaitingForStepId: predecessor.stepId,
    recoveryHistory: [...(failedRow.recoveryHistory || []), recoveryEvent],
    error: safeReason,
  };
  next = releaseDescendants(next, failedIndex);
  return {
    journal: refreshStatuses(next),
    scheduled: true,
    exhausted: false,
    reason: cause,
    failedStepId: failedRow.stepId,
    predecessorStepId: predecessor.stepId,
    retryCount: recoveryNumber,
    maxRetries,
  };
}

function controlScopedDescendantIds(journal, sourceIndex) {
  const source = journal[sourceIndex];
  const sourceKey = String(source?.controlKey || '').trim();
  if (!sourceKey) return [];
  const descendants = new Set(descendantStepIds(journal, source.stepId));
  const affected = [];
  for (let index = sourceIndex + 1; index < journal.length; index += 1) {
    const row = journal[index];
    if (!descendants.has(row.stepId)) continue;
    const rowKey = String(row.controlKey || '').trim();
    if (rowKey === sourceKey) {
      affected.push(row.stepId);
      continue;
    }
    const action = String(row.actionType || row.kind || '').toLowerCase();
    const passive = row.assertionStep === true || /wait|assert|verify|check|observe/.test(action);
    if (passive && !rowKey && (row.dependencyStepIds || []).some((id) => id === source.stepId || affected.includes(id))) {
      affected.push(row.stepId);
      continue;
    }
    // A different actionable control begins a new independent transaction.
    if (!passive) break;
  }
  return affected;
}

function releaseNextIndependentControl(journal, sourceIndex, blockedStepIds) {
  const blocked = new Set(blockedStepIds);
  const sourceKey = String(journal[sourceIndex]?.controlKey || '').trim();
  for (let index = sourceIndex + 1; index < journal.length; index += 1) {
    const row = journal[index];
    if (row.actionOutcome !== null || row.dependencySkipped === true) continue;
    const dependencies = row.dependencyStepIds || [];
    if (!dependencies.some((id) => blocked.has(id))) continue;
    const rowKey = String(row.controlKey || '').trim();
    const action = String(row.actionType || row.kind || '').toLowerCase();
    const passive = row.assertionStep === true || /wait|assert|verify|check|observe/.test(action);
    if (passive || (sourceKey && rowKey === sourceKey)) continue;
    return journal.map((candidate, candidateIndex) => candidateIndex === index
      ? {
          ...candidate,
          dependencyStepIds: dependencies.filter((id) => !blocked.has(id)),
          releasedDependencyStepIds: dependencies.filter((id) => blocked.has(id)),
          dependencyReleaseReason: 'prior_control_transaction_failed_continue_independent',
        }
      : candidate);
  }
  return journal;
}

function hasTypedRecoveryForControl(journal, sourceIndex) {
  const sourceKey = String(journal[sourceIndex]?.controlKey || '').trim();
  if (!sourceKey) return false;
  for (let index = sourceIndex + 1; index < journal.length; index += 1) {
    const row = journal[index];
    const action = String(row.actionType || row.kind || '').toLowerCase();
    const passive = row.assertionStep === true || /wait|assert|verify|check|observe/.test(action);
    const rowKey = String(row.controlKey || '').trim();
    if (rowKey === sourceKey && /^(?:select|date|fill|type|check|radio|setvalue|choose)$/.test(action)) {
      return true;
    }
    if (!passive && rowKey && rowKey !== sourceKey) return false;
  }
  return false;
}

function hasDeliveredDispatch(row, details = {}) {
  if (details.dispatchStatus === 'delivered'
    || details.actionTransaction?.dispatchStatus === 'delivered') return true;
  return (Array.isArray(row?.attempts) ? row.attempts : []).some((attempt) => (
    attempt?.dispatchStatus === 'delivered'
    || (Array.isArray(attempt?.universalActionDiagnostics?.dispatches)
      && attempt.universalActionDiagnostics.dispatches.some((dispatch) => dispatch?.ok === true))
  ));
}

function stopDescendants(journal, sourceIndex, reason, options = {}) {
  const source = journal[sourceIndex];
  const failureClass = String(options.failureClass || '').toLowerCase();
  const resolverUncertainty = /(?:ambiguous|locator|selector|target_resolution|evidence_unavailable)/.test(failureClass);
  const controlScoped = options.continueIndependent === true
    && options.scope === 'step_dependents'
    && resolverUncertainty
    && continuationNodeKindForRow(source) === 'action';
  const affected = controlScoped
    ? controlScopedDescendantIds(journal, sourceIndex)
    : descendantStepIds(journal, source.stepId);
  const affectedSet = new Set(affected);
  const safeReason = redactSensitiveText(reason || `Dependency ${source.stepId} did not complete successfully.`);
  let next = journal.map((row, index) => {
    if (index === sourceIndex) {
      return {
        ...row,
        continuationOutcome: 'stop_descendants',
        continuationReason: safeReason,
        affectedDescendantStepIds: affected,
      };
    }
    if (!affectedSet.has(row.stepId)) return row;
    if (row.actionOutcome === 'succeeded' || row.actionOutcome === 'failed') return row;
    return {
      ...row,
      actionOutcome: 'not_executed',
      assertionOutcome: row.assertionOutcome || 'not_applicable',
      continuationOutcome: 'stop_descendants',
      continuationReason: safeReason,
      failureImpact: 'dependency_skipped',
      dependencySkipped: true,
      blockedByStepIds: [...new Set([...(row.blockedByStepIds || []), source.stepId])],
      error: null,
    };
  });
  if (controlScoped) {
    next = releaseNextIndependentControl(next, sourceIndex, [source.stepId, ...affected]);
  }
  return refreshStatuses(next);
}

function stopCase(journal, sourceIndex, reason) {
  const sourceStepId = journal[sourceIndex].stepId;
  const safeReason = redactSensitiveText(reason || 'Case execution stopped before the remaining steps ran.');
  return refreshStatuses(journal.map((row, index) => {
    if (index === sourceIndex) {
      return {
        ...row,
        continuationOutcome: 'stop_case',
        continuationReason: safeReason,
      };
    }
    if (row.actionOutcome !== null) return row;
    return {
      ...row,
      actionOutcome: 'not_executed',
      assertionOutcome: row.assertionOutcome || 'not_applicable',
      continuationOutcome: 'stop_case',
      continuationReason: safeReason,
      failureImpact: 'case_stopped',
      dependencySkipped: false,
      blockedByStepIds: [...new Set([...(row.blockedByStepIds || []), sourceStepId])],
      error: null,
    };
  }));
}

function releaseDescendants(journal, sourceIndex) {
  const sourceStepId = journal[sourceIndex].stepId;
  return refreshStatuses(journal.map((row) => {
    if (!Array.isArray(row.blockedByStepIds) || !row.blockedByStepIds.includes(sourceStepId)) return row;
    const blockers = row.blockedByStepIds.filter((stepId) => stepId !== sourceStepId);
    if (blockers.length) return { ...row, blockedByStepIds: blockers };
    if (!row.dependencySkipped || row.actionOutcome !== 'not_executed') return { ...row, blockedByStepIds: [] };
    return {
      ...row,
      actionOutcome: null,
      assertionOutcome: null,
      continuationOutcome: null,
      continuationReason: null,
      failureImpact: null,
      dependencySkipped: false,
      blockedByStepIds: [],
      error: null,
    };
  }));
}

function recordAttempt(journal, stepRef, attempt = {}) {
  const next = ensureJournal(journal);
  const index = requireRowIndex(next, stepRef);
  const row = next[index];
  const safeAttempt = redactSensitiveValues(isObject(attempt) ? attempt : { detail: attempt }, {
    forceSensitive: row.hasSensitiveBindings === true,
    redactValueFields: true,
  });
  next[index] = {
    ...row,
    attempts: [
      ...(row.attempts || []),
      {
        attempt: (row.attempts || []).length + 1,
        ...safeAttempt,
      },
    ],
  };
  return refreshStatuses(next);
}

function recordActionOutcome(journal, stepRef, input) {
  let next = ensureJournal(journal);
  const index = requireRowIndex(next, stepRef);
  const row = next[index];
  const details = isObject(input) ? input : { outcome: input };
  const requestedOutcome = normalizedActionOutcome(details);
  const operationEvidence = isObject(details.evidence) ? details.evidence : null;
  const authoritativeProof = authoritativeOperationProof(details);
  const attachedVerifyKind = String(firstDefined(
    operationEvidence?.args?.verify?.kind,
    operationEvidence?.operationCheck?.kind,
    operationEvidence?.verify?.kind,
    operationEvidence?.expectedKind,
    authoritativeProof?.proof?.kind,
    '',
  )).toLowerCase();
  const attachedAssertion = row.assertionStep !== true
    && typeof operationEvidence?.matched === 'boolean'
    && /^(?:visible|hidden|text|number|url|value|selected|checked|count|attribute|action_completed)$/.test(attachedVerifyKind);
  // A browser action with an attached postcondition is still an executed
  // action when that postcondition misses. Conductor previously collapsed the
  // two facts into a failed/product action, which stopped the dependency graph
  // and moved the pointer to the end. Keep the action and assertion channels
  // independent at the journal authority boundary.
  const attachedAssertionMiss = attachedAssertion && operationEvidence.matched === false;
  const failureType = String(details.failureType || details.failureKind || '').toLowerCase();
  const optionalAbsent = details.optionalAbsent === true
    || details.optionalTargetAbsent === true
    || OPTIONAL_ABSENCE_TYPES.has(failureType);
  // Looking for an optional target and proving that it is absent is a
  // successfully executed check, not a failed browser action.
  const openerProofDelegated = requestedOutcome === 'failed'
    && /^(?:menu_opened|control_open|opened)$/.test(String(row.operationCheckKind || '').toLowerCase())
    && operationEvidence?.matched !== true
    && ['functional_failure', 'qaai_execution_uncertainty', 'execution_uncertainty']
      .includes(String(operationEvidence?.outcomeKind || '').toLowerCase())
    && hasDeliveredDispatch(row, details)
    && hasTypedRecoveryForControl(next, index);
  const outcome = optionalAbsent || attachedAssertion || authoritativeProof || openerProofDelegated
    ? 'succeeded'
    : requestedOutcome;
  const ownership = outcome === 'failed'
    ? classifyActionFailureOwnership({
      ...details,
      failureType,
      evidence: operationEvidence || details.evidence || null,
      assertionMismatch: details.assertionMismatch === true,
      observedProductRejection: details.observedProductRejection === true,
      productFailureEvidence: details.productFailureEvidence === true,
    })
    : null;
  const executionError = ownership?.executionError === true;
  const required = details.required === undefined ? row.required !== false : details.required === true;
  const failureOwner = outcome === 'failed' ? ownership.failureOwner : null;
  const evidenceState = [
    details.status,
    details.evidenceStatus,
    details.observation?.status,
    details.evidence?.status,
  ].filter(Boolean).join(' ').toLowerCase();
  const temporaryEvidence = details.temporarilyUnavailable === true
    || /(?:capture_pending|evidence_pending|snapshot_pending|temporarily_unavailable|unknown_yet)/.test(evidenceState);
  const actionContinuation = decideJournalContinuation(row, details, {
    status: optionalAbsent ? 'optional_target_absent' : outcome,
    optionalTargetAbsent: optionalAbsent,
    failureProven: outcome === 'failed' && !temporaryEvidence,
  });
  const reason = redactSensitiveText(authoritativeProof
    ? firstDefined(authoritativeProof.proof.reason, authoritativeProof.proof.evidence, null)
    : firstDefined(
      details.reason,
      details.error,
      operationEvidence?.reason,
      operationEvidence?.message,
      optionalAbsent ? 'Optional target was absent; execution continued.' : null,
      outcome === 'failed' ? details.evidence : null,
    ));
  const observedState = firstDefined(details.observedState, details.observed, details.actual, undefined);
  const expectedState = firstDefined(details.expectedState, details.expected, undefined);
  const reconciledFailure = requestedOutcome === 'failed' && authoritativeProof;
  const reconciliationHistory = reconciledFailure
    ? [
        ...(row.reconciliationHistory || []),
        redactSensitiveValues({
          kind: 'authoritative_operation_proof',
          source: authoritativeProof.source,
          priorActionOutcome: row.actionOutcome || requestedOutcome,
          priorExecutionError: row.executionError === true || details.executionError === true,
          priorFailureType: row.failureType || failureType || null,
          proof: authoritativeProof.proof,
        }, {
          forceSensitive: row.hasSensitiveBindings === true,
          redactValueFields: true,
        }),
      ]
    : (row.reconciliationHistory || []);

  next[index] = {
    ...row,
    required,
    actionOutcome: outcome,
    assertionOutcome: optionalAbsent
      ? (row.assertionOutcome || 'not_applicable')
      : row.assertionOutcome,
    executionError,
    executionErrorReason: executionError ? (reason || 'Required browser action did not complete.') : null,
    retryExhausted: outcome === 'succeeded' ? false : row.retryExhausted,
    invalidatedByStepId: outcome === 'succeeded' ? null : row.invalidatedByStepId,
    recoveryWaitingForStepId: outcome === 'succeeded' ? null : row.recoveryWaitingForStepId,
    failureType: optionalAbsent
      ? (failureType || 'optional_absent')
      : outcome === 'failed'
        ? ownership.failureType
        : null,
    failureOwner,
    expectedState: expectedState === undefined ? row.expectedState : redactSensitiveValues(expectedState, { forceSensitive: row.hasSensitiveBindings === true, redactValueFields: true, redactRoot: row.hasSensitiveBindings === true }),
    observedState: observedState === undefined ? row.observedState : redactSensitiveValues(observedState, { forceSensitive: row.hasSensitiveBindings === true, redactValueFields: true, redactRoot: row.hasSensitiveBindings === true }),
    durationMs: details.durationMs == null ? row.durationMs : Number(details.durationMs),
    evidence: details.evidence == null ? row.evidence : redactSensitiveValues(details.evidence, { forceSensitive: row.hasSensitiveBindings === true, redactValueFields: true }),
    reconciliationHistory,
    error: outcome === 'failed' ? (reason || 'Action failed.') : null,
    failureImpact: optionalAbsent
      ? 'optional_absent'
      : outcome === 'failed'
        ? executionError ? 'execution_error' : ownership.failureType
        : null,
    continuationOutcome: actionContinuation.journalOutcome,
    continuationReason: reason
      || (optionalAbsent ? 'Optional target was absent; execution continued.' : null)
      || (outcome === 'failed' ? actionContinuation.decision.reason : null),
    continuationPolicyDecision: compactContinuationPolicyDecision(actionContinuation.decision),
    affectedDescendantStepIds: outcome === 'succeeded' ? [] : row.affectedDescendantStepIds,
  };

  if (openerProofDelegated) {
    next[index] = {
      ...next[index],
      actionOutcome: 'succeeded',
      assertionOutcome: row.assertionOutcome || 'not_applicable',
      executionError: false,
      executionErrorReason: null,
      failureType: null,
      failureOwner: null,
      failureImpact: 'synchronization_delegated',
      continuationOutcome: 'continue',
      continuationReason: 'control_opener_proof_delegated_to_typed_transaction',
      error: null,
    };
    next = releaseDescendants(next, index);
    return refreshStatuses(next);
  }

  if (attachedAssertion) {
    const attachedContinuation = decideJournalContinuation(row, details, {
      kind: attachedVerifyKind === 'action_completed' ? continuationNodeKindForRow(row) : 'assertion',
      status: attachedAssertionMiss ? 'mismatch' : 'matched',
      failureProven: attachedAssertionMiss && attachedVerifyKind === 'action_completed',
    });
    const blocking = attachedContinuation.decision.blockDependents === true;
    const assertionRecord = redactSensitiveValues({
      assertionId: firstDefined(operationEvidence.assertionId, operationEvidence.id, null),
      kind: attachedVerifyKind,
      outcome: attachedAssertionMiss ? 'not_matched' : 'matched',
      matched: !attachedAssertionMiss,
      reason: firstDefined(operationEvidence.reason, details.reason, null),
      evidence: operationEvidence.evidence || null,
      expected: operationEvidence.expected,
      observed: operationEvidence.observed,
      source: 'action_postcondition',
    }, { forceSensitive: row.hasSensitiveBindings === true, redactValueFields: true });
    const assertionOutcomes = [...(row.assertionOutcomes || []), assertionRecord];
    next[index] = {
      ...next[index],
      assertionOutcomes,
      assertionOutcome: aggregateAssertionOutcome(assertionOutcomes),
      failureImpact: attachedAssertionMiss
        ? (blocking ? 'blocks_descendants' : 'validation_only')
        : null,
      continuationOutcome: attachedContinuation.journalOutcome,
      continuationReason: attachedAssertionMiss
          ? (reason || 'Attached validation did not match; browser action execution remains successful.')
          : null,
      continuationPolicyDecision: compactContinuationPolicyDecision(attachedContinuation.decision),
      error: null,
      executionError: false,
      executionErrorReason: null,
      failureType: null,
      failureOwner: null,
    };
    next = attachedAssertionMiss && blocking
      ? stopDescendants(next, index, reason)
      : releaseDescendants(next, index);
    return refreshStatuses(next);
  }

  if (outcome === 'failed' && actionContinuation.journalOutcome === 'stop_case') {
    next = stopCase(next, index, reason);
  } else if (outcome === 'failed' && actionContinuation.journalOutcome === 'stop_descendants') {
    next = stopDescendants(next, index, reason, {
      continueIndependent: actionContinuation.decision.continueIndependent === true,
      scope: actionContinuation.decision.scope,
      failureClass: failureType,
    });
  } else if (outcome === 'succeeded' || ['continue', 'retry'].includes(actionContinuation.journalOutcome)) {
    next = releaseDescendants(next, index);
  }
  return refreshStatuses(next);
}

function evidenceUncertainPerformedAction(row) {
  if (!row || row.actionOutcome !== 'failed') return false;
  const performed = (Array.isArray(row.attempts) && row.attempts.length > 0)
    || row.evidence != null
    || row.observedState != null
    || row.durationMs != null;
  if (!performed) return false;
  if (row.executionError === true || semanticToken(row.failureOwner) === 'qaai') return true;
  return /(?:uncertain|unconfirmed|inconclusive|evidence|automation|dispatch|locator|selector|resolution)/i.test(
    [row.failureType, row.executionErrorReason, row.error].filter(Boolean).join(' '),
  );
}

function directlyRatifiableActionIndex(journal, assertionIndex, assertionRow, details, outcome) {
  if (outcome !== 'matched' || !isExactAssertionReadback(assertionRow, details)) return -1;
  const assertionLike = assertionRow?.assertionStep === true
    || semanticToken(details.source).includes('readback');
  if (!assertionLike) return -1;
  const dependencies = Array.isArray(assertionRow?.dependencyStepIds)
    ? [...new Set(assertionRow.dependencyStepIds.map(String).filter(Boolean))]
    : [];
  if (dependencies.length !== 1) return -1;
  const predecessorIndex = rowIndexForRef(journal, dependencies[0]);
  if (predecessorIndex < 0 || predecessorIndex === assertionIndex) return -1;
  const predecessor = journal[predecessorIndex];
  const predecessorOrdinal = Number(predecessor?.ordinal || predecessor?.index || predecessorIndex + 1);
  const assertionOrdinal = Number(assertionRow?.ordinal || assertionRow?.index || assertionIndex + 1);
  if (predecessorOrdinal >= assertionOrdinal) return -1;
  return evidenceUncertainPerformedAction(predecessor) ? predecessorIndex : -1;
}

function ratifyEvidenceUncertainAction(journal, actionIndex, assertionRow, assertionRecord) {
  const prior = journal[actionIndex];
  const reason = 'Action effect ratified by a directly dependent exact assertion.';
  const event = redactSensitiveValues({
    kind: 'dependent_exact_assertion_ratification',
    assertionStepId: assertionRow.stepId,
    assertionId: assertionRecord.assertionId || null,
    priorActionOutcome: prior.actionOutcome,
    priorExecutionError: prior.executionError === true,
    priorFailureType: prior.failureType || null,
    priorContinuationOutcome: prior.continuationOutcome || null,
    priorContinuationReason: prior.continuationReason || null,
    reason,
  }, {
    forceSensitive: prior.hasSensitiveBindings === true,
    redactValueFields: true,
  });
  const next = ensureJournal(journal);
  next[actionIndex] = {
    ...prior,
    actionOutcome: 'succeeded',
    executionError: false,
    executionErrorReason: null,
    retryExhausted: false,
    invalidatedByStepId: null,
    recoveryWaitingForStepId: null,
    failureType: null,
    failureOwner: null,
    failureImpact: null,
    continuationOutcome: 'continue',
    continuationReason: reason,
    affectedDescendantStepIds: [],
    error: null,
    reconciledByStepId: assertionRow.stepId,
    reconciliationHistory: [...(prior.reconciliationHistory || []), event],
  };
  return releaseDescendants(next, actionIndex);
}

function recordAssertionOutcome(journal, stepRef, input) {
  let next = ensureJournal(journal);
  const index = requireRowIndex(next, stepRef);
  const row = next[index];
  const details = isObject(input) ? input : { outcome: input };
  const semanticOnlyTooltip = isSemanticOnlyTooltipVisualEvidence(details);
  const optionalAbsent = details.optionalAbsent === true || details.optionalTargetAbsent === true;
  let outcome = optionalAbsent ? 'not_applicable' : normalizedAssertionOutcome(details);
  if (semanticOnlyTooltip && outcome === 'matched') outcome = 'not_matched';
  const safe = redactSensitiveValues(details, {
    forceSensitive: row.hasSensitiveBindings === true,
    redactValueFields: true,
  });
  const record = {
    ...safe,
    assertionId: details.assertionId || details.id || null,
    outcome,
    matched: outcome === 'matched' ? true : outcome === 'not_matched' ? false : null,
    ...(semanticOnlyTooltip ? {
      visualMatched: false,
      semanticMatched: true,
      semanticOnlyVisualEvidence: true,
      reason: 'tooltip_semantic_only_no_visual',
    } : {}),
  };
  delete record.assertionOutcome;
  const ratificationIndex = directlyRatifiableActionIndex(next, index, row, details, outcome);
  const ratifiesAction = ratificationIndex >= 0;
  const assertionOutcomes = [...(row.assertionOutcomes || []), record];
  const mismatch = outcome === 'not_matched' || outcome === 'uncheckable';
  const assertionContinuation = decideJournalContinuation(row, details, {
    kind: 'assertion',
    status: outcome,
    observationBudgetExhausted: outcome === 'uncheckable' && details.observationBudgetExhausted !== false,
  });
  const blocking = assertionContinuation.decision.blockDependents === true;
  const reason = redactSensitiveText(semanticOnlyTooltip
    ? (details.evidence || 'Tooltip text exists in DOM/accessibility metadata, but no rendered visual tooltip was captured.')
    : firstDefined(details.reason, details.evidence, details.error, null));
  const observedState = firstDefined(details.observedState, details.observed, details.actual, undefined);
  const expectedState = firstDefined(details.expectedState, details.expected, undefined);

  next[index] = {
    ...row,
    // An assertion-only step was executed even when its functional result did
    // not match. This keeps execution completion separate from validation.
    actionOutcome: ratifiesAction && row.actionOutcome === 'not_executed'
      ? 'succeeded'
      : (row.actionOutcome || 'succeeded'),
    assertionOutcomes,
    assertionOutcome: aggregateAssertionOutcome(assertionOutcomes),
    expectedState: expectedState === undefined
      ? row.expectedState
      : redactSensitiveValues(expectedState, {
          forceSensitive: row.hasSensitiveBindings === true,
          redactValueFields: true,
          redactRoot: row.hasSensitiveBindings === true,
        }),
    observedState: observedState === undefined
      ? row.observedState
      : redactSensitiveValues(observedState, {
          forceSensitive: row.hasSensitiveBindings === true,
          redactValueFields: true,
          redactRoot: row.hasSensitiveBindings === true,
        }),
    durationMs: details.durationMs == null ? row.durationMs : Number(details.durationMs),
    failureImpact: ratifiesAction
      ? null
      : optionalAbsent
      ? 'optional_absent'
      : mismatch ? (blocking ? 'blocks_descendants' : 'validation_only') : row.failureImpact,
    continuationOutcome: assertionContinuation.journalOutcome,
    continuationReason: ratifiesAction
      ? null
      : (reason
        || assertionContinuation.decision.reason
        || (mismatch ? 'Validation did not match; execution continued.' : row.continuationReason)),
    continuationPolicyDecision: compactContinuationPolicyDecision(assertionContinuation.decision),
    dependencySkipped: ratifiesAction ? false : row.dependencySkipped,
    blockedByStepIds: ratifiesAction
      ? (row.blockedByStepIds || []).filter((stepId) => stepId !== next[ratificationIndex].stepId)
      : row.blockedByStepIds,
    error: null,
  };

  if (ratifiesAction) {
    next = ratifyEvidenceUncertainAction(next, ratificationIndex, next[index], record);
  }
  if (blocking) next = stopDescendants(next, index, reason);
  else next = releaseDescendants(next, index);
  return refreshStatuses(next);
}

function recordContinuationOutcome(journal, stepRef, input) {
  let next = ensureJournal(journal);
  const index = requireRowIndex(next, stepRef);
  const row = next[index];
  const details = isObject(input) ? input : { outcome: input };
  const outcome = normalizedContinuationOutcome(details);
  const reason = redactSensitiveText(firstDefined(details.reason, details.evidence, null));
  next[index] = {
    ...row,
    continuationOutcome: outcome,
    continuationReason: reason || row.continuationReason,
  };

  if (outcome === 'stop_descendants') {
    next = stopDescendants(next, index, reason);
  } else if (outcome === 'stop_case') {
    next = stopCase(next, index, reason);
  } else {
    next = releaseDescendants(next, index);
  }
  return refreshStatuses(next);
}

function dependencySatisfied(row) {
  if (!row || row.dependencySkipped || row.actionOutcome === 'not_executed') return false;
  if (row.continuationOutcome === 'retry') return false;
  if (row.actionOutcome === 'succeeded') return true;
  if (row.actionOutcome === 'failed') return row.continuationOutcome === 'continue';
  return false;
}

function selectNextRunnableStep(journal) {
  if (!Array.isArray(journal)) throw new TypeError('execution journal must be an array');
  // Never let storage/consumer array order redefine execution order. Stable
  // step IDs carry dependency identity; ordinal only provides deterministic
  // plan ordering when choosing among multiple runnable rows.
  const ordered = journal
    .map((row, arrayIndex) => ({ row, arrayIndex }))
    .sort((left, right) => {
      const leftOrdinal = Number(left.row && (left.row.ordinal || left.row.index)) || left.arrayIndex + 1;
      const rightOrdinal = Number(right.row && (right.row.ordinal || right.row.index)) || right.arrayIndex + 1;
      if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
      return String(left.row?.stepId || '').localeCompare(String(right.row?.stepId || ''));
    });
  const byId = new Map(ordered
    .filter(({ row }) => row && row.stepId != null)
    .map(({ row }) => [String(row.stepId), row]));
  const dependenciesReady = (candidate) => (candidate.dependencyStepIds || [])
    .every((dependencyId) => dependencySatisfied(byId.get(String(dependencyId))));
  // A transiently failed current step must be retried before any later pending
  // work. Its actionOutcome remains an honest failed attempt until overwritten
  // by the succeeding retry.
  const retryable = ordered.find(({ row: candidate }) => candidate
    && (candidate.actionOutcome === 'failed' || candidate.actionOutcome === 'succeeded')
    && candidate.continuationOutcome === 'retry'
    && !candidate.dependencySkipped
    && dependenciesReady(candidate));
  const pending = retryable || ordered.find(({ row: candidate }) => candidate
    && candidate.actionOutcome === null
    && !candidate.dependencySkipped
    && dependenciesReady(candidate));
  const row = pending && pending.row;
  return row ? cloneValue(row) : null;
}

function finalizeExecutionJournal(journal, options = {}) {
  let next = ensureJournal(journal);
  const reason = redactSensitiveText(options.reason || 'Case finalized before this planned step executed.');

  // A retry decision is provisional. If the case is being finalized before
  // the retry succeeds, terminalize that failed attempt and its dependants
  // instead of leaving a false pending=0/completed projection.
  for (let index = 0; index < next.length; index += 1) {
    const retryRow = next[index];
    if (retryRow?.continuationOutcome !== 'retry') continue;
    if (retryRow.recoveryWaitingForStepId) {
      next[index] = {
        ...retryRow,
        actionOutcome: retryRow.actionOutcome || 'failed',
        retryExhausted: true,
        executionError: true,
        executionErrorReason: reason,
        failureType: 'prerequisite_recovery_not_completed',
        failureOwner: 'qaai',
        failureImpact: 'execution_error',
        continuationOutcome: 'stop_descendants',
        continuationReason: reason,
        error: reason,
      };
      next = stopDescendants(next, index, reason);
    } else if (retryRow.actionOutcome === 'failed') {
      next = retryRow.required !== false
        ? stopDescendants(next, index, reason)
        : refreshStatuses(next.map((row, rowIndex) => rowIndex === index
          ? { ...row, retryExhausted: true, continuationOutcome: 'continue', continuationReason: reason }
          : row));
    } else {
      next = refreshStatuses(next.map((row, rowIndex) => rowIndex === index
        ? { ...row, retryExhausted: true, continuationOutcome: 'continue', continuationReason: reason }
        : row));
    }
  }
  const byId = new Map(next.map((row) => [row.stepId, row]));

  next = next.map((row) => {
    if (row.actionOutcome !== null) {
      return {
        ...row,
        assertionOutcome: row.assertionOutcome || aggregateAssertionOutcome(row.assertionOutcomes) || 'not_applicable',
        continuationOutcome: row.continuationOutcome
          || (row.actionOutcome === 'failed' && row.required !== false ? 'stop_descendants' : 'continue'),
      };
    }
    const blockers = (row.dependencyStepIds || []).filter((dependencyId) => !dependencySatisfied(byId.get(dependencyId)));
    const dependencySkipped = row.dependencySkipped || blockers.length > 0;
    return {
      ...row,
      actionOutcome: 'not_executed',
      assertionOutcome: row.assertionOutcome || 'not_applicable',
      continuationOutcome: dependencySkipped ? 'stop_descendants' : 'stop_case',
      continuationReason: row.continuationReason || (dependencySkipped
        ? `Dependency did not complete: ${blockers.join(', ')}.`
        : reason),
      failureImpact: row.failureImpact || (dependencySkipped ? 'dependency_skipped' : 'not_executed'),
      dependencySkipped,
      blockedByStepIds: [...new Set([...(row.blockedByStepIds || []), ...blockers])],
      error: null,
    };
  });
  return refreshStatuses(next);
}

function projectExecutionJournal(journal) {
  if (!Array.isArray(journal)) throw new TypeError('execution journal must be an array');
  let executed = 0;
  let passed = 0;
  let validationFailed = 0;
  let validationUncheckable = 0;
  let executionErrors = 0;
  let dependencySkipped = 0;
  let notExecuted = 0;
  let pending = 0;
  let productFailures = 0;
  let actionSucceeded = 0;
  let actionFailed = 0;
  let retryPending = 0;

  for (const row of journal) {
    const action = row && row.actionOutcome;
    const assertions = latestAssertionOutcomes(Array.isArray(row && row.assertionOutcomes) ? row.assertionOutcomes : []);
    const mismatchCount = assertions.filter((item) => item && item.outcome === 'not_matched').length
      || (row && row.assertionOutcome === 'not_matched' ? 1 : 0);
    const uncheckableCount = assertions.filter((item) => item && item.outcome === 'uncheckable').length
      || (row && row.assertionOutcome === 'uncheckable' ? 1 : 0);
    validationFailed += mismatchCount;
    validationUncheckable += uncheckableCount;

    if (action === 'succeeded' || action === 'failed') executed += 1;
    else if (action === 'not_executed') notExecuted += 1;
    else pending += 1;

    if (action === 'succeeded') actionSucceeded += 1;
    if (action === 'failed') actionFailed += 1;
    if (row && row.continuationOutcome === 'retry') retryPending += 1;

    if (row && row.dependencySkipped) dependencySkipped += 1;
    if (row && row.executionError) executionErrors += 1;
    if (action === 'failed' && !(row && row.executionError)) productFailures += 1;
    if (action === 'succeeded' && mismatchCount === 0 && uncheckableCount === 0 && !(row && row.executionError)) passed += 1;
  }

  const planned = journal.length;
  const allPlannedExecuted = executed === planned && notExecuted === 0 && pending === 0;
  const executionCompleted = allPlannedExecuted && retryPending === 0;
  const executionFinalized = pending === 0 && retryPending === 0;

  return {
    planned,
    executed,
    actionSucceeded,
    actionFailed,
    passed,
    validationFailed,
    executionErrors,
    dependencySkipped,
    notExecuted,
    pending,
    retryPending,
    productFailures,
    validationUncheckable,
    allPlannedExecuted,
    executionCompleted,
    executionIncomplete: !executionCompleted,
    executionFinalized,
  };
}

module.exports = {
  JOURNAL_VERSION,
  REDACTED,
  ACTION_OUTCOMES: [...ACTION_OUTCOMES],
  ASSERTION_OUTCOMES: [...ASSERTION_OUTCOMES],
  CONTINUATION_OUTCOMES: [...CONTINUATION_OUTCOMES],
  initializeExecutionJournal,
  recordAttempt,
  recordActionOutcome,
  recordAssertionOutcome,
  recordContinuationOutcome,
  schedulePrerequisiteRetry,
  selectNextRunnableStep,
  finalizeExecutionJournal,
  projectExecutionJournal,
  latestAssertionOutcomes,
  deriveLegacyStatus,
  redactSensitiveValues,
  _descendantStepIds: descendantStepIds,
};
