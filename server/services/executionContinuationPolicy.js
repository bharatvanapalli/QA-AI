'use strict';

const CONTINUATION_OUTCOME = Object.freeze({
  CONTINUE: 'continue',
  BLOCK_DEPENDENTS: 'block_dependents',
  RETRY_OBSERVATION: 'retry_observation',
  ENVIRONMENT_ISSUE: 'environment_issue',
  STOP_RUN: 'stop_run',
});

const EXECUTION_NODE_KIND = Object.freeze({
  WAIT_FOR_STATE: 'wait_for_state',
  ASSERTION: 'assertion',
  ACTION: 'action',
  NAVIGATION: 'navigation',
  SESSION: 'session',
  ENVIRONMENT: 'environment',
  UNKNOWN: 'unknown',
});

const STEP_VERDICT = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  UNVERIFIED: 'unverified',
  NONE: null,
});

const SUCCESS_STATES = new Set([
  'complete',
  'completed',
  'matched',
  'pass',
  'passed',
  'ready',
  'satisfied',
  'success',
  'succeeded',
]);

const FAILURE_STATES = new Set([
  'blocked',
  'failed',
  'failure',
  'mismatch',
  'not_matched',
  'not_satisfied',
  'unavailable',
]);

const TEMPORARY_EVIDENCE_STATES = new Set([
  'capture_pending',
  'evidence_pending',
  'evidence_temporarily_unavailable',
  'pending',
  'snapshot_pending',
  'snapshot_temporarily_unavailable',
  'temporarily_unavailable',
  'unknown_yet',
]);

const WAIT_ALIASES = new Set([
  'wait',
  'wait_for',
  'wait_for_state',
  'waitforstate',
  'synchronize',
  'synchronization',
]);

const ASSERTION_ALIASES = new Set([
  'assert',
  'assert_count',
  'assert_text',
  'assert_ui',
  'assert_visible',
  'assertion',
  'check',
  'count',
  'text',
  'ui_match',
  'validate',
  'verification',
  'verify',
  'visual',
]);

const NAVIGATION_ALIASES = new Set([
  'navigate',
  'navigation',
  'page_transition',
  'redirect',
]);

const SESSION_ALIASES = new Set([
  'auth',
  'authentication',
  'browser_session',
  'session',
  'session_continuation',
]);

