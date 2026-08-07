import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
} = require('../../server/services/browserTransactionContract');
const {
  createControllerAuthority,
} = require('../../server/services/browserTransactionAuthority');
const {
  createBrowserTransactionStateMachine,
} = require('../../server/services/browserTransactionStateMachine');

function operation() {
  return {
    schemaVersion: 'OperationContractV2',
    operationId: 'action:login:email',
    actionOccurrenceId: 'occurrence:action:login:email:1',
  };
}

describe('browser transaction state machine', () => {
  it('records an append-only successful action lifecycle', () => {
    let tick = 0;
    const machine = createBrowserTransactionStateMachine({
      operation: operation(),
      authority: createControllerAuthority(),
      now: () => Date.parse('2026-07-23T10:00:00.000Z') + tick++,
    });

    machine.transition(CONTROLLER_STATE.RESOLVING, { reason: 'target_resolution_started' });
    machine.transition(CONTROLLER_STATE.DISPATCHED, {
      dispatchAttemptId: 'dispatch:1',
      deliveryStatus: 'DELIVERED',
      factRefs: ['dispatch-fact:1'],
    });
    machine.transition(CONTROLLER_STATE.RECONCILING, {
      deadlineAt: '2026-07-23T10:00:05.000Z',
      factRefs: ['snapshot:post-action'],
    });
    const committed = machine.transition(CONTROLLER_STATE.COMMITTED, {
      commitDisposition: COMMIT_DISPOSITION.EXECUTED,
      proofRefs: undefined,
      factRefs: ['owner-readback:email'],
    });

    expect(committed.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.COMMITTED,
      commitDisposition: COMMIT_DISPOSITION.EXECUTED,
      proofRefs: ['owner-readback:email'],
    });
    expect(machine.snapshot().events.map((event) => event.toState)).toEqual([
      CONTROLLER_STATE.PENDING,
      CONTROLLER_STATE.RESOLVING,
      CONTROLLER_STATE.DISPATCHED,
      CONTROLLER_STATE.RECONCILING,
      CONTROLLER_STATE.COMMITTED,
    ]);
  });

  it('requires dispatch facts and a reconciliation deadline', () => {
    const machine = createBrowserTransactionStateMachine({
      operation: operation(),
      authority: createControllerAuthority(),
    });
    machine.transition(CONTROLLER_STATE.RESOLVING);
    expect(() => machine.transition(CONTROLLER_STATE.DISPATCHED)).toThrowError(
      expect.objectContaining({ code: 'BROWSER_TRANSACTION_DISPATCH_FACTS_REQUIRED' }),
    );
  });

  it('makes terminal decisions immutable', () => {
    const machine = createBrowserTransactionStateMachine({
      operation: operation(),
      authority: createControllerAuthority(),
    });
    machine.transition(CONTROLLER_STATE.EXECUTION_ERROR, { reason: 'target_not_found' });
    expect(() => machine.transition(CONTROLLER_STATE.RESOLVING)).toThrowError(
      expect.objectContaining({ code: 'BROWSER_TRANSACTION_TERMINAL_DECISION_IMMUTABLE' }),
    );
  });

  it('rejects forged authority even when its public fields look correct', () => {
    const machine = createBrowserTransactionStateMachine({
      operation: operation(),
      authority: {
        schemaVersion: 'qaai-browser-transaction-authority-v1',
        owner: 'BrowserTransactionController',
      },
    });
    expect(() => machine.transition(CONTROLLER_STATE.RESOLVING)).toThrowError(
      expect.objectContaining({ code: 'BROWSER_TRANSACTION_CONTROLLER_AUTHORITY_REQUIRED' }),
    );
  });
});
