import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const contract = require('../../server/services/browserTransactionContract');
const authority = require('../../server/services/browserTransactionAuthority');

describe('browser transaction authority', () => {
  it('rejects forged controller authority and accepts only a minted capability', () => {
    expect(() => authority.assertControllerAuthority(
      { schemaVersion: authority.AUTHORITY_VERSION, owner: authority.CONTROLLER_OWNER },
      authority.CONTROLLER_CAPABILITY.COMMIT_OPERATION,
    )).toThrowError(expect.objectContaining({
      code: 'BROWSER_TRANSACTION_CONTROLLER_AUTHORITY_REQUIRED',
    }));

    const controllerAuthority = authority.createControllerAuthority();
    expect(authority.assertControllerAuthority(
      controllerAuthority,
      authority.CONTROLLER_CAPABILITY.COMMIT_OPERATION,
    )).toEqual({
      schemaVersion: authority.AUTHORITY_VERSION,
      owner: authority.CONTROLLER_OWNER,
      capability: authority.CONTROLLER_CAPABILITY.COMMIT_OPERATION,
    });
  });

  it('keeps Healer and Critic outputs proposal-only', () => {
    expect(authority.proposal(authority.OBSERVER_ROLE.HEALER, {
      target: { role: 'button', name: 'Sign in' },
    })).toMatchObject({
      kind: 'proposal',
      mayMutateBrowser: false,
      mayChangeVerdict: false,
      mayStopExecution: false,
    });
  });
});

describe('browser transaction contract', () => {
  it('contains no blocked state and permits only explicit state transitions', () => {
    expect(Object.values(contract.CONTROLLER_STATE)).not.toContain('BLOCKED');
    expect(contract.assertTransition(
      contract.CONTROLLER_STATE.PENDING,
      contract.CONTROLLER_STATE.RESOLVING,
    )).toEqual({
      fromState: contract.CONTROLLER_STATE.PENDING,
      toState: contract.CONTROLLER_STATE.RESOLVING,
    });
    expect(() => contract.assertTransition(
      contract.CONTROLLER_STATE.COMMITTED,
      contract.CONTROLLER_STATE.RECONCILING,
    )).toThrowError(expect.objectContaining({
      code: 'BROWSER_TRANSACTION_TRANSITION_INVALID',
    }));
  });

  it('continues inconclusive operations and stops only for an explicit reason', () => {
    const assertion = contract.createTerminalDecision({
      operationId: 'operation:assert-email',
      actionOccurrenceId: 'occurrence:assert-email',
      state: contract.CONTROLLER_STATE.ASSERTION_FAILED,
      reason: 'expected text not visible',
    });
    expect(assertion.continuation).toMatchObject({
      disposition: contract.CONTINUATION_DISPOSITION.CONTINUE,
      continueIndependent: true,
      skipDependents: false,
    });

    const executionError = contract.createTerminalDecision({
      operationId: 'operation:submit',
      actionOccurrenceId: 'occurrence:submit',
      operationKind: 'action',
      state: contract.CONTROLLER_STATE.EXECUTION_ERROR,
      reason: 'target resolution budget exhausted',
    });
    expect(executionError.continuation).toMatchObject({
      disposition: contract.CONTINUATION_DISPOSITION.CONTINUE,
      continueIndependent: true,
      skipDependents: false,
    });

    const synchronizationError = contract.createTerminalDecision({
      operationId: 'operation:wait',
      actionOccurrenceId: 'occurrence:wait',
      operationKind: 'synchronization',
      state: contract.CONTROLLER_STATE.EXECUTION_ERROR,
      reason: 'wait observation budget exhausted',
    });
    expect(synchronizationError.continuation).toMatchObject({
      disposition: contract.CONTINUATION_DISPOSITION.CONTINUE,
      continueIndependent: true,
      skipDependents: false,
    });

    const provenNonDelivery = contract.createTerminalDecision({
      operationId: 'operation:undelivered-submit',
      actionOccurrenceId: 'occurrence:undelivered-submit',
      state: contract.CONTROLLER_STATE.EXECUTION_ERROR,
      reason: 'required mutation positively not delivered',
      terminationReason: contract.RUN_TERMINATION_REASON.REQUIRED_MUTATION_PROVEN_UNDELIVERED,
    });
    expect(provenNonDelivery.continuation).toMatchObject({
      disposition: contract.CONTINUATION_DISPOSITION.STOP,
      continueIndependent: false,
      skipDependents: true,
    });
  });

  it('requires an exact disposition for every committed operation', () => {
    expect(() => contract.createTerminalDecision({
      operationId: 'operation:email',
      actionOccurrenceId: 'occurrence:email',
      state: contract.CONTROLLER_STATE.COMMITTED,
    })).toThrowError(expect.objectContaining({
      code: 'BROWSER_TRANSACTION_COMMIT_DISPOSITION_REQUIRED',
    }));

    expect(contract.createTerminalDecision({
      operationId: 'operation:email',
      actionOccurrenceId: 'occurrence:email',
      state: contract.CONTROLLER_STATE.COMMITTED,
      commitDisposition: contract.COMMIT_DISPOSITION.EXECUTED,
      proofRefs: ['owner-readback:email', 'owner-readback:email'],
    })).toMatchObject({
      state: contract.CONTROLLER_STATE.COMMITTED,
      commitDisposition: contract.COMMIT_DISPOSITION.EXECUTED,
      proofRefs: ['owner-readback:email'],
    });
  });

  it('allows run termination only for the explicit whitelist', () => {
    expect(() => contract.createTerminalDecision({
      operationId: 'operation:email',
      actionOccurrenceId: 'occurrence:email',
      state: contract.CONTROLLER_STATE.EXECUTION_ERROR,
      terminationReason: 'SNAPSHOT_MISSING',
    })).toThrowError(expect.objectContaining({
      code: 'BROWSER_TRANSACTION_TERMINATION_REASON_INVALID',
    }));
  });
});