const ENVIRONMENT_ALIASES = new Set([
  'browser_environment',
  'environment',
  'external_site',
  'infrastructure',
  'network',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeNodeKind(input = {}) {
  const raw = firstDefined(input.nodeKind, input.kind, input.type, input.action, input.operation);
  const token = normalizeToken(raw);
  if (WAIT_ALIASES.has(token)) return EXECUTION_NODE_KIND.WAIT_FOR_STATE;
  if (ASSERTION_ALIASES.has(token) || token.startsWith('assert_')) return EXECUTION_NODE_KIND.ASSERTION;
  if (NAVIGATION_ALIASES.has(token)) return EXECUTION_NODE_KIND.NAVIGATION;
  if (SESSION_ALIASES.has(token)) return EXECUTION_NODE_KIND.SESSION;
  if (ENVIRONMENT_ALIASES.has(token)) return EXECUTION_NODE_KIND.ENVIRONMENT;
  if (token) return EXECUTION_NODE_KIND.ACTION;
  return EXECUTION_NODE_KIND.UNKNOWN;
}

function normalizeState(input = {}) {
  return normalizeToken(firstDefined(
    input.status,
    input.state,
    input.result,
    input.outcome,
    input.verdict,
    input.evidenceStatus,
  ));
}

function isSuccess(input = {}) {
  if (input.success === true || input.matched === true || input.satisfied === true) return true;
  return SUCCESS_STATES.has(normalizeState(input));
}

function isFailure(input = {}) {
  if (input.success === false || input.matched === false || input.satisfied === false) return true;
  return FAILURE_STATES.has(normalizeState(input));
}

function isTemporarilyUnavailable(input = {}) {
  const observation = isObject(input.observation) ? input.observation : {};
  const evidence = isObject(input.evidence) ? input.evidence : {};
  if (
    input.temporarilyUnavailable === true
    || observation.temporarilyUnavailable === true
    || evidence.temporarilyUnavailable === true
  ) return true;
  return [
    normalizeState(input),
    normalizeState(observation),
    normalizeState(evidence),
  ].some((state) => TEMPORARY_EVIDENCE_STATES.has(state));
}

function observationBudgetExhausted(input = {}) {
  const observation = isObject(input.observation) ? input.observation : {};
  return Boolean(
    input.observationBudgetExhausted
    || input.retryBudgetExhausted
    || observation.budgetExhausted
    || observation.retryBudgetExhausted
  );
}

function isOptionalTargetAbsent(input = {}) {
  const target = isObject(input.target) ? input.target : {};
  const state = normalizeState(input);
  return Boolean(
    input.optionalTargetAbsent === true
    || (input.optional === true && (input.targetPresent === false || target.present === false))
    || (input.optional === true && ['absent', 'not_present', 'optional_target_absent'].includes(state))
  );
}

function isProven(input = {}) {
  const failure = isObject(input.failure) ? input.failure : {};
  return Boolean(input.proven === true || input.failureProven === true || failure.proven === true);
}

function normalizedFailureClass(input = {}) {
  const failure = isObject(input.failure) ? input.failure : {};
  return normalizeToken(firstDefined(
    input.failureClass,
    input.classification,
    failure.classification,
    failure.kind,
  ));
}

function decision(outcome, details = {}) {
  const base = {
    outcome,
    continueExecution: outcome === CONTINUATION_OUTCOME.CONTINUE,
    continueIndependent: outcome !== CONTINUATION_OUTCOME.STOP_RUN,
    blockDependents: outcome === CONTINUATION_OUTCOME.BLOCK_DEPENDENTS,
    retryObservation: outcome === CONTINUATION_OUTCOME.RETRY_OBSERVATION,
    redispatchAction: false,
    stopRun: outcome === CONTINUATION_OUTCOME.STOP_RUN,
    stepVerdict: STEP_VERDICT.NONE,
    scope: 'none',
    reason: 'continuation_policy_default',
  };
  return Object.freeze({ ...base, ...details, outcome });
}

function retryObservation(reason, details = {}) {
  return decision(CONTINUATION_OUTCOME.RETRY_OBSERVATION, {
    ...details,
    continueExecution: false,
    continueIndependent: true,
    retryObservation: true,
    redispatchAction: false,
    scope: 'current_observation',
    reason,
  });
}

function systemImpossibilityDecision(input, kind) {
  const failureClass = normalizedFailureClass(input);
  const proven = isProven(input);
  const impossible = input.impossible === true || input.runImpossible === true;
  const environmentFailure = kind === EXECUTION_NODE_KIND.ENVIRONMENT
    || ['environment', 'external_site', 'infrastructure', 'network'].includes(failureClass);
  const sessionFailure = kind === EXECUTION_NODE_KIND.SESSION
    || ['auth', 'authentication', 'session'].includes(failureClass);

  if (!proven || (!environmentFailure && !sessionFailure)) return null;

  if (impossible) {
    return decision(CONTINUATION_OUTCOME.STOP_RUN, {
      continueExecution: false,
      continueIndependent: false,
      stopRun: true,
      stepVerdict: STEP_VERDICT.FAILED,
      scope: 'run',
      reason: environmentFailure
        ? 'proven_environment_impossibility'
        : 'proven_session_impossibility',
    });
  }

  if (environmentFailure) {
    return decision(CONTINUATION_OUTCOME.ENVIRONMENT_ISSUE, {
      continueExecution: false,
      continueIndependent: true,
      stepVerdict: STEP_VERDICT.UNVERIFIED,
      scope: 'environment',
      reason: 'proven_environment_issue',
    });
  }

  return decision(CONTINUATION_OUTCOME.BLOCK_DEPENDENTS, {
    continueExecution: false,
    continueIndependent: true,
    blockDependents: true,
    stepVerdict: STEP_VERDICT.FAILED,
    scope: 'session_dependents',
    reason: 'proven_session_failure',
  });
}

function waitDecision(input) {
  if (isOptionalTargetAbsent(input)) {
    return decision(CONTINUATION_OUTCOME.CONTINUE, {
      stepVerdict: STEP_VERDICT.SKIPPED,
      synchronizationOnly: true,
      optionalTargetAbsent: true,
      reason: 'optional_target_absent',
    });
  }

  if (isSuccess(input)) {
    return decision(CONTINUATION_OUTCOME.CONTINUE, {
      stepVerdict: STEP_VERDICT.NONE,
      synchronizationOnly: true,
      reason: 'synchronization_satisfied',
    });
  }

  if (!observationBudgetExhausted(input)) {
    return retryObservation('synchronization_pending', {
      stepVerdict: STEP_VERDICT.NONE,
      synchronizationOnly: true,
    });
  }

  return decision(CONTINUATION_OUTCOME.CONTINUE, {
    stepVerdict: STEP_VERDICT.NONE,
    synchronizationOnly: true,
    synchronizationTimedOut: true,
    reason: 'synchronization_budget_exhausted_without_verdict',
  });
}

function assertionDecision(input) {
  if (isTemporarilyUnavailable(input) && !observationBudgetExhausted(input)) {
    return retryObservation('assertion_evidence_temporarily_unavailable', {
      stepVerdict: STEP_VERDICT.NONE,
    });
  }

  if (isSuccess(input)) {
    return decision(CONTINUATION_OUTCOME.CONTINUE, {
      stepVerdict: STEP_VERDICT.PASSED,
      reason: 'assertion_passed',
    });
  }

  if (isFailure(input)) {
    return decision(CONTINUATION_OUTCOME.CONTINUE, {
      stepVerdict: STEP_VERDICT.FAILED,
      nonBlockingValidationFailure: true,
      reason: 'assertion_failed_continue_independent',
    });
  }

  return decision(CONTINUATION_OUTCOME.CONTINUE, {
    stepVerdict: STEP_VERDICT.UNVERIFIED,
    nonBlockingValidationFailure: false,
    reason: observationBudgetExhausted(input)
      ? 'assertion_unverified_after_observation_budget'
      : 'assertion_unverified_without_concrete_mismatch',
  });
}

function actionDecision(input, kind) {
  if (isOptionalTargetAbsent(input)) {
    return decision(CONTINUATION_OUTCOME.CONTINUE, {
      stepVerdict: STEP_VERDICT.SKIPPED,
      optionalTargetAbsent: true,
      reason: 'optional_target_absent',
    });
  }

  if (isTemporarilyUnavailable(input) && !observationBudgetExhausted(input)) {
    return retryObservation('action_evidence_temporarily_unavailable', {
      stepVerdict: STEP_VERDICT.NONE,
    });
  }

  if (isSuccess(input)) {
    return decision(CONTINUATION_OUTCOME.CONTINUE, {
      stepVerdict: STEP_VERDICT.PASSED,
      reason: kind === EXECUTION_NODE_KIND.NAVIGATION
        ? 'navigation_succeeded'
        : 'action_succeeded',
    });
  }

  const required = input.required !== false;
  const inabilityProven = isProven(input) || input.inabilityProven === true;
  if (required && inabilityProven) {
    return decision(CONTINUATION_OUTCOME.BLOCK_DEPENDENTS, {
      continueExecution: false,
      continueIndependent: true,
      blockDependents: true,
      stepVerdict: STEP_VERDICT.FAILED,
      scope: kind === EXECUTION_NODE_KIND.NAVIGATION
        ? 'session_dependents'
        : 'step_dependents',
      reason: kind === EXECUTION_NODE_KIND.NAVIGATION
        ? 'required_navigation_failure_proven'
        : 'required_action_inability_proven',
    });
  }

  if (isTemporarilyUnavailable(input)) {
    return decision(CONTINUATION_OUTCOME.CONTINUE, {
      stepVerdict: STEP_VERDICT.UNVERIFIED,
      reason: 'action_unverified_after_observation_budget',
    });
  }

  if (isFailure(input) && !required) {
    return decision(CONTINUATION_OUTCOME.CONTINUE, {
      stepVerdict: STEP_VERDICT.FAILED,
      reason: 'optional_or_independent_action_failed',
    });
  }

  return retryObservation('action_outcome_not_yet_proven', {
    stepVerdict: STEP_VERDICT.NONE,
  });
}

function decideContinuation(input = {}) {
  const kind = normalizeNodeKind(input);

  if (isTemporarilyUnavailable(input) && !observationBudgetExhausted(input)) {
    return kind === EXECUTION_NODE_KIND.WAIT_FOR_STATE
      ? waitDecision(input)
      : retryObservation('evidence_temporarily_unavailable', {
        nodeKind: kind,
        stepVerdict: STEP_VERDICT.NONE,
      });
  }

  const impossible = systemImpossibilityDecision(input, kind);
  if (impossible) return impossible;

  if (kind === EXECUTION_NODE_KIND.WAIT_FOR_STATE) return waitDecision(input);
  if (kind === EXECUTION_NODE_KIND.ASSERTION) return assertionDecision(input);
  if (
    kind === EXECUTION_NODE_KIND.ACTION
    || kind === EXECUTION_NODE_KIND.NAVIGATION
    || kind === EXECUTION_NODE_KIND.SESSION
  ) return actionDecision(input, kind);

  if (isOptionalTargetAbsent(input)) {
    return decision(CONTINUATION_OUTCOME.CONTINUE, {
      stepVerdict: STEP_VERDICT.SKIPPED,
      optionalTargetAbsent: true,
      reason: 'optional_target_absent',
    });
  }

  return isSuccess(input)
    ? decision(CONTINUATION_OUTCOME.CONTINUE, {
      stepVerdict: STEP_VERDICT.PASSED,
      reason: 'execution_node_succeeded',
    })
    : retryObservation('execution_node_outcome_not_yet_proven', {
      nodeKind: kind,
      stepVerdict: STEP_VERDICT.NONE,
    });
}

function contextValue(context, key) {
  if (!isObject(context)) return undefined;
  const aliases = {
    browser: ['browser', 'browserId'],
    page: ['page', 'pageId'],
    context: ['context', 'contextId', 'browserContext', 'browserContextId'],
    sessionToken: ['sessionToken', 'continuationToken', 'sessionId'],
  };
  for (const alias of aliases[key]) {
    if (context[alias] !== undefined && context[alias] !== null) return context[alias];
  }
  return undefined;
}

function sameContextValue(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  if (typeof left === 'object' || typeof right === 'object') return left === right;
  return String(left) === String(right);
}

function evaluateSessionContinuity(previousContext, nextContext) {
  if (!isObject(previousContext)) {
    return {
      valid: false,
      reason: 'previous_session_context_missing',
      mismatches: ['browser', 'context', 'page', 'sessionToken'],
    };
  }

  if (!isObject(nextContext)) {
    return {
      valid: true,
      reason: 'reuse_previous_session_context',
      mismatches: [],
      contextToReuse: previousContext,
      mustReuseExactContext: true,
    };
  }

  const keys = ['browser', 'context', 'page', 'sessionToken'];
  const mismatches = keys.filter((key) => !sameContextValue(
    contextValue(previousContext, key),
    contextValue(nextContext, key),
  ));
  return {
    valid: mismatches.length === 0,
    reason: mismatches.length === 0
      ? 'session_context_preserved'
      : 'session_continuity_mismatch',
    mismatches,
    contextToReuse: previousContext,
    mustReuseExactContext: true,
  };
}

function hasBlockingPreviousFailure(previousCase = {}) {
  if (previousCase.blockingFailure === true || previousCase.hasBlockingFailure === true) return true;
  const failures = Array.isArray(previousCase.failures) ? previousCase.failures : [];
  return failures.some((failure) => {
    if (!isObject(failure)) return false;
    if (failure.blocking === true || failure.blockDependents === true) return true;
    return [
      CONTINUATION_OUTCOME.BLOCK_DEPENDENTS,
      CONTINUATION_OUTCOME.STOP_RUN,
    ].includes(failure.outcome);
  });
}

function caseCommitted(previousCase = {}) {
  const terminal = isObject(previousCase.terminalState) ? previousCase.terminalState : {};
  return Boolean(
    previousCase.committed === true
    || previousCase.terminalCommitted === true
    || terminal.committed === true
  );
}

function evaluateDependentCaseStart(input = {}) {
  const previousCase = isObject(input.previousCase) ? input.previousCase : {};
  const previousContext = firstDefined(
    input.previousSessionContext,
    previousCase.sessionContext,
    previousCase.continuationContext,
  );
  const nextContext = firstDefined(input.nextSessionContext, input.currentSessionContext);

  if (!caseCommitted(previousCase)) {
    return decision(CONTINUATION_OUTCOME.BLOCK_DEPENDENTS, {
      continueExecution: false,
      continueIndependent: true,
      blockDependents: true,
      scope: 'case_dependents',
      reason: 'dependency_terminal_state_not_committed',
    });
  }

  if (previousCase.sessionUsable === false || previousCase.sessionFailure === true) {
    return decision(CONTINUATION_OUTCOME.BLOCK_DEPENDENTS, {
      continueExecution: false,
      continueIndependent: true,
      blockDependents: true,
      scope: 'session_dependents',
      reason: 'dependency_session_not_usable',
    });
  }

  if (hasBlockingPreviousFailure(previousCase)) {
    return decision(CONTINUATION_OUTCOME.BLOCK_DEPENDENTS, {
      continueExecution: false,
      continueIndependent: true,
      blockDependents: true,
      scope: 'case_dependents',
      reason: 'dependency_has_blocking_failure',
    });
  }

  const continuity = evaluateSessionContinuity(previousContext, nextContext);
  if (!continuity.valid) {
    return decision(CONTINUATION_OUTCOME.BLOCK_DEPENDENTS, {
      continueExecution: false,
      continueIndependent: true,
      blockDependents: true,
      scope: 'session_dependents',
      reason: continuity.reason,
      sessionContinuity: continuity,
    });
  }

  return decision(CONTINUATION_OUTCOME.CONTINUE, {
    continueExecution: true,
    continueIndependent: true,
    blockDependents: false,
    scope: 'dependent_case',
    reason: 'dependency_committed_session_preserved',
    stepVerdict: STEP_VERDICT.NONE,
    sessionContinuity: continuity,
    contextToReuse: continuity.contextToReuse,
    nonBlockingAssertionFailuresAllowed: true,
  });
}

module.exports = {
  CONTINUATION_OUTCOME,
  EXECUTION_NODE_KIND,
  STEP_VERDICT,
  normalizeNodeKind,
  decideContinuation,
  evaluateSessionContinuity,
  evaluateDependentCaseStart,
};
