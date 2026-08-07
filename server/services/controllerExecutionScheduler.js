'use strict';

const {
  CONTROLLER_STATE,
} = require('./browserTransactionContract');
const {
  CONTROLLER_CAPABILITY,
  assertControllerAuthority,
} = require('./browserTransactionAuthority');

const SCHEDULER_VERSION = 'qaai-controller-execution-scheduler-v1';

const SCHEDULE_STATE = Object.freeze({
  WAITING: 'WAITING',
  RUNNABLE: 'RUNNABLE',
  RUNNING: 'RUNNING',
  TERMINAL: 'TERMINAL',
  SKIPPED_DEPENDENCY: 'SKIPPED_DEPENDENCY',
});

const DEPENDENCY_SATISFYING_STATES = new Set([
  CONTROLLER_STATE.COMMITTED,
  CONTROLLER_STATE.ASSERTION_FAILED,
]);

const DEPENDENCY_UNAVAILABLE_STATES = new Set([
  CONTROLLER_STATE.EXECUTION_ERROR,
  CONTROLLER_STATE.PRODUCT_FAILURE,
  CONTROLLER_STATE.CANCELLED,
]);

function synchronizationInconclusive(record) {
  return record?.operation?.kind === 'synchronization'
    && record?.terminalDecision?.state === CONTROLLER_STATE.EXECUTION_ERROR;
}

function dependencySatisfied(record) {
  if (synchronizationInconclusive(record)) return true;
  const decision = record?.terminalDecision;
  if (!decision
    || decision.continuation?.skipDependents !== false
    || decision.continuation?.pause === true
    || decision.continuation?.terminationReason) return false;
  return DEPENDENCY_SATISFYING_STATES.has(decision.state);
}

function dependencyUnavailable(record) {
  if (synchronizationInconclusive(record)) return false;
  return record?.terminalDecision?.continuation?.skipDependents === true
    || Boolean(record?.terminalDecision?.continuation?.terminationReason)
    || DEPENDENCY_UNAVAILABLE_STATES.has(record?.terminalDecision?.state);
}

class ControllerExecutionSchedulerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerExecutionSchedulerError';
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

