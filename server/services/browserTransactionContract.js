'use strict';

const CONTRACT_VERSION = 'qaai-browser-transaction-contract-v1';

const CONTROLLER_STATE = Object.freeze({
  PENDING: 'PENDING',
  RESOLVING: 'RESOLVING',
  DISPATCHED: 'DISPATCHED',
  RECONCILING: 'RECONCILING',
  COMMITTED: 'COMMITTED',
  PRODUCT_FAILURE: 'PRODUCT_FAILURE',
  ASSERTION_FAILED: 'ASSERTION_FAILED',
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  MANUAL_BOUNDARY: 'MANUAL_BOUNDARY',
  CANCELLED: 'CANCELLED',
});

const COMMIT_DISPOSITION = Object.freeze({
  EXECUTED: 'EXECUTED',
  ALREADY_SATISFIED: 'ALREADY_SATISFIED',
  OPTIONAL_ABSENT: 'OPTIONAL_ABSENT',
  RECOVERED: 'RECOVERED',
});

const CONTINUATION_DISPOSITION = Object.freeze({
  CONTINUE: 'CONTINUE',
  SKIP_DEPENDENTS: 'SKIP_DEPENDENTS',
  PAUSE: 'PAUSE',
  STOP: 'STOP',
});

const FAILURE_ATTRIBUTION = Object.freeze({
  NONE: 'NONE',
  PRODUCT: 'PRODUCT',
  QAAI_EXECUTION: 'QAAI_EXECUTION',
  FUNCTIONAL_ASSERTION: 'FUNCTIONAL_ASSERTION',
  MANUAL: 'MANUAL',
  USER: 'USER',
});

const RUN_TERMINATION_REASON = Object.freeze({
  USER_CANCELLED: 'USER_CANCELLED',
  BROWSER_SESSION_LOST: 'BROWSER_SESSION_LOST',
  REQUIRED_MUTATION_PROVEN_UNDELIVERED: 'REQUIRED_MUTATION_PROVEN_UNDELIVERED',
});

const TERMINAL_STATES = new Set([
  CONTROLLER_STATE.COMMITTED,
  CONTROLLER_STATE.PRODUCT_FAILURE,
  CONTROLLER_STATE.ASSERTION_FAILED,
  CONTROLLER_STATE.EXECUTION_ERROR,
  CONTROLLER_STATE.MANUAL_BOUNDARY,
  CONTROLLER_STATE.CANCELLED,
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  [CONTROLLER_STATE.PENDING]: new Set([
    CONTROLLER_STATE.RESOLVING,
    CONTROLLER_STATE.COMMITTED,
    CONTROLLER_STATE.ASSERTION_FAILED,
    CONTROLLER_STATE.EXECUTION_ERROR,
    CONTROLLER_STATE.MANUAL_BOUNDARY,
    CONTROLLER_STATE.CANCELLED,
  ]),
  [CONTROLLER_STATE.RESOLVING]: new Set([
    CONTROLLER_STATE.DISPATCHED,
    CONTROLLER_STATE.RECONCILING,
    CONTROLLER_STATE.COMMITTED,
    CONTROLLER_STATE.PRODUCT_FAILURE,
    CONTROLLER_STATE.ASSERTION_FAILED,
    CONTROLLER_STATE.EXECUTION_ERROR,
    CONTROLLER_STATE.MANUAL_BOUNDARY,
    CONTROLLER_STATE.CANCELLED,
  ]),
  [CONTROLLER_STATE.DISPATCHED]: new Set([
    CONTROLLER_STATE.RECONCILING,
    CONTROLLER_STATE.EXECUTION_ERROR,
    CONTROLLER_STATE.MANUAL_BOUNDARY,
    CONTROLLER_STATE.CANCELLED,
  ]),
  [CONTROLLER_STATE.RECONCILING]: new Set([
    CONTROLLER_STATE.COMMITTED,
    CONTROLLER_STATE.PRODUCT_FAILURE,
    CONTROLLER_STATE.ASSERTION_FAILED,
    CONTROLLER_STATE.EXECUTION_ERROR,
    CONTROLLER_STATE.MANUAL_BOUNDARY,
    CONTROLLER_STATE.CANCELLED,
  ]),
});

const STATE_VALUES = new Set(Object.values(CONTROLLER_STATE));
const COMMIT_DISPOSITION_VALUES = new Set(Object.values(COMMIT_DISPOSITION));
const RUN_TERMINATION_REASON_VALUES = new Set(Object.values(RUN_TERMINATION_REASON));

class BrowserTransactionContractError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BrowserTransactionContractError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function assertControllerState(state) {
  if (!STATE_VALUES.has(state)) {
    throw new BrowserTransactionContractError(
      `Unknown browser transaction state: ${clean(state) || '<empty>'}`,
      'BROWSER_TRANSACTION_STATE_INVALID',
      { state },
    );
  }
  return state;
}

function assertTransition(fromState, toState) {
  assertControllerState(fromState);
  assertControllerState(toState);
  if (TERMINAL_STATES.has(fromState) || !ALLOWED_TRANSITIONS[fromState]?.has(toState)) {
    throw new BrowserTransactionContractError(
      `Illegal browser transaction transition: ${fromState} -> ${toState}`,
      'BROWSER_TRANSACTION_TRANSITION_INVALID',
      { fromState, toState },
    );
  }
  return Object.freeze({ fromState, toState });
}

