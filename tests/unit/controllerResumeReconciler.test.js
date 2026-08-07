import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
} = require('../../server/services/browserTransactionContract');
const {
  CONTROLLER_CAPABILITY,
  createControllerAuthority,
} = require('../../server/services/browserTransactionAuthority');
const {
  createBrowserTransactionEventJournal,
} = require('../../server/services/browserTransactionEventJournal');
const {
  RESUME_STATUS,
  createControllerResumeReconciler,
} = require('../../server/services/controllerResumeReconciler');

const operation = {
  operationId: 'action:login:sign-in',
  actionOccurrenceId: 'occurrence:action:login:sign-in:1',
};
const occurrenceKey = `${operation.actionOccurrenceId}::action`;

describe('controller resume reconciler', () => {
  it('requires reconciliation before any possible redispatch after dispatch start', async () => {
    const journal = createBrowserTransactionEventJournal();
    await journal.appendDispatchEvent({
      eventType: 'DISPATCH_STARTED',
      occurrenceKey,
      operationId: operation.operationId,
      actionOccurrenceId: operation.actionOccurrenceId,
      dispatchAttemptId: 'dispatch:1',
    });
    const result = await createControllerResumeReconciler({ journal }).reconcile({
      operation,
      plan: { mutation: { phaseId: 'action' } },
    });
    expect(result).toMatchObject({
      status: RESUME_STATUS.RECONCILE_BEFORE_ANY_DISPATCH,
      mayDispatch: false,
      mustReconcile: true,
      delivery: { deliveryStatus: 'DELIVERY_UNCERTAIN' },
    });
  });

  it('restores a terminal controller decision without dispatch', async () => {
    const journal = createBrowserTransactionEventJournal();
    await journal.appendControllerEvent({
      authority: createControllerAuthority(),
      capability: CONTROLLER_CAPABILITY.COMMIT_OPERATION,
      event: {
        eventType: 'TERMINAL_DECISION',
        occurrenceKey,
        operationId: operation.operationId,
        terminalDecision: {
          operationId: operation.operationId,
          actionOccurrenceId: operation.actionOccurrenceId,
          state: CONTROLLER_STATE.COMMITTED,
          commitDisposition: COMMIT_DISPOSITION.EXECUTED,
          proofRefs: ['owner:sign-in'],
        },
      },
    });
    const result = await createControllerResumeReconciler({ journal }).reconcile({
      operation,
      plan: { mutation: { phaseId: 'action' } },
    });
    expect(result).toMatchObject({
      status: RESUME_STATUS.TERMINAL_DECISION_RESTORED,
      mayDispatch: false,
      terminalDecision: {
        state: CONTROLLER_STATE.COMMITTED,
        commitDisposition: COMMIT_DISPOSITION.EXECUTED,
      },
    });
  });

  it('allows dispatch only when no occurrence facts exist', async () => {
    const journal = createBrowserTransactionEventJournal();
    await expect(createControllerResumeReconciler({ journal }).reconcile({
      operation,
      plan: { mutation: { phaseId: 'action' } },
    })).resolves.toMatchObject({
      status: RESUME_STATUS.NEW_OPERATION,
      mayDispatch: true,
      mustReconcile: false,
    });
  });
});
