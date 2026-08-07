const ACTION_OUTCOMES = new Set(['succeeded', 'failed', 'not_executed']);
const ASSERTION_OUTCOMES = new Set(['matched', 'not_matched', 'uncheckable', 'not_applicable']);
const CONTINUATION_OUTCOMES = new Set(['continue', 'retry', 'stop_descendants', 'stop_case']);

const asArray = value => (Array.isArray(value) ? value : []);

const firstPresent = (...values) => values.find(value => value !== undefined && value !== null && value !== '');

const normalizeStatus = value => String(value || '').trim().toLowerCase();

const plannedStepId = (step, index) => String(firstPresent(step?.stepId, step?.id, step?.nodeId, `step-${index + 1}`));

const plannedStepText = step => String(firstPresent(
  step?.plannedText,
  step?.text,
  step?.description,
  step?.name,
  step?.title,
  step?.action,
  ''
));

const getOrdinal = (row, fallback) => {
  const candidate = Number(firstPresent(row?.ordinal, row?.index, row?.stepIndex));
  return Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
};

const normalizeAssertion = (assertion, index, row = {}) => {
  const rawOutcome = normalizeStatus(firstPresent(assertion?.outcome, assertion?.assertionOutcome, assertion?.status));
  const outcome = ASSERTION_OUTCOMES.has(rawOutcome)
    ? rawOutcome
    : rawOutcome === 'pass' || assertion?.matched === true
      ? 'matched'
      : rawOutcome === 'fail' || assertion?.matched === false
        ? 'not_matched'
        : 'uncheckable';

  return {
    ...assertion,
    id: String(firstPresent(assertion?.id, assertion?.assertionId, `${row.stepId || 'step'}-assertion-${index + 1}`)),
    outcome,
    expected: firstPresent(assertion?.expected, assertion?.expectedValue, assertion?.expectedState, row.expected, row.expectedState),
    actual: firstPresent(assertion?.actual, assertion?.actualValue, assertion?.observed, assertion?.observedValue, assertion?.observedState, row.actual, row.observedState),
    comparator: firstPresent(assertion?.comparator, assertion?.operator, assertion?.comparison, row.comparator),
    reason: firstPresent(assertion?.reason, assertion?.message, assertion?.error, row.assertionReason, row.reason),
    evidence: firstPresent(assertion?.evidence, assertion?.evidenceRef, assertion?.evidenceReferences, assertion?.screenshotRef, assertion?.traceRef),
  };
};

const assertionCandidates = row => {
  const direct = [row?.assertions, row?.assertionResults, row?.checks, row?.checkOutcomes, row?.assertionOutcomes]
    .find(Array.isArray);
  if (direct) return direct;
  const scalar = firstPresent(row?.assertionOutcome, row?.checkOutcome);
  return scalar && normalizeStatus(scalar) !== 'not_applicable' ? [{
    outcome: scalar,
    expected: firstPresent(row?.expected, row?.expectedState),
    actual: firstPresent(row?.actual, row?.observedState),
    comparator: row?.comparator,
    reason: firstPresent(row?.assertionReason, row?.reason, row?.error),
    evidence: row?.evidence,
  }] : [];
};

const inferActionOutcome = (row, assertions) => {
  const explicit = normalizeStatus(row?.actionOutcome);
  if (ACTION_OUTCOMES.has(explicit)) return explicit;
  const status = normalizeStatus(row?.status);
  if (['skipped', 'not_executed', 'pending'].includes(status)) return 'not_executed';
  if (['blocked', 'error', 'execution_error'].includes(status)) return 'failed';
  if (status === 'fail' || status === 'failed') {
    return assertions.some(assertion => assertion.outcome === 'not_matched') ? 'succeeded' : 'failed';
  }
  if (['pass', 'passed', 'success', 'succeeded'].includes(status)) return 'succeeded';
  return 'not_executed';
};