function continuationForState(state, options = {}) {
  assertControllerState(state);
  const terminationReason = options.terminationReason || null;
  if (terminationReason && !RUN_TERMINATION_REASON_VALUES.has(terminationReason)) {
    throw new BrowserTransactionContractError(
      `Run termination reason is not authorized: ${clean(terminationReason) || '<empty>'}`,
      'BROWSER_TRANSACTION_TERMINATION_REASON_INVALID',
      { state, terminationReason },
    );
  }

  if (state === CONTROLLER_STATE.CANCELLED) {
    return Object.freeze({
      disposition: CONTINUATION_DISPOSITION.STOP,
      continueIndependent: false,
      skipDependents: true,
      pause: false,
      terminationReason: terminationReason || RUN_TERMINATION_REASON.USER_CANCELLED,
    });
  }
  if (state === CONTROLLER_STATE.MANUAL_BOUNDARY) {
    return Object.freeze({
      disposition: CONTINUATION_DISPOSITION.PAUSE,
      continueIndependent: false,
      skipDependents: false,
      pause: true,
      terminationReason: null,
    });
  }
  if (terminationReason) {
    return Object.freeze({
      disposition: CONTINUATION_DISPOSITION.STOP,
      continueIndependent: false,
      skipDependents: true,
      pause: false,
      terminationReason,
    });
  }
  if (state === CONTROLLER_STATE.PRODUCT_FAILURE) {
    return Object.freeze({
      disposition: CONTINUATION_DISPOSITION.SKIP_DEPENDENTS,
      continueIndependent: true,
      skipDependents: true,
      pause: false,
      terminationReason: null,
    });
  }
  // An execution error says that QAAI could not prove this operation. It does
  // not prove that the next authored operation is unavailable. Only a
  // canonical terminationReason (session loss, user cancellation, or proven
  // non-delivery of a required mutation) may stop the run. Product failures
  // remain dependency-unavailable because the application positively rejected
  // the authored state.
  return Object.freeze({
    disposition: CONTINUATION_DISPOSITION.CONTINUE,
    continueIndependent: true,
    skipDependents: false,
    pause: false,
    terminationReason: null,
  });
}

function expectedAttribution(state) {
  switch (state) {
    case CONTROLLER_STATE.PRODUCT_FAILURE:
      return FAILURE_ATTRIBUTION.PRODUCT;
    case CONTROLLER_STATE.ASSERTION_FAILED:
      return FAILURE_ATTRIBUTION.FUNCTIONAL_ASSERTION;
    case CONTROLLER_STATE.EXECUTION_ERROR:
      return FAILURE_ATTRIBUTION.QAAI_EXECUTION;
    case CONTROLLER_STATE.MANUAL_BOUNDARY:
      return FAILURE_ATTRIBUTION.MANUAL;
    case CONTROLLER_STATE.CANCELLED:
      return FAILURE_ATTRIBUTION.USER;
    default:
      return FAILURE_ATTRIBUTION.NONE;
  }
}

function createTerminalDecision(input = {}) {
  const operationId = clean(input.operationId);
  const actionOccurrenceId = clean(input.actionOccurrenceId);
  const state = assertControllerState(input.state);
  if (!TERMINAL_STATES.has(state)) {
    throw new BrowserTransactionContractError(
      'A terminal controller decision requires a terminal state.',
      'BROWSER_TRANSACTION_TERMINAL_STATE_REQUIRED',
      { state },
    );
  }
  if (!operationId || !actionOccurrenceId) {
    throw new BrowserTransactionContractError(
      'A controller decision requires operationId and actionOccurrenceId.',
      'BROWSER_TRANSACTION_IDENTITY_REQUIRED',
      { operationId: operationId || null, actionOccurrenceId: actionOccurrenceId || null },
    );
  }

  const commitDisposition = input.commitDisposition || null;
  if (state === CONTROLLER_STATE.COMMITTED && !COMMIT_DISPOSITION_VALUES.has(commitDisposition)) {
    throw new BrowserTransactionContractError(
      'Committed browser transactions require an exact commit disposition.',
      'BROWSER_TRANSACTION_COMMIT_DISPOSITION_REQUIRED',
      { operationId, commitDisposition },
    );
  }
  if (state !== CONTROLLER_STATE.COMMITTED && commitDisposition != null) {
    throw new BrowserTransactionContractError(
      'Only committed browser transactions may carry a commit disposition.',
      'BROWSER_TRANSACTION_COMMIT_DISPOSITION_FORBIDDEN',
      { operationId, state, commitDisposition },
    );
  }

  const proofRefs = Object.freeze([
    ...new Set((Array.isArray(input.proofRefs) ? input.proofRefs : [])
      .map(clean)
      .filter(Boolean)),
  ]);
  const terminationReason = input.terminationReason || null;
  const continuation = continuationForState(state, {
    terminationReason,
    operationKind: input.operationKind,
  });
  const attribution = input.attribution || expectedAttribution(state);
  if (attribution !== expectedAttribution(state)) {
    throw new BrowserTransactionContractError(
      `Failure attribution ${attribution} is incompatible with ${state}.`,
      'BROWSER_TRANSACTION_ATTRIBUTION_INVALID',
      { operationId, state, attribution, expected: expectedAttribution(state) },
    );
  }

  return Object.freeze({
    schemaVersion: CONTRACT_VERSION,
    operationId,
    actionOccurrenceId,
    state,
    commitDisposition,
    attribution,
    reason: clean(input.reason) || null,
    proofRefs,
    continuation,
  });
}

module.exports = {
  CONTRACT_VERSION,
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
  CONTINUATION_DISPOSITION,
  FAILURE_ATTRIBUTION,
  RUN_TERMINATION_REASON,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  BrowserTransactionContractError,
  assertControllerState,
  assertTransition,
  continuationForState,
  createTerminalDecision,
};
