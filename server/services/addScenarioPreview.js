'use strict';

const crypto = require('node:crypto');

const PREVIEW_VERSION = 'AddScenarioPreviewV1';
const PREVIEW_STATUS = Object.freeze({
  READY: 'ready_for_review',
  NEEDS_REVIEW: 'needs_review',
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableSerialize(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return `sha256-${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function text(value, max = 1_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeFindings(entries) {
  return (Array.isArray(entries) ? entries : []).slice(0, 100).map((entry, index) => ({
    id: `finding.${index + 1}`,
    code: text(entry && entry.code, 160) || 'semantic_review_required',
    path: text(entry && entry.path, 300) || '$',
    detail: text(entry && (entry.detail || entry.message), 1_000) || 'Review is required before approval.',
    severity: text(entry && entry.severity, 40) || 'error',
  }));
}

function sourceOrder(record, fallback) {
  const span = record && record.sourceSpan;
  return Number.isInteger(span && span.start) ? span.start : Number.MAX_SAFE_INTEGER - 10_000 + fallback;
}

function orderedOperations(caseContract) {
  const steps = (Array.isArray(caseContract && caseContract.steps) ? caseContract.steps : [])
    .map((record, index) => ({
      kind: 'action',
      ordinal: index + 1,
      sourceOrder: sourceOrder(record, index),
      record: clone(record),
    }));
  const assertions = (Array.isArray(caseContract && caseContract.assertions) ? caseContract.assertions : [])
    .map((record, index) => ({
      kind: 'assertion',
      ordinal: index + 1,
      sourceOrder: sourceOrder(record, steps.length + index),
      record: clone(record),
    }));
  return [...steps, ...assertions]
    .sort((left, right) => left.sourceOrder - right.sourceOrder
      || (left.kind === right.kind ? left.ordinal - right.ordinal : left.kind.localeCompare(right.kind)))
    .map((entry, index) => ({
      ordinal: index + 1,
      kind: entry.kind,
      ...entry.record,
    }));
}

function literalDisplay(caseContract) {
  const output = [];
  const add = (recordId, field, value, classification = 'normal') => {
    if (!['string', 'number', 'boolean'].includes(typeof value) || value === '') return;
    output.push({ recordId: recordId || null, field, value, classification });
  };
  for (const step of (Array.isArray(caseContract && caseContract.steps) ? caseContract.steps : [])) {
    if (Object.prototype.hasOwnProperty.call(step || {}, 'value')) add(step.id, 'value', step.value);
    if (step && step.valueRef) add(step.id, 'valueRef', step.valueRef, 'reference');
    const selection = step && step.selectionCriteria;
    if (selection && selection.text) add(step.id, 'selection.text', selection.text);
    if (selection && Object.prototype.hasOwnProperty.call(selection, 'value')) add(step.id, 'selection.value', selection.value);
    if (selection && Number.isInteger(selection.ordinal)) add(step.id, 'selection.ordinal', selection.ordinal);
  }
  for (const assertion of (Array.isArray(caseContract && caseContract.assertions) ? caseContract.assertions : [])) {
    const operands = assertion && assertion.payload && Array.isArray(assertion.payload.operands)
      ? assertion.payload.operands : [];
    for (const operand of operands) {
      if (!operand || operand.role !== 'expected') continue;
      if (Object.prototype.hasOwnProperty.call(operand, 'value')) add(assertion.id, 'expected', operand.value);
      if (Array.isArray(operand.items)) operand.items.forEach((item, index) => add(assertion.id, `expected.items[${index}]`, item));
      if (operand.ref) add(assertion.id, 'expectedRef', operand.ref, 'reference');
    }
  }
  return output;
}

function previewCase(caseContract, index) {
  const steps = clone(Array.isArray(caseContract && caseContract.steps) ? caseContract.steps : []);
  const assertions = clone(Array.isArray(caseContract && caseContract.assertions) ? caseContract.assertions : []);
  const authority = {
    id: caseContract && caseContract.id || null,
    name: caseContract && caseContract.name || `Case ${index + 1}`,
    intent: caseContract && caseContract.intent || null,
    initialState: caseContract && caseContract.initialState || null,
    expectedFinalState: caseContract && caseContract.expectedFinalState || null,
    sessionRequirement: caseContract && caseContract.sessionRequirement || null,
    dependencies: caseContract && caseContract.dependencies || [],
    failurePolicy: caseContract && caseContract.failurePolicy || null,
    steps,
    assertions,
  };
  return {
    id: authority.id || `preview-case.${index + 1}`,
    ordinal: index + 1,
    revision: digest(stableSerialize(authority)),
    name: authority.name,
    intent: authority.intent,
    initialState: clone(authority.initialState),
    expectedFinalState: clone(authority.expectedFinalState),
    continuation: clone(authority.sessionRequirement),
    dependencies: clone(authority.dependencies),
    failurePolicy: clone(authority.failurePolicy),
    steps,
    assertions,
    orderedOperations: orderedOperations(caseContract),
    inlineLiterals: literalDisplay(caseContract),
  };
}

function previewClarifications(envelope, error, sourceCompleteness) {
  const authored = (Array.isArray(envelope && envelope.clarifications) ? envelope.clarifications : [])
    .map((entry, index) => ({
      id: entry && entry.id || `clarification.${index + 1}`,
      question: text(entry && entry.question) || 'Please clarify the authored behavior.',
      reason: text(entry && entry.reason) || 'The requested behavior cannot be compiled safely yet.',
      blocking: true,
      sourceQuote: entry && entry.sourceQuote || null,
      sourceSpan: clone(entry && entry.sourceSpan || null),
      affectedRecord: clone(entry && entry.affectedRecord || null),
    }));
  const findings = safeFindings([
    ...(Array.isArray(sourceCompleteness && sourceCompleteness.findings) ? sourceCompleteness.findings : []),
    ...(Array.isArray(error && error.findings) ? error.findings : []),
  ]);
  return {
    questions: authored,
    findings,
    error: error ? {
      code: text(error.code, 160) || 'ADD_SCENARIO_REVIEW_REQUIRED',
      message: text(error.message, 1_000) || 'Review is required before approval.',
    } : null,
  };
}

function buildAddScenarioPreview({
  projectId,
  currentGenerationId = null,
  sourceText = '',
  semanticPlan = null,
  error = null,
} = {}) {
  const source = typeof sourceText === 'string' ? sourceText : '';
  const effectiveSource = semanticPlan && typeof semanticPlan.authoritativeSourceText === 'string'
    ? semanticPlan.authoritativeSourceText
    : source;
  const envelope = semanticPlan && (semanticPlan.caseContractV1 || semanticPlan.envelope) || null;
  const sourceCompleteness = semanticPlan && semanticPlan.sourceCompleteness
    || error && error.sourceCompleteness
    || null;
  const cases = (Array.isArray(envelope && envelope.cases) ? envelope.cases : []).map(previewCase);
  const clarifications = previewClarifications(envelope, error, sourceCompleteness);
  const complete = sourceCompleteness && sourceCompleteness.complete === true;
  const ready = !error && complete && cases.length > 0
    && clarifications.questions.length === 0 && clarifications.findings.length === 0;
  const identityAuthority = {
    version: PREVIEW_VERSION,
    projectId: projectId || null,
    currentGenerationId: currentGenerationId || null,
    sourceDigest: digest(source),
  };
  const scenarioName = cases[0] && cases[0].name || 'Add Scenario preview';
  const scenario = {
    id: `preview-scenario.${digest(`${scenarioName}|${identityAuthority.sourceDigest}`).slice(7, 23)}`,
    ordinal: 1,
    name: scenarioName,
    cases,
  };
  const revisionAuthority = {
    identityAuthority,
    envelope,
    sourceCompleteness,
    clarifications,
  };
  const preview = {
    version: PREVIEW_VERSION,
    previewId: `add-scenario-preview.${digest(stableSerialize(identityAuthority)).slice(7, 31)}`,
    revision: digest(stableSerialize(revisionAuthority)),
    status: ready ? PREVIEW_STATUS.READY : PREVIEW_STATUS.NEEDS_REVIEW,
    approvalEligible: ready,
    persistence: {
      status: 'not_persisted',
      currentGenerationId: currentGenerationId || null,
      scenarioCountCreated: 0,
      caseCountCreated: 0,
    },
    source: {
      digest: identityAuthority.sourceDigest,
      text: source,
      effectiveDigest: digest(effectiveSource),
      effectiveText: effectiveSource,
      refinements: clone(Array.isArray(envelope && envelope.refinementLedger) ? envelope.refinementLedger : []),
      clauses: clone(Array.isArray(envelope && envelope.sourceClauses) ? envelope.sourceClauses : []),
      coverage: clone(Array.isArray(envelope && envelope.sourceCoverage) ? envelope.sourceCoverage : []),
      completeness: clone(sourceCompleteness),
    },
    scenarios: cases.length ? [scenario] : [],
    clarifications,
    metadata: {
      providerAttempts: Number(semanticPlan && semanticPlan.metadata && semanticPlan.metadata.attempts) || null,
      semanticPlanVersion: semanticPlan && (
        semanticPlan.semanticIntentPlanV1 && semanticPlan.semanticIntentPlanV1.version
        || semanticPlan.semanticIntentPlan && semanticPlan.semanticIntentPlan.version
      ) || null,
    },
  };
  return deepFreeze(preview);
}

module.exports = {
  PREVIEW_VERSION,
  PREVIEW_STATUS,
  buildAddScenarioPreview,
  _private: {
    stableSerialize,
    orderedOperations,
    literalDisplay,
  },
};