const inferContinuationOutcome = (row, actionOutcome, assertions) => {
  const explicit = normalizeStatus(row?.continuationOutcome);
  if (CONTINUATION_OUTCOMES.has(explicit)) return explicit;
  if (actionOutcome === 'not_executed') return 'stop_descendants';
  if (actionOutcome === 'failed') return row?.stopCase ? 'stop_case' : 'stop_descendants';
  if (assertions.some(assertion => assertion.outcome === 'not_matched')) return 'continue';
  return 'continue';
};

const isExecutionError = (row, actionOutcome) => {
  if (row?.executionError === true || row?.qaaiExecutionError === true) return true;
  const failureType = normalizeStatus(firstPresent(row?.failureType, row?.errorType, row?.failureCategory));
  if (failureType.includes('execution') || failureType.includes('qaai')) return true;
  return actionOutcome === 'failed' && normalizeStatus(row?.status) === 'blocked';
};

const deriveLegacyStatus = ({ actionOutcome, assertionOutcome, executionError, rawStatus }) => {
  if (actionOutcome === 'not_executed') return normalizeStatus(rawStatus) === 'pending' ? 'pending' : 'skipped';
  if (executionError) return 'blocked';
  if (actionOutcome === 'failed') return 'fail';
  if (assertionOutcome === 'not_matched') return 'fail';
  if (assertionOutcome === 'uncheckable') return 'blocked';
  return actionOutcome === 'succeeded' ? 'pass' : normalizeStatus(rawStatus) || 'pending';
};

export function normalizeExecutionStep(row = {}, fallbackOrdinal = 1) {
  const ordinal = getOrdinal(row, fallbackOrdinal);
  const stepId = String(firstPresent(row.stepId, row.id, row.nodeId, `step-${ordinal}`));
  const assertions = assertionCandidates(row).map((assertion, index) => normalizeAssertion(assertion, index, { ...row, stepId }));
  const actionOutcome = inferActionOutcome(row, assertions);
  const continuationOutcome = inferContinuationOutcome(row, actionOutcome, assertions);
  const executionError = isExecutionError(row, actionOutcome);
  const failureType = firstPresent(row.failureType, row.failureImpact, executionError ? 'qaai_execution_error' : undefined);
  const dependencySkipped = row.dependencySkipped === true || normalizeStatus(failureType).includes('dependency');
  const assertionOutcome = assertions.length === 0
    ? 'not_applicable'
    : assertions.some(assertion => assertion.outcome === 'not_matched')
      ? 'not_matched'
      : assertions.some(assertion => assertion.outcome === 'uncheckable')
        ? 'uncheckable'
        : assertions.every(assertion => assertion.outcome === 'matched')
          ? 'matched'
          : 'not_applicable';

  return {
    ...row,
    stepId,
    ordinal,
    plannedText: plannedStepText(row),
    boundDataReferences: asArray(firstPresent(row.boundDataReferences, row.dataBindings, row.boundDataRefs)),
    attempts: asArray(firstPresent(row.attempts, row.attemptHistory)),
    expectedState: firstPresent(row.expectedState, row.expected),
    observedState: firstPresent(row.observedState, row.actual),
    actionOutcome,
    assertions,
    assertionOutcome,
    continuationOutcome,
    continuationReason: firstPresent(row.continuationReason, row.reason, row.error),
    affectedDescendantSteps: asArray(firstPresent(row.affectedDescendantSteps, row.affectedDescendants, row.blockedDescendants)),
    evidence: firstPresent(row.evidence, row.evidenceRefs, row.screenshotRef, row.traceRef),
    executionError,
    failureType,
    dependencySkipped,
    status: deriveLegacyStatus({ actionOutcome, assertionOutcome, executionError, rawStatus: row.status }),
  };
}

const resultKeyCandidates = (row, index) => [
  row?.stepId,
  row?.id,
  row?.nodeId,
  getOrdinal(row, index + 1),
].filter(value => value !== undefined && value !== null && value !== '');

