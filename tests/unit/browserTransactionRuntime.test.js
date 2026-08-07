import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CONTROLLER_STATE,
  RUN_TERMINATION_REASON,
} = require('../../server/services/browserTransactionContract');
const {
  PROOF_STATUS,
  EVIDENCE_TIER,
  createProofContract,
} = require('../../server/services/browserProofContract');
const {
  RESOLUTION_STATUS,
} = require('../../server/services/browserTransactionController');
const {
  createBrowserTransactionRuntime,
} = require('../../server/services/browserTransactionRuntime');

describe('browser transaction runtime autonomous recovery', () => {
  it('keeps the same required action current after QAAI uncertainty instead of poisoning descendants', async () => {
    const operation = Object.freeze({
      schemaVersion: 'OperationContractV2',
      operationId: 'action:scheduling:start-time',
      actionOccurrenceId: 'occurrence:action:scheduling:start-time:1',
      authoredStepId: 'step:start-time',
      assertionId: null,
      ordinal: 1,
      kind: 'action',
      type: 'Select',
      targetIdentity: Object.freeze({ accessibleName: 'Requested Start Time dropdown' }),
      dependencies: Object.freeze([]),
      required: true,
    });
    const proofContract = createProofContract({
      id: 'proof:start-time',
      alternatives: [{ id: 'owner-value', allOf: ['normalized_time_owner_value'] }],
    });
    const compositeExecutor = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          proof: {
            status: PROOF_STATUS.UNKNOWN,
            reason: 'composite_phase_unproven:option-resolved',
            factRefs: ['fact:first-option-observation'],
          },
          delivery: null,
        })
        .mockResolvedValueOnce({
          proof: {
            status: PROOF_STATUS.MATCHED,
            reason: 'composite_protocol_committed:owner-readback',
            factRefs: ['fact:normalized-time-owner'],
          },
          delivery: null,
        }),
    };
    const heartbeat = vi.fn();
    const runtime = createBrowserTransactionRuntime({
      heartbeat,
      recoverySleep: async () => {},
      controllerOptions: {
        resolver: vi.fn().mockResolvedValue({
          status: RESOLUTION_STATUS.RESOLVED,
          target: { ref: 'start-time-owner', role: 'combobox' },
          factRefs: ['fact:start-time-owner'],
        }),
        planner: vi.fn().mockReturnValue({
          protocol: { phases: [{ phaseId: 'option-resolved' }] },
          proofContract,
        }),
        observer: vi.fn().mockResolvedValue({ claims: [], factRefs: ['fact:fresh-snapshot'] }),
        gateway: { dispatch: vi.fn() },
        compositeExecutor,
      },
    });

    const outcome = await runtime.runCase({
      scopeId: 'case:scheduling',
      operationContract: {
        schemaVersion: 'OperationContractV2',
        operations: [operation],
      },
    });

    expect(compositeExecutor.execute).toHaveBeenCalledTimes(2);
    expect(outcome.operationResults).toHaveLength(1);
    expect(outcome.operationResults[0].terminalDecision.state).toBe(CONTROLLER_STATE.COMMITTED);
    expect(outcome.schedulerSnapshot.records[0]).toMatchObject({
      scheduleState: 'TERMINAL',
      terminalState: CONTROLLER_STATE.COMMITTED,
    });
    expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'autonomous_recovery',
      reason: 'composite_phase_unproven:option-resolved',
      recoveryCycle: 1,
    }));
    expect(compositeExecutor.execute.mock.calls[1][0].context).toMatchObject({
      autonomousRecoveryCycle: 1,
      forceFreshSnapshot: true,
      resumeCompositePhases: true,
    });
  });

  it('honors the narrow run-termination whitelist instead of retrying proven non-delivery', async () => {
    const operation = Object.freeze({
      schemaVersion: 'OperationContractV2',
      operationId: 'action:required-submit',
      actionOccurrenceId: 'occurrence:action:required-submit:1',
      authoredStepId: 'step:required-submit',
      assertionId: null,
      ordinal: 1,
      kind: 'action',
      type: 'Click',
      targetIdentity: Object.freeze({ accessibleName: 'Submit' }),
      dependencies: Object.freeze([]),
      required: true,
    });
    const compositeExecutor = {
      execute: vi.fn().mockResolvedValue({
        proof: {
          status: PROOF_STATUS.UNKNOWN,
          reason: 'required_mutation_proven_undelivered',
          factRefs: ['fact:positive-non-delivery'],
        },
        delivery: {
          deliveryStatus: 'NOT_DELIVERED',
          factRefs: ['fact:positive-non-delivery'],
        },
        positivelyNotDelivered: true,
      }),
    };
    const runtime = createBrowserTransactionRuntime({
      recoverySleep: async () => {},
      controllerOptions: {
        resolver: vi.fn().mockResolvedValue({
          status: RESOLUTION_STATUS.RESOLVED,
          target: { ref: 'submit-owner', role: 'button' },
          factRefs: ['fact:submit-owner'],
        }),
        planner: vi.fn().mockReturnValue({
          protocol: { phases: [{ phaseId: 'submit' }] },
          proofContract: createProofContract({
            id: 'proof:required-submit',
            alternatives: [{ id: 'destination', allOf: ['destination_reached'] }],
          }),
        }),
        observer: vi.fn().mockResolvedValue({ claims: [], factRefs: ['fact:fresh-snapshot'] }),
        gateway: { dispatch: vi.fn() },
        compositeExecutor,
      },
    });

    const outcome = await runtime.runCase({
      scopeId: 'case:required-submit',
      operationContract: {
        schemaVersion: 'OperationContractV2',
        operations: [operation],
      },
    });

    expect(compositeExecutor.execute).toHaveBeenCalledTimes(1);
    expect(outcome.operationResults[0].terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.EXECUTION_ERROR,
      continuation: {
        terminationReason: RUN_TERMINATION_REASON.REQUIRED_MUTATION_PROVEN_UNDELIVERED,
      },
    });
  });

  it('reconciles an uncertain owner reveal without redispatching it, then performs the authored fill', async () => {
    const operation = Object.freeze({
      schemaVersion: 'OperationContractV2',
      operationId: 'action:login:email',
      actionOccurrenceId: 'occurrence:action:login:email:1',
      authoredStepId: 'step:email',
      assertionId: null,
      ordinal: 1,
      kind: 'action',
      type: 'Fill',
      value: 'qa@example.test',
      targetIdentity: Object.freeze({ accessibleName: 'Email address', role: 'textbox' }),
      dependencies: Object.freeze([]),
      required: true,
    });
    const proofContract = createProofContract({
      id: 'proof:email',
      alternatives: [{ id: 'owner-value', allOf: ['same_owner_value'] }],
    });
    const gateway = {
      dispatch: vi.fn()
        .mockResolvedValueOnce({
          dispatchAttemptId: 'dispatch:email:reveal-owner:1',
          deliveryStatus: 'DELIVERY_UNCERTAIN',
          browserAcknowledged: false,
          reason: 'BROWSER_TRANSACTION_EXACT_OWNER_REVEAL_DEADLINE',
          factRefs: ['fact:reveal-uncertain'],
        })
        .mockResolvedValueOnce({
          dispatchAttemptId: 'dispatch:email:action:1',
          deliveryStatus: 'DELIVERED',
          browserAcknowledged: true,
          acknowledgmentKind: 'browser_fill_returned',
          factRefs: ['fact:fill-delivered'],
        }),
    };
    const observer = vi.fn()
      .mockResolvedValueOnce({ claims: [], factRefs: ['fact:first-pre'] })
      .mockResolvedValueOnce({ claims: [], factRefs: ['fact:recovery-pre'] })
      .mockResolvedValueOnce({
        claims: [{
          claimId: 'same_owner_value',
          status: PROOF_STATUS.MATCHED,
          tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
          factRef: 'fact:email-owner-value',
        }],
        factRefs: ['fact:email-owner-value'],
      });
    const heartbeat = vi.fn();
    const runtime = createBrowserTransactionRuntime({
      heartbeat,
      recoverySleep: async () => {},
      controllerOptions: {
        resolver: vi.fn().mockResolvedValue({
          status: RESOLUTION_STATUS.RESOLVED,
          target: { ref: 'email-owner', role: 'textbox', accessibleName: 'Email address' },
          factRefs: ['fact:email-owner'],
        }),
        planner: vi.fn().mockReturnValue({
          preDispatchMutation: {
            toolName: 'browser_evaluate',
            phaseId: 'reveal-owner',
            args: { target: 'email-owner', function: 'exact-owner-reveal' },
          },
          mutation: {
            toolName: 'browser_fill',
            args: { target: 'email-owner', text: 'qa@example.test' },
          },
          proofContract,
        }),
        observer,
        gateway,
        defaultDeadlineMs: 8_000,
      },
    });

    const outcome = await runtime.runCase({
      scopeId: 'case:login',
      context: { maxAutonomousRecoveryCycles: 2 },
      operationContract: {
        schemaVersion: 'OperationContractV2',
        operations: [operation],
      },
    });

    expect(gateway.dispatch.mock.calls.map(([input]) => input.plan.mutation.phaseId || 'action'))
      .toEqual(['reveal-owner', 'action']);
    expect(gateway.dispatch).toHaveBeenCalledTimes(2);
    expect(outcome.operationResults[0].terminalDecision.state).toBe(CONTROLLER_STATE.COMMITTED);
    expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'autonomous_recovery',
      reason: 'BROWSER_TRANSACTION_EXACT_OWNER_REVEAL_DEADLINE',
    }));
  });

  it('bounds uncertain delivery observation without redispatch or run termination', async () => {
    const operation = Object.freeze({
      schemaVersion: 'OperationContractV2',
      operationId: 'action:bounded-unknown',
      actionOccurrenceId: 'occurrence:action:bounded-unknown:1',
      authoredStepId: 'step:bounded-unknown',
      assertionId: null,
      ordinal: 1,
      kind: 'action',
      type: 'Click',
      targetIdentity: Object.freeze({ accessibleName: 'Continue', role: 'button' }),
      dependencies: Object.freeze([]),
      required: true,
    });
    const heartbeat = vi.fn();
    const gateway = {
      dispatch: vi.fn().mockResolvedValue({
        deliveryStatus: 'DELIVERY_UNCERTAIN',
        reason: 'response_lost',
        factRefs: ['fact:response-lost'],
      }),
    };
    const runtime = createBrowserTransactionRuntime({
      heartbeat,
      recoverySleep: async () => {},
      controllerOptions: {
        resolver: vi.fn().mockResolvedValue({
          status: RESOLUTION_STATUS.RESOLVED,
          target: { ref: 'continue-owner', role: 'button', accessibleName: 'Continue' },
          factRefs: ['fact:continue-owner'],
        }),
        planner: vi.fn().mockReturnValue({
          mutation: { toolName: 'browser_click', args: { target: 'continue-owner' } },
          proofContract: createProofContract({
            id: 'proof:bounded-unknown',
            alternatives: [{ id: 'destination', allOf: ['authored_destination'] }],
          }),
        }),
        observer: vi.fn().mockResolvedValue({ claims: [], factRefs: ['fact:unknown'] }),
        gateway,
        defaultDeadlineMs: 100,
      },
    });

    const outcome = await runtime.runCase({
      scopeId: 'case:bounded-unknown',
      context: { maxAutonomousRecoveryCycles: 2 },
      operationContract: {
        schemaVersion: 'OperationContractV2',
        operations: [operation],
      },
    });

    expect(outcome.operationResults).toHaveLength(1);
    expect(outcome.operationResults[0].terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.EXECUTION_ERROR,
      continuation: { terminationReason: null },
    });
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'observation_reconciliation_exhausted',
      duplicateMutationForbidden: true,
      recoveryMutationAuthorized: false,
      runTerminationAuthorized: false,
    }));
  });

  it('uses one distinct recovery occurrence when a click response is lost and the source state is proven unchanged', async () => {
    const operation = Object.freeze({
      schemaVersion: 'OperationContractV2',
      operationId: 'action:orders:create',
      actionOccurrenceId: 'occurrence:action:orders:create:1',
      authoredStepId: 'step:create-order',
      assertionId: null,
      ordinal: 1,
      kind: 'action',
      type: 'Click',
      targetIdentity: Object.freeze({ accessibleName: 'Create Order', role: 'button' }),
      dependencies: Object.freeze([]),
      required: true,
    });
    const proofContract = createProofContract({
      id: 'proof:create-order',
      alternatives: [{ id: 'destination', allOf: ['authored_destination'] }],
    });
    const planner = vi.fn(({ context = {} }) => ({
      mutation: context.controllerRecoveryDirective === 'ACTIVATE_PROVEN_UNCHANGED_TARGET'
        ? {
            toolName: 'browser_evaluate',
            phaseId: 'recovery-activation',
            args: { target: 'create-order-owner', function: 'exact-bound-activation' },
          }
        : { toolName: 'browser_click', args: { target: 'create-order-owner' } },
      recoveryMutation: context.controllerRecoveryDirective
        ? null
        : {
            toolName: 'browser_evaluate',
            phaseId: 'recovery-activation',
            args: { target: 'create-order-owner', function: 'exact-bound-activation' },
          },
      proofContract,
    }));
    const gateway = {
      dispatch: vi.fn(({ operation: dispatchedOperation }) => (
        dispatchedOperation.actionOccurrenceId.includes(':recovery:')
          ? Promise.resolve({
              deliveryStatus: 'DELIVERED',
              browserAcknowledged: true,
              acknowledgmentKind: 'browser_evaluate_returned',
              factRefs: ['fact:recovery-delivered'],
            })
          : Promise.resolve({
              deliveryStatus: 'DELIVERY_UNCERTAIN',
              browserAcknowledged: false,
              reason: '-32001 request timeout',
              factRefs: ['fact:click-response-lost'],
            })
      )),
    };
    const observer = vi.fn(({ operation: observedOperation, phase }) => {
      if (observedOperation.actionOccurrenceId.includes(':recovery:') && phase === 'post_dispatch') {
        return Promise.resolve({
          claims: [{
            claimId: 'authored_destination',
            status: PROOF_STATUS.MATCHED,
            tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
            factRef: 'fact:create-form-reached',
          }],
          factRefs: ['fact:create-form-reached'],
        });
      }
      return Promise.resolve({
        claims: [],
        factRefs: ['fact:create-order-still-actionable'],
        ...(phase === 'post_dispatch'
          ? {
              actionRecoveryState: {
                exactOwnerPresent: true,
                sourceUrlUnchanged: true,
                authoredDestinationReached: false,
                nextRequiredControlReached: false,
                pageTransitionCommitted: false,
                sourceStateUnchanged: true,
              },
            }
          : {}),
      });
    });
    const heartbeat = vi.fn();
    const runtime = createBrowserTransactionRuntime({
      heartbeat,
      recoverySleep: async () => {},
      controllerOptions: {
        resolver: vi.fn().mockResolvedValue({
          status: RESOLUTION_STATUS.RESOLVED,
          target: {
            ref: 'create-order-owner',
            role: 'button',
            identity: { accessibleName: 'Create Order', role: 'button' },
          },
          factRefs: ['fact:create-order-owner'],
        }),
        planner,
        observer,
        gateway,
        defaultDeadlineMs: 8_000,
      },
    });

    const outcome = await runtime.runCase({
      scopeId: 'case:create-order',
      context: { maxObservationAttempts: 2, maxAutonomousRecoveryCycles: 2 },
      operationContract: {
        schemaVersion: 'OperationContractV2',
        operations: [operation],
      },
    });

    expect(gateway.dispatch).toHaveBeenCalledTimes(2);
    expect(gateway.dispatch.mock.calls.map(([input]) => ({
      occurrence: input.operation.actionOccurrenceId,
      toolName: input.plan.mutation.toolName,
    }))).toEqual([
      {
        occurrence: operation.actionOccurrenceId,
        toolName: 'browser_click',
      },
      {
        occurrence: `${operation.actionOccurrenceId}:recovery:unchanged-activation:1`,
        toolName: 'browser_evaluate',
      },
    ]);
    expect(outcome.operationResults[0].terminalDecision).toMatchObject({
      actionOccurrenceId: `${operation.actionOccurrenceId}:recovery:unchanged-activation:1`,
      state: CONTROLLER_STATE.COMMITTED,
    });
    expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'autonomous_recovery',
      recoveryMutationAuthorized: true,
      recoveryOccurrenceId: `${operation.actionOccurrenceId}:recovery:unchanged-activation:1`,
    }));
  });

  it('does not authorize a recovery mutation when the source state is not proven unchanged', async () => {
    const operation = Object.freeze({
      schemaVersion: 'OperationContractV2',
      operationId: 'action:navigation:continue',
      actionOccurrenceId: 'occurrence:action:navigation:continue:1',
      authoredStepId: 'step:continue',
      assertionId: null,
      ordinal: 1,
      kind: 'action',
      type: 'Click',
      targetIdentity: Object.freeze({ accessibleName: 'Continue', role: 'button' }),
      dependencies: Object.freeze([]),
      required: true,
    });
    const gateway = {
      dispatch: vi.fn().mockResolvedValue({
        deliveryStatus: 'DELIVERY_UNCERTAIN',
        reason: 'response_lost',
        factRefs: ['fact:response-lost'],
      }),
    };
    const runtime = createBrowserTransactionRuntime({
      recoverySleep: async () => {},
      controllerOptions: {
        resolver: vi.fn().mockResolvedValue({
          status: RESOLUTION_STATUS.RESOLVED,
          target: {
            ref: 'continue-owner',
            role: 'button',
            identity: { accessibleName: 'Continue', role: 'button' },
          },
          factRefs: ['fact:continue-owner'],
        }),
        planner: vi.fn().mockReturnValue({
          mutation: { toolName: 'browser_click', args: { target: 'continue-owner' } },
          recoveryMutation: {
            toolName: 'browser_evaluate',
            phaseId: 'recovery-activation',
            args: { target: 'continue-owner', function: 'exact-bound-activation' },
          },
          proofContract: createProofContract({
            id: 'proof:continue',
            alternatives: [{ id: 'destination', allOf: ['authored_destination'] }],
          }),
        }),
        observer: vi.fn().mockResolvedValue({
          claims: [],
          factRefs: ['fact:state-not-stable'],
          actionRecoveryState: { sourceStateUnchanged: false },
        }),
        gateway,
        defaultDeadlineMs: 8_000,
      },
    });

    const outcome = await runtime.runCase({
      scopeId: 'case:continue',
      context: { maxObservationAttempts: 2, maxAutonomousRecoveryCycles: 1 },
      operationContract: {
        schemaVersion: 'OperationContractV2',
        operations: [operation],
      },
    });

    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(outcome.operationResults[0].terminalDecision).toMatchObject({
      actionOccurrenceId: operation.actionOccurrenceId,
      state: CONTROLLER_STATE.EXECUTION_ERROR,
      continuation: { terminationReason: null },
    });
  });

  // Phase 31 — evidence-write faults must degrade, never alter the verdict
  // or abort the case. These are the chaos scenarios for the fix that lets
  // a journal/verdict-repository write hiccup lose only its OWN proof
  // record, never the already-decided outcome.
  it('a journal write failure never affects the committed decision or the final verdict', async () => {
    const operation = Object.freeze({
      schemaVersion: 'OperationContractV2',
      operationId: 'action:chaos:journal-fault',
      actionOccurrenceId: 'occurrence:action:chaos:journal-fault:1',
      authoredStepId: 'step:journal-fault',
      assertionId: null,
      ordinal: 1,
      kind: 'action',
      type: 'Click',
      targetIdentity: Object.freeze({ accessibleName: 'Submit', role: 'button' }),
      dependencies: Object.freeze([]),
      required: true,
    });
    const proofContract = createProofContract({
      id: 'proof:journal-fault',
      alternatives: [{ id: 'destination', allOf: ['destination_reached'] }],
    });
    const gateway = {
      dispatch: vi.fn().mockResolvedValue({
        dispatchAttemptId: 'dispatch:journal-fault:1',
        deliveryStatus: 'DELIVERED',
        factRefs: ['fact:journal-fault-delivered'],
      }),
    };
    const observer = vi.fn().mockResolvedValue({
      claims: [{
        claimId: 'destination_reached',
        status: PROOF_STATUS.MATCHED,
        tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
        factRef: 'fact:journal-fault-destination',
      }],
      factRefs: ['fact:journal-fault-destination'],
    });
    const heartbeat = vi.fn();
    const faultingJournal = {
      appendControllerEvent: vi.fn().mockRejectedValue(new Error('disk full — journal append failed')),
      eventsForOccurrence: vi.fn().mockResolvedValue([]),
    };
    const runtime = createBrowserTransactionRuntime({
      heartbeat,
      recoverySleep: async () => {},
      journal: faultingJournal,
      controllerOptions: {
        resolver: vi.fn().mockResolvedValue({
          status: RESOLUTION_STATUS.RESOLVED,
          target: { ref: 'submit-owner', role: 'button' },
          factRefs: ['fact:submit-owner'],
        }),
        planner: vi.fn().mockReturnValue({
          mutation: { toolName: 'browser_click', args: { target: 'submit-owner' } },
          proofContract,
        }),
        observer,
        gateway,
        defaultDeadlineMs: 8_000,
      },
    });

    const outcome = await runtime.runCase({
      scopeId: 'case:journal-fault',
      operationContract: {
        schemaVersion: 'OperationContractV2',
        operations: [operation],
      },
    });

    expect(faultingJournal.appendControllerEvent).toHaveBeenCalled();
    expect(outcome.operationResults[0].terminalDecision.state).toBe(CONTROLLER_STATE.COMMITTED);
    expect(outcome.verdict).toBeTruthy();
    expect(outcome.verdict.verdict).toBeTruthy();
    expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'evidence_write_degraded',
      evidenceDegraded: true,
      runTerminationAuthorized: false,
    }));
  });

  it('a verdict-repository write failure never blocks the case verdict', async () => {
    const operation = Object.freeze({
      schemaVersion: 'OperationContractV2',
      operationId: 'action:chaos:verdict-fault',
      actionOccurrenceId: 'occurrence:action:chaos:verdict-fault:1',
      authoredStepId: 'step:verdict-fault',
      assertionId: null,
      ordinal: 1,
      kind: 'action',
      type: 'Click',
      targetIdentity: Object.freeze({ accessibleName: 'Submit', role: 'button' }),
      dependencies: Object.freeze([]),
      required: true,
    });
    const proofContract = createProofContract({
      id: 'proof:verdict-fault',
      alternatives: [{ id: 'destination', allOf: ['destination_reached'] }],
    });
    const gateway = {
      dispatch: vi.fn().mockResolvedValue({
        dispatchAttemptId: 'dispatch:verdict-fault:1',
        deliveryStatus: 'DELIVERED',
        factRefs: ['fact:verdict-fault-delivered'],
      }),
    };
    const observer = vi.fn().mockResolvedValue({
      claims: [{
        claimId: 'destination_reached',
        status: PROOF_STATUS.MATCHED,
        tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
        factRef: 'fact:verdict-fault-destination',
      }],
      factRefs: ['fact:verdict-fault-destination'],
    });
    const heartbeat = vi.fn();
    const faultingVerdictRepository = {
      loadVerdict: vi.fn().mockResolvedValue(null),
      appendVerdict: vi.fn().mockRejectedValue(new Error('verdict store disk full')),
    };
    const runtime = createBrowserTransactionRuntime({
      heartbeat,
      recoverySleep: async () => {},
      verdictRepository: faultingVerdictRepository,
      controllerOptions: {
        resolver: vi.fn().mockResolvedValue({
          status: RESOLUTION_STATUS.RESOLVED,
          target: { ref: 'submit-owner', role: 'button' },
          factRefs: ['fact:submit-owner'],
        }),
        planner: vi.fn().mockReturnValue({
          mutation: { toolName: 'browser_click', args: { target: 'submit-owner' } },
          proofContract,
        }),
        observer,
        gateway,
        defaultDeadlineMs: 8_000,
      },
    });

    const outcome = await runtime.runCase({
      scopeId: 'case:verdict-fault',
      operationContract: {
        schemaVersion: 'OperationContractV2',
        operations: [operation],
      },
    });

    expect(faultingVerdictRepository.appendVerdict).toHaveBeenCalled();
    expect(outcome.operationResults[0].terminalDecision.state).toBe(CONTROLLER_STATE.COMMITTED);
    expect(outcome.verdict).toBeTruthy();
    expect(outcome.verdict.verdict).toBeTruthy();
    expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'verdict_persistence_degraded',
      evidenceDegraded: true,
      runTerminationAuthorized: false,
    }));
  });
});