function createControllerExecutionScheduler({
  operationContract,
  authority,
} = {}) {
  if (operationContract?.schemaVersion !== 'OperationContractV2'
    || !Array.isArray(operationContract.operations)) {
    throw new ControllerExecutionSchedulerError(
      'Controller scheduler requires OperationContractV2.',
      'CONTROLLER_SCHEDULER_OPERATION_CONTRACT_REQUIRED',
    );
  }

  const operations = operationContract.operations.slice().sort((left, right) => (
    Number(left.ordinal || 0) - Number(right.ordinal || 0)
  ));
  const aliases = new Map();
  for (const operation of operations) {
    aliases.set(operation.operationId, operation.operationId);
    for (const alias of [operation.authoredStepId, operation.assertionId]) {
      if (clean(alias)) aliases.set(clean(alias), operation.operationId);
    }
  }
  const records = new Map();
  for (const operation of operations) {
    const dependencyInputs = Array.isArray(operation.dependencies) ? operation.dependencies : [];
    const dependencies = dependencyInputs.map((dependency) => {
      const resolved = aliases.get(clean(dependency));
      if (!resolved) {
        throw new ControllerExecutionSchedulerError(
          'Operation dependency is absent from OperationContractV2.',
          'CONTROLLER_SCHEDULER_DEPENDENCY_MISSING',
          { operationId: operation.operationId, dependency },
        );
      }
      return resolved;
    });
    const orderingPredecessor = clean(operation.orderingPredecessor)
      ? aliases.get(clean(operation.orderingPredecessor))
      : null;
    if (clean(operation.orderingPredecessor) && !orderingPredecessor) {
      throw new ControllerExecutionSchedulerError(
        'Operation ordering predecessor is absent from OperationContractV2.',
        'CONTROLLER_SCHEDULER_ORDERING_PREDECESSOR_MISSING',
        { operationId: operation.operationId, orderingPredecessor: operation.orderingPredecessor },
      );
    }
    records.set(operation.operationId, {
      operation,
      dependencies: Object.freeze([...new Set(dependencies)]),
      orderingPredecessor,
      scheduleState: dependencies.length || orderingPredecessor
        ? SCHEDULE_STATE.WAITING
        : SCHEDULE_STATE.RUNNABLE,
      terminalDecision: null,
      skipReason: null,
      skippedByOperationId: null,
    });
  }

  let paused = false;
  let cancelled = false;

  const skipExplicitDependents = (sourceOperationId) => {
    const queue = [sourceOperationId];
    const visited = new Set();
    while (queue.length) {
      const source = queue.shift();
      if (visited.has(source)) continue;
      visited.add(source);
      for (const record of records.values()) {
        if (!record.dependencies.includes(source)) continue;
        if ([SCHEDULE_STATE.TERMINAL, SCHEDULE_STATE.SKIPPED_DEPENDENCY].includes(record.scheduleState)) continue;
        record.scheduleState = SCHEDULE_STATE.SKIPPED_DEPENDENCY;
        record.skipReason = 'explicit_dependency_unavailable';
        record.skippedByOperationId = source;
        queue.push(record.operation.operationId);
      }
    }
  };

  const refresh = () => {
    for (const record of records.values()) {
      if (record.scheduleState !== SCHEDULE_STATE.WAITING) continue;
      const orderingPredecessor = record.orderingPredecessor
        ? records.get(record.orderingPredecessor)
        : null;
      if (orderingPredecessor
        && ![
          SCHEDULE_STATE.TERMINAL,
          SCHEDULE_STATE.SKIPPED_DEPENDENCY,
        ].includes(orderingPredecessor.scheduleState)) continue;
      const dependencies = record.dependencies.map((dependency) => records.get(dependency));
      const unavailable = dependencies.find((dependency) => (
        dependency.scheduleState === SCHEDULE_STATE.SKIPPED_DEPENDENCY
        || dependencyUnavailable(dependency)
      ));
      if (unavailable) {
        record.scheduleState = SCHEDULE_STATE.SKIPPED_DEPENDENCY;
        record.skipReason = 'explicit_dependency_unavailable';
        record.skippedByOperationId = unavailable.operation.operationId;
        skipExplicitDependents(record.operation.operationId);
        continue;
      }
      if (dependencies.every((dependency) => (
        dependency.scheduleState === SCHEDULE_STATE.TERMINAL
        && dependencySatisfied(dependency)
      ))) {
        record.scheduleState = SCHEDULE_STATE.RUNNABLE;
      }
    }
  };

  const claimNext = () => {
    assertControllerAuthority(authority, CONTROLLER_CAPABILITY.SCHEDULE_OPERATION);
    if (paused || cancelled) return null;
    refresh();
    const next = operations
      .map((operation) => records.get(operation.operationId))
      .find((record) => record.scheduleState === SCHEDULE_STATE.RUNNABLE);
    if (!next) return null;
    next.scheduleState = SCHEDULE_STATE.RUNNING;
    return next.operation;
  };

  const recordDecision = (decision) => {
    assertControllerAuthority(authority, CONTROLLER_CAPABILITY.DECIDE_CONTINUATION);
    const record = records.get(clean(decision?.operationId));
    if (!record) {
      throw new ControllerExecutionSchedulerError(
        'Controller decision does not belong to this operation contract.',
        'CONTROLLER_SCHEDULER_DECISION_OPERATION_UNKNOWN',
        { operationId: clean(decision?.operationId) || null },
      );
    }
    if (record.scheduleState !== SCHEDULE_STATE.RUNNING) {
      throw new ControllerExecutionSchedulerError(
        'Only the currently claimed operation may receive a terminal decision.',
        'CONTROLLER_SCHEDULER_OPERATION_NOT_RUNNING',
        { operationId: record.operation.operationId, scheduleState: record.scheduleState },
      );
    }
    if (!decision?.state || !decision?.continuation) {
      throw new ControllerExecutionSchedulerError(
        'Scheduler requires a canonical controller terminal decision.',
        'CONTROLLER_SCHEDULER_TERMINAL_DECISION_REQUIRED',
        { operationId: record.operation.operationId },
      );
    }
    record.scheduleState = SCHEDULE_STATE.TERMINAL;
    record.terminalDecision = decision;

    if (decision.state === CONTROLLER_STATE.MANUAL_BOUNDARY) {
      paused = true;
    } else if (decision.state === CONTROLLER_STATE.CANCELLED) {
      cancelled = true;
    } else if (decision.continuation.skipDependents === true) {
      skipExplicitDependents(record.operation.operationId);
    }
    refresh();
    return snapshot();
  };

  const resumeManualBoundary = () => {
    assertControllerAuthority(authority, CONTROLLER_CAPABILITY.DECIDE_CONTINUATION);
    paused = false;
    refresh();
    return snapshot();
  };

  const snapshot = () => Object.freeze({
    schemaVersion: SCHEDULER_VERSION,
    paused,
    cancelled,
    complete: [...records.values()].every((record) => (
      record.scheduleState === SCHEDULE_STATE.TERMINAL
      || record.scheduleState === SCHEDULE_STATE.SKIPPED_DEPENDENCY
    )),
    records: Object.freeze(operations.map((operation) => {
      const record = records.get(operation.operationId);
      return Object.freeze({
        operationId: operation.operationId,
        kind: operation.kind,
        orderingPredecessor: record.orderingPredecessor,
        dependencies: record.dependencies,
        scheduleState: record.scheduleState,
        terminalState: record.terminalDecision?.state || null,
        continuationDisposition: record.terminalDecision?.continuation?.disposition || null,
        skipDependents: record.terminalDecision?.continuation?.skipDependents ?? null,
        terminationReason: record.terminalDecision?.continuation?.terminationReason || null,
        skipReason: record.skipReason,
        skippedByOperationId: record.skippedByOperationId,
      });
    })),
  });

  return Object.freeze({
    claimNext,
    recordDecision,
    resumeManualBoundary,
    snapshot,
  });
}

module.exports = {
  SCHEDULER_VERSION,
  SCHEDULE_STATE,
  DEPENDENCY_SATISFYING_STATES,
  DEPENDENCY_UNAVAILABLE_STATES,
  synchronizationInconclusive,
  dependencySatisfied,
  dependencyUnavailable,
  ControllerExecutionSchedulerError,
  createControllerExecutionScheduler,
};