export function normalizeExecutionJournal(stepResults = [], plannedSteps = []) {
  const sourceResults = asArray(stepResults);
  const sourcePlanned = asArray(plannedSteps);
  const byKey = new Map();

  sourceResults.forEach((row, index) => {
    resultKeyCandidates(row, index).forEach(key => byKey.set(String(key), row));
  });

  const consumed = new Set();
  const rows = sourcePlanned.map((step, index) => {
    const ordinal = index + 1;
    const id = plannedStepId(step, index);
    const result = byKey.get(id) || byKey.get(String(ordinal));
    if (result) {
      consumed.add(result);
      return normalizeExecutionStep({
        ...step,
        ...result,
        stepId: firstPresent(result.stepId, result.id, id),
        ordinal,
        plannedText: firstPresent(result.plannedText, plannedStepText(step)),
      }, ordinal);
    }

    return normalizeExecutionStep({
      ...step,
      stepId: id,
      ordinal,
      plannedText: plannedStepText(step),
      status: 'skipped',
      actionOutcome: 'not_executed',
      assertionOutcome: 'not_applicable',
      continuationOutcome: 'stop_descendants',
      continuationReason: 'No execution journal result was recorded for this planned step.',
      failureType: 'dependency_skipped',
      dependencySkipped: true,
      affectedDescendantSteps: [],
    }, ordinal);
  });

  sourceResults.forEach((result, index) => {
    if (!consumed.has(result)) rows.push(normalizeExecutionStep(result, sourcePlanned.length + index + 1));
  });

  return rows.sort((left, right) => left.ordinal - right.ordinal);
}

export function projectExecutionJournal(stepResults = [], plannedSteps = []) {
  const rows = normalizeExecutionJournal(stepResults, plannedSteps);
  const summary = {
    planned: rows.length,
    executed: 0,
    passed: 0,
    validationFailed: 0,
    validationUncheckable: 0,
    executionErrors: 0,
    dependencySkipped: 0,
    notExecuted: 0,
    pending: 0,
    productFailures: 0,
    executionCompleted: true,
  };

  rows.forEach(row => {
    if (row.actionOutcome === 'not_executed') {
      summary.notExecuted += 1;
      if (row.dependencySkipped || normalizeStatus(row.failureType).includes('dependency') || row.affectedDescendantSteps.length > 0) {
        summary.dependencySkipped += 1;
      }
      if (normalizeStatus(row.status) === 'pending') summary.pending += 1;
      return;
    }

    summary.executed += 1;
    if (row.executionError) summary.executionErrors += 1;
    if (!row.executionError && row.actionOutcome === 'failed') summary.productFailures += 1;
    const mismatchCount = row.assertions.filter(assertion => assertion.outcome === 'not_matched').length;
    const uncheckableCount = row.assertions.filter(assertion => assertion.outcome === 'uncheckable').length;
    if (mismatchCount > 0) summary.validationFailed += mismatchCount;
    else if (row.assertionOutcome === 'not_matched') summary.validationFailed += 1;
    if (uncheckableCount > 0) summary.validationUncheckable += uncheckableCount;
    else if (row.assertionOutcome === 'uncheckable') summary.validationUncheckable += 1;
    if (row.actionOutcome === 'succeeded' && !['not_matched', 'uncheckable'].includes(row.assertionOutcome)) {
      summary.passed += 1;
    }
  });

  summary.executionCompleted = summary.pending === 0;
  return { rows, summary };
}

export function continuationLabel(row = {}) {
  const outcome = normalizeStatus(row.continuationOutcome);
  if (outcome === 'continue') return 'Continued';
  if (outcome === 'retry') return 'Retried';
  if (outcome === 'stop_case') return 'Stopped case';
  if (outcome === 'stop_descendants') return 'Stopped dependent steps';
  return '';
}
