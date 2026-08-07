'use strict';

const {
  CONTRACT_VERSION,
  CONTROLLER_STATE,
  TERMINAL_STATES,
  assertTransition,
  createTerminalDecision,
} = require('./browserTransactionContract');
const {
  CONTROLLER_CAPABILITY,
  assertControllerAuthority,
} = require('./browserTransactionAuthority');

const STATE_MACHINE_VERSION = 'qaai-browser-transaction-state-machine-v1';

const TRANSITION_CAPABILITY = Object.freeze({
  [CONTROLLER_STATE.RESOLVING]: CONTROLLER_CAPABILITY.SCHEDULE_OPERATION,
  [CONTROLLER_STATE.DISPATCHED]: CONTROLLER_CAPABILITY.AUTHORIZE_MUTATION,
  [CONTROLLER_STATE.RECONCILING]: CONTROLLER_CAPABILITY.DECIDE_CONTINUATION,
  [CONTROLLER_STATE.COMMITTED]: CONTROLLER_CAPABILITY.COMMIT_OPERATION,
  [CONTROLLER_STATE.PRODUCT_FAILURE]: CONTROLLER_CAPABILITY.DECIDE_CONTINUATION,
  [CONTROLLER_STATE.ASSERTION_FAILED]: CONTROLLER_CAPABILITY.DECIDE_CONTINUATION,
  [CONTROLLER_STATE.EXECUTION_ERROR]: CONTROLLER_CAPABILITY.DECIDE_CONTINUATION,
  [CONTROLLER_STATE.MANUAL_BOUNDARY]: CONTROLLER_CAPABILITY.PAUSE_MANUAL_BOUNDARY,
  [CONTROLLER_STATE.CANCELLED]: CONTROLLER_CAPABILITY.CANCEL_RUN,
});

class BrowserTransactionStateMachineError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BrowserTransactionStateMachineError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(Number(value)).toISOString();
}

function operationIdentity(operation = {}) {
  const operationId = clean(operation.operationId);
  const actionOccurrenceId = clean(operation.actionOccurrenceId);
  if (!operationId || !actionOccurrenceId) {
    throw new BrowserTransactionStateMachineError(
      'Browser transaction state requires OperationContractV2 identity.',
      'BROWSER_TRANSACTION_OPERATION_IDENTITY_REQUIRED',
      { operationId: operationId || null, actionOccurrenceId: actionOccurrenceId || null },
    );
  }
  return Object.freeze({ operationId, actionOccurrenceId });
}

function stateSpecificFacts(toState, details = {}) {
  if (toState === CONTROLLER_STATE.DISPATCHED) {
    const dispatchAttemptId = clean(details.dispatchAttemptId);
    const deliveryStatus = clean(details.deliveryStatus);
    if (!dispatchAttemptId || !deliveryStatus) {
      throw new BrowserTransactionStateMachineError(
        'DISPATCHED requires dispatchAttemptId and deliveryStatus facts.',
        'BROWSER_TRANSACTION_DISPATCH_FACTS_REQUIRED',
        { dispatchAttemptId: dispatchAttemptId || null, deliveryStatus: deliveryStatus || null },
      );
    }
  }
  if (toState === CONTROLLER_STATE.RECONCILING) {
    const deadlineAt = clean(details.deadlineAt);
    if (!deadlineAt) {
      throw new BrowserTransactionStateMachineError(
        'RECONCILING requires an operation deadline.',
        'BROWSER_TRANSACTION_RECONCILIATION_DEADLINE_REQUIRED',
      );
    }
  }
}

function createBrowserTransactionStateMachine({
  operation,
  authority,
  now = Date.now,
} = {}) {
  const identity = operationIdentity(operation);
  let currentState = CONTROLLER_STATE.PENDING;
  let sequence = 0;
  let terminalDecision = null;
  const events = [];

  const append = (event) => {
    const record = Object.freeze({
      schemaVersion: STATE_MACHINE_VERSION,
      contractVersion: CONTRACT_VERSION,
      sequence: ++sequence,
      operationId: identity.operationId,
      actionOccurrenceId: identity.actionOccurrenceId,
      occurredAt: timestamp(now),
      ...clone(event),
    });
    events.push(record);
    return record;
  };

  append({
    eventType: 'TRANSACTION_CREATED',
    fromState: null,
    toState: CONTROLLER_STATE.PENDING,
    capability: null,
    reason: 'operation_accepted',
    factRefs: [],
  });

  const transition = (toState, details = {}) => {
    if (TERMINAL_STATES.has(currentState)) {
      throw new BrowserTransactionStateMachineError(
        'A terminal browser transaction decision is write-once.',
        'BROWSER_TRANSACTION_TERMINAL_DECISION_IMMUTABLE',
        { operationId: identity.operationId, currentState, requestedState: toState },
      );
    }
    const capability = TRANSITION_CAPABILITY[toState];
    if (!capability) {
      throw new BrowserTransactionStateMachineError(
        `No controller capability is assigned to transition into ${String(toState)}.`,
        'BROWSER_TRANSACTION_TRANSITION_CAPABILITY_MISSING',
        { toState },
      );
    }
    assertControllerAuthority(authority, capability);
    assertTransition(currentState, toState);
    stateSpecificFacts(toState, details);

    const fromState = currentState;
    currentState = toState;
    const factRefs = Object.freeze([
      ...new Set((Array.isArray(details.factRefs) ? details.factRefs : [])
        .map(clean)
        .filter(Boolean)),
    ]);
    const event = append({
      eventType: TERMINAL_STATES.has(toState) ? 'TERMINAL_DECISION' : 'STATE_TRANSITION',
      fromState,
      toState,
      capability,
      reason: clean(details.reason) || null,
      factRefs,
      dispatchAttemptId: clean(details.dispatchAttemptId) || null,
      deliveryStatus: clean(details.deliveryStatus) || null,
      deadlineAt: clean(details.deadlineAt) || null,
    });

    if (TERMINAL_STATES.has(toState)) {
      terminalDecision = createTerminalDecision({
        operationId: identity.operationId,
        actionOccurrenceId: identity.actionOccurrenceId,
        operationKind: operation.kind,
        state: toState,
        commitDisposition: details.commitDisposition,
        attribution: details.attribution,
        terminationReason: details.terminationReason,
        reason: details.reason,
        proofRefs: factRefs,
      });
    }
    return Object.freeze({
      event,
      state: currentState,
      terminalDecision,
    });
  };

  const snapshot = () => Object.freeze({
    schemaVersion: STATE_MACHINE_VERSION,
    operationId: identity.operationId,
    actionOccurrenceId: identity.actionOccurrenceId,
    state: currentState,
    terminal: TERMINAL_STATES.has(currentState),
    terminalDecision,
    events: Object.freeze(events.slice()),
  });

  return Object.freeze({
    transition,
    snapshot,
    currentState: () => currentState,
    isTerminal: () => TERMINAL_STATES.has(currentState),
  });
}

module.exports = {
  STATE_MACHINE_VERSION,
  TRANSITION_CAPABILITY,
  BrowserTransactionStateMachineError,
  createBrowserTransactionStateMachine,
};
