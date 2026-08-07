import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
  createTerminalDecision,
} = require('../../server/services/browserTransactionContract');
const {
  createControllerAuthority,
} = require('../../server/services/browserTransactionAuthority');
const {
  SCHEDULE_STATE,
  createControllerExecutionScheduler,
} = require('../../server/services/controllerExecutionScheduler');

function operation(operationId, kind, ordinal, dependencies = [], orderingPredecessor = null) {
  return {
    schemaVersion: 'OperationContractV2',
    operationId,
    actionOccurrenceId: `occurrence:${operationId}:1`,
    kind,
    ordinal,
    dependencies,
    orderingPredecessor,
  };
}

function contract(operations) {
  return {
    schemaVersion: 'OperationContractV2',
    caseId: 'login',
    operations,
  };
}

function decision(operationId, state, terminationReason = null, operationKind = 'action') {
  return createTerminalDecision({
    operationId,
    actionOccurrenceId: `occurrence:${operationId}:1`,
    operationKind,
    state,
    ...(state === CONTROLLER_STATE.COMMITTED
      ? { commitDisposition: COMMIT_DISPOSITION.EXECUTED }
      : {}),
    ...(terminationReason ? { terminationReason } : {}),
  });
}

describe('controller execution scheduler', () => {
  it('continues after assertion failure and releases its dependent action', () => {
    const authority = createControllerAuthority();
    const scheduler = createControllerExecutionScheduler({
      authority,
      operationContract: contract([
        operation('assertion:email-visible', 'assertion', 1),
        operation('action:sign-in', 'action', 2, ['assertion:email-visible']),
      ]),
    });
    expect(scheduler.claimNext().operationId).toBe('assertion:email-visible');
    scheduler.recordDecision(decision('assertion:email-visible', CONTROLLER_STATE.ASSERTION_FAILED));
    expect(scheduler.claimNext().operationId).toBe('action:sign-in');
  });

  it('continues independent work without releasing descendants of an execution error', () => {
    const authority = createControllerAuthority();
    const scheduler = createControllerExecutionScheduler({
      authority,
      operationContract: contract([
        operation('action:email', 'action', 1),
        operation('action:sign-in', 'action', 2, ['action:email']),
        operation('assertion:branding', 'assertion', 3),
      ]),
    });
    expect(scheduler.claimNext().operationId).toBe('action:email');
    scheduler.recordDecision(decision('action:email', CONTROLLER_STATE.EXECUTION_ERROR));
    expect(scheduler.claimNext().operationId).toBe('assertion:branding');
    expect(scheduler.snapshot().records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationId: 'action:sign-in',
        scheduleState: SCHEDULE_STATE.SKIPPED_DEPENDENCY,
        skippedByOperationId: 'action:email',
      }),
    ]));
  });

  it('preserves authored order without turning the prior operation into a failure dependency', () => {
    const authority = createControllerAuthority();
    const scheduler = createControllerExecutionScheduler({
      authority,
      operationContract: contract([
        operation('action:open-zone', 'action', 1),
        operation('action:select-zone', 'action', 2, [], 'action:open-zone'),
        operation('action:next-field', 'action', 3, [], 'action:select-zone'),
      ]),
    });
    expect(scheduler.claimNext().operationId).toBe('action:open-zone');
    scheduler.recordDecision(decision('action:open-zone', CONTROLLER_STATE.EXECUTION_ERROR));
    expect(scheduler.claimNext().operationId).toBe('action:select-zone');
    scheduler.recordDecision(decision('action:select-zone', CONTROLLER_STATE.COMMITTED));
    expect(scheduler.claimNext().operationId).toBe('action:next-field');
  });

  it('skips explicit dependents only for an authorized stop reason', () => {
    const authority = createControllerAuthority();
    const scheduler = createControllerExecutionScheduler({
      authority,
      operationContract: contract([
        operation('action:email', 'action', 1),
        operation('action:sign-in', 'action', 2, ['action:email']),
        operation('assertion:branding', 'assertion', 3),
      ]),
    });
    expect(scheduler.claimNext().operationId).toBe('action:email');
    scheduler.recordDecision(decision(
      'action:email',
      CONTROLLER_STATE.EXECUTION_ERROR,
      'REQUIRED_MUTATION_PROVEN_UNDELIVERED',
    ));
    expect(scheduler.claimNext().operationId).toBe('assertion:branding');
    expect(scheduler.snapshot().records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationId: 'action:sign-in',
        scheduleState: SCHEDULE_STATE.SKIPPED_DEPENDENCY,
        skippedByOperationId: 'action:email',
      }),
    ]));
  });

  it('lets a dependent action decide truth after synchronization is inconclusive', () => {
    const authority = createControllerAuthority();
    const scheduler = createControllerExecutionScheduler({
      authority,
      operationContract: contract([
        operation('wait:email-page', 'synchronization', 1),
        operation('action:fill-email', 'action', 2, ['wait:email-page']),
      ]),
    });
    expect(scheduler.claimNext().operationId).toBe('wait:email-page');
    scheduler.recordDecision(decision(
      'wait:email-page',
      CONTROLLER_STATE.EXECUTION_ERROR,
      null,
      'synchronization',
    ));
    expect(scheduler.claimNext().operationId).toBe('action:fill-email');
    expect(scheduler.snapshot().records.find((record) => (
      record.operationId === 'action:fill-email'
    )).scheduleState).toBe(SCHEDULE_STATE.RUNNING);
  });

  it('never exposes a generic blocked schedule state', () => {
    expect(Object.values(SCHEDULE_STATE)).not.toContain('BLOCKED');
    expect(Object.values(SCHEDULE_STATE)).not.toContain('blocked');
  });
});
