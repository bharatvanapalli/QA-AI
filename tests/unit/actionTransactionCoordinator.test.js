import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const coordinator = require('../../server/services/actionTransactionCoordinator');

function identity(overrides = {}) {
  return {
    runId: 'run-1',
    caseId: 'case-1',
    stepId: 'step-4',
    sequenceIndex: 4,
    action: { kind: 'click', target: { role: 'button', name: 'Continue' } },
    ...overrides,
  };
}

function fixedClock() {
  let tick = 0;
  return () => Date.parse('2026-07-20T10:00:00.000Z') + tick++;
}

describe('actionTransactionCoordinator', () => {
  it('creates stable identities and durable JSON-safe transaction state', () => {
    const first = coordinator.createActionTransaction(identity(), { now: () => 1 });
    const second = coordinator.createActionTransaction(identity(), { now: () => 2 });

    expect(first.actionOccurrenceId).toBe(second.actionOccurrenceId);
    expect(first.transactionId).toBe(second.transactionId);
    expect(first).toMatchObject({
      status: coordinator.TRANSACTION_STATUS.CREATED,
      dispatchStatus: coordinator.DISPATCH_STATUS.NOT_DISPATCHED,
      dispatchTimestamp: null,
      observations: [],
      canonicalOutcome: null,
    });
    expect(JSON.parse(coordinator.serializeActionTransaction(first))).toEqual(first);
  });

  it('does not let callers relabel a canonical browser mutation as observation-only', () => {
    const transaction = coordinator.createActionTransaction(identity({
      toolName: 'browser_click',
      args: { target: 'e1' },
      mutating: false,
    }));
    expect(transaction).toMatchObject({
      toolName: 'browser_click',
      mutationPolicy: 'mutation',
      mutating: true,
      dispatchStatus: coordinator.DISPATCH_STATUS.NOT_DISPATCHED,
    });
  });

  it('persists sensitive transactions with value references and no raw credential material', async () => {
    const secret = 'Never-Persist-This-Password-7!';
    const persisted = [];
    const result = await coordinator.coordinateActionTransaction({
      ...identity({
        action: {
          kind: 'fill',
          target: { role: 'textbox', name: 'Password', inputType: 'password' },
          value: secret,
          valueRef: 'env://LOGIN_PASSWORD',
        },
      }),
      capturePreState: async () => ({
        value: secret,
        valueAfter: secret,
        ActualValue: secret,
        inputValue: secret,
        ownerValue: secret,
        selectedValues: [secret],
        url: `https://app.example.test/login?token=${secret}`,
        observation: {
          fresh: true,
          url: `https://app.example.test/login?token=${secret}`,
          snapshotText: `password=${secret}`,
        },
      }),
      dispatch: async () => ({ delivered: true, message: `authorization=Bearer ${secret}` }),
      observe: async () => ({
        valueAfter: secret,
        actualValue: secret,
        selectedValues: [secret],
        error: new Error(secret),
        snapshotText: `password=${secret}`,
      }),
      provePostcondition: async () => ({
        matched: false,
        checked: true,
        terminal: true,
        reason: 'password_readback_mismatch',
        evidence: { actual: secret, password: secret },
      }),
      persist: async (snapshot) => persisted.push(snapshot),
      maxObservationAttempts: 1,
      sleep: async () => {},
    });

    for (const snapshot of [...persisted, result.transaction]) {
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('password=');
      expect(serialized).not.toContain('?token=');
      expect(serialized).toContain('env://LOGIN_PASSWORD');
    }
  });

  it('persists the dispatching marker, dispatches once, and retries observation only', async () => {
    const order = [];
    const dispatch = vi.fn(async () => {
      order.push('dispatch');
      return { delivered: true, browserEventId: 'event-1' };
    });
    const observe = vi.fn(async ({ attempt }) => ({ value: attempt < 2 ? 'old' : 'new' }));
    const provePostcondition = vi.fn(async ({ observation }) => ({
      matched: observation.data.value === 'new',
      checked: true,
      terminal: observation.data.value === 'new',
      reason: observation.data.value === 'new' ? 'value_committed' : 'value_pending',
    }));

    const result = await coordinator.coordinateActionTransaction({
      ...identity({ action: { kind: 'fill', target: { role: 'textbox', name: 'Email' } } }),
      now: fixedClock(),
      capturePreState: async () => ({ value: '' }),
      dispatch,
      observe,
      provePostcondition,
      persist: async (state) => {
        if (state.dispatchStatus === coordinator.DISPATCH_STATUS.DISPATCHING) order.push('persist:dispatching');
      },
      maxObservationAttempts: 4,
      sleep: async () => {},
    });

    expect(order.indexOf('persist:dispatching')).toBeLessThan(order.indexOf('dispatch'));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(3);
    expect(result.transaction.observations).toHaveLength(3);
    expect(result.transaction).toMatchObject({
      status: coordinator.TRANSACTION_STATUS.COMMITTED,
      dispatchStatus: coordinator.DISPATCH_STATUS.DELIVERED,
      dispatchAttemptCount: 1,
      canonicalOutcome: {
        status: 'passed',
        outcomeKind: coordinator.OUTCOME_KIND.SUCCESS,
        continuation: { shouldContinue: true, blockDependents: false },
      },
    });
  });

  it('does not redispatch an uncertain mutating action without positive non-delivery proof', async () => {
    const dispatch = vi.fn(async () => {
      throw Object.assign(new Error('transport response lost'), { code: 'TRANSPORT_LOST' });
    });
    const proveNotDelivered = vi.fn(async () => false);

    const result = await coordinator.coordinateActionTransaction({
      ...identity(),
      now: fixedClock(),
      capturePreState: async () => ({ url: '/before' }),
      dispatch,
      observe: async () => ({ url: '/before' }),
      provePostcondition: async () => ({ matched: null, checked: false, reason: 'effect_unconfirmed' }),
      proveNotDelivered,
      maxObservationAttempts: 3,
      maxDispatchAttempts: 3,
      sleep: async () => {},
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(proveNotDelivered).toHaveBeenCalledTimes(3);
    expect(result.transaction.dispatchStatus).toBe(coordinator.DISPATCH_STATUS.DELIVERY_UNCERTAIN);
    expect(result.outcome).toMatchObject({
      status: 'blocked',
      outcomeKind: coordinator.OUTCOME_KIND.EXECUTION_UNCERTAINTY,
      continuation: {
        shouldContinue: false,
        blockDependents: true,
        validationOnly: false,
      },
    });
  });

  it('allows one replacement dispatch only after positive proof that delivery did not occur', async () => {
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new Error('channel closed before send'))
      .mockResolvedValueOnce({ delivered: true, browserEventId: 'event-2' });
    const proveNotDelivered = vi.fn(async ({ transaction }) => ({
      proven: transaction.dispatchAttemptCount === 1,
      reason: 'browser_event_absent_and_transport_rejected_before_send',
    }));

    const result = await coordinator.coordinateActionTransaction({
      ...identity(),
      now: fixedClock(),
      capturePreState: async () => ({ page: 'before' }),
      dispatch,
      observe: async ({ transaction }) => ({ page: transaction.dispatchAttemptCount > 1 ? 'after' : 'before' }),
      provePostcondition: async ({ observation }) => ({
        matched: observation.data.page === 'after',
        checked: true,
        reason: observation.data.page === 'after' ? 'landing_proven' : 'landing_pending',
      }),
      proveNotDelivered,
      maxObservationAttempts: 4,
      maxDispatchAttempts: 2,
      sleep: async () => {},
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.transaction.dispatchAttempts).toHaveLength(2);
    expect(result.transaction.dispatchAttempts[0]).toMatchObject({
      status: coordinator.DISPATCH_STATUS.NOT_DELIVERED,
      positivelyNotDelivered: true,
    });
    expect(result.transaction.dispatchAttempts[1].status).toBe(coordinator.DISPATCH_STATUS.DELIVERED);
    expect(result.outcome.status).toBe('passed');
  });

  it('accepts explicit non-delivery from the dispatcher as proof for a controlled replacement', async () => {
    const dispatch = vi.fn()
      .mockResolvedValueOnce({ delivered: false, positivelyNotDelivered: true, reason: 'rejected_before_send' })
      .mockResolvedValueOnce({ delivered: true });

    const result = await coordinator.coordinateActionTransaction({
      ...identity(),
      capturePreState: async () => null,
      dispatch,
      observe: async ({ transaction }) => ({ deliveredAttempts: transaction.dispatchAttemptCount }),
      provePostcondition: async ({ observation }) => ({
        matched: observation.data.deliveredAttempts === 2,
        checked: true,
        reason: observation.data.deliveredAttempts === 2 ? 'effect_proven' : 'effect_pending',
      }),
      maxObservationAttempts: 3,
      maxDispatchAttempts: 2,
      sleep: async () => {},
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.transaction.preStateCaptured).toBe(true);
    expect(result.transaction.dispatchAttempts.map((attempt) => attempt.status)).toEqual([
      coordinator.DISPATCH_STATUS.NOT_DELIVERED,
      coordinator.DISPATCH_STATUS.DELIVERED,
    ]);
    expect(result.outcome.status).toBe('passed');
  });

  it('resumes a persisted dispatching transaction by reconciling without blind redispatch', async () => {
    const persisted = coordinator.createActionTransaction(identity(), { now: () => 1 });
    persisted.preState = { selected: 'Outbound' };
    persisted.status = coordinator.TRANSACTION_STATUS.DISPATCHING;
    persisted.dispatchStatus = coordinator.DISPATCH_STATUS.DISPATCHING;
    persisted.dispatchTimestamp = '2026-07-20T10:00:00.000Z';
    persisted.dispatchAttemptCount = 1;
    persisted.dispatchAttempts = [{
      attempt: 1,
      startedAt: persisted.dispatchTimestamp,
      completedAt: null,
      status: coordinator.DISPATCH_STATUS.DISPATCHING,
    }];
    const dispatch = vi.fn();
    const observe = vi.fn(async ({ phase }) => ({ phase, selected: 'Inbound' }));

    const result = await coordinator.resumeActionTransaction(persisted, {
      now: fixedClock(),
      dispatch,
      observe,
      provePostcondition: async ({ observation }) => ({
        matched: observation.data.selected === 'Inbound',
        checked: true,
        reason: 'selected_value_reconciled',
      }),
      sleep: async () => {},
    });

    expect(result.resumed).toBe(true);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0][0].phase).toBe('resume_reconcile');
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.outcome.status).toBe('passed');
  });

  it('reconciles a persisted not-dispatched transaction before deciding to dispatch', async () => {
    const persisted = coordinator.createActionTransaction(identity(), { now: () => 1 });
    persisted.preState = { visible: false };
    persisted.status = coordinator.TRANSACTION_STATUS.READY;
    const dispatch = vi.fn();

    const result = await coordinator.resumeActionTransaction(persisted, {
      dispatch,
      observe: async () => ({ visible: true }),
      provePostcondition: async ({ observation }) => ({
        matched: observation.data.visible === true,
        checked: true,
        reason: 'effect_already_present',
      }),
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.outcome.status).toBe('passed');
  });

  it('records a validation-only mismatch as failed while allowing independent execution', async () => {
    const result = await coordinator.coordinateActionTransaction({
      ...identity({
        mutating: false,
        failureMode: coordinator.FAILURE_MODE.VALIDATION_ONLY,
        action: { kind: 'assert_text', target: { role: 'heading', name: 'Welcome' } },
      }),
      capturePreState: async () => ({ text: 'Dashboard' }),
      observe: async () => ({ text: 'Dashboard' }),
      provePostcondition: async () => ({
        matched: false,
        checked: true,
        terminal: true,
        reason: 'exact_visible_text_mismatch',
        evidence: { expected: 'Welcome', actual: 'Dashboard' },
      }),
    });

    expect(result.transaction.dispatchStatus).toBe(coordinator.DISPATCH_STATUS.NOT_REQUIRED);
    expect(result.outcome).toMatchObject({
      status: 'failed',
      outcomeKind: coordinator.OUTCOME_KIND.FUNCTIONAL_FAILURE,
      matched: false,
      continuation: {
        shouldContinue: true,
        blockDependents: false,
        validationOnly: true,
      },
    });
  });

  it('blocks dependent steps when a required action postcondition is conclusively false', async () => {
    const result = await coordinator.coordinateActionTransaction({
      ...identity({ failureMode: coordinator.FAILURE_MODE.DEPENDENT_BLOCK }),
      capturePreState: async () => ({ enabled: true }),
      dispatch: async () => ({ delivered: true }),
      observe: async () => ({ selected: 'Outbound' }),
      provePostcondition: async () => ({
        matched: false,
        checked: true,
        terminal: true,
        reason: 'required_selected_value_mismatch',
      }),
    });

    expect(result.outcome).toMatchObject({
      status: 'blocked',
      outcomeKind: coordinator.OUTCOME_KIND.FUNCTIONAL_FAILURE,
      continuation: {
        shouldContinue: false,
        blockDependents: true,
        validationOnly: false,
      },
    });
  });
});
